// RWR-02 / CONTRACTS §1: the persisted character registry and the saved/effective role selection.
//
// Why this is a module and not a table read inlined in the server: admission used to be the hardcoded
// predicate `value === 'companion'`, so a syntactically valid id was indistinguishable from a
// registered character and `getPreset` fabricated a default preset for anything that passed the regex.
// CONTRACTS §1 requires existence to come from persisted state, so every entry point asks THIS module.
//
// Two revisions exist and are deliberately distinct:
//   * `character_registry.revision`  — the descriptor revision (label/intro edits).
//   * `characters.revision`          — the memory/prompt revision owned by SqliteMemoryStore.
// They are never compared to each other and never written from the same surface.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  COMPANION_ID, COMPANION_LABEL, isCharacterId,
  type CharacterDescriptor, type CharacterId, type RuntimeRoleState,
} from '../contracts/character.js';

export class RegistryError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_request' | 'version_conflict' | 'operation_id_payload_mismatch' | 'forbidden', message: string) {
    super(message);
  }
}

/** Deterministic payload signature: the same operationId with different content is a conflict. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return '{' + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
};
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

interface RegistryRow { character_id: string; label: string; intro: string; revision: number; created_at: string; updated_at: string }
interface SelectionRow { saved_character_id: string; effective_character_id: string; selection_revision: number; effective_selection_revision: number }
interface OperationRow { operation_id: string; signature: string | null; result_json: string | null }

export interface CreateCharacterInput {
  readonly label: string;
  readonly intro?: string;
  readonly operationId: string;
  /** Caller may propose an id; when absent the registry assigns one. Never reused across characters. */
  readonly id?: string;
}

const MAX_LABEL = 80;
const MAX_INTRO = 2000;

/**
 * Acceptance-created roles are hidden from the picker by default, but NOT deleted.
 *
 * RWR-08 acceptance created `companion` and `b` through the real create/select routes, so both carry an
 * `operation_id` prefixed with `rwr08-acceptance-`. That prefix is the durable provenance marker: it lives
 * in `character_registry_operations`, which the registry already owns, so no new column or table is needed
 * and a role the user creates later can never match it.
 *
 * This ONLY narrows `list()`, the roster surface. `get`/`exists`/`require` still admit a hidden id, so the
 * running role keeps working, its memory/traces stay reachable, and hiding is reversible by dropping the
 * filter. Deleting rows here would orphan `memory_records`/`runtime_traces` foreign keys.
 */
const ACCEPTANCE_ROLE_PREFIX = 'rwr08-acceptance-';

/** Label/intro are user-authored display strings; control characters never enter storage. */
function display(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string') throw new RegistryError('invalid_request', `${name}无效。`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) throw new RegistryError('invalid_request', `${name}无效。`);
  return trimmed;
}

/** Derive a stable, readable id from a label without ever colliding with an existing character. */
function deriveId(label: string, taken: (id: string) => boolean): CharacterId {
  const ascii = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const base = /^[a-z]/.test(ascii) ? ascii : `role-${createHash('sha256').update(label).digest('hex').slice(0, 8)}`;
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) { const candidate = `${base}-${n}`; if (!taken(candidate)) return candidate; }
  throw new RegistryError('invalid_request', '无法为该角色分配标识。');
}

export class CharacterRegistry {
  private constructor(
    private readonly db: Database.Database,
    private readonly now: () => string,
  ) {}

  /**
   * The registry tables live in the SAME database and transaction boundary as memory. A character must
   * never become a second application database, and a create must be atomic with its registry row.
   */
  static open(db: Database.Database, options: { now: () => string }): CharacterRegistry {
    const registry = new CharacterRegistry(db, options.now);
    registry.#migrate();
    // RWR-02: opening the store IS the restart boundary. The saved selection becomes the running role
    // here and nowhere else, so a mid-session selection can never retag an in-flight turn.
    registry.applySelectionOnStart();
    return registry;
  }

  #migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS character_registry(
        character_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        intro TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS character_registry_operations(
        character_id TEXT NOT NULL, operation_id TEXT NOT NULL, signature TEXT, result_json TEXT,
        PRIMARY KEY(character_id,operation_id));
      CREATE TABLE IF NOT EXISTS role_selection(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        saved_character_id TEXT NOT NULL,
        effective_character_id TEXT NOT NULL,
        selection_revision INTEGER NOT NULL DEFAULT 0 CHECK(selection_revision >= 0),
        effective_selection_revision INTEGER NOT NULL DEFAULT 0 CHECK(effective_selection_revision >= 0));
      CREATE TABLE IF NOT EXISTS character_retirements(character_id TEXT PRIMARY KEY, retired_at TEXT NOT NULL);
    `);
    // Seed once: the shipped companion is registered from the product constant, and the existing
    // `characters` row (if any) keeps its prompt/revision because we never copy those here.
    const seeded = this.db.prepare('SELECT count(*) AS n FROM character_registry').get() as { n: number };
    if (seeded.n === 0) {
      const at = this.now();
      this.db.prepare('INSERT INTO character_registry(character_id,label,intro,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)')
        .run(COMPANION_ID, COMPANION_LABEL, '', at, at);
    }
    const selection = this.db.prepare('SELECT count(*) AS n FROM role_selection').get() as { n: number };
    if (selection.n === 0) {
      const first = (this.db.prepare('SELECT character_id FROM character_registry ORDER BY created_at, character_id LIMIT 1').get() as { character_id: string } | undefined)?.character_id ?? COMPANION_ID;
      this.db.prepare('INSERT INTO role_selection(singleton,saved_character_id,effective_character_id,selection_revision,effective_selection_revision) VALUES(1,?,?,0,0)')
        .run(first, first);
    }
  }

  private get row(): SelectionRow {
    const row = this.db.prepare('SELECT saved_character_id,effective_character_id,selection_revision,effective_selection_revision FROM role_selection WHERE singleton=1').get() as SelectionRow | undefined;
    if (!row) throw new RegistryError('not_found', '角色选择状态缺失。');
    return row;
  }

  private decode(row: RegistryRow): CharacterDescriptor {
    return Object.freeze({
      schemaVersion: 2 as const, id: row.character_id, label: row.label, intro: row.intro,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    });
  }

  /**
   * Every registered role, including the ones `list()` hides.
   *
   * Store-internal consistency work (seeding a missing `characters` row, purging deleted memories) must see
   * hidden roles too: they still own rows, and skipping them would leave those rows unreconciled. Only the
   * roster surface may narrow; internal bookkeeping must not.
   */
  listAll(): readonly CharacterDescriptor[] {
    const rows = this.db.prepare('SELECT * FROM character_registry ORDER BY created_at, character_id').all() as RegistryRow[];
    return Object.freeze(rows.map(row => this.decode(row)));
  }

  list(): readonly CharacterDescriptor[] {
    const rows = this.db.prepare('SELECT * FROM character_registry ORDER BY created_at, character_id').all() as RegistryRow[];
    return Object.freeze(rows.filter(row => !this.isAcceptanceRole(row.character_id) && !this.retired(row.character_id)).map(row => this.decode(row)));
  }

  /**
   * A role counts as acceptance-created when EVERY operation that ever touched it is an acceptance
   * operation. Requiring all of them (rather than any) keeps a role the user later selected or renamed
   * visible again, so the roster can never silently swallow a real character.
   */
  private isAcceptanceRole(characterId: string): boolean {
    const ops = this.db.prepare('SELECT operation_id FROM character_registry_operations WHERE character_id=? OR character_id=?')
      .all(characterId, `selection:${characterId}`) as OperationRow[];
    return ops.length > 0 && ops.every(row => (row.operation_id ?? '').startsWith(ACCEPTANCE_ROLE_PREFIX));
  }

  /** Existence is a persisted fact. A syntactically valid id that was never created is NOT admitted. */
  exists(id: unknown): id is CharacterId {
    return isCharacterId(id) && !this.retired(id) && this.taken(id);
  }
  private taken(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM character_registry WHERE character_id=?').get(id); }
  private retired(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM character_retirements WHERE character_id=?').get(id); }

  /** Unknown ids are `not_found`; they never receive a synthesized default. */
  require(id: unknown): CharacterDescriptor {
    if (!isCharacterId(id)) throw new RegistryError('invalid_request', '角色标识无效。');
    const row = this.db.prepare('SELECT * FROM character_registry WHERE character_id=?').get(id) as RegistryRow | undefined;
    if (!row || this.retired(id)) throw new RegistryError('not_found', '没有这个角色。');
    return this.decode(row);
  }

  get(id: unknown): CharacterDescriptor | null {
    if (!isCharacterId(id)) return null;
    const row = this.db.prepare('SELECT * FROM character_registry WHERE character_id=?').get(id) as RegistryRow | undefined;
    return row && !this.retired(id) ? this.decode(row) : null;
  }

  /** The descriptor revision is the registry's own cursor, independent of the memory revision. */
  revision(): number {
    const row = this.db.prepare('SELECT coalesce(max(revision),0) AS n FROM character_registry').get() as { n: number };
    return row.n;
  }

  /**
   * Explicit, transactional creation. Replaying the same operationId returns the SAME character; the
   * same id with different content is a conflict rather than a silent overwrite.
   */
  create(input: CreateCharacterInput): { readonly character: CharacterDescriptor; readonly created: boolean } {
    if (typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.length > 160) throw new RegistryError('invalid_request', '操作编号无效。');
    const label = display(input.label, MAX_LABEL, '角色名称');
    const intro = input.intro === undefined ? '' : (input.intro.trim() ? display(input.intro, MAX_INTRO, '角色简介') : '');
    if (input.id !== undefined && !isCharacterId(input.id)) throw new RegistryError('invalid_request', '角色标识无效。');
    const signature = digest({ label, intro, id: input.id ?? null });

    return this.db.transaction(() => {
      // Replay key: scoped to the proposed id (or a synthetic bucket when the server assigns it).
      const scopeKey = input.id ?? '';
      const prior = this.db.prepare('SELECT signature,result_json FROM character_registry_operations WHERE character_id=? AND operation_id=?').get(scopeKey, input.operationId) as OperationRow | undefined;
      if (prior) {
        if (prior.signature && prior.signature !== signature) throw new RegistryError('operation_id_payload_mismatch', '同一操作编号已用于不同内容。');
        const id = (JSON.parse(prior.result_json ?? '{}') as { id?: string }).id;
        const existing = id ? this.get(id) : null;
        if (!existing) throw new RegistryError('not_found', '该操作创建的角色已不存在。');
        return { character: existing, created: false };
      }

      let id = input.id;
      if (id !== undefined) {
        if (this.taken(id)) throw new RegistryError('version_conflict', '该角色标识已被使用。');
      } else {
        id = deriveId(label, candidate => this.taken(candidate));
      }
      const at = this.now();
      this.db.prepare('INSERT INTO character_registry(character_id,label,intro,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(id, label, intro, at, at);
      // RWR-02: a registered character owns its `characters` row in the SAME transaction. That row is the
      // FK target of memory_records/operations/tasks, and its revision/prompt columns are the memory
      // owner's cursor. Provisioning it here (rather than in a later open() sweep) is what makes a
      // create-then-append sequence succeed instead of failing on a foreign key.
      this.db.prepare('INSERT INTO characters(character_id,prompt) VALUES(?,?)').run(id, '');
      this.db.prepare('INSERT INTO character_registry_operations(character_id,operation_id,signature,result_json) VALUES(?,?,?,?)')
        .run(scopeKey, input.operationId, signature, JSON.stringify({ id }));
      return { character: this.require(id), created: true };
    }).immediate();
  }

  /**
   * CONTRACTS §1: `selection` records which role the NEXT start runs. It deliberately does NOT move
   * `effectiveCharacterId` — the running pairing keeps its character until a restart, so a browse or a
   * pending selection can never retag an in-flight turn.
   */
  selection(): RuntimeRoleState {
    const row = this.row;
    return Object.freeze({
      savedCharacterId: row.saved_character_id,
      effectiveCharacterId: row.effective_character_id,
      selectionRevision: row.selection_revision,
      effectiveSelectionRevision: row.effective_selection_revision,
      applyOn: 'restart' as const,
    });
  }
  /** Revoke an entire role. IDs and isolated history remain reserved to prevent resurrection. */
  remove(input: { characterId: string; expectedRevision: number }): void {
    this.db.transaction(() => {
      const current = this.require(input.characterId);
      if (current.revision !== input.expectedRevision) throw new RegistryError('version_conflict', '角色已更新，请刷新后重试。');
      if (current.id === this.row.effective_character_id || current.id === this.row.saved_character_id) throw new RegistryError('forbidden', '请先选择其他角色并重启，再删除该角色。');
      this.db.prepare('INSERT INTO character_retirements(character_id,retired_at) VALUES(?,?)').run(current.id, this.now());
    }).immediate();
  }
  replace(input: { characterId: string; expectedRevision: number; label: string; operationId: string }): { character: CharacterDescriptor; created: boolean } {
    return this.db.transaction(() => {
      const key = `replace:${input.characterId}`;
      const signature = digest(input);
      const prior = this.db.prepare('SELECT signature,result_json FROM character_registry_operations WHERE character_id=? AND operation_id=?').get(key, input.operationId) as OperationRow | undefined;
      if (prior) {
        if (prior.signature !== signature) throw new RegistryError('operation_id_payload_mismatch', '操作编号已用于不同内容。');
        return { character: this.require(JSON.parse(prior.result_json!).id), created: false };
      }
      this.remove(input);
      const result = this.create({ label: input.label, operationId: `replacement:${input.operationId}` });
      this.db.prepare('INSERT INTO character_registry_operations(character_id,operation_id,signature,result_json) VALUES(?,?,?,?)').run(key, input.operationId, signature, JSON.stringify({ id: result.character.id }));
      return result;
    }).immediate();
  }

  /** The role the CURRENT process actually runs. Never derived from the saved selection. */
  effectiveRole(): CharacterId { return this.row.effective_character_id; }

  setSelection(input: { readonly characterId: unknown; readonly expectedRevision: unknown; readonly operationId: unknown }): RuntimeRoleState {
    const descriptor = this.require(input.characterId);
    if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) throw new RegistryError('invalid_request', '修订号无效。');
    if (typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.length > 160) throw new RegistryError('invalid_request', '操作编号无效。');
    const signature = digest({ kind: 'selection', characterId: descriptor.id });
    return this.db.transaction(() => {
      const scopeKey = `selection:${descriptor.id}`;
      const prior = this.db.prepare('SELECT signature,result_json FROM character_registry_operations WHERE character_id=? AND operation_id=?').get(scopeKey, input.operationId) as OperationRow | undefined;
      if (prior) {
        if (prior.signature && prior.signature !== signature) throw new RegistryError('operation_id_payload_mismatch', '同一操作编号已用于不同内容。');
        return this.selection();
      }
      const row = this.row;
      if (row.selection_revision !== input.expectedRevision) throw new RegistryError('version_conflict', '角色选择已被更新，请刷新后再切换。');
      this.db.prepare('UPDATE role_selection SET saved_character_id=?, selection_revision=selection_revision+1 WHERE singleton=1').run(descriptor.id);
      this.db.prepare('INSERT INTO character_registry_operations(character_id,operation_id,signature,result_json) VALUES(?,?,?,?)')
        .run(scopeKey, input.operationId, signature, JSON.stringify({ characterId: descriptor.id }));
      return this.selection();
    }).immediate();
  }

  /**
   * Called once by the composition root at startup: the saved selection becomes effective and the
   * effective revision catches up. This is the ONLY transition that moves the running role.
   */
  applySelectionOnStart(): RuntimeRoleState {
    return this.db.transaction(() => {
      const row = this.row;
      if (row.saved_character_id !== row.effective_character_id) {
        this.db.prepare('UPDATE role_selection SET effective_character_id=saved_character_id, effective_selection_revision=selection_revision WHERE singleton=1').run();
      } else if (row.effective_selection_revision !== row.selection_revision) {
        this.db.prepare('UPDATE role_selection SET effective_selection_revision=selection_revision WHERE singleton=1').run();
      }
      return this.selection();
    }).immediate();
  }

  /**
   * RWR-02: the migration the store performs when it upgrades an existing single-role database.
   * The legacy `characters` row for companion keeps its prompt/revision; this only registers the
   * identity and pins the selection, and it is idempotent.
   */
  registerLegacyCompanion(): void {
    if (this.exists(COMPANION_ID)) return;
    const at = this.now();
    this.db.prepare('INSERT INTO character_registry(character_id,label,intro,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)')
      .run(COMPANION_ID, COMPANION_LABEL, '', at, at);
  }
}

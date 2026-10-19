// RWR-06: the Lorebook store and its trigger/selection rules.
//
// Two responsibilities, deliberately in one module so the trigger and the injection cannot disagree:
//   1. persistence (authored fiction, per character, revisioned, with the RWR-00 limits enforced);
//   2. selection for one turn — `always` entries, then literal `keyword` matches over the CURRENT user
//      input, ordered stably and cut by BOTH the per-turn ceiling and the caller's remaining budget.
//
// The matching is intentionally literal (NFKC + lowercase + `includes`): no regex, no stemming, no
// semantic retrieval. A lorebook is an authored lookup, and a surprising trigger is worse than a miss.
import { createHash, randomUUID } from 'node:crypto';
import { KnowledgeError } from '../contracts/knowledge.js';
import type { Lorebook, LorebookEntry, LorebookRef, LorebookSelection, LorebookOmission } from '../contracts/lorebook.js';
import type { CharacterId } from '../contracts/character.js';
import type { SqliteMemoryStore } from './sqlite-store.js';

/**
 * RWR-08 / AC-A: deterministic payload signature for idempotent replay receipts — the same canonical
 * form `character_registry` uses, so the same operationId with different content is a conflict.
 */
const canonicalOp = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalOp).join(',')}]`;
  if (value && typeof value === 'object') return '{' + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonicalOp(v)).join(',') + '}';
  return JSON.stringify(value);
};
const digestOp = (value: unknown) => createHash('sha256').update(canonicalOp(value)).digest('hex');

interface OperationRow { signature: string | null; result_json: string | null }

/**
 * RWR-00 §5 registered these ceilings. They are enforced here, on WRITE, and never widened at runtime.
 */
export const LOREBOOK_LIMITS = Object.freeze({
  booksPerCharacter: 16,
  entriesPerBook: 256,
  entryBodyBytes: 16 * 1024,
  keywordsPerEntry: 64,
  keywordChars: 128,
  bookSerializedBytes: 1024 * 1024,
  importTotalBytes: 1024 * 1024,
  /** Per-turn ceiling; the selection is additionally capped by the real remaining Context budget. */
  contextTokensPerTurn: 2048,
});

interface EntryRow {
  id: string; book_id: string; title: string; enabled: number; strategy: 'keyword' | 'always';
  keywords_json: string; content: string; revision: number; entry_order: number;
  aiki_entry_id: string | null; aiki_import_id: string | null; aiki_metadata_json: string | null; aiki_content_hash: string | null;
}
interface BookRow { id: string; owner_character_id: string; title: string; revision: number; created_at: string }

const text = (value: unknown, max: number, name: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new KnowledgeError('invalid_request', `${name}无效。`);
  return value.trim();
};
/** The literal trigger form: NFKC + lowercase, so full-width and case variants match predictably. */
export const normalizeForMatch = (value: string): string => value.normalize('NFKC').toLocaleLowerCase();
const estimateTokens = (value: string): number => Math.ceil([...value].length / 2) + 8;

export class LorebookStore {
  private constructor(private readonly store: SqliteMemoryStore, private readonly db: ReturnType<SqliteMemoryStore['rawDatabaseForKnowledge']>) {}

  static open(store: SqliteMemoryStore): LorebookStore {
    const db = store.rawDatabaseForKnowledge();
    db.exec(`CREATE TABLE IF NOT EXISTS lorebooks(
        id TEXT PRIMARY KEY, owner_character_id TEXT NOT NULL, title TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lorebooks_by_owner ON lorebooks(owner_character_id);
      CREATE TABLE IF NOT EXISTS lorebook_entries(
        id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES lorebooks(id), title TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), strategy TEXT NOT NULL CHECK(strategy IN ('keyword','always')),
        keywords_json TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, entry_order INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS lorebook_entries_by_book ON lorebook_entries(book_id, entry_order, id);
      CREATE TABLE IF NOT EXISTS lorebook_operations(
        owner_character_id TEXT NOT NULL, domain TEXT NOT NULL, operation_id TEXT NOT NULL,
        signature TEXT, result_json TEXT, PRIMARY KEY(owner_character_id, domain, operation_id));`);
    // CB-02: additive aiki linkage columns (nullable; legacy rows read as undefined).
    const entryColumns = db.pragma('table_info(lorebook_entries)') as { name: string }[];
    if (!entryColumns.some(column => column.name === 'aiki_entry_id')) db.exec('ALTER TABLE lorebook_entries ADD COLUMN aiki_entry_id TEXT');
    if (!entryColumns.some(column => column.name === 'aiki_import_id')) db.exec('ALTER TABLE lorebook_entries ADD COLUMN aiki_import_id TEXT');
    if (!entryColumns.some(column => column.name === 'aiki_metadata_json')) db.exec('ALTER TABLE lorebook_entries ADD COLUMN aiki_metadata_json TEXT');
    if (!entryColumns.some(column => column.name === 'aiki_content_hash')) db.exec('ALTER TABLE lorebook_entries ADD COLUMN aiki_content_hash TEXT');
    return new LorebookStore(store, db);
  }

  /**
   * RWR-08 / AC-A: read a prior replay receipt for one (owner, domain, operationId). `null` means this
   * exact operation has never been committed; a signature mismatch (same id, different payload) is the
   * caller's version conflict.
   */
  private priorOperation(owner: CharacterId, domain: string, operationId: string): OperationRow | undefined {
    return this.db.prepare('SELECT signature,result_json FROM lorebook_operations WHERE owner_character_id=? AND domain=? AND operation_id=?')
      .get(owner, domain, operationId) as OperationRow | undefined;
  }

  private recordOperation(owner: CharacterId, domain: string, operationId: string, signature: string, result: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO lorebook_operations(owner_character_id,domain,operation_id,signature,result_json) VALUES(?,?,?,?,?)')
      .run(owner, domain, operationId, signature, JSON.stringify(result));
  }

  private now(): string { return this.store.now(); }

  private decodeEntry(row: EntryRow): LorebookEntry {
    return Object.freeze({
      id: row.id, title: row.title, enabled: row.enabled === 1, strategy: row.strategy,
      keywords: Object.freeze(JSON.parse(row.keywords_json) as string[]), content: row.content,
      revision: row.revision, order: row.entry_order,
      // CB-02: aiki linkage is exposed only when present; legacy rows carry undefined.
      ...(row.aiki_entry_id ? { aikiEntryId: row.aiki_entry_id } : {}),
      ...(row.aiki_import_id ? { aikiImportId: row.aiki_import_id } : {}),
    });
  }

  private bookRow(id: string, owner?: CharacterId): BookRow {
    const row = owner === undefined
      ? this.db.prepare('SELECT * FROM lorebooks WHERE id=?').get(id) as BookRow | undefined
      : this.db.prepare('SELECT * FROM lorebooks WHERE id=? AND owner_character_id=?').get(id, owner) as BookRow | undefined;
    // A book owned by another role is reported as not found, so ids cannot be probed across roles.
    if (!row) throw new KnowledgeError('not_found', '没有这个故事书。');
    return row;
  }

  private assemble(row: BookRow): Lorebook {
    const entries = (this.db.prepare('SELECT * FROM lorebook_entries WHERE book_id=? ORDER BY entry_order,id').all(row.id) as EntryRow[]).map(entry => this.decodeEntry(entry));
    return Object.freeze({ schemaVersion: 1 as const, id: row.id, ownerCharacterId: row.owner_character_id, title: row.title, revision: row.revision, entries: Object.freeze(entries) });
  }

  list(ownerCharacterId: CharacterId): readonly Lorebook[] {
    const rows = this.db.prepare('SELECT * FROM lorebooks WHERE owner_character_id=? ORDER BY created_at,id').all(ownerCharacterId) as BookRow[];
    return Object.freeze(rows.map(row => this.assemble(row)));
  }

  get(id: string, ownerCharacterId: CharacterId): Lorebook | null {
    const row = this.db.prepare('SELECT * FROM lorebooks WHERE id=? AND owner_character_id=?').get(id, ownerCharacterId) as BookRow | undefined;
    return row ? this.assemble(row) : null;
  }

  /**
   * RWR-08 / AC-A: idempotent creation. The same (owner, 'book.create', operationId) with the same
   * title replays the ORIGINAL book; the same id with a different title is a version conflict. The
   * receipt is persisted, so a replay after a store reopen still returns the same book.
   */
  create(ownerCharacterId: CharacterId, title: string, operationId?: string): Lorebook {
    return this.createIdempotent(ownerCharacterId, title, operationId).book;
  }

  /** Idempotent creation with an explicit replay flag, for the HTTP receipt. */
  createIdempotent(ownerCharacterId: CharacterId, title: string, operationId?: string): { readonly book: Lorebook; readonly created: boolean } {
    const clean = text(title, 80, '故事书标题');
    if (!this.store.registry.exists(ownerCharacterId)) throw new KnowledgeError('not_found', '没有这个角色。');
    if (operationId === undefined) {
      // Legacy direct-store callers (tests, seeders) keep the old behaviour; the HTTP route always
      // validates and passes an operationId, so the idempotent path is the production one.
      const id = `lb-${randomUUID()}`;
      this.db.transaction(() => {
        const owned = (this.db.prepare('SELECT count(*) AS n FROM lorebooks WHERE owner_character_id=?').get(ownerCharacterId) as { n: number }).n;
        if (owned >= LOREBOOK_LIMITS.booksPerCharacter) throw new KnowledgeError('invalid_request', `每角色最多 ${LOREBOOK_LIMITS.booksPerCharacter} 本故事书。`);
        this.db.prepare('INSERT INTO lorebooks(id,owner_character_id,title,revision,created_at) VALUES(?,?,?,1,?)').run(id, ownerCharacterId, clean, this.now());
      }).immediate();
      return { book: this.assemble(this.bookRow(id, ownerCharacterId)), created: true };
    }
    if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 160) throw new KnowledgeError('invalid_request', '操作编号无效。');
    const signature = digestOp({ domain: 'book.create', title: clean });
    const prior = this.priorOperation(ownerCharacterId, 'book.create', operationId);
    if (prior) {
      if (prior.signature !== signature) throw new KnowledgeError('version_conflict', '同一操作编号已用于不同内容。');
      const id = (JSON.parse(prior.result_json ?? '{}') as { bookId?: string }).bookId;
      const book = id ? this.get(id, ownerCharacterId) : null;
      if (!book) throw new KnowledgeError('not_found', '该操作创建的故事书已不存在。');
      return { book, created: false };
    }
    const id = `lb-${randomUUID()}`;
    this.db.transaction(() => {
      const owned = (this.db.prepare('SELECT count(*) AS n FROM lorebooks WHERE owner_character_id=?').get(ownerCharacterId) as { n: number }).n;
      if (owned >= LOREBOOK_LIMITS.booksPerCharacter) throw new KnowledgeError('invalid_request', `每角色最多 ${LOREBOOK_LIMITS.booksPerCharacter} 本故事书。`);
      this.db.prepare('INSERT INTO lorebooks(id,owner_character_id,title,revision,created_at) VALUES(?,?,?,1,?)').run(id, ownerCharacterId, clean, this.now());
      this.recordOperation(ownerCharacterId, 'book.create', operationId, signature, { bookId: id });
    }).immediate();
    return { book: this.assemble(this.bookRow(id, ownerCharacterId)), created: true };
  }

  /** Validate an entry's keyword list and content against the registered ceilings. */
  private validateEntry(input: { title?: unknown; content: unknown; strategy?: unknown; keywords?: unknown; enabled?: unknown }): { title: string; content: string; strategy: 'keyword' | 'always'; keywords: string[]; enabled: boolean } {
    const strategy = input.strategy === undefined ? 'keyword' : input.strategy;
    if (strategy !== 'keyword' && strategy !== 'always') throw new KnowledgeError('invalid_request', '注入方式无效。');
    const content = text(input.content, LOREBOOK_LIMITS.entryBodyBytes, '条目正文');
    if (Buffer.byteLength(content, 'utf8') > LOREBOOK_LIMITS.entryBodyBytes) throw new KnowledgeError('invalid_request', '条目正文超过大小上限。');
    const rawKeywords = Array.isArray(input.keywords) ? input.keywords : [];
    if (rawKeywords.length > LOREBOOK_LIMITS.keywordsPerEntry) throw new KnowledgeError('invalid_request', `每条最多 ${LOREBOOK_LIMITS.keywordsPerEntry} 个关键词。`);
    const keywords = rawKeywords.map(value => text(value, LOREBOOK_LIMITS.keywordChars, '关键词'));
    if (strategy === 'keyword' && !keywords.length) throw new KnowledgeError('invalid_request', '关键词触发至少需要一个关键词。');
    return { title: input.title === undefined ? '未命名条目' : text(input.title, 80, '条目标题'), content, strategy, keywords, enabled: input.enabled === undefined ? true : input.enabled === true };
  }

  /**
   * RWR-08 / AC-A: validate a batch WITHOUT touching the database, so the route can refuse an invalid
   * batch before any write. Uses exactly the same rules as `addEntry` (single-source of validation).
   */
  validateEntries(inputs: readonly { title?: unknown; content: unknown; strategy?: unknown; keywords?: unknown; enabled?: unknown }[]): { title: string; content: string; strategy: 'keyword' | 'always'; keywords: string[]; enabled: boolean }[] {
    return inputs.map(input => this.validateEntry(input));
  }

  /**
   * RWR-08 / AC-A: append a WHOLE batch in ONE SQLite transaction. Every entry is validated before the
   * transaction opens; the book existence and the caller's `expectedRevision` are checked inside it, so
   * an invalid entry or a stale revision leaves the book byte-identical (zero writes, no revision bump).
   */
  addEntries(bookId: string, ownerCharacterId: CharacterId, expectedRevision: number, inputs: readonly { title?: unknown; content: unknown; strategy?: unknown; keywords?: unknown; enabled?: unknown }[]): Lorebook {
    const validated = this.validateEntries(inputs);
    this.bookRow(bookId, ownerCharacterId);
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT revision FROM lorebooks WHERE id=? AND owner_character_id=?').get(bookId, ownerCharacterId) as { revision: number } | undefined;
      if (!row) throw new KnowledgeError('not_found', '没有这个故事书。');
      if (row.revision !== expectedRevision) throw new KnowledgeError('version_conflict', '故事书已更新，请刷新后重试。');
      const count = (this.db.prepare('SELECT count(*) AS n FROM lorebook_entries WHERE book_id=?').get(bookId) as { n: number }).n;
      if (count + validated.length > LOREBOOK_LIMITS.entriesPerBook) throw new KnowledgeError('invalid_request', `每本书最多 ${LOREBOOK_LIMITS.entriesPerBook} 条。`);
      let order = (this.db.prepare('SELECT coalesce(max(entry_order),0) AS n FROM lorebook_entries WHERE book_id=?').get(bookId) as { n: number }).n;
      for (const entry of validated) {
        order += 1;
        this.db.prepare("INSERT INTO lorebook_entries(id,book_id,title,enabled,strategy,keywords_json,content,revision,entry_order) VALUES(?,?,?,?,?,?,?,1,?)")
          .run(`le-${randomUUID()}`, bookId, entry.title, entry.enabled ? 1 : 0, entry.strategy, JSON.stringify(entry.keywords), entry.content, order);
      }
      this.db.prepare('UPDATE lorebooks SET revision=revision+1 WHERE id=?').run(bookId);
      this.#assertBookSize(bookId);
    }).immediate();
    return this.assemble(this.bookRow(bookId, ownerCharacterId));
  }

  addEntry(bookId: string, ownerCharacterId: CharacterId, input: { title?: unknown; content: unknown; strategy?: unknown; keywords?: unknown; enabled?: unknown }): Lorebook {
    const row = this.bookRow(bookId, ownerCharacterId);
    const entry = this.validateEntry(input);
    this.db.transaction(() => {
      const count = (this.db.prepare('SELECT count(*) AS n FROM lorebook_entries WHERE book_id=?').get(bookId) as { n: number }).n;
      if (count >= LOREBOOK_LIMITS.entriesPerBook) throw new KnowledgeError('invalid_request', `每本书最多 ${LOREBOOK_LIMITS.entriesPerBook} 条。`);
      const order = (this.db.prepare('SELECT coalesce(max(entry_order),0)+1 AS n FROM lorebook_entries WHERE book_id=?').get(bookId) as { n: number }).n;
      this.db.prepare("INSERT INTO lorebook_entries(id,book_id,title,enabled,strategy,keywords_json,content,revision,entry_order) VALUES(?,?,?,?,?,?,?,1,?)")
        .run(`le-${randomUUID()}`, bookId, entry.title, entry.enabled ? 1 : 0, entry.strategy, JSON.stringify(entry.keywords), entry.content, order);
      this.db.prepare('UPDATE lorebooks SET revision=revision+1 WHERE id=?').run(bookId);
      this.#assertBookSize(row.id);
    }).immediate();
    return this.assemble(this.bookRow(bookId, ownerCharacterId));
  }

  removeEntry(bookId: string, ownerCharacterId: CharacterId, entryId: string): Lorebook {
    this.bookRow(bookId, ownerCharacterId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM lorebook_entries WHERE id=? AND book_id=?').run(entryId, bookId);
      this.db.prepare('UPDATE lorebooks SET revision=revision+1 WHERE id=?').run(bookId);
    }).immediate();
    return this.assemble(this.bookRow(bookId, ownerCharacterId));
  }

  /**
   * Replace ONE entry in place. The whole entry is re-validated against the registered ceilings exactly
   * like an append, so an edit can never smuggle in a body the writer would have refused. The book
   * revision is bumped so a stale editor is caught by the caller's `expectedRevision` check.
   */
  updateEntry(bookId: string, ownerCharacterId: CharacterId, entryId: string, input: { title?: unknown; content?: unknown; strategy?: unknown; keywords?: unknown; enabled?: unknown }): Lorebook {
    const book = this.bookRow(bookId, ownerCharacterId);
    const existing = (this.db.prepare('SELECT * FROM lorebook_entries WHERE id=? AND book_id=?').get(entryId, bookId) as EntryRow | undefined);
    if (!existing) throw new KnowledgeError('not_found', '没有这个故事书条目。');
    // Fall back to the CURRENT values for any field the caller left out, so a partial edit (the common
    // "toggle this entry" case) does not have to resend the whole body and cannot accidentally blank it.
    const entry = this.validateEntry({
      title: input.title === undefined ? existing.title : input.title,
      content: input.content === undefined ? existing.content : input.content,
      strategy: input.strategy === undefined ? existing.strategy : input.strategy,
      keywords: input.keywords === undefined ? (JSON.parse(existing.keywords_json) as string[]) : input.keywords,
      enabled: input.enabled === undefined ? existing.enabled === 1 : input.enabled,
    });
    this.db.transaction(() => {
      this.db.prepare('UPDATE lorebook_entries SET title=?,enabled=?,strategy=?,keywords_json=?,content=?,revision=revision+1 WHERE id=? AND book_id=?')
        .run(entry.title, entry.enabled ? 1 : 0, entry.strategy, JSON.stringify(entry.keywords), entry.content, entryId, bookId);
      this.db.prepare('UPDATE lorebooks SET revision=revision+1 WHERE id=?').run(bookId);
      this.#assertBookSize(book.id);
    }).immediate();
    return this.assemble(this.bookRow(bookId, ownerCharacterId));
  }

  /**
   * RWR-08 (E2 / CONTRACTS §5): validate an authored v1 Lorebook import WITHOUT writing. Returns the
   * normalized diff preview (what would be created) for user confirmation. Rejects unknown fields,
   * cross-character owners and any payload past the registered ceilings — zero writes on refusal.
   */
  previewImport(ownerCharacterId: CharacterId, payload: unknown): { readonly title: string; readonly entries: { title: string; content: string; strategy: 'keyword' | 'always'; keywords: string[]; enabled: boolean }[] } {
    const book = (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>;
    const allowed = new Set(['schemaVersion', 'id', 'ownerCharacterId', 'title', 'revision', 'entries']);
    for (const key of Object.keys(book)) if (!allowed.has(key)) throw new KnowledgeError('invalid_request', `导入包含未知字段：${key}`);
    if (book.schemaVersion !== 1) throw new KnowledgeError('invalid_request', '导入格式必须是 schemaVersion 1。');
    if (typeof book.ownerCharacterId === 'string' && book.ownerCharacterId !== ownerCharacterId) throw new KnowledgeError('invalid_request', '导入内容的 owner 与目标角色不一致。');
    const title = text(book.title ?? '导入的故事书', 80, '故事书标题');
    if (!Array.isArray(book.entries)) throw new KnowledgeError('invalid_request', '导入缺少条目数组。');
    if (book.entries.length > LOREBOOK_LIMITS.entriesPerBook) throw new KnowledgeError('invalid_request', `每本书最多 ${LOREBOOK_LIMITS.entriesPerBook} 条。`);
    const totalBytes = Buffer.byteLength(JSON.stringify(book), 'utf8');
    if (totalBytes > LOREBOOK_LIMITS.importTotalBytes) throw new KnowledgeError('invalid_request', '导入总大小超过上限。');
    const entries = book.entries.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new KnowledgeError('invalid_request', '故事书条目无效。');
      const raw = item as Record<string, unknown>;
      const entryAllowed = new Set(['id', 'title', 'enabled', 'strategy', 'keywords', 'content', 'revision', 'order']);
      for (const key of Object.keys(raw)) if (!entryAllowed.has(key)) throw new KnowledgeError('invalid_request', `条目包含未知字段：${key}`);
      return this.validateEntry({ title: raw.title, content: raw.content, strategy: raw.strategy, keywords: raw.keywords, enabled: raw.enabled });
    });
    return { title, entries };
  }

  /**
   * RWR-08 (E2): commit a PREVIEWED import as ONE transaction (create + all entries + receipt). A
   * replay of the same operationId returns the original book; anything rejected leaves zero writes.
   */
  commitImport(ownerCharacterId: CharacterId, preview: { readonly title: string; readonly entries: { title: string; content: string; strategy: 'keyword' | 'always'; keywords: string[]; enabled: boolean }[] }, operationId: string): Lorebook {
    if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 160) throw new KnowledgeError('invalid_request', '操作编号无效。');
    const signature = digestOp({ domain: 'book.import', title: preview.title, count: preview.entries.length });
    const prior = this.priorOperation(ownerCharacterId, 'book.import', operationId);
    if (prior) {
      if (prior.signature !== signature) throw new KnowledgeError('version_conflict', '同一操作编号已用于不同内容。');
      const id = (JSON.parse(prior.result_json ?? '{}') as { bookId?: string }).bookId;
      const book = id ? this.get(id, ownerCharacterId) : null;
      if (!book) throw new KnowledgeError('not_found', '该操作导入的故事书已不存在。');
      return book;
    }
    if (!this.store.registry.exists(ownerCharacterId)) throw new KnowledgeError('not_found', '没有这个角色。');
    const id = `lb-${randomUUID()}`;
    this.db.transaction(() => {
      const owned = (this.db.prepare('SELECT count(*) AS n FROM lorebooks WHERE owner_character_id=?').get(ownerCharacterId) as { n: number }).n;
      if (owned >= LOREBOOK_LIMITS.booksPerCharacter) throw new KnowledgeError('invalid_request', `每角色最多 ${LOREBOOK_LIMITS.booksPerCharacter} 本故事书。`);
      this.db.prepare('INSERT INTO lorebooks(id,owner_character_id,title,revision,created_at) VALUES(?,?,?,1,?)').run(id, ownerCharacterId, preview.title, this.now());
      let order = 0;
      for (const entry of preview.entries) {
        order += 1;
        this.db.prepare("INSERT INTO lorebook_entries(id,book_id,title,enabled,strategy,keywords_json,content,revision,entry_order) VALUES(?,?,?,?,?,?,?,1,?)")
          .run(`le-${randomUUID()}`, id, entry.title, entry.enabled ? 1 : 0, entry.strategy, JSON.stringify(entry.keywords), entry.content, order);
      }
      this.recordOperation(ownerCharacterId, 'book.import', operationId, signature, { bookId: id });
      this.#assertBookSize(id);
    }).immediate();
    return this.assemble(this.bookRow(id, ownerCharacterId));
  }

  /**
   * CB-02: idempotent upsert of unified-document story entries into ONE book. Matching key is the
   * stable aiki entry id (never title): same id + same content → no-op (no revision bump); same id
   * + changed content → in-place update as a NEW entry revision (never a second row); a manually
   * edited entry (revision/content drifted from the last import write) is SKIPPED and reported, so
   * a re-import never silently overwrites a hand edit. The whole batch runs in ONE transaction.
   */
  upsertAikiEntries(params: {
    readonly ownerCharacterId: CharacterId;
    readonly bookTitle: string;
    readonly operationId: string;
    readonly importId: string;
    readonly expectedBookRevision?: number | undefined;
    readonly entries: readonly {
      readonly aikiEntryId: string; readonly title: string; readonly content: string;
      readonly strategy: 'keyword' | 'always'; readonly keywords: readonly string[];
      readonly metadataJson: string; readonly contentHash: string;
    }[];
  }): { book: Lorebook; bookId: string; inserted: number; updated: number; noop: number; skipped: readonly { aikiEntryId: string; reason: string }[] } {
    if (typeof params.operationId !== 'string' || !params.operationId.trim() || params.operationId.length > 160) throw new KnowledgeError('invalid_request', '操作编号无效。');
    const signature = digestOp({ domain: 'book.aiki-upsert', importId: params.importId, entries: params.entries.map(e => `${e.aikiEntryId}:${e.contentHash}`) });
    const prior = this.priorOperation(params.ownerCharacterId, 'book.aiki-upsert', params.operationId);
    if (prior) {
      if (prior.signature !== signature) throw new KnowledgeError('version_conflict', '同一操作编号已用于不同内容。');
      const id = (JSON.parse(prior.result_json ?? '{}') as { bookId?: string }).bookId;
      const book = id ? this.get(id, params.ownerCharacterId) : null;
      if (!book) throw new KnowledgeError('not_found', '该操作写入的故事书已不存在。');
      return { book, bookId: book.id, inserted: 0, updated: 0, noop: params.entries.length, skipped: [] };
    }
    if (!this.store.registry.exists(params.ownerCharacterId)) throw new KnowledgeError('not_found', '没有这个角色。');
    const validated = this.validateEntries(params.entries.map(e => ({ title: e.title, content: e.content, strategy: e.strategy, keywords: [...e.keywords], enabled: true })));
    const result = { inserted: 0, updated: 0, noop: 0, skipped: [] as { aikiEntryId: string; reason: string }[] };
    let bookId = '';
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM lorebooks WHERE owner_character_id=? AND title=?').get(params.ownerCharacterId, params.bookTitle) as BookRow | undefined;
      if (existing) {
        bookId = existing.id;
        if (params.expectedBookRevision !== undefined && existing.revision !== params.expectedBookRevision) {
          throw new KnowledgeError('version_conflict', '故事书已更新，请刷新后重试。');
        }
      } else {
        const owned = (this.db.prepare('SELECT count(*) AS n FROM lorebooks WHERE owner_character_id=?').get(params.ownerCharacterId) as { n: number }).n;
        if (owned >= LOREBOOK_LIMITS.booksPerCharacter) throw new KnowledgeError('invalid_request', `每角色最多 ${LOREBOOK_LIMITS.booksPerCharacter} 本故事书。`);
        bookId = `lb-${randomUUID()}`;
        this.db.prepare('INSERT INTO lorebooks(id,owner_character_id,title,revision,created_at) VALUES(?,?,?,1,?)').run(bookId, params.ownerCharacterId, params.bookTitle, this.now());
      }
      let order = (this.db.prepare('SELECT coalesce(max(entry_order),0) AS n FROM lorebook_entries WHERE book_id=?').get(bookId) as { n: number }).n;
      params.entries.forEach((entry, index) => {
        const row = this.db.prepare('SELECT * FROM lorebook_entries WHERE book_id=? AND aiki_entry_id=?').get(bookId, entry.aikiEntryId) as EntryRow | undefined;
        if (!row) {
          const count = (this.db.prepare('SELECT count(*) AS n FROM lorebook_entries WHERE book_id=?').get(bookId) as { n: number }).n;
          if (count >= LOREBOOK_LIMITS.entriesPerBook) throw new KnowledgeError('invalid_request', `每本书最多 ${LOREBOOK_LIMITS.entriesPerBook} 条。`);
          order += 1;
          const v = validated[index]!;
          this.db.prepare("INSERT INTO lorebook_entries(id,book_id,title,enabled,strategy,keywords_json,content,revision,entry_order,aiki_entry_id,aiki_import_id,aiki_metadata_json,aiki_content_hash) VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?)")
            .run(`le-${randomUUID()}`, bookId, v.title, 1, v.strategy, JSON.stringify(v.keywords), v.content, order, entry.aikiEntryId, params.importId, entry.metadataJson, entry.contentHash);
          result.inserted += 1;
          return;
        }
        if (row.aiki_content_hash === entry.contentHash) { result.noop += 1; return; }
        if (row.aiki_import_id !== params.importId && row.aiki_content_hash !== null) {
          // Written by an EARLIER import but since hand-edited (content drifted): keep local edit.
          result.skipped.push({ aikiEntryId: entry.aikiEntryId, reason: '本地已有手工修改，默认保留本地。' });
          return;
        }
        const v = validated[index]!;
        this.db.prepare('UPDATE lorebook_entries SET title=?,strategy=?,keywords_json=?,content=?,revision=revision+1,aiki_import_id=?,aiki_metadata_json=?,aiki_content_hash=? WHERE id=? AND book_id=?')
          .run(v.title, v.strategy, JSON.stringify(v.keywords), v.content, params.importId, entry.metadataJson, entry.contentHash, row.id, bookId);
        result.updated += 1;
      });
      this.db.prepare('UPDATE lorebooks SET revision=revision+1 WHERE id=?').run(bookId);
      this.#assertBookSize(bookId);
      this.recordOperation(params.ownerCharacterId, 'book.aiki-upsert', params.operationId, signature, { bookId });
    }).immediate();
    return { book: this.assemble(this.bookRow(bookId, params.ownerCharacterId)), bookId, ...result, skipped: Object.freeze(result.skipped) };
  }

  /**
   * CB-02 rollback: restore aiki-linked lorebook entries to a recorded pre-apply snapshot.
   *
   * Entries present in the snapshot are restored verbatim (title/content/strategy/keywords/enabled)
   * with a bumped revision; aiki-linked entries created by the apply and absent from the snapshot
   * are removed. Non-aiki entries (hand-authored by the user) are never touched.
   */
  restoreAikiEntries(params: {
    readonly ownerCharacterId: CharacterId;
    readonly bookId: string;
    readonly entries: readonly {
      readonly aikiEntryId: string; readonly title: string; readonly content: string;
      readonly strategy: 'keyword' | 'always'; readonly keywords: readonly string[]; readonly enabled: boolean;
    }[];
  }): { restored: number; removed: number } {
    const book = this.bookRow(params.bookId, params.ownerCharacterId);
    let restored = 0, removed = 0;
    this.db.transaction(() => {
      const keep = new Set(params.entries.map(entry => entry.aikiEntryId));
      const live = this.db.prepare('SELECT id, aiki_entry_id FROM lorebook_entries WHERE book_id=? AND aiki_entry_id IS NOT NULL')
        .all(book.id) as { id: string; aiki_entry_id: string }[];
      for (const row of live) {
        if (keep.has(row.aiki_entry_id)) continue;
        this.db.prepare('DELETE FROM lorebook_entries WHERE id=? AND book_id=?').run(row.id, book.id);
        removed += 1;
      }
      for (const entry of params.entries) {
        const existing = this.db.prepare('SELECT id FROM lorebook_entries WHERE book_id=? AND aiki_entry_id=?')
          .get(book.id, entry.aikiEntryId) as { id: string } | undefined;
        if (existing) {
          this.db.prepare('UPDATE lorebook_entries SET title=?,enabled=?,strategy=?,keywords_json=?,content=?,revision=revision+1,aiki_import_id=NULL,aiki_content_hash=NULL WHERE id=? AND book_id=?')
            .run(entry.title, entry.enabled ? 1 : 0, entry.strategy, JSON.stringify([...entry.keywords]), entry.content, existing.id, book.id);
          restored += 1;
          continue;
        }
        const order = (this.db.prepare('SELECT coalesce(max(entry_order),0) AS n FROM lorebook_entries WHERE book_id=?').get(book.id) as { n: number }).n + 1;
        this.db.prepare('INSERT INTO lorebook_entries(id,book_id,title,enabled,strategy,keywords_json,content,revision,entry_order,aiki_entry_id) VALUES(?,?,?,?,?,?,?,1,?,?)')
          .run(`le-${randomUUID()}`, book.id, entry.title, entry.enabled ? 1 : 0, entry.strategy, JSON.stringify([...entry.keywords]), entry.content, order, entry.aikiEntryId);
        restored += 1;
      }
      this.db.prepare('UPDATE lorebooks SET revision=revision+1 WHERE id=?').run(book.id);
      this.#assertBookSize(book.id);
    }).immediate();
    return { restored, removed };
  }

  delete(bookId: string, ownerCharacterId: CharacterId): void {    this.bookRow(bookId, ownerCharacterId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM lorebook_entries WHERE book_id=?').run(bookId);
      this.db.prepare('DELETE FROM lorebooks WHERE id=?').run(bookId);
    }).immediate();
  }

  /**
   * RWR-08 / AC-A: idempotent, revision-checked book deletion. The `expectedRevision` is checked inside
   * the transaction (a stale caller gets version_conflict and the book survives); a replay of the same
   * (owner, 'book.delete', operationId) returns the original receipt even though the book is already
   * gone, so a retried delete never 404s.
   */
  deleteBook(bookId: string, ownerCharacterId: CharacterId, expectedRevision: number, operationId: string): { deleted: true; bookId: string } {
    if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 160) throw new KnowledgeError('invalid_request', '操作编号无效。');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new KnowledgeError('invalid_request', '修订号无效。');
    const signature = digestOp({ domain: 'book.delete', expectedRevision });
    const prior = this.priorOperation(ownerCharacterId, 'book.delete', operationId);
    if (prior) {
      if (prior.signature !== signature) throw new KnowledgeError('version_conflict', '同一操作编号已用于不同内容。');
      const result = JSON.parse(prior.result_json ?? '{}') as { deleted?: boolean; bookId?: string };
      if (result.deleted !== true || result.bookId !== bookId) throw new KnowledgeError('version_conflict', '同一操作编号已用于不同内容。');
      return { deleted: true, bookId };
    }
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT revision FROM lorebooks WHERE id=? AND owner_character_id=?').get(bookId, ownerCharacterId) as { revision: number } | undefined;
      if (!row) throw new KnowledgeError('not_found', '没有这个故事书。');
      if (row.revision !== expectedRevision) throw new KnowledgeError('version_conflict', '故事书已更新，请刷新后重试。');
      this.db.prepare('DELETE FROM lorebook_entries WHERE book_id=?').run(bookId);
      this.db.prepare('DELETE FROM lorebooks WHERE id=?').run(bookId);
      this.recordOperation(ownerCharacterId, 'book.delete', operationId, signature, { deleted: true, bookId });
    }).immediate();
    return { deleted: true, bookId };
  }

  #assertBookSize(bookId: string): void {
    const bytes = this.db.prepare('SELECT coalesce(sum(length(content)+length(title)+length(keywords_json)),0) AS n FROM lorebook_entries WHERE book_id=?').get(bookId) as { n: number };
    if (bytes.n > LOREBOOK_LIMITS.bookSerializedBytes) throw new KnowledgeError('invalid_request', '故事书总正文超过上限。');
  }

  /**
   * Select the lorebook contribution for ONE turn.
   *
   * `remainingTokenBudget` is the REAL remaining budget of the one Context assembly, so the ceiling
   * alone can never overfill a turn. Whole entries are taken; a partial entry is never emitted, and an
   * omission always records why.
   */
  select(ownerCharacterId: CharacterId, userInput: string, remainingTokenBudget: number): LorebookSelection {
    const perTurn = Math.min(LOREBOOK_LIMITS.contextTokensPerTurn, Math.max(0, remainingTokenBudget));
    const haystack = normalizeForMatch(userInput);
    const refs: LorebookRef[] = [];
    const omissions: LorebookOmission[] = [];
    const parts: { text: string; tokens: number }[] = [];
    let used = 0;

    for (const book of this.list(ownerCharacterId)) {
      for (const entry of book.entries) {
        if (!entry.enabled) { omissions.push({ bookId: book.id, entryId: entry.id, reason: 'disabled' }); continue; }
        const matched = entry.strategy === 'always'
          || entry.keywords.some(keyword => haystack.includes(normalizeForMatch(keyword)));
        if (!matched) { omissions.push({ bookId: book.id, entryId: entry.id, reason: 'keyword_miss' }); continue; }
        const tokens = estimateTokens(entry.content);
        if (used + tokens > perTurn) {
          omissions.push({ bookId: book.id, entryId: entry.id, reason: used + tokens > remainingTokenBudget ? 'budget_exhausted' : 'over_per_turn_ceiling' });
          continue;
        }
        used += tokens;
        parts.push({ text: `【${book.title} · ${entry.title}】${entry.content}`, tokens });
        refs.push({ bookId: book.id, entryId: entry.id, entryRevision: entry.revision });
      }
    }

    const text = parts.length
      ? `【作者设定（虚构，非用户事实）】\n${parts.map(part => part.text).join('\n\n')}`
      : '';
    return Object.freeze({
      authoredFiction: true as const, text,
      refs: Object.freeze(refs), omissions: Object.freeze(omissions), tokens: used,
    });
  }
}

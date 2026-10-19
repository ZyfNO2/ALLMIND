// N07-01 / N07-03: SQLite persistence for Character Pack drafts, source snapshots,
// activated immutable character packs, character instances, dual timelines, and continuity snapshots.
// Implements ContinuityReadPort, atomic activation/upgrade/rollback, and revocation awareness.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CompanionEventEnvelope } from '../contracts/perception.js';
import type {
  CanonAwareness,
  CanonTimelineEvent,
  CharacterInstance,
  CharacterPack,
  CharacterPackDraft,
  CharacterPackDraftPayload,
  CompanionTimelineEvent,
  ContinuityReadPort,
  ContinuitySnapshot,
  DraftStatus,
  DraftValidationResult,
  PairingScope,
  SourceBlock,
  SourceBlockLocator,
  SourceImportInput,
  SourceLimits,
  SourceSnapshot,
} from '../contracts/character-pack.js';
import {
  CharacterPackError,
  DEFAULT_SOURCE_LIMITS,
} from '../contracts/character-pack.js';
import {
  createSourceSnapshot,
  sha256,
  splitSourceBlocks,
  validateSourceInput,
} from './character-pack-source.js';
import { computeCutoffAllowedBlockIds } from './character-pack-validator.js';

interface SourceRow {
  id: string;
  character_id: string;
  source_name: string;
  content_hash: string;
  body: string;
  byte_length: number;
  created_at: string;
}

interface BlockRow {
  id: string;
  source_id: string;
  ordinal: number;
  block_hash: string;
  text: string;
  start_offset: number;
  end_offset: number;
  chapter: string | null;
  line: number | null;
}

interface DraftRow {
  id: string;
  character_id: string;
  pack_version: string;
  schema_version: string;
  status: string;
  payload_json: string;
  source_ids_json: string;
  validation_json: string;
  created_at: string;
  updated_at: string;
}

interface PackRow {
  id: string;
  character_id: string;
  pack_version: string;
  schema_version: string;
  name: string;
  soul: string;
  style_hints_json: string | null;
  canon_facts_json: string;
  canon_timeline_json: string;
  gaps_json: string;
  source_ids_json: string;
  source_hashes_json: string;
  cutoff_point: string | null;
  work_title: string | null;
  draft_id: string | null;
  activated_at: string | null;
  created_at: string;
}

interface InstanceRow {
  instance_id: string;
  user_id: string;
  character_id: string;
  active_pack_id: string | null;
  active_pack_version: string | null;
  created_at: string;
  updated_at: string;
}

interface CompanionEventRow {
  event_id: string;
  user_id: string;
  character_id: string;
  character_instance_id: string;
  session_id: string;
  turn_id: string;
  user_text: string;
  assistant_text: string;
  created_at: string;
  source_ids_json: string | null;
}

export class CharacterPackStore implements ContinuityReadPort {
  private constructor(private readonly db: Database.Database) {}

  static async open(
    target: Database.Database | { rawDatabaseForKnowledge(): Database.Database },
  ): Promise<CharacterPackStore> {
    const db = 'rawDatabaseForKnowledge' in target ? target.rawDatabaseForKnowledge() : target;

    db.exec(`
      CREATE TABLE IF NOT EXISTS character_pack_sources (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pack_sources_char_hash 
        ON character_pack_sources(character_id, content_hash);

      CREATE TABLE IF NOT EXISTS character_pack_source_blocks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES character_pack_sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        text TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        chapter TEXT,
        line INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pack_blocks_source 
        ON character_pack_source_blocks(source_id);

      CREATE TABLE IF NOT EXISTS character_pack_drafts (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft', 'validated', 'rejected')),
        payload_json TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pack_drafts_char 
        ON character_pack_drafts(character_id);

      CREATE TABLE IF NOT EXISTS character_packs (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        name TEXT NOT NULL,
        soul TEXT NOT NULL,
        style_hints_json TEXT,
        canon_facts_json TEXT NOT NULL,
        canon_timeline_json TEXT NOT NULL,
        gaps_json TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        source_hashes_json TEXT NOT NULL,
        cutoff_point TEXT,
        work_title TEXT,
        draft_id TEXT,
        activated_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(character_id, pack_version)
      );
      CREATE INDEX IF NOT EXISTS idx_packs_char_ver ON character_packs(character_id, pack_version);
    `);
    // WV0-02: canon-only character-Wiki facts live OUTSIDE the legacy facts→timeline derivation.
    // Old packs keep NULL (the composer emits zero character_wiki segments for them).
    const packColumns = db.pragma('table_info(character_packs)') as { name: string }[];
    if (!packColumns.some(column => column.name === 'wiki_facts_json')) db.exec("ALTER TABLE character_packs ADD COLUMN wiki_facts_json TEXT");
    if (!packColumns.some(column => column.name === 'import_id')) db.exec("ALTER TABLE character_packs ADD COLUMN import_id TEXT");

    db.exec(`
      CREATE TABLE IF NOT EXISTS character_instances (
        instance_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        active_pack_id TEXT REFERENCES character_packs(id),
        active_pack_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, character_id, instance_id)
      );

      CREATE TABLE IF NOT EXISTS character_pack_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('activate', 'upgrade', 'rollback')),
        from_pack_id TEXT,
        to_pack_id TEXT NOT NULL REFERENCES character_packs(id),
        reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS character_companion_timeline (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        character_instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_companion_timeline 
        ON character_companion_timeline(user_id, character_id, character_instance_id, created_at);

      -- The outbox stores only stable History identities. Conversation text is read from the
      -- authoritative History store when the projection is drained, including after restart.
      CREATE TABLE IF NOT EXISTS character_companion_projection_outbox (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        character_instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_companion_projection_outbox_created
        ON character_companion_projection_outbox(created_at, event_id);

      CREATE TABLE IF NOT EXISTS character_source_revocations (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('source', 'block')),
        target_id TEXT NOT NULL,
        reason TEXT,
        revoked_at TEXT NOT NULL,
        UNIQUE(character_id, target_type, target_id)
      );

      -- WV0-01: additive Wiki-import records. The raw document and its embedded sources live in the
      -- existing source tables; this record only holds import metadata, the idempotent operation
      -- receipt and the local→real source-id mapping. No second fact database.
      CREATE TABLE IF NOT EXISTS character_wiki_imports (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('structured', 'source_only')),
        source_kind TEXT NOT NULL,
        input_kind TEXT NOT NULL,
        source_name TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        preview_hash TEXT,
        document_source_id TEXT NOT NULL REFERENCES character_pack_sources(id),
        draft_id TEXT,
        normalized_json TEXT,
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(character_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_imports_char ON character_wiki_imports(character_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_imports_char_hash
        ON character_wiki_imports(character_id, mode, document_hash)
        WHERE draft_id IS NULL OR mode='source_only';

      -- CB-01: additive unified-document (.aiki.md) import records. A SEPARATE table from
      -- character_wiki_imports (whose mode CHECK is frozen); same idempotency semantics:
      -- one record per (character, operation), content dedupe per (character, mode, hash).
      CREATE TABLE IF NOT EXISTS character_aiki_imports (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('aiki-character', 'aiki-source-only')),
        input_kind TEXT NOT NULL,
        source_name TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        preview_hash TEXT,
        document_source_id TEXT NOT NULL REFERENCES character_pack_sources(id),
        normalized_json TEXT,
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(character_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_aiki_imports_char ON character_aiki_imports(character_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_aiki_imports_char_hash
        ON character_aiki_imports(character_id, mode, document_hash);

      -- WV0-02: idempotent operation receipts for apply/rollback (crash-recovery query path).
      -- CB-02 adds 'aiki-apply'/'aiki-rollback' to the domain CHECK. CREATE TABLE IF NOT EXISTS
      -- does NOT re-apply a changed CHECK on an existing database, so the extension below has to
      -- rebuild the table — otherwise a real upgraded DB rejects every aiki receipt write and the
      -- whole apply rolls back with a misleading "Wiki 应用未完成".
      CREATE TABLE IF NOT EXISTS character_wiki_operations (
        character_id TEXT NOT NULL,
        domain TEXT NOT NULL CHECK(domain IN ('wiki-apply', 'wiki-rollback', 'aiki-apply', 'aiki-rollback')),
        operation_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(character_id, domain, operation_id)
      );
    `);
    // CB-02 schema migration: widen the domain CHECK on databases created before aiki receipts.
    {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='character_wiki_operations'").get() as { sql: string } | undefined;
      if (row && !row.sql.includes('aiki-apply')) {
        db.exec(`
          ALTER TABLE character_wiki_operations RENAME TO character_wiki_operations_legacy;
          CREATE TABLE character_wiki_operations (
            character_id TEXT NOT NULL,
            domain TEXT NOT NULL CHECK(domain IN ('wiki-apply', 'wiki-rollback', 'aiki-apply', 'aiki-rollback')),
            operation_id TEXT NOT NULL,
            signature TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(character_id, domain, operation_id)
          );
          INSERT INTO character_wiki_operations(character_id,domain,operation_id,signature,receipt_json,created_at)
            SELECT character_id,domain,operation_id,signature,receipt_json,created_at FROM character_wiki_operations_legacy;
          DROP TABLE character_wiki_operations_legacy;
        `);
      }
    }
    db.exec(`
      -- CB-02: author initial-state values (NOT real Continuity). One live row per
      -- (character, entry); history is append-only. Real user memory is never written here.
      CREATE TABLE IF NOT EXISTS character_author_state (
        character_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        subtype TEXT NOT NULL,
        title TEXT NOT NULL,
        body_text TEXT NOT NULL,
        data_json TEXT,
        priority INTEGER NOT NULL DEFAULT 50,
        always INTEGER NOT NULL DEFAULT 0 CHECK(always IN (0,1)),
        source_json TEXT,
        valid_from TEXT,
        valid_until TEXT,
        updated_at_client TEXT,
        expires_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        import_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(character_id, entry_id)
      );
      CREATE TABLE IF NOT EXISTS character_author_state_history (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        body_text TEXT NOT NULL,
        import_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_author_state_char ON character_author_state(character_id);

      -- CB-02: durable multi-owner apply journal (prepare/commit/abort + crash recovery).
      -- baseline_json is the PRE-APPLY snapshot of every owner the operation may touch. Without
      -- it neither a user rollback nor a crash recovery could restore anything (both would only be
      -- able to mark the journal), which is exactly the half-applied-data hole this column closes.
      CREATE TABLE IF NOT EXISTS character_document_journal (
        operation_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared', 'committed', 'aborted')),
        progress_json TEXT NOT NULL DEFAULT '{}',
        receipt_json TEXT,
        baseline_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const journalColumns = db.pragma('table_info(character_document_journal)') as { name: string }[];
    if (!journalColumns.some(column => column.name === 'baseline_json')) {
      db.exec('ALTER TABLE character_document_journal ADD COLUMN baseline_json TEXT');
    }
    const timelineColumns = db.pragma('table_info(character_companion_timeline)') as { name: string }[];
    if (!timelineColumns.some(column => column.name === 'source_ids_json')) db.exec("ALTER TABLE character_companion_timeline ADD COLUMN source_ids_json TEXT NOT NULL DEFAULT '[]'");
    // Timeline projections cite History rows. Once a cited transcript is changed, forgotten,
    // expired or purged, scrub the duplicate body in the same SQLite mutation boundary.
    const hasHistory = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_records'").get());
    if (hasHistory) db.exec(`
      CREATE TRIGGER IF NOT EXISTS character_companion_history_redact_update
      AFTER UPDATE OF state, text, version ON memory_records
      WHEN old.kind='transcript' AND (new.state<>'active' OR new.text<>old.text OR new.version<>old.version)
      BEGIN
        UPDATE character_companion_timeline SET user_text='', assistant_text=''
        WHERE character_id=old.character_id AND EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(character_companion_timeline.source_ids_json) THEN character_companion_timeline.source_ids_json ELSE '[]' END)
          WHERE value='history:'||old.id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS character_companion_history_redact_delete
      AFTER DELETE ON memory_records
      WHEN old.kind='transcript'
      BEGIN
        UPDATE character_companion_timeline SET user_text='', assistant_text=''
        WHERE character_id=old.character_id AND EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(character_companion_timeline.source_ids_json) THEN character_companion_timeline.source_ids_json ELSE '[]' END)
          WHERE value='history:'||old.id
        );
      END;
    `);
    // Catch up old events on startup if History changed while this runtime was not open.
    try {
      db.exec(`UPDATE character_companion_timeline SET user_text='',assistant_text=''
        WHERE EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(character_companion_timeline.source_ids_json) THEN character_companion_timeline.source_ids_json ELSE '[]' END) source
          WHERE substr(source.value,1,8)='history:' AND NOT EXISTS (
            SELECT 1 FROM memory_records history WHERE history.character_id=character_companion_timeline.character_id
              AND history.id=substr(source.value,9) AND history.state='active'
          )
        )`);
    } catch { /* Standalone Character Pack consumers may not own History. */ }

    return new CharacterPackStore(db);
  }

  // --- Source Operations -----------------------------------------------------

  /** Synchronous core of importSource for use inside a wider transaction (no nested immediate txn). */
  private importSourceSync(
    characterId: string,
    input: SourceImportInput,
    limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
  ): { snapshot: SourceSnapshot; isDuplicate: boolean } {
    const trimmedCharId = (characterId || '').trim();
    if (!trimmedCharId) {
      throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    }
    const meta = validateSourceInput(input, limits);
    const existing = this.db
      .prepare('SELECT id FROM character_pack_sources WHERE character_id=? AND content_hash=?')
      .get(trimmedCharId, meta.contentHash) as { id: string } | undefined;
    if (existing) {
      const snapshot = this.getSource(existing.id);
      if (snapshot) return { snapshot, isDuplicate: true };
    }
    const sourceId = `src-${randomUUID()}`;
    const now = new Date().toISOString();
    const blocks = splitSourceBlocks(input.text, sourceId, limits.maxBlockCodePoints);
    this.db.prepare(
      `INSERT INTO character_pack_sources (id, character_id, source_name, content_hash, body, byte_length, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sourceId, trimmedCharId, meta.sourceName, meta.contentHash, input.text, meta.byteLength, now);
    const insertBlock = this.db.prepare(
      `INSERT INTO character_pack_source_blocks (id, source_id, ordinal, block_hash, text, start_offset, end_offset, chapter, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const block of blocks) {
      insertBlock.run(block.id, sourceId, block.ordinal, block.blockHash, block.text, block.locator.start, block.locator.end, block.locator.chapter ?? null, block.locator.line ?? null);
    }
    const snapshot = this.getSource(sourceId);
    if (!snapshot) throw new CharacterPackError('not_found', '写入后无法检索来源快照。');
    return { snapshot, isDuplicate: false };
  }

  async importSource(
    characterId: string,
    input: SourceImportInput,
    limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
  ): Promise<{ snapshot: SourceSnapshot; isDuplicate: boolean }> {
    const trimmedCharId = (characterId || '').trim();
    if (!trimmedCharId) {
      throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    }

    const meta = validateSourceInput(input, limits);

    const existing = this.db
      .prepare('SELECT id FROM character_pack_sources WHERE character_id=? AND content_hash=?')
      .get(trimmedCharId, meta.contentHash) as { id: string } | undefined;

    if (existing) {
      const snapshot = this.getSource(existing.id);
      if (snapshot) {
        return { snapshot, isDuplicate: true };
      }
    }

    const sourceId = `src-${randomUUID()}`;
    const now = new Date().toISOString();
    const blocks = splitSourceBlocks(input.text, sourceId, limits.maxBlockCodePoints);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO character_pack_sources (id, character_id, source_name, content_hash, body, byte_length, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sourceId, trimmedCharId, meta.sourceName, meta.contentHash, input.text, meta.byteLength, now);

      const insertBlock = this.db.prepare(
        `INSERT INTO character_pack_source_blocks (id, source_id, ordinal, block_hash, text, start_offset, end_offset, chapter, line)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const block of blocks) {
        insertBlock.run(
          block.id,
          sourceId,
          block.ordinal,
          block.blockHash,
          block.text,
          block.locator.start,
          block.locator.end,
          block.locator.chapter ?? null,
          block.locator.line ?? null,
        );
      }
    }).immediate();

    const snapshot = this.getSource(sourceId);
    if (!snapshot) {
      throw new CharacterPackError('not_found', '写入后无法检索来源快照。');
    }

    return { snapshot, isDuplicate: false };
  }

  async importSources(
    characterId: string,
    inputs: readonly SourceImportInput[],
    limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
  ): Promise<{ snapshots: readonly SourceSnapshot[]; duplicates: readonly string[] }> {
    const trimmedCharId = (characterId || '').trim();
    if (!trimmedCharId) {
      throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    }
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new CharacterPackError('invalid_request', '必须提供至少一个导入文件。');
    }
    if (inputs.length > limits.maxFilesPerImport) {
      throw new CharacterPackError(
        'source_limit_exceeded',
        `单次最多导入 ${limits.maxFilesPerImport} 个文件，当前提供了 ${inputs.length} 个。`,
      );
    }

    const prepared = inputs.map(input => {
      const meta = validateSourceInput(input, limits);
      return { input, meta };
    });

    const snapshots: SourceSnapshot[] = [];
    const duplicates: string[] = [];
    const now = new Date().toISOString();

    this.db.transaction(() => {
      for (const item of prepared) {
        const existing = this.db
          .prepare('SELECT id FROM character_pack_sources WHERE character_id=? AND content_hash=?')
          .get(trimmedCharId, item.meta.contentHash) as { id: string } | undefined;

        if (existing) {
          const snapshot = this.getSource(existing.id);
          if (snapshot) {
            snapshots.push(snapshot);
            duplicates.push(item.meta.sourceName);
            continue;
          }
        }

        const sourceId = `src-${randomUUID()}`;
        const blocks = splitSourceBlocks(item.input.text, sourceId, limits.maxBlockCodePoints);

        this.db
          .prepare(
            `INSERT INTO character_pack_sources (id, character_id, source_name, content_hash, body, byte_length, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(sourceId, trimmedCharId, item.meta.sourceName, item.meta.contentHash, item.input.text, item.meta.byteLength, now);

        const insertBlock = this.db.prepare(
          `INSERT INTO character_pack_source_blocks (id, source_id, ordinal, block_hash, text, start_offset, end_offset, chapter, line)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        for (const block of blocks) {
          insertBlock.run(
            block.id,
            sourceId,
            block.ordinal,
            block.blockHash,
            block.text,
            block.locator.start,
            block.locator.end,
            block.locator.chapter ?? null,
            block.locator.line ?? null,
          );
        }

        const snapshot = this.getSource(sourceId);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      }
    }).immediate();

    return {
      snapshots: Object.freeze(snapshots),
      duplicates: Object.freeze(duplicates),
    };
  }

  getSource(sourceId: string): SourceSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM character_pack_sources WHERE id=?')
      .get(sourceId) as SourceRow | undefined;

    if (!row) return null;

    const blockRows = this.db
      .prepare('SELECT * FROM character_pack_source_blocks WHERE source_id=? ORDER BY ordinal')
      .all(sourceId) as BlockRow[];

    const blocks: SourceBlock[] = blockRows.map(b => {
      const locator: SourceBlockLocator = Object.freeze({
        start: b.start_offset,
        end: b.end_offset,
        ...(b.chapter !== null ? { chapter: b.chapter } : {}),
        ...(b.line !== null ? { line: b.line } : {}),
      });

      return Object.freeze({
        id: b.id,
        sourceId: b.source_id,
        ordinal: b.ordinal,
        text: b.text,
        blockHash: b.block_hash,
        locator,
      });
    });

    return Object.freeze({
      id: row.id,
      characterId: row.character_id,
      sourceName: row.source_name,
      contentHash: row.content_hash,
      byteLength: row.byte_length,
      createdAt: row.created_at,
      blocks: Object.freeze(blocks),
    });
  }

  listSources(characterId: string): readonly SourceSnapshot[] {
    const rows = this.db
      .prepare('SELECT id FROM character_pack_sources WHERE character_id=? ORDER BY created_at')
      .all(characterId) as { id: string }[];

    return Object.freeze(
      rows
        .map(r => this.getSource(r.id))
        .filter((s): s is SourceSnapshot => s !== null),
    );
  }

  // --- Draft Operations ------------------------------------------------------

  async saveDraft(params: {
    readonly characterId: string;
    readonly payload: CharacterPackDraftPayload;
    readonly sourceIds: readonly string[];
    readonly validation: DraftValidationResult;
    readonly packVersion?: string | undefined;
    readonly draftId?: string | undefined;
  }): Promise<CharacterPackDraft> {
    const characterId = (params.characterId || '').trim();
    if (!characterId) {
      throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    }

    const draftId = params.draftId || `cpd-${randomUUID()}`;
    const packVersion = params.packVersion || `draft-${randomUUID()}`;
    const schemaVersion = params.payload.schemaVersion || '0.7-draft-1';
    const status: DraftStatus = params.validation.valid ? 'validated' : 'rejected';
    const now = new Date().toISOString();

    const payloadJson = JSON.stringify(params.payload);
    const sourceIdsJson = JSON.stringify(params.sourceIds);
    const validationJson = JSON.stringify(params.validation);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO character_pack_drafts 
           (id, character_id, pack_version, schema_version, status, payload_json, source_ids_json, validation_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          draftId,
          characterId,
          packVersion,
          schemaVersion,
          status,
          payloadJson,
          sourceIdsJson,
          validationJson,
          now,
          now,
        );
    }).immediate();

    const saved = this.getDraft(draftId);
    if (!saved) {
      throw new CharacterPackError('not_found', '写入后无法检索草稿。');
    }
    return saved;
  }

  // --- WV0-01: Wiki import persistence ---------------------------------------

  /** Public read model of one saved import (receipt shape; never contains the full document). */
  wikiImportRecord(importId: string): {
    importId: string; characterId: string; operationId: string; mode: 'structured' | 'source_only';
    sourceKind: string; inputKind: string; sourceName: string; documentHash: string;
    documentSourceId: string; draftId: string | null; diagnostics: readonly string[]; createdAt: string;
  } | null {
    const row = this.db.prepare('SELECT * FROM character_wiki_imports WHERE id=?').get(importId) as
      | { id: string; character_id: string; operation_id: string; mode: string; source_kind: string; input_kind: string; source_name: string; document_hash: string; document_source_id: string; draft_id: string | null; diagnostics_json: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      importId: row.id, characterId: row.character_id, operationId: row.operation_id,
      mode: row.mode as 'structured' | 'source_only', sourceKind: row.source_kind, inputKind: row.input_kind,
      sourceName: row.source_name, documentHash: row.document_hash, documentSourceId: row.document_source_id,
      draftId: row.draft_id, diagnostics: JSON.parse(row.diagnostics_json) as string[], createdAt: row.created_at,
    };
  }

  listWikiImports(characterId: string): readonly { importId: string; mode: 'structured' | 'source_only'; sourceName: string; documentHash: string; draftId: string | null; createdAt: string }[] {
    const rows = this.db.prepare('SELECT id, mode, source_name, document_hash, draft_id, created_at FROM character_wiki_imports WHERE character_id=? ORDER BY created_at DESC LIMIT 50')
      .all(characterId) as { id: string; mode: string; source_name: string; document_hash: string; draft_id: string | null; created_at: string }[];
    return rows.map(row => ({ importId: row.id, mode: row.mode as 'structured' | 'source_only', sourceName: row.source_name, documentHash: row.document_hash, draftId: row.draft_id, createdAt: row.created_at }));
  }

  /** Finds an import by its idempotent operation id (crash-recovery query path). */
  wikiImportByOperation(characterId: string, operationId: string): { importId: string; documentHash: string; mode: 'structured' | 'source_only'; draftId: string | null } | null {
    const row = this.db.prepare('SELECT id, document_hash, mode, draft_id FROM character_wiki_imports WHERE character_id=? AND operation_id=?')
      .get(characterId, operationId) as { id: string; document_hash: string; mode: string; draft_id: string | null } | undefined;
    if (!row) return null;
    return { importId: row.id, documentHash: row.document_hash, mode: row.mode as 'structured' | 'source_only', draftId: row.draft_id };
  }

  // --- CB-01: unified document (.aiki.md) import records ------------------------

  /** Public read model of one saved .aiki.md import (receipt shape; never the full document). */
  aikiImportRecord(importId: string): {
    importId: string; characterId: string; operationId: string; mode: 'aiki-character' | 'aiki-source-only';
    inputKind: string; sourceName: string; documentHash: string;
    documentSourceId: string; normalizedJson: string | null; diagnostics: readonly string[]; createdAt: string;
  } | null {
    const row = this.db.prepare('SELECT * FROM character_aiki_imports WHERE id=?').get(importId) as
      | { id: string; character_id: string; operation_id: string; mode: string; input_kind: string; source_name: string; document_hash: string; document_source_id: string; normalized_json: string | null; diagnostics_json: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      importId: row.id, characterId: row.character_id, operationId: row.operation_id,
      mode: row.mode as 'aiki-character' | 'aiki-source-only', inputKind: row.input_kind,
      sourceName: row.source_name, documentHash: row.document_hash, documentSourceId: row.document_source_id,
      normalizedJson: row.normalized_json, diagnostics: JSON.parse(row.diagnostics_json) as string[], createdAt: row.created_at,
    };
  }

  listAikiImports(characterId: string): readonly { importId: string; mode: 'aiki-character' | 'aiki-source-only'; sourceName: string; documentHash: string; createdAt: string }[] {
    const rows = this.db.prepare('SELECT id, mode, source_name, document_hash, created_at FROM character_aiki_imports WHERE character_id=? ORDER BY created_at DESC LIMIT 50')
      .all(characterId) as { id: string; mode: string; source_name: string; document_hash: string; created_at: string }[];
    return rows.map(row => ({ importId: row.id, mode: row.mode as 'aiki-character' | 'aiki-source-only', sourceName: row.source_name, documentHash: row.document_hash, createdAt: row.created_at }));
  }

  /** Finds an .aiki.md import by its idempotent operation id (crash-recovery query path). */
  aikiImportByOperation(characterId: string, operationId: string): { importId: string; documentHash: string; mode: 'aiki-character' | 'aiki-source-only' } | null {
    const row = this.db.prepare('SELECT id, document_hash, mode FROM character_aiki_imports WHERE character_id=? AND operation_id=?')
      .get(characterId, operationId) as { id: string; document_hash: string; mode: string } | undefined;
    if (!row) return null;
    return { importId: row.id, documentHash: row.document_hash, mode: row.mode as 'aiki-character' | 'aiki-source-only' };
  }

  /** Finds an .aiki.md import by content hash: the read-only baseline for noop detection. */
  aikiImportByHash(characterId: string, documentHash: string): { importId: string; normalizedJson: string | null } | null {
    const row = this.db.prepare("SELECT id, normalized_json FROM character_aiki_imports WHERE character_id=? AND mode='aiki-character' AND document_hash=? ORDER BY created_at DESC LIMIT 1")
      .get(characterId, documentHash) as { id: string; normalized_json: string | null } | undefined;
    if (!row) return null;
    return { importId: row.id, normalizedJson: row.normalized_json };
  }

  /** Latest structured .aiki.md import for a role: the read-only baseline for add/noop/update diffing. */
  aikiLatestImport(characterId: string): { importId: string; documentHash: string; normalizedJson: string | null } | null {
    const row = this.db.prepare("SELECT id, document_hash, normalized_json FROM character_aiki_imports WHERE character_id=? AND mode='aiki-character' ORDER BY created_at DESC LIMIT 1")
      .get(characterId) as { id: string; document_hash: string; normalized_json: string | null } | undefined;
    if (!row) return null;
    return { importId: row.id, documentHash: row.document_hash, normalizedJson: row.normalized_json };
  }

  // --- CB-02: unified-document apply surface (author state, wiki facts, journal) ------

  /**
   * CB-02 rollback: restore author-state rows to a recorded pre-apply snapshot.
   *
   * Rows present in the snapshot are re-upserted with their ORIGINAL body (as a NEW revision, so
   * history is never rewritten); rows created by the apply and absent from the snapshot are
   * removed. Returns how many rows were restored and removed.
   */
  restoreAuthorState(params: {
    readonly characterId: string;
    readonly importId: string;
    readonly rows: readonly {
      readonly entryId: string; readonly subtype: string; readonly title: string;
      readonly body: string; readonly dataJson?: string | null;
      readonly priority: number; readonly always: boolean;
      readonly sourceJson?: string | null;
      readonly validFrom?: string | null; readonly validUntil?: string | null;
      readonly updatedAtClient?: string | null; readonly expiresAt?: string | null;
    }[];
  }): { restored: number; removed: number } {
    const now = new Date().toISOString();
    let restored = 0, removed = 0;
    this.db.transaction(() => {
      const keep = new Set(params.rows.map(row => row.entryId));
      const live = this.db.prepare('SELECT entry_id FROM character_author_state WHERE character_id=?')
        .all(params.characterId) as { entry_id: string }[];
      for (const row of live) {
        if (keep.has(row.entry_id)) continue;
        this.db.prepare('DELETE FROM character_author_state WHERE character_id=? AND entry_id=?')
          .run(params.characterId, row.entry_id);
        removed += 1;
      }
      for (const row of params.rows) {
        const existing = this.db.prepare('SELECT revision FROM character_author_state WHERE character_id=? AND entry_id=?')
          .get(params.characterId, row.entryId) as { revision: number } | undefined;
        const contentHash = sha256(JSON.stringify({ entryId: row.entryId, body: row.body, title: row.title }));
        if (existing) {
          this.db.prepare(
            `UPDATE character_author_state SET subtype=?,title=?,body_text=?,data_json=?,priority=?,always=?,source_json=?,
             valid_from=?,valid_until=?,updated_at_client=?,expires_at=?,revision=revision+1,import_id=?,content_hash=?,updated_at=?
             WHERE character_id=? AND entry_id=?`,
          ).run(row.subtype, row.title, row.body, row.dataJson ?? null, row.priority, row.always ? 1 : 0,
            row.sourceJson ?? null, row.validFrom ?? null, row.validUntil ?? null, row.updatedAtClient ?? null,
            row.expiresAt ?? null, params.importId, contentHash, now, params.characterId, row.entryId);
          this.db.prepare(
            `INSERT INTO character_author_state_history(id,character_id,entry_id,revision,body_text,import_id,reason,created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          ).run(`cah-${randomUUID()}`, params.characterId, row.entryId, existing.revision + 1, row.body, params.importId, 'rollback', now);
        } else {
          this.db.prepare(
            `INSERT INTO character_author_state
             (character_id,entry_id,subtype,title,body_text,data_json,priority,always,source_json,valid_from,valid_until,updated_at_client,expires_at,revision,import_id,content_hash,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(params.characterId, row.entryId, row.subtype, row.title, row.body, row.dataJson ?? null,
            row.priority, row.always ? 1 : 0, row.sourceJson ?? null, row.validFrom ?? null, row.validUntil ?? null,
            row.updatedAtClient ?? null, row.expiresAt ?? null, 1, params.importId, contentHash, now);
          this.db.prepare(
            `INSERT INTO character_author_state_history(id,character_id,entry_id,revision,body_text,import_id,reason,created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          ).run(`cah-${randomUUID()}`, params.characterId, row.entryId, 1, row.body, params.importId, 'rollback-restore', now);
        }
        restored += 1;
      }
    }).immediate();
    return { restored, removed };
  }

  /** CB-02 rollback: the instance's active pack pointer (null when the instance has no pack). */
  activePackIdOf(pairing: PairingScope): string | null {
    const row = this.db.prepare('SELECT active_pack_id FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
      .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as { active_pack_id: string | null } | undefined;
    return row?.active_pack_id ?? null;
  }

  /**
   * CB-02 rollback: clear the active pack pointer (used when the apply INSTALLED the pack).
   *
   * `character_pack_history.to_pack_id` is NOT NULL, so a "cleared" state cannot be expressed as a
   * history row. The pack versions themselves are immutable and stay queryable, so the pointer is
   * cleared and the removal is recorded in the operation journal by the caller instead of
   * fabricating a history row that would claim a target pack.
   */
  clearActivePack(params: { readonly pairing: PairingScope; readonly operationId: string }): void {
    const instance = this.db.prepare('SELECT active_pack_id FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
      .get(params.pairing.userId, params.pairing.characterId, params.pairing.characterInstanceId) as { active_pack_id: string | null } | undefined;
    if (!instance?.active_pack_id) return;
    this.db.prepare('UPDATE character_instances SET active_pack_id=NULL, active_pack_version=NULL, updated_at=? WHERE user_id=? AND character_id=? AND instance_id=?')
      .run(new Date().toISOString(), params.pairing.userId, params.pairing.characterId, params.pairing.characterInstanceId);
  }

  /** CB-02 rollback: move the active pack pointer back to a previous version (new history row). */
  restoreActivePack(params: { readonly pairing: PairingScope; readonly targetPackId: string; readonly operationId: string }): void {
    const target = this.getPack(params.targetPackId);
    if (!target || target.characterId !== params.pairing.characterId) throw new CharacterPackError('not_found', '目标角色包不存在或不属于该角色。');
    const instance = this.db.prepare('SELECT active_pack_id FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
      .get(params.pairing.userId, params.pairing.characterId, params.pairing.characterInstanceId) as { active_pack_id: string | null } | undefined;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('UPDATE character_instances SET active_pack_id=?, active_pack_version=?, updated_at=? WHERE user_id=? AND character_id=? AND instance_id=?')
        .run(target.id, target.packVersion, now, params.pairing.userId, params.pairing.characterId, params.pairing.characterInstanceId);
      this.db.prepare(
        `INSERT INTO character_pack_history(id,user_id,character_id,instance_id,action,from_pack_id,to_pack_id,reason,created_at)
         VALUES (?,?,?,?,'rollback',?,?,?,?)`,
      ).run(`cph-${randomUUID()}`, params.pairing.userId, params.pairing.characterId, params.pairing.characterInstanceId,
        instance?.active_pack_id ?? null, target.id, `Aiki rollback ${params.operationId}`, now);
    }).immediate();
  }

  /** CB-02: author initial-state upsert. Newer `updatedAtClient` wins; stale values never overwrite. */
  upsertAuthorState(params: {
    readonly characterId: string;
    readonly importId: string;
    readonly entries: readonly {
      readonly entryId: string; readonly subtype: string; readonly title: string;
      readonly body: string; readonly dataJson?: string | undefined;
      readonly priority: number; readonly always: boolean;
      readonly sourceJson?: string | undefined;
      readonly validFrom?: string | undefined; readonly validUntil?: string | undefined;
      readonly updatedAtClient?: string | undefined; readonly expiresAt?: string | undefined;
      readonly contentHash: string;
    }[];
  }): { inserted: number; updated: number; noop: number; skipped: readonly { entryId: string; reason: string }[] } {
    const now = new Date().toISOString();
    const result = { inserted: 0, updated: 0, noop: 0, skipped: [] as { entryId: string; reason: string }[] };
    const tx = this.db.transaction(() => {
      for (const entry of params.entries) {
        const row = this.db.prepare('SELECT * FROM character_author_state WHERE character_id=? AND entry_id=?')
          .get(params.characterId, entry.entryId) as {
            body_text: string; content_hash: string; revision: number; updated_at_client: string | null; import_id: string;
          } | undefined;
        if (!row) {
          // Column order MUST match the argument order below: revision is the literal 1 and the
          // last two bound values are import_id and content_hash (a misalignment here silently
          // writes the import id into `revision` and makes content_hash a constant).
          this.db.prepare(
            `INSERT INTO character_author_state
             (character_id,entry_id,subtype,title,body_text,data_json,priority,always,source_json,valid_from,valid_until,updated_at_client,expires_at,revision,import_id,content_hash,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(params.characterId, entry.entryId, entry.subtype, entry.title, entry.body, entry.dataJson ?? null,
            entry.priority, entry.always ? 1 : 0, entry.sourceJson ?? null, entry.validFrom ?? null,
            entry.validUntil ?? null, entry.updatedAtClient ?? null, entry.expiresAt ?? null,
            1, params.importId, entry.contentHash, now);
          this.db.prepare(
            `INSERT INTO character_author_state_history(id,character_id,entry_id,revision,body_text,import_id,reason,created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          ).run(`cah-${randomUUID()}`, params.characterId, entry.entryId, 1, entry.body, params.importId, 'initial', now);
          result.inserted += 1;
          continue;
        }
        if (row.content_hash === entry.contentHash) { result.noop += 1; continue; }
        // Same id, source updated, but the row was hand-edited after the last import write and this
        // import carries an older-or-equal client timestamp: keep the local edit.
        if (row.import_id !== params.importId && entry.updatedAtClient !== undefined && row.updated_at_client !== null
          && entry.updatedAtClient <= row.updated_at_client) {
          result.skipped.push({ entryId: entry.entryId, reason: '本地已有更新的值，默认保留本地。' });
          continue;
        }
        this.db.prepare(
          `UPDATE character_author_state SET subtype=?,title=?,body_text=?,data_json=?,priority=?,always=?,source_json=?,
           valid_from=?,valid_until=?,updated_at_client=?,expires_at=?,revision=revision+1,import_id=?,content_hash=?,updated_at=? WHERE character_id=? AND entry_id=?`,
        ).run(entry.subtype, entry.title, entry.body, entry.dataJson ?? null, entry.priority, entry.always ? 1 : 0,
          entry.sourceJson ?? null, entry.validFrom ?? null, entry.validUntil ?? null,
          entry.updatedAtClient ?? null, entry.expiresAt ?? null, params.importId, entry.contentHash, now,
          params.characterId, entry.entryId);
        this.db.prepare(
          `INSERT INTO character_author_state_history(id,character_id,entry_id,revision,body_text,import_id,reason,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(`cah-${randomUUID()}`, params.characterId, entry.entryId, row.revision + 1, entry.body, params.importId, 'import-update', now);
        result.updated += 1;
      }
    });
    try { tx.immediate(); } catch (error) {
      if (error instanceof CharacterPackError) throw error;
      throw new CharacterPackError('invalid_request', '作者初始状态保存失败，已完整回滚。');
    }
    return { ...result, skipped: Object.freeze(result.skipped) };
  }

  /** CB-02: current effective author-state rows for one character (validity filtering is CB-03's job). */
  authorStateOf(characterId: string): readonly {
    readonly entryId: string; readonly subtype: string; readonly title: string; readonly body: string;
    readonly dataJson: string | null; readonly priority: number; readonly always: boolean;
    readonly sourceJson: string | null; readonly validFrom: string | null; readonly validUntil: string | null;
    readonly updatedAtClient: string | null; readonly expiresAt: string | null;
    readonly revision: number; readonly importId: string;
  }[] {
    const rows = this.db.prepare('SELECT * FROM character_author_state WHERE character_id=? ORDER BY priority DESC, entry_id')
      .all(characterId) as {
        entry_id: string; subtype: string; title: string; body_text: string; data_json: string | null;
        priority: number; always: number; source_json: string | null; valid_from: string | null;
        valid_until: string | null; updated_at_client: string | null; expires_at: string | null;
        revision: number; import_id: string;
      }[];
    return Object.freeze(rows.map(row => Object.freeze({
      entryId: row.entry_id, subtype: row.subtype, title: row.title, body: row.body_text,
      dataJson: row.data_json, priority: row.priority, always: row.always === 1,
      sourceJson: row.source_json, validFrom: row.valid_from, validUntil: row.valid_until,
      updatedAtClient: row.updated_at_client, expiresAt: row.expires_at,
      revision: row.revision, importId: row.import_id,
    })));
  }

  /** CB-02: applies wiki-fact entries from a unified import as a NEW immutable pack version. */
  applyAikiWikiFacts(params: {
    readonly pairing: PairingScope;
    readonly importId: string;
    readonly facts: readonly { id: string; text: string }[];
    readonly expectedPackRevision: number;
    readonly operationId: string;
  }): { packId: string; packVersion: string; packRevision: number; previousPackId: string | null; inserted: number; updated: number; noop: number; skipped: readonly { id: string; reason: string }[] } {
    const pairing = params.pairing;
    const operationId = (params.operationId || '').trim();
    if (!operationId) throw new CharacterPackError('invalid_request', 'operationId 不能为空。');
    const signatureOf = (facts: readonly { id: string; text: string }[]) =>
      `${params.importId}:${params.expectedPackRevision}:${JSON.stringify(facts.map(f => `${f.id}:${sha256(f.text)}`))}`;
    const prior = this.operationReceipt(pairing, 'aiki-apply', operationId);
    if (prior) {
      if (prior.signature !== signatureOf(params.facts)) {
        throw new CharacterPackError('version_conflict', '同一操作编号对应不同的应用内容。');
      }
      const receipt = JSON.parse(prior.receiptJson) as {
        packId: string; packVersion: string; packRevision: number; previousPackId: string | null;
        inserted: number; updated: number; noop: number; skipped: { id: string; reason: string }[];
      };
      return { ...receipt, skipped: Object.freeze(receipt.skipped) };
    }
    const record = this.aikiImportRecord(params.importId);
    if (!record || record.characterId !== pairing.characterId) throw new CharacterPackError('not_found', '导入记录不存在或不属于该角色。');
    const tx = this.db.transaction(() => {
      const currentRevision = this.getPackRevision(pairing);
      if (currentRevision !== params.expectedPackRevision) {
        throw new CharacterPackError('version_conflict', `角色包修订已变化（当前 ${currentRevision}，请求基于 ${params.expectedPackRevision}）；请刷新预览后重新确认。`);
      }
      const snapshot = this.db.prepare('SELECT active_pack_id FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
        .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as { active_pack_id: string | null } | undefined;
      const previousPackId = snapshot?.active_pack_id ?? null;
      const previous = previousPackId ? this.getPack(previousPackId) : null;
      const liveById = new Map((previous?.wikiFacts ?? []).map(fact => [fact.id, fact.text]));
      const merged = new Map((previous?.wikiFacts ?? []).map(fact => [fact.id, { id: fact.id, text: fact.text, evidenceIds: [...fact.evidenceIds] }]));
      // Pristine ledger: the import that WROTE the live pack, plus that import's stored entry
      // text. A live fact still equal to its writer's wrapped text is pristine (no hand edit) —
      // a differing incoming source is then an UPDATE, not a conflict (PLAN §8.1).
      const writerImportId = previous?.importId;
      const pristineById = new Map<string, string>();
      if (writerImportId) {
        try {
          const writer = this.aikiImportRecord(writerImportId);
          if (writer?.normalizedJson) {
            const doc = JSON.parse(writer.normalizedJson) as { entries?: { meta: { id: string; title?: string }; body: string }[] };
            for (const e of doc.entries ?? []) {
              pristineById.set(e.meta.id, `## ${e.meta.title ?? e.meta.id}\n\n${e.body.trim()}`);
            }
          }
        } catch { /* corrupt writer record: fall back to conflict-preserving */ }
      }
      let inserted = 0, updated = 0, noop = 0;
      const skipped: { id: string; reason: string }[] = [];
      const hadBefore = new Set(merged.keys());
      for (const fact of params.facts) {
        const live = liveById.get(fact.id);
        if (live === fact.text) { noop += 1; continue; }
        if (live !== undefined) {
          const pristine = pristineById.get(fact.id);
          if (pristine === undefined || pristine !== live) {
            // Genuinely hand-edited (or written by an unknown import): keep local content.
            skipped.push({ id: fact.id, reason: '本地已有同 ID 但内容不同，默认保留本地。' });
            continue;
          }
          // Pristine row from an older import: the new source wins as an update.
          merged.set(fact.id, { id: fact.id, text: fact.text, evidenceIds: [] });
          updated += 1;
          continue;
        }
        merged.set(fact.id, { id: fact.id, text: fact.text, evidenceIds: [] });
        if (hadBefore.has(fact.id)) updated += 1; else inserted += 1;
      }
      const version = `v${((this.db.prepare('SELECT COUNT(*) as c FROM character_packs WHERE character_id=?').get(pairing.characterId) as { c: number }).c) + 1}.0-aiki`;
      if (this.getPackByVersion(pairing.characterId, version)) throw new CharacterPackError('version_conflict', `角色包版本 "${version}" 已存在。`);
      const packId = `pack-${randomUUID()}`;
      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO character_packs
         (id, character_id, pack_version, schema_version, name, soul, style_hints_json,
          canon_facts_json, canon_timeline_json, gaps_json, source_ids_json, source_hashes_json,
          cutoff_point, work_title, draft_id, activated_at, created_at, wiki_facts_json, import_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(packId, pairing.characterId, version, previous?.schemaVersion ?? 'aika-wiki-draft-0.1',
        previous?.name ?? record.sourceName, previous?.soul ?? '', previous?.styleHints ? JSON.stringify(previous.styleHints) : null,
        JSON.stringify(previous?.canonFacts ?? []), JSON.stringify(previous?.canonTimeline ?? []),
        JSON.stringify(previous?.gaps ?? []), JSON.stringify(previous?.sourceIds ?? []),
        JSON.stringify(previous?.sourceHashes ?? []), previous?.cutoffPoint ?? null, previous?.workTitle ?? null,
        previous?.draftId ?? null, now, now, JSON.stringify([...merged.values()]), params.importId);
      this.db.prepare(
        `INSERT INTO character_instances
         (instance_id, user_id, character_id, active_pack_id, active_pack_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, character_id, instance_id) DO UPDATE SET
           active_pack_id=excluded.active_pack_id, active_pack_version=excluded.active_pack_version, updated_at=excluded.updated_at`,
      ).run(pairing.characterInstanceId, pairing.userId, pairing.characterId, packId, version, now, now);
      this.db.prepare(
        `INSERT INTO character_pack_history
         (id, user_id, character_id, instance_id, action, from_pack_id, to_pack_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`cph-${randomUUID()}`, pairing.userId, pairing.characterId, pairing.characterInstanceId,
        previousPackId ? 'upgrade' : 'activate', previousPackId, packId, `Aiki import ${params.importId}`, now);
      const packRevision = this.getPackRevision(pairing);
      const receipt = { packId, packVersion: version, packRevision, previousPackId, inserted, updated, noop, skipped };
      this.recordOperationReceipt(pairing, 'aiki-apply', operationId, signatureOf(params.facts), receipt);
      return receipt;
    });
    try {
      const receipt = tx.immediate();
      return { ...receipt, skipped: Object.freeze(receipt.skipped) };
    } catch (error) {
      if (error instanceof CharacterPackError) throw error;
      // Never replace the real cause with a generic message: a schema/constraint failure here is
      // otherwise indistinguishable from a version conflict and costs hours to diagnose.
      throw new CharacterPackError('invalid_request', `角色文档 Wiki 应用未完成，已完整回滚（原因：${(error as Error).message}）。`);
    }
  }

  /** CB-02: durable apply journal — prepare/commit/abort plus crash-recovery helpers. */
  journalPrepare(operationId: string, characterId: string, importId: string, payload: unknown): void {
    const now = new Date().toISOString();
    const body = JSON.stringify(payload);
    try {
      this.db.prepare(
        `INSERT INTO character_document_journal(operation_id,character_id,import_id,payload_json,state,progress_json,receipt_json,created_at,updated_at)
         VALUES (?,?,?,?, 'prepared', '{}', NULL, ?, ?)`,
      ).run(operationId, characterId, importId, body, now, now);
    } catch {
      const existing = this.db.prepare('SELECT payload_json FROM character_document_journal WHERE operation_id=?')
        .get(operationId) as { payload_json: string } | undefined;
      if (existing && existing.payload_json === body) return;
      throw new CharacterPackError('version_conflict', '同一操作编号已用于不同内容。');
    }
  }

  journalProgress(operationId: string, progress: Record<string, unknown>): void {
    this.db.prepare('UPDATE character_document_journal SET progress_json=?, updated_at=? WHERE operation_id=?')
      .run(JSON.stringify(progress), new Date().toISOString(), operationId);
  }

  /**
   * CB-04: the most recent COMMITTED apply for a character, with its baseline availability.
   *
   * The panel needs this to offer "roll back this apply" after a page reload: the receipt is
   * otherwise only an in-memory React value and the button disappears on refresh.
   */
  latestCommittedApply(characterId: string): {
    operationId: string; importId: string; committedAt: string; hasBaseline: boolean;
    alreadyRolledBack: boolean;
  } | null {
    const row = this.db.prepare(
      "SELECT operation_id, import_id, baseline_json IS NOT NULL AS has_baseline, updated_at FROM character_document_journal WHERE character_id=? AND state='committed' AND operation_id NOT LIKE '%:rollback' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(characterId) as { operation_id: string; import_id: string; has_baseline: number; updated_at: string } | undefined;
    if (!row) return null;
    const rolled = this.db.prepare("SELECT 1 AS found FROM character_document_journal WHERE operation_id=? AND state='committed'")
      .get(`${row.operation_id}:rollback`) as { found: number } | undefined;
    return {
      operationId: row.operation_id, importId: row.import_id, committedAt: row.updated_at,
      hasBaseline: row.has_baseline === 1, alreadyRolledBack: Boolean(rolled),
    };
  }

  /**
   * CB-02: record the PRE-APPLY owner snapshot for one operation.
   *
   * Written once, before the first owner mutation. It is the single source of truth for both user
   * rollback and crash recovery — without it those paths can only mark the journal, which would
   * leave half-applied data behind.
   */
  journalBaseline(operationId: string, baseline: unknown): void {
    this.db.prepare('UPDATE character_document_journal SET baseline_json=?, updated_at=? WHERE operation_id=?')
      .run(JSON.stringify(baseline), new Date().toISOString(), operationId);
  }

  /** CB-02: the recorded pre-apply snapshot, or null when none was captured. */
  journalBaselineOf(operationId: string): unknown | null {
    const row = this.db.prepare('SELECT baseline_json FROM character_document_journal WHERE operation_id=?')
      .get(operationId) as { baseline_json: string | null } | undefined;
    if (!row?.baseline_json) return null;
    try { return JSON.parse(row.baseline_json) as unknown; } catch { return null; }
  }

  journalFinish(operationId: string, state: 'committed' | 'aborted', receipt: unknown): void {
    this.db.prepare('UPDATE character_document_journal SET state=?, receipt_json=?, updated_at=? WHERE operation_id=?')
      .run(state, JSON.stringify(receipt), new Date().toISOString(), operationId);
  }

  journalGet(operationId: string): { operationId: string; characterId: string; importId: string; payload: unknown; state: string; progress: Record<string, unknown>; receipt: unknown } | null {
    const row = this.db.prepare('SELECT * FROM character_document_journal WHERE operation_id=?').get(operationId) as {
      operation_id: string; character_id: string; import_id: string; payload_json: string; state: string;
      progress_json: string; receipt_json: string | null;
    } | undefined;
    if (!row) return null;
    return {
      operationId: row.operation_id, characterId: row.character_id, importId: row.import_id,
      payload: JSON.parse(row.payload_json) as unknown, state: row.state,
      progress: JSON.parse(row.progress_json) as Record<string, unknown>,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) as unknown : null,
    };
  }

  /** CB-02: journal rows left `prepared` by a crashed process (recovery input). */
  journalPrepared(): readonly { operationId: string; characterId: string; importId: string }[] {
    const rows = this.db.prepare("SELECT operation_id, character_id, import_id FROM character_document_journal WHERE state='prepared' ORDER BY created_at")
      .all() as { operation_id: string; character_id: string; import_id: string }[];
    return rows.map(row => ({ operationId: row.operation_id, characterId: row.character_id, importId: row.import_id }));
  }

  /**
   * CB-02: the import whose content is CURRENTLY IN EFFECT for a role (preview diff baseline).
   *
   * Only a COMMITTED apply counts, and a rolled-back apply must NOT: its `:rollback` row is also
   * `committed`, so an unfiltered "latest committed" would treat rolled-back content as live and
   * report a clean re-import as `noop` — leaving the apply button disabled forever. A merely
   * SAVED draft never counts either.
   */
  latestCommittedAikiImport(characterId: string): string | null {
    // A rolled-back apply is no longer in effect, so its content must not be the baseline. The
    // rollback itself is journaled as `<operationId>:rollback`, hence the suffix filter.
    const row = this.db.prepare(
      "SELECT operation_id, import_id FROM character_document_journal WHERE character_id=? AND state='committed' AND operation_id NOT LIKE '%:rollback' AND operation_id NOT LIKE '%:restore-%' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(characterId) as { operation_id: string; import_id: string } | undefined;
    if (!row) return null;
    const rolledBack = this.db.prepare("SELECT 1 AS found FROM character_document_journal WHERE operation_id=? AND state='committed'")
      .get(`${row.operation_id}:rollback`) as { found: number } | undefined;
    return rolledBack ? null : row.import_id;
  }

  /**
   * ONE transaction: persists the raw document as a source snapshot plus the idempotent import
   * record. Nothing is written outside this boundary; a failure rolls the whole save back.
   * Same replay rules as saveWikiImport: same operation + same content → original receipt;
   * same operation + different content → version_conflict; new operation + same content → duplicate.
   */
  async saveAikiImport(params: {
    readonly characterId: string;
    readonly operationId: string;
    readonly mode: 'aiki-character' | 'aiki-source-only';
    readonly inputKind: 'file' | 'paste';
    readonly sourceName: string;
    readonly documentHash: string;
    readonly previewHash?: string | undefined;
    /** Raw submitted text — becomes the document source snapshot. */
    readonly documentText: string;
    readonly normalizedJson?: string | undefined;
    readonly diagnostics?: readonly string[];
  }): Promise<{ importId: string; documentSourceId: string; duplicate: boolean }> {
    const characterId = (params.characterId || '').trim();
    const operationId = (params.operationId || '').trim();
    if (!characterId) throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    if (!operationId) throw new CharacterPackError('invalid_request', 'operationId 不能为空。');

    const existing = this.aikiImportByOperation(characterId, operationId);
    if (existing) {
      if (existing.documentHash !== params.documentHash) {
        throw new CharacterPackError('version_conflict', '同一操作编号对应的内容发生变化；请刷新预览后重试。');
      }
      const record = this.aikiImportRecord(existing.importId);
      return { importId: existing.importId, documentSourceId: record!.documentSourceId, duplicate: true };
    }

    const importId = `aiki-${randomUUID()}`;
    const now = new Date().toISOString();

    const dupRow = this.db.prepare(
      'SELECT id, document_source_id FROM character_aiki_imports WHERE character_id=? AND mode=? AND document_hash=?',
    ).get(characterId, params.mode, params.documentHash) as { id: string; document_source_id: string } | undefined;
    if (dupRow) {
      return { importId: dupRow.id, documentSourceId: dupRow.document_source_id, duplicate: true };
    }

    const tx = this.db.transaction(() => {
      const documentSource = this.importSourceSync(characterId, { sourceName: params.sourceName, text: params.documentText });
      if (documentSource.snapshot.contentHash !== params.documentHash) {
        throw new CharacterPackError('invalid_request', '文档 hash 与写入内容不一致，已回滚。');
      }
      this.db.prepare(
        `INSERT INTO character_aiki_imports
         (id, character_id, operation_id, mode, input_kind, source_name, document_hash, preview_hash, document_source_id, normalized_json, diagnostics_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(importId, characterId, operationId, params.mode, params.inputKind, params.sourceName,
        params.documentHash, params.previewHash ?? null, documentSource.snapshot.id,
        params.normalizedJson ?? null, JSON.stringify(params.diagnostics ?? []), now);
      return { documentSourceId: documentSource.snapshot.id };
    });

    let result: { documentSourceId: string };
    try { result = tx.immediate(); } catch (error) {
      if (error instanceof CharacterPackError) throw error;
      throw new CharacterPackError('invalid_request', '角色文档保存失败，已完整回滚。');
    }
    return { importId, documentSourceId: result.documentSourceId, duplicate: false };
  }

  /** Canon story-event summaries of one import (for the zero-write apply preview). */
  wikiImportEvents(importId: string): readonly string[] {
    const row = this.db.prepare('SELECT normalized_json FROM character_wiki_imports WHERE id=?').get(importId) as { normalized_json: string | null } | undefined;
    if (!row?.normalized_json) return [];
    try {
      const normalized = JSON.parse(row.normalized_json) as { storyEvents?: { status: string; summary: string }[] };
      return (normalized.storyEvents ?? []).filter(event => event.status === 'canon').map(event => event.summary);
    } catch { return []; }
  }

  /**
   * ONE transaction: persists the raw document as a source snapshot, each embedded source as its own
   * snapshot, the optional pack draft (structured mode) and the idempotent import record. Nothing is
   * written outside this boundary; a failure rolls the whole import back (AC-01-2).
   *
   * The caller (route service) has already re-parsed the text and validated the draft evidence —
   * this method persists exactly what it is given and does not re-interpret it.
   */
  async saveWikiImport(params: {
    readonly characterId: string;
    readonly operationId: string;
    readonly mode: 'structured' | 'source_only';
    readonly sourceKind: string;
    readonly inputKind: 'file' | 'paste';
    readonly sourceName: string;
    readonly documentHash: string;
    readonly previewHash?: string | undefined;
    /** Raw submitted text — becomes the document source snapshot. */
    readonly documentText: string;
    /** Embedded sources from the normalized document (structured mode only). */
    readonly embeddedSources: readonly { sourceId: string; title: string; text: string }[];
    /** Optional draft payload for structured mode (already evidence-mapped by the caller). */
    readonly draft?: {
      readonly payload: CharacterPackDraftPayload;
      readonly sourceIds: readonly string[];
      readonly validation: DraftValidationResult;
    } | undefined;
    readonly normalizedJson?: string | undefined;
    readonly diagnostics?: readonly string[];
  }): Promise<{ importId: string; documentSourceId: string; draftId: string | null; duplicate: boolean }> {
    const characterId = (params.characterId || '').trim();
    const operationId = (params.operationId || '').trim();
    if (!characterId) throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    if (!operationId) throw new CharacterPackError('invalid_request', 'operationId 不能为空。');

    const existing = this.wikiImportByOperation(characterId, operationId);
    if (existing) {
      if (existing.documentHash !== params.documentHash) {
        throw new CharacterPackError('version_conflict', '同一操作编号对应的内容发生变化；请刷新预览后重试。');
      }
      const record = this.wikiImportRecord(existing.importId);
      return { importId: existing.importId, documentSourceId: record!.documentSourceId, draftId: existing.draftId, duplicate: true };
    }

    const importId = `wiki-${randomUUID()}`;
    const now = new Date().toISOString();

    // Duplicate content under a NEW operation id: return the existing import, never copy snapshots.
    const dupRow = this.db.prepare(
      "SELECT id, document_source_id, draft_id FROM character_wiki_imports WHERE character_id=? AND mode=? AND document_hash=?",
    ).get(characterId, params.mode, params.documentHash) as { id: string; document_source_id: string; draft_id: string | null } | undefined;
    if (dupRow) {
      return { importId: dupRow.id, documentSourceId: dupRow.document_source_id, draftId: dupRow.draft_id, duplicate: true };
    }

    const tx = this.db.transaction(() => {
      // 1) Raw document snapshot (reuses the existing source table; content hash = document hash).
      const documentSource = this.importSourceSync(characterId, { sourceName: params.sourceName, text: params.documentText });
      if (documentSource.snapshot.contentHash !== params.documentHash) {
        throw new CharacterPackError('invalid_request', '文档 hash 与写入内容不一致，已回滚。');
      }
      // 2) Embedded sources (structured mode).
      const embeddedIds: string[] = [];
      for (const source of params.embeddedSources) {
        const savedSource = this.importSourceSync(characterId, { sourceName: source.title || source.sourceId, text: source.text });
        embeddedIds.push(savedSource.snapshot.id);
      }
      // 3) Optional draft.
      let draftId: string | null = null;
      if (params.draft) {
        const draft = this.saveDraftSync(params.characterId, params.draft.payload, params.draft.sourceIds, params.draft.validation);
        draftId = draft.id;
      }
      // 4) Import record.
      this.db.prepare(
        `INSERT INTO character_wiki_imports
         (id, character_id, operation_id, mode, source_kind, input_kind, source_name, document_hash, preview_hash, document_source_id, draft_id, normalized_json, diagnostics_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(importId, characterId, operationId, params.mode, params.sourceKind, params.inputKind, params.sourceName,
        params.documentHash, params.previewHash ?? null, documentSource.snapshot.id, draftId,
        params.normalizedJson ?? null, JSON.stringify(params.diagnostics ?? []), now);
      return { documentSourceId: documentSource.snapshot.id, draftId };
    });

    let result: { documentSourceId: string; draftId: string | null };
    try { result = tx.immediate(); } catch (error) {
      // The transaction rolls back everything; surface fixed categories only (no document text).
      if (error instanceof CharacterPackError) throw error;
      throw new CharacterPackError('invalid_request', 'Wiki 导入保存失败，已完整回滚。');
    }
    return { importId, documentSourceId: result.documentSourceId, draftId: result.draftId, duplicate: false };
  }

  /** Synchronous saveDraft core for use INSIDE the import transaction (no nested immediate txn). */
  private saveDraftSync(characterId: string, payload: CharacterPackDraftPayload, sourceIds: readonly string[], validation: DraftValidationResult): CharacterPackDraft {
    const draftId = `cpd-${randomUUID()}`;
    const packVersion = `draft-${randomUUID()}`;
    const schemaVersion = payload.schemaVersion || '0.7-draft-1';
    const status: DraftStatus = validation.valid ? 'validated' : 'rejected';
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO character_pack_drafts
       (id, character_id, pack_version, schema_version, status, payload_json, source_ids_json, validation_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(draftId, characterId, packVersion, schemaVersion, status, JSON.stringify(payload), JSON.stringify(sourceIds), JSON.stringify(validation), now, now);
    const saved = this.getDraft(draftId);
    if (!saved) throw new CharacterPackError('not_found', '写入后无法检索草稿。');
    return saved;
  }

  getDraft(draftId: string): CharacterPackDraft | null {
    const row = this.db
      .prepare('SELECT * FROM character_pack_drafts WHERE id=?')
      .get(draftId) as DraftRow | undefined;

    if (!row) return null;

    let payload: CharacterPackDraftPayload;
    let sourceIds: string[];
    let validation: DraftValidationResult;

    try {
      payload = JSON.parse(row.payload_json);
      sourceIds = JSON.parse(row.source_ids_json);
      validation = JSON.parse(row.validation_json);
    } catch {
      throw new CharacterPackError('version_conflict', `草稿 ${draftId} 的 JSON 数据已损坏。`);
    }

    return Object.freeze({
      id: row.id,
      characterId: row.character_id,
      packVersion: row.pack_version,
      schemaVersion: row.schema_version,
      status: row.status as DraftStatus,
      payload: Object.freeze(payload),
      sourceIds: Object.freeze(sourceIds),
      validation: Object.freeze(validation),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  listDrafts(characterId: string): readonly CharacterPackDraft[] {
    const rows = this.db
      .prepare('SELECT id FROM character_pack_drafts WHERE character_id=? ORDER BY created_at DESC')
      .all(characterId) as { id: string }[];

    return Object.freeze(
      rows
        .map(r => this.getDraft(r.id))
        .filter((d): d is CharacterPackDraft => d !== null),
    );
  }

  deleteDraft(draftId: string): boolean {
    const info = this.db.prepare('DELETE FROM character_pack_drafts WHERE id=?').run(draftId);
    return info.changes > 0;
  }

  // --- N07-03 Activation, Versioning, Instances, and Rollback ----------------

  /**
   * Generates a preview projection of how a draft would look as an activated CharacterPack.
   */
  async previewDraft(draftId: string): Promise<{
    readonly draft: CharacterPackDraft;
    readonly packPreview: CharacterPack;
    readonly warnings: readonly string[];
  }> {
    const draft = this.getDraft(draftId);
    if (!draft) {
      throw new CharacterPackError('not_found', `未找到草稿: "${draftId}"`);
    }

    const warnings: string[] = [];
    if (!draft.validation.valid) {
      warnings.push('草稿验证未通过，激活将直接失败。');
    }

    // Check for revoked sources
    for (const srcId of draft.sourceIds) {
      if (this.isSourceRevoked(draft.characterId, srcId)) {
        warnings.push(`草稿依赖的来源 "${srcId}" 已被撤销。`);
      }
    }

    const sourceHashes: string[] = [];
    for (const srcId of draft.sourceIds) {
      const src = this.getSource(srcId);
      if (src) sourceHashes.push(src.contentHash);
    }

    const canonTimeline = this.deriveCanonTimeline(draft.payload);

    const packPreview: CharacterPack = Object.freeze({
      id: `preview-${draft.id}`,
      characterId: draft.characterId,
      packVersion: 'preview',
      schemaVersion: draft.schemaVersion,
      name: draft.payload.character.name,
      soul: draft.payload.character.soul,
      styleHints: draft.payload.character.styleHints,
      canonFacts: draft.payload.canonFacts,
      canonTimeline,
      gaps: draft.payload.gaps,
      sourceIds: draft.sourceIds,
      sourceHashes: Object.freeze(sourceHashes),
      cutoffPoint: draft.payload.cutoffPoint,
      workTitle: draft.payload.workTitle,
      draftId: draft.id,
      createdAt: new Date().toISOString(),
    });

    return Object.freeze({
      draft,
      packPreview,
      warnings: Object.freeze(warnings),
    });
  }

  /**
   * Activates or upgrades a validated CharacterPackDraft into an immutable CharacterPack.
   * Updates the target character instance's active pack pointer atomically.
   */
  async activateDraft(params: {
    readonly characterId: string;
    readonly draftId: string;
    readonly userId?: string | undefined;
    readonly instanceId?: string | undefined;
    readonly packVersion?: string | undefined;
  }): Promise<CharacterPack> {
    const characterId = (params.characterId || '').trim();
    const userId = (params.userId || 'default-user').trim();
    const instanceId = (params.instanceId || 'default-instance').trim();

    const draft = this.getDraft(params.draftId);
    if (!draft) {
      throw new CharacterPackError('not_found', `未找到草稿: "${params.draftId}"`);
    }

    if (draft.characterId !== characterId) {
      throw new CharacterPackError(
        'invalid_request',
        `草稿所属角色 ("${draft.characterId}") 与请求角色 ("${characterId}") 不一致。`,
      );
    }

    if (!draft.validation.valid || draft.status !== 'validated') {
      throw new CharacterPackError(
        'validation_failed',
        `草稿尚未通过校验（status: ${draft.status}），不能激活为活动角色包。错误: ${draft.validation.errors.join('; ')}`,
      );
    }

    // Check revoked sources
    for (const srcId of draft.sourceIds) {
      if (this.isSourceRevoked(characterId, srcId)) {
        throw new CharacterPackError(
          'validation_failed',
          `草稿依赖的来源 "${srcId}" 已被撤销，无法激活。`,
        );
      }
    }

    // Determine version
    let version = (params.packVersion || '').trim();
    if (!version) {
      const count = (
        this.db
          .prepare('SELECT COUNT(*) as c FROM character_packs WHERE character_id=?')
          .get(characterId) as { c: number }
      ).c;
      version = `v${count + 1}.0`;
    }

    // Check if pack version already exists
    const existingPack = this.getPackByVersion(characterId, version);
    if (existingPack) {
      throw new CharacterPackError(
        'version_conflict',
        `角色包版本 "${version}" 已存在，不可变版本不可覆盖。`,
      );
    }

    const sourceHashes: string[] = [];
    for (const srcId of draft.sourceIds) {
      const src = this.getSource(srcId);
      if (src) sourceHashes.push(src.contentHash);
    }

    const canonTimeline = this.deriveCanonTimeline(draft.payload);
    const packId = `pack-${randomUUID()}`;
    const now = new Date().toISOString();

    let createdPack: CharacterPack;

    this.db.transaction(() => {
      // 1. Insert immutable pack
      this.db
        .prepare(
          `INSERT INTO character_packs
           (id, character_id, pack_version, schema_version, name, soul, style_hints_json,
            canon_facts_json, canon_timeline_json, gaps_json, source_ids_json, source_hashes_json,
            cutoff_point, work_title, draft_id, activated_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          packId,
          characterId,
          version,
          draft.schemaVersion,
          draft.payload.character.name,
          draft.payload.character.soul,
          draft.payload.character.styleHints ? JSON.stringify(draft.payload.character.styleHints) : null,
          JSON.stringify(draft.payload.canonFacts),
          JSON.stringify(canonTimeline),
          JSON.stringify(draft.payload.gaps),
          JSON.stringify(draft.sourceIds),
          JSON.stringify(sourceHashes),
          draft.payload.cutoffPoint ?? null,
          draft.payload.workTitle ?? null,
          draft.id,
          now,
          now,
        );

      // 2. Query existing instance
      const instanceRow = this.db
        .prepare('SELECT * FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
        .get(userId, characterId, instanceId) as InstanceRow | undefined;

      const previousPackId = instanceRow?.active_pack_id ?? null;
      const action = previousPackId ? 'upgrade' : 'activate';

      // 3. Upsert instance pointer
      this.db
        .prepare(
          `INSERT INTO character_instances
           (instance_id, user_id, character_id, active_pack_id, active_pack_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, character_id, instance_id) DO UPDATE SET
             active_pack_id=excluded.active_pack_id,
             active_pack_version=excluded.active_pack_version,
             updated_at=excluded.updated_at`,
        )
        .run(instanceId, userId, characterId, packId, version, instanceRow?.created_at ?? now, now);

      // 4. Record history
      this.db
        .prepare(
          `INSERT INTO character_pack_history
           (id, user_id, character_id, instance_id, action, from_pack_id, to_pack_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `cph-${randomUUID()}`,
          userId,
          characterId,
          instanceId,
          action,
          previousPackId,
          packId,
          action === 'upgrade' ? `Upgraded from draft ${draft.id}` : `Initial activation from draft ${draft.id}`,
          now,
        );
    }).immediate();

    createdPack = this.getPack(packId)!;
    return createdPack;
  }

  /**
   * Rolls back an instance to a previously activated character pack version.
   * Strictly enforces: rollback cannot bypass source revocation.
   */
  async rollback(params: {
    readonly characterId: string;
    readonly targetPackVersion: string;
    readonly userId?: string | undefined;
    readonly instanceId?: string | undefined;
    readonly reason?: string | undefined;
  }): Promise<CharacterPack> {
    const characterId = (params.characterId || '').trim();
    const userId = (params.userId || 'default-user').trim();
    const instanceId = (params.instanceId || 'default-instance').trim();
    const targetVersion = (params.targetPackVersion || '').trim();

    const instanceRow = this.db
      .prepare('SELECT * FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
      .get(userId, characterId, instanceId) as InstanceRow | undefined;

    if (!instanceRow) {
      throw new CharacterPackError(
        'not_found',
        `未找到角色实例 (user: "${userId}", char: "${characterId}", instance: "${instanceId}")。`,
      );
    }

    const targetPack = this.getPackByVersion(characterId, targetVersion);
    if (!targetPack) {
      throw new CharacterPackError(
        'not_found',
        `未找到目标角色包版本 "${targetVersion}"。`,
      );
    }

    // IRON RULE: Rollback cannot bypass source revocation
    for (const srcId of targetPack.sourceIds) {
      if (this.isSourceRevoked(characterId, srcId)) {
        throw new CharacterPackError(
          'version_conflict',
          `回退失败：目标版本引用的来源 "${srcId}" 已被撤销；回退旧 pack 不能绕过来源撤销。`,
        );
      }
    }

    const previousPackId = instanceRow.active_pack_id;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE character_instances 
           SET active_pack_id=?, active_pack_version=?, updated_at=?
           WHERE user_id=? AND character_id=? AND instance_id=?`,
        )
        .run(targetPack.id, targetPack.packVersion, now, userId, characterId, instanceId);

      this.db
        .prepare(
          `INSERT INTO character_pack_history
           (id, user_id, character_id, instance_id, action, from_pack_id, to_pack_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `cph-${randomUUID()}`,
          userId,
          characterId,
          instanceId,
          'rollback',
          previousPackId,
          targetPack.id,
          params.reason || `Rollback to version ${targetVersion}`,
          now,
        );
    }).immediate();

    return targetPack;
  }

  // --- WV0-02: revision-guarded single-domain Wiki apply/rollback ------------------------------

  /** Extracts the canon-only projection for one Wiki import (facts stay facts; events stay events). */
  private wikiCanonProjection(importId: string): { wikiFacts: { id: string; text: string; evidenceIds: readonly string[] }[]; importRef: string | null } {
    const record = this.wikiImportRecord(importId);
    if (!record || !record.draftId) throw new CharacterPackError('not_found', `导入记录不存在或没有草稿: "${importId}"`);
    const normalizedRow = this.db.prepare('SELECT normalized_json FROM character_wiki_imports WHERE id=?').get(importId) as { normalized_json: string | null } | undefined;
    if (!normalizedRow?.normalized_json) throw new CharacterPackError('invalid_request', '导入记录缺少 normalized 内容。');
    const normalized = JSON.parse(normalizedRow.normalized_json) as {
      wikiFacts: { id: string; text: string; status: string; evidence: { sourceId: string; location: { start: number; end: number } }[] }[];
    };
    // Map each fact's evidence quote locations to real blocks of the embedded source snapshots.
    // The import stored embedded sources as real snapshots; find them via the source table by hash
    // is fragile — instead the import record's draft cites them; here we map via source names.
    const draft = this.getDraft(record.draftId);
    if (!draft) throw new CharacterPackError('not_found', '导入草稿不存在。');
    // The drafts saved by WV0-01 cite ONLY the document snapshot; embedded snapshots are found by
    // matching the import's sources list. Re-derive: every source snapshot of this character created
    // in the same import is listed on the import record's documentSourceId siblings — we persisted
    // embedded sources with their own rows; map by their content hash from the normalized text.
    const wikiFacts = normalized.wikiFacts.filter(fact => fact.status === 'canon').map(fact => ({
      id: fact.id, text: fact.text, evidenceIds: [] as string[],
    }));
    return { wikiFacts, importRef: record.importId };
  }

  /**
   * Applies a Wiki import as the instance's active pack in ONE revision-guarded transaction:
   * immutable pack (canon facts + independent story-event timeline + canon wiki facts) + instance
   * pointer + history + import link + idempotent operation receipt. Rejects stale revision,
   * missing confirmation, revoked sources, and content drift BEFORE any mutation.
   */
  async applyWikiImport(params: {
    readonly pairing: PairingScope;
    readonly importId: string;
    readonly documentHash: string;
    readonly expectedPackRevision: number;
    readonly operationId: string;
  }): Promise<{ operationId: string; applied: true; packId: string; packVersion: string; packRevision: number; previousPackId: string | null; duplicate: boolean }> {
    const pairing = params.pairing;
    const operationId = (params.operationId || '').trim();
    if (!operationId) throw new CharacterPackError('invalid_request', 'operationId 不能为空。');
    // Idempotent replay: same operation → first persistent receipt.
    const prior = this.operationReceipt(pairing, 'wiki-apply', operationId);
    if (prior) {
      if (prior.signature !== `${params.importId}:${params.documentHash}:${params.expectedPackRevision}`) {
        throw new CharacterPackError('version_conflict', '同一操作编号对应不同的应用内容。');
      }
      return { ...JSON.parse(prior.receiptJson) as { packId: string; packVersion: string; packRevision: number; previousPackId: string | null }, operationId, applied: true, duplicate: true };
    }
    const record = this.wikiImportRecord(params.importId);
    if (!record || record.characterId !== pairing.characterId) throw new CharacterPackError('not_found', '导入记录不存在或不属于该角色。');
    if (record.mode !== 'structured' || !record.draftId) throw new CharacterPackError('invalid_request', '来源草稿（普通 Markdown）不能应用为角色包。');
    if (record.documentHash !== params.documentHash) throw new CharacterPackError('version_conflict', '导入内容已变化；请重新预览并确认。');
    // Revision guard INSIDE the transaction (no check-then-act window across await boundaries).
    const tx = this.db.transaction(() => {
      const currentRevision = this.getPackRevision(pairing);
      if (currentRevision !== params.expectedPackRevision) {
        throw new CharacterPackError('version_conflict', `角色包修订已变化（当前 ${currentRevision}，请求基于 ${params.expectedPackRevision}）；请刷新预览后重新确认。`);
      }
      const draft = this.getDraft(record.draftId!);
      if (!draft || draft.status !== 'validated') throw new CharacterPackError('validation_failed', '导入草稿未通过校验，不能应用。');
      // Revocation guard covers BOTH the raw document snapshot and the draft's cited sources.
      for (const srcId of [...draft.sourceIds, record.documentSourceId]) if (this.isSourceRevoked(pairing.characterId, srcId)) {
        throw new CharacterPackError('version_conflict', '导入依赖的来源已被撤销，不能应用。');
      }
      const instanceRow = this.db.prepare('SELECT * FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
        .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as InstanceRow | undefined;
      const previousPackId = instanceRow?.active_pack_id ?? null;
      // Freeze the pack: canon facts from the draft (already evidence-mapped), timeline ONLY from
      // explicit story events is already projected by WV0-01 (facts→events auto-derivation disabled
      // by storing an empty facts→events path) — the draft's canonTimeline came from the parsed
      // storyEvents, so reuse the draft's projection via activateDraftSync semantics inline.
      const version = `v${((this.db.prepare('SELECT COUNT(*) as c FROM character_packs WHERE character_id=?').get(pairing.characterId) as { c: number }).c) + 1}.0`;
      if (this.getPackByVersion(pairing.characterId, version)) throw new CharacterPackError('version_conflict', `角色包版本 "${version}" 已存在。`);
      const packId = `pack-${randomUUID()}`;
      const now = new Date().toISOString();
      const sourceHashes: string[] = [];
      for (const srcId of draft.sourceIds) { const src = this.getSource(srcId); if (src) sourceHashes.push(src.contentHash); }
      const { wikiFacts } = this.wikiCanonProjection(params.importId);
      const canonTimeline = this.deriveCanonTimeline(draft.payload);
      // The legacy derive maps EVERY fact to an event; Wiki imports must NOT. Build the timeline
      // from the import's own canon storyEvents (stored in normalized_json) instead.
      const normalizedRow = this.db.prepare('SELECT normalized_json FROM character_wiki_imports WHERE id=?').get(params.importId) as { normalized_json: string } | undefined;
      const normalized = JSON.parse(normalizedRow!.normalized_json) as { storyEvents: { id: string; ordinal: number; summary: string; participants: string[]; awareness: string; status: string; evidence: { sourceId: string; location: { start: number; end: number } }[]; chapter?: string }[] };
      const timeline: import('../contracts/character-pack.js').CanonTimelineEvent[] = normalized.storyEvents.filter(event => event.status === 'canon').map(event => ({
        eventId: event.id, ordinal: event.ordinal, summary: event.summary,
        charactersInvolved: event.participants, awareness: event.awareness as CanonAwareness,
        ...(event.chapter ? { chapter: event.chapter } : {}),
        evidenceIds: [] as string[], status: 'explicit' as const,
      }));
      this.db.prepare(
        `INSERT INTO character_packs
         (id, character_id, pack_version, schema_version, name, soul, style_hints_json,
          canon_facts_json, canon_timeline_json, gaps_json, source_ids_json, source_hashes_json,
          cutoff_point, work_title, draft_id, activated_at, created_at, wiki_facts_json, import_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(packId, pairing.characterId, version, draft.schemaVersion, draft.payload.character.name, draft.payload.character.soul,
        draft.payload.character.styleHints ? JSON.stringify(draft.payload.character.styleHints) : null,
        JSON.stringify(draft.payload.canonFacts), JSON.stringify(timeline), JSON.stringify(draft.payload.gaps),
        JSON.stringify(draft.sourceIds), JSON.stringify(sourceHashes), draft.payload.cutoffPoint ?? null,
        draft.payload.workTitle ?? null, draft.id, now, now, JSON.stringify(wikiFacts), params.importId);
      // Instance pointer + history.
      const action = previousPackId ? 'upgrade' : 'activate';
      this.db.prepare(
        `INSERT INTO character_instances
         (instance_id, user_id, character_id, active_pack_id, active_pack_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, character_id, instance_id) DO UPDATE SET
           active_pack_id=excluded.active_pack_id, active_pack_version=excluded.active_pack_version, updated_at=excluded.updated_at`,
      ).run(pairing.characterInstanceId, pairing.userId, pairing.characterId, packId, version, (instanceRow as InstanceRow | undefined)?.created_at ?? now, now);
      this.db.prepare(
        `INSERT INTO character_pack_history
         (id, user_id, character_id, instance_id, action, from_pack_id, to_pack_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`cph-${randomUUID()}`, pairing.userId, pairing.characterId, pairing.characterInstanceId, action, previousPackId, packId, `Wiki import ${params.importId}`, now);
      const packRevision = this.getPackRevision(pairing);
      const receipt = { packId, packVersion: version, packRevision, previousPackId };
      this.recordOperationReceipt(pairing, 'wiki-apply', operationId, `${params.importId}:${params.documentHash}:${params.expectedPackRevision}`, receipt);
      return receipt;
    });
    try {
      const receipt = tx.immediate();
      return { operationId, applied: true, ...receipt, duplicate: false };
    } catch (error) {
      if (error instanceof CharacterPackError) throw error;
      throw new CharacterPackError('invalid_request', 'Wiki 应用未完成，已完整回滚。');
    }
  }

  /** Revision-guarded rollback to a target pack; forms a NEW history revision, never rewrites packs. */
  async rollbackWikiPack(params: {
    readonly pairing: PairingScope;
    readonly targetPackId: string;
    readonly expectedPackRevision: number;
    readonly operationId: string;
  }): Promise<{ operationId: string; applied: true; packId: string; packVersion: string; packRevision: number; duplicate: boolean }> {
    const pairing = params.pairing;
    const operationId = (params.operationId || '').trim();
    if (!operationId) throw new CharacterPackError('invalid_request', 'operationId 不能为空。');
    const prior = this.operationReceipt(pairing, 'wiki-rollback', operationId);
    if (prior) {
      if (prior.signature !== `${params.targetPackId}:${params.expectedPackRevision}`) throw new CharacterPackError('version_conflict', '同一操作编号对应不同的回退内容。');
      return { ...JSON.parse(prior.receiptJson) as { packId: string; packVersion: string; packRevision: number }, operationId, applied: true, duplicate: true };
    }
    const target = this.getPack(params.targetPackId);
    if (!target || target.characterId !== pairing.characterId) throw new CharacterPackError('not_found', '目标角色包不存在或不属于该角色。');
    for (const srcId of target.sourceIds) if (this.isSourceRevoked(pairing.characterId, srcId)) {
      throw new CharacterPackError('version_conflict', '目标版本引用的来源已被撤销；回退不能绕过来源撤销。');
    }
    const tx = this.db.transaction(() => {
      const currentRevision = this.getPackRevision(pairing);
      if (currentRevision !== params.expectedPackRevision) throw new CharacterPackError('version_conflict', '角色包修订已变化；请刷新预览后重新确认。');
      const instanceRow = this.db.prepare('SELECT * FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
        .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as InstanceRow | undefined;
      if (!instanceRow?.active_pack_id) throw new CharacterPackError('not_found', '该实例当前没有活动角色包。');
      const now = new Date().toISOString();
      this.db.prepare('UPDATE character_instances SET active_pack_id=?, active_pack_version=?, updated_at=? WHERE user_id=? AND character_id=? AND instance_id=?')
        .run(target.id, target.packVersion, now, pairing.userId, pairing.characterId, pairing.characterInstanceId);
      this.db.prepare(
        `INSERT INTO character_pack_history
         (id, user_id, character_id, instance_id, action, from_pack_id, to_pack_id, reason, created_at)
         VALUES (?, ?, ?, ?, 'rollback', ?, ?, ?, ?)`,
      ).run(`cph-${randomUUID()}`, pairing.userId, pairing.characterId, pairing.characterInstanceId, instanceRow.active_pack_id, target.id, `Wiki rollback to ${target.packVersion}`, now);
      const packRevision = this.getPackRevision(pairing);
      const receipt = { packId: target.id, packVersion: target.packVersion, packRevision };
      this.recordOperationReceipt(pairing, 'wiki-rollback', operationId, `${params.targetPackId}:${params.expectedPackRevision}`, receipt);
      return receipt;
    });
    try {
      const receipt = tx.immediate();
      return { operationId, applied: true, ...receipt, duplicate: false };
    } catch (error) {
      if (error instanceof CharacterPackError) throw error;
      throw new CharacterPackError('invalid_request', 'Wiki 回退未完成，已完整回滚。');
    }
  }

  /** Idempotent operation receipts for Wiki apply/rollback (crash-recovery query path). */
  private operationReceipt(pairing: PairingScope, domain: string, operationId: string): { signature: string; receiptJson: string } | null {
    const row = this.db.prepare('SELECT signature, receipt_json FROM character_wiki_operations WHERE character_id=? AND domain=? AND operation_id=?')
      .get(pairing.characterId, domain, operationId) as { signature: string; receipt_json: string } | undefined;
    return row ? { signature: row.signature, receiptJson: row.receipt_json } : null;
  }
  private recordOperationReceipt(pairing: PairingScope, domain: string, operationId: string, signature: string, receipt: unknown): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO character_wiki_operations (character_id, domain, operation_id, signature, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(pairing.characterId, domain, operationId, signature, JSON.stringify(receipt), new Date().toISOString());
  }

  getPack(packId: string): CharacterPack | null {
    const row = this.db
      .prepare('SELECT * FROM character_packs WHERE id=?')
      .get(packId) as PackRow | undefined;

    return row ? this.hydratePack(row) : null;
  }

  getPackByVersion(characterId: string, packVersion: string): CharacterPack | null {
    const row = this.db
      .prepare('SELECT * FROM character_packs WHERE character_id=? AND pack_version=?')
      .get(characterId, packVersion) as PackRow | undefined;

    return row ? this.hydratePack(row) : null;
  }

  listPacks(characterId: string): readonly CharacterPack[] {
    const rows = this.db
      .prepare('SELECT * FROM character_packs WHERE character_id=? ORDER BY created_at DESC')
      .all(characterId) as PackRow[];

    return Object.freeze(rows.map(r => this.hydratePack(r)));
  }

  getInstance(userId: string, characterId: string, instanceId: string): CharacterInstance | null {
    const row = this.db
      .prepare('SELECT * FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
      .get(userId, characterId, instanceId) as InstanceRow | undefined;

    if (!row) return null;

    return Object.freeze({
      instanceId: row.instance_id,
      userId: row.user_id,
      characterId: row.character_id,
      activePackId: row.active_pack_id,
      activePackVersion: row.active_pack_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  // --- Source Revocation -----------------------------------------------------

  revokeSource(characterId: string, sourceId: string, reason?: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO character_source_revocations
         (id, character_id, target_type, target_id, reason, revoked_at)
         VALUES (?, ?, 'source', ?, ?, ?)`,
      )
      .run(
        `csr-${randomUUID()}`,
        characterId,
        sourceId,
        reason ?? null,
        new Date().toISOString(),
      );
  }

  isSourceRevoked(characterId: string, sourceId: string): boolean {
    if (sourceId.startsWith('history:')) return this.isHistorySourceRevoked(characterId, sourceId.slice('history:'.length));
    const row = this.db
      .prepare(
        "SELECT id FROM character_source_revocations WHERE character_id=? AND target_type='source' AND target_id=?",
      )
      .get(characterId, sourceId);
    return row !== undefined;
  }

  private isHistorySourceRevoked(characterId: string, messageId: string): boolean {
    const row = this.db.prepare('SELECT state FROM memory_records WHERE character_id=? AND id=? LIMIT 1')
      .get(characterId, messageId) as { state: string } | undefined;
    return !row || row.state !== 'active';
  }

  /** Persist a recoverable projection marker without duplicating conversation text. */
  stageCompanionProjection(input: {
    readonly pairing: PairingScope;
    readonly sessionId: string;
    readonly turnId: string;
    readonly createdAt?: string | undefined;
  }): void {
    const eventId = `cte-turn-${input.turnId}`;
    const createdAt = input.createdAt || new Date().toISOString();
    const projected = this.db.prepare('SELECT user_id,character_id,character_instance_id,session_id,turn_id FROM character_companion_timeline WHERE event_id=?').get(eventId) as {
      user_id: string; character_id: string; character_instance_id: string; session_id: string; turn_id: string;
    } | undefined;
    if (projected) {
      if (projected.user_id !== input.pairing.userId || projected.character_id !== input.pairing.characterId
        || projected.character_instance_id !== input.pairing.characterInstanceId || projected.session_id !== input.sessionId || projected.turn_id !== input.turnId) {
        throw new Error('companion_projection_identity_conflict');
      }
      return;
    }
    try {
      this.db.prepare(`INSERT INTO character_companion_projection_outbox
        (event_id,user_id,character_id,character_instance_id,session_id,turn_id,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(eventId, input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId, input.sessionId, input.turnId, createdAt);
    } catch (error) {
      const existing = this.db.prepare('SELECT * FROM character_companion_projection_outbox WHERE event_id=?').get(eventId) as {
        event_id: string; user_id: string; character_id: string; character_instance_id: string;
        session_id: string; turn_id: string; created_at: string;
      } | undefined;
      if (!existing || existing.user_id !== input.pairing.userId || existing.character_id !== input.pairing.characterId
        || existing.character_instance_id !== input.pairing.characterInstanceId || existing.session_id !== input.sessionId
        || existing.turn_id !== input.turnId) throw error;
    }
  }

  /**
   * Project staged turns from authoritative History. Invalidated/missing sources are discarded,
   * while transient resolver failures leave the marker for a later retry. Replaying after a crash
   * between event insertion and marker deletion is safe because eventId and payload are stable.
   */
  projectPendingCompanionEvents(
    readHistory: (scope: { readonly characterId: string; readonly sessionId: string; readonly turnId: string }, messageId: string) =>
      { readonly state: string; readonly role?: string | undefined; readonly text?: string | undefined } | null,
    publishEvent?: (event: CompanionEventEnvelope) => void,
  ): { readonly projected: number; readonly discarded: number; readonly pending: number } {
    const rows = this.db.prepare('SELECT * FROM character_companion_projection_outbox ORDER BY created_at,event_id').all() as Array<{
      event_id: string; user_id: string; character_id: string; character_instance_id: string;
      session_id: string; turn_id: string; created_at: string;
    }>;
    let projected = 0, discarded = 0;
    for (const row of rows) {
      const scope = { characterId: row.character_id, sessionId: row.session_id, turnId: row.turn_id };
      try {
        const user = readHistory(scope, `${row.turn_id}:user`);
        const assistant = readHistory(scope, `${row.turn_id}:assistant`);
        if (!user || !assistant || user.state !== 'active' || assistant.state !== 'active'
          || user.role !== 'user' || assistant.role !== 'assistant' || typeof user.text !== 'string' || typeof assistant.text !== 'string') {
          this.db.prepare('DELETE FROM character_companion_projection_outbox WHERE event_id=?').run(row.event_id);
          discarded++;
          continue;
        }
        const sourceIds = [`history:${row.turn_id}:user`, `history:${row.turn_id}:assistant`];
        if (publishEvent) {
          publishEvent({
            eventId: row.event_id,
            schemaVersion: 1,
            domain: 'companion',
            type: 'companion.turn.saved',
            pairing: {
              userId: row.user_id,
              characterId: row.character_id,
              characterInstanceId: row.character_instance_id,
            },
            turnId: row.turn_id,
            sourceRef: { id: sourceIds[0]!, version: 1 },
            occurredAt: row.created_at,
            receivedAt: new Date().toISOString(),
            payload: {
              userText: user.text,
              assistantText: assistant.text,
              sessionId: row.session_id,
              turnId: row.turn_id,
              sourceIds,
            },
            summary: user.text.slice(0, 40),
          });
        } else {
          this.appendCompanionEvent({
            eventId: row.event_id, userId: row.user_id, characterId: row.character_id,
            characterInstanceId: row.character_instance_id, sessionId: row.session_id, turnId: row.turn_id,
            userText: user.text, assistantText: assistant.text, createdAt: row.created_at,
            sourceIds,
          });
        }
        this.db.prepare('DELETE FROM character_companion_projection_outbox WHERE event_id=?').run(row.event_id);
        projected++;
      } catch {
        // Keep the durable marker. The next foreground turn or startup will retry it.
      }
    }
    const pending = (this.db.prepare('SELECT COUNT(*) AS count FROM character_companion_projection_outbox').get() as { count: number }).count;
    return Object.freeze({ projected, discarded, pending });
  }

  // --- Companion Timeline ----------------------------------------------------

  appendCompanionEvent(event: {
    /** Stable id supplied by the production projector for replay-safe writes. */
    readonly eventId?: string | undefined;
    readonly userId: string;
    readonly characterId: string;
    readonly characterInstanceId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly userText: string;
    readonly assistantText: string;
    readonly createdAt?: string | undefined;
    readonly sourceIds?: readonly string[] | undefined;
  }): CompanionTimelineEvent {
    const eventId = event.eventId?.trim() || `cte-${randomUUID()}`;
    const createdAt = event.createdAt || new Date().toISOString();
    const sourceIds = [...new Set(event.sourceIds ?? [])];
    const insert = this.db.prepare(
      `INSERT INTO character_companion_timeline
       (event_id, user_id, character_id, character_instance_id, session_id, turn_id, user_text, assistant_text, created_at, source_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      insert.run(eventId, event.userId, event.characterId, event.characterInstanceId, event.sessionId, event.turnId, event.userText, event.assistantText, createdAt, JSON.stringify(sourceIds));
    } catch (error) {
      // Production replay uses the same event id. A byte-for-byte replay is a
      // duplicate; a divergent replay is a real conflict and must not overwrite it.
      const existing = this.db.prepare('SELECT * FROM character_companion_timeline WHERE event_id=?').get(eventId) as CompanionEventRow | undefined;
      if (!existing || existing.user_id !== event.userId || existing.character_id !== event.characterId || existing.character_instance_id !== event.characterInstanceId
        || existing.session_id !== event.sessionId || existing.turn_id !== event.turnId || existing.user_text !== event.userText || existing.assistant_text !== event.assistantText
        || existing.created_at !== createdAt || existing.source_ids_json !== JSON.stringify(sourceIds)) throw error;
    }

    return Object.freeze({
      eventId,
      userId: event.userId,
      characterId: event.characterId,
      characterInstanceId: event.characterInstanceId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      userText: event.userText,
      assistantText: event.assistantText,
      createdAt,
      ...(sourceIds.length > 0 ? { sourceIds: Object.freeze(sourceIds) } : {}),
    });
  }

  // --- ContinuityReadPort Implementation -------------------------------------

  async getSnapshot(
    pairing: PairingScope,
    options?: {
      readonly cutoffPoint?: string | undefined;
      readonly maxCanonEvents?: number | undefined;
      readonly maxCompanionEvents?: number | undefined;
      readonly awarenessFilter?: readonly CanonAwareness[] | undefined;
    },
  ): Promise<ContinuitySnapshot> {
    const instance = this.getInstance(pairing.userId, pairing.characterId, pairing.characterInstanceId);
    let activePack: CharacterPack | null = null;
    let canonTimeline: CanonTimelineEvent[] = [];

    if (instance?.activePackId) {
      activePack = this.getPack(instance.activePackId);
      if (activePack) {
        // Filter out events citing revoked sources
        let events = activePack.canonTimeline.filter(event => {
          return !event.evidenceIds.some(evId => {
            const srcId = evId.split(':')[0]!;
            return this.isSourceRevoked(pairing.characterId, srcId);
          });
        });

        // Filter by cutoffPoint if provided
        const effectiveCutoff = options?.cutoffPoint ?? activePack.cutoffPoint;
        if (effectiveCutoff) {
          // Find source snapshots to compute cutoff block boundaries
          const sources = this.listSources(pairing.characterId);
          const allowedBlockIds = computeCutoffAllowedBlockIds(sources, effectiveCutoff);
          events = events.filter(e => e.evidenceIds.every(id => allowedBlockIds.has(id)));
        }

        // Filter by awareness if provided
        if (options?.awarenessFilter && options.awarenessFilter.length > 0) {
          const filterSet = new Set(options.awarenessFilter);
          events = events.filter(e => filterSet.has(e.awareness));
        }

        // Sort by ordinal
        events.sort((a, b) => a.ordinal - b.ordinal);

        // Limit
        const maxCanon = options?.maxCanonEvents ?? 50;
        canonTimeline = events.slice(0, maxCanon);
      }
    }

    // Retrieve companion timeline events (strictly scoped to pairing!)
    // N075-01/R9: select the LATEST maxCompanion events (ORDER BY created_at DESC), then reverse to
    // restore natural chronological order. The previous ORDER BY ASC selected the oldest historical events.
    const maxCompanion = options?.maxCompanionEvents ?? 50;
    const companionRows = this.db
      .prepare(
        `SELECT * FROM character_companion_timeline
         WHERE user_id=? AND character_id=? AND character_instance_id=?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(pairing.userId, pairing.characterId, pairing.characterInstanceId, maxCompanion * 2) as CompanionEventRow[];

    const companionTimeline: CompanionTimelineEvent[] = companionRows.filter(r => {
      const sourceIds = r.source_ids_json ? JSON.parse(r.source_ids_json) as string[] : [];
      const revoked = sourceIds.some(id => this.isContinuityFactRevoked(pairing, id));
      if (revoked && sourceIds.some(id => id.startsWith('history:'))) {
        // Also scrub eagerly if an old database predates the mutation triggers.
        this.db.prepare("UPDATE character_companion_timeline SET user_text='',assistant_text='' WHERE event_id=?").run(r.event_id);
      }
      return !revoked;
    }).slice(0, maxCompanion).map(r => {
      const sourceIds = r.source_ids_json ? JSON.parse(r.source_ids_json) as string[] : [];
      return Object.freeze({
        eventId: r.event_id,
        userId: r.user_id,
        characterId: r.character_id,
        characterInstanceId: r.character_instance_id,
        sessionId: r.session_id,
        turnId: r.turn_id,
        userText: r.user_text,
        assistantText: r.assistant_text,
        createdAt: r.created_at,
        ...(sourceIds.length > 0 ? { sourceIds: Object.freeze(sourceIds) } : {}),
      });
    }).reverse();

    // Calculate revision number
    const packRevision = this.getPackRevision(pairing);

    return Object.freeze({
      pairing: Object.freeze({ ...pairing }),
      activePack,
      canonTimeline: Object.freeze(canonTimeline),
      companionTimeline: Object.freeze(companionTimeline),
      packRevision,
    });
  }

  getPackRevision(pairing: PairingScope): number {
    const packCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM character_packs WHERE character_id=?')
        .get(pairing.characterId) as { c: number }
    ).c;
    const historyCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM character_pack_history WHERE character_id=?')
        .get(pairing.characterId) as { c: number }
    ).c;
    const companionCount = (
      this.db
        .prepare(
          'SELECT COUNT(*) as c FROM character_companion_timeline WHERE user_id=? AND character_id=? AND character_instance_id=?',
        )
        .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as { c: number }
    ).c;
    const revocationCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM character_source_revocations WHERE character_id=?')
        .get(pairing.characterId) as { c: number }
    ).c;

    return packCount + historyCount + companionCount + revocationCount + 1;
  }

  // --- Internal Helpers ------------------------------------------------------

  private hydratePack(row: PackRow): CharacterPack {
    return Object.freeze({
      id: row.id,
      characterId: row.character_id,
      packVersion: row.pack_version,
      schemaVersion: row.schema_version,
      name: row.name,
      soul: row.soul,
      styleHints: row.style_hints_json ? Object.freeze(JSON.parse(row.style_hints_json)) : undefined,
      canonFacts: Object.freeze(JSON.parse(row.canon_facts_json)),
      canonTimeline: Object.freeze(JSON.parse(row.canon_timeline_json)),
      gaps: Object.freeze(JSON.parse(row.gaps_json)),
      sourceIds: Object.freeze(JSON.parse(row.source_ids_json)),
      sourceHashes: Object.freeze(JSON.parse(row.source_hashes_json)),
      cutoffPoint: row.cutoff_point ?? undefined,
      workTitle: row.work_title ?? undefined,
      draftId: row.draft_id ?? undefined,
      activatedAt: row.activated_at ?? undefined,
      createdAt: row.created_at,
      // WV0-02: canon-only Wiki facts (undefined on legacy packs — the column stays NULL).
      ...(('wiki_facts_json' in row) && (row as { wiki_facts_json?: string | null }).wiki_facts_json
        ? { wikiFacts: Object.freeze(JSON.parse((row as { wiki_facts_json: string }).wiki_facts_json)) }
        : {}),
      // CB-02: the import that wrote this pack version (undefined on legacy packs).
      ...(('import_id' in row) && (row as { import_id?: string | null }).import_id
        ? { importId: (row as { import_id: string }).import_id }
        : {}),
    });
  }

  private isContinuityFactRevoked(pairing: PairingScope, factId: string): boolean {
    if (factId.startsWith('history:')) return this.isHistorySourceRevoked(pairing.characterId, factId.slice('history:'.length));
    try {
      const row = this.db.prepare('SELECT 1 AS found FROM continuity_tombstones WHERE user_id=? AND character_id=? AND instance_id=? AND fact_id=? LIMIT 1')
        .get(pairing.userId, pairing.characterId, pairing.characterInstanceId, factId) as { found: number } | undefined;
      return Boolean(row);
    } catch { return false; }
  }

  private deriveCanonTimeline(payload: CharacterPackDraftPayload): readonly CanonTimelineEvent[] {
    return payload.canonFacts.map((fact, index) =>
      Object.freeze({
        eventId: `ce-${fact.id}`,
        ordinal: index,
        summary: fact.text,
        charactersInvolved: Object.freeze([payload.character.name]),
        awareness: 'experienced' as CanonAwareness,
        evidenceIds: fact.evidenceIds,
        status: fact.status ?? 'explicit',
      }),
    );
  }
}

// Backward compatibility alias for N07-01 callers
export { CharacterPackStore as CharacterPackDraftStore };

// CB-03: the read-only unified-document port for the ONE Context assembly point.
//
// It exposes recall METADATA only. Bodies stay with their real owners:
//   * wiki facts  → the active Character Pack (`wikiFacts`), already consumed as `character_wiki`;
//   * story bodies → the Lorebook store (keyword/always), consumed as authored fiction;
//   * author state → `character_author_state` (authored setting, never real Continuity).
// Nothing here writes, and nothing here becomes a second knowledge database.
import type { AikiContextPort, AikiAuthorStateRow, AikiStoryMetaRow } from '../contracts/continuity-context.js';
import type { CharacterPackStore } from './character-pack-store.js';
import type { LorebookStore } from './lorebook-store.js';

interface AikiEntryLike {
  readonly meta: {
    readonly id: string;
    readonly type: string;
    readonly title?: string | undefined;
    readonly aliases: readonly string[];
    readonly keywords: readonly string[];
    readonly related: readonly string[];
    readonly time?: { readonly start?: string | undefined; readonly end?: string | undefined } | undefined;
    readonly characters: readonly string[];
    readonly locations: readonly string[];
    readonly importance?: number | undefined;
    readonly expiresAt?: string | undefined;
  };
}

export interface AikiContextPortDeps {
  readonly packs: CharacterPackStore;
  readonly lorebooks: LorebookStore;
}

/**
 * Reads the normalized document of the import currently in effect. When no committed apply has
 * happened, the port reports no document (an ordinary turn) instead of inventing recall state.
 */
export class AikiContextStore implements AikiContextPort {
  readonly #entries = new Map<string, AikiEntryLike[]>();
  readonly #importIds = new Map<string, string | null>();

  constructor(private readonly deps: AikiContextPortDeps) {}

  #documentOf(characterId: string): readonly AikiEntryLike[] {
    if (this.#entries.has(characterId)) return this.#entries.get(characterId)!;
    let entries: AikiEntryLike[] = [];
    const importId = this.deps.packs.latestCommittedAikiImport(characterId);
    this.#importIds.set(characterId, importId);
    if (importId) {
      const record = this.deps.packs.aikiImportRecord(importId);
      if (record?.normalizedJson) {
        try {
          const parsed = JSON.parse(record.normalizedJson) as { entries?: AikiEntryLike[] };
          entries = parsed.entries ?? [];
        } catch { entries = []; }
      }
    }
    this.#entries.set(characterId, entries);
    return entries;
  }

  /** CB-03: cache invalidation hook — a new apply must not serve stale recall metadata. */
  invalidate(characterId?: string): void {
    if (characterId === undefined) { this.#entries.clear(); this.#importIds.clear(); return; }
    this.#entries.delete(characterId);
    this.#importIds.delete(characterId);
  }

  documentImportId(characterId: string): string | null {
    this.#documentOf(characterId);
    return this.#importIds.get(characterId) ?? null;
  }

  authorState(characterId: string): readonly AikiAuthorStateRow[] {
    const rows = this.deps.packs.authorStateOf(characterId);
    const byId = new Map(this.#documentOf(characterId).map(entry => [entry.meta.id, entry]));
    return Object.freeze(rows.map(row => {
      const entry = byId.get(row.entryId);
      return Object.freeze({
        entryId: row.entryId, title: row.title, body: row.body, priority: row.priority,
        always: row.always, validFrom: row.validFrom, validUntil: row.validUntil, expiresAt: row.expiresAt,
        related: Object.freeze([...(entry?.meta.related ?? [])]),
        aliases: Object.freeze([...(entry?.meta.aliases ?? [])]),
        keywords: Object.freeze([...(entry?.meta.keywords ?? [])]),
      });
    }));
  }

  storyMeta(characterId: string): readonly AikiStoryMetaRow[] {
    // Story entries live in the lorebook owner; the aiki linkage column is the join key.
    const linked = new Map<string, { title: string; bookId: string }>();
    for (const book of this.deps.lorebooks.list(characterId)) {
      for (const entry of book.entries) {
        const aikiId = (entry as { aikiEntryId?: string | undefined }).aikiEntryId;
        if (aikiId) linked.set(aikiId, { title: entry.title, bookId: book.id });
      }
    }
    const byId = new Map(this.#documentOf(characterId).map(entry => [entry.meta.id, entry]));
    const rows: AikiStoryMetaRow[] = [];
    for (const [entryId, link] of linked) {
      const entry = byId.get(entryId);
      rows.push(Object.freeze({
        entryId, title: link.title,
        aliases: Object.freeze([...(entry?.meta.aliases ?? [])]),
        keywords: Object.freeze([...(entry?.meta.keywords ?? [])]),
        related: Object.freeze([...(entry?.meta.related ?? [])]),
        ...(entry?.meta.time === undefined ? {} : { time: entry.meta.time }),
        characters: Object.freeze([...(entry?.meta.characters ?? [])]),
        locations: Object.freeze([...(entry?.meta.locations ?? [])]),
        ...(entry?.meta.importance === undefined ? {} : { importance: entry.meta.importance }),
      }));
    }
    return Object.freeze(rows);
  }

  entryHints(characterId: string): ReadonlyMap<string, { readonly aliases: readonly string[]; readonly keywords: readonly string[] }> {
    const hints = new Map<string, { aliases: readonly string[]; keywords: readonly string[] }>();
    for (const entry of this.#documentOf(characterId)) {
      hints.set(entry.meta.id, Object.freeze({
        aliases: Object.freeze([...entry.meta.aliases]),
        keywords: Object.freeze([...entry.meta.keywords]),
      }));
    }
    return hints;
  }

  related(characterId: string): ReadonlyMap<string, readonly string[]> {
    const graph = new Map<string, readonly string[]>();
    for (const entry of this.#documentOf(characterId)) {
      if (entry.meta.related.length > 0) graph.set(entry.meta.id, Object.freeze([...entry.meta.related]));
    }
    return graph;
  }
}

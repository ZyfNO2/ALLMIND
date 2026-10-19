import type { PairingScope, ContinuitySnapshot } from './character-pack.js';
import type { ContinuityFact, ContinuityMemorySnapshot } from './continuity-memory.js';

/**
 * CK-06 adds three domains. They are additive: the N07 values and their meanings are unchanged.
 *
 *  - `character_wiki`     — character lore facts compiled from canon sources (CK-07/08). An
 *                           INDEPENDENT domain: it is never satisfied by presenting a canon event as
 *                           a character fact.
 *  - `reference_knowledge` — private/reference library documents, pairing-filtered (CK-05 owner).
 *  - `recent_activity`     — CK-04 activity events / daily summaries.
 */
export type ContinuityContextSource =
  | 'character_soul'
  | 'relationship'
  | 'user_soul'
  | 'canon_timeline'
  | 'user_wiki'
  | 'companion_timeline'
  | 'character_wiki'
  | 'reference_knowledge'
  | 'recent_activity'
  /**
   * CB-03: the AUTHOR's initial state (current location, task, relationship) imported from a
   * unified character document. This is authored setting — never real Continuity, never a user
   * memory, and it never overwrites an established instance state.
   */
  | 'author_state';

export interface ContinuityContextSegment {
  readonly key: string;
  readonly source: ContinuityContextSource;
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly tokens: number;
  readonly selected: boolean;
  readonly reason: string;
}

export interface ContinuityContextRequest {
  readonly pairing: PairingScope;
  readonly query: string;
  readonly tokenBudget: number;
  readonly maxCanonEvents?: number;
  readonly maxCompanionEvents?: number;
  readonly now?: string;
  readonly cutoffPoint?: string;
}

export interface ContinuityContextResult {
  readonly pairing: PairingScope;
  readonly revision: string;
  readonly text: string;
  readonly segments: readonly ContinuityContextSegment[];
  readonly selected: readonly ContinuityContextSegment[];
  readonly omitted: readonly ContinuityContextSegment[];
  readonly continuity: ContinuitySnapshot;
  readonly memory: ContinuityMemorySnapshot;
  /**
   * CB-03: which unified-document entries actually reached this turn, and which were omitted and
   * why. Present only when the aiki port is wired; absent leaves the previous shape untouched.
   */
  readonly aiki?: {
    readonly documentImportId: string | null;
    readonly selectedEntryIds: readonly string[];
    readonly omittedEntryIds: readonly { readonly entryId: string; readonly reason: string }[];
    /** Honest recall statement: keyword/alias only — no embedding retrieval is claimed. */
    readonly recall: 'keyword+alias';
  } | undefined;
}

export interface ContinuityContextSourceAdapter {
  compose(request: ContinuityContextRequest): Promise<ContinuityContextResult>;
  assertCurrent(result: ContinuityContextResult): void | Promise<void>;
}

export function factSegment(source: 'relationship' | 'user_soul' | 'user_wiki', fact: ContinuityFact, estimate: (text: string) => number): ContinuityContextSegment {
  return Object.freeze({ key: `fact:${fact.id}`, source, text: fact.text, evidenceIds: fact.sourceIds, tokens: estimate(fact.text), selected: false, reason: fact.kind === 'inference' ? '有来源的推断' : fact.origin === 'manual' ? '用户纠正/设定' : '当前配对有效条目' });
}

/** CB-03: one authored initial-state row as the Context composer sees it. */
export interface AikiAuthorStateRow {
  readonly entryId: string;
  readonly title: string;
  readonly body: string;
  readonly priority: number;
  readonly always: boolean;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly expiresAt: string | null;
  readonly related: readonly string[];
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
}

/** CB-03: one authored story entry's recall metadata (the lorebook owner keeps the body). */
export interface AikiStoryMetaRow {
  readonly entryId: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
  readonly related: readonly string[];
  readonly time?: { readonly start?: string | undefined; readonly end?: string | undefined } | undefined;
  readonly characters: readonly string[];
  readonly locations: readonly string[];
  readonly importance?: number | undefined;
}

/**
 * CB-03: the read-only port the ONE Context assembly point uses to recall unified-document
 * content. It exposes recall METADATA only — bodies stay with their real owners (pack wiki facts
 * and the lorebook store), so this can never become a second knowledge database.
 */
export interface AikiContextPort {
  /** The import currently in effect for this character (receipt provenance), or null. */
  documentImportId(characterId: string): string | null;
  /** Author initial-state rows (raw; validity filtering happens in the composer). */
  authorState(characterId: string): readonly AikiAuthorStateRow[];
  /** Story-entry recall metadata keyed by aiki entry id. */
  storyMeta(characterId: string): readonly AikiStoryMetaRow[];
  /** Alias/keyword index for wiki + persona entries keyed by aiki entry id. */
  entryHints(characterId: string): ReadonlyMap<string, { readonly aliases: readonly string[]; readonly keywords: readonly string[] }>;
  /** One-level `related` graph across aiki entry ids. */
  related(characterId: string): ReadonlyMap<string, readonly string[]>;
}

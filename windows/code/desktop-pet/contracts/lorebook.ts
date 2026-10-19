// RWR-06 / CONTRACTS §5: authored Lorebook — a character's world, relationships and backstory, kept
// as AUTHORED FICTION and injected into the ONE bounded Context assembly point.
//
// Boundaries frozen by D5 and CONTRACTS §5:
//   * a Lorebook is per-character; a shared book is NOT a default and has no representation here;
//   * an entry's text is the author's setting. It is never written into real user memory/Continuity
//     and never counts as evidence about the user;
//   * the only trigger strategies are `keyword` (literal match on the current user input after
//     Unicode NFKC + lowercase) and `always` (enabled entries always present);
//   * per-turn lorebook injection is capped by BOTH the registered per-turn token ceiling AND the real
//     remaining Context budget, and whole entries are selected (never a truncated entry).
import type { CharacterId } from './character.js';

export type LorebookEntryStrategy = 'keyword' | 'always';

export interface LorebookEntry {
  readonly id: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly strategy: LorebookEntryStrategy;
  readonly keywords: readonly string[];
  readonly content: string;
  readonly revision: number;
  readonly order: number;
  /** CB-02: set only on entries written by a unified character-document import. */
  readonly aikiEntryId?: string | undefined;
  /** CB-02: the import that last wrote this entry. */
  readonly aikiImportId?: string | undefined;
}

export interface Lorebook {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly ownerCharacterId: CharacterId;
  readonly title: string;
  readonly revision: number;
  readonly entries: readonly LorebookEntry[];
}

/** A reference to an entry that actually reached the Context, for the turn trace. */
export interface LorebookRef {
  readonly bookId: string;
  readonly entryId: string;
  readonly entryRevision: number;
}

/** Why a matched/considered entry was NOT injected, recorded for explainability. */
export type LorebookOmissionReason = 'budget_exhausted' | 'over_per_turn_ceiling' | 'keyword_miss' | 'disabled';

export interface LorebookOmission {
  readonly bookId: string;
  readonly entryId: string;
  readonly reason: LorebookOmissionReason;
}

/** The lorebook contribution to ONE turn's Context. Frozen so a later save cannot mutate it. */
export interface LorebookSelection {
  /** Marked as authored fiction; the LLM is told it is setting, not user fact or instruction. */
  readonly authoredFiction: true;
  readonly text: string;
  readonly refs: readonly LorebookRef[];
  readonly omissions: readonly LorebookOmission[];
  readonly tokens: number;
}

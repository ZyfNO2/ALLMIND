import type { CharacterId, TurnScope } from '../contracts/index.js';
import { COMPANION_ID, isCharacterId } from '../contracts/character.js';

export class MemoryRuleError extends Error {}

/**
 * RWR-02: admission is a PERSISTED fact, not a hardcoded product constant.
 *
 * The store installs its registry-backed admission here when it opens. The fallback below is the
 * pre-RWR-02 product constant — exactly one fixed id — and it exists only for code that builds a ledger
 * or a scope WITHOUT a store (unit tests, isolated helpers). It is deliberately a fixed id and never a
 * regex: no path may admit an arbitrary syntactically valid id just because no registry is present.
 */
type Admission = (value: CharacterId) => boolean;
const SEED_ADMISSION: Admission = value => value === COMPANION_ID;
let admission: Admission = SEED_ADMISSION;

/** Installed by `SqliteMemoryStore` when the persisted registry becomes available. */
export function installAdmission(check: Admission | null): void { admission = check ?? SEED_ADMISSION; }

/** True when the persisted registry is the authority for this process. */
export function hasPersistedAdmission(): boolean { return admission !== SEED_ADMISSION; }

/**
 * A character id is admitted only when the persisted registry knows it. `isProductCharacter` used to
 * stand here; keeping that predicate would let any regex-valid id reach storage, which is exactly the
 * gap G2/RWR-02 exists to close.
 */
export function assertCharacter(value: CharacterId): void {
  if (!isCharacterId(value)) throw new MemoryRuleError('unknown_character');
  if (!admission(value)) throw new MemoryRuleError('unknown_character');
}

export function bindScope(scope: TurnScope, characterId: CharacterId): TurnScope {
  assertCharacter(characterId);
  if (scope.characterId !== characterId) throw new MemoryRuleError('character_mismatch');
  if (!scope.sessionId || !scope.turnId || !Number.isSafeInteger(scope.generation) || scope.generation < 0) {
    throw new MemoryRuleError('invalid_scope');
  }
  return Object.freeze({ characterId, sessionId: scope.sessionId, turnId: scope.turnId, generation: scope.generation });
}

export function sameScope(a: TurnScope, b: TurnScope): boolean {
  return a.characterId === b.characterId && a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
}

export function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new MemoryRuleError('invalid_timestamp');
  return parsed;
}

/** Identity carried by records and work tickets. Product admission is narrower than storage identity. */
export type CharacterId = string;
export const COMPANION_ID = 'companion' as const;
export const COMPANION_LABEL = '青梅竹马' as const;
/**
 * RWR-02: the shipped single-role product identity.
 *
 * This is now only the *seed* for a fresh registry and the default deep-link target. Admission is no
 * longer decided here: CONTRACTS §1 requires existence to come from the persisted registry, so that a
 * syntactically valid id is not mistaken for a registered character.
 */
export const PRODUCT_CHARACTERS = Object.freeze([{ id: COMPANION_ID, label: COMPANION_LABEL }]);
/** Validate opaque identity syntax without substituting the currently active product identity. */
export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}
/**
 * The seed role id of the shipped product. Callers must NOT use this as an admission test — use the
 * persisted registry (`CharacterRegistry.exists`) so an unknown id cannot reach storage.
 */
export function isProductCharacter(value: unknown): value is typeof COMPANION_ID { return value === COMPANION_ID; }

/** Fictional opening is presentation-only: never a real conversation or memory source. */
export interface CompanionIntroduction { readonly id: string; readonly text: string }
export interface CompanionProfilePort {
  introduction(): CompanionIntroduction | null;
  acknowledgeIntroduction(id: string): void;
}

/**
 * RWR-02 / CONTRACTS §1: the target descriptor for one registered character.
 *
 * `revision` advances on every accepted edit; `createdAt`/`updatedAt` are informational only and are
 * never used for ordering decisions (revision is the ordering authority).
 */
export interface CharacterDescriptor {
  readonly schemaVersion: 2;
  readonly id: CharacterId;
  readonly label: string;
  readonly intro: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * RWR-02 / CONTRACTS §1: which role the process has saved for the NEXT start versus which role the
 * CURRENT turn actually runs.
 *
 * Browsing a character never moves `effectiveCharacterId`; only a restart establishes a new pairing.
 */
export interface RuntimeRoleState {
  readonly savedCharacterId: CharacterId;
  readonly effectiveCharacterId: CharacterId;
  readonly selectionRevision: number;
  readonly effectiveSelectionRevision: number;
  readonly applyOn: 'restart';
}

/** The `GET /api/characters` envelope. Never carries user-authored bodies. */
export interface CharacterRegistryView {
  readonly apiVersion: 2;
  readonly revision: number;
  readonly characters: readonly CharacterDescriptor[];
  readonly selection: RuntimeRoleState;
}

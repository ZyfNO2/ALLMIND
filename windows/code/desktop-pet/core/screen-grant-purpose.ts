/**
 * core/screen-grant-purpose.ts
 *
 * CK-10: purpose/destination separation and the permission to become live again.
 *
 * The dangerous failure this prevents is a **silent purpose upgrade**: a user who once allowed a
 * single local screenshot, or a local continuous observation, must never find that the same
 * consent now covers sending frames to a cloud VLM, keeping raw images long-term, or routing
 * recognised text to a cloud model.
 *
 * So the rules are stated positively rather than by exclusion:
 *  - each purpose has exactly ONE permitted destination;
 *  - a v1 local grant maps to a v2 purpose and **nothing else** — upgrading requires a fresh
 *    consent at a higher revision, issued by an explicit user confirmation;
 *  - a model binding is part of the grant. Changing the model invalidates it, so "the same
 *    destination" is not enough to keep an old grant alive.
 */

/** What the grant authorises, in the v2 scheme. */
export type ScreenGrantPurposeV2 =
  | 'capture-single'
  | 'capture-continuous-local'
  | 'capture-continuous-cloud-image'
  | 'context-use-cloud-text'
  | 'long-term-retention';

/**
 * The single permitted destination per purpose. A mismatch is a refusal, not a coercion: we never
 * silently downgrade a cloud request to local, because that would produce an empty result while
 * reporting success, nor silently upgrade a local request to cloud.
 */
export const PURPOSE_DESTINATION: Readonly<Record<ScreenGrantPurposeV2, 'local' | 'cloud'>> = Object.freeze({
  'capture-single': 'local',
  'capture-continuous-local': 'local',
  'capture-continuous-cloud-image': 'cloud',
  'context-use-cloud-text': 'cloud',
  'long-term-retention': 'local',
});

/** Purposes that keep raw content beyond the turn. Retention is never implied by a capture grant. */
export const RETENTION_PURPOSES: ReadonlySet<ScreenGrantPurposeV2> = Object.freeze(
  new Set<ScreenGrantPurposeV2>(['long-term-retention']),
) as ReadonlySet<ScreenGrantPurposeV2>;

/** Purposes whose content leaves the machine. */
export const CLOUD_PURPOSES: ReadonlySet<ScreenGrantPurposeV2> = Object.freeze(
  new Set<ScreenGrantPurposeV2>(['capture-continuous-cloud-image', 'context-use-cloud-text']),
) as ReadonlySet<ScreenGrantPurposeV2>;

export function isKnownPurpose(value: string): value is ScreenGrantPurposeV2 {
  return Object.prototype.hasOwnProperty.call(PURPOSE_DESTINATION, value);
}

/**
 * Map a v1 purpose onto the v2 scheme.
 *
 * The mapping is deliberately narrow: v1 knew `capture-single`, `capture-continuous` (local only)
 * and `context-use`. A v1 `context-use` grant carried an explicit destination, so it maps to the
 * cloud-text purpose **only** when that destination really was cloud — otherwise it maps to
 * `capture-single`, the weakest thing it could authorise.
 */
export function upgradePurposeV1(input: { readonly purpose: string; readonly destination: string }): ScreenGrantPurposeV2 | null {
  if (input.purpose === 'capture-single') return 'capture-single';
  if (input.purpose === 'capture-continuous') return 'capture-continuous-local';
  if (input.purpose === 'context-use') return input.destination === 'cloud' ? 'context-use-cloud-text' : 'capture-single';
  return null;
}

export interface PurposeCheckInput {
  readonly purpose: string;
  readonly destination: string;
  /** A v1 grant is only ever carried forward, never widened. */
  readonly carriedFromV1?: boolean;
  readonly userConfirmed: boolean;
  /** Required for any cloud purpose; the binding is part of what was consented to. */
  readonly modelBinding?: string | undefined;
}

export type PurposeRefusal =
  | 'unknown_purpose'
  | 'purpose_destination_mismatch'
  | 'explicit_confirmation_required'
  | 'model_binding_required'
  | 'v1_grant_cannot_be_widened';

export interface PurposeVerdict {
  readonly allowed: boolean;
  readonly purpose: ScreenGrantPurposeV2 | null;
  readonly destination: 'local' | 'cloud' | null;
  readonly refusal: PurposeRefusal | null;
}

export function checkPurpose(input: PurposeCheckInput): PurposeVerdict {
  if (!isKnownPurpose(input.purpose)) {
    return { allowed: false, purpose: null, destination: null, refusal: 'unknown_purpose' };
  }
  const purpose = input.purpose;
  const required = PURPOSE_DESTINATION[purpose];

  if (input.destination !== required) {
    return { allowed: false, purpose, destination: null, refusal: 'purpose_destination_mismatch' };
  }
  if (CLOUD_PURPOSES.has(purpose) && !input.modelBinding?.trim()) {
    return { allowed: false, purpose, destination: null, refusal: 'model_binding_required' };
  }
  // Carrying a v1 grant forward can only ever preserve its original, weaker meaning.
  if (input.carriedFromV1 === true) {
    const v1Equivalent = upgradePurposeV1({ purpose: 'capture-continuous', destination: 'local' });
    if (purpose !== 'capture-single' && purpose !== v1Equivalent) {
      return { allowed: false, purpose, destination: null, refusal: 'v1_grant_cannot_be_widened' };
    }
  }
  if (input.userConfirmed !== true) {
    return { allowed: false, purpose, destination: null, refusal: 'explicit_confirmation_required' };
  }
  return { allowed: true, purpose, destination: required, refusal: null };
}

/**
 * Readiness: can this persisted grant actually be used right now?
 *
 * Returning `false` with a reason is the point — "the capability is absent" must be visible
 * separately from "the user has not consented" and from "a grant exists but needs re-validation".
 */
export interface GrantReadiness {
  readonly ready: boolean;
  readonly reason:
    | 'ready'
    | 'no_grant'
    | 'grant_not_active'
    | 'needs_revalidation'
    | 'expired'
    | 'capability_missing'
    | 'model_binding_changed'
    | null;
  readonly detail: string | null;
}

export function grantReadiness(input: {
  readonly grant:
    | { readonly status: string; readonly needsValidation: boolean; readonly expiresAt: string; readonly modelBinding?: string | undefined }
    | null;
  readonly capabilityAvailable: boolean;
  readonly nowIso: string;
  readonly currentModelBinding?: string | undefined;
}): GrantReadiness {
  const grant = input.grant;
  if (!grant) return { ready: false, reason: 'no_grant', detail: '尚未就屏幕观察授权。' };
  if (!input.capabilityAvailable) {
    return { ready: false, reason: 'capability_missing', detail: '当前运行实例没有真实的屏幕捕获能力。' };
  }
  if (Date.parse(grant.expiresAt) <= Date.parse(input.nowIso)) {
    return { ready: false, reason: 'expired', detail: '屏幕观察授权已到期。' };
  }
  if (grant.needsValidation) {
    return { ready: false, reason: 'needs_revalidation', detail: '重启或目标变化后需要重新确认并签发新授权修订。' };
  }
  if (grant.status !== 'active') {
    return { ready: false, reason: 'grant_not_active', detail: '屏幕观察授权当前不是生效状态。' };
  }
  // A changed model is a changed consent: the same destination label is not enough.
  if (input.currentModelBinding && grant.modelBinding && input.currentModelBinding !== grant.modelBinding) {
    return { ready: false, reason: 'model_binding_changed', detail: '模型绑定已变化，需要重新确认。' };
  }
  return { ready: true, reason: 'ready', detail: null };
}

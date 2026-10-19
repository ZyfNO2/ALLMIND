import type { LegacyContinuousPerceptionGrant } from '../contracts/perception.js';
import {
  validateContinuousPerceptionGrant,
  type RuntimeContinuousPerceptionGrant,
} from '../contracts/companion-mode.js';

export interface RuntimeScreenTargetBinding {
  readonly targetId: string;
  readonly targetRevision: number;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly runtimeSessionId: string;
}

/**
 * Convert the frozen, target-less legacy grant only when the caller supplies a complete trusted target
 * binding. Missing fields are errors; they never imply whole-screen authorization.
 */
export function toRuntimeContinuousGrant(
  legacy: LegacyContinuousPerceptionGrant,
  target: RuntimeScreenTargetBinding,
): RuntimeContinuousPerceptionGrant {
  if (!legacy || typeof legacy !== 'object') throw new Error('legacy_grant_required');
  if (!target || typeof target.targetId !== 'string' || !target.targetId.trim()) throw new Error('target_id_required');
  if (!Number.isSafeInteger(target.targetRevision) || target.targetRevision < 1) throw new Error('target_revision_required');
  if (!target.bounds || ![target.bounds.x, target.bounds.y, target.bounds.width, target.bounds.height].every(Number.isFinite)
    || target.bounds.width <= 0 || target.bounds.height <= 0) throw new Error('target_bounds_required');
  if (typeof target.runtimeSessionId !== 'string' || !target.runtimeSessionId.trim()) throw new Error('runtime_session_required');
  if (legacy.destination !== 'local') throw new Error('legacy_destination_forbidden');
  if (!Number.isSafeInteger(legacy.revision) || legacy.revision < 1) throw new Error('legacy_revision_invalid');
  if (!Number.isSafeInteger(legacy.minPollIntervalMs) || legacy.minPollIntervalMs < 1000) throw new Error('legacy_poll_interval_invalid');
  if (!Number.isFinite(Date.parse(legacy.expiresAt))) throw new Error('legacy_expiry_invalid');

  const grant: RuntimeContinuousPerceptionGrant = {
    schemaVersion: 1,
    grantId: legacy.continuousGrantId,
    revision: legacy.revision,
    pairing: legacy.pairing,
    targetId: target.targetId,
    targetRevision: target.targetRevision,
    bounds: { ...target.bounds },
    runtimeSessionId: target.runtimeSessionId,
    minPollIntervalMs: legacy.minPollIntervalMs,
    expiry: legacy.expiresAt,
    destination: 'local',
    state: legacy.status,
  };
  validateContinuousPerceptionGrant(grant);
  return grant;
}

/**
 * core/trigger-delivery.ts
 *
 * CK-12 (GAP-05): the public local delivery path, independent of any screen capability.
 *
 * CK-12 splits itself into two halves and says so explicitly: GAP-05 (public local delivery +
 * shared reservation) must not be blocked by the screen environment, GAP-06 adds the screen
 * single-shot and the internal observation admission. This module is GAP-05.
 *
 * The property that makes it worth its own module: **a local greeting can be delivered and
 * acknowledged with `capture:false` and `localOcr:false`**, reading no screen and calling no paid
 * model. The existing `CompanionTriggerRuntime.#decide` returns `unavailable: 'greeting_not_enabled'`
 * for every greeting, which meant CK-14's whole delivery surface was waiting on a screen path it
 * never needed.
 *
 * Accounting rules that shape it:
 *  - a **manual/local** delivery does not consume the automatic quota (13/14 share the ledger, and
 *    a user pressing a button must not spend the budget that automatic observation saved for);
 *  - a **cancelled or failed** attempt settles at zero only when nothing was actually produced;
 *    an unknown cost keeps its reservation, because releasing it would create new allowance out
 *    of an unaccounted charge;
 *  - `delivered` is set only by an exact scope/session/generation/triggerId acknowledgement. A
 *    stale or mismatched ack is rejected loudly, never folded into a normal success.
 */

import { createHash } from 'node:crypto';

export type LocalDeliveryKind = 'greeting' | 'manual';
export type LocalDeliveryStage = 'queued' | 'rendered' | 'delivered' | 'failed' | 'cancelled';

export interface LocalDeliveryRequest {
  readonly pairing: { readonly userId: string; readonly characterId: string; readonly characterInstanceId: string };
  readonly operationId: string;
  readonly kind: LocalDeliveryKind;
  /** The text to show. For a greeting this is the trusted rule text, not model output. */
  readonly text: string;
  readonly ruleId?: string | undefined;
  readonly localDate?: string | undefined;
  readonly timezone?: string | undefined;
  readonly expectedRevision?: number | undefined;
  readonly userConfirmed?: boolean | undefined;
}

export interface LocalDeliveryScope {
  readonly characterId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly triggerId: string;
}

export interface LocalDeliveryRecord {
  readonly triggerId: string;
  readonly kind: LocalDeliveryKind;
  readonly stage: LocalDeliveryStage;
  readonly reason: string | null;
  readonly text: string;
  readonly ruleId: string | null;
  readonly localDate: string | null;
  readonly timezone: string | null;
  readonly scope: LocalDeliveryScope;
  /** False for a failure/cancel; the shared ledger must not see a phantom delivery. */
  readonly countsAsAutomatic: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LocalDeliveryReceipt {
  readonly outcome: 'accepted' | 'duplicate' | 'conflict' | 'invalid';
  readonly triggerId: string | null;
  readonly stage: LocalDeliveryStage | null;
  readonly reason: string | null;
}

export type AckRejection =
  | 'unknown_trigger'
  | 'not_rendered'
  | 'already_delivered'
  | 'terminal_state'
  | 'scope_mismatch'
  | 'stale_generation';

export interface AckResult {
  readonly ok: boolean;
  readonly record: LocalDeliveryRecord | null;
  readonly rejection: AckRejection | null;
}

/** The shared automatic-delivery ledger. Supplied by the existing owner (13/14), never duplicated. */
export interface AutomaticDeliveryLedger {
  /** Record one automatic delivery. Manual/local deliveries must NOT call this. */
  countAutomatic(input: { readonly pairingKey: string; readonly localDate: string; readonly ruleId: string }): Promise<boolean>;
  /** Persist an operationId -> receipt so a replay is answered without re-running. */
  readOperation(input: { readonly pairingKey: string; readonly operationId: string }): { readonly signature: string; readonly triggerId: string } | null;
  writeOperation(input: { readonly pairingKey: string; readonly operationId: string; readonly signature: string; readonly triggerId: string }): void;
}

function signatureOf(request: LocalDeliveryRequest): string {
  return createHash('sha256').update(JSON.stringify({
    kind: request.kind, text: request.text, ruleId: request.ruleId ?? null,
    localDate: request.localDate ?? null, timezone: request.timezone ?? null,
  })).digest('hex');
}

function triggerIdFor(pairingKey: string, operationId: string): string {
  return `local-${createHash('sha256').update(`${pairingKey}|${operationId}`).digest('hex').slice(0, 24)}`;
}

export class LocalDeliveryCoordinator {
  private readonly records = new Map<string, LocalDeliveryRecord>();
  private readonly now: () => number;

  constructor(private readonly options: { readonly ledger: AutomaticDeliveryLedger; readonly now?: () => number }) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Accept one local delivery.
   *
   * No screen grant, no capture, no OCR, no model call. The only requirement is a non-empty text:
   * a delivery with nothing to show is a caller bug, not a successful empty bubble.
   */
  accept(request: LocalDeliveryRequest): LocalDeliveryReceipt {
    const pairingKey = `${request.pairing.userId}|${request.pairing.characterId}|${request.pairing.characterInstanceId}`;
    const text = typeof request.text === 'string' ? request.text.trim() : '';
    if (!text) return { outcome: 'invalid', triggerId: null, stage: null, reason: 'empty_delivery_text' };
    if (typeof request.operationId !== 'string' || !request.operationId.trim() || request.operationId.length > 200) {
      return { outcome: 'invalid', triggerId: null, stage: null, reason: 'invalid_operation_id' };
    }

    const signature = signatureOf(request);
    const prior = this.options.ledger.readOperation({ pairingKey, operationId: request.operationId });
    if (prior) {
      // Same id + same intent replays the first receipt; a different intent is a conflict.
      if (prior.signature !== signature) {
        return { outcome: 'conflict', triggerId: prior.triggerId, stage: null, reason: 'operation_id_payload_conflict' };
      }
      const existing = this.records.get(prior.triggerId) ?? null;
      return {
        outcome: 'duplicate',
        triggerId: prior.triggerId,
        stage: existing?.stage ?? 'queued',
        reason: existing?.reason ?? null,
      };
    }

    const triggerId = triggerIdFor(pairingKey, request.operationId);
    const created = this.now();
    const record: LocalDeliveryRecord = {
      triggerId,
      kind: request.kind,
      stage: 'queued',
      reason: null,
      text,
      ruleId: request.ruleId ?? null,
      localDate: request.localDate ?? null,
      timezone: request.timezone ?? null,
      scope: {
        characterId: request.pairing.characterId,
        sessionId: 'pending',
        generation: 0,
        triggerId,
      },
      // A user-pressed or rule-driven local line is not an automatic observation.
      countsAsAutomatic: false,
      createdAt: created,
      updatedAt: created,
    };
    this.records.set(triggerId, record);
    this.options.ledger.writeOperation({ pairingKey, operationId: request.operationId, signature, triggerId });
    return { outcome: 'accepted', triggerId, stage: 'queued', reason: null };
  }

  /** The renderer produced the text but has not yet confirmed it is on screen. */
  rendered(triggerId: string, scope: Omit<LocalDeliveryScope, 'triggerId'>): boolean {
    const record = this.records.get(triggerId);
    if (!record || record.stage !== 'queued') return false;
    this.records.set(triggerId, { ...record, stage: 'rendered', scope: { ...scope, triggerId }, updatedAt: this.now() });
    return true;
  }

  /**
   * Confirm the reply is actually visible.
   *
   * The scope must match exactly. A stale session or an old generation is rejected with a named
   * reason rather than being folded into a normal success, because "delivered" is the one state
   * that spends the shared quota and dismisses the cooldown.
   */
  acknowledge(triggerId: string, scope: LocalDeliveryScope): AckResult {
    const record = this.records.get(triggerId);
    if (!record) return { ok: false, record: null, rejection: 'unknown_trigger' };
    if (record.stage === 'delivered') return { ok: false, record, rejection: 'already_delivered' };
    if (record.stage === 'failed' || record.stage === 'cancelled') {
      return { ok: false, record, rejection: 'terminal_state' };
    }
    if (record.stage !== 'rendered') return { ok: false, record, rejection: 'not_rendered' };
    if (record.scope.sessionId !== scope.sessionId || record.scope.characterId !== scope.characterId) {
      return { ok: false, record, rejection: 'scope_mismatch' };
    }
    if (record.scope.generation !== scope.generation) {
      return { ok: false, record, rejection: 'stale_generation' };
    }
    const delivered: LocalDeliveryRecord = { ...record, stage: 'delivered', updatedAt: this.now() };
    this.records.set(triggerId, delivered);
    return { ok: true, record: delivered, rejection: null };
  }

  cancel(triggerId: string, reason = 'user_cancelled'): LocalDeliveryRecord | null {
    const record = this.records.get(triggerId);
    if (!record || record.stage === 'delivered' || record.stage === 'failed' || record.stage === 'cancelled') return record ?? null;
    const cancelled: LocalDeliveryRecord = { ...record, stage: 'cancelled', reason, updatedAt: this.now() };
    this.records.set(triggerId, cancelled);
    return cancelled;
  }

  fail(triggerId: string, reason: string): LocalDeliveryRecord | null {
    const record = this.records.get(triggerId);
    if (!record || record.stage === 'delivered' || record.stage === 'cancelled') return record ?? null;
    const failed: LocalDeliveryRecord = { ...record, stage: 'failed', reason, updatedAt: this.now() };
    this.records.set(triggerId, failed);
    return failed;
  }

  get(triggerId: string): LocalDeliveryRecord | null { return this.records.get(triggerId) ?? null; }

  /**
   * Reserve against the shared automatic quota, for 13/14's automatic paths only.
   *
   * A local/manual delivery deliberately does not go through here: spending the automatic budget
   * on something the user explicitly asked for would starve observation.
   */
  async reserveAutomatic(input: { readonly pairingKey: string; readonly localDate: string; readonly ruleId: string }): Promise<boolean> {
    return this.options.ledger.countAutomatic(input);
  }
}

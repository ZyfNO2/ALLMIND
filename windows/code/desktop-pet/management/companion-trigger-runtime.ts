import type { PairingScope } from '../contracts/character-pack.js';
import type { Observation } from '../contracts/perception.js';
import type { TurnInput, TurnScope } from '../contracts/index.js';
import { CompanionModeError, CompanionModeRuntime, type CompanionTriggerRecord, type CompanionTriggerState } from '../core/companion-mode-runtime.js';
import type { ScreenPerceptionService } from '../core/screen-perception.js';
import { ScreenGrantRuntime } from './screen-grant-runtime.js';

export interface CompanionTriggerSessionPort {
  identity(): { readonly characterId: string; readonly sessionId: string; readonly generation: number };
  readiness(): { readonly ready: boolean; readonly reason?: string };
  dispatch(triggerId: string, observationId: string): Promise<void>;
  cancel(triggerId: string): Promise<boolean>;
}
export interface CompanionTriggerRuntimeOptions {
  readonly pairing: PairingScope;
  readonly mode: CompanionModeRuntime;
  readonly screenGrants: ScreenGrantRuntime;
  readonly perception: ScreenPerceptionService;
  readonly session: CompanionTriggerSessionPort;
  /** True when observation text would be sent to a remotely hosted dialogue model. */
  readonly requiresContextUseGrant: boolean;
  readonly dialogueModelBinding: string;
  readonly onState?: (record: CompanionTriggerRecord) => void;
  readonly now?: () => number;
}
export interface CompanionTriggerReceipt {
  readonly outcome: 'accepted' | 'busy' | 'needs-authorization' | 'unavailable';
  readonly triggerId: string;
  readonly reason?: string;
  readonly status: CompanionTriggerState;
}

interface ActiveTrigger { readonly controller: AbortController; record: CompanionTriggerRecord }

/** Single-turn coordinator. Capture/OCR are admitted here; generation still enters DesktopRuntime's unique TurnController. */
export class CompanionTriggerRuntime {
  private readonly active = new Map<string, ActiveTrigger>();
  private readonly now: () => number;
  constructor(private readonly options: CompanionTriggerRuntimeOptions) {
    this.now = options.now ?? Date.now;
    options.mode.recoverInterruptedCompanionTriggers(options.session.identity().sessionId);
  }

  async trigger(input: { readonly pairing: PairingScope; readonly operationId: string; readonly kind: 'screen' | 'greeting' }): Promise<CompanionTriggerReceipt> {
    this.#assertPairing(input.pairing);
    if (!input.operationId.trim() || input.operationId.length > 200 || input.operationId.includes('\0')) {
      throw new CompanionModeError('invalid_request', 'Invalid trigger operation id.');
    }
    const identity = this.options.session.identity();
    if (identity.characterId !== this.options.pairing.characterId) throw new CompanionModeError('forbidden', 'Trigger role is not active.');
    const triggerId = triggerIdFor(input.operationId);
    const previous = this.options.mode.getCompanionTrigger(triggerId, input.pairing);
    if (previous) {
      if (previous.kind !== input.kind) throw new CompanionModeError('operation_conflict', 'Trigger operation ID conflicts with a different trigger kind.');
      const running = this.active.get(triggerId);
      if (running) return this.#receipt(running.record);
      if (!isTerminal(previous.status)) {
        const recovered = this.options.mode.transitionCompanionTrigger({ triggerId, pairing: input.pairing,
          runtimeSessionId: previous.runtimeSessionId, generation: previous.generation, status: 'failed', reason: 'operation_interrupted' });
        this.#publish(recovered);
        return this.#receipt(recovered);
      }
      return this.#receipt(previous);
    }

    const decision = this.#decide(input.kind, input.pairing);
    const record = this.options.mode.registerCompanionTrigger({ operationId: input.operationId, kind: input.kind,
      outcome: decision.outcome, ...(decision.reason ? { reason: decision.reason } : {}),
      runtimeSessionId: identity.sessionId, generation: identity.generation + 1 });
    if (record.outcome !== 'accepted' || record.status !== 'accepted') return this.#receipt(record);

    const active: ActiveTrigger = { controller: new AbortController(), record };
    this.active.set(record.triggerId, active);
    void this.#run(active, decision.grantId!).catch(() => {});
    return this.#receipt(record);
  }

  get(triggerId: string, pairing: PairingScope): CompanionTriggerRecord | null {
    this.#assertPairing(pairing);
    return this.options.mode.getCompanionTrigger(triggerId, pairing);
  }

  async cancel(triggerId: string, pairing: PairingScope): Promise<CompanionTriggerRecord> {
    this.#assertPairing(pairing);
    const record = this.options.mode.getCompanionTrigger(triggerId, pairing);
    if (!record) throw new CompanionModeError('not_found', 'Companion trigger not found.');
    if (record.runtimeSessionId !== this.options.session.identity().sessionId) {
      throw new CompanionModeError('forbidden', 'Trigger belongs to another runtime session.');
    }
    if (isTerminal(record.status)) {
      if (record.status === 'cancelled') return record;
      throw new CompanionModeError('version_conflict', 'Trigger is already terminal.');
    }
    const active = this.active.get(triggerId);
    active?.controller.abort();
    if (record.status === 'generating') await this.options.session.cancel(triggerId);
    const cancelled = this.options.mode.transitionCompanionTrigger({ triggerId, pairing, runtimeSessionId: record.runtimeSessionId,
      generation: record.generation, status: 'cancelled', reason: 'user_cancelled' });
    this.active.delete(triggerId);
    this.#publish(cancelled);
    return cancelled;
  }

  /** Called by the existing turn pipeline when a generated trigger turn terminates without display. */
  async turnFinished(input: TurnInput, status: 'cancelled' | 'failed', reason?: string): Promise<void> {
    const provenance = input.provenance;
    if (!provenance || provenance.kind !== 'companion-trigger') return;
    const active = this.active.get(provenance.triggerId);
    if (!active) return;
    const next = this.options.mode.transitionCompanionTrigger({ triggerId: provenance.triggerId, pairing: this.options.pairing,
      runtimeSessionId: active.record.runtimeSessionId, generation: active.record.generation,
      status, reason: safeReason(reason, status === 'cancelled' ? 'turn_cancelled' : 'generation_failed') });
    active.controller.abort(); this.active.delete(provenance.triggerId); active.record = next; this.#publish(next);
  }

  /**
   * CK-12 (GAP-06): admit an observation that was ALREADY captured.
   *
   * The periodic path (CK-13) captures and recognises a frame itself. Feeding that result back
   * through `trigger()` would capture and recognise a **second** time, doubling both the resource
   * cost and the chance of observing something different from what was evaluated. So this entry
   * accepts the completed material and goes straight to the generating stage.
   *
   * Deliberately NOT reachable from the browser: it is an internal method with no route, and it
   * refuses an observation whose identity or scope does not match this runtime. A caller cannot
   * submit a fabricated image or a forged observation id through any client surface.
   */
  async admitObservation(input: {
    readonly operationId: string;
    readonly observationId: string;
    readonly targetId: string;
    readonly targetRevision: number;
    readonly text: string;
    /** The lease the observation was produced under; re-checked so a revoked grant cannot slip in. */
    readonly sourceLease: { readonly grantId: string; readonly grantRevision: number };
    readonly scope: { readonly characterId: string; readonly sessionId: string; readonly generation: number };
  }): Promise<CompanionTriggerReceipt> {
    this.#assertPairing(this.options.pairing);
    if (!input.operationId.trim() || input.operationId.length > 200 || input.operationId.includes('\0')) {
      throw new CompanionModeError('invalid_request', 'Invalid admit operation id.');
    }
    // A caller outside the current session/generation must not inject an observation.
    const identity = this.options.session.identity();
    if (input.scope.characterId !== this.options.pairing.characterId
      || input.scope.sessionId !== identity.sessionId
      || input.scope.generation !== identity.generation) {
      throw new CompanionModeError('forbidden', 'Admitted observation does not belong to the active session.');
    }
    // The lease must still be live: a revoked or superseded grant invalidates the material.
    const readiness = this.options.screenGrants.triggerReadiness(this.options.pairing);
    if (!readiness.targetSelected || readiness.target?.targetId !== input.targetId
      || readiness.target.targetRevision !== input.targetRevision) {
      throw new CompanionModeError('forbidden', 'Admitted observation target is not the active target.');
    }
    if (!input.text.trim()) {
      // No recognised content is not an admission, it is a no-content result.
      const record = this.options.mode.registerCompanionTrigger({
        operationId: input.operationId, kind: 'screen', outcome: 'accepted',
        runtimeSessionId: identity.sessionId, generation: identity.generation + 1,
      });
      const noContent = this.options.mode.transitionCompanionTrigger({
        triggerId: record.triggerId, pairing: this.options.pairing,
        runtimeSessionId: record.runtimeSessionId, generation: record.generation,
        status: 'no-content', reason: 'no_text_detected', observationId: input.observationId,
      });
      this.#publish(noContent);
      return this.#receipt(noContent);
    }

    const previous = this.options.mode.getCompanionTrigger(triggerIdFor(input.operationId), this.options.pairing);
    if (previous) return this.#receipt(previous);

    const record = this.options.mode.registerCompanionTrigger({
      operationId: input.operationId, kind: 'screen', outcome: 'accepted',
      runtimeSessionId: identity.sessionId, generation: identity.generation + 1,
    });
    const active: ActiveTrigger = { controller: new AbortController(), record };
    this.active.set(record.triggerId, active);

    // Straight to generating: the capture and recognition already happened upstream.
    const recognized = this.options.mode.transitionCompanionTrigger({
      triggerId: record.triggerId, pairing: this.options.pairing,
      runtimeSessionId: record.runtimeSessionId, generation: record.generation,
      status: 'recognized', observationId: input.observationId,
    });
    active.record = recognized; this.#publish(recognized);

    if (this.options.requiresContextUseGrant && !this.#contextUseAllowed(input.targetId)) {
      const failed = this.options.mode.transitionCompanionTrigger({
        triggerId: recognized.triggerId, pairing: this.options.pairing,
        runtimeSessionId: recognized.runtimeSessionId, generation: recognized.generation,
        status: 'failed', reason: 'context_use_grant_required', observationId: input.observationId,
      });
      active.record = failed; this.active.delete(failed.triggerId); this.#publish(failed);
      return this.#receipt(failed);
    }

    const generating = this.options.mode.transitionCompanionTrigger({
      triggerId: recognized.triggerId, pairing: this.options.pairing,
      runtimeSessionId: recognized.runtimeSessionId, generation: recognized.generation,
      status: 'generating', observationId: input.observationId,
    });
    active.record = generating; this.#publish(generating);
    void this.options.session.dispatch(generating.triggerId, input.observationId).catch(() => {
      void this.turnFinished(
        { provenance: { kind: 'companion-trigger', triggerId: generating.triggerId } } as unknown as TurnInput,
        'failed', 'dispatch_failed',
      );
    });
    return this.#receipt(generating);
  }

  /** Called only after the renderer inserted the reply into the visible chat log. */
  async replyDisplayed(triggerId: string, scope: TurnScope): Promise<void> {
    const active = this.active.get(triggerId);
    if (!active || active.record.status !== 'generating' || active.record.generation !== scope.generation
      || active.record.runtimeSessionId !== scope.sessionId || scope.characterId !== this.options.pairing.characterId) {
      throw new CompanionModeError('forbidden', 'Reply acknowledgement does not belong to the active trigger turn.');
    }
    const delivered = this.options.mode.transitionCompanionTrigger({ triggerId, pairing: this.options.pairing,
      runtimeSessionId: active.record.runtimeSessionId, generation: active.record.generation,
      status: 'delivered', turnScope: scope });
    this.active.delete(triggerId); active.record = delivered; this.#publish(delivered);
  }

  async cancelAll(reason = 'grant_revoked'): Promise<void> {
    for (const [triggerId, active] of [...this.active]) {
      active.controller.abort();
      if (active.record.status === 'generating') await this.options.session.cancel(triggerId).catch(() => false);
      if (!isTerminal(active.record.status)) {
        const cancelled = this.options.mode.transitionCompanionTrigger({ triggerId, pairing: this.options.pairing,
          runtimeSessionId: active.record.runtimeSessionId, generation: active.record.generation, status: 'cancelled', reason });
        active.record = cancelled; this.#publish(cancelled);
      }
      this.active.delete(triggerId);
    }
  }

  #decide(kind: 'screen' | 'greeting', pairing: PairingScope): { outcome: CompanionTriggerReceipt['outcome']; reason?: string; grantId?: string } {
    if (kind === 'greeting') return { outcome: 'unavailable', reason: 'greeting_not_enabled' };
    const availability = this.options.session.readiness();
    if (!availability.ready) {
      const busyReasons = ['turn_busy', 'work_confirmation_pending', 'user_active'];
      return busyReasons.includes(availability.reason ?? '')
        ? { outcome: 'busy', ...(availability.reason ? { reason: availability.reason } : {}) }
        : { outcome: 'unavailable', reason: safeReason(availability.reason, 'desktop_presence_unavailable') };
    }
    const readiness = this.options.screenGrants.triggerReadiness(pairing);
    if (!readiness.targetSelected || !readiness.grantId || !readiness.target) {
      return { outcome: 'needs-authorization', reason: 'single_capture_grant_required' };
    }
    if (!readiness.capture) return { outcome: 'unavailable', reason: 'real_screen_capture_unavailable' };
    if (readiness.destination === 'local' && !readiness.localOcr) return { outcome: 'unavailable', reason: 'pixel_ocr_unavailable' };
    if (readiness.destination === 'cloud' && !readiness.cloudVlm) return { outcome: 'unavailable', reason: 'cloud_vlm_unavailable' };
    if (this.options.requiresContextUseGrant && !this.#contextUseAllowed(readiness.target.targetId)) {
      return { outcome: 'needs-authorization', reason: 'context_use_grant_required' };
    }
    return { outcome: 'accepted', grantId: readiness.grantId };
  }

  async #run(active: ActiveTrigger, grantId: string): Promise<void> {
    let bytes: Uint8Array | undefined;
    try {
      const capture = await this.options.screenGrants.captureSingleFrame(grantId, active.controller.signal);
      bytes = capture.frame.bytes;
      if (capture.frame.mimeType !== 'image/png') throw new CompanionModeError('unavailable', 'single_capture_frame_type_unavailable');
      active.record = this.options.mode.transitionCompanionTrigger({ triggerId: active.record.triggerId, pairing: this.options.pairing,
        runtimeSessionId: active.record.runtimeSessionId, generation: active.record.generation, status: 'captured' });
      this.#publish(active.record);
      const observation = await this.options.perception.processCapture({ grantId, targetId: capture.frame.targetId,
        targetRevision: capture.frame.targetRevision, imageBytes: capture.frame.bytes, mimeType: 'image/png' }, this.options.pairing);
      if (active.controller.signal.aborted) throw Object.assign(new Error('trigger_cancelled'), { name: 'AbortError' });
      if (observation.ocr?.status === 'unavailable' || observation.ocr?.status === 'failed' || observation.vlm?.status === 'failed') {
        const failed = this.options.mode.transitionCompanionTrigger({ triggerId: active.record.triggerId, pairing: this.options.pairing,
          runtimeSessionId: active.record.runtimeSessionId, generation: active.record.generation, status: 'failed',
          reason: 'recognition_unavailable', observationId: observation.observationId });
        active.record = failed; this.active.delete(active.record.triggerId); this.#publish(failed); return;
      }
      if (!this.#hasContent(observation)) {
        const noContent = this.options.mode.transitionCompanionTrigger({ triggerId: active.record.triggerId, pairing: this.options.pairing,
          runtimeSessionId: active.record.runtimeSessionId, generation: active.record.generation, status: 'no-content',
          reason: 'no_text_detected', observationId: observation.observationId });
        active.record = noContent; this.active.delete(active.record.triggerId); this.#publish(noContent); return;
      }
      active.record = this.options.mode.transitionCompanionTrigger({ triggerId: active.record.triggerId, pairing: this.options.pairing,
        runtimeSessionId: active.record.runtimeSessionId, generation: active.record.generation, status: 'recognized', observationId: observation.observationId });
      this.#publish(active.record);
      if (this.options.requiresContextUseGrant && !this.#contextUseAllowed(capture.frame.targetId)) {
        throw new CompanionModeError('forbidden', 'context_use_grant_revoked');
      }
      if (active.controller.signal.aborted) throw Object.assign(new Error('trigger_cancelled'), { name: 'AbortError' });
      active.record = this.options.mode.transitionCompanionTrigger({ triggerId: active.record.triggerId, pairing: this.options.pairing,
        runtimeSessionId: active.record.runtimeSessionId, generation: active.record.generation, status: 'generating', observationId: observation.observationId });
      this.#publish(active.record);
      await this.options.session.dispatch(active.record.triggerId, observation.observationId);
    } catch (error) {
      const cancelled = active.controller.signal.aborted || (error as { name?: string }).name === 'AbortError';
      if (!isTerminal(active.record.status)) {
        const failed = this.options.mode.transitionCompanionTrigger({ triggerId: active.record.triggerId, pairing: this.options.pairing,
          runtimeSessionId: active.record.runtimeSessionId, generation: active.record.generation,
          status: cancelled ? 'cancelled' : 'failed', reason: cancelled ? 'user_cancelled' : safeReason((error as Error)?.message, 'trigger_failed') });
        active.record = failed; this.#publish(failed);
      }
      this.active.delete(active.record.triggerId);
    } finally { bytes?.fill(0); }
  }

  #contextUseAllowed(targetId: string): boolean {
    const grant = this.options.mode.getContextUseGrant();
    return !!grant && grant.state === 'active' && Date.parse(grant.expiry) > this.now()
      && grant.modelBinding === this.options.dialogueModelBinding
      && grant.observationSourceScopes.some(scope => scope === `screen:${targetId}` || scope === 'screen:*');
  }

  #hasContent(observation: Observation): boolean {
    if (observation.ocr?.status === 'unavailable' || observation.ocr?.status === 'failed') return false;
    if (observation.vlm?.status === 'failed') return false;
    return !!(observation.ocr?.readingOrderText.trim() || observation.vlm?.summary.trim());
  }

  #receipt(record: CompanionTriggerRecord): CompanionTriggerReceipt {
    return { outcome: record.outcome, triggerId: record.triggerId, ...(record.reason ? { reason: record.reason } : {}), status: record.status };
  }
  #publish(record: CompanionTriggerRecord): void { try { this.options.onState?.(structuredClone(record)); } catch { /* State publishing cannot reverse a committed transition. */ } }
  #assertPairing(pairing: PairingScope): void {
    if (pairing.userId !== this.options.pairing.userId || pairing.characterId !== this.options.pairing.characterId
      || pairing.characterInstanceId !== this.options.pairing.characterInstanceId) throw new CompanionModeError('forbidden', 'Trigger pairing does not match this runtime.');
  }
}

function triggerIdFor(operationId: string): string { return `rwr10-trigger-${Buffer.from(operationId, 'utf8').toString('base64url')}`; }
function isTerminal(status: CompanionTriggerState): boolean { return ['delivered', 'no-content', 'cancelled', 'failed'].includes(status); }
function safeReason(value: unknown, fallback: string): string {
  if (typeof value === 'string') { const match = value.toLowerCase().match(/[a-z0-9_-]{1,100}/); if (match) return match[0]; }
  return fallback;
}

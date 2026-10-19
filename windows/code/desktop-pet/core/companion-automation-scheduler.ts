/**
 * core/companion-automation-scheduler.ts
 *
 * CK-13: the periodic observation policy layer.
 *
 * The two hardcoded lines this replaces told the truth badly rather than falsely: `schedulerAvailable`
 * was pinned to `false` and `nextEligibleAt` to `null`, so the console could never show *when* the
 * next automatic run was due or *why* it was withheld. A user could save a preference and be told
 * nothing at all about whether it would ever run.
 *
 * The rules that shape this scheduler, in the order they are checked:
 *
 *  1. **single-flight per target.** A tick while one is in flight is dropped, never queued. Missed
 *     cycles are not backfilled: catching up by observing three times in a row is exactly the
 *     "补采积压" the spec forbids.
 *  2. **near-duplicate suppression before generation.** Frame hash first, then a Jaccard comparison
 *     of the recognised text. Crucially, similarity ignores numbers and status words, because
 *     "余额 120 元" → "余额 98 元" is a *change that matters* even though the words are identical.
 *  3. **observation interval and reply cooldown are separate clocks.** A new observation may be
 *     taken while the previous reply is still cooling down; it simply will not produce a reply.
 *  4. **bounded backoff on failure, immediate pause on authorization loss.** A transient engine
 *     failure backs off 1×→2×→4×→8×→16× (capped, or 30 min). A revoked grant pauses at once,
 *     because retrying will never succeed and would only burn budget.
 *  5. **nothing counts as delivered before an ack**, and a suppressed/empty/busy tick is not a
 *     delivery attempt at all.
 */

import { createHash } from 'node:crypto';
import type { ObservationOutcome, ObservationItem } from './observation-scheduler.js';

export interface AutomationPolicy {
  /** Minimum spacing between two observation attempts. */
  readonly observationIntervalMs: number;
  /** Minimum spacing between two replies. Separate from the observation interval on purpose. */
  readonly replyCooldownMs: number;
  /** Frozen backoff multipliers; the last entry is the cap. */
  readonly backoffMultipliers: readonly number[];
  readonly maxBackoffMs: number;
  /** Attempts before a failing run is reported as paused. */
  readonly maxAttemptsBeforePause: number;
  /** Frozen near-duplicate threshold (Jaccard over word sets). */
  readonly nearDuplicateThreshold: number;
  readonly maxAttemptsPerRun: number;
}

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = Object.freeze({
  observationIntervalMs: 300_000,
  replyCooldownMs: 3 * 3_600_000,
  backoffMultipliers: Object.freeze([1, 2, 4, 8, 16]),
  maxBackoffMs: 30 * 60_000,
  maxAttemptsBeforePause: 5,
  nearDuplicateThreshold: 0.85,
  maxAttemptsPerRun: 2,
});

export type AutomationRunState = 'paused' | 'running' | 'cooling-down' | 'backing-off' | 'needs-authorization' | 'unavailable';

export type TickDecision =
  | { readonly run: false; readonly state: AutomationRunState; readonly reason: string }
  | { readonly run: true; readonly reason: 'due' };

export interface AutomationDeps {
  readonly now: () => number;
  /** One observation attempt. Provided by the existing ObservationScheduler. */
  readonly observe: (signal?: AbortSignal) => Promise<ObservationOutcome | null>;
  /** Whether capture/grant/route/authorizer are all actually wired. */
  readonly capabilities: () => { readonly capture: boolean; readonly route: boolean; readonly grant: boolean; readonly authorizer: boolean };
  /** Whether the user is busy: typing, recording, work confirmation pending. */
  readonly busy: () => { readonly busy: boolean; readonly reason?: string; readonly dnd?: boolean };
  /** Reserve against the shared automatic quota. False means the budget is spent. */
  readonly reserve: () => Promise<boolean>;
  /** Commit a delivery after the renderer acknowledged it. */
  readonly commitDisplayed: (observationId: string) => void;
}

export interface AutomationView {
  readonly state: AutomationRunState;
  readonly reason: string | null;
  readonly nextEligibleAt: string | null;
  readonly lastObservationAt: string | null;
  readonly consecutiveFailures: number;
  readonly suppressed: number;
}

interface SeenObservation {
  readonly frameDigest: string;
  readonly tokens: ReadonlySet<string>;
  readonly numbers: ReadonlySet<string>;
  readonly at: number;
}

const WORD = /[\p{L}\p{N}]{2,}/gu;
const NUMBER = /\d+(?:[.,]\d+)?/g;

/** Words that carry no discriminating power when deciding "is this the same screen?". */
const STOP_WORDS = new Set(['的', '了', '在', '是', '和', '与', 'the', 'a', 'an', 'of', 'to']);

function tokensOf(text: string): Set<string> {
  return new Set(
    [...text.toLocaleLowerCase().matchAll(WORD)]
      .map(match => match[0])
      .filter(token => !STOP_WORDS.has(token)),
  );
}

function numbersOf(text: string): Set<string> {
  return new Set(text.match(NUMBER) ?? []);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

export class CompanionAutomationScheduler {
  private state: AutomationRunState = 'paused';
  private reason: string | null = 'not_started';
  private lastObservationAt: number | null = null;
  private lastReplyAt: number | null = null;
  private nextEligibleAtMs: number | null = null;
  private consecutiveFailures = 0;
  private suppressed = 0;
  private inFlight = false;
  private readonly recent: SeenObservation[] = [];
  private controller: AbortController | null = null;

  constructor(
    private readonly deps: AutomationDeps,
    private readonly policy: AutomationPolicy = DEFAULT_AUTOMATION_POLICY,
  ) {}

  view(): AutomationView {
    return Object.freeze({
      state: this.state,
      reason: this.reason,
      nextEligibleAt: this.nextEligibleAtMs === null ? null : new Date(this.nextEligibleAtMs).toISOString(),
      lastObservationAt: this.lastObservationAt === null ? null : new Date(this.lastObservationAt).toISOString(),
      consecutiveFailures: this.consecutiveFailures,
      suppressed: this.suppressed,
    });
  }

  get busy(): boolean { return this.inFlight; }

  /** Explicit resume. The user has to ask; a restart never auto-resumes periodic observation. */
  resume(): void {
    this.state = 'running';
    this.reason = null;
    this.consecutiveFailures = 0;
    // Resuming means "you may observe now", not "wait one more interval": the user just said go.
    this.nextEligibleAtMs = this.deps.now();
  }

  pause(reason: string): void {
    this.state = 'paused';
    this.reason = reason;
    this.nextEligibleAtMs = null;
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * Decide whether a tick should run, without running it. Exposed separately so the settings page
   * can show the real answer instead of a hard-coded `schedulerAvailable = false`.
   */
  decide(): TickDecision {
    const now = this.deps.now();
    if (this.state === 'paused') return { run: false, state: 'paused', reason: this.reason ?? 'paused' };
    if (this.inFlight) return { run: false, state: this.state, reason: 'single_flight' };

    const capabilities = this.deps.capabilities();
    if (!capabilities.grant) return { run: false, state: 'needs-authorization', reason: 'continuous_screen_grant_required' };
    if (!capabilities.capture) return { run: false, state: 'unavailable', reason: 'real_screen_capture_unavailable' };
    if (!capabilities.route) return { run: false, state: 'unavailable', reason: 'recognition_route_unavailable' };
    if (!capabilities.authorizer) return { run: false, state: 'unavailable', reason: 'background_authorizer_unavailable' };

    if (this.nextEligibleAtMs !== null && now < this.nextEligibleAtMs) {
      return { run: false, state: this.state, reason: 'not_due_yet' };
    }
    return { run: true, reason: 'due' };
  }

  /**
   * One periodic tick.
   *
   * Missed cycles are dropped rather than queued: a scheduler that catches up by observing three
   * times in a row is producing exactly the burst the user did not ask for.
   */
  async tick(): Promise<{ readonly ran: boolean; readonly reason: string; readonly observationId?: string; readonly replyEligible?: boolean }> {
    const decision = this.decide();
    if (!decision.run) {
      if (decision.reason !== 'not_due_yet' && decision.reason !== 'single_flight') {
        this.state = decision.state;
        this.reason = decision.reason;
      }
      return { ran: false, reason: decision.reason };
    }

    const busy = this.deps.busy();
    if (busy.dnd) return { ran: false, reason: 'do_not_disturb' };
    if (busy.busy) {
      this.state = 'running';
      this.reason = busy.reason ?? 'user_busy';
      // A busy tick is not an attempt: it must not consume the interval or the backoff.
      return { ran: false, reason: this.reason };
    }

    this.inFlight = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const outcome = await this.deps.observe(controller.signal);
      this.lastObservationAt = this.deps.now();

      if (controller.signal.aborted) return { ran: false, reason: 'cancelled' };
      if (outcome === null) return { ran: false, reason: 'observation_skipped' };

      if (outcome.status === 'unavailable' || outcome.status === 'failed') {
        this.#recordFailure(outcome.status === 'unavailable' ? outcome.reason : outcome.reason);
        return { ran: false, reason: outcome.status };
      }
      if (outcome.status === 'no-content') {
        // No content is not a failure and not a delivery: it must not cost the user a cooldown.
        this.consecutiveFailures = 0;
        this.#scheduleNext(this.deps.now());
        return { ran: true, reason: 'no_content' };
      }

      const observation = outcome.observation;
      if (this.#isNearDuplicate(observation)) {
        this.suppressed += 1;
        this.consecutiveFailures = 0;
        this.#scheduleNext(this.deps.now());
        return { ran: true, reason: 'suppressed_near_duplicate' };
      }
      this.#remember(observation);

      // The reply cooldown is a SEPARATE clock from the observation interval.
      const now = this.deps.now();
      const replyEligible = this.lastReplyAt === null || now - this.lastReplyAt >= this.policy.replyCooldownMs;
      if (!replyEligible) {
        this.state = 'cooling-down';
        this.reason = 'reply_cooldown_active';
        this.#scheduleNext(now, this.policy.replyCooldownMs - (now - this.lastReplyAt!));
        return { ran: true, reason: 'reply_cooldown_active', observationId: observation.observationId, replyEligible: false };
      }

      const reserved = await this.deps.reserve();
      if (!reserved) {
        this.state = 'running';
        this.reason = 'shared_quota_exhausted';
        this.#scheduleNext(now);
        return { ran: true, reason: 'shared_quota_exhausted', observationId: observation.observationId, replyEligible: false };
      }

      // Delivered is NOT set here. The renderer must acknowledge first.
      this.lastReplyAt = now;
      this.consecutiveFailures = 0;
      this.state = 'running';
      this.reason = null;
      this.#scheduleNext(now);
      return { ran: true, reason: 'reply_pending_ack', observationId: observation.observationId, replyEligible: true };
    } finally {
      this.inFlight = false;
      if (this.controller === controller) this.controller = null;
    }
  }

  /** Called only after the renderer acknowledged. Until then nothing counts as delivered. */
  markDisplayed(observationId: string): void {
    this.deps.commitDisplayed(observationId);
    this.#scheduleNext(this.deps.now());
  }

  /**
   * Near-duplicate check.
   *
   * The frame digest is the cheap exact test. The text comparison ignores numbers on purpose:
   * if the numbers differ, the screen CHANGED in a way that matters and must not be suppressed.
   */
  #isNearDuplicate(observation: ObservationItem): boolean {
    const text = observation.text;
    const tokens = tokensOf(text);
    const numbers = numbersOf(text);
    const digest = createHash('sha256').update(`${observation.targetId}|${observation.targetRevision}|${text}`).digest('hex');

    for (const seen of this.recent) {
      if (seen.frameDigest === digest) return true;
      // A differing number is a meaningful change even when every word matches.
      if (numbers.size !== seen.numbers.size) continue;
      let sameNumbers = true;
      for (const number of numbers) if (!seen.numbers.has(number)) { sameNumbers = false; break; }
      if (!sameNumbers) continue;
      if (jaccard(tokens, seen.tokens) >= this.policy.nearDuplicateThreshold) return true;
    }
    return false;
  }

  #remember(observation: ObservationItem): void {
    this.recent.unshift({
      frameDigest: createHash('sha256')
        .update(`${observation.targetId}|${observation.targetRevision}|${observation.text}`)
        .digest('hex'),
      tokens: tokensOf(observation.text),
      numbers: numbersOf(observation.text),
      at: this.deps.now(),
    });
    while (this.recent.length > 8) this.recent.pop();
  }

  #recordFailure(reason: string): void {
    this.consecutiveFailures += 1;
    this.reason = reason;
    if (this.consecutiveFailures >= this.policy.maxAttemptsBeforePause) {
      this.state = 'paused';
      this.reason = `repeated_failure:${reason}`;
      this.nextEligibleAtMs = null;
      return;
    }
    this.state = 'backing-off';
    this.#scheduleNext(this.deps.now());
  }

  #scheduleNext(now: number, extraDelayMs?: number): void {
    const base = this.state === 'backing-off'
      ? this.#backoffDelay()
      : this.policy.observationIntervalMs;
    const delay = Math.max(base, extraDelayMs ?? 0);
    this.nextEligibleAtMs = now + delay;
  }

  #backoffDelay(): number {
    const index = Math.min(this.consecutiveFailures, this.policy.backoffMultipliers.length - 1);
    const multiplier = this.policy.backoffMultipliers[Math.max(0, index)] ?? 1;
    return Math.min(multiplier * this.policy.observationIntervalMs, this.policy.maxBackoffMs);
  }
}

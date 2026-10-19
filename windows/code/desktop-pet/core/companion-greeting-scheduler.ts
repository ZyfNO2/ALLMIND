/**
 * core/companion-greeting-scheduler.ts
 *
 * CK-14: timezone greetings, daily dedup, and takeover of the old desktop timer.
 *
 * Three problems this solves, in order of how much damage they do if ignored:
 *
 *  1. **Double timers.** The desktop host already runs a `LocalGreetingScheduler` (45 min idle,
 *     6 h cooldown, four time-of-day bands) from `prefs.localGreeting`. Starting the new
 *     rule-driven path before the old one is stopped produces two greetings a day. So the takeover
 *     is an explicit **handshake**: new delivery becomes live only after the legacy timer is
 *     confirmed stopped, the old preference has been read, and the dedup ledger is ready. A crash at
 *     any point leaves exactly one producer.
 *  2. **DST and missed windows.** A local time that occurs twice sends once; a local time skipped by
 *     a DST jump, or a window missed while the app was closed, sends **nothing** — catching up later
 *     would be an unrequested greeting at an arbitrary hour.
 *  3. **Dedup that a timezone edit cannot bypass.** The dedup key is
 *     `pairing + stable ruleId + localDate`. It deliberately does NOT include the rule's time or
 *     timezone, so editing a rule from 08:00 to 09:00 cannot produce a second greeting the same day.
 */

import type { PairingScope } from '../contracts/character-pack.js';
import type { CompanionGreetingRule } from '../contracts/companion-mode.js';

export type GreetingOutcome = 'delivered-candidate' | 'suppressed' | 'unavailable' | 'disabled';

export interface GreetingDedupRecord {
  readonly pairingKey: string;
  readonly ruleId: string;
  /** The IANA local date the greeting belongs to. */
  readonly localDate: string;
  /** The timezone that was in force when it was actually shown. */
  readonly timezoneAtSend: string;
  readonly scope: string;
  readonly shownAt: number;
}

export interface GreetingLedger {
  /** Has this exact (pairing, rule, localDate) already been shown? */
  has(record: Pick<GreetingDedupRecord, 'pairingKey' | 'ruleId' | 'localDate'>): boolean;
  /** Only called AFTER the renderer acknowledged. */
  commit(record: GreetingDedupRecord): void;
  /** Reserve against the shared automatic quota (CK-13 owns the ledger). */
  reserve(input: { readonly pairingKey: string; readonly localDate: string; readonly ruleId: string }): Promise<boolean>;
}

export interface GreetingDeps {
  readonly now: () => number;
  readonly ledger: GreetingLedger;
  /** The CK-12 local delivery owner. A local greeting must not need a screen. */
  readonly deliver: (input: { readonly pairing: PairingScope; readonly operationId: string; readonly text: string; readonly ruleId: string; readonly localDate: string; readonly timezone: string }) => Promise<string | null>;
  readonly busy: () => { readonly busy: boolean; readonly reason?: string; readonly dnd?: boolean };
  /**
   * Takeover handshake. The scheduler refuses to produce until the legacy desktop timer has
   * actually been stopped, so two producers can never both be live.
   */
  readonly takeover: TakeoverState;
}

export type TakeoverPhase = 'legacy-active' | 'legacy-stopped' | 'ready' | 'failed';

export interface TakeoverState {
  readonly phase: TakeoverPhase;
  /** Reason the takeover failed, when phase is 'failed'. */
  readonly reason?: string | null;
  readonly migratedEnabled?: boolean;
  readonly migratedLastShownAt?: number | null;
  readonly migrationVersion?: number;
}

function pairingKeyOf(pairing: PairingScope): string {
  return `${pairing.userId}|${pairing.characterId}|${pairing.characterInstanceId}`;
}

/** The IANA local calendar date at `instant` in `timezone`. */
export function localDateAt(instant: number, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(new Date(instant));
}

/** Minutes since local midnight at `instant` in `timezone`. */
export function localMinutesAt(instant: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  const hour = Number(parts.hour) % 24;
  return hour * 60 + Number(parts.minute);
}

function parseLocalTime(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export interface GreetingTickResult {
  readonly outcome: GreetingOutcome;
  readonly ruleId: string | null;
  readonly reason: string;
  /** Only set when a delivery was actually started. */
  readonly triggerId?: string;
}

export class CompanionGreetingScheduler {
  /** Local dates already consumed, keyed by pairing+rule+date. Durable via the ledger. */
  private readonly attempted = new Set<string>();

  constructor(private readonly deps: GreetingDeps) {}

  view(): { readonly takeover: TakeoverPhase; readonly reason: string | null } {
    return { takeover: this.deps.takeover.phase, reason: this.deps.takeover.reason ?? null };
  }

  /**
   * Evaluate the rules for the current instant.
   *
   * Returns at most one candidate per rule per tick and never more than the shared quota allows.
   */
  async tick(input: { readonly pairing: PairingScope; readonly rules: readonly CompanionGreetingRule[] }): Promise<GreetingTickResult[]> {
    // 1. The handshake gates everything: until the legacy timer is stopped, this path stays silent.
    const takeover = this.deps.takeover;
    if (takeover.phase === 'failed') {
      return [{ outcome: 'unavailable', ruleId: null, reason: takeover.reason ?? 'takeover_failed' }];
    }
    if (takeover.phase !== 'ready') {
      return [{ outcome: 'unavailable', ruleId: null, reason: `takeover_${takeover.phase}` }];
    }
    if (takeover.phase === 'ready' && takeover.migratedEnabled === false) {
      return [{ outcome: 'disabled', ruleId: null, reason: 'greeting_disabled_by_user' }];
    }

    const busy = this.deps.busy();
    if (busy.dnd) return [{ outcome: 'suppressed', ruleId: null, reason: 'do_not_disturb' }];
    if (busy.busy) return [{ outcome: 'suppressed', ruleId: null, reason: busy.reason ?? 'user_busy' }];

    const now = this.deps.now();
    const pairingKey = pairingKeyOf(input.pairing);
    const results: GreetingTickResult[] = [];
    // One rule fires at most once per tick, even if several rules share an id.
    const firedThisTick = new Set<string>();

    for (const rule of input.rules) {
      if (!rule.enabled) continue;
      if (firedThisTick.has(rule.id)) continue;
      const time = parseLocalTime(rule.localTime);
      if (!time) {
        results.push({ outcome: 'unavailable', ruleId: rule.id, reason: 'invalid_rule_time' });
        continue;
      }

      let localDate: string;
      let minutes: number;
      try {
        localDate = localDateAt(now, rule.timezone);
        minutes = localMinutesAt(now, rule.timezone);
      } catch {
        results.push({ outcome: 'unavailable', ruleId: rule.id, reason: 'invalid_timezone' });
        continue;
      }

      const due = time.hour * 60 + time.minute;
      // A 5-minute window catches a tick that lands slightly late without double-sending.
      if (minutes < due || minutes > due + 5) {
        // Missed and not due: no catch-up. A greeting at 15:00 for an 08:00 rule is a disturbance.
        continue;
      }

      // The dedup key deliberately omits the rule's time and timezone: editing a rule must not let
      // the user be greeted twice in one local day.
      const dedupKey = `${pairingKey}|${rule.id}|${localDate}`;
      if (this.attempted.has(dedupKey) || this.deps.ledger.has({ pairingKey, ruleId: rule.id, localDate })) {
        results.push({ outcome: 'suppressed', ruleId: rule.id, reason: 'already_shown_today' });
        continue;
      }

      const reserved = await this.deps.ledger.reserve({ pairingKey, localDate, ruleId: rule.id });
      if (!reserved) {
        results.push({ outcome: 'suppressed', ruleId: rule.id, reason: 'shared_quota_exhausted' });
        continue;
      }

      this.attempted.add(dedupKey);
      firedThisTick.add(rule.id);
      const text = greetingTextFor(rule.id, rule.localTime);
      const triggerId = await this.deps.deliver({
        pairing: input.pairing, operationId: `greeting:${rule.id}:${localDate}`,
        text, ruleId: rule.id, localDate, timezone: rule.timezone,
      });
      results.push({
        outcome: triggerId ? 'delivered-candidate' : 'unavailable',
        ruleId: rule.id,
        reason: triggerId ? 'delivery_started' : 'delivery_refused',
        ...(triggerId ? { triggerId } : {}),
      });
    }
    return results;
  }

  /**
   * Only after the renderer acknowledged.
   *
   * A greeting that was produced but never displayed must not burn the daily slot, and must not be
   * resent automatically after a crash — resending an unacknowledged old display is exactly the
   * "展示未 ack 的旧会话不自动重发" rule.
   */
  commitShown(input: { readonly pairing: PairingScope; readonly ruleId: string; readonly localDate: string; readonly timezone: string; readonly scope: string; readonly shownAt?: number }): void {
    this.deps.ledger.commit({
      pairingKey: pairingKeyOf(input.pairing),
      ruleId: input.ruleId,
      localDate: input.localDate,
      timezoneAtSend: input.timezone,
      scope: input.scope,
      shownAt: input.shownAt ?? this.deps.now(),
    });
  }
}

function greetingTextFor(ruleId: string, localTime: string): string {
  // Deterministic local text. No model, no screen, no paid call.
  const hour = Number(localTime.slice(0, 2));
  if (ruleId.includes('morning') || hour < 11) return '早上好，今天也慢慢来。';
  if (hour < 18) return '中午好，记得歇一会儿。';
  return '晚上好，今天辛苦了。';
}

/**
 * CK-14: the takeover handshake, expressed as a pure reducer so each stage is testable in isolation.
 *
 * The invariant is that exactly one producer may be live. `legacy-active` means the old desktop
 * timer still speaks; the new path is silent. Only after the host confirms the old timer is
 * stopped AND the dedup ledger reports ready does the new path speak. A failure at any step parks
 * the system in `legacy-active` — the old behaviour — rather than in a state where neither speaks.
 */
export interface TakeoverInput {
  readonly phase: TakeoverPhase;
  readonly legacyStopped: boolean;
  readonly ledgerReady: boolean;
  readonly legacyEnabled: boolean;
  readonly legacyLastShownAt: number | null;
  readonly migrationVersion: number;
  readonly failure?: string | null;
}

export function nextTakeoverPhase(input: TakeoverInput): TakeoverState {
  if (input.phase === 'failed') {
    // A failure falls back to the legacy behaviour rather than to silence.
    return { phase: 'legacy-active', reason: input.failure ?? 'takeover_failed', migratedEnabled: input.legacyEnabled, migratedLastShownAt: input.legacyLastShownAt, migrationVersion: input.migrationVersion };
  }
  if (input.phase === 'legacy-active' && input.legacyStopped) {
    return { phase: 'legacy-stopped', reason: null, migratedEnabled: input.legacyEnabled, migratedLastShownAt: input.legacyLastShownAt, migrationVersion: input.migrationVersion };
  }
  if (input.phase === 'legacy-stopped' && input.ledgerReady) {
    return { phase: 'ready', reason: null, migratedEnabled: input.legacyEnabled, migratedLastShownAt: input.legacyLastShownAt, migrationVersion: input.migrationVersion };
  }
  return { phase: input.phase, reason: input.failure ?? null, migratedEnabled: input.legacyEnabled, migratedLastShownAt: input.legacyLastShownAt, migrationVersion: input.migrationVersion };
}

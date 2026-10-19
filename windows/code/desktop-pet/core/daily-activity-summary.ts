/**
 * core/daily-activity-summary.ts
 *
 * CK-04: grounded daily activity summary.
 *
 * Two properties matter more than the prose:
 *
 *  1. The day boundary is the *user's local* day, computed from an explicit IANA timezone. A
 *     summary built from a UTC day boundary silently misfiles everything after 08:00 in
 *     Asia/Shanghai, and DST transitions must not double-count or drop an hour.
 *  2. A summary is never sent anywhere by default. `build` returns data; it does not message the
 *     user. Sending is a separate, explicitly authorized action (CK-12/13).
 *
 * The summary also carries its own coverage, so "nothing happened" and "we failed to look" are
 * distinguishable by the reader rather than being rendered as the same empty page.
 */

import type { PairingScope } from '../contracts/character-pack.js';
import { ActivityUnderstanding, orderableTime, type ActivityEvent } from './activity-understanding.js';

export type DailySummaryStatus = 'ok' | 'partial' | 'empty' | 'failed';

export interface DailySummary {
  readonly summaryId: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly localDate: string;
  readonly timezone: string;
  /** The half-open UTC instant range this local day covers. */
  readonly fromUtc: string;
  readonly toUtc: string;
  readonly status: DailySummaryStatus;
  readonly events: readonly ActivityEvent[];
  readonly eventCount: number;
  /** Events whose time is unknown and which were therefore ordered by recorded time. */
  readonly recordedTimeOnly: number;
  readonly coverage: {
    readonly considered: number;
    readonly included: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly failures: readonly string[];
  /** Always false from this module: building a summary never contacts the user. */
  readonly delivered: false;
}

export interface BuildDailySummaryRequest {
  readonly pairing: PairingScope;
  readonly localDate: string;
  readonly timezone: string;
  readonly operationId: string;
  readonly cutoff?: string;
  readonly events: readonly ActivityEvent[];
  /** Non-empty when the upstream understanding pass could not cover every input. */
  readonly upstreamFailures?: readonly string[];
  readonly signal?: AbortSignal | undefined;
}

/**
 * The UTC instant range covered by a local calendar day.
 *
 * Implemented by probing the timezone offset at the day's local boundaries rather than assuming a
 * fixed 24-hour span: on a DST transition day the local day is 23 or 25 hours long, and hard-coding
 * 86_400_000 ms would include or drop an hour of the user's activity.
 */
export function localDayRangeUtc(localDate: string, timezone: string): { fromUtc: string; toUtc: string; hours: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error('localDate must be YYYY-MM-DD');
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error('localDate is not a calendar date');

  const start = zonedMidnightToUtc(year, month, day, timezone);
  // The next local midnight, found on the calendar (not by adding 24h) so DST is handled.
  const nextDate = new Date(Date.UTC(year, month - 1, day));
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const end = zonedMidnightToUtc(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate(), timezone);

  return {
    fromUtc: new Date(start).toISOString(),
    toUtc: new Date(end).toISOString(),
    hours: (end - start) / 3_600_000,
  };
}

/** The UTC instant at which the given wall-clock local midnight occurs. */
function zonedMidnightToUtc(year: number, month: number, day: number, timezone: string): number {
  // First guess: treat the wall time as UTC, then correct by the offset the timezone actually had.
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = zoneOffsetMs(guess, timezone);
  let instant = guess - offset;
  // The offset at the corrected instant can differ across a DST boundary; settle it once.
  const corrected = zoneOffsetMs(instant, timezone);
  if (corrected !== offset) instant = guess - corrected;
  return instant;
}

/** Milliseconds to add to UTC to get local time in `timezone` at `instant`. */
function zoneOffsetMs(instant: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? '0');
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asLocal - instant;
}

export class DailyActivitySummary {
  constructor(private readonly options: { readonly now?: () => string } = {}) {}

  /**
   * Build one local day's summary.
   *
   * Events outside the requested local day are excluded rather than clamped, and events with no
   * trustworthy occurrence time are included by their recorded time while being counted in
   * `recordedTimeOnly`, so the reader can see the difference.
   */
  build(request: BuildDailySummaryRequest): DailySummary {
    if (request.signal?.aborted) throw Object.assign(new Error('summary_cancelled'), { code: 'summary_cancelled' });

    const range = localDayRangeUtc(request.localDate, request.timezone);
    const from = Date.parse(range.fromUtc);
    const to = Date.parse(range.toUtc);

    const included: ActivityEvent[] = [];
    const failures: string[] = [...(request.upstreamFailures ?? [])];
    let skipped = 0;
    let failed = 0;

    for (const event of request.events) {
      if (event.status === 'failed') { failed += 1; failures.push(`${event.eventId}:${event.reason ?? 'failed'}`); }
      const { sortKey, recordedOnly } = orderableTime(event);
      const instant = Date.parse(sortKey);
      if (Number.isNaN(instant)) { skipped += 1; continue; }
      if (instant < from || instant >= to) { skipped += 1; continue; }
      void recordedOnly;
      included.push(event);
    }

    // Deterministic order: real occurrence time first, recorded-time-only events keep their
    // recorded position. Ties break on eventId so two runs agree.
    included.sort((a, b) => {
      const left = orderableTime(a), right = orderableTime(b);
      const byTime = Date.parse(left.sortKey) - Date.parse(right.sortKey);
      if (byTime !== 0) return byTime;
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    });

    const recordedTimeOnly = included.filter(event => orderableTime(event).recordedOnly).length;
    const status: DailySummaryStatus = failed > 0
      ? (included.length === 0 ? 'failed' : 'partial')
      : included.length === 0
        ? 'empty'
        : (skipped > 0 || failures.length > 0 ? 'partial' : 'ok');

    const now = (this.options.now ?? (() => new Date().toISOString()))();
    return Object.freeze({
      summaryId: `sum-${request.pairing.characterInstanceId}-${request.localDate}`,
      revision: 1,
      pairing: request.pairing,
      localDate: request.localDate,
      timezone: request.timezone,
      fromUtc: range.fromUtc,
      toUtc: range.toUtc,
      status,
      events: Object.freeze(included),
      eventCount: included.length,
      recordedTimeOnly,
      coverage: Object.freeze({
        considered: request.events.length,
        included: included.length,
        skipped,
        failed,
      }),
      failures: Object.freeze(failures),
      delivered: false,
    });
    void now;
  }

  /**
   * True when a model call is warranted.
   *
   * The rule from the spec is explicit: a summary with no new events must not call the model. This
   * is a separate predicate so the caller cannot accidentally call first and check afterwards.
   */
  needsModel(summary: DailySummary, previous: DailySummary | null): boolean {
    if (summary.eventCount === 0) return false;
    if (!previous) return true;
    // Same event set means nothing new happened since the last revision.
    if (previous.eventCount === summary.eventCount) {
      const before = previous.events.map(event => event.eventId).join(',');
      const after = summary.events.map(event => event.eventId).join(',');
      if (before === after) return false;
    }
    return true;
  }
}

/** Convenience: understand inputs, then fold them into one local day's summary. */
export function buildSummaryFromInputs(
  understanding: ActivityUnderstanding,
  summary: DailyActivitySummary,
  request: {
    pairing: PairingScope; localDate: string; timezone: string; operationId: string;
    methodVersion: string; inputs: Parameters<ActivityUnderstanding['understand']>[0]['inputs'];
    upstreamFailures?: readonly string[];
  },
): { summary: DailySummary; understanding: ReturnType<ActivityUnderstanding['understand']> } {
  const result = understanding.understand({
    pairing: request.pairing, operationId: request.operationId,
    methodVersion: request.methodVersion, inputs: request.inputs,
  });
  return {
    understanding: result,
    summary: summary.build({
      pairing: request.pairing, localDate: request.localDate, timezone: request.timezone,
      operationId: request.operationId, events: result.events,
      ...(request.upstreamFailures ? { upstreamFailures: request.upstreamFailures } : {}),
    }),
  };
}

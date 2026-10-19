/**
 * core/activity-understanding.ts
 *
 * CK-04: source evidence -> grounded activity events.
 *
 * The hard part of this step is not summarising; it is refusing to claim more than the evidence
 * supports. Four refusals are load-bearing and each has a named rule below:
 *
 *  - `error_not_resolved`   an error report is not evidence that the problem was fixed;
 *  - `presence_not_read`    a file existing is not evidence the user read it;
 *  - `third_party_not_user` a person visible in a frame is not the account owner;
 *  - `no_time_abstain`      with no trustworthy time we abstain instead of inventing one.
 *
 * File metadata time (mtime / name date) is kept in its own field and never promoted to
 * `occurredAt`, because "when the file changed" and "when the user did the thing" are different
 * claims. `UnifiedTimelineService` stays a projection: this module owns the event, the timeline
 * only renders it.
 */

import { createHash } from 'node:crypto';
import type { PairingScope } from '../contracts/character-pack.js';
import type { CompanionSourceKind } from '../contracts/companion-mode.js';
import type { SourceEvidenceRef } from './collection-source-reader.js';

export type ActivitySubject = 'user' | 'third_party' | 'system' | 'unknown';

/**
 * What the evidence actually supports. `file_present` deliberately exists instead of
 * `read_document`: observing a file is not observing a reading act.
 */
export type ActivityKind =
  | 'authored_text'
  | 'clipboard_copy'
  | 'file_present'
  | 'file_changed'
  | 'conversation_reference'
  | 'screen_content'
  | 'unknown';

export type ActivityEvidenceKind =
  /** The account owner's own submitted words. The only kind that may become a first-person fact. */
  | 'user_stated'
  /** Content the user copied or that arrived from elsewhere; not automatically their own claim. */
  | 'third_party_content'
  /** A captured frame or image. */
  | 'captured_image'
  /** Filesystem metadata only. */
  | 'file_metadata'
  | 'unknown';

export type ActivityStatus = 'confirmed' | 'candidate' | 'unknown' | 'failed';

export interface ActivityTime {
  /** Null means we do not know when it happened. Never back-filled from mtime. */
  readonly occurredAt: string | null;
  readonly basis: 'user-stated' | 'trusted-capture' | 'in-image' | 'file-metadata' | 'unknown';
  readonly fileCreatedAt?: string | undefined;
  readonly fileModifiedAt?: string | undefined;
  readonly receivedAt: string;
}

export interface ActivityEvent {
  readonly eventId: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly subject: ActivitySubject;
  readonly claim: string;
  readonly activityKind: ActivityKind;
  readonly evidenceKind: ActivityEvidenceKind;
  readonly time: ActivityTime;
  readonly sourceRefs: readonly SourceEvidenceRef[];
  readonly status: ActivityStatus;
  /** Machine-readable reason for `unknown`/`failed`, so a gap is inspectable rather than silent. */
  readonly reason: string | null;
}

export interface ActivityCoverage {
  readonly considered: number;
  readonly events: number;
  readonly unknown: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface ActivityUnderstandingResult {
  readonly operationId: string;
  readonly methodVersion: string;
  readonly events: readonly ActivityEvent[];
  readonly coverage: ActivityCoverage;
  /** Why individual inputs produced no event. Never empty when coverage has gaps. */
  readonly diagnostics: readonly { readonly sourceId: string; readonly reason: string }[];
}

/** One piece of evidence, already read through the CK-01 controlled port. */
export interface ActivityInput {
  readonly evidence: SourceEvidenceRef;
  readonly sourceKind: CompanionSourceKind;
  /** Validated body text, or null for a binary/absent body. */
  readonly text: string | null;
  /** True only when the user submitted this text themselves. */
  readonly userSubmitted?: boolean;
  /** True when the content is known to originate from someone other than the owner. */
  readonly thirdParty?: boolean;
  /** Set when this input is a report of a failure rather than a success. */
  readonly failure?: boolean;
}

export interface ActivityUnderstandingRequest {
  readonly pairing: PairingScope;
  readonly operationId: string;
  readonly methodVersion: string;
  readonly inputs: readonly ActivityInput[];
}

/** Same source + same content version + same claim collapses into one event. */
function eventKeyOf(input: ActivityInput, claim: string): string {
  const ref = input.evidence;
  return [
    ref.sourceKind, ref.sourceId, String(ref.sourceRevision), ref.contentHash ?? 'no-hash', claim,
  ].join('|');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Classify one input. Returns either an event or a reason the input produced none, so a gap is
 * always explainable instead of being silently dropped.
 */
export function classifyActivity(input: ActivityInput): { readonly event: ActivityEvent } | { readonly skip: string } {
  const ref = input.evidence;

  // Rule `no_time_abstain`: a source whose validity already lapsed cannot ground a claim at all.
  if (ref.validity !== 'valid') return { skip: `source_${ref.validity}` };

  // Rule `error_not_resolved`: a failure report may be recorded as a failure, never as a success
  // or as proof that the underlying problem was fixed.
  if (input.failure) {
    return {
      event: buildEvent(input, {
        subject: 'user',
        claim: input.text?.trim() ? input.text.trim().slice(0, 500) : '记录到一次失败，未推断为已解决',
        activityKind: 'unknown',
        evidenceKind: 'user_stated',
        status: 'failed',
        reason: 'reported_failure_not_resolution',
      }),
    };
  }

  const text = input.text?.trim() ?? '';

  switch (input.sourceKind) {
    case 'manual_text':
    case 'input_text': {
      if (!text) return { skip: 'empty_body' };
      // Only the owner's own submission is first-person evidence.
      return {
        event: buildEvent(input, {
          subject: input.userSubmitted === false ? 'third_party' : 'user',
          claim: text.slice(0, 500),
          activityKind: 'authored_text',
          evidenceKind: input.thirdParty ? 'third_party_content' : 'user_stated',
          status: 'confirmed',
          reason: null,
        }),
      };
    }

    case 'clipboard_text': {
      if (!text) return { skip: 'empty_body' };
      // Rule: copied text is evidence the user copied something, not that they wrote or endorse it.
      return {
        event: buildEvent(input, {
          subject: 'user',
          claim: `复制了一段内容（${text.length} 字）`,
          activityKind: 'clipboard_copy',
          evidenceKind: 'third_party_content',
          status: 'candidate',
          reason: null,
        }),
      };
    }

    case 'workspace_directory':
    case 'download_directory': {
      // Rule `presence_not_read`: a file existing or changing is not a reading act.
      return {
        event: buildEvent(input, {
          subject: 'user',
          claim: input.text
            ? `工作区文件「${ref.locator}」存在且可读`
            : `工作区文件「${ref.locator}」存在（未读取正文）`,
          activityKind: ref.time.fileModifiedAt ? 'file_changed' : 'file_present',
          evidenceKind: 'file_metadata',
          // Metadata alone never confirms a user action.
          status: 'candidate',
          reason: 'metadata_does_not_establish_user_action',
        }),
      };
    }

    case 'history_reference':
      return {
        event: buildEvent(input, {
          subject: 'user',
          claim: '引用了一段既有对话',
          activityKind: 'conversation_reference',
          evidenceKind: 'user_stated',
          status: 'confirmed',
          reason: null,
        }),
      };

    case 'screenshot_directory':
    case 'clipboard_image': {
      if (!text) return { skip: 'image_without_recognised_text' };
      // Rule `third_party_not_user`: text recognised inside a frame is content on screen, not a
      // statement by the account owner.
      return {
        event: buildEvent(input, {
          subject: 'third_party',
          claim: text.slice(0, 500),
          activityKind: 'screen_content',
          evidenceKind: 'captured_image',
          status: 'candidate',
          reason: 'on_screen_content_is_not_owner_statement',
        }),
      };
    }

    default:
      return { skip: 'unsupported_source_kind' };
  }
}

function buildEvent(
  input: ActivityInput,
  parts: {
    subject: ActivitySubject;
    claim: string;
    activityKind: ActivityKind;
    evidenceKind: ActivityEvidenceKind;
    status: ActivityStatus;
    reason: string | null;
  },
): ActivityEvent {
  const ref = input.evidence;
  const key = eventKeyOf(input, parts.claim);
  return Object.freeze({
    eventId: `act-${digest(key)}`,
    revision: 1,
    pairing: ref.scope,
    subject: parts.subject,
    claim: parts.claim,
    activityKind: parts.activityKind,
    evidenceKind: parts.evidenceKind,
    // `occurredAt` comes only from the evidence's own time package; metadata time stays separate.
    time: Object.freeze({
      occurredAt: ref.time.occurredAt,
      basis: ref.time.occurredAtBasis,
      ...(ref.time.fileCreatedAt === undefined ? {} : { fileCreatedAt: ref.time.fileCreatedAt }),
      ...(ref.time.fileModifiedAt === undefined ? {} : { fileModifiedAt: ref.time.fileModifiedAt }),
      receivedAt: ref.time.receivedAt,
    }),
    sourceRefs: Object.freeze([ref]),
    status: parts.status,
    reason: parts.reason,
  });
}

/**
 * Deterministic, model-free understanding.
 *
 * No model binding is required to be correct here: every claim above is derived from evidence
 * kinds the source layer already established. When no model is configured this still produces
 * grounded events, and it never invents a claim the evidence does not carry.
 */
export class ActivityUnderstanding {
  constructor(private readonly options: { readonly now?: () => string } = {}) {}

  understand(request: ActivityUnderstandingRequest): ActivityUnderstandingResult {
    const byEvent = new Map<string, ActivityEvent>();
    const diagnostics: { sourceId: string; reason: string }[] = [];
    let skipped = 0;

    for (const input of request.inputs) {
      // Cross-pairing evidence is refused outright: another instance's source is not ours.
      if (input.evidence.scope.characterInstanceId !== request.pairing.characterInstanceId
        || input.evidence.scope.userId !== request.pairing.userId
        || input.evidence.scope.characterId !== request.pairing.characterId) {
        skipped += 1;
        diagnostics.push({ sourceId: input.evidence.sourceId, reason: 'pairing_mismatch' });
        continue;
      }

      const result = classifyActivity(input);
      if ('skip' in result) {
        skipped += 1;
        diagnostics.push({ sourceId: input.evidence.sourceId, reason: result.skip });
        continue;
      }

      const existing = byEvent.get(result.event.eventId);
      if (existing) {
        // Same source version and same claim: merge the refs instead of creating a second weight.
        byEvent.set(result.event.eventId, Object.freeze({
          ...existing,
          sourceRefs: Object.freeze([...existing.sourceRefs, input.evidence]),
        }));
        continue;
      }
      byEvent.set(result.event.eventId, result.event);
    }

    const events = Object.freeze([...byEvent.values()]);
    const unknown = events.filter(event => event.status === 'unknown').length;
    const failed = events.filter(event => event.status === 'failed').length;

    return Object.freeze({
      operationId: request.operationId,
      methodVersion: request.methodVersion,
      events,
      coverage: Object.freeze({
        considered: request.inputs.length,
        events: events.length,
        unknown,
        failed,
        skipped,
      }),
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

/**
 * CK-04 time ordering: an event with no trustworthy `occurredAt` is ordered by its recorded time
 * and must be labelled as such. The label is returned so callers cannot accidentally present a
 * recorded time as an occurrence time.
 */
export function orderableTime(event: ActivityEvent): { readonly sortKey: string; readonly recordedOnly: boolean } {
  if (event.time.occurredAt) return { sortKey: event.time.occurredAt, recordedOnly: false };
  return { sortKey: event.time.receivedAt, recordedOnly: true };
}

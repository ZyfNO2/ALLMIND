/**
 * core/collection-source-reader.ts
 *
 * CK-01: Controlled source-read port.
 *
 * The batch runner used to derive text from the candidate *label*, and it treated
 * "skipped because no reader exists" as a successful day. Both are wrong: a display
 * name is never body text, and an unprocessed item is never a completed day.
 *
 * This port is the ONLY sanctioned way to obtain real body bytes or text for a
 * candidate. It accepts owner-issued ids, never caller-supplied filesystem paths,
 * and it re-checks pairing, grant revision, source revision and expiry around the
 * read so a revoked or replaced source cannot commit afterwards.
 */

import { createHash } from 'node:crypto';
import type { PairingScope } from '../contracts/character-pack.js';
import type { CompanionSourceKind } from '../contracts/companion-mode.js';
import type { CollectionStore } from '../memory/collection-store.js';

export type SourceReadOutcome =
  | 'ok'
  | 'no-content'
  | 'unsupported'
  | 'missing'
  | 'unavailable'
  | 'invalidated'
  | 'expired'
  | 'version-conflict';

export type SourceReadPurpose = 'parse' | 'compile-knowledge';

export interface EvidenceTime {
  readonly occurredAt: string | null;
  readonly occurredAtBasis:
    | 'user-stated'
    | 'trusted-capture'
    | 'in-image'
    | 'file-metadata'
    | 'unknown';
  readonly receivedAt: string;
  readonly fileCreatedAt?: string | undefined;
  readonly fileModifiedAt?: string | undefined;
  readonly filenameTime?: string | undefined;
  readonly capturedAt?: string | undefined;
  readonly timezone?: string | undefined;
}

export interface SourceEvidenceRef {
  readonly schemaVersion: 1;
  readonly sourceKind: CompanionSourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly contentHash: string | null;
  readonly locator: string;
  readonly scope: PairingScope;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly generation: number;
  readonly origin: string;
  readonly time: EvidenceTime;
  readonly validity: 'valid' | 'invalidated' | 'expired';
  readonly expiresAt: string;
}

export interface SourceReadRequest {
  readonly pairing: PairingScope;
  readonly sourceId: string;
  readonly expectedSourceRevision: number;
  readonly grantRevision: number;
  readonly purpose: SourceReadPurpose;
  readonly signal?: AbortSignal | undefined;
}

export type SourceReadResult =
  | {
      readonly outcome: 'ok';
      /** Validated text. Empty is never reported as ok. */
      readonly text: string;
      readonly mediaType: 'text';
      readonly bytes: number;
      readonly evidence: SourceEvidenceRef;
    }
  | {
      readonly outcome: 'ok';
      /** Validated bytes for a controlled file reference. */
      readonly bytes: Uint8Array;
      readonly mediaType: string;
      readonly filename: string;
      readonly evidence: SourceEvidenceRef;
    }
  | {
      readonly outcome: Exclude<SourceReadOutcome, 'ok'>;
      readonly reason: string;
      readonly evidence: SourceEvidenceRef;
    };

export interface SourceReadPort {
  read(request: SourceReadRequest): Promise<SourceReadResult>;
}

/** Extensions the production reader can hand to the document parser as text-like. */
export const PARSEABLE_TEXT_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.srt', '.vtt']),
);

/** Extensions that are recognised as files but are not supported in this version. */
export const RECOGNISED_UNSUPPORTED_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.zip', '.7z', '.rar', '.mp4', '.mp3', '.wav']),
);

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLocaleLowerCase();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Storage-backed reader. It resolves the candidate's stored body text, or the bytes of
 * an owner-issued managed asset, and verifies the source has not changed underneath it.
 */
export class CollectionSourceReader implements SourceReadPort {
  constructor(private readonly store: CollectionStore) {}

  async read(request: SourceReadRequest): Promise<SourceReadResult> {
    if (request.signal?.aborted) {
      throw Object.assign(new Error('read_cancelled'), { code: 'read_cancelled' });
    }

    const record = this.store.readSourceBody({
      pairing: request.pairing,
      sourceId: request.sourceId,
      expectedSourceRevision: request.expectedSourceRevision,
      grantRevision: request.grantRevision,
    });

    if (record.outcome !== 'ok') {
      return Object.freeze({
        outcome: record.outcome,
        reason: record.reason,
        evidence: record.evidence,
      });
    }

    const evidence = record.evidence;

    if (request.signal?.aborted) {
      throw Object.assign(new Error('read_cancelled'), { code: 'read_cancelled' });
    }

    if (record.text !== null) {
      // A stored body must actually contain text; an empty body is not a success.
      if (record.text.trim().length === 0) {
        return Object.freeze({ outcome: 'no-content', reason: 'stored_body_empty', evidence });
      }
      return Object.freeze({
        outcome: 'ok',
        text: record.text,
        mediaType: 'text',
        bytes: Buffer.byteLength(record.text, 'utf8'),
        evidence,
      });
    }

    if (record.filename) {
      const extension = extensionOf(record.filename);
      if (!PARSEABLE_TEXT_EXTENSIONS.has(extension)) {
        return Object.freeze({
          outcome: 'unsupported',
          reason: RECOGNISED_UNSUPPORTED_EXTENSIONS.has(extension)
            ? 'extension_not_supported_in_this_version'
            : 'unknown_extension_without_reader',
          evidence,
        });
      }
    }

    const bytes = this.store.readSourceBytes({
      pairing: request.pairing,
      sourceId: request.sourceId,
    });
    if (bytes === null) {
      return Object.freeze({ outcome: 'missing', reason: 'managed_bytes_gone', evidence });
    }
    if (bytes.byteLength === 0) {
      return Object.freeze({ outcome: 'no-content', reason: 'zero_length_source', evidence });
    }

    return Object.freeze({
      outcome: 'ok',
      bytes,
      mediaType: record.mimeType ?? 'application/octet-stream',
      filename: record.filename ?? `${request.sourceId}.bin`,
      evidence,
    });
  }
}

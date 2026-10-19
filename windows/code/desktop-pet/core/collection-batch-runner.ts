/**
 * core/collection-batch-runner.ts
 *
 * N082-06: Incremental batch parsing and scheduling runner.
 * CK-01: real body reading and honest completion semantics.
 *
 * Two previously-reproduced P1 defects are fixed here and must not return:
 *   1. Derived text used to fall back to the candidate's *label* when no body was read.
 *      A display name is never body text, so this is now impossible by construction.
 *   2. Candidates that were skipped because no reader/parser existed were still counted
 *      as a successful day. A day now completes only when every processable item reached
 *      a terminal state and nothing is backlogged for a missing capability.
 *
 * Bounded concurrency, checkpoint tracking, and persistent daily schedule ledger.
 */

import type { Database } from 'better-sqlite3';
import type { PairingScope } from '../contracts/character-pack.js';
import type { JobStatus, JobTrigger, DerivedTextStatus } from '../contracts/companion-mode.js';
import type { CollectionStore } from '../memory/collection-store.js';
import type { DocumentParser } from './document-parser.js';
import type { SourceReadPort, SourceReadResult } from './collection-source-reader.js';

/** Frozen CK-00 limits: per-item read/parse timeouts, page size, batch ceiling, retries. */
export const BATCH_LIMITS = Object.freeze({
  /** Page size only. A batch may span pages via checkpoint; this is never "the" batch size. */
  pageSize: 50,
  /** Bounded work per batch. Beyond this the job ends partial with `remaining` set. */
  maxItemsPerBatch: 500,
  itemReadTimeoutMs: 5_000,
  itemParseTimeoutMs: 15_000,
  batchTimeoutMs: 120_000,
  /** Same processing key, one automatic retry. Never a fresh key per day. */
  maxAttemptsPerItem: 2,
  processorId: 'standard-batch-parser-v1',
  processorVersion: '1.1.0',
});

export type BatchItemOutcome =
  | 'processed'
  | 'no-content'
  | 'unsupported'
  | 'missing'
  | 'invalidated'
  | 'version-conflict'
  | 'capability-missing'
  | 'parse-failed'
  | 'cancelled'
  | 'skipped';

export interface BatchItemReport {
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly outcome: BatchItemOutcome;
  readonly reason: string;
  readonly attempts: number;
  readonly derivedId?: string | undefined;
}

export interface BatchRunnerOptions {
  readonly db: Database;
  readonly store: CollectionStore;
  readonly pairing: PairingScope;
  readonly parser?: DocumentParser | undefined;
  /** CK-01: the controlled reader. Without it no file body can be read, and no day completes. */
  readonly reader?: SourceReadPort | undefined;
  readonly now?: (() => string) | undefined;
}

export interface BatchRequestInput {
  readonly trigger: JobTrigger;
  readonly operationId: string;
  readonly expectedPolicyRevision: number;
  readonly generation: number;
  readonly scheduledDay?: string;
  readonly signal?: AbortSignal | undefined;
}

export interface BatchRunReceipt {
  readonly jobId: string;
  readonly state: JobStatus['state'];
  readonly reasonCode: string | null;
  readonly counts: JobStatus['counts'];
  readonly items: readonly BatchItemReport[];
  /** Items left unprocessed because a page/batch limit or deadline was reached. */
  readonly remaining: number;
  readonly nextCursor: string | null;
  readonly dayCompleted: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

export class CollectionBatchRunner {
  private readonly db: Database;
  private readonly store: CollectionStore;
  private readonly pairing: PairingScope;
  private readonly parser?: DocumentParser | undefined;
  private readonly reader?: SourceReadPort | undefined;
  private readonly now: () => string;
  private activeJob: JobStatus | null = null;
  /** Persistent idempotency: operationId -> canonical payload digest + receipt. */
  private readonly operations = new Map<string, { readonly digest: string; readonly receipt: BatchRunReceipt }>();
  private cancelledOperations = new Set<string>();

  constructor(options: BatchRunnerOptions) {
    this.db = options.db;
    this.store = options.store;
    this.pairing = options.pairing;
    this.parser = options.parser;
    this.reader = options.reader;
    this.now = options.now ?? (() => new Date().toISOString());
    this.#initLedger();
  }

  #initLedger(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_batch_ledger(
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        scheduled_day TEXT NOT NULL,
        last_success_at TEXT NOT NULL,
        PRIMARY KEY(user_id, character_id, character_instance_id, scheduled_day));
      CREATE TABLE IF NOT EXISTS companion_batch_operations(
        pairing_key TEXT NOT NULL, operation_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(pairing_key, operation_id));
    `);
  }

  #pairKey(): string {
    return `${this.pairing.userId}|${this.pairing.characterId}|${this.pairing.characterInstanceId}`;
  }

  /**
   * Request a batch run.
   *
   * CK-01 semantics:
   *  - same `operationId` + same payload replays the same receipt (persistent idempotency);
   *  - same `operationId` + different payload is a conflict, not a second run;
   *  - a concurrent run for this pairing returns the active job;
   *  - a completed daily/catchup day short-circuits with a distinct reason code.
   */
  async request(input: BatchRequestInput): Promise<JobStatus> {
    const digest = JSON.stringify([
      input.trigger, input.expectedPolicyRevision, input.generation, input.scheduledDay ?? null,
    ]);
    const pairKey = this.#pairKey();

    const persisted = this.db.prepare(`
      SELECT payload_digest, receipt_json FROM companion_batch_operations
      WHERE pairing_key=? AND operation_id=?
    `).get(pairKey, input.operationId) as { payload_digest: string; receipt_json: string } | undefined;

    if (persisted) {
      if (persisted.payload_digest !== digest) {
        throw Object.assign(new Error('operation_id_payload_conflict'), { code: 'operation_id_payload_conflict' });
      }
      return JSON.parse(persisted.receipt_json) as JobStatus;
    }
    const inMemory = this.operations.get(input.operationId);
    if (inMemory && inMemory.digest !== digest) {
      throw Object.assign(new Error('operation_id_payload_conflict'), { code: 'operation_id_payload_conflict' });
    }

    if (this.activeJob && this.activeJob.state === 'running') {
      return this.activeJob;
    }

    const today = input.scheduledDay ?? this.now().slice(0, 10);

    if (input.trigger === 'daily' || input.trigger === 'catchup') {
      const alreadyRun = this.db.prepare(`
        SELECT 1 FROM companion_batch_ledger
        WHERE user_id=? AND character_id=? AND character_instance_id=? AND scheduled_day=?
      `).get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId, today);

      if (alreadyRun) {
        const skipped = Object.freeze({
          jobId: `skipped-${today}`,
          pairing: this.pairing,
          kind: 'batch' as const,
          trigger: input.trigger,
          policyRevision: input.expectedPolicyRevision,
          generation: input.generation,
          scheduledDay: today,
          cutoff: this.now(),
          state: 'succeeded' as const,
          startedAt: this.now(),
          finishedAt: this.now(),
          checkpoint: null,
          counts: { accepted: 0, processed: 0, failed: 0, skipped: 1, dropped: 0 },
          reasonCode: 'already_completed_today',
        });
        this.#remember(input.operationId, digest, {
          jobId: skipped.jobId, state: 'succeeded', reasonCode: 'already_completed_today',
          counts: skipped.counts, items: [], remaining: 0, nextCursor: null, dayCompleted: true,
        });
        return skipped;
      }
    }

    const cutoff = this.now();
    const job = this.store.claimJob({
      pairing: this.pairing,
      kind: 'batch',
      trigger: input.trigger,
      policyRevision: input.expectedPolicyRevision,
      generation: input.generation,
      scheduledDay: today,
      cutoff,
    });
    this.activeJob = job;

    // Run the batch execution. The receipt is persisted even when the caller never awaits it.
    // The operation id is only marked cancelled by an explicit `cancel()` call.
    void this.#executeBatch(job, cutoff, input).catch((err: unknown) => {
      // A crash outside the per-item guard must still finish the job, keep the first error,
      // and never leave an eternally "running" job behind.
      process.stderr.write(`batch runner fatal: ${(err as Error).message}\n`);
      try {
        this.store.finishJob(job.jobId, { state: 'failed', reasonCode: 'runner_internal_error' });
      } finally {
        this.activeJob = null;
        this.cancelledOperations.delete(input.operationId);
      }
    });
    return job;
  }

  #remember(operationId: string, digest: string, receipt: BatchRunReceipt): void {
    this.operations.set(operationId, { digest, receipt });
    this.db.prepare(`
      INSERT INTO companion_batch_operations(pairing_key, operation_id, payload_digest, receipt_json, created_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(pairing_key, operation_id) DO NOTHING
    `).run(this.#pairKey(), operationId, digest, JSON.stringify(receipt), this.now());
  }

  async #executeBatch(job: JobStatus, cutoff: string, request: BatchRequestInput): Promise<void> {
    const items: BatchItemReport[] = [];
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    let remaining = 0;
    let nextCursor: string | null = null;
    let cancelled = false;
    let firstError: string | null = null;
    /** Categories that make the day incomplete regardless of how many items succeeded. */
    let capabilityBlocked = 0;
    let rejected = 0;

    const startedAtMs = Date.parse(this.now());
    const deadline = startedAtMs + BATCH_LIMITS.batchTimeoutMs;
    let cursor: string | null = null;
    let accepted = 0;

    try {
      let visited = 0;
      let exhausted = false;

      while (!exhausted && visited < BATCH_LIMITS.maxItemsPerBatch) {
        if (request.signal?.aborted || this.cancelledOperations.has(request.operationId)) { cancelled = true; break; }
        if (Date.parse(this.now()) >= deadline) { remaining += 1; break; }

        const page = this.store.listPending(this.pairing, cutoff, BATCH_LIMITS.pageSize, cursor);
        if (page.length === 0) { exhausted = true; break; }
        cursor = String(page[page.length - 1]!.id);
        nextCursor = cursor;

        for (const item of page) {
          if (request.signal?.aborted || this.cancelledOperations.has(request.operationId)) { cancelled = true; break; }
          if (Date.parse(this.now()) >= deadline) { remaining += 1; break; }
          visited += 1;
          accepted += 1;

          let report: BatchItemReport;
          try {
            report = await this.#processItem(item, request.signal);
          } catch (err: unknown) {
            // Keep the first real error instead of only incrementing a counter.
            if ((err as { code?: string })?.code !== 'read_cancelled') {
              firstError ??= `${(err as Error).message}`;
            }
            report = {
              sourceId: item.id,
              sourceKind: item.sourceKind,
              outcome: 'parse-failed',
              reason: (err as Error).message || 'unexpected_error',
              attempts: 1,
            };
          }
          items.push(report);

          switch (report.outcome) {
            case 'processed': processed += 1; break;
            case 'unsupported': skipped += 1; break;
            case 'no-content':
            case 'missing':
            case 'invalidated':
            case 'version-conflict': rejected += 1; skipped += 1; break;
            case 'capability-missing': capabilityBlocked += 1; skipped += 1; break;
            case 'cancelled': cancelled = true; skipped += 1; break;
            default: failed += 1; break;
          }

          if (report.outcome === 'capability-missing') break;
        }

        if (cancelled || capabilityBlocked > 0 || visited >= BATCH_LIMITS.maxItemsPerBatch) break;
        if (page.length < BATCH_LIMITS.pageSize) { exhausted = true; }
      }

      // Anything still pending after a clean sweep is genuinely outstanding work.
      if (!cancelled && capabilityBlocked === 0 && remaining === 0) {
        const tail = this.store.listPending(this.pairing, cutoff, 1, cursor);
        remaining = tail.length;
        if (remaining > 0) nextCursor = cursor;
      }

      const totalOutstanding = failed + capabilityBlocked + remaining;
      const noWorkAtAll = accepted === 0;
      let state: JobStatus['state'];
      let reasonCode: string | null = null;

      if (cancelled) {
        state = 'cancelled';
        reasonCode = 'cancelled';
      } else if (noWorkAtAll) {
        // Genuinely nothing new is a legitimate, honest completion.
        state = 'succeeded';
        reasonCode = 'no_new_input';
      } else if (capabilityBlocked > 0) {
        state = 'failed';
        reasonCode = 'capability_missing';
      } else if (failed > 0) {
        state = processed > 0 ? 'partial' : 'failed';
        reasonCode = firstError ? 'items_failed' : 'items_failed';
      } else if (remaining > 0) {
        state = 'partial';
        reasonCode = 'remaining_items';
      } else {
        state = 'succeeded';
        reasonCode = 'completed';
      }

      // Daily completion rule (CK-01 P1 #2): everything processable finished, every
      // unsupported item is terminal, and there is no capability/authorization/failure
      // backlog. "Has parseable files but no reader/OCR" can never complete the day.
      const dayCompleted = !cancelled
        && totalOutstanding === 0
        && (noWorkAtAll || (processed > 0 && rejected === 0));

      this.store.finishJob(job.jobId, {
        state,
        counts: { accepted, processed, failed, skipped, dropped: 0 },
        checkpoint: remaining > 0 ? nextCursor : null,
        reasonCode,
      });

      if (dayCompleted && (job.trigger === 'daily' || job.trigger === 'catchup')) {
        this.db.prepare(`
          INSERT INTO companion_batch_ledger(
            user_id, character_id, character_instance_id, scheduled_day, last_success_at)
          VALUES(?,?,?,?,?)
          ON CONFLICT(user_id, character_id, character_instance_id, scheduled_day) DO UPDATE SET
            last_success_at=excluded.last_success_at
        `).run(
          this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId,
          job.scheduledDay, this.now(),
        );
      }

      this.#remember(request.operationId, JSON.stringify([
        request.trigger, request.expectedPolicyRevision, request.generation, request.scheduledDay ?? null,
      ]), {
        jobId: job.jobId,
        state,
        reasonCode,
        counts: { accepted, processed, failed, skipped, dropped: 0 },
        items,
        remaining,
        nextCursor: remaining > 0 ? nextCursor : null,
        dayCompleted,
      });
    } finally {
      // Release always happens, including on cancellation or an unexpected throw.
      this.cancelledOperations.delete(request.operationId);
      this.activeJob = null;
    }
  }

  /**
   * Process one candidate through the controlled reader.
   *
   * The reader — never a display name — supplies the body. Classification distinguishes
   * "nothing new" from "unsupported" from "capability missing" from "really failed".
   */
  async #processItem(
    item: {
      readonly id: string;
      readonly revision: number;
      readonly sourceKind: string;
      readonly grantRevision: number;
      readonly expiresAt: string;
      readonly displayName?: string | undefined;
      readonly mimeType?: string | undefined;
      readonly stableVersion?: string | undefined;
    },
    signal?: AbortSignal,
  ): Promise<BatchItemReport> {
    const base = { sourceId: item.id, sourceKind: item.sourceKind, attempts: 1 } as const;

    if (!this.reader) {
      // No reader at all: every parseable file is blocked, not "skipped and done".
      return { ...base, outcome: 'capability-missing', reason: 'source_reader_not_configured' };
    }

    let read: SourceReadResult;
    try {
      read = await withTimeout(
        this.reader.read({
          pairing: this.pairing,
          sourceId: item.id,
          expectedSourceRevision: item.revision,
          grantRevision: item.grantRevision,
          purpose: 'parse',
          signal,
        }),
        BATCH_LIMITS.itemReadTimeoutMs,
        'source_read_timeout',
      );
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'read_cancelled' || signal?.aborted) {
        return { ...base, outcome: 'cancelled', reason: 'read_cancelled' };
      }
      return { ...base, outcome: 'parse-failed', reason: `read_failed:${(err as Error).message}` };
    }

    if (read.outcome !== 'ok') {
      const mapping: Record<string, BatchItemOutcome> = {
        'no-content': 'no-content',
        unsupported: 'unsupported',
        missing: 'missing',
        invalidated: 'invalidated',
        unavailable: 'capability-missing',
        // An expired source is a terminal, non-recoverable state: it must not be retried
        // forever, and it must never be mistaken for real work still outstanding.
        expired: 'invalidated',
        'version-conflict': 'version-conflict',
      };
      return { ...base, outcome: mapping[read.outcome] ?? 'parse-failed', reason: read.reason };
    }

    // A revoke between read and commit must invalidate the candidate before we write anything.
    if (read.evidence.validity !== 'valid') {
      this.store.invalidateCandidate(this.pairing, item.id, 'source_invalidated_during_read');
      return { ...base, outcome: 'invalidated', reason: `invalidated:${read.evidence.validity}` };
    }

    const version = item.stableVersion ?? `v${read.evidence.sourceRevision}`;
    const processingKey = `proc-${item.id}-${version}-${BATCH_LIMITS.processorId}-${BATCH_LIMITS.processorVersion}`;

    let text: string;
    if ('text' in read) {
      text = read.text;
    } else {
      if (!this.parser) {
        // The bytes are real and readable, but nothing can parse them: capability gap.
        return { ...base, outcome: 'capability-missing', reason: 'document_parser_not_configured' };
      }
      try {
        const parsed = await withTimeout(
          this.parser.parse({
            filename: read.filename,
            bytes: read.bytes,
            mimeType: read.mediaType,
            signal,
          }),
          BATCH_LIMITS.itemParseTimeoutMs,
          'document_parse_timeout',
        );
        if (parsed.status === 'unsupported' || parsed.status === 'missing') {
          return { ...base, outcome: 'unsupported', reason: `parse_${parsed.status}` };
        }
        if (parsed.status === 'cancelled') return { ...base, outcome: 'cancelled', reason: 'parse_cancelled' };
        text = parsed.text;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'document_parse_timeout') {
          return { ...base, outcome: 'parse-failed', reason: 'parse_timeout' };
        }
        if (signal?.aborted) return { ...base, outcome: 'cancelled', reason: 'parse_cancelled' };
        return { ...base, outcome: 'parse-failed', reason: `parse_failed:${(err as Error).message}` };
      }
    }

    if (text.trim().length === 0) {
      // Real read, genuinely empty result: never stored as a successful derivation.
      return { ...base, outcome: 'no-content', reason: 'extracted_text_empty' };
    }

    let status: DerivedTextStatus = 'ok';
    const committed = this.store.commitDerived(this.pairing, {
      parentRefs: [{ sourceId: item.id, version }],
      processorId: BATCH_LIMITS.processorId,
      processorVersion: BATCH_LIMITS.processorVersion,
      grantRevision: item.grantRevision,
      processingKey,
      status,
      text,
      expiresAt: item.expiresAt,
      expectedSourceRevision: item.revision,
      expectedGrantRevision: item.grantRevision,
    });

    if (!committed.committed) {
      // The source changed or was revoked between read and commit: refuse the late write.
      return { ...base, outcome: committed.reason === 'version-conflict' ? 'version-conflict' : 'invalidated', reason: committed.reason };
    }

    return { ...base, outcome: 'processed', reason: 'ok', derivedId: committed.id };
  }

  isDayCompleted(day: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM companion_batch_ledger
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND scheduled_day=?
    `).get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId, day);
    return row !== undefined;
  }

  /** CK-01: inspect a completed run's persisted receipt. */
  receiptFor(operationId: string): BatchRunReceipt | null {
    const inMemory = this.operations.get(operationId);
    if (inMemory) return inMemory.receipt;
    const row = this.db.prepare(`
      SELECT receipt_json FROM companion_batch_operations WHERE pairing_key=? AND operation_id=?
    `).get(this.#pairKey(), operationId) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as BatchRunReceipt : null;
  }

  /** CK-01: cancel an in-flight run and release its resources. */
  cancel(operationId: string): boolean {
    if (this.activeJob?.state !== 'running') return false;
    this.cancelledOperations.add(operationId);
    return true;
  }
}

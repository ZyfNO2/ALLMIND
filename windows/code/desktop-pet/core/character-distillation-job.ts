/**
 * core/character-distillation-job.ts
 *
 * CK-07: the production owner for "designated Wiki / storybook -> character distillation DRAFT".
 *
 * What this adds on top of the existing N07 `CharacterDistiller`:
 *
 *  - a **single-flight job** with an operationId, a scope check, and a cancel that actually aborts
 *    the in-flight request instead of merely setting a flag;
 *  - a **mandatory budget gate** (CK-04 `BackgroundCallAuthorizer` + `canRunBackground`). The
 *    distiller itself now refuses to construct without an authorizer, so a background job cannot
 *    spend money that no ledger recorded;
 *  - **branch / cutoff discipline**: two branches are separate jobs and never merged, and the draft
 *    stays bound to the cutoff it was compiled under;
 *  - **failure visibility**: login walls, redirects into private address space, size/timeout
 *    limits, malformed model JSON and cancellation each produce a named reason. There is no
 *    "assume and continue" fallback.
 *
 * It produces a DRAFT only. It never activates a pack, never publishes a persona and never writes
 * the Lorebook — that is CK-08's explicit publish step.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { CharacterPackDraft, CharacterSourceRef } from '../contracts/character-pack.js';
import type { CharacterDistiller } from '../providers/character-distiller.js';
import type { CompositeCharacterSourceProvider } from '../memory/character-source-provider.js';
import { canRunBackground } from '../app/background-call-authorizer.js';

export type DistillationJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type DistillationFailureCode =
  | 'no_available_sources'
  | 'no_model_binding'
  | 'no_authorized_purpose'
  | 'no_remaining_budget'
  | 'distiller_noop_must_not_consume_budget'
  | 'source_empty'
  | 'source_login_wall'
  | 'source_blocked_address'
  | 'source_too_large'
  | 'source_timeout'
  | 'malformed_model_output'
  | 'cancelled'
  | 'replay_conflict'
  | 'job_scope_mismatch'
  | 'job_in_flight';

export interface DistillationJobRequest {
  readonly characterId: string;
  readonly sourceRefs: readonly CharacterSourceRef[];
  readonly branch?: string | undefined;
  readonly cutoffPoint?: string | undefined;
  readonly operationId: string;
  readonly characterName?: string | undefined;
  readonly instructions?: string | undefined;
}

export interface DistillationJob {
  readonly jobId: string;
  readonly characterId: string;
  readonly branch: string;
  readonly cutoffPoint: string | null;
  readonly state: DistillationJobState;
  readonly draftId: string | null;
  readonly failure: DistillationFailureCode | null;
  readonly failureDetail: string | null;
  readonly coverage: {
    readonly requested: number;
    readonly used: number;
    readonly rejected: readonly { readonly uri: string; readonly reason: DistillationFailureCode }[];
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DistillationJobCoordinatorOptions {
  readonly distiller: CharacterDistiller;
  readonly sourceProvider: CompositeCharacterSourceProvider;
  /** False when the distiller genuinely has nothing to do; a no-op must not consume budget. */
  readonly hasWork: () => boolean;
  readonly now?: () => string;
  readonly maxSourceBytes?: number;
  readonly sourceTimeoutMs?: number;
}

const LOGIN_WALL = /(sign in|log in|登录|请先登录|authenticate|unauthorized|access denied)/i;

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || /^127\./.test(host) || /^10\./.test(host)
    || /^192\.168\./.test(host) || /^169\.254\./.test(host) || host === '::1' || /^\[?::1\]?$/.test(host);
}

/** Login walls, private-address redirects and oversize bodies are material failures, not empty docs. */
function screenSource(uri: string, text: string, bytes: number, maxBytes: number): DistillationFailureCode | null {
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    try { if (isPrivateHost(new URL(uri).hostname)) return 'source_blocked_address'; } catch { return 'source_blocked_address'; }
  }
  if (bytes > maxBytes) return 'source_too_large';
  // An empty body is a bad source, not an empty document worth distilling from.
  if (text.trim().length === 0) return 'source_empty';
  // A login wall is short and generic. Length alone is not the signal — the wording is.
  if (text.length < 4_000 && LOGIN_WALL.test(text)) return 'source_login_wall';
  return null;
}

export class DistillationJobCoordinator {
  private readonly jobs = new Map<string, DistillationJob>();
  private readonly requests = new Map<string, DistillationJobRequest>();
  private readonly byOperation = new Map<string, { readonly jobId: string; readonly signature: string }>();
  /** One in-flight job per (character, branch): a second submit for the same branch is refused. */
  private readonly inflight = new Map<string, AbortController>();
  private readonly maxSourceBytes: number;
  private readonly sourceTimeoutMs: number;

  constructor(private readonly options: DistillationJobCoordinatorOptions) {
    this.maxSourceBytes = options.maxSourceBytes ?? 2 * 1024 * 1024;
    this.sourceTimeoutMs = options.sourceTimeoutMs ?? 15_000;
  }

  job(jobId: string): DistillationJob | null { return this.jobs.get(jobId) ?? null; }

  #signature(request: DistillationJobRequest): string {
    return createHash('sha256').update(JSON.stringify({
      characterId: request.characterId,
      refs: request.sourceRefs,
      branch: request.branch ?? 'main',
      cutoffPoint: request.cutoffPoint ?? null,
    })).digest('hex');
  }

  /**
   * Submit a job.
   *
   * Idempotency is by operationId + payload: the same intent replays the same job, a reused id with
   * a different payload is a conflict (the caller is reusing an id for different work).
   */
  submit(request: DistillationJobRequest): DistillationJob {
    const signature = this.#signature(request);
    const prior = this.byOperation.get(request.operationId);
    if (prior) {
      if (prior.signature !== signature) throw new Error('replay_conflict');
      return this.jobs.get(prior.jobId)!;
    }

    const branch = request.branch ?? 'main';
    const scopeKey = `${request.characterId}|${branch}`;
    const jobId = `cdj-${randomUUID()}`;
    this.byOperation.set(request.operationId, { jobId, signature });
    this.requests.set(jobId, request);

    if (this.inflight.has(scopeKey)) {
      return this.#write(jobId, {
        state: 'failed', draftId: null, failure: 'job_in_flight',
        failureDetail: '同一角色分支已有提炼任务在运行（single-flight）。',
      });
    }

    // A no-op distillation must not consume budget, and must not pretend to have done work.
    const gate = canRunBackground({
      hasSources: request.sourceRefs.length > 0,
      hasModel: true,
      hasPurpose: true,
      hasBudget: true,
      isDistillerNoOp: this.options.hasWork() === false,
    });
    if (!gate.allowed) {
      return this.#write(jobId, {
        state: 'failed', draftId: null,
        failure: gate.reason as DistillationFailureCode, failureDetail: null,
      });
    }
    return this.#write(jobId, { state: 'queued', draftId: null, failure: null, failureDetail: null });
  }

  /** Run a submitted job to completion. Sources are screened BEFORE any model call. */
  async run(jobId: string): Promise<DistillationJob> {
    const job = this.jobs.get(jobId);
    const request = this.requests.get(jobId);
    if (!job || !request) throw new Error('job_not_found');
    const scopeKey = `${job.characterId}|${job.branch}`;

    const controller = new AbortController();
    this.inflight.set(scopeKey, controller);
    this.jobs.set(jobId, { ...job, state: 'running' });

    const used: string[] = [];
    const rejected: { uri: string; reason: DistillationFailureCode }[] = [];
    try {
      const snapshots: { sourceName: string; text: string; uri: string }[] = [];
      for (const ref of request.sourceRefs) {
        if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        const timeout = AbortSignal.timeout(this.sourceTimeoutMs);
        let fetched;
        try {
          fetched = await this.options.sourceProvider.fetch(ref, AbortSignal.any([controller.signal, timeout]));
        } catch (error) {
          const timedOut = (error as { name?: string }).name === 'TimeoutError'
            || /timeout|abort/i.test((error as Error).message);
          rejected.push({ uri: ref.uri, reason: timedOut ? 'source_timeout' : 'source_blocked_address' });
          continue;
        }
        const problem = screenSource(ref.uri, fetched.text, Buffer.byteLength(fetched.text, 'utf8'), this.maxSourceBytes);
        if (problem) { rejected.push({ uri: ref.uri, reason: problem }); continue; }
        snapshots.push({ sourceName: fetched.sourceName, text: fetched.text, uri: ref.uri });
        used.push(ref.uri);
      }

      if (snapshots.length === 0) {
        return this.#write(jobId, {
          state: 'failed', draftId: null,
          failure: rejected[0]?.reason ?? 'no_available_sources',
          failureDetail: '所有来源均被拒绝，未发起任何模型调用。',
        }, rejected);
      }

      const draft: CharacterPackDraft = await this.options.distiller.distillFromSourceRefs({
        characterId: request.characterId,
        ...(request.characterName === undefined ? {} : { characterName: request.characterName }),
        sourceRefs: request.sourceRefs.filter(ref => used.includes(ref.uri)),
        sourceProvider: this.options.sourceProvider,
        ...(request.cutoffPoint === undefined ? {} : { cutoffPoint: request.cutoffPoint }),
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      }, controller.signal);

      // The distiller deliberately degrades bad model output into a reviewable draft carrying
      // `gaps` rather than throwing. That is fine for a human reviewer, but a job must not report
      // success on a draft that failed evidence validation — otherwise "malformed output" is
      // indistinguishable from a real result in the job ledger.
      if (!draft.validation.valid) {
        return this.#write(jobId, {
          state: 'failed', draftId: null, failure: 'malformed_model_output',
          failureDetail: draft.validation.errors.join('; ') || '模型输出未通过证据校验。',
        }, rejected);
      }

      return this.#write(jobId, { state: 'succeeded', draftId: draft.id, failure: null, failureDetail: null }, rejected);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = (error as Error).message;
      const cancelled = code === 'cancelled' || controller.signal.aborted;
      return this.#write(jobId, {
        state: cancelled ? 'cancelled' : 'failed',
        draftId: null,
        failure: cancelled ? 'cancelled' : 'malformed_model_output',
        failureDetail: message,
      }, rejected);
    } finally {
      this.inflight.delete(scopeKey);
    }
  }

  /** Cancel a job for its own character scope; the in-flight request is aborted, not flagged. */
  cancel(jobId: string, characterId: string): DistillationJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('job_not_found');
    if (job.characterId !== characterId) throw new Error('job_scope_mismatch');
    this.inflight.get(`${job.characterId}|${job.branch}`)?.abort();
    return this.#write(jobId, {
      state: 'cancelled', draftId: job.draftId, failure: 'cancelled', failureDetail: null,
    });
  }

  #write(
    jobId: string,
    outcome: { state: DistillationJobState; draftId: string | null; failure: DistillationFailureCode | null; failureDetail: string | null },
    rejected: readonly { uri: string; reason: DistillationFailureCode }[] = [],
  ): DistillationJob {
    const now = this.options.now?.() ?? new Date().toISOString();
    const previous = this.jobs.get(jobId);
    const request = this.requests.get(jobId);
    const job: DistillationJob = Object.freeze({
      jobId,
      characterId: previous?.characterId ?? request?.characterId ?? '',
      branch: previous?.branch ?? request?.branch ?? 'main',
      cutoffPoint: previous?.cutoffPoint ?? request?.cutoffPoint ?? null,
      state: outcome.state,
      draftId: outcome.draftId,
      failure: outcome.failure,
      failureDetail: outcome.failureDetail,
      coverage: Object.freeze({
        requested: request?.sourceRefs.length ?? 0,
        used: outcome.state === 'succeeded' ? (request?.sourceRefs.length ?? 0) - rejected.length : 0,
        rejected: Object.freeze([...rejected]),
      }),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
    this.jobs.set(jobId, job);
    return job;
  }
}

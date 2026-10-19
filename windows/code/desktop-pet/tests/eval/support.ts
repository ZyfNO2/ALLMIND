// EVAL-00: shared evaluation harness.
//
// This module owns the evidence contract every suite writes through: a deterministic manifest,
// nearest-rank quantiles over an explicit valid-sample denominator, and a result envelope that
// keeps PASS / FAIL / BLOCKED / NOT_RUN distinct so a missing capability can never be summarized
// into a passing number. It performs no network, device, or user-database access by itself.
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type EvalStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
export type EvidenceLevel = 'L1_deterministic' | 'L2_production_wiring' | 'L3_real_end_to_end';
export type EvalSuite = 'memory' | 'retrieval' | 'latency' | 'robustness';

export interface EvalMetric {
  readonly name: string;
  /** null means "no valid denominator"; it is never silently coerced to 0. */
  readonly value: number | null;
  readonly unit: string;
  readonly numerator?: number;
  readonly denominator?: number;
  readonly definition: string;
}

export interface EvalCase {
  readonly caseId: string;
  readonly status: EvalStatus;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly evidenceRefs: readonly string[];
  readonly error?: string;
}

export interface EvalSuiteResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly suite: EvalSuite;
  readonly evidenceLevel: EvidenceLevel;
  readonly codeRevision: string;
  readonly fixtureHash: string;
  readonly policySnapshot: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: EvalStatus;
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly excluded: number;
  readonly exclusions: readonly string[];
  readonly metrics: readonly EvalMetric[];
  readonly cases: readonly EvalCase[];
  /**
   * False while the run is still in progress. A killed or crashed run therefore keeps its collected
   * evidence but is never mistakable for a completed suite, even when everything recorded so far
   * happened to pass.
   */
  readonly complete: boolean;
  /**
   * Per-item measurements that do NOT drive the suite status. A single missed query inside a met
   * pre-registered target is data, not a suite failure, and is kept here so it stays visible
   * without being able to flip a passing suite to FAIL or hide a failing one behind an average.
   */
  readonly observations?: readonly { readonly id: string; readonly hit: boolean; readonly detail: unknown }[];
}

/** A case that cannot run because the capability under test is absent from the product. */
export class EvalBlocked extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'EvalBlocked';
  }
}

/**
 * Nearest-rank percentile. The plan freezes this definition: sort ascending, take index
 * ceil(p*n)-1. An empty sample yields null rather than a fabricated 0.
 */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  if (!(p > 0 && p <= 1)) throw new Error(`invalid_percentile:${p}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]!;
}

export function mean(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

export function summarize(samples: readonly number[]): { readonly n: number; readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly mean: number | null } {
  return {
    n: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples.length ? Math.max(...samples) : null,
    mean: mean(samples),
  };
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface EvalRunContext {
  readonly runId: string;
  readonly outputDirectory: string;
  readonly codeRevision: string;
  readonly suite: EvalSuite;
  readonly evidenceLevel: EvidenceLevel;
  readonly fixtureHash: string;
  readonly policySnapshot: Readonly<Record<string, unknown>>;
}

export function createRunContext(suite: EvalSuite, outputDirectory: string, options: { readonly evidenceLevel?: EvidenceLevel; readonly codeRevision?: string; readonly fixtureHash?: string; readonly policySnapshot?: Record<string, unknown>; readonly runId?: string } = {}): EvalRunContext {
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const runId = options.runId ?? `${suite}-${startedAt.replace(/[:.]/g, '-')}`;
  return {
    runId,
    outputDirectory: directory,
    codeRevision: options.codeRevision ?? 'unknown',
    suite,
    evidenceLevel: options.evidenceLevel ?? 'L1_deterministic',
    fixtureHash: options.fixtureHash ?? 'none',
    policySnapshot: options.policySnapshot ?? {},
  };
}

/**
 * Accumulates cases and metrics for one suite, then writes the frozen envelope. Cases run through
 * `step` so a thrown error becomes a FAIL with its first error preserved rather than aborting the
 * whole suite; EvalBlocked is reserved for a missing product capability and maps to BLOCKED.
 */
export class EvalRecorder {
  readonly #cases: EvalCase[] = [];
  readonly #metrics: EvalMetric[] = [];
  readonly #observations: { id: string; hit: boolean; detail: unknown }[] = [];
  readonly #events: string[] = [];
  readonly #exclusions: string[] = [];
  #failed = 0;
  #blocked = 0;
  #cancelled = 0;

  constructor(private readonly context: EvalRunContext) {}

  get runId(): string { return this.context.runId; }
  get outputDirectory(): string { return this.context.outputDirectory; }

  event(caseId: string, event: string, monotonicMs: number, detail: Record<string, unknown> = {}): void {
    const line = JSON.stringify({
      runId: this.context.runId, caseId, event, monotonicMs,
      clockDomain: 'process-monotonic', processId: process.pid,
      at: new Date().toISOString(), ...detail,
    });
    this.#events.push(line);
  }

  exclude(caseId: string, reason: string): void {
    this.#exclusions.push(`${caseId}: ${reason}`);
  }

  record(caseId: string, status: EvalStatus, expected: unknown, actual: unknown, evidenceRefs: readonly string[] = []): void {
    if (status === 'FAIL' || status === 'BLOCKED') this.#failed += 1;
    if (status === 'BLOCKED') this.#blocked += 1;
    const entry: EvalCase = { caseId, status, expected, actual, evidenceRefs: [...evidenceRefs] };
    this.#cases.push(Object.freeze(entry));
    this.persist();
  }

  /**
   * Writes the current envelope immediately after each case. Evidence must survive a later crash,
   * and an interrupted run must never be mistakable for a completed PASS.
   */
  private persist(): void {
    const partial: EvalSuiteResult = {
      schemaVersion: 1,
      runId: this.context.runId,
      suite: this.context.suite,
      evidenceLevel: this.context.evidenceLevel,
      codeRevision: this.context.codeRevision,
      fixtureHash: this.context.fixtureHash,
      policySnapshot: this.context.policySnapshot,
      startedAt: this.#startedAt,
      finishedAt: new Date().toISOString(),
      status: 'NOT_RUN',
      complete: false,
      attempted: this.#cases.length + this.#exclusions.length,
      completed: this.#cases.length,
      failed: this.#failed,
      cancelled: this.#cancelled,
      excluded: this.#exclusions.length,
      exclusions: [...this.#exclusions],
      metrics: [...this.#metrics],
      cases: [...this.#cases],
      observations: [...this.#observations],
    };
    this.#write(partial);
  }

  /** Runs one case, converting thrown errors into a recorded FAIL/BLOCKED with the first error kept. */
  async step(caseId: string, expected: unknown, body: () => Promise<unknown> | unknown, evidenceRefs: readonly string[] = []): Promise<EvalStatus> {
    this.event(caseId, 'case_start', 0);
    try {
      const actual = await body();
      this.record(caseId, 'PASS', expected, actual, evidenceRefs);
      return 'PASS';
    } catch (error) {
      if (error instanceof EvalBlocked) {
        this.record(caseId, 'BLOCKED', expected, { blocked: error.reason }, evidenceRefs);
        return 'BLOCKED';
      }
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const entry: EvalCase = { caseId, status: 'FAIL', expected, actual: null, evidenceRefs: [...evidenceRefs], error: message };
      this.#cases.push(Object.freeze(entry));
      this.#failed += 1;
      return 'FAIL';
    }
  }

  metric(metric: EvalMetric): void {
    this.#metrics.push(Object.freeze(metric));
  }

  /** Records a per-item measurement that must never influence the suite status. */
  observe(id: string, hit: boolean, detail: unknown): void {
    this.#observations.push(Object.freeze({ id, hit, detail }));
  }

  /** A ratio metric returns value=null when its denominator is zero instead of a misleading 0 or 1. */
  ratio(name: string, numerator: number, denominator: number, unit: string, definition: string): void {
    this.metric({ name, value: denominator === 0 ? null : numerator / denominator, unit, numerator, denominator, definition });
  }

  get blockedCount(): number { return this.#blocked; }
  get caseCount(): number { return this.#cases.length; }

  /**
   * Derives the suite status from the recorded cases. A suite that recorded nothing is NOT_RUN;
   * a suite whose only failures are BLOCKED is BLOCKED; any other failure is FAIL. A capability
   * that is merely absent can therefore never be summarized as PASS.
   */
  get derivedStatus(): EvalStatus {
    if (this.#cases.length === 0) return 'NOT_RUN';
    if (this.#failed === 0) return 'PASS';
    return this.#blocked === this.#failed ? 'BLOCKED' : 'FAIL';
  }

  finish(): EvalSuiteResult {
    const status = this.derivedStatus;
    this.#finalized = true;
    const result: EvalSuiteResult = {
      schemaVersion: 1,
      runId: this.context.runId,
      suite: this.context.suite,
      evidenceLevel: this.context.evidenceLevel,
      codeRevision: this.context.codeRevision,
      fixtureHash: this.context.fixtureHash,
      policySnapshot: this.context.policySnapshot,
      startedAt: this.#startedAt,
      finishedAt: new Date().toISOString(),
      status,
      complete: true,
      attempted: this.#cases.length + this.#exclusions.length,
      completed: this.#cases.length,
      failed: this.#failed,
      cancelled: this.#cancelled,
      excluded: this.#exclusions.length,
      exclusions: [...this.#exclusions],
      metrics: [...this.#metrics],
      cases: [...this.#cases],
      observations: [...this.#observations],
    };
    this.#write(result);
    return result;
  }

  readonly #startedAt = new Date().toISOString();
  #finalized = false;

  /**
   * Finalizes the envelope on process exit even when a test crashed or the process was killed
   * mid-suite. Without this, a crashed run leaves an envelope whose status is still the initial
   * NOT_RUN placeholder and the collected evidence would be silently discarded.
   */
  installExitGuard(): void {
    const guard = () => { if (!this.#finalized) { try { this.finish(); } catch { /* best effort */ } } };
    process.once('exit', guard);
  }

  #write(result: EvalSuiteResult): void {
    writeFileSync(join(this.context.outputDirectory, `eval_${this.context.suite}.json`), `${JSON.stringify(result, null, 2)}\n`);
    if (this.#events.length) {
      appendFileSync(join(this.context.outputDirectory, 'events.jsonl'), `${this.#events.join('\n')}\n`);
      this.#events.length = 0;
    }
  }
}

export interface EnvironmentManifest {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpus: number;
  readonly totalMemoryBytes: number;
  readonly sqlite: string | null;
  readonly gitRevision: string | null;
  readonly workingTreeDirty: boolean | null;
}

/** Collects the run environment. It deliberately records no key, endpoint credential, or personal data. */
export function collectEnvironment(sqliteVersion: string | null, git: { readonly revision: string | null; readonly dirty: boolean | null }): EnvironmentManifest {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    totalMemoryBytes: totalmem(),
    sqlite: sqliteVersion,
    gitRevision: git.revision,
    workingTreeDirty: git.dirty,
  };
}

export function writeJson(directory: string, filename: string, value: unknown): string {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

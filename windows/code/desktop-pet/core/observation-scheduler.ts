import { randomUUID } from 'node:crypto';
import type { PairingScope } from '../contracts/character-pack.js';
import type { RuntimeContinuousPerceptionGrant } from '../contracts/companion-mode.js';
import type { ScreenCaptureSource, ScreenTarget } from './screen-capture-source.js';
import type { createLocalOcrEngine } from './local-ocr-engine.js';

export interface ObservationItem {
  readonly observationId: string;
  readonly pairing?: PairingScope;
  readonly targetId: string;
  readonly targetRevision?: number;
  readonly grantId?: string;
  readonly grantRevision?: number;
  readonly capturedAt: string;
  readonly expiresAt?: string;
  readonly recognitionRoute?: 'local-ocr';
  readonly text: string;
  readonly blockCount: number;
}

export type ObservationOutcome =
  | { readonly status: 'recognized'; readonly observation: ObservationItem }
  | { readonly status: 'no-content' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export interface ObservationSchedulerOptions {
  readonly pairing: PairingScope;
  readonly captureSource: ScreenCaptureSource;
  readonly ocrEngine: ReturnType<typeof createLocalOcrEngine>;
  readonly onObservation?: (item: ObservationItem) => void;
  readonly now?: () => string;
}

export class ObservationScheduler {
  private readonly pairing: PairingScope;
  private readonly captureSource: ScreenCaptureSource;
  private readonly ocrEngine: ReturnType<typeof createLocalOcrEngine>;
  private readonly onObservation?: ((item: ObservationItem) => void) | undefined;
  private readonly now: () => string;
  private isBusy = false;
  private currentGrant: RuntimeContinuousPerceptionGrant | null = null;
  private currentTarget: ScreenTarget | null = null;
  private activeController: AbortController | null = null;
  private currentTask: Promise<ObservationOutcome | null> | null = null;

  constructor(options: ObservationSchedulerOptions) {
    this.pairing = options.pairing;
    this.captureSource = options.captureSource;
    this.ocrEngine = options.ocrEngine;
    this.onObservation = options.onObservation;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  setContext(grant: RuntimeContinuousPerceptionGrant | null, target: ScreenTarget | null): void {
    if (grant && !samePairing(grant.pairing, this.pairing)) throw new Error('grant_pairing_mismatch');
    if (grant && target && (grant.targetId !== target.targetId || grant.targetRevision !== target.targetRevision
      || grant.bounds.x !== target.bounds.x || grant.bounds.y !== target.bounds.y
      || grant.bounds.width !== target.bounds.width || grant.bounds.height !== target.bounds.height)) {
      throw new Error('grant_target_mismatch');
    }
    if (this.isBusy && (grant?.grantId !== this.currentGrant?.grantId || target?.targetId !== this.currentTarget?.targetId)) {
      void this.cancel();
    }
    this.currentGrant = grant;
    this.currentTarget = target;
  }

  get inFlight(): boolean { return this.isBusy; }

  /** Periodic scheduler tick; missed or busy ticks are not queued. */
  async tick(signal?: AbortSignal): Promise<ObservationOutcome | null> {
    if (this.isBusy || !this.currentGrant || this.currentGrant.state !== 'active'
      || !this.currentTarget || !this.currentTarget.isValid || signal?.aborted) return null;
    return this.#runObservation(signal);
  }

  /** User or console explicit trigger. operationId is consumed by the durable trigger owner in RWR-10-06. */
  async observeNow(_operationId: string = randomUUID(), signal?: AbortSignal): Promise<ObservationOutcome | null> {
    if (this.isBusy) throw new Error('observation_busy');
    if (!this.currentGrant || this.currentGrant.state !== 'active') throw new Error('observation_not_authorized');
    if (!this.currentTarget || !this.currentTarget.isValid) throw new Error('target_invalid');
    if (signal?.aborted) return null;
    return this.#runObservation(signal);
  }

  /** Abort the current hook and wait for its promise to settle before reporting released. */
  async cancel(): Promise<void> {
    const task = this.currentTask;
    this.activeController?.abort();
    if (task) await task.catch(() => null);
  }

  #runObservation(externalSignal?: AbortSignal): Promise<ObservationOutcome | null> {
    const grant = this.currentGrant;
    const target = this.currentTarget;
    if (!grant || !target) return Promise.resolve(null);
    this.isBusy = true;
    const controller = new AbortController();
    this.activeController = controller;
    const abortFromCaller = () => controller.abort();
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });

    const task = this.#executeObservation(grant, target, controller.signal)
      .catch((error: unknown): ObservationOutcome | null => {
        if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return null;
        const code = error instanceof Error ? error.message : '';
        if (code === 'capture_unavailable' || code === 'local_perception_engine_unavailable') {
          return { status: 'unavailable', reason: code };
        }
        return { status: 'failed', reason: safeReason(code) };
      })
      .finally(() => {
        externalSignal?.removeEventListener('abort', abortFromCaller);
        this.isBusy = false;
        if (this.activeController === controller) this.activeController = null;
        if (this.currentTask === task) this.currentTask = null;
      });
    this.currentTask = task;
    return task;
  }

  async #executeObservation(
    grant: RuntimeContinuousPerceptionGrant,
    target: ScreenTarget,
    signal: AbortSignal,
  ): Promise<ObservationOutcome | null> {
    let frame: Awaited<ReturnType<ScreenCaptureSource['capture']>> | null = null;
    try {
      frame = await this.captureSource.capture(target, signal);
      if (signal.aborted) return null;
      if (!frame || frame.bytes.length === 0) return { status: 'failed', reason: 'empty_frame' };
      const ocr = await this.ocrEngine(frame.bytes, signal);
      if (signal.aborted) return null;
      if (ocr.status === 'unavailable') return { status: 'unavailable', reason: ocr.reason ?? 'pixel_ocr_unavailable' };
      if (ocr.status === 'failed') return { status: 'failed', reason: ocr.reason ?? 'pixel_ocr_failed' };
      const text = ocr.readingOrderText.trim();
      if (!text) return { status: 'no-content' };

      const capturedAt = frame.capturedAt;
      const item: ObservationItem = {
        observationId: `obs-${randomUUID()}`,
        pairing: this.pairing,
        targetId: frame.targetId,
        targetRevision: frame.targetRevision,
        grantId: grant.grantId,
        grantRevision: grant.revision,
        capturedAt,
        expiresAt: new Date(Date.parse(capturedAt) + 120_000).toISOString(),
        recognitionRoute: 'local-ocr',
        text,
        blockCount: ocr.blocks.length,
      };
      if (signal.aborted) return null;
      this.onObservation?.(item);
      return { status: 'recognized', observation: item };
    } finally {
      // Native hooks own native handle disposal. Drop our frame reference and scrub its byte buffer after OCR.
      frame?.bytes.fill(0);
      frame = null;
    }
  }
}

function safeReason(value: string): string {
  return /^[a-z0-9_-]{1,80}$/i.test(value) ? value : 'observation_failed';
}
function samePairing(a: PairingScope, b: PairingScope): boolean {
  return a.userId === b.userId && a.characterId === b.characterId && a.characterInstanceId === b.characterInstanceId;
}

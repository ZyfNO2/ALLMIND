/**
 * core/windows-screen-capture.ts
 *
 * CK-11: the production `captureHook`.
 *
 * Before this, `ScreenCaptureSource` was constructed in `trial-backend.ts` with **no** hook, so
 * every production capture threw `capture_unavailable`. The adapters existed and every one of them
 * lived in a test. This module is the missing edge: it turns a host capture response into a
 * `CapturedFrame`, and — just as importantly — it turns every failure into a named reason instead
 * of a silent empty frame.
 *
 * It also enforces the frozen budgets rather than the looser defaults: a continuous observation
 * frame is capped at **1.5 MiB** (TESTING §2.1 / CONTRACTS §7), not the 20 MiB document limit.
 * A frame over the ceiling is refused, never compressed into something that lies about its size.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { CapturedFrame, ScreenTarget } from './screen-capture-source.js';
import { captureHostScreenTarget, type DesktopHostBridge } from '../app/desktop-host-bridge.js';
import {
  isHostCaptureResult,
  type HostCaptureRequest,
  type HostCaptureResult,
  type HostScreenTargetKind,
} from '../contracts/desktop-host-capture.js';

/** CONTRACTS §7: continuous observation frames are bounded at 1.5 MiB, not 20 MiB. */
export const CONTINUOUS_FRAME_MAX_BYTES = 1_500_000;

export type CaptureUnavailableReason =
  | 'host_bridge_missing'
  | 'target_kind_unsupported'
  | 'capture_denied'
  | 'target_invalidated'
  | 'host_unavailable'
  | 'frame_too_large'
  | 'malformed_host_response';

export class HostCaptureError extends Error {
  constructor(readonly reason: CaptureUnavailableReason, message: string) {
    super(message);
    this.name = 'HostCaptureError';
  }
}

export interface WindowsScreenCaptureOptions {
  readonly bridge?: DesktopHostBridge | undefined;
  readonly maxBytes?: number;
  readonly now?: () => string;
  /** Test seam. Production goes through the host bridge. */
  readonly requestHostCapture?: (request: HostCaptureRequest) => Promise<unknown>;
}

export interface CaptureAvailability {
  readonly available: boolean;
  readonly reason: CaptureUnavailableReason | null;
  readonly detail: string | null;
}

/** What the console shows. It is derived from real wiring, never from a credential existing. */
export function captureAvailability(options: WindowsScreenCaptureOptions): CaptureAvailability {
  if (options.requestHostCapture) return { available: true, reason: null, detail: null };
  if (!options.bridge) {
    return { available: false, reason: 'host_bridge_missing', detail: '当前运行实例没有接入桌宠宿主，无法进行真实屏幕捕获。' };
  }
  // CK-11 fix: a bridge alone is not enough. `available` used to be true whenever an object was
  // passed, which is how the console reported a working capture route while every capture threw.
  // The check now asks the bridge for the one method the route actually calls.
  const runtime = options.bridge as unknown as { request?: unknown };
  if (typeof runtime.request !== 'function') {
    return { available: false, reason: 'host_bridge_missing', detail: '桌宠宿主没有实现捕获请求，无法进行真实屏幕捕获。' };
  }
  return { available: true, reason: null, detail: null };
}

export class WindowsScreenCapture {
  private readonly maxBytes: number;
  private readonly now: () => string;
  private inFlight = 0;

  constructor(private readonly options: WindowsScreenCaptureOptions = {}) {
    this.maxBytes = options.maxBytes ?? CONTINUOUS_FRAME_MAX_BYTES;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Live in-flight count; a correct shutdown brings this to zero. */
  get outstanding(): number { return this.inFlight; }

  /**
   * Build the `captureHook` a `ScreenCaptureSource` can consume.
   *
   * The hook takes only a trusted target. It cannot accept bytes from a caller, so a browser
   * screenshot can never be laundered in as a host capture result.
   */
  hook(): (target: ScreenTarget, signal?: AbortSignal) => Promise<CapturedFrame | null> {
    return (target, signal) => this.capture(target, signal);
  }

  async capture(target: ScreenTarget, signal?: AbortSignal): Promise<CapturedFrame | null> {
    if (signal?.aborted) throw Object.assign(new Error('Capture aborted'), { name: 'AbortError' });

    // Only the three frozen kinds are capturable; an unknown kind is refused, never coerced to screen.
    const kind = target.kind as HostScreenTargetKind;
    if (kind !== 'screen' && kind !== 'window' && kind !== 'region') {
      throw new HostCaptureError('target_kind_unsupported', `不支持的捕获目标类型：${String(target.kind)}`);
    }
    const availability = captureAvailability(this.options);
    if (!availability.available) {
      throw new HostCaptureError('host_bridge_missing', availability.detail ?? '宿主捕获能力不可用。');
    }

    const request: HostCaptureRequest = {
      operationId: `capture-${randomUUID()}`,
      targetId: target.targetId,
      targetRevision: target.targetRevision,
      targetKind: kind,
      maxBytes: this.maxBytes,
      mimeType: 'image/png',
    };

    this.inFlight += 1;
    let raw: unknown;
    try {
      raw = await this.#ask(request, signal);
    } finally {
      this.inFlight -= 1;
    }

    if (signal?.aborted) throw Object.assign(new Error('Capture aborted'), { name: 'AbortError' });
    if (raw === null || raw === undefined) {
      throw new HostCaptureError('host_unavailable', '宿主没有返回屏幕帧。');
    }
    if (!isHostCaptureResult(raw)) {
      throw new HostCaptureError('malformed_host_response', '宿主返回了无法识别的捕获结果。');
    }
    const result = raw as HostCaptureResult;

    if (result.outcome === 'denied') {
      throw new HostCaptureError('capture_denied', result.reason ?? '屏幕捕获授权被拒绝。');
    }
    if (result.outcome === 'invalidated') {
      throw new HostCaptureError('target_invalidated', result.reason ?? '捕获目标已失效。');
    }
    if (result.outcome === 'unavailable') {
      throw new HostCaptureError('host_unavailable', result.reason ?? '宿主当前无法捕获该目标。');
    }

    const bytes = Buffer.from(String(result.bytesBase64), 'base64');
    if (bytes.length === 0) {
      throw new HostCaptureError('malformed_host_response', '宿主返回了空的像素数据。');
    }
    // The frozen budget is a ceiling, not a suggestion: an over-budget frame is refused outright.
    if (bytes.length > this.maxBytes) {
      bytes.fill(0);
      throw new HostCaptureError('frame_too_large', `捕获帧 ${bytes.length} 字节超过 ${this.maxBytes} 上限。`);
    }
    // The frame must actually belong to the target that was asked for.
    if (result.targetId !== target.targetId || result.targetRevision !== target.targetRevision) {
      bytes.fill(0);
      throw new HostCaptureError('malformed_host_response', '宿主返回的帧与请求的目标不一致。');
    }

    return Object.freeze({
      targetId: target.targetId,
      targetRevision: target.targetRevision,
      capturedAt: result.capturedAt || this.now(),
      mimeType: (result.mimeType ?? 'image/png') as 'image/png' | 'image/bmp',
      dimensions: Object.freeze({ ...result.dimensions! }),
      bytes: new Uint8Array(bytes),
    });
  }

  /** A stable digest of a frame, used for dedup and for proving "these are the same pixels". */
  static frameDigest(frame: CapturedFrame): string {
    return createHash('sha256').update(frame.bytes).digest('hex');
  }

  async #ask(request: HostCaptureRequest, signal?: AbortSignal): Promise<unknown> {
    if (this.options.requestHostCapture) return this.options.requestHostCapture(request);
    const bridge = this.options.bridge;
    if (!bridge) throw new HostCaptureError('host_bridge_missing', '当前运行实例没有接入桌宠宿主。');
    if (signal?.aborted) throw Object.assign(new Error('Capture aborted'), { name: 'AbortError' });
    // CK-11 fix: the old code duck-typed `runtime.hostRequest`, which DesktopHostBridge never
    // exposed. Route through its typed capture helper so method-union validation, requestId
    // correlation, and the actual request method cannot drift apart again.
    return captureHostScreenTarget(bridge, request);
  }
}

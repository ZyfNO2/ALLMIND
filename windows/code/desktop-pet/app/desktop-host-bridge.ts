/**
 * app/desktop-host-bridge.ts — RWR-10-01
 *
 * Backend side of the host control channel. The management HTTP server lives in this same process, so it
 * calls `request()` directly; the message then travels over the existing NDJSON stdio pipe to the
 * Electron host, which answers with `host_reply`.
 *
 * RWR-10-00 established that no such channel existed before: the only requestId/ack pairing in the tree
 * (app/desktop-device-bridge.ts) is backend<->renderer for devices and appearance. This is the new,
 * deliberately tiny surface: two methods, a closed method union, and no way to name an arbitrary native
 * call.
 */
import { randomUUID } from 'node:crypto';
import {
  isDesktopHostMethod,
  operationSignature,
  type DesktopHostErrorCode,
  type DesktopHostMethod,
  type DesktopHostPreferences,
  type DesktopHostPatchInput,
  type DesktopHostPatchReceipt,
  type DesktopHostReply,
  type HostResourceSelection,
  type HostScreenTargetSelection,
  type ResourceSelectionKind,
  type ResourceSelectionType,
} from '../contracts/desktop-host.js';
import type { HostCaptureRequest, HostCaptureResult } from '../contracts/desktop-host-capture.js';

export interface DesktopHostFailure {
  readonly code: DesktopHostErrorCode;
  readonly message: string;
}

export class DesktopHostError extends Error {
  constructor(readonly code: DesktopHostErrorCode, message: string) { super(message); this.name = 'DesktopHostError'; }
}

export interface DesktopHostBridgeOptions {
  /** Writes one NDJSON line to the host. Production passes a stdout writer. */
  readonly send: (message: unknown) => void;
  /** Default request timeout. A disconnected host must fail fast rather than hang the HTTP request. */
  readonly timeoutMs?: number;
  /** Injection point for tests; defaults to the real clock. */
  readonly now?: () => number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/** How long an HTTP request waits for the host before it is reported unavailable. */
export const DEFAULT_HOST_TIMEOUT_MS = 15_000;

export class DesktopHostBridge {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private closed = false;
  /** Set while the host has not answered a single request; used to report `unsupported` honestly. */
  private sawHostReply = false;

  constructor(private readonly options: DesktopHostBridgeOptions) {
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? options.timeoutMs as number : DEFAULT_HOST_TIMEOUT_MS;
  }

  /** True once the host has answered at least one request in this process lifetime. */
  get hostAnswered(): boolean { return this.sawHostReply; }

  get inFlight(): number { return this.pending.size; }

  /**
   * Send one request and await its correlated reply. A reply for an unknown or already-settled
   * requestId is dropped, so a late answer can never settle a newer request.
   */
  async request<T>(method: DesktopHostMethod, params: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new DesktopHostError('unavailable', '桌宠宿主已断开，无法读写宿主设置。');
    if (!isDesktopHostMethod(method)) throw new DesktopHostError('unsupported', `不支持的宿主操作：${String(method)}`);
    const requestId = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DesktopHostError('unavailable', method==='chatgpt-page' ? '独立 ChatGPT 页面响应超时。请检查网络，并在登录面板完成登录后重试。' : '宿主没有响应，设置未保存。请确认桌宠仍在运行。'));
      }, method === 'resource-picker.select' ? Math.max(this.timeoutMs, 5 * 60_000) : method==='chatgpt-page' && (['login','navigate','probe','open-file'].includes(String(params.action))||params.action==='upload-image'&&(params.input as {done?:boolean}|undefined)?.done) ? Math.max(this.timeoutMs,65000) : this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
    });
    try { this.options.send({ channel: 'host_request', requestId, method, params }); }
    catch {
      this.settle(requestId, error => error(new DesktopHostError('unavailable', '无法把请求发送给桌宠宿主。')));
      return promise as Promise<T>;
    }
    return promise as Promise<T>;
  }

  /** Returns true when the message was a host reply this bridge owned. */
  receive(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const raw = value as Record<string, unknown>;
    if (raw.channel !== 'host_reply' || typeof raw.requestId !== 'string') return false;
    const pending = this.pending.get(raw.requestId);
    // An unknown requestId is a late or foreign reply. Dropping it keeps this bridge's correlation exact.
    if (!pending) return false;
    this.sawHostReply = true;
    if (raw.ok === true) {
      this.pending.delete(raw.requestId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(raw.result);
      return true;
    }
    const error = (raw.error ?? {}) as Record<string, unknown>;
    const code = typeof error.code === 'string' ? error.code as DesktopHostErrorCode : 'unavailable';
    const message = typeof error.message === 'string' && error.message ? error.message : '宿主设置未保存。';
    this.pending.delete(raw.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(new DesktopHostError(code, message));
    return true;
  }

  /** Reject every in-flight request. Called when the backend session closes. */
  close(): void {
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new DesktopHostError('unavailable', '桌宠宿主已断开。'));
      this.pending.delete(requestId);
    }
  }

  private settle(requestId: string, apply: (reject: (error: Error) => void) => void): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    apply(pending.reject);
  }
}

/** Narrow typed helpers so routes never assemble raw method strings. */
export const readHostPreferences = (bridge: DesktopHostBridge): Promise<DesktopHostPreferences> =>
  bridge.request<DesktopHostPreferences>('preferences.get', {});

export const patchHostPreferences = (bridge: DesktopHostBridge, input: DesktopHostPatchInput): Promise<DesktopHostPatchReceipt> =>
  bridge.request<DesktopHostPatchReceipt>('preferences.patch', {
    expectedRevision: input.expectedRevision,
    operationId: input.operationId,
    patch: input.patch,
    signature: operationSignature({ expectedRevision: input.expectedRevision, patch: input.patch }),
  });

/**
 * RWR-10-04: open the native chooser.
 *
 * The host owns `parent`, `filters` and every option, so the client cannot turn this into an arbitrary
 * directory browser or a window it does not own. `cancelled` is a normal answer, not an error.
 */
export const selectHostResource = (
  bridge: DesktopHostBridge,
  input: { characterId: string; type: ResourceSelectionType; selectionKind: ResourceSelectionKind },
): Promise<HostResourceSelection> =>
  bridge.request<HostResourceSelection>('resource-picker.select', { ...input });

export const selectHostScreenTarget = (
  bridge: DesktopHostBridge,
  input: { operationId: string; pairing: { userId: string; characterId: string; characterInstanceId: string } },
): Promise<HostScreenTargetSelection> =>
  bridge.request<HostScreenTargetSelection>('screen-target.select', { ...input });

/**
 * CK-11: ask the host for the pixels of a target IT issued.
 *
 * The request carries identity and a byte ceiling only. There is no parameter through which a caller
 * could supply an image, so this cannot be used to feed an arbitrary picture into the pipeline.
 */
export const captureHostScreenTarget = (
  bridge: DesktopHostBridge,
  request: HostCaptureRequest,
): Promise<HostCaptureResult> =>
  bridge.request<HostCaptureResult>('screen-target.capture', { ...request });

/**
 * RUX-02: ask the host to restart the managed backend. The host answers BEFORE the restart starts
 * (with the restart acknowledgment and its boot identity), then performs the bounded shutdown and
 * relaunch. If the host never answers, the promise rejects and the caller must NOT claim a restart
 * happened.
 */
export const requestHostRestart = (bridge: DesktopHostBridge): Promise<{ requestedAt: string }> =>
  bridge.request<{ requestedAt: string }>('app.restart', {});

export type { DesktopHostReply };

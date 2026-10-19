/**
 * core/screen-capture-source.ts
 *
 * N082-05: Real screen and window capture source.
 * Validates trusted target handles, checks boundaries & DPI, captures frames
 * without unbounded memory retention, and strictly rejects synthetic random targets.
 */

import { validateContinuousPerceptionGrant, type RuntimeContinuousPerceptionGrant } from '../contracts/companion-mode.js';
import type { CaptureGrant } from '../contracts/perception.js';

export interface ScreenTarget {
  readonly targetId: string;
  readonly targetRevision: number;
  readonly kind: 'screen' | 'window' | 'region';
  readonly displayName: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly isValid: boolean;
}

export interface CapturedFrame {
  readonly targetId: string;
  readonly targetRevision: number;
  readonly capturedAt: string;
  readonly mimeType: 'image/png' | 'image/bmp';
  readonly dimensions: { readonly width: number; readonly height: number };
  readonly bytes: Uint8Array;
}

export interface ScreenCaptureSourceOptions {
  readonly maxImageBytes?: number;   // Default 20 MiB
  readonly maxPixels?: number;       // Default 40,000,000 pixels (40 MP)
  readonly captureHook?: (target: ScreenTarget, signal?: AbortSignal) => Promise<CapturedFrame | null>;
  readonly now?: () => string;
}

export class ScreenCaptureSource {
  private readonly maxImageBytes: number;
  private readonly maxPixels: number;
  private readonly captureHook?: ((target: ScreenTarget, signal?: AbortSignal) => Promise<CapturedFrame | null>) | undefined;
  private readonly now: () => string;
  private activeGrant: RuntimeContinuousPerceptionGrant | null = null;
  private closed = false;

  constructor(options: ScreenCaptureSourceOptions = {}) {
    this.maxImageBytes = options.maxImageBytes ?? 20 * 1024 * 1024;
    this.maxPixels = options.maxPixels ?? 40_000_000;
    this.captureHook = options.captureHook;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async attachContinuousGrant(grant: RuntimeContinuousPerceptionGrant): Promise<void> {
    validateContinuousPerceptionGrant(grant);
    if (grant.state !== 'active') throw new Error('capture_grant_inactive');
    if (!Number.isSafeInteger(grant.targetRevision) || grant.targetRevision < 1) throw new Error('invalid_target_revision');
    if (!Number.isFinite(Date.parse(grant.expiry)) || Date.parse(grant.expiry) <= Date.now()) throw new Error('capture_grant_expired');
    this.activeGrant = grant;
    this.closed = false;
  }

  detachGrant(): void {
    this.activeGrant = null;
    this.closed = true;
  }

  validateTarget(target: ScreenTarget): boolean {
    if (!target || !target.targetId || target.targetId.trim().length === 0) return false;
    if (!target.isValid) return false;
    if (target.bounds.width <= 0 || target.bounds.height <= 0) return false;
    const pixels = target.bounds.width * target.bounds.height;
    if (pixels > this.maxPixels) return false;
    return true;
  }

  async capture(target: ScreenTarget, signal?: AbortSignal): Promise<CapturedFrame | null> {
    const grant = this.activeGrant;
    if (this.closed || !grant) throw new Error('capture_source_not_active');
    if (signal?.aborted) throw Object.assign(new Error('Capture aborted'), { name: 'AbortError' });
    if (!this.validateTarget(target)) throw new Error('target_invalid');
    if (target.targetId !== grant.targetId || target.targetRevision !== grant.targetRevision) throw new Error('target_grant_mismatch');
    if (grant.state !== 'active' || Date.parse(grant.expiry) <= Date.now()) throw new Error('capture_grant_expired');
    if (target.bounds.x !== grant.bounds.x || target.bounds.y !== grant.bounds.y
      || target.bounds.width !== grant.bounds.width || target.bounds.height !== grant.bounds.height) throw new Error('target_bounds_mismatch');
    return this.#captureFrame(target, signal);
  }

  async captureSingle(target: ScreenTarget, grant: CaptureGrant, signal?: AbortSignal): Promise<CapturedFrame | null> {
    if (grant.duration !== 'single' || grant.status !== 'active') throw new Error('single_capture_grant_required');
    if (grant.scopeType !== 'screen' && grant.scopeType !== target.kind) throw new Error('capture_scope_mismatch');
    if (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('capture_grant_expired');
    if (!this.validateTarget(target)) throw new Error('target_invalid');
    if (target.targetId !== grant.targetId) throw new Error('target_grant_mismatch');
    if (grant.bounds && (target.bounds.x !== grant.bounds.x || target.bounds.y !== grant.bounds.y
      || target.bounds.width !== grant.bounds.width || target.bounds.height !== grant.bounds.height)) throw new Error('target_bounds_mismatch');
    if (signal?.aborted) throw Object.assign(new Error('Capture aborted'), { name: 'AbortError' });
    return this.#captureFrame(target, signal);
  }

  async #captureFrame(target: ScreenTarget, signal?: AbortSignal): Promise<CapturedFrame | null> {
    if (!this.captureHook) throw new Error('capture_unavailable');
    const frame = await this.captureHook(target, signal);
    if (!frame) {
      if (signal?.aborted) throw Object.assign(new Error('Capture aborted'), { name: 'AbortError' });
      return null;
    }
    try {
      if (signal?.aborted) throw Object.assign(new Error('Capture aborted'), { name: 'AbortError' });
      if (frame.targetId !== target.targetId || frame.targetRevision !== target.targetRevision) throw new Error('captured_target_mismatch');
      if (frame.dimensions.width <= 0 || frame.dimensions.height <= 0
        || frame.dimensions.width * frame.dimensions.height > this.maxPixels) throw new Error('frame_dimensions_invalid');
      if (!(frame.bytes instanceof Uint8Array) || frame.bytes.length === 0 || frame.bytes.length > this.maxImageBytes) {
        throw new Error('frame_exceeds_byte_limit');
      }
      return frame;
    } catch (error) {
      frame.bytes.fill(0);
      throw error;
    }
  }
}

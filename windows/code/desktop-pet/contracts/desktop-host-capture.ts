/**
 * contracts/desktop-host.ts (CK-11 addition — capture route)
 *
 * CK-11: the host protocol gained **no** capture method, so `ScreenCaptureSource.capture()` had
 * nothing to call: every `captureHook` in the repo was inside a test, and production always threw
 * `capture_unavailable`. A chooser that can select a display but cannot capture it is half a feature.
 *
 * This file declares the missing route. Two rules shape it:
 *
 *  - the browser cannot supply a frame. The host returns bytes for a **target it resolved itself**
 *    from a request that carries the trusted target id + revision; there is no "here is my
 *    screenshot, please treat it as a capture" path.
 *  - the target kind is versioned. v1 only knew `screen`; `window` and `region` are new values that
 *    old hosts do not return, and a caller that receives an unknown kind must refuse rather than
 *    coerce it to `screen`.
 */

/** The versioned target kinds. A v1 host returns only 'screen'. */
export type HostScreenTargetKind = 'screen' | 'window' | 'region';

export interface HostScreenTarget {
  readonly targetId: string;
  readonly targetRevision: number;
  /** CK-11: widened from the v1 literal 'screen'. Consumers must handle all three. */
  readonly kind: HostScreenTargetKind;
  readonly displayName: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly scaleFactor: number;
  /** CK-11: host-side identity kept at the host (HWND / display id). Never a browser string. */
  readonly nativeHandle?: string | undefined;
}

export interface HostScreenTargetSelection {
  readonly outcome: 'selected' | 'cancelled';
  readonly target?: HostScreenTarget;
}

/** What the host was asked to capture. It echoes identity; it never receives a frame. */
export interface HostCaptureRequest {
  readonly operationId: string;
  readonly targetId: string;
  readonly targetRevision: number;
  readonly targetKind: HostScreenTargetKind;
  /** Ceiling the host must respect; the host may return fewer bytes, never more. */
  readonly maxBytes: number;
  readonly mimeType: 'image/png' | 'image/bmp';
}

export interface HostCaptureResult {
  readonly outcome: 'captured' | 'unavailable' | 'denied' | 'invalidated';
  readonly targetId: string;
  readonly targetRevision: number;
  readonly capturedAt: string;
  readonly mimeType?: 'image/png' | 'image/bmp';
  readonly dimensions?: { readonly width: number; readonly height: number };
  /** Base64 payload of the pixels. Absent unless `outcome === 'captured'`. */
  readonly bytesBase64?: string;
  readonly reason?: string;
}

export function isHostCaptureRequest(value: unknown): value is HostCaptureRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.operationId === 'string' && v.operationId.length > 0
    && typeof v.targetId === 'string' && v.targetId.length > 0
    && Number.isSafeInteger(v.targetRevision) && Number(v.targetRevision) >= 1
    && (v.targetKind === 'screen' || v.targetKind === 'window' || v.targetKind === 'region')
    && Number.isSafeInteger(v.maxBytes) && Number(v.maxBytes) > 0
    && (v.mimeType === 'image/png' || v.mimeType === 'image/bmp');
}

export function isHostCaptureResult(value: unknown): value is HostCaptureResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!['captured', 'unavailable', 'denied', 'invalidated'].includes(String(v.outcome))) return false;
  // A captured result MUST carry pixels; anything else is a protocol violation, not a partial one.
  if (v.outcome === 'captured') {
    return typeof v.bytesBase64 === 'string' && v.bytesBase64.length > 0
      && typeof v.mimeType === 'string'
      && !!v.dimensions && typeof (v.dimensions as { width: number }).width === 'number';
  }
  return true;
}

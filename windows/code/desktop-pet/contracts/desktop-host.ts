/**
 * contracts/desktop-host.ts — RWR-10-01
 *
 * The host (Electron main process) is the ONLY persistent owner of hotkey / replySound / display
 * preferences. The management HTTP server runs inside the backend child process and has no direct
 * access to that process, so every read and write travels over the existing NDJSON stdio bridge as a
 * requestId-correlated request/reply pair.
 *
 * This file is the single frozen description of that protocol. It deliberately does NOT expose an
 * arbitrary IPC surface: `method` is a closed union and `params` are validated on both sides.
 */

/** Bumped only when a field is removed or its meaning changes. Additive fields do not bump it. */
export const DESKTOP_HOST_API_VERSION = 1 as const;

/**
 * RWR-10-04: the native chooser surface.
 *
 * The real absolute path NEVER leaves the host. The host answers with a short-lived ticket plus the
 * display-only information the console needs (a name and, for a Live2D pack, the relative entry candidates
 * it found). The server resolves the ticket to the real path when an import is confirmed.
 */
export type ResourceSelectionKind = 'directory' | 'model-entry' | 'archive' | 'image';
export type ResourceSelectionType = 'live2d' | 'sprite';

/** One `.model3.json` candidate, always RELATIVE to the selected pack root. */
export interface ResourceSelectionEntry {
  /** Pack-relative path using forward slashes, e.g. `pet.model3.json` or `model/Hiyori.model3.json`. */
  readonly entry: string;
  readonly label: string;
}

export interface ResourceSelectionResult {
  readonly outcome: 'selected' | 'cancelled';
  /** Present only for `selected`. Bound to instance + character + type + selection for five minutes. */
  readonly selectionId?: string;
  /** Display name only (file or directory basename). Never a path. */
  readonly displayName?: string;
  /** 0, 1 or many relative entries. A Live2D directory with exactly one is chosen automatically. */
  readonly entries?: readonly ResourceSelectionEntry[];
}

/**
 * What the HOST returns over stdio. Unlike the browser-facing result, this carries the real absolute path:
 * it travels only between the host and this server process, never into an HTTP response.
 */
export interface HostResourceSelection extends ResourceSelectionResult {
  readonly source?: string;
  readonly root?: string;
}

/**
 * RWR-10-04: what the ticket RESOLVES to on the server. This is the only place a real path is used, and it
 * never travels to the browser.
 */
export interface ResourceSelectionTicket {
  readonly selectionId: string;
  readonly characterId: string;
  readonly type: ResourceSelectionType;
  readonly selectionKind: ResourceSelectionKind;
  /** The real absolute path, held server-side only. */
  readonly source: string;
  /** Pack root for a directory/model-entry selection; equals `source` for an image selection. */
  readonly root: string;
  readonly displayName: string;
  readonly entries: readonly ResourceSelectionEntry[];
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Set once an import actually succeeded, so a replay returns the same result instead of re-importing. */
  readonly consumedResult?: { readonly skinId: string; readonly revision: number };
}

/** Frozen by RWR-10-00: a selection ticket lives five minutes. */
export const RESOURCE_SELECTION_TTL_MS = 5 * 60 * 1000;

export const isResourceSelectionKind = (value: unknown): value is ResourceSelectionKind =>
  value === 'directory' || value === 'model-entry' || value === 'archive' || value === 'image';

export const isResourceSelectionType = (value: unknown): value is ResourceSelectionType =>
  value === 'live2d' || value === 'sprite';

/**
 * A `.model3.json` path is acceptable only as a pack-relative POSIX path. Rejecting `..`, absolute
 * prefixes and backslashes here means a hostile ticket can never point the importer outside its pack.
 */
export const RESOURCE_ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,183}\.model3\.json$/;

export const isValidResourceEntry = (value: unknown): value is string => {
  if (typeof value !== 'string' || !RESOURCE_ENTRY_PATTERN.test(value)) return false;
  return !value.split('/').some(part => !part || part === '.' || part === '..');
};

/**
 * Closed method set. A client can never name an arbitrary native call: adding a method is a code change
 * here plus a handler in the host switch, and the host rejects anything it does not implement.
 */
export interface HostScreenTarget {
  readonly targetId: string;
  readonly targetRevision: number;
  readonly kind: 'screen';
  readonly displayName: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly scaleFactor: number;
}

export interface HostScreenTargetSelection {
  readonly outcome: 'selected' | 'cancelled';
  readonly target?: HostScreenTarget;
}

export type DesktopHostMethod = 'preferences.get' | 'preferences.patch' | 'resource-picker.select' | 'screen-target.select'
  /** CK-11: the method `ScreenCaptureSource` had nothing to call. Without it the capture route was
   * declared in contracts/desktop-host-capture.ts but unreachable: the bridge refused the method as
   * `unsupported` before any host was ever asked. */
  | 'screen-target.capture'
  /** RUX-02: restart the managed desktop stack. The host (not the backend) serializes this: it
   * cancels the current backend session with the existing bounded EOF-then-kill shutdown and spawns a
   * fresh backend. The reply arrives BEFORE the restart begins, so the console can confirm first.
   * The response carries the host process's own boot identity so the console can tell the new
   * generation apart from the old one. */
  | 'app.restart'
  | 'companion.interact'
  /** Browser-owned Chat surface: closed actions only; no supplied scripts or shell commands. */
  | 'chatgpt-page';

export const DESKTOP_HOST_METHODS: readonly DesktopHostMethod[] = Object.freeze([
  'preferences.get', 'preferences.patch', 'resource-picker.select', 'screen-target.select', 'screen-target.capture',
  'app.restart', 'chatgpt-page', 'companion.interact',
]);

/** How the voice hotkey is actually delivered. `window-only` must never be presented as a global hotkey. */
export type HotkeyRegistration = 'window-only' | 'native-global';

export interface DesktopHostCapabilities {
  /** Honest registration level of the press-to-talk key. See HotkeyRegistration. */
  readonly hotkey: HotkeyRegistration;
  /** True once the host can open a native file/directory chooser (RWR-10-04). */
  readonly filePicker: boolean;
  /** True when the host owns display mode/size and reports a fitted configuration. */
  readonly display: boolean;
  /** True when the host can persist preferences at all (false for an offline/preview host). */
  readonly preferences: boolean;
}

/** Display intent and the screen-constrained result are DIFFERENT values and must not be conflated. */
export interface DesktopDisplayState {
  readonly mode: 'full' | 'half';
  /** What the user asked for, in logical CSS pixels. */
  readonly preferredWidth: number;
  /** What the host actually fitted after screen bounds were applied. */
  readonly modelWidth: number;
  readonly modelHeight: number;
  readonly drawerHeight: number;
}

export interface DesktopHostPreferences {
  readonly revision: number;
  readonly hotkey: string | null;
  readonly replySound: boolean;
  readonly display: DesktopDisplayState;
  readonly capabilities: DesktopHostCapabilities;
}

/** Only these keys may appear in a patch. Unknown keys are refused, never silently stored. */
export const DESKTOP_HOST_PATCH_KEYS = Object.freeze(['hotkey', 'replySound', 'mode', 'preferredWidth'] as const);
export type DesktopHostPatchKey = typeof DESKTOP_HOST_PATCH_KEYS[number];

export type DesktopHostPatch = Partial<Record<DesktopHostPatchKey, unknown>>;

export interface DesktopHostPatchInput {
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly patch: DesktopHostPatch;
}

export interface DesktopHostPatchReceipt {
  readonly revision: number;
  readonly applied: readonly DesktopHostPatchKey[];
  readonly preferences: DesktopHostPreferences;
}

/** A request the backend sends to the host. `params` is method-specific and validated by the host. */
export interface DesktopHostRequest {
  readonly channel: 'host_request';
  readonly requestId: string;
  readonly method: DesktopHostMethod;
  readonly params: Record<string, unknown>;
}

export type DesktopHostReply =
  | { readonly channel: 'host_reply'; readonly requestId: string; readonly ok: true; readonly result: unknown }
  | { readonly channel: 'host_reply'; readonly requestId: string; readonly ok: false;
      readonly error: { readonly code: DesktopHostErrorCode; readonly message: string } };

/**
 * Error codes the host may return. They map onto ManagementError codes at the HTTP edge:
 * `stale_revision`/`operation_conflict` -> 409, `invalid_request` -> 400, `unsupported`/`unavailable` -> 503.
 */
export type DesktopHostErrorCode =
  | 'invalid_request'
  | 'stale_revision'
  | 'operation_conflict'
  | 'unsupported'
  | 'unavailable';

export const isDesktopHostMethod = (value: unknown): value is DesktopHostMethod =>
  typeof value === 'string' && (DESKTOP_HOST_METHODS as readonly string[]).includes(value);

/**
 * The host's own hotkey whitelist. Kept identical to `desktop/press-to-talk.ts:validVoiceKey` and
 * `desktop/electron/main.mjs:validHotkey`; RWR-10-00 froze these three as one set.
 */
export const VALID_HOTKEY_PATTERN =
  /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/;

export const isValidHotkey = (value: unknown): value is string =>
  typeof value === 'string' && VALID_HOTKEY_PATTERN.test(value);

/** Display bounds frozen by RWR-10-00 (mirrors the host clamp in desktop/electron/main.mjs). */
export const DISPLAY_MIN_WIDTH = 220;
export const DISPLAY_MAX_WIDTH = 720;
export const clampDisplayWidth = (value: number): number =>
  Math.max(DISPLAY_MIN_WIDTH, Math.min(DISPLAY_MAX_WIDTH, Math.round(value)));

/**
 * Canonical JSON used for the operation replay signature. Key order must not change the signature, so
 * object keys are sorted; a different payload under the same operationId is a conflict, not a replay.
 */
export function operationSignature(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      const source = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(source).sort().map(key => [key, normalize(source[key])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

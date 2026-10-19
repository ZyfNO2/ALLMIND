/**
 * desktop/electron/host-preferences.ts — RWR-10-01
 *
 * Pure preference normalization/patching for the Electron host.
 *
 * SELF-CONTAINED BY CONSTRUCTION: this file is loaded directly by Electron, which strips types at
 * runtime and therefore resolves relative specifiers literally. A `./x.js` import would look for a
 * file that does not exist next to the source, and `./x.ts` would break the tsc build. So the host
 * keeps its own copy of the few shared constants and validates everything itself — which is also the
 * correct trust posture: the host must not rely on its own backend having validated a request.
 *
 * `tests/role-repair/rwr10-host-preferences.test.ts` asserts these constants still match
 * `contracts/desktop-host.ts`, so the two copies cannot drift apart silently.
 *
 * Three properties this file exists to guarantee:
 *  1. An old prefs file with no `revision` reads as revision 0 and upgrades to 1 on first write.
 *  2. Unknown fields written by a NEWER host are preserved across a downgrade/upgrade cycle.
 *  3. A write is only reported successful after the caller actually persisted it.
 */

/** Must equal `DESKTOP_HOST_API_VERSION` in contracts/desktop-host.ts. */
export const HOST_API_VERSION = 1;

/** Must equal `VALID_HOTKEY_PATTERN` in contracts/desktop-host.ts. */
export const HOST_HOTKEY_PATTERN =
  /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/;

export const HOST_DISPLAY_MIN_WIDTH = 220;
export const HOST_DISPLAY_MAX_WIDTH = 720;

/**
 * RWR-10-04: recognises a `.model3.json` file while scanning a chosen pack.
 *
 * The matching RELATIVE-path rule lives in contracts/desktop-host.ts; the RWR-10-04 test asserts the two
 * agree, so this copy cannot drift.
 */
export const HOST_MODEL_ENTRY_FILENAME = /\.model3\.json$/i;

/** RWR-10-04: sprite imports accept PNG and WebP only (mirrors SkinStore's own rule). */
export const HOST_SPRITE_EXTENSIONS = ['.png', '.webp'] as const;

export const isHostSpriteFile = (value: string): boolean =>
  typeof value === 'string' && HOST_SPRITE_EXTENSIONS.some(extension => value.toLowerCase().endsWith(extension));

/**
 * Turn an absolute path into a pack-relative POSIX entry, or null when the path escapes the pack root or is
 * otherwise unusable. Symlinks are not resolved here: the importer re-checks every file it actually copies.
 */
export function toPackRelativeEntry(root: string, absolute: string, separator: string): string | null {
  if (typeof absolute !== 'string' || !absolute.startsWith(root)) return null;
  const relative = absolute.slice(root.length).replace(/^[\\/]+/, '');
  if (!relative || relative.includes('\0')) return null;
  const parts = relative.split(separator);
  // `..` is refused rather than resolved: a `..` segment means the caller asked for something outside the
  // pack, and silently collapsing it would hand the importer a path the user never chose.
  if (parts.some(part => part === '..')) return null;
  const usable = parts.filter(part => part && part !== '.');
  if (usable.length === 0) return null;
  return usable.join('/');
}

export const isHostHotkey = (value: unknown): value is string =>
  typeof value === 'string' && HOST_HOTKEY_PATTERN.test(value);

export const clampHostWidth = (value: number): number =>
  Math.max(HOST_DISPLAY_MIN_WIDTH, Math.min(HOST_DISPLAY_MAX_WIDTH, Math.round(value)));

/**
 * Canonical JSON for the operation replay signature. Keys are sorted so that key order cannot change
 * the signature; the same operationId with a different payload is a conflict, not a replay.
 */
export function hostOperationSignature(value: unknown): string {
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

export type HostHotkeyRegistration = 'window-only' | 'native-global';
export type HostErrorCode = 'invalid_request' | 'stale_revision' | 'operation_conflict' | 'unsupported' | 'unavailable';
export type HostPatchKey = 'hotkey' | 'replySound' | 'mode' | 'preferredWidth';

export interface HostCapabilities {
  readonly hotkey: HostHotkeyRegistration;
  readonly filePicker: boolean;
  readonly display: boolean;
  readonly preferences: boolean;
}

export interface HostDisplayState {
  readonly mode: 'full' | 'half';
  readonly preferredWidth: number;
  readonly modelWidth: number;
  readonly modelHeight: number;
  readonly drawerHeight: number;
}

export interface HostPreferencesPayload {
  readonly apiVersion: number;
  readonly revision: number;
  readonly hotkey: string | null;
  readonly replySound: boolean;
  readonly display: HostDisplayState;
  readonly capabilities: HostCapabilities;
}

/** Fields this host understands. Anything else in the file is preserved verbatim as an unknown field. */
export const HOST_PREFERENCE_KEYS = Object.freeze([
  'mode', 'width', 'hotkey', 'replySound', 'localGreeting', 'localGreetingLastShownAt', 'revision', 'drawerSize',
] as const);

/** RUX-08: the chat drawer's user-resized bounds. `null` means "use the layout default". */
export const HOST_DRAWER_MIN_WIDTH = 340;
export const HOST_DRAWER_MIN_HEIGHT = 420;
export const HOST_DRAWER_MAX_WIDTH = 1280;
export const HOST_DRAWER_MAX_HEIGHT = 1200;

export interface HostDrawerSize { width: number; height: number }

export const clampHostDrawerSize = (value: unknown): HostDrawerSize | null => {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height)) return null;
  const width = Math.round(Number(source.width)), height = Math.round(Number(source.height));
  if (width < HOST_DRAWER_MIN_WIDTH || height < HOST_DRAWER_MIN_HEIGHT) return null;
  return { width: Math.min(HOST_DRAWER_MAX_WIDTH, width), height: Math.min(HOST_DRAWER_MAX_HEIGHT, height) };
};

export interface HostPreferenceState {
  mode: 'full' | 'half';
  width: number;
  hotkey: string | null;
  replySound: boolean;
  localGreeting: boolean;
  localGreetingLastShownAt: number | null;
  revision: number;
  drawerSize: HostDrawerSize | null;
}

export function defaultHostPreferences(): HostPreferenceState {
  return { mode: 'full', width: 360, hotkey: null, replySound: true, localGreeting: true,
    localGreetingLastShownAt: null, revision: 0, drawerSize: null };
}

export interface ParsedHostPreferences {
  readonly state: HostPreferenceState;
  /** Fields this build does not understand, preserved on the next write. */
  readonly unknown: Record<string, unknown>;
}

/**
 * Read a prefs file. A corrupt or non-object file falls back to defaults rather than throwing: the host
 * must still start, and the next successful write repairs the file.
 */
export function parseHostPreferences(saved: unknown): ParsedHostPreferences {
  const state = defaultHostPreferences();
  const unknown: Record<string, unknown> = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { state, unknown };
  const source = saved as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const value = source[key];
    // The window anchor is owned by the layout path, not by this state, so it is neither read nor dropped.
    if (key === 'anchor') continue;
    if (!(HOST_PREFERENCE_KEYS as readonly string[]).includes(key)) { unknown[key] = value; continue; }
    if (key === 'mode') { if (value === 'full' || value === 'half') state.mode = value; continue; }
    if (key === 'width') { if (Number.isFinite(value)) state.width = clampHostWidth(Number(value)); continue; }
    if (key === 'hotkey') { if (value === null || isHostHotkey(value)) state.hotkey = value as string | null; continue; }
    if (key === 'replySound') { if (typeof value === 'boolean') state.replySound = value; continue; }
    if (key === 'localGreeting') { if (typeof value === 'boolean') state.localGreeting = value; continue; }
    if (key === 'localGreetingLastShownAt') {
      if (Number.isFinite(value) && Number(value) >= 0) state.localGreetingLastShownAt = Number(value);
      continue;
    }
    if (key === 'drawerSize') { state.drawerSize = clampHostDrawerSize(value); continue; }
    // An absent revision is the documented "old file" case and reads as 0. A present but unusable
    // revision is treated the same way: the file is repaired on the next write.
    if (key === 'revision') { if (Number.isSafeInteger(value) && Number(value) >= 0) state.revision = Number(value); }
  }
  return { state, unknown };
}

/** Serialize for disk, keeping unknown fields so a newer host's settings survive this one. */
export function serializeHostPreferences(parsed: ParsedHostPreferences, anchor: unknown): string {
  return JSON.stringify({ ...parsed.unknown, ...parsed.state, anchor });
}

export interface HostCapabilityInput {
  readonly windowAvailable: boolean;
  readonly canPersist: boolean;
  readonly filePicker: boolean;
  readonly hotkey?: HostHotkeyRegistration;
}

/**
 * Report what this host can REALLY do. The press-to-talk key is delivered by renderer key events, so it
 * is `window-only`; the only system-registered accelerator is the click-through toggle. Reporting
 * `native-global` here would be a lie the console would then repeat to the user.
 */
export function hostCapabilities(input: HostCapabilityInput): HostCapabilities {
  return Object.freeze({
    hotkey: input.hotkey ?? 'window-only',
    filePicker: input.filePicker === true,
    display: input.windowAvailable === true,
    preferences: input.canPersist === true,
  });
}

export function toHostPreferencesPayload(
  state: HostPreferenceState, display: HostDisplayState, capabilities: HostCapabilities,
): HostPreferencesPayload {
  return Object.freeze({
    apiVersion: HOST_API_VERSION,
    revision: state.revision,
    hotkey: state.hotkey,
    replySound: state.replySound,
    display: Object.freeze({ ...display, preferredWidth: clampHostWidth(display.preferredWidth) }),
    capabilities,
  });
}

export interface HostPatchSuccess {
  readonly ok: true;
  readonly next: HostPreferenceState;
  readonly applied: readonly HostPatchKey[];
}
export interface HostPatchFailure {
  readonly ok: false;
  readonly code: HostErrorCode;
  readonly message: string;
}

/**
 * Apply a validated patch. Every value is re-checked here even though the HTTP edge also validates it:
 * the host is the authority and must not trust a well-formed-looking request from its own backend.
 */
export function applyHostPatch(current: HostPreferenceState, expectedRevision: unknown, patch: unknown): HostPatchSuccess | HostPatchFailure {
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
    return { ok: false, code: 'invalid_request', message: '修订号无效。' };
  }
  if (Number(expectedRevision) !== current.revision) {
    return { ok: false, code: 'stale_revision', message: '宿主设置已被其他窗口修改，请刷新后重试。' };
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, code: 'invalid_request', message: '设置内容无效。' };
  }
  const source = patch as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length === 0) return { ok: false, code: 'invalid_request', message: '没有需要保存的设置。' };

  const next: HostPreferenceState = { ...current };
  const applied: HostPatchKey[] = [];
  for (const key of keys) {
    const value = source[key];
    if (key === 'hotkey') {
      if (value !== null && !isHostHotkey(value)) return { ok: false, code: 'invalid_request', message: '这个按键不能用于按住发言。' };
      next.hotkey = value as string | null; applied.push('hotkey'); continue;
    }
    if (key === 'replySound') {
      if (typeof value !== 'boolean') return { ok: false, code: 'invalid_request', message: '回复声音开关无效。' };
      next.replySound = value; applied.push('replySound'); continue;
    }
    if (key === 'mode') {
      if (value !== 'full' && value !== 'half') return { ok: false, code: 'invalid_request', message: '展示模式无效。' };
      next.mode = value; applied.push('mode'); continue;
    }
    if (key === 'preferredWidth') {
      if (!Number.isFinite(value)) return { ok: false, code: 'invalid_request', message: '尺寸无效。' };
      next.width = clampHostWidth(Number(value)); applied.push('preferredWidth'); continue;
    }
    return { ok: false, code: 'invalid_request', message: `不支持的设置项：${key}` };
  }
  next.revision = current.revision + 1;
  return { ok: true, next, applied };
}

interface ReplayEntry<T> { readonly signature: string; readonly receipt: T }

/**
 * Bounded operationId replay ledger. Replay is resolved BEFORE the revision check so a retried request
 * after a lost response returns the original receipt instead of a spurious stale-revision conflict.
 *
 * Note: no constructor parameter properties — Electron strips types and cannot execute that syntax.
 */
export class HostOperationLedger<T> {
  private readonly entries = new Map<string, ReplayEntry<T>>();
  private readonly capacity: number;
  constructor(capacity = 64) { this.capacity = capacity; }
  /** Returns the stored receipt for a replay, `null` for a new operation, or throws on a payload conflict. */
  lookup(operationId: string, payload: unknown): T | null {
    const entry = this.entries.get(operationId);
    if (!entry) return null;
    if (entry.signature !== hostOperationSignature(payload)) {
      throw Object.assign(new Error('操作编号已用于另一组设置。'), { code: 'operation_conflict' as HostErrorCode });
    }
    return entry.receipt;
  }
  record(operationId: string, payload: unknown, receipt: T): void {
    this.entries.delete(operationId);
    this.entries.set(operationId, { signature: hostOperationSignature(payload), receipt });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
  get size(): number { return this.entries.size; }
}

/**
 * management/desktop-host-routes.ts — RWR-10-01 / RWR-10-04
 *
 * HTTP surface for host-owned preferences and the native resource chooser. This file is intentionally
 * thin: it validates the wire shape, delegates to the host bridge, and maps host error codes onto
 * ManagementError. It never exposes a file path to the browser — a selection returns a ticket, and only
 * this server resolves a ticket back to a path.
 */
import { ManagementError } from '../contracts/management.js';
import {
  DESKTOP_HOST_API_VERSION, isResourceSelectionKind, isResourceSelectionType, isValidHotkey,
  isValidResourceEntry, type DesktopHostPreferences,
} from '../contracts/desktop-host.js';
import {
  DesktopHostError, patchHostPreferences, readHostPreferences, requestHostRestart, selectHostResource, type DesktopHostBridge,
} from '../app/desktop-host-bridge.js';
import {
  chooseResourceEntry, ResourceSelectionStore, type SelectionIdentity,
} from '../app/resource-selection-store.js';
import type { SkinManagement, SkinState } from '../contracts/skin.js';

export interface DesktopHostManagement {
  preferences(): Promise<DesktopHostPreferences>;
  patch(input: { expectedRevision: number; operationId: string; patch: Record<string, unknown> }): Promise<unknown>;
  /**
   * Open the native chooser for one character/type/selection and return a ticket.
   *
   * `identityFor` binds a ticket to THIS management instance: a ticket issued by a previous backend must not
   * be importable after a restart, so the route never has to invent or forward an instance id itself.
   */
  identityFor(characterId: string, type: 'live2d' | 'sprite', selectionKind: 'directory' | 'model-entry' | 'archive' | 'image'): SelectionIdentity;
  /** RWR-10-04: open the native chooser and return a ticket instead of a path. */
  select(identity: SelectionIdentity): Promise<Record<string, unknown>>;
  /** Exchange a ticket for its real path. Only the server ever sees a path. */
  importBySelection(identity: SelectionIdentity, input: {
    selectionId: string; entry?: string; label?: string; skinId?: string;
    sprite?: Record<string, unknown>;
    localInteractions?: import('../contracts/local-pet.js').LocalPetInteractionPack;
  }): Promise<SkinState>;
  /** RUX-02: ask the host to restart the managed backend; resolves only when the host acknowledged. */
  restart(): Promise<{ requestedAt: string }>;
}

/** The only patch keys this endpoint accepts. Kept explicit so an unknown key is a 400, not a silent drop. */
const PATCH_KEYS = new Set(['hotkey', 'replySound', 'mode', 'preferredWidth']);

function hostFailure(error: unknown): never {
  if (error instanceof DesktopHostError) {
    if (error.code === 'stale_revision' || error.code === 'operation_conflict') throw new ManagementError('version_conflict', error.message);
    if (error.code === 'invalid_request') throw new ManagementError('invalid_request', error.message);
    throw new ManagementError('unavailable', error.message);
  }
  throw new ManagementError('unavailable', '宿主设置操作未完成。');
}

/**
 * Wrap the bridge as a management port. Absent bridge => the section reports unavailable, never fake data.
 *
 * `skins` is optional: with it the ticket can be exchanged for a real import; without it the chooser still
 * works but no import endpoint exists, so the console must not pretend otherwise.
 */
export function desktopHostManagement(
  bridge: DesktopHostBridge | undefined,
  context: { readonly instanceId: string; readonly skins?: SkinManagement },
): DesktopHostManagement | undefined {
  if (!bridge) return undefined;
  const selections = new ResourceSelectionStore();
  const identityOf = (characterId: string, type: 'live2d' | 'sprite', selectionKind: 'directory' | 'model-entry' | 'archive' | 'image'): SelectionIdentity =>
    ({ instanceId: context.instanceId, characterId, type, selectionKind });
  return {
    async preferences() {
      try { return await readHostPreferences(bridge); }
      catch (error) { hostFailure(error); }
    },
    async patch(input) {
      try { return await patchHostPreferences(bridge, input); }
      catch (error) { hostFailure(error); }
    },
    identityFor(characterId, type, selectionKind) { return identityOf(characterId, type, selectionKind); },
    async select(identity) {
      let selection;
      try {
        selection = await selectHostResource(bridge, {
          characterId: identity.characterId, type: identity.type, selectionKind: identity.selectionKind,
        });
      } catch (error) { hostFailure(error); }
      // A cancelled selection is a normal outcome: no ticket, no error, and nothing is recorded.
      if (selection?.outcome === 'cancelled') return { outcome: 'cancelled' };
      if (selection?.outcome !== 'selected') throw new ManagementError('unavailable', '系统选择窗口返回了无效结果。');
      const ticket = selections.issue({
        instanceId: identity.instanceId,
        characterId: identity.characterId,
        type: identity.type,
        selectionKind: identity.selectionKind,
        source: String(selection.source ?? ''),
        root: String(selection.root ?? ''),
        displayName: String(selection.displayName ?? ''),
        entries: Array.isArray(selection.entries) ? selection.entries : [],
      });
      // The browser receives a ticket plus display-only data. The real path stays here.
      return { outcome: 'selected', selectionId: ticket.selectionId, displayName: ticket.displayName, entries: ticket.entries };
    },
    async importBySelection(identity, input) {
      if (!context.skins) throw new ManagementError('unavailable', '当前实例未接入形象登记，无法导入。');
      const ticket = selections.resolve(input.selectionId, identity);
      // For a directory/model-entry selection the importer needs the pack root and the chosen entry.
      const chosen = ticket.type === 'live2d' && ticket.entries.length > 0
        ? chooseResourceEntry(ticket.entries, input.entry)
        : undefined;
      const state = await context.skins.import(ticket.selectionKind === 'image' ? ticket.source : ticket.root, {
        ...(ticket.type === 'live2d' ? { type: 'live2d' as const } : { type: 'sprite' as const }),
        ...(chosen ? { entry: chosen.entry } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.skinId ? { skinId: input.skinId } : {}),
        ...(ticket.type === 'sprite' && input.sprite ? { sprite: input.sprite as never } : {}),
        ...(input.localInteractions!==undefined?{localInteractions:input.localInteractions}:{}),
      });
      // Only a SUCCESSFUL import consumes the ticket, so a failure can be retried without reopening the
      // chooser. The real path is never echoed back to the browser.
      const added = state.skins.find(skin => skin.origin === 'imported');
      if (added) selections.consume(ticket.selectionId, { skinId: added.skinId, revision: state.revision });
      return state;
    },
    async restart() {
      try { return await requestHostRestart(bridge); }
      catch (error) { hostFailure(error); }
    },
  };
}

const str = (value: unknown, max: number, message: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', message);
  return value;
};

export async function desktopHostRoute(
  method: string | undefined,
  port: DesktopHostManagement | undefined,
  pathname: string,
  body: () => Promise<Record<string, unknown>>,
  send: (value: unknown) => void,
): Promise<boolean> {
  if (!pathname.startsWith('/api/desktop/')) return false;
  if (!port) throw new ManagementError('unavailable', '当前实例未连接桌宠宿主，宿主设置不可用。');

  if (pathname === '/api/desktop/preferences') {
    if (method === 'GET') {
      const preferences = await port.preferences();
      // The wire always carries the version so an older console can refuse a newer host instead of
      // rendering fields whose meaning changed.
      send({ apiVersion: DESKTOP_HOST_API_VERSION, ...preferences });
      return true;
    }
    if (method === 'PUT') {
      const payload = await body();
      const expectedRevision = payload.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new ManagementError('invalid_request', '修订号无效。');
      const operationId = str(payload.operationId, 200, '操作编号无效。');
      const patch = payload.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ManagementError('invalid_request', '设置内容无效。');
      const keys = Object.keys(patch as Record<string, unknown>);
      if (keys.length === 0) throw new ManagementError('invalid_request', '没有需要保存的设置。');
      for (const key of keys) {
        if (!PATCH_KEYS.has(key)) throw new ManagementError('invalid_request', `不支持的设置项：${key}`);
      }
      // Shape checks happen here for a fast 400; the host re-validates and remains the authority.
      const source = patch as Record<string, unknown>;
      if ('hotkey' in source && source.hotkey !== null && !isValidHotkey(source.hotkey)) throw new ManagementError('invalid_request', '这个按键不能用于按住发言。');
      if ('replySound' in source && typeof source.replySound !== 'boolean') throw new ManagementError('invalid_request', '回复声音开关无效。');
      if ('mode' in source && source.mode !== 'full' && source.mode !== 'half') throw new ManagementError('invalid_request', '展示模式无效。');
      if ('preferredWidth' in source && !Number.isFinite(source.preferredWidth)) throw new ManagementError('invalid_request', '尺寸无效。');
      const receipt = await port.patch({ expectedRevision: Number(expectedRevision), operationId, patch: source });
      send(receipt);
      return true;
    }
    throw new ManagementError('not_found', '没有这个宿主设置操作。');
  }

  if (pathname === '/api/desktop/resource-picker') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个资源选择操作。');
    const payload = await body();
    // The client may only name WHAT it wants, never a window, a filter or a path.
    if (!isResourceSelectionType(payload.type)) throw new ManagementError('invalid_request', '形象类型无效。');
    if (!isResourceSelectionKind(payload.selectionKind)) throw new ManagementError('invalid_request', '选择来源无效。');
    if ((payload.type === 'sprite') !== (payload.selectionKind === 'image')) throw new ManagementError('invalid_request', '形象类型与选择来源不符。');
    if (payload.path !== undefined || payload.url !== undefined || payload.windowId !== undefined) {
      throw new ManagementError('forbidden', '系统选择窗口只能由桌宠打开。');
    }
    const characterId = str(payload.characterId, 64, '角色标识无效。');
    const identity = port.identityFor(characterId, payload.type, payload.selectionKind);
    if (payload.selectionId !== undefined) {
      // A ticket-based import reuses this endpoint, so the console needs only one resource entry point.
      const selectionId = str(payload.selectionId, 100, '选择票据无效。');
      if (payload.entry !== undefined && !isValidResourceEntry(payload.entry)) throw new ManagementError('invalid_request', '入口文件无效。');
      const sprite = payload.sprite && typeof payload.sprite === 'object' && !Array.isArray(payload.sprite)
        ? payload.sprite as Record<string, unknown> : undefined;
      const state = await port.importBySelection(identity, {
        selectionId,
        ...(payload.entry !== undefined ? { entry: payload.entry } : {}),
        ...(payload.label !== undefined ? { label: str(payload.label, 80, '显示名称无效。') } : {}),
        ...(payload.skinId !== undefined ? { skinId: str(payload.skinId, 48, '模型包标识无效。') } : {}),
        ...(sprite ? { sprite } : {}),
      });
      send(state);
      return true;
    }
    send(await port.select(identity));
    return true;
  }

  if (pathname === '/api/desktop/restart') {
    // RUX-02: the console asks the HOST to restart the managed backend. The request only settles when
    // the host has acknowledged; a rejected request must reach the console as a failure, never as a
    // silent "already restarted". This endpoint performs no configuration write of its own.
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个宿主重启操作。');
    send(await port.restart());
    return true;
  }

  throw new ManagementError('not_found', '没有这个宿主设置操作。');
}

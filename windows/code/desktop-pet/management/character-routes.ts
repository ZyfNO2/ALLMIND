// RWR-02 / CONTRACTS §1: the HTTP plane for the persisted character registry.
//
// Why a dedicated route: admission used to be the hardcoded `isProductCharacter`, so every management
// entry point shared one implicit "there is exactly one character" assumption, and `getPreset`
// fabricated a default preset for any id that passed the regex. The registry is now the authority, and
// this route is the only management surface that can create or select a character.
//
// Boundary rules from CONTRACTS §1:
//  * `GET /api/characters` never carries user-authored bodies (no prompt, no records, no Wiki).
//  * `POST /api/characters` allocates the id server-side and is transactional; replaying an
//    operationId returns the same character instead of creating a second one.
//  * `PUT /api/characters/selection` changes only the SAVED selection. The running pairing keeps its
//    character until a restart, so a selection can never retag an in-flight turn.
import { ManagementError, type CharacterRegistryPort } from '../contracts/management.js';
import type { CharacterDescriptor, RuntimeRoleState } from '../contracts/character.js';

/** Published capability version. A renderer that does not see this must not offer multi-role creation. */
export const CHARACTER_API_VERSION = 2;

export interface CharactersView {
  readonly apiVersion: number;
  readonly revision: number;
  readonly characters: readonly CharacterDescriptor[];
  readonly selection: RuntimeRoleState;
}

const text = (value: unknown, max: number, message: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', message);
  return value;
};
const operationId = (value: unknown): string => text(value, 160, '操作编号无效。');
/**
 * An absent field is left untouched; an explicitly empty one clears it.
 *
 * RWR-07: the empty case previously went through `text()`, which rejects `!value.trim()`. That made
 * this function's own documented contract ("an explicitly empty one clears it") impossible to
 * express, and the console — whose draft fields are seeded to `''` — got a 400 「角色简介无效。」 for a
 * field the user never edited. Clearing author text is legitimate (the store's `authorText` stores it
 * verbatim), so only a **blank** value is treated as "clear"; a non-string, an over-long value, or a
 * NUL is still `invalid_request`. Whitespace-only is preserved verbatim like any other author prose,
 * because silently deleting a user's spaces is worse than storing them.
 */
const optionalText = (value: unknown, message: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ManagementError('invalid_request', message);
  if (!value.trim()) return '';
  return text(value, 4000, message);
};
const revision = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ManagementError('invalid_request', '修订号无效。');
  return parsed;
};

/** Translate a registry failure into the HTTP contract without leaking internal messages. */
function translate(error: unknown): never {
  if (error instanceof ManagementError) throw error;
  const code = (error as { code?: string }).code;
  if (code === 'not_found') throw new ManagementError('not_found', '没有这个角色。');
  if (code === 'version_conflict') throw new ManagementError('version_conflict', '角色数据已更新，请刷新后重试。');
  if (code === 'operation_id_payload_mismatch') throw new ManagementError('version_conflict', '同一操作编号已用于不同内容。');
  if (code === 'invalid_request') throw new ManagementError('invalid_request', (error as Error).message || '角色请求无效。');
  if (code === 'forbidden') throw new ManagementError('forbidden', '该角色不可访问。');
  throw new ManagementError('internal_error', '角色操作未完成，原始内容未对外输出。');
}
function view(registry: CharacterRegistryPort): CharactersView {
  return {
    apiVersion: CHARACTER_API_VERSION,
    revision: registry.list().reduce((max, entry) => Math.max(max, entry.revision), 0),
    characters: registry.list(),
    selection: registry.selection(),
  };
}

/**
 * /api/characters* — registry reads, explicit creation and the restart-scoped selection.
 *
 *  GET  /api/characters              descriptors + selection (no user bodies)
 *  POST /api/characters              create one character (server-assigned id, idempotent)
 *  PUT  /api/characters/selection    change the SAVED selection only
 */
export async function charactersRoute(
  method: string | undefined,
  registry: CharacterRegistryPort | undefined,
  pathname: string,
  body: () => Promise<Record<string, unknown>>,
  profileStore?: import('./role-configuration.js').RoleConfigurationStore,
  skins?: import('../contracts/skin.js').SkinManagement,
  query?: URLSearchParams,
): Promise<unknown> {
  if (!pathname.startsWith('/api/characters')) return undefined;
  if (!registry) throw new ManagementError('unavailable', '当前实例尚未接入角色登记。');

  if (pathname === '/api/characters') {
    if (method === 'GET') return view(registry);
    if (method === 'POST') {
      const payload = await body();
      const input: { label: string; intro?: string; operationId: string; id?: string } = {
        label: text(payload.label, 80, '角色名称无效。'),
        operationId: operationId(payload.operationId),
      };
      // `intro` is optional; an explicitly empty one is accepted and stored as empty (RWR-07: this
      // comment used to promise behaviour that `text()` made impossible — blank meant a 400).
      if (payload.intro !== undefined && payload.intro !== null) input.intro = payload.intro === '' ? '' : text(payload.intro, 2000, '角色简介无效。');
      // A caller may propose an id, but it must be well-formed; the registry still checks uniqueness.
      if (payload.id !== undefined && payload.id !== null) input.id = text(payload.id, 64, '角色标识无效。');
      try {
        const result = registry.create(input);
        // RWR-08 (B1): a created role starts with visible inherit-default v2 bindings, so the very
        // first author save works instead of 404-ing forever on a missing configuration.
        if (profileStore) await profileStore.ensureConfiguration(result.character.id);
        return { operationId: input.operationId, created: result.created, character: result.character };
      } catch (error) { return translate(error); }
    }
    throw new ManagementError('not_found', '没有这个角色操作。');
  }

  if (pathname === '/api/characters/selection') {
    if (method !== 'PUT') throw new ManagementError('not_found', '没有这个角色操作。');
    const payload = await body();
    try {
      return registry.setSelection({
        characterId: payload.characterId,
        expectedRevision: revision(payload.expectedRevision),
        operationId: operationId(payload.operationId),
      });
    } catch (error) { return translate(error); }
  }
  const lifecycle = /^\/api\/characters\/([a-zA-Z0-9_-]+)\/(remove|replace)$/.exec(pathname);
  if (lifecycle) {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个角色操作。');
    const payload = await body();
    try {
      const input = { characterId: lifecycle[1]!, expectedRevision: revision(payload.expectedRevision) };
      if (lifecycle[2] === 'remove') {
        if (!registry.remove) throw new ManagementError('unavailable', '当前实例尚未接入角色删除。');
        registry.remove(input);
        return { removed: true, characterId: input.characterId, historyRetained: true };
      }
      if (!registry.replace) throw new ManagementError('unavailable', '当前实例尚未接入角色替换。');
      const result = registry.replace({ ...input, label: text(payload.label, 80, '角色名称无效。'), operationId: operationId(payload.operationId) });
      await profileStore?.ensureConfiguration(result.character.id);
      return { ...result, replacedCharacterId: input.characterId, historyRetained: true };
    } catch (error) {
      if ((error as { code?: string }).code === 'forbidden') throw new ManagementError('forbidden', '请先选择其他角色并重启，再删除或替换该角色。');
      return translate(error);
    }
  }

  // RWR-06: the author metadata surface. It writes ONLY author prose; the persona BODY stays owned by
  // `memory.prompt` and is not editable here, so this route can never become a second editable persona.
  if (pathname === '/api/characters/profile') {
    if (method === 'GET') {
      const characterId = query?.get('characterId') || 'companion';
      if (!registry.get(characterId)) throw new ManagementError('not_found','没有这个角色。');
      // Registered legacy roles may predate the author metadata file. Empty metadata is valid;
      // seed only AFTER registry admission, never invent a role from a query string.
      const configuration = await profileStore?.ensureConfiguration(characterId);
      if (!configuration) throw new ManagementError('unavailable','当前实例尚未接入该角色资料。');
      return {characterId,identity:configuration.identity,persona:configuration.persona,fieldRevision:configuration.fieldRevision ?? 0,savedRevision:configuration.savedRevision};
    }
    if (method !== 'PUT') throw new ManagementError('not_found', '没有这个角色操作。');
    const payload = await body();
    if (!registry.get(payload.characterId)) throw new ManagementError('not_found', '没有这个角色。');
    if (!profileStore) throw new ManagementError('unavailable', '当前实例尚未接入角色资料。');
    try {
      const configuration = await profileStore.saveAuthorMetadata(String(payload.characterId ?? ''), {
        intro: optionalText(payload.intro, '角色简介无效。'),
        scenario: optionalText(payload.scenario, '背景与情境无效。'),
        firstMessage: optionalText(payload.firstMessage, '开场白无效。'),
        exampleDialogue: optionalText(payload.exampleDialogue, '示例对话无效。'),
        sourceRef: optionalText(payload.sourceRef, '来源引用无效。'),
        expectedFieldRevision: payload.expectedFieldRevision === undefined || payload.expectedFieldRevision === null
          ? undefined : Number(payload.expectedFieldRevision),
        operationId: operationId(payload.operationId),
      });
      // The receipt is explicit about what was persisted and what is still pending a restart.
      return { operationId: payload.operationId, applyOn: 'restart', fieldRevision: configuration.fieldRevision ?? 0, configuration };
    } catch (error) { return translate(error); }
  }

  // RWR-08 (F06): the per-character APPEARANCE choice. Registering resources stays with the skin
  // registry; WHICH resource a role uses is role configuration. Saving a non-running role's appearance
  // here only changes that role's saved choice — it must never call the global skin activation the
  // running (companion) presentation depends on.
  if (pathname === '/api/characters/appearance') {
    if (method !== 'PUT') throw new ManagementError('not_found', '没有这个角色操作。');
    const payload = await body();
    if (!profileStore) throw new ManagementError('unavailable', '当前实例尚未接入角色配置。');
    try {
      const characterIdText = String(payload.characterId ?? '');
      if (!registry.get(characterIdText)) throw new ManagementError('not_found', '没有这个角色。');
      const resourceId = text(payload.resourceId, 96, '形象资源标识无效。');
      const type = payload.type === 'sprite' ? 'sprite' : payload.type === 'live2d' ? 'live2d' : undefined;
      if (!type) throw new ManagementError('invalid_request', '形象类型无效。');
      if (skins) {
        const resource = skins.list().find(skin => skin.skinId === resourceId);
        if (!resource || (resource.type || 'live2d') !== type) throw new ManagementError('invalid_request', '形象类型与登记资源不符。');
      }
      const configuration = await profileStore.saveAppearance(characterIdText, { resourceId, type });
      return { operationId: typeof payload.operationId === 'string' ? payload.operationId : null, saved: true, resourceId: configuration.appearance.resourceId, revision: configuration.savedRevision, applyOn: 'restart' };
    } catch (error) { return translate(error); }
  }

  throw new ManagementError('not_found', '没有这个角色接口。');
}

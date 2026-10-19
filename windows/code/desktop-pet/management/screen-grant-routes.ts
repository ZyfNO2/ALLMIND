import { ManagementError } from '../contracts/management.js';
import type { PairingScope } from '../contracts/character-pack.js';
import { ScreenGrantRuntimeError, type ScreenGrantRuntime } from './screen-grant-runtime.js';

const fail = (error: unknown): never => {
  if (error instanceof ManagementError) throw error;
  if (error instanceof ScreenGrantRuntimeError) throw new ManagementError(error.code, error.message);
  throw new ManagementError('unavailable', '屏幕授权操作未完成，原始内容不会写入诊断。');
};

function string(value: unknown, max: number, message: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new ManagementError('invalid_request', message);
  }
  return value.trim();
}
function pairing(value: unknown): PairingScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('invalid_request', '配对范围无效。');
  const p = value as Record<string, unknown>;
  return {
    userId: string(p.userId, 96, '用户标识无效。'),
    characterId: string(p.characterId, 64, '角色标识无效。'),
    characterInstanceId: string(p.characterInstanceId, 96, '角色实例标识无效。'),
  };
}
function opId(value: unknown): string { return string(value, 200, '操作编号无效。'); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ManagementError('invalid_request', `不支持的屏幕授权字段：${key}`);
  }
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ManagementError('invalid_request', '修订号无效。');
  return Number(value);
}

export async function screenGrantRoute(
  method: string | undefined,
  runtime: ScreenGrantRuntime | undefined,
  pathname: string,
  query: URLSearchParams,
  body: () => Promise<Record<string, unknown>>,
  send: (value: unknown) => void,
): Promise<boolean> {
  if (!pathname.startsWith('/api/companion/screen-')) return false;
  if (!runtime) throw new ManagementError('unavailable', '屏幕授权运行时未装配。');

  if (pathname === '/api/companion/screen-targets/select') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个屏幕目标操作。');
    const value = await body();
    exactKeys(value, ['pairing', 'operationId']);
    try { send(await runtime.selectTarget({ pairing: pairing(value.pairing), operationId: opId(value.operationId) })); return true; }
    catch (error) { fail(error); }
  }

  if (pathname === '/api/companion/screen-grants') {
    if (method === 'GET') {
      const scope: PairingScope = {
        userId: string(query.get('userId'), 96, '必须指定用户标识。'),
        characterId: string(query.get('characterId'), 64, '必须指定角色标识。'),
        characterInstanceId: string(query.get('characterInstanceId'), 96, '必须指定角色实例。'),
      };
      try { send(runtime.getGrants(scope)); return true; }
      catch (error) { fail(error); }
    }
    if (method === 'PUT') {
      const value = await body();
      exactKeys(value, ['pairing', 'expectedRevision', 'operationId', 'purpose', 'destination', 'targetId', 'targetRevision',
        'ttlMs', 'minPollIntervalMs', 'userConfirmed', 'modelBinding', 'observationSourceScopes']);
      if (value.purpose !== 'capture-single' && value.purpose !== 'capture-continuous' && value.purpose !== 'context-use') {
        throw new ManagementError('invalid_request', '屏幕授权用途无效。');
      }
      if (value.destination !== 'local' && value.destination !== 'cloud') throw new ManagementError('invalid_request', '处理目的地无效。');
      if (!Number.isSafeInteger(value.targetRevision) || Number(value.targetRevision) < 1) throw new ManagementError('invalid_request', '目标修订号无效。');
      if (value.ttlMs !== undefined && !Number.isSafeInteger(value.ttlMs)) throw new ManagementError('invalid_request', '授权期限无效。');
      if (value.minPollIntervalMs !== undefined && !Number.isSafeInteger(value.minPollIntervalMs)) throw new ManagementError('invalid_request', '观察间隔无效。');
      const scopes = value.observationSourceScopes;
      if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length > 32 || scopes.some(x => typeof x !== 'string' || !x.trim() || x.length > 200))) {
        throw new ManagementError('invalid_request', '观察来源范围无效。');
      }
      try {
        send(await runtime.issue({
          pairing: pairing(value.pairing), expectedRevision: revision(value.expectedRevision), operationId: opId(value.operationId),
          purpose: value.purpose, destination: value.destination,
          targetId: string(value.targetId, 200, '目标标识无效。'), targetRevision: Number(value.targetRevision),
          ...(value.ttlMs !== undefined ? { ttlMs: Number(value.ttlMs) } : {}),
          ...(value.minPollIntervalMs !== undefined ? { minPollIntervalMs: Number(value.minPollIntervalMs) } : {}),
          userConfirmed: value.userConfirmed === true,
          ...(value.modelBinding !== undefined ? { modelBinding: string(value.modelBinding, 200, '模型绑定无效。') } : {}),
          ...(scopes !== undefined ? { observationSourceScopes: scopes as string[] } : {}),
        }));
        return true;
      } catch (error) { fail(error); }
    }
    throw new ManagementError('not_found', '没有这个屏幕授权操作。');
  }

  const revoke = /^\/api\/companion\/screen-grants\/([^/]+)\/revoke$/.exec(pathname);
  if (revoke) {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个撤销操作。');
    const value = await body();
    exactKeys(value, ['pairing', 'expectedRevision', 'operationId']);
    try {
      send(await runtime.revoke({ pairing: pairing(value.pairing), grantId: decodeURIComponent(revoke[1]!),
        expectedRevision: revision(value.expectedRevision), operationId: opId(value.operationId) }));
      return true;
    } catch (error) { fail(error); }
  }
  throw new ManagementError('not_found', '没有这个屏幕授权操作。');
}

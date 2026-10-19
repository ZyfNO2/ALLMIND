import { ManagementError } from '../contracts/management.js';
import type { PairingScope } from '../contracts/character-pack.js';
import { CompanionModeError } from '../core/companion-mode-runtime.js';
import type { CompanionTriggerRuntime } from './companion-trigger-runtime.js';

function string(value: unknown, max: number, message: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', message);
  return value.trim();
}
function pairing(value: unknown): PairingScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('invalid_request', '配对范围无效。');
  const p = value as Record<string, unknown>;
  return { userId: string(p.userId, 96, '用户标识无效。'), characterId: string(p.characterId, 64, '角色标识无效。'),
    characterInstanceId: string(p.characterInstanceId, 96, '角色实例标识无效。') };
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ManagementError('invalid_request', `不支持的触发字段：${key}`);
}
function fail(error: unknown): never {
  if (error instanceof ManagementError) throw error;
  if (error instanceof CompanionModeError) {
    const code = error.code === 'operation_conflict' ? 'version_conflict'
      : error.code === 'forbidden' ? 'forbidden' : error.code === 'not_found' ? 'not_found'
      : error.code === 'invalid_request' ? 'invalid_request' : 'unavailable';
    throw new ManagementError(code, error.message);
  }
  throw new ManagementError('unavailable', '陪伴触发未完成；屏幕内容不会写入诊断。');
}

export async function companionTriggerRoute(method: string | undefined, runtime: CompanionTriggerRuntime | undefined,
  pathname: string, query: URLSearchParams, body: () => Promise<Record<string, unknown>>, send: (value: unknown) => void): Promise<boolean> {
  if (!pathname.startsWith('/api/companion/trigger')) return false;
  if (!runtime) throw new ManagementError('unavailable', '单次陪伴触发运行时未装配。');

  if (pathname === '/api/companion/trigger') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个陪伴触发操作。');
    const value = await body();
    exactKeys(value, ['pairing', 'operationId', 'kind']);
    if (value.kind !== 'screen' && value.kind !== 'greeting') throw new ManagementError('invalid_request', '触发类型无效。');
    try { send(await runtime.trigger({ pairing: pairing(value.pairing), operationId: string(value.operationId, 200, '操作编号无效。'), kind: value.kind })); return true; }
    catch (error) { fail(error); }
  }

  const match = /^\/api\/companion\/triggers\/([^/]+)(?:\/(cancel))?$/.exec(pathname);
  if (!match) throw new ManagementError('not_found', '没有这个陪伴触发操作。');
  const triggerId = decodeURIComponent(match[1]!);
  if (match[2] === 'cancel') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个触发取消操作。');
    const value = await body(); exactKeys(value, ['pairing']);
    try { send(await runtime.cancel(triggerId, pairing(value.pairing))); return true; }
    catch (error) { fail(error); }
  }
  if (method !== 'GET') throw new ManagementError('not_found', '没有这个陪伴触发查询。');
  const scope: PairingScope = { userId: string(query.get('userId'), 96, '必须指定用户标识。'),
    characterId: string(query.get('characterId'), 64, '必须指定角色标识。'),
    characterInstanceId: string(query.get('characterInstanceId'), 96, '必须指定角色实例。') };
  try {
    const record = runtime.get(triggerId, scope);
    if (!record) throw new ManagementError('not_found', '陪伴触发不存在。');
    send(record); return true;
  } catch (error) { fail(error); }
}

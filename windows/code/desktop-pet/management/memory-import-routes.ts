import type { IncomingMessage } from 'node:http';
import type { MemoryImportManagement, MemoryImportSource } from '../contracts/memory-import.js';
import { ManagementError } from '../contracts/management.js';
import type { CharacterAdmission } from './emotion-routes.js';
import type { PairingScope } from '../contracts/character-pack.js';
const str = (value: unknown, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', '导入信息不完整或无效。');
  return value;
};
async function invoke<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof ManagementError) throw error;
    const code = (error as {code?:unknown})?.code;
    if (code === 'invalid_state' || code === 'version_conflict' || code === 'source_changed')
      throw new ManagementError('version_conflict', '导入状态或来源已变化，请刷新后核对。');
    if (code === 'invalid_source_entry' || code === 'unsupported_export' || code === 'ambiguous_project')
      throw new ManagementError('invalid_request', '来源信息无效，请核对项目位置与导出格式。');
    if (code === 'source_unavailable') throw new ManagementError('unavailable', '指定来源暂时无法读取。');
    throw error;
  }
}
export async function memoryImportRoute(req: IncomingMessage, url: URL, port: MemoryImportManagement | undefined,
  body: () => Promise<Record<string, unknown>>, send: (value: unknown) => void, admit: CharacterAdmission = () => false): Promise<boolean> {
  if (!url.pathname.startsWith('/api/memory-import')) return false;
  if (!port) throw new ManagementError('unavailable', '旧聊天导入尚未就绪。');
  const pairing = (value:unknown, characterId:string):PairingScope | undefined => {
    if (value === undefined) return undefined;
    const candidate = value as PairingScope;
    if (candidate?.characterId !== characterId) throw new ManagementError('invalid_request','导入配对域与角色不符。');
    return {characterId,userId:str(candidate.userId),characterInstanceId:str(candidate.characterInstanceId)};
  };
  if (req.method === 'GET' && url.pathname === '/api/memory-import') { const characterId = url.searchParams.get('characterId') || 'companion'; if (!admit(characterId)) throw new ManagementError('not_found', '没有这个角色。'); const owner = url.searchParams.has('userId') || url.searchParams.has('characterInstanceId') ? pairing({characterId,userId:url.searchParams.get('userId'),characterInstanceId:url.searchParams.get('characterInstanceId')},characterId) : undefined; send(await invoke(() => port.snapshot(characterId,owner))); return true; }
  if (req.method !== 'POST') throw new ManagementError('not_found', '没有这个导入操作。');
  const b = await body(), instanceId = str(b.instanceId);
  if (url.pathname === '/api/memory-import/start') {
    // RWR-02: import targets a REGISTERED character; the old check admitted the shipped role only.
    if (typeof b.characterId !== 'string' || !admit(b.characterId)) throw new ManagementError('not_found', '没有这个角色。');
    const source = b.source as Partial<MemoryImportSource> | null;
    if (!source || !['codex-project','text-export'].includes(String(source.kind))) throw new ManagementError('invalid_request', '请选择支持的聊天来源。');
    const characterId = b.characterId;
    send(await invoke(() => port.start({ instanceId, characterId, ...(b.pairing ? {pairing:pairing(b.pairing,characterId)!} : {}), operationId: str(b.operationId), source: {
      kind: source.kind!, projectName: str(source.projectName), path: str(source.path, 4096),
    } }))); return true;
  }
  if (url.pathname === '/api/memory-import/pause' || url.pathname === '/api/memory-import/resume') {
    if (!Number.isSafeInteger(b.expectedRevision) || Number(b.expectedRevision) < 1) throw new ManagementError('invalid_request', '导入版本无效，请刷新。');
    const characterId = typeof b.characterId === 'string' ? b.characterId : 'companion';
    if (!admit(characterId)) throw new ManagementError('not_found', '没有这个角色。');
    const action = { instanceId, characterId, ...(b.pairing ? {pairing:pairing(b.pairing,characterId)!} : {}), jobId: str(b.jobId), expectedRevision: Number(b.expectedRevision) };
    send(await invoke(() => url.pathname.endsWith('/pause') ? port.pause(action) : port.resume(action)));  return true;
  }
  throw new ManagementError('not_found', '没有这个导入操作。');
}

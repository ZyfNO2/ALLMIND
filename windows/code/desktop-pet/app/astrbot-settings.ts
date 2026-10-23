import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {BookError} from '../contracts/memory-book.js';

export interface AstrbotSettings {
  execution: 'local' | 'astrbot';
  baseUrl: string;
  credentialId: string;
  configId: string | null;
  instanceId: string;
  modeConfigIds?: Partial<Record<'quick'|'smart'|'rp',string>>;
}

/** File is optional. A present file with execution=astrbot is the only switch into the external executor. */
export function loadAstrbotSettings(directory: string): AstrbotSettings | null {
  const file = join(directory, 'astrbot.json');
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (cause) { throw new BookError('invalid_input', 'astrbot.json 无法解析。', {cause}); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BookError('invalid_input', 'astrbot.json 必须是对象。');
  const row = parsed as Record<string, unknown>;
  if (row.execution !== 'local' && row.execution !== 'astrbot') throw new BookError('invalid_input', 'astrbot.json execution 只能是 local 或 astrbot。');
  if (row.execution === 'local') return {execution: 'local', baseUrl: '', credentialId: '', configId: null, instanceId: ''};
  let address:URL;
  try { address=new URL(String(row.baseUrl)); } catch {throw new BookError('invalid_input','AstrBot 地址无效。');}
  if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||address.username||address.password||address.pathname!=='/'||address.search||address.hash)throw new BookError('invalid_input','AstrBot 只接受本机 HTTP 根地址。');
  if (typeof row.credentialId !== 'string' || !row.credentialId.trim()) throw new BookError('invalid_input', 'AstrBot credentialId 无效。');
  if (row.configId !== null && row.configId !== undefined && typeof row.configId !== 'string') throw new BookError('invalid_input', 'AstrBot configId 无效。');
  if (typeof row.instanceId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(row.instanceId)) throw new BookError('invalid_input', 'AstrBot instanceId 无效。');
  if(row.modeConfigIds!==undefined&&(!row.modeConfigIds||typeof row.modeConfigIds!=='object'||Array.isArray(row.modeConfigIds)||Object.entries(row.modeConfigIds).some(([key,value])=>!['quick','smart','rp'].includes(key)||typeof value!=='string'||!value||value.length>100)))throw new BookError('invalid_input','场景配置映射无效。');
  return {execution: 'astrbot', baseUrl: address.origin, credentialId: row.credentialId, configId: typeof row.configId === 'string' ? row.configId : null, instanceId: row.instanceId,...(row.modeConfigIds?{modeConfigIds:row.modeConfigIds as AstrbotSettings['modeConfigIds']&{}}:{})};
}

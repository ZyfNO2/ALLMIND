import {validateScope} from '../memory/book-validation.js';
import {assertPublicationCurrent, publicationForPairing, publicationRuntime} from '../memory/channel-publication.js';
import type {ChannelPublication} from '../contracts/book-channel.js';
import type {FileBookRepository} from '../memory/file-book-repository.js';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BookError, type BookScope} from '../contracts/memory-book.js';
import type {BookRuntime} from '../app/book-runtime.js';

export interface CapabilityBinding {
  platform: string;
  conversationKey: string;
  senderKey: string;
  characterId: string;
  pairingId: string;
  sessionId: string;
  audience: 'private' | 'public';
  publicationEntryIds: string[];
  publication?: ChannelPublication;
  mode?: 'smart' | 'quick' | 'rp';
}

interface RecordRow {
  eventKey: string;
  domain: 'reality' | 'fiction';
  answer: string;
  generation: 'completed' | 'unknown';
  delivery: 'accepted' | 'unknown' | 'failed';
  wikiWrite: false;
}

export function ensureCapabilityToken(directory: string): string {
  const file = join(directory, 'astrbot', 'capability.token');
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new BookError('invalid_input', '能力令牌文件无效。');
    return token;
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(join(directory, 'astrbot'), {recursive: true});
  writeFileSync(file, token + '\n', {mode: 0o600});
  return token;
}

function directoryOf(runtime: BookRuntime): string {
  const directory = (runtime.repository as {directory?: string}).directory;
  if (!directory) throw new BookError('unavailable', '当前存储没有能力账本目录。');
  return directory;
}

function bindingsFile(directory: string): string { return join(directory, 'astrbot', 'bindings.json'); }
function recordsFile(directory: string): string { return join(directory, 'astrbot', 'turn-records.json'); }

function readJson<T>(file: string, empty: T): T {
  if (!existsSync(file)) return empty;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), {recursive: true});
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value) + '\n', {mode: 0o600});
  renameSync(temp, file);
}

function bindingKey(row: {platform: string; conversationKey: string; senderKey: string}): string {
  return JSON.stringify([row.platform, row.conversationKey, row.senderKey]);
}

export function saveCapabilityBinding(directory: string, binding: CapabilityBinding): void {
  validateScope(binding);
  if (![binding.platform,binding.conversationKey,binding.senderKey].every(value=>typeof value==='string'&&value.length>0&&value.length<=500))throw new BookError('invalid_input','绑定身份无效。');
  if(binding.audience!=='private'&&binding.audience!=='public')throw new BookError('invalid_input','绑定范围无效。');
  if(binding.audience==='public'&&!binding.publication)throw new BookError('forbidden','公开绑定必须携带经过审核的发布快照。');
  const file = bindingsFile(directory);
  const rows = readJson<CapabilityBinding[]>(file, []);
  writeJson(file, [...rows.filter(row => bindingKey(row) !== bindingKey(binding)), binding]);
}

export function revokeCapabilityBinding(directory: string, key: {platform: string; conversationKey: string; senderKey: string}): void {
  const file = bindingsFile(directory);
  writeJson(file, readJson<CapabilityBinding[]>(file, []).filter(row => bindingKey(row) !== bindingKey(key)));
}

export async function handleAllmindCapability(runtime: BookRuntime, route: string, method: string, data: Record<string, unknown>, signal: AbortSignal, tools?:import('./book-tools.js').BookTools): Promise<unknown> {
  const directory = directoryOf(runtime);
  if (route === '/astrbot/capabilities' && method === 'GET') {
    return {protocol:'allmind-capability/v1',modules:{wiki:true,preset:'messages',memory:'review-candidates'},tools:Boolean(tools)};
  }
  if (route === '/astrbot/prepare' && method === 'POST') return prepare(runtime, directory, data, signal);
  if (route === '/astrbot/record' && method === 'POST') return record(runtime, directory, data);
  if(route.startsWith('/astrbot/task/')&&method==='POST'){
    if(!tools)throw new BookError('unavailable','本机工具扩展未安装。');
    const binding=listCapabilityBindings(directory).find(row=>bindingKey(row)===bindingKey(data as unknown as CapabilityBinding));
    if(!binding)throw new BookError('forbidden','工具主体未绑定或已撤销。');
    if(binding.audience!=='private')throw new BookError('forbidden','公开聊天无权请求本机工具。');
    const scope={characterId:binding.characterId,pairingId:binding.pairingId,sessionId:binding.sessionId};
    if(route==='/astrbot/task/status'){
      const job=tools.view(scope).jobs.find(row=>row.id===data.id);
      if(!job)throw new BookError('not_found','任务不存在或不属于此主体。');
      return {job};
    }
    if(route==='/astrbot/task/prepare'){
      if(typeof data.profileId!=='string')throw new BookError('invalid_input','需要已授权的工具连接编号。');
      // Creation only. Commit/execute is deliberately confined to the authenticated desktop UI.
      return tools.prepare(scope,{profileId:data.profileId,...(typeof data.toolName==='string'?{toolName:data.toolName}:{}),...(data.arguments&&typeof data.arguments==='object'&&!Array.isArray(data.arguments)?{arguments:data.arguments as Record<string,unknown>}:{}),...(typeof data.instruction==='string'?{instruction:data.instruction}:{})});
    }
  }
  throw new BookError('not_found', '未知的 ALLMIND 能力路由。');
}

async function prepare(runtime: BookRuntime, directory: string, data: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (typeof data.message !== 'string' || !data.message.trim()) throw new BookError('invalid_input', '能力准备缺少当前消息。');
  if (data.platform === undefined || data.conversationKey === undefined || data.senderKey === undefined) throw new BookError('invalid_input', '能力准备缺少平台、会话或发言人。');
  const binding = readJson<CapabilityBinding[]>(bindingsFile(directory), []).find(row => bindingKey(row) === bindingKey({platform: String(data.platform), conversationKey: String(data.conversationKey), senderKey: String(data.senderKey)}));
  if (!binding) throw new BookError('forbidden', '主体未绑定或授权已撤销。');
  if (data.audience !== undefined && data.audience !== binding.audience) throw new BookError('forbidden', '请求声明的范围与绑定不一致。');
  const scope: BookScope = {characterId: binding.characterId, pairingId: binding.pairingId, sessionId: binding.sessionId};
  const config=runtime.repository.loadConfig();
  let external: Parameters<BookRuntime['prepareExternal']>[4]={history:Array.isArray(data.history)?data.history:[]};
  if(binding.audience==='public'){
    if(!binding.publication)throw new BookError('forbidden','公开快照不存在。');
    assertPublicationCurrent(runtime.repository as FileBookRepository,binding.publication);
    const published=publicationForPairing(binding.publication,binding.pairingId);
    external={...external,config:publicationRuntime(binding.publication,config),snapshot:{...runtime.repository.snapshot(scope),entries:published.entries,wikiSources:published.sources}};
  }
  if(binding.mode){
    const routed=structuredClone(external.config??config),scene=routed.dialogueRouting?.profiles[binding.mode];
    const role=routed.characters.find(row=>row.id===scope.characterId);
    if(role&&scene?.presetId!==undefined){if(scene.presetId===null)delete role.promptPresetId;else role.promptPresetId=scene.presetId;}
    if(scene?.model)routed.mainModel=structuredClone(scene.model);
    if(binding.mode==='rp')routed.recall={...routed.recall,memoryDomain:'fiction',mode:'story-rp'};
    if(binding.mode==='quick')routed.recall={...routed.recall,memoryDomain:'core-only',mode:'off'};
    external.config=routed;
  }
  const prepared=await runtime.prepareExternal(scope,data.message,signal,undefined,external);
  if(typeof data.eventKey!=='string'||!/^[a-f0-9]{64}$/.test(data.eventKey))throw new BookError('invalid_input','eventKey 必须是稳定事件 SHA-256。');
  const file=join(directory,'astrbot','prepared.json');
  const rows=readJson<Record<string,unknown>[]>(file,[]);
  const identity=bindingKey(binding),bindingHash=createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  const inputHash=createHash('sha256').update(JSON.stringify([identity,data.message])).digest('hex');
  const previous=rows.find(row=>row.eventKey===data.eventKey);
  if(previous&&(previous.inputHash!==inputHash||previous.bindingHash!==bindingHash))throw new BookError('conflict','事件编号或绑定已变化。');
  const recordToken=typeof previous?.recordToken==='string'?previous.recordToken:randomBytes(32).toString('hex');
  if(!previous)writeJson(file,[...rows,{eventKey:data.eventKey,identity,inputHash,bindingHash,recordToken,scope,message:data.message,domain:binding.mode==='rp'?'fiction':'reality'}]);
  return {...prepared,audience:binding.audience,characterId:binding.characterId,historyIncluded:false,recordToken};

}

function record(runtime:BookRuntime,directory:string,data:Record<string,unknown>):unknown {
  const prepared=readJson<Record<string,unknown>[]>(join(directory,'astrbot','prepared.json'),[]).find(row=>row.eventKey===data.eventKey&&row.recordToken===data.recordToken);
  if(!prepared)throw new BookError('forbidden','没有匹配的准备回执，未写入。');
  const binding=readJson<CapabilityBinding[]>(bindingsFile(directory),[]).find(row=>bindingKey(row)===prepared.identity);
  if(!binding||createHash('sha256').update(JSON.stringify(binding)).digest('hex')!==prepared.bindingHash)throw new BookError('forbidden','绑定已修改或撤销。');
  if(binding.publication)assertPublicationCurrent(runtime.repository as FileBookRepository,binding.publication);
  if(typeof data.answer!=='string'||data.answer.length>200000)throw new BookError('invalid_input','最终回答无效。');
  if(!['completed','unknown'].includes(String(data.generation))||!['accepted','unknown','failed'].includes(String(data.delivery)))throw new BookError('invalid_input','完成或投递状态无效。');
  const file=recordsFile(directory),rows=readJson<Record<string,unknown>[]>(file,[]),prior=rows.find(row=>row.eventKey===data.eventKey);
  if(prior)return {recorded:false,duplicate:true,record:prior};
  const row={eventKey:data.eventKey,scope:prepared.scope,message:prepared.message,domain:prepared.domain,answer:data.answer,generation:data.generation,delivery:data.delivery,wikiWrite:false,review:'pending'};
  writeJson(file,[...rows,row]);return {recorded:true,duplicate:false,record:row};
}

export function listCapabilityBindings(directory:string){return readJson<CapabilityBinding[]>(bindingsFile(directory),[]);}
export function listCapabilityRecords(directory:string){return readJson<Record<string,unknown>[]>(recordsFile(directory),[]);}

import {resourceRoute} from './book-resource-routes.js';
import {GptNiangLocal} from './gpt-niang-local.js';
import {focusState} from '../core/book-focus.js';
import type {CompanionLifeState} from '../core/companion-behavior.js';
import {previewTopicForget} from '../memory/topic-forget.js';
import {saveReminder,deleteReminder} from '../core/book-reminders.js';
import type {CompanionInteractionControls} from '../contracts/companion-interactions.js';
import {weeklyReview} from '../memory/weekly-review.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash,randomBytes, randomUUID, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile,unlink } from 'node:fs/promises';
import { BookError, type RuntimeConfig, type BookEntry, type ModelBinding, type RecallMode } from '../contracts/memory-book.js';
import { BookRuntime } from '../app/book-runtime.js';
import type { ChatgptWebProbe, ChatgptWebAskResult } from '../providers/chatgpt-web-bridge.js';
import { characterUiAsset } from './character-ui-static.js';
import { validateIdentity, validateModelBinding } from '../memory/book-validation.js';
import type { BookCredentials } from './book-credentials.js';
import type { SkinManagement } from '../contracts/skin.js';
import type { PortraitStore } from './portrait-store.js';
import type { OutfitService } from './outfit-service.js';
import { writeTempImage } from './outfit-service.js';
import { DesktopHostError, type DesktopHostBridge } from '../app/desktop-host-bridge.js';
import { desktopHostManagement } from './desktop-host-routes.js';
import { skinRoute } from './skin-routes.js';
import { ManagementError } from '../contracts/management.js';
import {DESKTOP_HOST_PATCH_KEYS} from '../contracts/desktop-host.js';
import { presentationAssetRoutes } from './presentation-assets.js';
import { resolve } from 'node:path';
import { companionBudget } from '../core/book-proactive.js';
import { relationshipFor } from '../core/companion-relationship.js';
import { DEFAULT_COMPANION_SETTINGS } from '../contracts/book-companion.js';
import { TURN_REPLY_STYLES } from '../contracts/reply-length.js';
import { projectIdFromUrl, type ChatgptProjectBinding } from '../contracts/chatgpt-project.js';
import { zipWikiTask } from '../memory/wiki-task-zip.js';

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body));
};
async function body(request: IncomingMessage): Promise<Record<string, any>> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new BookError('invalid_input', '请求正文超过 2 MiB。'); chunks.push(chunk); }
  let parsed; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (cause) { throw new BookError('invalid_input', 'JSON 正文无效。', { cause }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BookError('invalid_input', '请求必须为对象。');
  return parsed;
}
/** ChatGPT web source surface exposed over management (composition injects the real bridge). */
export interface ChatgptWebManagement {
  thinking?(level?:number,model?:string):Promise<Record<string,any>>;
  inspectModels?():Promise<unknown>;
  inspectProject?(projectId:string):Promise<{projectId:string;name:string;account:string;memory:'unverified'}>;
  projectThreads?(binding:ChatgptProjectBinding|null,scope:import('../contracts/memory-book.js').BookScope):unknown;
  currentRequest?(): { requestId: string; submitted: string } | null;
  requestStatus?(requestId: string): unknown | Promise<unknown>;
  resume?(requestId: string, timeoutMs: number): Promise<ChatgptWebAskResult>;
  cancel?(requestId: string): Promise<ChatgptWebAskResult>;
  /** eval-only readiness probe: no message, no page load (RPD §3.1). */
  probe(): Promise<ChatgptWebProbe>;
  /** Open the login page once; the user completes login in their own browser. */
  openLoginPage(options?: { standalone?: boolean }): Promise<void>;
}

export async function startBookServer(options: { runtime: BookRuntime; uiRoot: string; credentials: BookCredentials; port?: number; onChatState?: (value:{state:'pending'|'completed'|'failed';scope:import('../contracts/memory-book.js').BookScope;text?:string;incognito?:boolean})=>void; onConfig?: (config: RuntimeConfig) => void | Promise<void>; onErase?: (scope:import('../contracts/memory-book.js').BookScope,turnIds:string[])=>void; companionInteractions?:CompanionInteractionControls; companionLife?: {read(characterId:string):CompanionLifeState;change(characterId:string,action:"set_enabled"|"set_quiet"|"clear_history",expectedRevision:number,enabled?:boolean):CompanionLifeState}; activity?:import('../core/book-activity.js').BookActivity; appearance?: { skins: SkinManagement; host?: DesktopHostBridge; portraits?: PortraitStore; outfits?: OutfitService }; chatgptWeb?: ChatgptWebManagement; chatgptEmbedded?: { login(): Promise<unknown>; probe(): Promise<unknown> }; chatgptPairing?: (reset?: boolean) => Promise<{ url: string; code: string; connected: boolean }> }) {
  const token = randomBytes(32).toString('hex'), instanceId = randomUUID();
  const sessionCookie = 'allmind-management-' + instanceId;
  const appearanceHost = options.appearance ? desktopHostManagement(options.appearance.host, { instanceId, skins: options.appearance.skins }) : undefined;
  const gptNiang=new GptNiangLocal();
  const previewAssets = options.appearance ? await presentationAssetRoutes(resolve(options.uiRoot, '../../..'), resolve(options.uiRoot, '../desktop')) : new Map<string, string>();
  const runtimeIdentity = { pid: process.pid, instanceId, sourceRevision: 'memory-book/v1' };
  let changingThinking=false;
  const server = createServer((request, response) => {
    const controller = new AbortController(); response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    void handle(request, response, controller.signal).catch(error => {
      if (response.destroyed) return;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      const known = error instanceof BookError || error instanceof ManagementError || error instanceof DesktopHostError;
      const code = known ? error.code : controller.signal.aborted ? 'cancelled' : timedOut ? 'timeout' : 'internal_error';
      const status = ({ invalid_input: 400, invalid_request: 400, forbidden: 403, version_conflict: 409, conflict: 409, corrupt_data: 503, not_found: 404, budget: 422, unavailable: 503, busy: 409, cancelled: 499, timeout: 503 } as Record<string, number>)[code] ?? 500;
      // Unknown internal errors retain server-side stack; never leak credentials in provider bodies.
      if (!(error instanceof BookError) && !controller.signal.aborted) process.stderr.write(`Memory Book ${code}: ${error instanceof Error ? error.stack : String(error)}\n`);
      const message = known ? error.message : timedOut ? '请求超过时限已停止；未自动重试。确认服务状态后可手动重试。' : '操作失败，详细原因已记录于本机运行日志。';
      if(response.headersSent){response.destroy();return;}
      json(response, status, { error: { code, message } });
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
    if (request.headers.host !== `127.0.0.1:${address.port}`) { json(response, 403, { error: { message: '请求 Host 无效。' } }); return; }
    const url = new URL(request.url ?? '/', address.origin), path = url.pathname;
    if (!path.startsWith('/api/')) {
      if (request.method !== 'GET') { json(response, 405, { error: { message: 'Method 不支持。' } }); return; }
      const previewAsset = previewAssets.get(path);
      if (previewAsset && !path.startsWith('/presentation-assets/')) { const content=await readFile(previewAsset);response.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/plain', 'Cache-Control': 'no-store' }); response.end(content); return; }
      const asset = characterUiAsset(options.uiRoot, path);
      if (!asset) { json(response, 404, { error: { message: '页面不可用。' } }); return; }
      // Only an address-bar/same-origin document navigation may establish a browser session.
      // Cross-site embeds, fetches and DNS rebinding must not acquire a management credential.
      if (asset.mime.startsWith('text/html') && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document' && ['none', 'same-origin'].includes(String(request.headers['sec-fetch-site'])) && (!request.headers.origin || request.headers.origin === address.origin)) {
        response.setHeader('Set-Cookie', `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/api/management-session`);
      }
      const content=await readFile(asset.path);response.writeHead(200, { 'Content-Type': asset.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); response.end(content); return;
    }
    if (path === '/api/management-session' && request.method === 'GET') {
      const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(sessionCookie + '='))?.slice(sessionCookie.length + 1) ?? '';
      const bytes = Buffer.from(cookie), expected = Buffer.from(token);
      if (request.headers['sec-fetch-site'] !== 'same-origin' || (request.headers.origin && request.headers.origin !== address.origin) || bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) { json(response, 403, { error: { message: '请在地址栏直接打开本机管理页面后重试。' } }); return; }
      json(response, 200, { token }); return;
    }
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const suppliedBytes = Buffer.from(supplied), tokenBytes = Buffer.from(token);
    if (suppliedBytes.length !== tokenBytes.length || !timingSafeEqual(suppliedBytes, tokenBytes)) { json(response, 401, { error: { message: '请从桌宠管理入口重新打开。' } }); return; }
    if (request.headers.origin && request.headers.origin !== address.origin) { json(response, 403, { error: { message: '拒绝跨来源请求。' } }); return; }
    if (path === '/api/snapshot' && request.method === 'GET') { json(response, 200, { runtime: runtimeIdentity }); return; }
    if (request.method === 'GET' && /^\/api\/skins\/[^/]+\/asset\//.test(path) && options.appearance) {
      await skinRoute(request, options.appearance.skins, path, async () => ({}), asset => { response.writeHead(200, { 'Content-Type': asset.mime, 'Cache-Control': 'no-store' }); response.end(asset.bytes); }); return;
    }
    const prefix = '/api/memory-book/v1';
    if (!path.startsWith(prefix + '/')) { json(response, 410, { error: { code: 'legacy_disabled', message: '旧功能暂未启用，请使用聊天、Memory Book 和设置。' } }); return; }
    const route = path.slice(prefix.length);
    if(route.startsWith('/resources/')||route.startsWith('/artifact-deliveries/')){const resourceScope=options.runtime.scope(url.searchParams.get('characterId')??options.runtime.repository.loadConfig().currentCharacterId,url.searchParams.get('sessionId')??'web-chat',url.searchParams.get('pairingId')??'local-user');if(await resourceRoute(request,response,route,url,resourceScope,options.runtime,signal,()=>body(request)))return;}
    const data = request.method === 'GET' ? {} : await body(request);
    if (route === '/runtime') {
      if (request.method === 'GET') { json(response, 200, { config: options.runtime.repository.loadConfig(), capabilities: { storage: 'local-file', semantic: false, regex: false }, runtime: runtimeIdentity }); return; }
      if (request.method === 'PUT') {
        if(changingThinking)throw new BookError('busy','思考强度设置尚未结束，不能同时修改配置。');
        const previousCompanion = options.runtime.repository.loadConfig().companion;
        const previousSource = options.runtime.repository.loadConfig().chatgptWeb;
        if (options.chatgptWeb?.currentRequest?.() && (JSON.stringify(data.config?.chatgptWeb) !== JSON.stringify(previousSource) || JSON.stringify(data.config?.chatgptProjects) !== JSON.stringify(options.runtime.repository.loadConfig().chatgptProjects) || data.config?.currentCharacterId !== options.runtime.repository.loadConfig().currentCharacterId)) throw new BookError('busy', '网页请求尚未确认结束，不能修改其连接来源、角色或项目绑定；请先接续读取或确认停止。');
        const previousCharacters = options.runtime.repository.loadConfig().characters;
        const receipt = options.runtime.repository.commitConfig(data.config as RuntimeConfig, data.expectedRevision, data.operationId);
        const savedConfig = options.runtime.repository.loadConfig();
        for (const role of previousCharacters) if (!savedConfig.characters.some(current => current.id === role.id)) options.runtime.removeCharacterResources(role.id);
        if (!previousCompanion?.proactive && savedConfig.companion?.proactive) options.runtime.userInteraction(options.runtime.scope(savedConfig.currentCharacterId,'web-chat'));
        for (const id of new Set([...previousCharacters, ...options.runtime.repository.loadConfig().characters].map(role => role.id))) options.runtime.invalidate(id);
        let activationError: string | null = null;
        try { await options.onConfig?.(options.runtime.repository.loadConfig()); }
        catch (error) { activationError = error instanceof Error ? error.message : String(error); process.stderr.write(`Memory Book settings saved; activation failed: ${activationError}\n`); }
        json(response, 200, { receipt, config: options.runtime.repository.loadConfig(), activationError }); return;
      }
    }
    if (route === '/credentials' && request.method === 'POST') { options.credentials.save(data.id, data.value); json(response, 200, { saved: true }); return; }
    if (route === '/models' && request.method === 'POST') {
      let endpoint: URL;
      try { endpoint = new URL(data.baseUrl); } catch { throw new BookError('invalid_input', '模型端点无效。'); }
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new BookError('invalid_input', '端点必须使用 HTTPS 或回环 HTTP，不能含凭据或查询参数。');
      validateIdentity(data.credentialId, 'credentialId');
      if (data.apiKey !== undefined && (typeof data.apiKey !== 'string' || data.apiKey.length > 8192 || /[\r\n]/.test(data.apiKey))) throw new BookError('invalid_input', 'API Key 格式无效。');
      const key = data.apiKey || await options.credentials.get(data.credentialId);
      endpoint.pathname = endpoint.pathname.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/models';
      const upstream = await fetch(endpoint, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error', headers: key ? { Authorization: `Bearer ${key}` } : {} });
      if (!upstream.ok) { await upstream.body?.cancel(); throw new BookError('unavailable', `获取模型失败（HTTP ${upstream.status}）。`); }
      const reader = upstream.body?.getReader(); if (!reader) throw new BookError('unavailable', '模型列表为空。');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new BookError('unavailable', '模型列表超过 2 MiB。'); } chunks.push(part.value); } } finally { reader.releaseLock(); }
      let parsed; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BookError('unavailable', '服务返回的模型列表不是 JSON。'); }
      if (!Array.isArray(parsed.data) || parsed.data.length > 4096 || parsed.data.some((item: any) => typeof item?.id !== 'string' || !item.id.trim() || item.id.length > 200)) throw new BookError('unavailable', '服务返回的模型列表格式无效。');
      json(response, 200, { models: [...new Set(parsed.data.map((item: { id: string }) => item.id))] }); return;
    }
    if (route === '/models/test' && request.method === 'POST') {
      // One explicit, minimal real chat request. A draft binding/key is used transiently: nothing is
      // saved, no recall runs, no history is written, and the response never echoes the key.
      const binding = data.binding as ModelBinding;
      validateModelBinding(binding);
      // ChatGPT web drafts select the browser source, not an HTTP endpoint: the URL rules do not apply.
      if (binding.kind !== 'chatgpt-web') {
        const endpoint = new URL(binding.baseUrl);
        if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new BookError('invalid_input', '端点必须使用 HTTPS 或回环 HTTP，不能含凭据或查询参数。');
      }
      if (data.apiKey !== undefined && data.apiKey !== null && data.apiKey !== '' && (typeof data.apiKey !== 'string' || data.apiKey.length > 8192 || /[\r\n]/.test(data.apiKey))) throw new BookError('invalid_input', 'API Key 格式无效。');
      if (data.prompt !== undefined && data.prompt !== null && (typeof data.prompt !== 'string' || data.prompt.length > 2000 || data.prompt.includes('\0'))) throw new BookError('invalid_input', '测试消息无效。');
      // Web drafts include the page connect overhead (~10–25s measured): 30s would abort a
      // request that is already generating server-side, so the web test waits generously.
      const testBudgetMs = binding.kind === 'chatgpt-web' ? 150_000 : 30_000;
      const testSignal = AbortSignal.any([signal, AbortSignal.timeout(testBudgetMs)]);
      if(data.debugSessionId!==undefined)validateIdentity(data.debugSessionId,'debugSessionId');
      json(response, 200, await options.runtime.testModel(binding, { ...(data.prompt ? { prompt: data.prompt } : {}), ...(data.apiKey ? { apiKey: data.apiKey } : {}), ...(data.debugSessionId?{debugSessionId:data.debugSessionId}:{}), signal: testSignal }));
      return;
    }
    // ChatGPT web source readiness/login (RPD §3.1): status is a zero-cost eval-only probe; login
    // opens the page once on an explicit user action. Neither sends a chat message.
    const webReceipt = /^\/chatgpt-web\/requests\/([^/]+)(?:\/(resume|cancel))?$/.exec(route);
    if (webReceipt) {
      const requestId = webReceipt[1]!; validateIdentity(requestId, 'requestId');
      const bridge = options.chatgptWeb;
      if (!bridge) throw new BookError('unavailable', '当前实例未装配网页来源。');
      if (!webReceipt[2] && request.method === 'GET' && bridge.requestStatus) { json(response, 200, await bridge.requestStatus(requestId)); return; }
      if (webReceipt[2] === 'resume' && request.method === 'POST' && bridge.resume) { json(response, 200, await bridge.resume(requestId, 120000)); return; }
      if (webReceipt[2] === 'cancel' && request.method === 'POST' && bridge.cancel) { json(response, 200, await bridge.cancel(requestId)); return; }
      throw new BookError('unavailable', '该网页来源不支持此回执操作。');
    }
    if (route === '/chatgpt-web/active-request' && request.method === 'GET') {
      json(response,200,{activeRequest:options.chatgptWeb?.currentRequest?.()??null});return;
    }
    if (route === '/chatgpt-web/status' && request.method === 'GET') {
      if (!options.chatgptWeb) throw new BookError('unavailable', '当前实例未装配 ChatGPT 网页来源。');
      json(response, 200, await options.chatgptWeb.probe());
      return;
    }
    if(route==='/chatgpt-web/thinking'&&(request.method==='GET'||request.method==='POST')){
      if(!options.chatgptWeb?.thinking)throw new BookError('unavailable','当前实例不支持思考强度。');
      if(options.chatgptWeb.currentRequest?.())throw new BookError('busy','生成中不能切换思考强度。');
      if(changingThinking)throw new BookError('busy','思考强度设置尚未结束。');
      const config=options.runtime.repository.loadConfig();
      const thinkingBinding=config.mainModel?.kind==='chatgpt-web'?config.mainModel:config.wikiModel?.kind==='chatgpt-web'?config.wikiModel:null;
      if(!thinkingBinding)throw new BookError('unavailable','思考强度需要 ChatGPT 主回复或整理模型。');
      if(request.method==='GET'){json(response,200,{...await options.chatgptWeb.thinking(undefined,thinkingBinding.model),revision:config.revision});return;}
      if(!Number.isSafeInteger(data.level)||data.level<0||data.level>8||data.expectedRevision!==config.revision||typeof data.operationId!=='string')throw new BookError('conflict','思考强度或配置修订无效，请刷新选项。');
      validateIdentity(data.operationId,'operationId');
      if(Object.keys(data).some(key=>!['level','expectedRevision','operationId'].includes(key)))throw new BookError('invalid_input','思考强度设置字段无效。');
      changingThinking=true;
      try{
        const actual=await options.chatgptWeb.thinking(data.level,thinkingBinding.model);
        if(actual.level!==data.level)throw new BookError('unavailable','网页没有确认所选思考强度，未保存。');
        const receipt=options.runtime.repository.commitConfig({...config,chatgptWeb:{...config.chatgptWeb!,thinkingLevel:data.level}},config.revision,data.operationId);
        await options.onConfig?.(options.runtime.repository.loadConfig());
        json(response,200,{...actual,revision:receipt.revision});return;
      }finally{changingThinking=false;}
    }
    if(route==='/chatgpt-web/models' && request.method==='GET'){
      if(!options.chatgptWeb?.inspectModels)throw new BookError('unavailable','当前来源不支持模型菜单检查。');
      json(response,200,await options.chatgptWeb.inspectModels());return;
    }
    if(route==='/chatgpt-web/backend/restart' && request.method==='POST'){
      if(options.chatgptWeb?.currentRequest?.())throw new BookError('busy','有未决请求，不重启。');
      if(!options.appearance?.host)throw new BookError('unavailable','没有桌面宿主。');
      json(response,200,await options.appearance.host.request('app.restart',{}));return;
    }
    if(route==='/chatgpt-web/projects/check' && request.method==='POST'){
      if(!options.chatgptWeb?.inspectProject)throw new BookError('unavailable','当前实例不支持项目检查。');
      if(typeof data.url!=='string')throw new BookError('invalid_input','项目链接缺失。');
      json(response,200,await options.chatgptWeb.inspectProject(projectIdFromUrl(data.url)));return;
    }
    if(route==='/chatgpt-web/projects/thread' && request.method==='GET'){
      const scope=options.runtime.scope(url.searchParams.get('characterId')??options.runtime.repository.loadConfig().currentCharacterId,url.searchParams.get('sessionId')??'desktop');
      const binding=options.runtime.repository.loadConfig().chatgptProjects?.find(row=>row.characterId===scope.characterId&&row.pairingId===scope.pairingId);
      json(response,200,{binding:binding??null,thread:options.chatgptWeb?.projectThreads?.(binding??null,scope)??null});return;
    }
    if (route === '/chatgpt-web/embedded/login' && request.method === 'POST') {
      if(!options.chatgptEmbedded)throw new BookError('unavailable','当前实例没有独立页面宿主。');
      if(options.runtime.repository.loadConfig().chatgptWeb?.transport==='embedded' && options.chatgptWeb?.currentRequest?.())throw new BookError('busy','当前独立页面有未确认请求，请先结束。');
      await options.chatgptEmbedded.login();json(response,200,{opened:true,note:'独立登录面板已准备，请自行登录；当前模型来源没有切换。'});return;
    }
    if (route === '/chatgpt-web/embedded/status' && request.method === 'GET') {
      if(!options.chatgptEmbedded)throw new BookError('unavailable','当前实例没有独立页面宿主。');
      json(response,200,await options.chatgptEmbedded.probe());return;
    }
    if (route === '/chatgpt-web/pairing' && request.method === 'POST') {
      if (!options.chatgptPairing) throw new BookError('unavailable', '当前实例未装配 Chat bridge。');
      if (data.reset === true && options.chatgptWeb?.currentRequest?.()) throw new BookError('busy', '网页请求尚未确认结束，不能更换浏览器配置。');
      json(response, 200, await options.chatgptPairing(data.reset === true)); return;
    }
    if (route === '/chatgpt-web/login' && request.method === 'POST') {
      if (!options.chatgptWeb) throw new BookError('unavailable', '当前实例未装配 ChatGPT 网页来源。');
      await options.chatgptWeb.openLoginPage({ ...(data.standalone === true ? { standalone: true } : {}) });
      json(response, 200, { opened: true, note: options.runtime.repository.loadConfig().chatgptWeb?.transport === 'embedded' ? '已打开 ALLMIND 独立登录面板，请自行登录；不会读取个人 Chrome 的登录资料。' : '已检查配对后台 Chat 标签，请刷新来源状态。' });
      return;
    }
    const characterId = url.searchParams.get('characterId') ?? data.characterId ?? options.runtime.repository.loadConfig().currentCharacterId;
    const sessionId = url.searchParams.get('sessionId') ?? data.sessionId ?? 'web-chat';
    validateIdentity(characterId, 'characterId'); validateIdentity(sessionId, 'sessionId');
    const scope = options.runtime.scope(characterId, sessionId, url.searchParams.get('pairingId') ?? data.pairingId ?? 'local-user');
    const knowledgeView = options.runtime.repository.loadConfig().characters.find(role => role.id === characterId)?.knowledgeView;
    if (route.startsWith('/wiki/synthesis')) {
      const synthesis=options.runtime.synthesis;
      if(route==='/wiki/synthesis'&&request.method==='GET'){json(response,200,{jobs:synthesis.list(scope)});return;}
      if(route==='/wiki/synthesis/prepare'&&request.method==='POST'){json(response,200,{job:synthesis.prepare(scope,data.expectedRevision,data.operationId)});return;}
      if(route==='/wiki/synthesis/package'&&request.method==='POST'){const bundle=synthesis.package(scope,data.jobId);json(response,200,{...bundle,zipBase64:zipWikiTask(bundle.files).toString('base64')});return;}
      if(route==='/wiki/synthesis/run'&&request.method==='POST'){json(response,200,{job:await synthesis.run(scope,data.jobId,signal,data.budgetMs,data.confirmedSend)});return;}
      if(route==='/wiki/synthesis/cancel'&&request.method==='POST'){json(response,200,{job:synthesis.cancel(scope,data.jobId)});return;}
      if(route==='/wiki/synthesis/resume'&&request.method==='POST'){json(response,200,{job:await synthesis.resume(scope,data.jobId,signal,data.confirmed)});return;}
      if(route==='/wiki/synthesis/apply'&&request.method==='POST'){const receipt=synthesis.apply(scope,data.jobId,data.expectedRevision,data.operationId,data.confirmed);json(response,200,{receipt,book:options.runtime.repository.snapshot(scope)});return;}
    }
    if(route==='/services/status'&&request.method==='GET'){
      const config=options.runtime.repository.loadConfig(),book=options.runtime.repository.snapshot(scope),repository=options.runtime.repository as import('../memory/file-book-repository.js').FileBookRepository,ledger=repository.loadCompanionData(scope),binding=config.wikiModel??config.fastModel;
      json(response,200,{local:{state:'readable',revision:book.revision},reply:{state:config.mainModel?'configured_unchecked':'unconfigured',model:config.mainModel?.model??null},memory:{enabled:config.companion?.autoMemory??false,mode:config.companion?.extraction??'declarations',state:config.companion?.extraction==='model'&&!binding?'unconfigured':binding?'configured_unchecked':'local_rules',model:binding?.model??null,paused:ledger.memoryPaused??false,failed:ledger.jobs.filter(job=>job.status==='failed').length,pending:ledger.jobs.filter(job=>['pending','running'].includes(job.status)).length},checkedAt:new Date().toISOString()});return;
    }
    if(route.startsWith('/companion') || route.startsWith('/memory/topic-') || route==='/memory/erase' || route==='/memory/backup' || route==='/memory/relearn') {
      const repository=options.runtime.repository as import('../memory/file-book-repository.js').FileBookRepository;
      if(typeof repository.loadCompanionData!=='function')throw new BookError('unavailable','当前存储不支持陪伴账本。');
      if(route==='/companion/keyboard'&&request.method==='GET'){
        if(!options.activity)throw new BookError('unavailable','此运行方式未连接键盘活动来源。');json(response,200,options.activity.view(scope.characterId));return;
      }
      if(route==='/companion/keyboard'&&request.method==='POST'){
        if(!options.activity)throw new BookError('unavailable','此运行方式未连接键盘活动来源。');
        if(data.action==='enable')await options.activity.enable(scope.characterId,data.enabled);
        else if(data.action==='delete')await options.activity.remove(scope.characterId,data.day);
        else throw new BookError('invalid_input','未知键盘活动操作。');
        json(response,200,options.activity.view(scope.characterId));return;
      }
      if(route==='/companion/weekly-review'&&request.method==='GET'){json(response,200,weeklyReview(repository,scope));return;}
      if(route==='/companion/interactions'&&request.method==='GET'){json(response,200,options.companionInteractions?.read(scope)??{available:false,reason:'此运行方式未连接实际桌面互动消费者。'});return;}
      if(route==='/companion/interactions/settings'&&request.method==='POST'){
        if(!options.companionInteractions)throw new BookError('unavailable','未连接实际桌面互动消费者。');
        json(response,200,options.companionInteractions.configure(scope,data.settings,data.expectedRevision));return;
      }
      if(route==='/companion/interactions/play'&&request.method==='POST'){
        if(!options.companionInteractions)throw new BookError('unavailable','未连接实际桌面互动消费者。');
        json(response,200,await options.companionInteractions.perform(scope,data.kind,data.id,data.expectedRevision,signal));return;
      }
      if(route==='/companion/interactions/undo'&&request.method==='POST'){
        if(!options.companionInteractions)throw new BookError('unavailable','未连接实际桌面互动消费者。');
        json(response,200,await options.companionInteractions.undo(scope,data.id));return;
      }
      if(route==='/companion/reminders'&&request.method==='POST'){
        if(data.confirmed!==true)throw new BookError('invalid_input','请明确确认提醒设置。');
        const previous=repository.loadCompanionData(scope),pending=previous.deliveries.some(row=>row.reminderRef?.id===data.reminder?.id&&['reserved','dispatched'].includes(row.status));
        const saved=saveReminder(repository,scope,data.reminder,data.expectedReminderRevision);if(pending&&saved.revision!==previous.revision)options.runtime.cancelProactive(characterId);json(response,200,saved);return;
      }
      if(route==='/companion/reminders'&&request.method==='DELETE'){
        const previous=repository.loadCompanionData(scope),pending=previous.deliveries.some(row=>row.reminderRef?.id===data.id&&['reserved','dispatched'].includes(row.status));
        const saved=deleteReminder(repository,scope,data.id,data.expectedReminderRevision);if(pending&&saved.revision!==previous.revision)options.runtime.cancelProactive(characterId);json(response,200,saved);return;
      }
      if(route==='/companion/weekly-review/narrative'&&request.method==='POST'){json(response,200,await options.runtime.narrateWeek(scope,{expectedRevision:data.expectedRevision,confirmed:data.confirmed},signal));return;}
      if(route==='/memory/topic-preview'&&request.method==='POST'){json(response,200,previewTopicForget(repository.snapshot(scope),scope,data.topic));return;}
      if(route==='/memory/topic-forget'&&request.method==='POST'){
        if(data.confirmed!==true||!Array.isArray(data.entryIds)||!data.entryIds.length||data.entryIds.length>256||new Set(data.entryIds).size!==data.entryIds.length)throw new BookError('invalid_input','请预览并明确确认话题遗忘范围。');
        for(const id of data.entryIds)validateIdentity(id,'entryId');
        if(!repository.hasBookOperation(scope,data.operationId)){
          const preview=previewTopicForget(repository.snapshot(scope),scope,data.topic);
          if(preview.expectedRevision!==data.expectedRevision||JSON.stringify(preview.entries.map(entry=>entry.id))!==JSON.stringify(data.entryIds))throw new BookError('conflict','话题范围已改变，请重新预览后确认；没有执行删除。');
        }
        const receipt=repository.commit(scope,{remove:data.entryIds},data.expectedRevision,data.operationId);options.runtime.invalidate(characterId);json(response,200,{receipt,book:repository.snapshot(scope)});return;
      }
      if(route==='/companion/life'&&(request.method==='GET'||request.method==='POST')){
        if(!options.companionLife)throw new BookError('unavailable','当前运行方式未连接桌宠生活状态。');
        if(request.method==='GET'){json(response,200,options.companionLife.read(scope.characterId));return;}
        if(!['set_enabled','set_quiet','clear_history'].includes(data.action)||!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<0)throw new BookError('invalid_input','桌宠操作或状态修订无效。');
        if(data.action==='clear_history'?data.confirmed!==true:typeof data.enabled!=='boolean')throw new BookError('invalid_input','请确认清理或明确开关状态。');
        json(response,200,options.companionLife.change(scope.characterId,data.action,data.expectedRevision,data.enabled));return;
      }
      if(route==='/companion'&&request.method==='GET'){const ledger=focusState(repository,scope);json(response,200,{...ledger,relationship:relationshipFor(repository.snapshot(scope),scope),budget:companionBudget(ledger,repository.loadConfig().companion??DEFAULT_COMPANION_SETTINGS),transientError:options.runtime.memoryFailure(scope)});return;}
      if(route==='/companion/resume'&&request.method==='POST'){options.runtime.userInteraction(scope);json(response,200,{resumed:true});return;}
      if(route==='/companion/focus'&&request.method==='POST'){options.runtime.setFocus(scope,data.enabled,data.minutes,Date.now(),data.action);json(response,200,repository.loadCompanionData(scope));return;}
      if(route==='/companion/favorites'&&request.method==='GET'){
        const ledger=repository.loadCompanionData(scope),visible=new Set(repository.snapshot(scope).entries.map(entry=>entry.id));json(response,200,{revision:ledger.revision,ids:(ledger.favorites??[]).filter(id=>visible.has(id))});return;
      }
      if(route==='/companion/favorites'&&request.method==='PUT'){
        validateIdentity(data.entryId,'entryId');if(typeof data.favorite!=='boolean')throw new BookError('invalid_input','请明确收藏或取消。');
        const ledger=repository.loadCompanionData(scope);if(data.expectedRevision!==ledger.revision)throw new BookError('conflict','收藏状态已改变，请回读当前状态。');
        if(!repository.snapshot(scope).entries.some(entry=>entry.id===data.entryId))throw new BookError('not_found','条目不存在或不属于当前实例。');
        ledger.favorites=[...new Set([...(ledger.favorites??[]).filter(id=>id!==data.entryId),...(data.favorite?[data.entryId]:[])])];
        const next=repository.saveCompanionData(scope,ledger);json(response,200,{revision:next.revision,ids:next.favorites??[]});return;
      }
      if(route==='/companion/memory-pause'&&request.method==='POST'){
        if(typeof data.paused!=='boolean')throw new BookError('invalid_input','请明确暂停或恢复入库。');
        if(data.paused)await options.runtime.wikiMaintenance?.pause(scope);
        await options.runtime.automaticMemory!.setPaused(scope,data.paused);json(response,200,repository.loadCompanionData(scope));return;
      }
      if(route==='/memory/relearn'&&request.method==='POST'){json(response,200,options.runtime.rememberNewFact(scope,data.fact,data.expectedRevision));return;}
      if(route==='/companion/retry'&&request.method==='POST'){options.runtime.automaticMemory!.retry(scope,data.jobId);json(response,200,{queued:true});return;}
      if(route==='/companion/approve'&&request.method==='POST'){options.runtime.automaticMemory!.approve(scope,data.jobId,data.eventId);json(response,200,{book:repository.snapshot(scope)});return;}
      if(route==='/companion/reject'&&request.method==='POST'){
        const ledger=repository.loadCompanionData(scope),job=ledger.jobs.find(job=>job.id===data.jobId);
        if(!job||job.status!=='review')throw new BookError('invalid_input','待审阅任务不存在。');job.status='cancelled';job.claims=[];repository.saveCompanionData(scope,ledger);json(response,200,{rejected:true});return;
      }
      if(route==='/memory/erase'&&request.method==='POST'){
        if(data.eraseRaw!==true)throw new BookError('invalid_input','请明确选择清除原文及应用管理的本实例备份。');
        options.runtime.clearSensitiveCaches(characterId);const receipt=repository.eraseTurns(scope,data.turnIds,data.expectedRevision);options.onErase?.(scope,data.turnIds);json(response,200,{receipt,book:repository.snapshot(scope),turns:repository.readSession(scope)});return;
      }
      if(route==='/memory/backup'&&request.method==='POST'){json(response,200,repository.exportPrivate(scope));return;}
    }
    if (route === '/memory/remember' && request.method === 'POST') {
      const receipt = options.runtime.rememberTurn(scope, data.turnId, data.expectedRevision, data.operationId);
      json(response, 200, { receipt, book: options.runtime.repository.snapshot(scope) }); return;
    }
    if (route === '/state' && request.method === 'GET') { json(response, 200, options.runtime.state.view(scope)); return; }
    if (route === '/state/preview' && request.method === 'POST') { json(response, 200, options.runtime.state.preview(scope, data.proposal)); return; }
    if (route === '/state/initialize' && request.method === 'POST') { json(response, 200, options.runtime.state.initialize(scope, data.templateId)); return; }
    if (route === '/state/apply' && request.method === 'POST') {
      const receipt = options.runtime.state.apply(scope, data.previewId, data.operationId, signal); options.runtime.invalidate(characterId);
      json(response, 200, { receipt, book: options.runtime.repository.snapshot(scope) }); return;
    }
    if (route === '/wiki/reader' && request.method === 'GET') {
      let view = knowledgeView;
      const worldId = url.searchParams.get('worldId');
      const branch = url.searchParams.get('branch');
      const cutoff = Number(url.searchParams.get('cutoff'));
      if(worldId!==null||branch!==null||url.searchParams.has('cutoff')){
        if(!view||worldId!==view.worldId||branch!==view.branch||!url.searchParams.has('cutoff')||!Number.isSafeInteger(cutoff)||cutoff<0||cutoff>view.cutoff)throw new BookError('invalid_input','阅读范围必须在当前角色已配置的世界、分支和截止章节内。');
        view={...view,cutoff};
      }
      const limit = url.searchParams.get('limit');
      json(response, 200, options.runtime.readWiki(scope, { ...(url.searchParams.get('pageId') ? { pageId: url.searchParams.get('pageId')! } : {}), ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}), ...(view ? { view } : {}), ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}), ...(limit ? { limit: Number(limit) } : {}) }));
      return;
    }
    if (route === '/wiki' && request.method === 'GET') { json(response, 200, options.runtime.wiki.pages(scope, knowledgeView)); return; }
    if(route.startsWith('/wiki/compilation')){
      const maintenance=options.runtime.wikiMaintenance;
      if(!maintenance)throw new BookError('unavailable','当前 Book 不支持持久编纂任务。');
      if(route==='/wiki/compilation'&&request.method==='GET'){json(response,200,{jobs:maintenance.list(scope),revision:options.runtime.repository.snapshot(scope).revision});return;}
      if(route==='/wiki/compilation/queue'&&request.method==='POST'){json(response,200,{job:maintenance.queue(scope,data.pageIds,data.operationId)});return;}
      if(route==='/wiki/compilation/run'&&request.method==='POST'){json(response,200,{job:await maintenance.run(scope,data.jobId,signal)});return;}
      if(route==='/wiki/compilation/cancel'&&request.method==='POST'){json(response,200,{job:maintenance.cancel(scope,data.jobId)});return;}
      if(route==='/wiki/compilation/apply'&&request.method==='POST'){
        if(data.confirmed!==true)throw new BookError('invalid_input','请核对综合草稿与事实来源后明确确认。');
        const receipt=maintenance.apply(scope,data.jobId,data.expectedRevision,data.operationId);json(response,200,{receipt,book:options.runtime.repository.snapshot(scope)});return;
      }
    }
    if (route === '/wiki/graph' && request.method === 'GET') {
      const category=url.searchParams.get('category')??'';
      if(category&&!['world','persona','knowledge','companion'].includes(category))throw new BookError('invalid_input','知识分类无效。');
      const text=url.searchParams.get('q')??'';
      const range=url.searchParams.get('range')??'known';if(range!=='known'&&range!=='management')throw new BookError('invalid_input','图谱范围无效。');
      const selection={...(category?{category:category as 'world'|'persona'|'knowledge'|'companion'}:{}),...(text?{text}:{}),range:range as 'known'|'management'};
      json(response,200,options.runtime.wiki.graph(scope,knowledgeView,url.searchParams.get('includeUnlinked')==='true',url.searchParams.has('timeBasis')?{basis:url.searchParams.get('timeBasis') as import('../memory/book-time-filter.js').EntryTimeFilter['basis'],from:url.searchParams.get('from')??'',to:url.searchParams.get('to')??'',timezone:options.runtime.repository.loadConfig().companion?.timezone??'Asia/Singapore'}:undefined,selection));return;
    }
    if (route === '/wiki/query' && request.method === 'GET') { json(response,200,options.runtime.wiki.query(scope,url.searchParams.get('query')??'',knowledgeView));return; }
    if (route === '/wiki/refresh' && request.method === 'POST') {
      const receipt=options.runtime.repository.commit(scope,{upsert:[]},data.expectedRevision,data.operationId);options.runtime.invalidate(characterId);
      json(response,200,{receipt,book:options.runtime.repository.snapshot(scope),...options.runtime.wiki.pages(scope,knowledgeView)});return;
    }
    if (route === '/wiki/lint' && request.method === 'GET') { json(response, 200, options.runtime.wiki.lint(scope, knowledgeView)); return; }
    if (route === '/wiki/preview' && request.method === 'POST') {
      let source = data.source;
      if (data.turnId) {
        const turn = options.runtime.repository.readSession(scope).find(turn => turn.id === data.turnId);
        if (!turn) throw new BookError('not_found', '当前会话的真实聊天不存在。');
        source = { sourceId: `turn.${turn.id}`, title: '用户', text: turn.user, private: true, uri:`turn:${scope.sessionId}:${turn.id}` };
      }
      if (!source || typeof source !== 'object') throw new BookError('invalid_input', '缺 Wiki 来源。');
      json(response, 200, await options.runtime.previewWiki(scope, source, data.mode ?? 'declarations', signal)); return;
    }
    if (route === '/wiki/apply' && request.method === 'POST') {
      const receipt = options.runtime.wiki.apply(scope, data.previewId, data.operationId); options.runtime.invalidate(characterId);
      json(response, 200, { receipt, book: options.runtime.repository.snapshot(scope) }); return;
    }
    if (route === '/wiki/revoke' && request.method === 'POST') {
      const receipt = options.runtime.wiki.revoke(scope, data.sourceId, data.expectedRevision, data.operationId); options.runtime.invalidate(characterId);
      json(response, 200, { receipt, book: options.runtime.repository.snapshot(scope) }); return;
    }
    if (route === '/sessions/archive' && request.method === 'POST') {
      if (!options.runtime.repository.setSessionArchived) throw new BookError('unavailable', '当前存储不支持会话归档。');
      options.runtime.repository.setSessionArchived(scope, data.archived);
      json(response, 200, { sessions: options.runtime.repository.listSessions(characterId, scope.pairingId) }); return;
    }
    if (route === '/sessions' && request.method === 'GET') {
      // Session summaries derived from persisted turns: refresh here discovers every session of this
      // character/pairing (including the desktop pet's shared session) without a second index.
      json(response, 200, { sessions: options.runtime.repository.listSessions(characterId, scope.pairingId) });
      return;
    }
    const organizationOp=/^\/wiki\/organization\/operations\/([a-zA-Z0-9._-]+)$/.exec(route);if(organizationOp&&request.method==='GET'){json(response,200,options.runtime.organization.operation(scope,organizationOp[1]!));return;}
    if (route === '/wiki/organization/preview' && request.method === 'POST') { json(response, 200, await options.runtime.organization.preview(scope, data as import('../contracts/wiki-organization.js').OrganizationInput, signal)); return; }
    if (/^\/wiki\/organization\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(route) && request.method === 'GET') { json(response, 200, options.runtime.organization.get(scope, route.slice('/wiki/organization/'.length))); return; }
    if (route === '/wiki/organization/apply' && request.method === 'POST') {
      const applied = options.runtime.organization.apply(scope, { previewId: data.previewId, expectedRevision: data.expectedRevision, operationId: data.operationId, decisions: data.decisions }, signal);
      options.runtime.invalidate(characterId); json(response, 200, applied); return;
    }
    if(route==='/appearance/gpt-niang'&&request.method==='POST'){
      json(response,200,await gptNiang.inspect(characterId,data.sourceRoot));return;
    }
    const gptPortrait=/^\/appearance\/gpt-niang\/([a-zA-Z0-9-]+)\/image$/.exec(route);
    if(gptPortrait&&request.method==='GET'){
      const bytes=await gptNiang.portrait(characterId,gptPortrait[1]!);
      response.writeHead(200,{'Content-Type':bytes.subarray(0,4).toString()==='RIFF'?'image/webp':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(bytes);return;
    }
    if(route==='/appearance/gpt-niang/import'&&request.method==='POST'){
      const portraits=options.appearance?.portraits;if(!portraits)throw new BookError('unavailable','当前实例未接入静态立绘。');
      const bytes=await gptNiang.portrait(characterId,data.portraitId),hash=createHash('sha256').update(bytes).digest('hex');
      const file=await writeTempImage(bytes,bytes.subarray(0,4).toString()==='RIFF'?'image/webp':'image/png');
      const role=options.runtime.repository.loadConfig().characters.find(row=>row.id===characterId)!;
      const fallback=role.appearanceSkinId??(role.appearancePath?'book-'+createHash('sha256').update(resolve(role.appearancePath)).digest('hex').slice(0,20):null);
      try{json(response,200,await portraits.add({characterId,name:data.name??'GPT 龙娘',file,origin:'user_import',contentHash:hash,operationId:data.operationId,expectedRevision:data.expectedRevision,currentSkinId:fallback}));}finally{await unlink(file);}return;
    }
    if (route === '/appearance/portraits' && request.method === 'GET') {
      if (!options.appearance?.portraits) throw new BookError('unavailable', '当前实例未接入静态立绘。');
      json(response, 200, options.appearance.portraits.get(characterId)); return;
    }
    if (route === '/appearance/portraits' && request.method === 'POST') {
      const portraits = options.appearance?.portraits; if (!portraits) throw new BookError('unavailable', '当前实例未接入静态立绘。');
      const record = options.runtime.resources.get(scope, data.resourceId);
      if (record.state !== 'ready' || record.kind !== 'image' || record.sha256 !== data.sha256) throw new BookError('conflict', '立绘资源不可用。');
      const bytes = await options.runtime.resources.readBytes(scope, data.resourceId, signal);
      const file = await writeTempImage(bytes, record.mime ?? 'image/png');
      const role=options.runtime.repository.loadConfig().characters.find(row=>row.id===characterId)!;
      const fallback=role.appearanceSkinId??(role.appearancePath?'book-'+createHash('sha256').update(resolve(role.appearancePath)).digest('hex').slice(0,20):null);
      try{json(response, 200, await portraits.add({ characterId, name: data.name ?? '静态立绘', file, origin: 'user_import',contentHash:record.sha256!, operationId: data.operationId, expectedRevision: data.expectedRevision, currentSkinId:fallback }));}finally{await unlink(file);} return;
    }
    if (route === '/appearance/portraits/select' && request.method === 'POST') {
      const portraits = options.appearance?.portraits; if (!portraits) throw new BookError('unavailable', '当前实例未接入静态立绘。');
      const set = await portraits.select(characterId, data.variantId, data.expectedRevision, data.operationId);
      const variant = set.variants.find(item => item.id === set.selectedVariantId);
      void variant;
      json(response, 200, set); return;
    }
    if (route === '/appearance/portraits/framing' && request.method === 'POST') {
      const portraits = options.appearance?.portraits; if (!portraits) throw new BookError('unavailable', '当前实例未接入静态立绘。');
      json(response, 200, await portraits.setFraming(characterId, data.framing, data.expectedRevision, data.operationId)); return;
    }
    const portraitId = /^\/appearance\/portraits\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(route);
    const portraitAsset=/^\/appearance\/portraits\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(image|reference)$/.exec(route);
    if(portraitAsset&&options.appearance?.portraits){
      const variant=options.appearance.portraits.get(characterId).variants.find(row=>row.id===portraitAsset[1]);
      if(!variant)throw new BookError('not_found','没有这个角色的差分。');
      const skin=options.appearance.skins.list().find(row=>row.skinId===variant.skinId);
      const registered=skin&&options.appearance.skins.routes(skin.skinId).get(skin.modelEntry);
      if(!skin||skin.type!=='sprite'||typeof registered!=='string')throw new BookError('unavailable','立绘原图不可读取。');
      const bytes=await readFile(registered),mime=skin.modelEntry.toLowerCase().endsWith('.webp')?'image/webp':'image/png';
      if(portraitAsset[2]==='image'&&request.method==='GET'){response.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(bytes);return;}
      if(portraitAsset[2]==='reference'&&request.method==='POST'){
        json(response,200,await options.runtime.resources.receiveUpload(scope,{name:variant.name+(mime==='image/webp'?'.webp':'.png'),mime},bytes,data.operationId,signal));return;
      }
      throw new BookError('not_found','没有这个立绘操作。');
    }
    if(portraitId&&request.method==='PATCH'){
      const portraits=options.appearance?.portraits;if(!portraits)throw new BookError('unavailable','当前实例未接入静态立绘。');
      json(response,200,await portraits.rename(characterId,portraitId[1]!,data.name,data.expectedRevision,data.operationId));return;
    }
    if (portraitId && request.method === 'DELETE') {
      const portraits = options.appearance?.portraits; if (!portraits) throw new BookError('unavailable', '当前实例未接入静态立绘。');
      const removed=await portraits.remove(characterId,portraitId[1]!,data.expectedRevision,data.operationId);
      json(response, 200, removed); return;
    }
    if (route === '/appearance/outfits' && request.method === 'POST') {
      if (!options.appearance?.outfits) throw new BookError('unavailable', '当前实例未接入网页换装。');
      json(response, 200, await options.appearance.outfits.begin(scope, { operationId: data.operationId, expectedAppearanceRevision: data.expectedAppearanceRevision, instruction: data.instruction, references: data.references,...(data.conversationMode===undefined?{}:{conversationMode:data.conversationMode}) })); return;
    }
    const outfitId = /^\/appearance\/outfits\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/(cancel|apply))?$/.exec(route);
    if (outfitId && options.appearance?.outfits) {
      const outfits = options.appearance.outfits;
      if (request.method === 'GET' && !outfitId[2]) { json(response, 200, await outfits.refresh(scope, outfitId[1]!, signal)); return; }
      if (request.method === 'POST' && outfitId[2] === 'cancel') { json(response, 200, await outfits.cancel(scope, outfitId[1]!)); return; }
      if (request.method === 'POST' && outfitId[2] === 'apply') { json(response, 200, await outfits.apply(scope, outfitId[1]!, { resourceId: data.resourceId, sha256: data.sha256, expectedAppearanceRevision: data.expectedAppearanceRevision, operationId: data.operationId }, writeTempImage)); return; }
    }
    if (route === '/appearance' && request.method === 'GET') {
      if (!options.appearance) throw new BookError('unavailable', '当前实例未接入 Live2D 资源。');
      json(response, 200, { ...options.appearance.skins.state(), pickerAvailable: Boolean(appearanceHost) }); return;
    }
    if(route==='/desktop/restart'&&request.method==='POST'){
      if(!appearanceHost)throw new BookError('unavailable','当前运行方式未连接桌面宿主。');
      json(response,200,await appearanceHost.restart());return;
    }
    if(route==='/desktop/preferences'&&(request.method==='GET'||request.method==='PUT')){
      if(!appearanceHost)throw new BookError('unavailable','当前运行方式未连接桌面偏好宿主。');
      if(request.method==='PUT'){
        validateIdentity(data.operationId,'operationId');
        if(!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<0||!data.patch||typeof data.patch!=='object'||Array.isArray(data.patch)||!Object.keys(data.patch).length||Object.keys(data.patch).some(key=>!DESKTOP_HOST_PATCH_KEYS.includes(key as typeof DESKTOP_HOST_PATCH_KEYS[number])))throw new BookError('invalid_input','桌面偏好修订或修改字段无效。');
      }
      json(response,200,request.method==='GET'?await appearanceHost.preferences():await appearanceHost.patch({expectedRevision:data.expectedRevision,operationId:data.operationId,patch:data.patch}));return;
    }
    if (route === '/appearance/select' && request.method === 'POST') {
      if (!appearanceHost || !options.appearance) throw new BookError('unavailable', '请从桌宠启动以使用系统选择器。');
      if (!['directory', 'model-entry', 'archive', 'image'].includes(data.selectionKind)) throw new BookError('invalid_input', '形象选择类型无效。');
      const identity = appearanceHost.identityFor(characterId, data.selectionKind === 'image' ? 'sprite' : 'live2d', data.selectionKind);
      if (!data.selectionId) { json(response, 200, await appearanceHost.select(identity)); return; }
      validateIdentity(data.selectionId, 'selectionId');
      const skinId = `book-${randomUUID()}`;
      const state = await appearanceHost.importBySelection(identity, { selectionId: data.selectionId, entry: data.entry, label: data.label, skinId });
      json(response, 200, { state, skinId }); return;
    }
    if (route === '/book' && request.method === 'GET') { json(response, 200, options.runtime.repository.snapshot(scope)); return; }
    if (route === '/entries' && request.method === 'PUT') {
      const receipt = options.runtime.repository.commit(scope, { upsert: [data.entry as BookEntry] }, data.expectedRevision, data.operationId);
      options.runtime.invalidate(characterId); json(response, 200, { receipt, book: options.runtime.repository.snapshot(scope) }); return;
    }
    if (route === '/entries' && request.method === 'DELETE') {
      const receipt = options.runtime.repository.commit(scope, { remove: [data.entryId] }, data.expectedRevision, data.operationId);
      options.runtime.invalidate(characterId); json(response, 200, { receipt, book: options.runtime.repository.snapshot(scope) }); return;
    }
    if (route === '/imports/preview' && request.method === 'POST') {
      if (data.zipBase64 !== undefined) {
        if (data.text !== undefined || typeof data.zipBase64 !== 'string' || data.zipBase64.length > 1398104) throw new BookError('invalid_input', 'ZIP 编码无效或同时提供了文本。');
        const bytes = Buffer.from(data.zipBase64, 'base64');
        if (bytes.toString('base64') !== data.zipBase64) throw new BookError('invalid_input', 'ZIP 编码无效。');
        json(response, 200, await options.runtime.imports.previewZip(scope, bytes, data.sourceName));
      } else json(response, 200, options.runtime.imports.preview(scope, data.text, data.sourceName));
      return;
    }
    if (route === '/imports/apply' && request.method === 'POST') {
      const receipt = options.runtime.imports.apply(scope, data.previewId, data.operationId, data.skippedIds ?? []);
      options.runtime.invalidate(characterId); json(response, 200, { receipt, book: options.runtime.repository.snapshot(scope) }); return;
    }
    if (route === '/export' && request.method === 'GET') {
      const format = url.searchParams.get('format') ?? 'json';
      if (format !== 'json' && format !== 'markdown') throw new BookError('invalid_input', '导出格式无效。');
      json(response, 200, options.runtime.imports.export(scope, format)); return;
    }
    if (route === '/retrieval/config' && request.method === 'GET') { json(response, 200, options.runtime.repository.loadConfig().recall); return; }
    if (route === '/retrieval/config' && request.method === 'PUT') {
      const config = options.runtime.repository.loadConfig();
      const receipt = options.runtime.repository.commitConfig({ ...config, recall: data.config }, data.expectedRevision, data.operationId);
      json(response, 200, { receipt }); return;
    }
    if (route === '/recall/test' && request.method === 'POST') {
      if (data.mode !== undefined && !['off', 'smart', 'deep', 'story-rp'].includes(data.mode)) throw new BookError('invalid_input', '召回模式无效。');
      if (data.replyStyle !== undefined && data.replyStyle !== null && !TURN_REPLY_STYLES.includes(data.replyStyle)) throw new BookError('invalid_input', '本轮回复风格必须为沿用设置、简短、适中或详细。');
      json(response, 200, await options.runtime.inspect(scope, data.query, signal, data.mode as RecallMode | undefined, undefined, data.replyStyle === undefined ? undefined : data.replyStyle)); return;
    }
    if (route.startsWith('/recall/traces/') && request.method === 'GET') { json(response, 200, options.runtime.trace(scope, route.slice('/recall/traces/'.length))); return; }
    if(route==='/chat/policy'&&request.method==='POST'){
      json(response,200,{decision:options.runtime.replyStylePreview(scope,data.text,data.replyStyle??'inherit')});return;
    }
    if (route === '/chat/history' && request.method === 'GET') { json(response, 200, { turns: options.runtime.repository.readSession(scope) }); return; }
    if(route==='/chat/incognito'&&request.method==='DELETE'){options.runtime.clearIncognito(scope);json(response,200,{cleared:true});return;}
    if (route === '/chat' && request.method === 'POST') {
      if (data.replyStyle !== undefined && data.replyStyle !== null && !TURN_REPLY_STYLES.includes(data.replyStyle)) throw new BookError('invalid_input', '本轮回复风格必须为沿用设置、简短、适中或详细。');
      options.onChatState?.({state:'pending',scope,incognito:data.incognito===true});
      try { const result=await options.runtime.chat(scope, data.text, signal, { ...(data.inputResources===undefined?{}:{inputResources:data.inputResources}), ...(data.turnId === undefined || data.turnId === null ? {} : {turnId:data.turnId}), ...(data.incognito===undefined?{}:{incognito:data.incognito}), ...(data.replyStyle===undefined||data.replyStyle===null?{}:{replyStyle:data.replyStyle}) });
        options.onChatState?.({state:'completed',scope,...(data.incognito===true?{incognito:true}:{text:result.turn.assistant})});json(response,200,result);
      } catch(error) { options.onChatState?.({state:'failed',scope,incognito:data.incognito===true});throw error; } return; }
    if (route === '/chat/cancel' && request.method === 'POST') { options.runtime.cancel(scope); json(response, 200, { cancelled: true }); return; }
    json(response, 404, { error: { message: '未知 Memory Book 路由。' } });
  }
  // OS ephemeral ranges can include browser/Fetch-blocked service ports on Windows.
  // Match the existing management server's high-range policy; explicit ports stay explicit.
  const automaticPort = options.port === undefined || options.port === 0;
  await new Promise<void>((done, reject) => {
    let retries = 0;
    const listen = (): void => {
      const onListening = (): void => { server.off('error', onError); done(); };
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        if (automaticPort && ['EADDRINUSE', 'EACCES'].includes(error.code ?? '') && retries++ < 16) { listen(); return; }
        reject(error);
      };
      server.once('error', onError); server.once('listening', onListening);
      try { server.listen(automaticPort ? randomInt(49152, 65536) : options.port!, '127.0.0.1'); }
      catch (error) { server.off('error', onError); server.off('listening', onListening); reject(error); }
    };
    listen();
  });
  const bound = server.address(); if (!bound || typeof bound === 'string') throw Error('Invalid local server address');
  const address = { port: bound.port, origin: `http://127.0.0.1:${bound.port}` };
  return { server, token, url: `${address.origin}/#token=${token}`, runtimeIdentity,
    close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); }) };
}

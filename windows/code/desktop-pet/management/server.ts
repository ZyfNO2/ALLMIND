import { emotionRoute } from './emotion-routes.js';
import type { EmotionManagement } from '../contracts/emotion-state.js';
import type { SelfSetupManagement } from '../contracts/self-setup.js';
import { selfSetupRoute } from './self-setup-routes.js';
import type { MemoryImportManagement } from '../contracts/memory-import.js';
import { memoryImportRoute } from './memory-import-routes.js';
import type {BalanceManagement} from '../contracts/balances.js';
import {balanceRoute} from './balance-routes.js';
import type { WakeManagement } from '../contracts/wake.js';
import { wakeRoute } from './wake-routes.js';
import type { WeChatManagement } from '../contracts/wechat.js';
import { wechatRoute } from './wechat-routes.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { characterUiAsset } from './character-ui-static.js';
import type { CharacterId } from '../contracts/index.js';
import { ManagementError, type ManagementMemoryPort, type ManagementSnapshot, type RecordQuery, type RecordEdit } from '../contracts/management.js';
import type { PresentationControls } from '../contracts/presentation-presets.js';
import type { ManagementSettingsStore } from './settings-store.js';
import { memoryDynamicsRoute } from './memory-dynamics-routes.js';
import type {PendingMemoryManagement} from './pending-memory.js';
import type { ProjectIndexPort } from '../contracts/projects.js';
import { projectRoute } from './project-routes.js';
import { taskRoute, type TaskManagement } from './task-routes.js';
import { workProtocolRoute } from './work-protocol-routes.js';
import { aikaRoute } from './aika-routes.js';
import { knowledgeRoute } from './knowledge-routes.js';
import { healthRoute, microphoneRoute } from './health-routes.js';
import { skinRoute } from './skin-routes.js';
import { providerSourceRoute } from './provider-source-routes.js';
import { charactersRoute } from './character-routes.js';
import { lorebookRoute } from './lorebook-routes.js';
import { localCapabilitiesRoute } from './local-capability-routes.js';
import { continuityRoute, type ContinuityManagement } from './continuity-routes.js';
import { characterWikiImportRoute, type WikiImportManagement } from './character-wiki-import-routes.js';
import { characterDocumentRoute, type CharacterDocumentManagement } from './character-document-routes.js';
import type { FlowProfile } from '../contracts/flow-profile.js';
import type { EventDomain } from '../contracts/perception.js';
import type { TimelineQueryResult } from '../memory/unified-timeline.js';
import type { WorkProtocolManagement } from '../contracts/work-protocol.js';
import { proactiveInvitationRoute, type ProactiveInvitationManagement } from './proactive-invitation-routes.js';
import { perceptionRoute } from './perception-routes.js';
import type { PerceptionManagementPort } from './perception-routes.js';
import { playgroundRoute } from './playground-routes.js';
import { collectionRoute } from './collection-routes.js';
import type { CollectionManagementPort } from './collection-routes.js';
import { companionModeRoute } from './companion-mode-routes.js';
import { screenGrantRoute } from './screen-grant-routes.js';
import { companionTriggerRoute } from './companion-trigger-routes.js';
import { companionKnowledgeRoute, type CompanionKnowledgePorts } from './companion-knowledge-routes.js';
import { companionPreferencesRoute } from './companion-preferences-routes.js';
import { desktopHostRoute, type DesktopHostManagement } from './desktop-host-routes.js';
import type { PlaygroundManagementPort } from '../contracts/management.js';

interface RuntimeServerOptions { emotion?: EmotionManagement; aika?: import('./aika-routes.js').AikaManagement; knowledge?: import('../contracts/knowledge.js').KnowledgeManagement; continuity?: ContinuityManagement; /** WV0-01: character Wiki import surface; absent leaves the section unavailable. */ wikiImport?: WikiImportManagement; /** CB-01: unified character document (.aiki.md) surface; absent leaves the section unavailable. */ characterDocuments?: CharacterDocumentManagement; /** RWR-06: authored Lorebook store; absent leaves the section unavailable. */ lorebooks?: import('../memory/lorebook-store.js').LorebookStore; /** RWR-05: read-only local voice capability probe. */ localCapabilities?: import('./local-capability-routes.js').LocalCapabilityProbe; /** RWR-06: role configuration store, for the author-metadata surface. */ roleConfigurations?: import('./role-configuration.js').RoleConfigurationStore; playground?: PlaygroundManagementPort; presets?: import('./character-preset-store.js').CharacterPresetStore; health?: import('./health-routes.js').HealthManagement; microphone?: import('./health-routes.js').MicrophoneManagement; mode?: 'runtime'; selfSetup?:SelfSetupManagement; memoryImport?: MemoryImportManagement; balances?: BalanceManagement; wake?: WakeManagement; wechat?: WeChatManagement; uiRoot: string; memory: ManagementMemoryPort; settings: ManagementSettingsStore; snapshot(): ManagementSnapshot | Promise<ManagementSnapshot>; token?: string; port?: number; presentation?: PresentationControls; presentationAssets?: ReadonlyMap<string, string>; pendingMemory?:PendingMemoryManagement; projects?: ProjectIndexPort; tasks?: TaskManagement;
  /** Explicit admitted role/pairing queries; older requests retain the runtime pairing default. */
  unifiedTimeline?: (query: { readonly domains?: readonly EventDomain[]; readonly limit?: number; readonly cursor?: string; readonly pairing?: import('../contracts/character-pack.js').PairingScope; readonly from?: string; readonly to?: string; readonly activitiesOnly?: boolean; readonly order?: 'desc' }) => Promise<TimelineQueryResult>;
  traces?: import('../core/trace-store.js').RuntimeTraceStore;
  /** Authenticated on-demand read from the existing History owner; never persisted in Trace. */
  traceContent?: (trace: import('../core/trace-store.js').RuntimeTrace) => import('../core/trace-store.js').TraceContentResult;
  /** FIX61-11: the FIX61-05 model-pack registry. Appearance only; absent leaves the skin section unavailable. */
  skins?: import('../contracts/skin.js').SkinManagement;
  /** N075-01/R8: live host and flow management projection. */
  next65?: import('./next65-management.js').Next65Management;
  /** 08-05: explicit, versioned ACP/MCP work cards and durable forget lifecycle. */
  workProtocol?: WorkProtocolManagement;
  /** 08-04: opt-in continuity-sourced invitations and shared quota/DND controls. */
  proactiveInvitations?: ProactiveInvitationManagement; perception?: PerceptionManagementPort;
  /** N081-06: local collection status, sources, samples and deletion. Absent leaves the section unavailable. */
  collection?: CollectionManagementPort;
  /** N082-08: companion mode runtime, batch runner, and observation scheduler */
  companionMode?: import('../core/companion-mode-runtime.js').CompanionModeRuntime;
  batchRunner?: import('../core/collection-batch-runner.js').CollectionBatchRunner;
  observationScheduler?: import('../core/observation-scheduler.js').ObservationScheduler;
  /** CK-13: the periodic automation policy layer; absent leaves the console honestly unavailable. */
  companionAutomation?: import('../core/companion-automation-scheduler.js').CompanionAutomationScheduler;
  /** RWR-10-01: host-owned preferences (hotkey/replySound/display). Absent leaves the section unavailable. */
  desktopHost?: DesktopHostManagement;
   /** RWR-10-05: pair-scoped host targets and screen grant families. */
   companionScreen?: import('./screen-grant-runtime.js').ScreenGrantRuntime;
    companionTriggers?: import('./companion-trigger-runtime.js').CompanionTriggerRuntime;
  /** CK-09: the companion knowledge console surface. Absent leaves the section unavailable. */
  companionKnowledge?: CompanionKnowledgePorts; }
type ServerOptions = RuntimeServerOptions | { mode:'setup'; selfSetup:SelfSetupManagement; uiRoot:string; token?:string; presentationAssets?:undefined };
/**
 * RWR-02: admission consults the PERSISTED registry, not a product constant.
 *
 * The previous test was `isProductCharacter(value)`, so every id that passed the syntax regex looked
 * admitted and `getPreset` answered it with a fabricated default. `options.memory.registry` is the
 * authority now; an unknown id is `not_found` and is never created as a side effect of a read.
 */
const characterOf = (memory: ManagementMemoryPort) => (value: unknown): CharacterId => {
  if (typeof value !== 'string') throw new ManagementError('invalid_request', '角色标识无效。');
  const registry = memory.registry;
  if (!registry) throw new ManagementError('unavailable', '当前实例尚未接入角色登记。');
  if (!registry.get(value)) throw new ManagementError('not_found', '没有这个角色。');
  return value;
};
const integer = (value: unknown, fallback: number, min: number, max: number) => { const n = value === null || value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new ManagementError('invalid_request', '数值范围无效。'); return n; };
const str = (value: unknown, max = 20000): string => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', '文本字段无效。'); return value; };
async function body(req: IncomingMessage, limit=256*1024): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ManagementError('invalid_request', '请求需要JSON格式。');
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const part of req) { const buffer = Buffer.from(part); bytes += buffer.length; if (bytes > limit) throw new ManagementError('invalid_request', '请求内容过大。'); chunks.push(buffer); }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new ManagementError('invalid_request', '请求格式无效。'); }
}
/** Actual backend-owned loopback server. No CORS, proxy, arbitrary files or raw SQL. */
export async function startManagementServer(options: ServerOptions) {
  const token = options.token ?? randomBytes(32).toString('hex'); if (token.length < 32) throw new Error('Management token too short');
  let origin = '';
  const json = (res: ServerResponse, status: number, value: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); };
  // RWR-02: every `characterId` query/body field is admitted through the persisted registry.
  const character = options.mode === 'setup' ? ((value: unknown): CharacterId => { throw new ManagementError('unavailable', '设置模式没有角色管理。'); }) : characterOf(options.memory);
  /**
   * The boolean form of the same admission, for routes that validate their own error codes. A route that
   * receives `false` must answer `not_found` rather than inventing a default role.
   */
  const admit = (value: unknown): boolean => {
    if (options.mode === 'setup' || typeof value !== 'string') return false;
    return !!options.memory.registry?.get(value);
  };
  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000, keepAliveTimeout: 1000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; media-src 'self' blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    void (async () => {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin)) throw new ManagementError('forbidden', '仅接受本机管理页面的同源请求。');
      const url = new URL(req.url ?? '/', origin);
      if (url.origin !== origin) throw new ManagementError('forbidden', '无效来源。');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new ManagementError('not_found', '没有这个页面。');
        const characterAsset = characterUiAsset(options.uiRoot, url.pathname, options.mode);
        if (characterAsset) {
          const data = await readFile(characterAsset.path);
          res.setHeader('Content-Type', characterAsset.mime); res.end(req.method === 'HEAD' ? undefined : data); return;
        }
        const asset = options.presentationAssets?.get(decodeURIComponent(url.pathname));
        if (asset) {
          const data = await readFile(asset);
          const type = asset.endsWith('.png') ? 'image/png' : asset.endsWith('.json') ? 'application/json' : asset.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
          res.setHeader('Content-Type', type); res.end(req.method === 'HEAD' ? undefined : data); return;
        }
        // LUI-06: the retired console's explicit names table, its `/legacy.html` alias, and the
        // "any existing .mjs/.js/.css/.html under uiRoot" fallback are all gone. The compiled SPA above
        // is the only management shell, so a direct request for the old shell or any old view script is
        // refused by the same bounded check that refuses every other unknown path.
        throw new ManagementError('not_found', '没有这个页面。');
      }
      const expected = Buffer.from('Bearer ' + token), provided = Buffer.from(req.headers.authorization ?? '');
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new ManagementError('unauthorized', '请从本机管理入口重新打开此页面。');
      if (req.method !== 'GET' && req.headers.origin !== origin) throw new ManagementError('forbidden', '写入必须来自当前管理页面。');
      if(await selfSetupRoute(req,url,options.selfSetup,limit=>body(req,limit),value=>json(res,200,value),(bytes,mime)=>{res.setHeader('Content-Type',mime);res.end(bytes);}))return;
      if(options.mode==='setup')throw new ManagementError('unavailable','当前为首次设置，桌宠尚未运行。');
      const q = url.searchParams;
      const sourceController = new AbortController();
      res.once('close', () => { if (!res.writableFinished) sourceController.abort(); });
      const sourceResponse = await providerSourceRoute(req.method, url, () => body(req), options.settings, options.roleConfigurations, admit, sourceController.signal);
      if (sourceResponse !== undefined) { json(res, 200, sourceResponse); return; }
      if (url.pathname === '/api/unified-timeline') {
        if (req.method !== 'GET') throw new ManagementError('not_found', '没有这个管理操作。');
        if (!options.unifiedTimeline) throw new ManagementError('unavailable', '统一时间线尚未接入当前运行实例。');
        const rawDomains = q.get('domains');
        const domains = rawDomains === null ? undefined : rawDomains.split(',').filter(Boolean);
        // N081-06: `collection` is an explicit opt-in domain. An absent `domains` still means the
        // legacy three, so existing clients keep exactly their previous result set.
        if (domains?.some(domain => !['canon', 'companion', 'work', 'collection'].includes(domain))) throw new ManagementError('invalid_request', '时间线领域筛选无效。');
        const rawCursor = q.get('cursor');
        const cursor = rawCursor === null ? undefined : str(rawCursor, 240);
        const input = {
          ...(q.has('characterId') ? { pairing: { characterId: character(q.get('characterId')), userId: str(q.get('userId') || 'local-user', 96), characterInstanceId: str(q.get('characterInstanceId') || `${q.get('characterId')}-default`, 96) } } : {}),
          ...(domains ? { domains: domains as EventDomain[] } : {}),
          limit: integer(q.get('limit'), 50, 1, 200),
          ...(cursor ? { cursor } : {}),
          ...(q.get('activitiesOnly') === 'true' ? { activitiesOnly: true } : {}),
          ...(q.get('order') === 'desc' ? { order: 'desc' as const } : {}),
          ...Object.fromEntries(['from','to'].filter(key => q.has(key)).map(key => { const value = str(q.get(key),80); if (!Number.isFinite(Date.parse(value))) throw new ManagementError('invalid_request','日期筛选无效。'); return [key,value]; })),
        };
        json(res, 200, await options.unifiedTimeline(input));
        return;
      }
      if(url.pathname==='/api/emotion' && await emotionRoute(req,url,options.emotion,(await options.snapshot()).runtime.instanceId,value=>json(res,200,value),admit))return;
      if (await memoryImportRoute(req,url,options.memoryImport,()=>body(req),value=>json(res,200,value),admit)) return;
      if(await balanceRoute(req,url,options.balances,()=>body(req),value=>json(res,200,value)))return;
      if (await taskRoute(req, url, options.tasks, () => body(req), value => json(res, 200, value))) return;
      if (await workProtocolRoute(req, url, options.workProtocol, () => body(req), value => json(res, 200, value))) return;
      if (url.pathname.startsWith('/api/perception')) {
        if (await perceptionRoute(req.method, options.perception, url.pathname,
          () => body(req, url.pathname === '/api/perception/captures' ? 2_100_000 : 256 * 1024), value => json(res, 200, value))) return;
      }
      if (await projectRoute(req, url, options.projects, () => body(req), value => json(res, 200, value))) return;
      // RWR-10-01: host-owned preferences. Reached only through the authenticated, same-origin console;
      // a PUT additionally needs the Origin header, which the shared check above already enforces.
      if (await desktopHostRoute(req.method, options.desktopHost, url.pathname, () => body(req), value => json(res, 200, value))) return;
      if (url.pathname === '/api/companion/preferences'
          && await companionPreferencesRoute(req.method, options.companionMode, options.companionScreen, url.pathname, q, () => body(req), value => json(res, 200, value),
            // CK-13: the real periodic state, so `schedulerAvailable` and `nextEligibleAt` come from
            // the installed scheduler instead of a hard-coded placeholder.
            options.companionAutomation)) return;
       if ((url.pathname === '/api/companion/trigger' || url.pathname.startsWith('/api/companion/triggers/'))
         && await companionTriggerRoute(req.method, options.companionTriggers, url.pathname, q, () => body(req), value => json(res, 200, value))) return;
       if (url.pathname.startsWith('/api/companion/screen-')
        && await screenGrantRoute(req.method, options.companionScreen, url.pathname, q, () => body(req), value => json(res, 200, value))) return;
      // N082-08: companion mode & batch routes
      if (await companionModeRoute(req.method, options.companionMode, options.batchRunner, options.observationScheduler, url.pathname, q, () => body(req), value => json(res, 200, value))) return;
      // N081-06: local collection console. Bytes are served by the dedicated asset route only.
      if (url.pathname.startsWith('/api/collection')) {
        if (await collectionRoute(req.method, options.collection, url.pathname, q, () => body(req),
          value => json(res, 200, value),
          (bytes, mime) => { res.setHeader('Content-Type', mime); res.setHeader('Cache-Control', 'no-store'); res.end(bytes); })) return;
      }
      if(url.pathname==='/api/memory-pending'&&req.method==='GET'){json(res,200,options.pendingMemory?.list()??{instanceId:(await options.snapshot()).runtime.instanceId,requests:[],busy:false});return;}
      if(['/api/memory-pending/retry','/api/memory-pending/cancel'].includes(url.pathname)&&req.method==='POST'){
        if(!options.pendingMemory)throw new ManagementError('unavailable','当前版本尚未接入未完成请求管理。');
        const b=await body(req),instanceId=str(b.instanceId,100),id=str(b.id,200);
        json(res,200,url.pathname.endsWith('/retry')?options.pendingMemory.retry(instanceId,id):await options.pendingMemory.cancel(instanceId,id));return;
      }
      if (await memoryDynamicsRoute(req, url, options.memory.dynamics, () => body(req), value => json(res, 200, value), admit)) return;
      // FIX61-11: the model-pack registry. Its own bytes-sender is used because an asset response is a
      // real file (texture/moc) rather than the JSON envelope every other route uses.
      const appearanceRole = options.roleConfigurations && url.pathname.endsWith('/activate') && url.pathname.startsWith('/api/skins/') ? (await options.snapshot()).runtime.characterId : undefined;
      if (await skinRoute(req, options.skins, url.pathname, () => body(req), value => {
        res.setHeader('Content-Type', value.mime + (value.mime === 'application/json' ? '; charset=utf-8' : ''));
        res.end(req.method === 'HEAD' ? undefined : value.bytes); }, appearanceRole ? () => options.roleConfigurations?.get(appearanceRole)?.savedRevision : undefined)) return;
      if (url.pathname === '/api/presentation' && options.presentation) {
        if (req.method === 'GET') { json(res, 200, { catalog: options.presentation.catalog, policy: options.presentation.snapshot() }); return; }
        if (req.method === 'PUT') { const b = await body(req); json(res, 200, { catalog: options.presentation.catalog, policy: await options.presentation.save(str(b.modelId, 100), integer(b.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER), b.enabledIds) }); return; }
      }
      if (options.aika && url.pathname.startsWith('/api/aika/')) { json(res, 200, await aikaRoute(req.method, options.aika, url.pathname, url.searchParams, () => body(req))); return; }
      // CK-09: companion knowledge console surface (sources, activities, wiki, distillation, publish).
      const ckPorts = options.companionKnowledge;
      if (url.pathname.startsWith('/api/companion/') && ckPorts) {
        const ckValue = await companionKnowledgeRoute(req.method, ckPorts, url.pathname, url.searchParams, () => body(req));
        if (ckValue !== null) { json(res, 200, ckValue); return; }
      }
      // An unwired build reports `unavailable` for reads rather than serving an empty success, so
      // the console can render "not wired" instead of a blank page that looks healthy.
      if (url.pathname.startsWith('/api/companion/') && !ckPorts) {
        if (url.pathname === '/api/companion/sources') { json(res, 200, { available: false, reason: 'not_wired', sources: [], workspace: { available: false, reason: 'not_wired' } }); return; }
        throw new ManagementError('unavailable', '当前运行实例未装配陪伴知识管理。');
      }
      if (url.pathname.startsWith('/api/continuity/')) { json(res, 200, await continuityRoute(req.method, options.continuity, url.pathname, () => body(req))); return; }
      if (url.pathname.startsWith('/api/characters/wiki/') || url.pathname.startsWith('/api/characters/wiki/operations/')) { json(res, 200, await characterWikiImportRoute(req.method, url.pathname, options.wikiImport, () => body(req), q)); return; }
      if (url.pathname.startsWith('/api/characters/documents/')) { json(res, 200, await characterDocumentRoute(req.method, url.pathname, options.characterDocuments, () => body(req), q)); return; }
      if (url.pathname.startsWith('/api/playground/')) { json(res, 200, await playgroundRoute(req.method, options.playground, url.pathname, () => body(req), q)); return; }
      if (url.pathname.startsWith('/api/proactive/')) { json(res, 200, await proactiveInvitationRoute(req.method, options.proactiveInvitations, url.pathname, () => body(req))); return; }
      if (url.pathname.startsWith('/api/knowledge')) {
        const id = q.has('characterId') ? character(q.get('characterId')) : undefined;
        if (id && !options.knowledge?.forCharacter) throw new ManagementError('unavailable', '此实例尚未接入角色资料库。');
        json(res, 200, await knowledgeRoute(req.method, id ? options.knowledge?.forCharacter?.(id) : options.knowledge, url.pathname, () => body(req))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/next65/packages') {
        if (!options.next65) throw new ManagementError('unavailable', '0.65 包管理未接入。');
        json(res, 200, options.next65.packages());
        return;
      }
      const packageActionMatch = /^\/api\/next65\/packages\/([^/]+)\/(disable|uninstall)$/.exec(url.pathname);
      if (packageActionMatch && req.method === 'POST') {
        if (!options.next65) throw new ManagementError('unavailable', '0.65 包管理未接入。');
        const pkgId = decodeURIComponent(packageActionMatch[1]!);
        const action = packageActionMatch[2];
        if (action === 'disable') {
          json(res, 200, options.next65.disable(pkgId));
          return;
        } else if (action === 'uninstall') {
          options.next65.uninstall(pkgId);
          json(res, 200, { uninstalled: true, packageId: pkgId });
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/next65/packages/import') {
        if (!options.next65) throw new ManagementError('unavailable', '0.65 包管理未接入。');
        const b = await body(req);
        const sourceRoot = str(b.sourceRoot, 1000);
        json(res, 200, options.next65.importPackage(sourceRoot));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/next65/truth') {
        if (!options.next65) throw new ManagementError('unavailable', '0.65 运行时未接入。');
        json(res, 200, options.next65.runtimeTruth());
        return;
      }
      if (url.pathname === '/api/next65/profiles') {
        if (!options.next65) throw new ManagementError('unavailable', '0.65 Flow 管理未接入。');
        if (req.method === 'GET') { json(res, 200, { profiles: options.next65.profiles(), active: options.next65.activeProfile() }); return; }
        if (req.method === 'PUT') {
          const value = await body(req);
          if (!value.profile || typeof value.profile !== 'object' || Array.isArray(value.profile)) throw new ManagementError('invalid_request', 'Flow profile 格式无效。');
          const saved = options.next65.saveProfile(value.profile as FlowProfile, integer(value.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER));
          json(res, 200, { profile: saved, active: options.next65.activeProfile() }); return;
        }
      }
      const activateProfile = /^\/api\/next65\/profiles\/([^/]+)\/activate$/.exec(url.pathname);
      if (activateProfile && req.method === 'POST') {
        if (!options.next65) throw new ManagementError('unavailable', '0.65 Flow 管理未接入。');
        const value = await body(req);
        const active = options.next65.activateProfile(decodeURIComponent(activateProfile[1]!), integer(value.expectedRevision, -1, 1, Number.MAX_SAFE_INTEGER));
        json(res, 200, active); return;
      }
      if (url.pathname.startsWith('/api/health')) { json(res, 200, await healthRoute(req.method, options.health, url.pathname)); return; }
      if (url.pathname.startsWith('/api/microphone')) { json(res, 200, await microphoneRoute(req.method, options.microphone, url.pathname, () => body(req))); return; }
      if (url.pathname === '/api/wake' && options.wake) { json(res, 200, await wakeRoute(req.method, options.wake, () => body(req))); return; }
      if (url.pathname === '/api/wechat' && options.wechat) { json(res, 200, await wechatRoute(req.method, options.wechat, () => body(req))); return; }
      if (req.method === 'GET' && url.pathname === '/api/snapshot') { json(res, 200, await options.snapshot()); return; }
      if (req.method === 'GET' && url.pathname === '/api/traces') {
        const limit = integer(q.get('limit'), 20, 1, 100);
        const offset = integer(q.get('offset'), 0, 0, 1000000);
        const charId = q.get('characterId') ? character(q.get('characterId')) : undefined;
        if (options.traces) {
          json(res, 200, options.traces.list({ characterId: charId, limit, offset, debugOptIn: false }));
        } else {
          json(res, 200, { total: 0, offset, limit, traces: [], summary: { totalCount: 0, avgElapsedMs: 0, successRate: 100, totalTokens: 0 } });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/traces/') && url.pathname.endsWith('/content')) {
        const traceId = decodeURIComponent(url.pathname.slice('/api/traces/'.length, -'/content'.length));
        if (!traceId || !options.traces) throw new ManagementError('not_found', 'Trace 不存在。');
        const trace = options.traces.get(traceId);
        if (!trace) throw new ManagementError('not_found', 'Trace 不存在。');
        if (!options.traceContent) throw new ManagementError('unavailable', '当前实例没有接入历史正文读取。');
        // Read both rows from one SQLite snapshot and serialize synchronously so an in-flight
        // forget cannot return only one side of the turn or race a stale asynchronous result.
        json(res, 200, options.traceContent(trace));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/records') {
        const kind = q.get('kind'); if (!['memory', 'transcript', 'summary', 'keyword_index', 'vector_index', 'context_cache'].includes(kind ?? '')) throw new ManagementError('invalid_request', '记录类型无效。');
        const state = q.get('state') ?? 'active'; if (state !== 'all' && state !== 'active') throw new ManagementError('invalid_request', '记录状态无效。');
        const query: RecordQuery = { characterId: character(q.get('characterId')), kind: kind as RecordQuery['kind'], state, query: str(q.get('query') ?? '', 1000), offset: integer(q.get('offset'), 0, 0, 1000000), limit: integer(q.get('limit'), 30, 1, 100) };
        for (const name of ['from', 'to'] as const) if (q.has(name)) { const value = str(q.get(name), 80); if (!Number.isFinite(Date.parse(value))) throw new ManagementError('invalid_request', '日期筛选无效。'); query[name] = value; }
        json(res, 200, await options.memory.list(query)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/context') { json(res, 200, await options.memory.context(character(q.get('characterId')), str(q.get('query') ?? '', 1000))); return; }
      if (req.method === 'GET' && url.pathname === '/api/prompt') { json(res, 200, await options.memory.prompt(character(q.get('characterId')))); return; }
      if (req.method === 'POST' && url.pathname === '/api/records/edit') {
        const b = await body(req); const input: RecordEdit = { characterId: character(b.characterId), id: str(b.id, 200), expectedVersion: integer(b.expectedVersion, -1, 1, Number.MAX_SAFE_INTEGER), operationId: str(b.operationId, 200), text: str(b.text), reason: str(b.reason, 1000) };
        if (!input.text.trim() || !input.operationId.trim() || !input.reason.trim()) throw new ManagementError('invalid_request', '请填写修改内容与原因。');
        json(res, 200, await options.memory.edit(input)); return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/prompt') {
        const b = await body(req); const text = str(b.text), operationId = str(b.operationId, 200);
        if (!text.trim() || !operationId.trim()) throw new ManagementError('invalid_request', '角色设定和操作编号不能为空。');
        json(res, 200, await options.memory.savePrompt({ characterId: character(b.characterId), expectedRevision: integer(b.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER), text, operationId })); return;
      }
      // RWR-02: the registry surface. It must be checked BEFORE the preset route, because both live
      // under /api/characters and only the registry may create a character.
      if (url.pathname === '/api/characters' || url.pathname === '/api/characters/selection' || url.pathname === '/api/characters/profile' || url.pathname === '/api/characters/appearance'
        || /^\/api\/characters\/[a-zA-Z0-9_-]+\/(remove|replace)$/.test(url.pathname)) {
        const result = await charactersRoute(req.method, options.memory.registry, url.pathname, () => body(req), options.roleConfigurations, options.skins, q);
        json(res, 200, result); return;
      }
      // RWR-06: authored Lorebooks. Checked before the preset route because both live under
      // /api/characters; every write is owner-checked against the persisted registry.
      if (url.pathname.startsWith('/api/characters/lorebooks')) {
        const result = await lorebookRoute(req.method, options.lorebooks, options.memory.registry, url.pathname, () => body(req), url.searchParams);
        if (result !== undefined) { json(res, 200, result); return; }
      }
      if (url.pathname === '/api/roles/local-capabilities') {
        const result = await localCapabilitiesRoute(req.method, url.pathname, options.localCapabilities);
        json(res, 200, result); return;
      }
      if (url.pathname === '/api/characters/preset') {
        if (!options.presets) throw new ManagementError('unavailable', '角色预设服务未装载。');
        if (req.method === 'GET') {
          // RWR-02: an unknown character is `not_found`. The previous default ('companion') plus a
          // fabricating store meant a typo returned a synthetic preset instead of an error.
          const charId = character(q.get('characterId') || 'companion');
          const preset = await options.presets.getPreset(charId);
          json(res, 200, preset);
          return;
        }
        if (req.method === 'PUT') {
          const b = await body(req);
          // Admission happens before the store so an unknown id can never create a preset entry.
          character(b.characterId);
          json(res, 200, await options.presets.savePreset(b as any));
          return;
        }
        throw new ManagementError('not_found', '请求方法不支持。');
      }
      if (req.method === 'PUT' && url.pathname === '/api/settings') { const b = await body(req); json(res, 200, await options.settings.save(integer(b.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER), b.settings)); return; }
      if (req.method === 'POST' && url.pathname === '/api/settings/rollback') { const b = await body(req); json(res, 200, await options.settings.rollback(integer(b.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER), integer(b.targetRevision, -1, 0, Number.MAX_SAFE_INTEGER))); return; }
      throw new ManagementError('not_found', '没有这个管理操作。');
    })().catch(error => {
      if (res.headersSent || res.destroyed) return;
      const safe = error instanceof ManagementError ? error : new ManagementError('internal_error', '这次管理操作未完成，原始内容和内部错误未对外输出。');
      const status = { unauthorized: 401, forbidden: 403, invalid_request: 400, not_found: 404, version_conflict: 409, unavailable: 503, internal_error: 500 }[safe.code];
      json(res, status, { error: { code: safe.code, message: safe.message } });
    });
  });
  const desiredPort = ('port' in options && typeof options.port === 'number') ? options.port : 0;
  await new Promise<void>((done, reject) => {
    let randomPortAttempts = 0;
    const listen = (port: number, randomPort: boolean): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('error', onError);
        // FIX LUI-01: Windows reports an excluded/reserved port range as EACCES rather than
        // EADDRINUSE, so retrying only on EADDRINUSE aborted the first-run setup server instead of
        // picking another port. Both codes mean "this port cannot be used"; try another one.
        const retryable = err.code === 'EADDRINUSE' || err.code === 'EACCES';
        if (retryable && randomPortAttempts < 16 && (randomPort || desiredPort !== 0)) {
          randomPortAttempts += 1;
          listen(randomInt(49152, 65536), true);
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('No local address')); return; }
        origin = 'http://127.0.0.1:' + address.port;
        done();
      });
    };
    // Browser and Fetch implementations reject a small set of reserved ports. A random OS port
    // can land there on hosts with a broad dynamic-port range, so choose from the safe high range.
    if (desiredPort === 0) listen(randomInt(49152, 65536), true);
    else listen(desiredPort, false);
  });
  return { origin, token, url: origin + '/#token=' + token,
    async close() {
      // FIX61-10: a keep-alive socket left open would make close() wait for its idle timeout, so any
      // connection that is not mid-response is dropped before the server itself is closed.
      server.closeIdleConnections();
      const sockets = new Set<import('node:net').Socket>();
      server.on('connection', socket => sockets.add(socket));
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); done(); }, 2000);
        server.close(error => { clearTimeout(timer); if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else done(); });
      });
      for (const socket of sockets) socket.destroy();
      // FIX61-10: also drop pooled client keep-alive sockets pointing at this server; the agent keeps
      // the loop alive after close() otherwise, which hung the HTTP test files forever on Windows.
      server.closeAllConnections();
      if(options.mode!=='setup')await options.settings.drain();
    } };
}

import { ChatgptParallelBridge } from '../providers/chatgpt-parallel-bridge.js';
import {FileResourceStore} from '../memory/file-resource-store.js';
import {BookResourceService} from '../memory/book-resources.js';
import {focusState} from '../core/book-focus.js';
import {memoryJobId} from '../memory/automatic-book-memory.js';
import { createInterface } from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { dirname, basename, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBookRepository } from '../memory/file-book-repository.js';
import { BookRuntime } from './book-runtime.js';
import { BookHttpModel } from '../providers/book-model.js';
import { ChatgptBackgroundBridge } from '../providers/chatgpt-background-bridge.js';
import { ChatgptExtensionHost } from '../providers/chatgpt-extension-host.js';
import { ChatgptWebModel } from '../providers/chatgpt-web-model.js';
import { createModelRouter } from '../providers/model-router.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../contracts/memory-book.js';
import { BookCredentials } from '../management/book-credentials.js';
import { startBookServer } from '../management/book-server.js';
import { restrictPrivatePathSync } from '../core/platform-files.js';
import {ensureGptNiangStarter} from '../management/starter-characters.js';
import { SkinStore, BUILT_IN_SKIN_ID } from '../management/skin-store.js';
import { PortraitStore } from '../management/portrait-store.js';
import { OutfitService, writeTempImage } from '../management/outfit-service.js';
import { createWebOutfitGenerator } from '../management/outfit-web.js';
import { inspectSprite } from '../management/sprite-inspector.js';
import { DESKTOP_BRIDGE_VERSION, type BackendToDesktop, type DesktopToBackend } from '../contracts/desktop-bridge.js';
import {BookError, type RuntimeConfig} from '../contracts/memory-book.js';
import { TURN_REPLY_STYLES } from '../contracts/reply-length.js';
import { validateIdentity } from '../memory/book-validation.js';
import type { CharacterId } from '../contracts/character.js';
import { DesktopHostBridge } from './desktop-host-bridge.js';
import { CompanionBehavior, createCompanionLifeState } from '../core/companion-behavior.js';
import {interactionBindings,saveInteractionSettings} from '../core/book-interactions.js';
import {resolveLocalPetSlot} from '../contracts/local-pet.js';
import {COMPANION_INTERACTIONS,type CompanionInteraction,type CompanionInteractionControls} from '../contracts/companion-interactions.js';
import type {BookScope} from '../contracts/memory-book.js';
import type {SkinManifest} from '../contracts/skin.js';
import {abortable} from '../media/scope.js';
import { relationshipFor } from '../core/companion-relationship.js';
import { bookReplyExpression } from '../core/book-reply-expression.js';
import { BookProactiveScheduler, type ProactivePresence } from '../core/book-proactive.js';
import {BookActivity} from '../core/book-activity.js';
import type {QqChannelManager} from './qq-channel-manager.js';
import {resolveProductProfile} from './product-profile.js';
import {loadAstrbotSettings} from './astrbot-settings.js';

/** New default composition root. Only file Book, text model, management and appearance are loaded. */
export async function runBookBackend(directory: string, options: { clock?:()=>number } = {}) {
  const profile = resolveProductProfile();
  const astrbotSettings = loadAstrbotSettings(directory);
  if (astrbotSettings?.execution === 'astrbot' && !profile.modules.astrbot) throw new BookError('conflict', '当前产品组合不包含 AstrBot 连接器，不会改走本地生成。');
  const petRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), desktop = join(petRoot, 'desktop');
  const resourceService=new BookResourceService(new FileResourceStore({directory:join(directory,'resources')}));
  const erasedRequests:string[]=[];let clearCompleted=(ids:string[])=>{erasedRequests.push(...ids);};
  const repository = new FileBookRepository(directory,{resourcesForErase(scope,turnIds){
    return turnIds.flatMap(id=>resourceService.store.resourcesForTurn(scope,id));
  },onErase(scope,turnIds){
    const resourceIds=turnIds.flatMap(id=>resourceService.revokeForTurn(scope,id));
    clearCompleted(turnIds.map(id=>'aiki-reply-'+createHash('sha256').update(JSON.stringify([scope,id])).digest('hex').slice(0,40)));
    return resourceIds;
  }}), credentials = new BookCredentials(join(directory, 'credentials'));
  resourceService.sweep();
  const resourceSweepTimer=setInterval(()=>resourceService.sweep(),60*60*1000);resourceSweepTimer.unref();
  // One model port for the whole runtime (RPD_CHAT_WIKI §2.2): legacy bindings keep the HTTP path
  // exactly; `chatgpt-web` bindings route to the web adapter. The bridge instance is shared by the
  // adapter and the management surface. Embedded tasks own separate pages and durable receipts;
  // extension/CLI transports retain their single-page lease.
  const chatgptConfig = () => repository.loadConfig().chatgptWeb ?? DEFAULT_CHATGPT_WEB_SOURCE;
  const host = new DesktopHostBridge({ send: message => { if (!closing) process.stdout.write(JSON.stringify(message) + '\n'); } });
  const extension = new ChatgptExtensionHost({ keyPath: join(directory, 'chatgpt-bridge-key') });
  const chatgptBridge = new ChatgptParallelBridge({ config: chatgptConfig, prewarm:true, receiptPath: join(directory, 'chatgpt-web-requests.json'), pageHostForLane: lane => ({
    execute: (action, input) => chatgptConfig().transport === 'embedded' ? host.request('chatgpt-page', { action, input, lane }) : extension.execute(action, input),
    async navigate(temporary, project) { if (chatgptConfig().transport === 'embedded') await host.request('chatgpt-page', { action: 'navigate', temporary, ...(project?{project}: {}), lane }); else { if(project)throw new BookError('unavailable','项目导航仅支持独立页面。');await extension.navigate(temporary); } },
    async login() { if (chatgptConfig().transport === 'embedded') await host.request('chatgpt-page', { action: 'login', lane }); else await extension.login(); },
  }) });
  clearCompleted=ids=>chatgptBridge.forgetCompleted(ids);
  if(erasedRequests.length)clearCompleted(erasedRequests);
  const chatgptModel = new ChatgptWebModel({ bridge: chatgptBridge, config: chatgptConfig, runtime:()=>repository.loadConfig(), artifacts:chatgptBridge });
  const runtime = new BookRuntime(repository, createModelRouter({
    http: new BookHttpModel(id => credentials.get(id)),
    chatgpt: () => chatgptModel,
  }),{resources:resourceService,artifacts:{readArtifact:(candidate,signal)=>chatgptModel.readArtifact({projectId:candidate.scope?repository.loadConfig().chatgptProjects?.find(row=>row.enabled&&row.characterId===candidate.scope!.characterId&&row.pairingId===candidate.scope!.pairingId)?.projectId??null:null,...(candidate.requestId?{requestId:candidate.requestId}:{}),handleId:candidate.candidateId,nameHint:candidate.nameHint,messageId:candidate.messageId,...(candidate.mimeHint?{mimeHint:candidate.mimeHint}:{})},signal)},screenEnabled:profile.modules.screen});
  let qq: QqChannelManager | undefined;
  if (profile.modules.qqDirect) {
    if (astrbotSettings?.execution === 'astrbot') throw new BookError('conflict', 'AstrBot 执行与旧 QQ 直连不能同时启用。');
    const {QqChannelManager: QqManager} = await import('./qq-channel-manager.js');
    qq = new QqManager({directory:join(directory,'channels','qq'),source:repository,credentials,model:externalConfig=>{
    const web=new ChatgptWebModel({bridge:chatgptBridge,config:()=>externalConfig().chatgptWeb??DEFAULT_CHATGPT_WEB_SOURCE,runtime:externalConfig,artifacts:chatgptBridge});
    const router=createModelRouter({http:new BookHttpModel(id=>credentials.get(id)),chatgpt:()=>web});
    return {complete:(binding,messages,signal,callOptions)=>router.complete(binding,messages,signal,{...callOptions,...(binding.kind==='chatgpt-web'?{requiredThinking:'high' as const}:{})})};
  }});
  }
  let astrbotConnector: import('./astrbot-connector.js').AstrbotConnector | undefined;

  if (astrbotSettings?.execution === 'astrbot') {
    const loaded = await import('./astrbot-connector.js');
    astrbotConnector = new loaded.AstrbotConnector(directory, astrbotSettings, await credentials.get(astrbotSettings.credentialId));
    (await import('./astrbot-chat.js')).attachAstrbotChat(runtime, astrbotConnector);
  }
  // The desktop pet shares ONE addressable session with the full chat window: a stable id keeps the
  // conversation discoverable and continuable across restarts instead of orphaning a random UUID
  // session nobody can reopen. Per-character isolation comes from the scope, not from a fresh id.
  let desktopIncognito=repository.loadConfig().incognitoDefault??false,privateSessionId='private-desktop-'+randomUUID();
  const privateScope=()=>runtime.scope(activeCharacter,privateSessionId);
  const sessionId = astrbotConnector?'desktop-astrbot-'+createHash('sha256').update(JSON.stringify([astrbotSettings?.instanceId,astrbotSettings?.configId])).digest('hex').slice(0,12):'desktop'; let generation = 0, closing = false, activeController: AbortController | null = null;
  const backendInstanceId = randomUUID();
  const turnReceipts = new Map<string, Extract<BackendToDesktop, {channel:'book_turn_state'}>>();
  const receipt = (value: Extract<BackendToDesktop, {channel:'book_turn_state'}>) => {
    // A conflicting retry is reported to that caller, but cannot replace a completed turn's recovery receipt.
    if(turnReceipts.get(value.clientRequestId)?.state==='completed'&&value.state!=='completed'){
      if(value.state==='failed')send(value);
    }else turnReceipts.set(value.clientRequestId,value);
    while (turnReceipts.size > 32) turnReceipts.delete(turnReceipts.keys().next().value!);
    process.stderr.write(JSON.stringify({diagnostic:'book-turn',state:value.state,requestId:value.clientRequestId,turnId:value.scope.turnId,characterId:value.scope.characterId,sessionId,backendInstanceId})+'\n');
  };
  const send = (message: BackendToDesktop) => { if (!closing) process.stdout.write(JSON.stringify(message) + '\n'); };
  const expression = { emotion: 'neutral', intensity: 0, delivery: '', gesture: null };
  const presence:ProactivePresence = { hidden:true,dnd:false,typing:false,recording:false,busy:false,quiet:false };
  const proactive = new BookProactiveScheduler(repository,(scope,prompt,signal)=>runtime.proactive(scope,prompt,signal),
    (scope,delivery)=>send({channel:'companion_offer',characterId:scope.characterId,sessionId:scope.sessionId,id:delivery.id}),options.clock??Date.now);
  let proactiveTimer:ReturnType<typeof setInterval> | undefined;
  let skins: SkinStore | null = null, activeCharacter = repository.loadConfig().currentCharacterId;
  const activity=new BookActivity(join(directory,'keyboard-activity'),petRoot,()=>{
    if(!closing)send({channel:'book_activity',characterId:activeCharacter,view:activity.view(activeCharacter)});
  },()=>{if(!closing)send({channel:'book_activity_pulse',characterId:activeCharacter});});
  let behavior: CompanionBehavior | null = null, lifeSequence = 0, lastLifeSave = 0, lifeTimer: ReturnType<typeof setInterval> | undefined;
  const effectivePresence=():ProactivePresence=>{
    const web=runtime.interactionPresence.read();
    return {...presence,typing:presence.typing||web.typing,recording:presence.recording||web.recording,busy:presence.busy||web.busy||web.speaking||!!activeController||runtime.isConversing(activeCharacter)||runtime.synthesis.processing||runtime.organization.processing||!!runtime.wikiMaintenance?.processing||!!runtime.automaticMemory?.processing,quiet:presence.quiet||web.roleplay===true||repository.loadConfig().dialogueRouting?.defaultMode==='rp'||(behavior?.snapshot().quiet??false)||activity.view(activeCharacter).quietCompanion};
  };
  let currentManifest:SkinManifest|null=null,interactionAppearanceChanging=false,appearanceAcknowledged=false,currentAppearanceRequestId:string|null=null,interactionRequest:{id:string;characterId:string;controller:AbortController}|null=null;
  let portraits:PortraitStore|undefined;
  const appearanceWaiters=new Map<string,{resolve:()=>void;reject:(error:Error)=>void}>();
  async function presentPortrait(set:import('../contracts/portraits.js').PortraitSet){
    if(set.characterId!==activeCharacter)return;
    const role=repository.loadConfig().characters.find(row=>row.id===set.characterId);
    if(!role||!skins)throw new BookError('not_found','角色或外观资源已不可用。');
    const selected=set.variants.find(row=>row.id===set.selectedVariantId),skinId=selected?.skinId??role.appearanceSkinId??set.fallbackSkinId??BUILT_IN_SKIN_ID;
    const base=skins.manifest(skinId),manifest:SkinManifest={...base,...(base.sprite?{sprite:{...base.sprite,framing:set.framing}}:{})};
    const id=randomUUID();cancelInteraction();interactionAppearanceChanging=true;appearanceAcknowledged=false;currentAppearanceRequestId=id;
    const ready=process.env.AIKI_BOOK_WEB_ONLY==='1'?Promise.resolve():new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{appearanceWaiters.delete(id);reject(new BookError('unavailable','原生宿主未确认立绘载入，保留原选择。'));},15000);appearanceWaiters.set(id,{resolve(){clearTimeout(timer);resolve();},reject(error){clearTimeout(timer);reject(error);}});});
    send({channel:'appearance',requestId:id,manifest,routes:[...skins.routes(skinId)]});
    await ready;currentManifest=manifest;interactionAppearanceChanging=false;
    send({channel:'presentation_policy',policy:{modelId:skinId,revision:manifest.revision,enabledIds:manifest.catalog.items.filter(row=>row.availability==='automatic'&&row.defaultEnabled).map(row=>row.id)}});
  }
  function cancelInteraction(){interactionRequest?.controller.abort(new BookError('conflict','互动已被角色、设置或对话变化取消。'));}
  // The removed character's final checkpoint must remain writable after config deletion.
  const lifeScope = () => ({ characterId: activeCharacter, pairingId: 'local-user', sessionId });
  function saveLife() {
    if (!behavior) return;
    const state = behavior.snapshot();
    behavior.saved(repository.saveCompanionLife(lifeScope(), state, state.revision)); lastLifeSave = Date.now();
  }
  function publishLife() {
    if (behavior) {
      const now=Date.now(),focus=focusState(repository,lifeScope(),now),relationship=relationshipFor(repository.snapshot(lifeScope()),lifeScope(),now);
      send({ channel: 'companion_state', sequence: ++lifeSequence, state: behavior.tick(now, !!activeController,!!focus.focus),interactionRevision:focus.interactionSettings?.revision??0,focus:!!focus.focus,focusTimer:focus.focusTimer,
        ...(relationship?.emotion?{relationship:{emotion:relationship.emotion.kind==='happy'?'happy' as const:'neutral' as const,intensity:relationship.emotion.intensity,until:now+10000}}:{}) });
    }
  }
  function lifeFailure(error: unknown) {
    if (lifeTimer) clearInterval(lifeTimer); lifeTimer = undefined;
    process.stderr.write(`Companion life failed (${activeCharacter}): ${error instanceof Error ? error.stack : String(error)}\n`);
    send({ channel: 'companion_error', message: '自主活动失败，已停止调度。请检查本机运行日志。' });
  }
  let announcedRole: string | null = null;
  const roleAppearances=new Map<string,string>();
  function assertInteractionOwner(scope:BookScope):void{
    if(scope.characterId!==activeCharacter||scope.pairingId!=='local-user'||!behavior||!currentManifest||interactionAppearanceChanging)throw new BookError('unavailable','请先切换到当前桌面角色并等待资源就绪。');
  }
  const interactionControls:CompanionInteractionControls={
    read(scope){if(scope.characterId===activeCharacter&&scope.pairingId==='local-user'&&(interactionAppearanceChanging||!behavior||!currentManifest))return {available:false,reason:'桌面资源仍在加载，请稍候。'};assertInteractionOwner(scope);const state=behavior!.snapshot();return {available:true,...interactionBindings(repository,scope,currentManifest!),skinId:currentManifest!.skinId,assetFingerprint:currentManifest!.assetFingerprint,mood:state.mood,records:state.interactions??[],allowance:behavior!.interactionAllowance(Date.now()),pending:!!interactionRequest||!appearanceAcknowledged};},
    configure(scope,input,expectedRevision){
      assertInteractionOwner(scope);const before=repository.loadCompanionData(scope).interactionSettings?.revision??0;
      const saved=saveInteractionSettings(repository,scope,currentManifest!,input,expectedRevision);
      if(saved.interactionSettings?.revision!==before)cancelInteraction();publishLife();return this.read(scope);
    },
    async perform(scope,kind,id,expectedRevision,signal){
      assertInteractionOwner(scope);validateIdentity(id,'interactionId');if(!COMPANION_INTERACTIONS.includes(kind))throw new BookError('invalid_input','未知互动类型。');
      const binding=interactionBindings(repository,scope,currentManifest!),settings=binding.settings,prior=behavior!.snapshot().interactions?.find(row=>row.id===id);
      if(prior){if(prior.kind!==kind)throw new BookError('conflict','同一互动ID不能切换类型。');return {controls:this.read(scope),played:false,message:prior.undone?'该互动已撤销，未重放。':'该互动已完成，未重复播放或加分。'};}
      if(!settings||settings.revision!==expectedRevision||!binding.matched)throw new BookError('conflict','请先保存当前资源的互动映射；旧资源映射不自动套用。');
      const target=binding.choices.find(row=>row.id===binding.bindings[kind]);if(!target)throw new BookError('unavailable','此互动已关闭，或当前资源没有对应动作。');
      const allowance=behavior!.interactionAllowance(Date.now());if(!allowance.allowed)throw new BookError('busy',allowance.reason);
      if(!appearanceAcknowledged||interactionRequest||activeController||runtime.isConversing(activeCharacter)||presence.typing||presence.hidden)throw new BookError('busy','资源仍在加载，或当前正在对话、隐藏、已有互动，请就绪后再试。');
      const manifest=currentManifest!,request={id,characterId:activeCharacter,controller:new AbortController()},combined=AbortSignal.any([signal,request.controller.signal,AbortSignal.timeout(4500)]);interactionRequest=request;proactive.cancel();
      try{
        const result=await abortable(host.request<{played:boolean;id:string;skinId:string;assetFingerprint:string}>('companion.interact',{action:'play',id,kind,characterId:scope.characterId,pairingId:scope.pairingId,skinId:manifest.skinId,assetFingerprint:manifest.assetFingerprint,target,revision:settings.revision,until:Date.now()+4000}),combined);combined.throwIfAborted();
        assertInteractionOwner(scope);
        if(!result.played||result.id!==id||result.skinId!==currentManifest!.skinId||result.assetFingerprint!==currentManifest!.assetFingerprint||repository.loadCompanionData(scope).interactionSettings?.revision!==settings.revision)throw new BookError('conflict','互动播放期间资源或设置变更，未应用反馈。');
        const applied=behavior!.interact(kind,id,Date.now());saveLife();if(applied.applied)runtime.userInteraction(lifeScope());publishLife();
        if(interactionRequest===request)interactionRequest=null;
        return {controls:this.read(scope),played:true,message:applied.applied?'动作已实际绘制；仅记录短期心情反馈，不增加信任或改变人格。':applied.reason};
      }catch(error){
        void host.request('companion.interact',{action:'stop',id,characterId:scope.characterId,pairingId:scope.pairingId}).catch(stopError=>process.stderr.write(`Interaction stop failed: ${String(stopError)}\n`));
        throw error instanceof BookError?error:new BookError('unavailable',error instanceof Error?error.message:'互动播放未确认。');
      }finally{if(interactionRequest===request)interactionRequest=null;}
    },
    async undo(scope,id){assertInteractionOwner(scope);validateIdentity(id,'interactionId');cancelInteraction();
      try{behavior!.undoInteraction(id,Date.now())}catch(cause){throw new BookError('not_found','互动不在当前实例可撤销记录中。',{cause})}saveLife();publishLife();
      await host.request('companion.interact',{action:'stop',id,characterId:scope.characterId,pairingId:scope.pairingId});return this.read(scope);
    }
  };
  async function applyCharacter(config: RuntimeConfig): Promise<void> {
    interactionAppearanceChanging=true;appearanceAcknowledged=false;
    cancelInteraction();
    if(config.currentCharacterId!==activeCharacter||!announcedRole)await activity.select(config.currentCharacterId);
    proactive.beginTakeover();
    if (config.currentCharacterId !== activeCharacter) { runtime.clearIncognito({characterId:activeCharacter,pairingId:'local-user',sessionId:privateSessionId});turnReceipts.clear();privateSessionId='private-desktop-'+randomUUID();desktopIncognito=config.incognitoDefault??false;runtime.cancel({ characterId: activeCharacter, pairingId: 'local-user', sessionId }); activeController?.abort(); saveLife(); activeCharacter = config.currentCharacterId; behavior = null; }
    const role = config.characters.find(item => item.id === activeCharacter)!;
    const appearanceKey=JSON.stringify([role.appearanceSkinId??null,role.appearancePath??null]),oldAppearanceKey=roleAppearances.get(role.id);
    if(oldAppearanceKey!==undefined&&oldAppearanceKey!==appearanceKey&&portraits?.get(role.id).selectedVariantId){const selected=portraits.get(role.id);await portraits.select(role.id,null,selected.revision,'restore-model-'+randomUUID());}
    roleAppearances.set(role.id,appearanceKey);
    if (announcedRole !== `${role.id}:${role.name}`) {
      send({ channel: 'backend_ready', bridgeVersion: DESKTOP_BRIDGE_VERSION, characterId: role.id as CharacterId, characterLabel: role.name, sessionId,
        productMode: 'memory-book', incognito:desktopIncognito, backendInstanceId, replyBudgetMs: chatgptConfig().replyBudgetMs, ...(role.intro ? { introduction: { id: `intro-${role.id}-${config.revision}`, text: role.intro } } : {}) });
      announcedRole = `${role.id}:${role.name}`;
    }
    send({channel:'book_activity',characterId:activeCharacter,view:activity.view(activeCharacter)});
    skins ??= await SkinStore.open(join(directory, 'appearance-registry.json'), join(directory, 'appearance-packs'), desktop);
    const portraitSet=portraits?.get(activeCharacter);
    let skinId = portraitSet?.variants.find(row=>row.id===portraitSet.selectedVariantId)?.skinId ?? role.appearanceSkinId ?? BUILT_IN_SKIN_ID;
    if (!portraitSet?.selectedVariantId && !role.appearanceSkinId && role.appearancePath) {
      const source = resolve(role.appearancePath), sourceInfo = await stat(source);
      const sprite = sourceInfo.isFile() && /\.(png|webp)$/i.test(source);
      const root = sourceInfo.isDirectory() ? source : dirname(source);
      let entry = sourceInfo.isFile() && source.endsWith('.model3.json') ? basename(source) : '';
      if (!entry && !sprite) {
        const candidates: string[] = []; let visited = 0;
        const scan = async (path: string) => {
          for (const child of await readdir(path, { withFileTypes: true })) {
            if (++visited > 512) throw new BookError('invalid_input', '形象包扫描超过 512 个文件。请指定 model3.json。');
            if (child.isSymbolicLink()) throw new BookError('invalid_input', '形象包不接受符号链接。');
            const file = join(path, child.name);
            if (child.isDirectory()) await scan(file); else if (child.name.endsWith('.model3.json')) candidates.push(relative(root, file).replaceAll('\\', '/'));
          }
        };
        await scan(root);
        if (candidates.length !== 1) throw new BookError('invalid_input', '形象目录必须含一个 model3.json，或直接指定入口文件。');
        entry = candidates[0]!;
      }
      skinId = `book-${createHash('sha256').update(source).digest('hex').slice(0, 20)}`;
      if (!skins.state().skins.some(skin => skin.skinId === skinId)) await skins.import(sprite ? source : root, { skinId, entry, label: role.name, ...(sprite ? { type: 'sprite' as const, sprite: { rows: 1, columns: 1, frameCount: 1, fps: 12 } } : {}) });
    }
    currentAppearanceRequestId=randomUUID();
    const baseManifest=skins.manifest(skinId),manifest:SkinManifest={...baseManifest,...(baseManifest.sprite&&portraitSet?.selectedVariantId?{sprite:{...baseManifest.sprite,framing:portraitSet.framing}}:{})};
    send({ channel: 'appearance', requestId: currentAppearanceRequestId, manifest, routes: [...skins.routes(skinId)] });
    currentManifest=manifest;
    send({ channel: 'presentation_policy', policy: { modelId: skinId, revision: manifest.revision,
      enabledIds: manifest.catalog.items.filter(item => item.availability === 'automatic' && item.defaultEnabled).map(item => item.id) } });
    if (!behavior) {
      behavior = new CompanionBehavior(repository.loadCompanionLife(lifeScope()) ?? createCompanionLifeState(lifeScope(), Date.now()));
      behavior.tick(Date.now()); saveLife();
    }
    publishLife();
    send({channel:'companion_takeover',phase:'prepare'});
    // The native transport drops messages before backend_ready. Prewarm only
    // after the handshake, and never block startup waiting for the page host.
    const projectBinding=config.chatgptProjects?.find(row=>row.enabled&&row.characterId===activeCharacter&&row.pairingId==='local-user');
    if(process.env.AIKI_BOOK_WEB_ONLY!=='1' && config.mainModel?.kind==='chatgpt-web' && !chatgptBridge.currentRequest())void chatgptBridge.warmup(config.mainModel.model,projectBinding?{binding:projectBinding,scope:lifeScope(),localTurnId:null,nextTurnId:null}:undefined).catch(error=>process.stderr.write('Chat page warmup: '+String(error)+'\n'));
    interactionAppearanceChanging=false;
  }
  let server: Awaited<ReturnType<typeof startBookServer>> | undefined;
  try {
    if (chatgptConfig().transport === 'bridge') await extension.pairing();
    skins = await SkinStore.open(join(directory, 'appearance-registry.json'), join(directory, 'appearance-packs'), desktop);
    await ensureGptNiangStarter(repository,skins,desktop);
    activeCharacter=repository.loadConfig().currentCharacterId;
    portraits = await PortraitStore.open(join(directory, 'portraits.json'), skins);
    portraits.onChange=presentPortrait;
    const outfits = new OutfitService(join(directory, 'outfits.json'), portraits, resourceService, createWebOutfitGenerator(chatgptBridge, () => repository.loadConfig()), () => repository.loadConfig(), async (bytes, mime) => {
      const file = await writeTempImage(bytes, mime);
      try {
        const sprite = await inspectSprite(file);
        const bounds = sprite.contentBounds ?? { x: 0, y: 0, width: sprite.width, height: sprite.height };
        return { width: sprite.width, height: sprite.height, minAlpha: sprite.alpha?.min ?? 0, maxAlpha: sprite.alpha?.max ?? 255, touchesEdge: bounds.x <= 1 || bounds.y <= 1 || bounds.x + bounds.width >= sprite.width - 1 || bounds.y + bounds.height >= sprite.height - 1 };
      } finally { unlinkSync(file); }
    }, async (scope, skinId) => {if(scope.characterId!==activeCharacter||currentManifest?.skinId!==skinId||process.env.AIKI_BOOK_WEB_ONLY!=='1'&&!appearanceAcknowledged)throw new BookError('conflict','当前角色或宿主载入状态已变化。');});
    let astrbotToken: string | undefined;
    if (profile.modules.astrbot) astrbotToken = (await import('../management/allmind-capabilities.js')).ensureCapabilityToken(directory);
    let gptText: import('../providers/gpt-text-endpoint.js').GptTextEndpoint | undefined;
    const gptFile = join(directory, 'gpt-text.json');
    if (existsSync(gptFile)) {
      const gptConfig = JSON.parse(readFileSync(gptFile, 'utf8')) as {enabled?: boolean; credentialId?: string};
      if (gptConfig.enabled === true) {
        if (!profile.modules.gptText) throw new BookError('conflict', '当前产品组合不包含 GPT 文本端点。');
        if (typeof gptConfig.credentialId !== 'string') throw new BookError('invalid_input', 'gpt-text.json 缺少 credentialId。');
        const binding = repository.loadConfig().mainModel;
        if (!binding || binding.kind !== 'chatgpt-web') throw new BookError('unavailable', 'GPT 文本端点只调用网页桥；当前主模型不是网页来源，没有改走其他模型。');
        gptText = {token: await credentials.get(gptConfig.credentialId), port: {async complete(messages, signal) {
          const isolated = new ChatgptWebModel({bridge:chatgptBridge,config:()=>({...chatgptConfig(),conversationMode:'temporary',temporaryChatTests:true}),runtime:()=>({...repository.loadConfig(),chatgptProjects:[]})});
          const text = await isolated.complete(binding, messages, signal);
          return {text, requestId: randomUUID()};
        }}};
      }
    }
    server = await startBookServer({ runtime, credentials, ...(qq ? {qq} : {}), profile, ...(astrbotToken ? {astrbotToken} : {}), ...(gptText ? {gptText} : {}),...(process.env.AIKI_WPF_HOST==='1'?{onChatState:(value:{state:'pending'|'completed'|'failed';scope:BookScope;text?:string;incognito?:boolean})=>send({channel:'book_chat_notice',...value})}:{}), uiRoot: join(petRoot, 'management'), onConfig: applyCharacter,onInteractionPresence:()=>proactive.cancel(),activity,...(process.env.AIKI_BOOK_WEB_ONLY==='1'?{}:{companionInteractions:interactionControls}),
      companionLife:{
        read(characterId){if(!behavior||characterId!==activeCharacter)throw new BookError('unavailable','请切换到当前桌面角色后操作。');return behavior.snapshot();},
        change(characterId,action,expectedRevision,enabled){
          if(!behavior||characterId!==activeCharacter)throw new BookError('unavailable','请切换到当前桌面角色后操作。');
          if(behavior.snapshot().revision!==expectedRevision)throw new BookError('conflict','桌宠状态已修改，请回读后重试。');
          if(action==='clear_history')behavior.clearLocalHistory();else if(action==='set_enabled')behavior.setEnabled(enabled!,Date.now());else behavior.setQuiet(enabled!);
          if(behavior.snapshot().quiet)proactive.cancel();saveLife();publishLife();return behavior.snapshot();
        }
      },
      onErase(scope,turnIds){
        if(scope.pairingId!=='local-user')return;
        const selected=new Set(turnIds);
        for(const [id,value] of turnReceipts)if(value.scope.characterId===scope.characterId&&value.scope.sessionId===scope.sessionId&&selected.has(value.scope.turnId)){
          if(value.state==='pending'&&scope.characterId===activeCharacter&&scope.sessionId===sessionId)activeController?.abort(new BookError('conflict','该轮原文已清除。'));
          turnReceipts.set(id,{channel:'book_turn_state',clientRequestId:id,scope:value.scope,state:'failed',message:'本轮原文已清除，不能恢复。'});
        }
        if(scope.sessionId===sessionId)send({channel:'book_erased',characterId:scope.characterId,sessionId:scope.sessionId,turnIds});
      },
      appearance: { skins, portraits, outfits, ...(process.env.AIKI_BOOK_WEB_ONLY === '1' ? {} : { host }) },
      chatgptWeb: chatgptBridge,
      ...(process.env.AIKI_BOOK_WEB_ONLY === '1' ? {} : {chatgptEmbedded:{login:()=>host.request('chatgpt-page',{action:'login'}),probe:()=>host.request('chatgpt-page',{action:'probe'})}}),
      chatgptPairing: reset => reset ? extension.resetPairing() : extension.pairing(),
      ...(process.env.AIKI_BOOK_PORT ? { port: Number(process.env.AIKI_BOOK_PORT) } : {}) });
    if(qq)try{await qq.restore();}catch(error){process.stderr.write('QQ channel restore failed; channel remains unavailable: '+(error instanceof BookError?error.message:'check channel settings and listener port')+'\n');}
    const sessionFile = join(directory, 'management-session.json');
    writeFileSync(sessionFile, JSON.stringify({ version: 1, url: server.url, ...server.runtimeIdentity }) + '\n', { mode: 0o600 }); restrictPrivatePathSync(sessionFile);
    process.stderr.write('Memory Book backend ready: local-file storage; optional memory and proactive companion services; local Windows speech and OCR are opt-in.\n');
    for(const role of repository.loadConfig().characters){const scope={characterId:role.id,pairingId:'local-user',sessionId};runtime.automaticMemory?.recover(scope);runtime.wikiMaintenance?.recover(scope);}
    if (process.env.AIKI_BOOK_WEB_ONLY !== '1') await applyCharacter(repository.loadConfig());
    if (process.env.AIKI_BOOK_WEB_ONLY !== '1') lifeTimer = setInterval(() => {
      try { publishLife(); if (Date.now() - lastLifeSave >= 60000) saveLife(); } catch (error) { lifeFailure(error); }
    }, 1000);
    if (!astrbotConnector && process.env.AIKI_BOOK_WEB_ONLY !== '1') proactiveTimer=setInterval(()=>{
      void proactive.tick(lifeScope(),effectivePresence()).catch(error=>{
        if(error instanceof BookError&&error.code==='conflict'){process.stderr.write(JSON.stringify({diagnostic:'proactive-cancelled',code:error.code})+'\n');return;}
        process.stderr.write(`Proactive scheduler failed: ${error instanceof Error?error.stack:String(error)}\n`);send({channel:'companion_error',message:error instanceof BookError?error.message:'主动交流失败，请检查账本与本机日志。'});
      });
    },10000);
  } catch (error) { clearInterval(resourceSweepTimer);await qq?.close();await extension.close(); await server?.close(); repository.close(); throw error; }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    let message: DesktopToBackend;
    try { message = JSON.parse(line); } catch (error) { process.stderr.write(`Invalid desktop NDJSON: ${String(error)}\n`); return; }
    if (host.receive(message)) return;
    if(message.channel==='book_activity_session'){
      if(typeof message.paused==='boolean')void activity.suspend(message.paused).catch(error=>{process.stderr.write(`Keyboard session failed: ${String(error)}\n`);});return;
    }
    if(message.channel==='book_activity_control'){
      void(async()=>{
        if(message.characterId!==activeCharacter)throw new BookError('conflict','键盘活动操作不属于当前角色。');
        if(message.action==='enable')await activity.enable(activeCharacter,message.enabled!);
        else if(message.action==='delete')await activity.remove(activeCharacter,message.day);
        else if(message.action!=='view')throw new BookError('invalid_input','未知键盘活动操作。');
        send({channel:'book_activity',characterId:activeCharacter,view:activity.view(activeCharacter)});
      })().catch(error=>{process.stderr.write(`Keyboard control failed: ${String(error)}\n`);send({channel:'companion_error',message:String(error)});});return;
    }
    if(message.channel==='ack'){if(message.requestId===currentAppearanceRequestId)appearanceAcknowledged=true;appearanceWaiters.get(message.requestId)?.resolve();appearanceWaiters.delete(message.requestId);return;}
    if(message.channel==='rpc_error'&&appearanceWaiters.has(message.requestId)){appearanceWaiters.get(message.requestId)!.reject(new Error(message.message));appearanceWaiters.delete(message.requestId);return;}
    if(message.channel==='book_privacy'){
      if(message.characterId!==activeCharacter||message.sessionId!==sessionId)return;
      if(activeController||runtime.isConversing(activeCharacter)){send({channel:'book_privacy',characterId:activeCharacter,sessionId,incognito:desktopIncognito,error:'生成中不能改变本轮隐私策略。'});return;}
      if(typeof message.incognito!=='boolean')return;
      runtime.clearIncognito(privateScope());turnReceipts.clear();privateSessionId='private-desktop-'+randomUUID();desktopIncognito=message.incognito;
      send({channel:'book_privacy',characterId:activeCharacter,sessionId,incognito:desktopIncognito});return;
    }
    if(message.channel==='book_reply_style'){
      if(message.characterId!==activeCharacter||message.sessionId!==sessionId||typeof message.requestId!=='string'||message.requestId.length>128)return;
      try{send({channel:'book_reply_style',requestId:message.requestId,characterId:activeCharacter,sessionId,decision:runtime.replyStylePreview(lifeScope(),message.text,message.replyStyle??'inherit')});}
      catch(error){send({channel:'book_reply_style',requestId:message.requestId,characterId:activeCharacter,sessionId,error:error instanceof BookError?error.message:'回复风格预览失败。'});}return;
    }
    if(message.channel==='book_thinking'){
      if(message.characterId!==activeCharacter||message.sessionId!==sessionId||typeof message.requestId!=='string'||message.requestId.length>128)return;
      void(async()=>{
        if(activeController||runtime.isConversing(activeCharacter)||chatgptBridge.currentRequest())throw new BookError('busy','生成中不能切换思考强度。');
        if(!server)throw new BookError('unavailable','管理服务尚未就绪。');
        const url=new URL(server.url),token=new URLSearchParams(url.hash.slice(1)).get('token');
        const response=await fetch(url.origin+'/api/memory-book/v1/chatgpt-web/thinking',{method:message.level===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(45000),...(message.level===undefined?{}:{body:JSON.stringify({level:message.level,expectedRevision:message.expectedRevision,operationId:message.operationId})})});
        const result=await response.json();if(!response.ok)throw new BookError('unavailable',result.error?.message??'思考强度操作失败。');
        send({channel:'book_thinking',requestId:message.requestId,characterId:message.characterId,sessionId:message.sessionId,data:result});
      })().catch(error=>{process.stderr.write('Thinking control: '+String(error)+'\n');send({channel:'book_thinking',requestId:message.requestId,characterId:message.characterId,sessionId:message.sessionId,error:error instanceof Error?error.message:String(error)});});return;
    }
    if (message.channel === 'book_turn_status') {
      if (message.characterId !== activeCharacter || message.sessionId !== sessionId || typeof message.clientRequestId !== 'string') return;
      const result = turnReceipts.get(message.clientRequestId);
      if (result && result.scope.characterId === activeCharacter) send(result);
      else if(message.clientRequestId.length<=128&&repository.loadCompanionData(lifeScope()).erasedTurns.includes(memoryJobId(lifeScope(),message.clientRequestId)))send({channel:'book_turn_state',clientRequestId:message.clientRequestId,scope:{characterId:activeCharacter,sessionId,turnId:message.clientRequestId,generation:Math.max(1,generation)},state:'failed',message:'本轮原文已清除，不能恢复。'});
      return;
    }
    if(message.channel==='companion_presence'){presence.hidden=message.hidden;presence.dnd=message.dnd;if(message.hidden||message.dnd)proactive.cancel();return;}
    if(message.channel==='presence'){presence.typing=message.isTyping;presence.busy=message.isSpeaking||message.isTurnActive;if(presence.typing||presence.busy)proactive.cancel();return;}
    if(message.channel==='companion_takeover'){
      if(message.characterId!==activeCharacter||message.stopped!==true)return;
      try{proactive.takeover(lifeScope(),message.lastShownAt,message.previouslyEnabled);send({channel:'companion_takeover',phase:'ready'});}catch(error){process.stderr.write(`Greeting takeover failed: ${String(error)}\n`);send({channel:'companion_takeover',phase:'failed'});send({channel:'companion_error',message:'问候接管失败；新主动路径尚未就绪，旧本地问候恢复。'});}return;
    }
    if(message.channel==='companion_claim'){
      if(message.characterId!==activeCharacter||message.sessionId!==sessionId||typeof message.id!=='string'||message.id.length>128)return;
      const delivery=proactive.claim(lifeScope(),message.id,effectivePresence());
      if(delivery)send({channel:'companion_message',characterId:activeCharacter,sessionId,delivery});return;
    }
    if(message.channel==='companion_ack'){if(message.characterId===activeCharacter)try{proactive.ack(lifeScope(),message.id);}catch(error){process.stderr.write(`Proactive ack failed: ${String(error)}\n`);}return;}
    if(message.channel==='local_pet_complete'){
      try{
        if(!behavior||message.characterId!==activeCharacter||message.pairingId!=='local-user'||presence.hidden||activeController||!behavior.snapshot().enabled||behavior.snapshot().quiet||focusState(repository,lifeScope(),Date.now()).focus)throw new BookError('conflict','本地互动作用域已失效。');
        if(!appearanceAcknowledged||interactionAppearanceChanging||!currentManifest||message.skinId!==currentManifest.skinId||message.assetFingerprint!==currentManifest.assetFingerprint||message.appearanceRequestId!==currentAppearanceRequestId||resolveLocalPetSlot(currentManifest.localInteractions??null,currentManifest,message.kind).availability!=='available'||message.presentation!=='played')throw new BookError('unavailable','角色没有声明对应互动，资源批次已变化，或尚未确认实际播放。');
        if(behavior.completeLocalAction(message.id,message.kind,Date.now(),message.presentation)){
          if(['petting','feeding','gifting'].includes(message.kind))behavior.interact(message.kind==='feeding'?'feed':message.kind==='gifting'?'gift':'touch',message.id,Date.now());
          saveLife();runtime.userInteraction(lifeScope());publishLife();
        }
      }catch(error){process.stderr.write(`Local interaction failed: ${String(error)}\n`);send({channel:'companion_error',message:error instanceof Error?error.message:'本地互动记录失败。'});}return;
    }
    if (message.channel === 'companion_action') {
      try {
        if (!behavior || message.characterId !== activeCharacter || message.pairingId !== 'local-user') throw new BookError('invalid_input', '自主活动操作不属于当前实例。');
        if (message.action === 'touch') {
          const binding=currentManifest?interactionBindings(repository,lifeScope(),currentManifest):null;
          if(binding?.matched&&binding.bindings.touch){
            if(!behavior.interactionAllowance(Date.now()).allowed||interactionRequest)return;
            void interactionControls.perform(lifeScope(),'touch',`touch.${Date.now()}`,binding.settings!.revision,new AbortController().signal).catch(error=>{process.stderr.write(`Mapped touch failed: ${String(error)}\n`);send({channel:'companion_error',message:error instanceof Error?error.message:'触摸反馈未确认。'});});return;
          }
          behavior.touch(Date.now());
        }
        else if(message.action==='clear_history')behavior.clearLocalHistory();
        else if (message.action === 'set_enabled' && typeof message.enabled === 'boolean') behavior.setEnabled(message.enabled, Date.now());
        else if (message.action === 'set_quiet' && typeof message.enabled === 'boolean') behavior.setQuiet(message.enabled);
        else if (message.action === 'set_focus' && typeof message.enabled === 'boolean') {runtime.setFocus(lifeScope(),message.enabled);if(message.enabled)proactive.cancel();publishLife();return;}
        else throw new BookError('invalid_input', '自主活动操作无效。');
        if(behavior.snapshot().quiet)proactive.cancel();saveLife(); publishLife();
      } catch (error) { process.stderr.write(`Companion action failed: ${error instanceof Error ? error.stack : String(error)}\n`); send({ channel: 'companion_error', message: error instanceof BookError ? error.message : '自主活动操作失败，请检查本机运行日志。' }); }
      return;
    }
    if (message.channel !== 'command') return;
    const command = message.command;
    if (command.type === 'cancel') { proactive.cancel(); activeController?.abort(); runtime.cancel(runtime.scope(activeCharacter, sessionId)); return; }
    if (command.type === 'acknowledge_introduction') return;
    if (command.type !== 'submit_text') { send({ channel: 'event', event: { type: 'error', scope: null, message: '此能力暂未启用。' } }); return; }
    if (activeController) { send({ channel: 'event', event: { type: 'error', scope: null, message: '当前回答尚未结束。' } }); return; }
    if (command.replyStyle !== undefined && command.replyStyle !== null && !TURN_REPLY_STYLES.includes(command.replyStyle)) { send({ channel: 'event', event: { type: 'error', scope: null, message: '本轮回复风格必须为沿用设置、简短、适中或详细。' } }); return; }
    const controller = new AbortController(); activeController = controller;
    cancelInteraction();
    proactive.cancel(); proactive.responded(lifeScope());
    // A retried submit replays the SAME persisted turn instead of duplicating it. The renderer sends
    // UUIDs; an id that cannot be a valid turn identity keeps a fresh one rather than blocking chat.
    let turnId: string = randomUUID();
    if (command.clientRequestId !== undefined && command.clientRequestId !== null) {
      try { validateIdentity(command.clientRequestId, 'clientRequestId'); turnId = command.clientRequestId; } catch { turnId = randomUUID(); }
    }
    const scope = { characterId: activeCharacter as CharacterId, sessionId, turnId, generation: ++generation };
    const clientRequestId = command.clientRequestId ?? turnId;

    receipt({channel:'book_turn_state',clientRequestId,scope,state:'pending'});
    send({ channel: 'event', event: { type: 'turn', input: { scope, kind: 'text', startedAt: new Date().toISOString(), text: command.text, ...(command.clientRequestId ? { clientRequestId: command.clientRequestId } : {}) } } });
    send({ channel: 'input_route', scope, route: 'companion' });
    send({ channel: 'event', event: { type: 'presentation', presentation: { scope, state: 'thinking', expression, mouth: 0 } } });
    void (async()=>{
      const result=await runtime.chat(desktopIncognito?privateScope():runtime.scope(activeCharacter, sessionId), command.text, controller.signal, { turnId,incognito:desktopIncognito,...(command.replyStyle===undefined||command.replyStyle===null?{}:{replyStyle:command.replyStyle}) });
      const attachmentCount=result.turn.artifactDeliveryId?resourceService.getDelivery(runtime.scope(activeCharacter,sessionId),result.turn.artifactDeliveryId).resourceIds.length:0;
      return {text:result.turn.assistant,attachmentCount,replyLength:result.turn.replyLength,replyStyleDecision:result.turn.replyStyleDecision};
    })().then(result => {
      controller.signal.throwIfAborted();
      if(activeController===controller)activeController=null;
      receipt({channel:'book_turn_state',clientRequestId,scope,attachmentCount:result.attachmentCount,state:'completed',text:result.text,...(result.replyLength?{replyLength:result.replyLength}:{}),...(result.replyStyleDecision?{replyStyleDecision:result.replyStyleDecision}:{})});
      send({ channel: 'event', event: { type: 'reply', reply: { scope, attachmentCount:result.attachmentCount, text: result.text, expression:bookReplyExpression(result.text),...(result.replyLength?{replyLength:result.replyLength}:{}),...(result.replyStyleDecision?{replyStyleDecision:result.replyStyleDecision}:{}) } } });
    }).catch(error => {
      receipt({channel:'book_turn_state',clientRequestId,scope,state:'failed',message:controller.signal.aborted ? '本轮已停止。' : error instanceof BookError ? error.message : '本轮失败，请检查本机运行日志。'});
      if (!controller.signal.aborted) process.stderr.write(`Memory Book turn failed: ${error instanceof Error ? error.stack : String(error)}\n`);
      send({ channel: 'event', event: { type: 'error', scope, message: controller.signal.aborted ? '本轮已停止。' : error instanceof BookError ? error.message : '本轮失败，请检查本机运行日志。' } });
    }).finally(() => {
      send({ channel: 'event', event: { type: 'presentation', presentation: { scope, state: 'idle', expression, mouth: 0 } } });
      if (activeController === controller) activeController = null;
    });
  });
  const close = async () => { if (closing) return; closing = true;clearInterval(resourceSweepTimer);cancelInteraction();if (lifeTimer) clearInterval(lifeTimer);if(proactiveTimer)clearInterval(proactiveTimer);proactive.cancel(); host.close(); activeController?.abort();
    await qq?.close();await activity.close();await runtime.wikiMaintenance?.stopActive();
    for(const role of repository.loadConfig().characters)runtime.automaticMemory?.cancel(role.id);await runtime.automaticMemory?.flush();
    try { saveLife(); } finally { for (const role of repository.loadConfig().characters) runtime.invalidate(role.id); await extension.close(); await server!.close(); repository.close(); } };
  lines.once('close', () => { void close().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }); });
  process.once('SIGTERM', () => { lines.close(); });
  process.once('SIGINT', () => { lines.close(); });
  return { runtime, server, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  void runBookBackend(resolve(process.env.AIKI_BOOK_DATA ?? join(root, '.local/memory-book'))).catch(error => { process.stderr.write(`Memory Book startup failed: ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}

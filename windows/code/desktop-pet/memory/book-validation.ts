import {validateBookScreen} from '../contracts/book-screen.js';
import { validateCompanionSettings } from '../contracts/book-companion.js';
import {validateBookVoice} from '../contracts/book-voice.js';
import { validateProjectBinding } from '../contracts/chatgpt-project.js';
import {validateReplyLength, validateReplyStyle} from '../contracts/reply-length.js';
import { BookError, type BookEntry, type BookScope, type ChatgptWebSourceConfig, type ModelBinding, type RuntimeConfig, type WikiSource } from '../contracts/memory-book.js';
import { createHash } from 'node:crypto';
import {validateStoredPreset,presetCompatibility} from './prompt-preset.js';

export function validateIdentity(value: unknown, label = 'id'): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new BookError('invalid_input', `${label} 无效。`);
}
export function validateScope(scope: BookScope): void {
  validateIdentity(scope.characterId, 'characterId'); validateIdentity(scope.pairingId, 'pairingId'); validateIdentity(scope.sessionId, 'sessionId');
}
function text(value: unknown, max: number, label: string): void {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new BookError('invalid_input', `${label} 无效或超限。`);
}
function list(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > 64) throw new BookError('invalid_input', `${label} 无效。`);
  for (const item of value) text(item, 256, label);
}
function integer(value: unknown, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new BookError('invalid_input', `${label} 无效。`);
}
function date(value: unknown): void {
  if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new BookError('invalid_input', '时间格式无效。');
}
export function validateEntry(entry: BookEntry): void {
  if(entry?.knowledgeCategory!==undefined&&!['world','persona','knowledge','companion'].includes(entry.knowledgeCategory))throw new BookError('invalid_input','知识分类无效。');
  if(entry?.corePersona!==undefined&&(typeof entry.corePersona!=='boolean'||entry.type!=='wiki'||!entry.synthesis||entry.knowledgeCategory!=='persona'))throw new BookError('invalid_input','核心人设启用只适用于已审核的人设分类派生页。');
  if (!entry || typeof entry !== 'object') throw new BookError('invalid_input', 'Entry 无效。');
  validateIdentity(entry.id); text(entry.title, 200, 'title'); text(entry.body, 65536, 'body');
  if (!['persona', 'wiki', 'story', 'lore', 'memory', 'state'].includes(entry.type) || !['authored', 'observed', 'inferred'].includes(entry.origin)) throw new BookError('invalid_input', '条目类型/来源无效。');
  if (typeof entry.enabled !== 'boolean' || typeof entry.pinned !== 'boolean') throw new BookError('invalid_input', '启用/固定标记无效。');
  integer(entry.revision, 0, Number.MAX_SAFE_INTEGER, 'revision'); integer(entry.importance, 0, 100, 'importance');
  if (entry.pairingId !== null) validateIdentity(entry.pairingId, 'pairingId');
  if (entry.type === 'memory' && entry.pairingId === null) throw new BookError('invalid_input', '真实 Memory 必须限定用户配对。');
  for (const key of ['aliases', 'tags', 'entities', 'locations', 'related', 'sourceRefs'] as const) list(entry[key], key);
  for (const id of entry.related) validateIdentity(id, 'related');
  for (const key of ['timeStart', 'timeEnd', 'validFrom', 'validUntil'] as const) date(entry[key]);
  if (entry.timeStart && entry.timeEnd && Date.parse(entry.timeStart) > Date.parse(entry.timeEnd) || entry.validFrom && entry.validUntil && Date.parse(entry.validFrom) >= Date.parse(entry.validUntil)) throw new BookError('invalid_input', '时间区间倒置。');
  if (entry.importedHash !== null && !/^[a-f0-9]{64}$/.test(entry.importedHash)) throw new BookError('invalid_input', '导入 hash 无效。');
  const trigger = entry.trigger;
  if (!trigger || !['always', 'keyword', 'regex', 'search'].includes(trigger.strategy) || !['and', 'or'].includes(trigger.operator)) throw new BookError('invalid_input', 'Trigger 无效。');
  list(trigger.keys, 'keys'); list(trigger.secondaryKeys, 'secondaryKeys');
  integer(trigger.priority, 0, 100, 'priority'); integer(trigger.stickyTurns, 0, 20, 'sticky'); integer(trigger.cooldownTurns, 0, 100, 'cooldown');
  if (trigger.strategy === 'regex') throw new BookError('unavailable', '本地 v1 暂不启用 Regex；请使用 keyword/alias。');
  if (entry.knowledge) {
    validateIdentity(entry.knowledge.worldId, 'worldId'); validateIdentity(entry.knowledge.branch, 'branch');
    integer(entry.knowledge.chapter, 0, 1000000, 'chapter');
    if (!['experienced', 'heard', 'unknown'].includes(entry.knowledge.awareness)) throw new BookError('invalid_input', '知情范围无效。');
  }
  if (entry.canon) { text(entry.canon.level, 100, 'canon'); text(entry.canon.confidence, 100, 'confidence'); }
  if (entry.authorScope !== undefined) text(entry.authorScope, 256, 'author scope');
  if (entry.event || entry.state) {
    if (entry.origin !== 'observed' || !entry.pairingId) throw new BookError('invalid_input', '实例事件与状态必须为当前配对私有。');
    if (entry.state) { if (entry.type !== 'state') throw new BookError('invalid_input', '实例 State 类型无效。'); text(entry.state.key, 100, 'state key'); text(entry.state.value, 1000, 'state value'); validateIdentity(entry.state.eventId); }
    if (entry.event) {
      const event = entry.event;
      if (entry.type !== 'memory' || !['user_message', 'author_initialization'].includes(event.basis) || !Array.isArray(event.changes) || !event.changes.length || event.changes.length > 8) throw new BookError('invalid_input', '实例事件无效。');
      validateIdentity(event.referenceId); text(event.quote, 4000, 'event quote');
      for (const change of event.changes) { text(change.key, 100, 'state key'); if (change.before !== null) text(change.before, 1000, 'state before'); text(change.after, 1000, 'state after'); validateIdentity(change.stateId); if (!event.quote.includes(change.after)) throw new BookError('invalid_input', '事件状态新值缺原文依据。'); }
    }
  }
  if (entry.organization) {
    const meta = entry.organization;
    if(meta.coexisting!==undefined&&typeof meta.coexisting!=='boolean')throw new BookError('invalid_input','并存属性标记无效。');
    if (!['real', 'rp', 'external', 'author'].includes(meta.domain) || !['observation', 'user_reported', 'source_asserted', 'hypothesis', 'user_confirmed'].includes(meta.evidenceStatus)) throw new BookError('invalid_input', '整理领域或认识状态无效。');
    if (meta.resourceRefs) {
      if (!Array.isArray(meta.resourceRefs) || meta.resourceRefs.length > 8) throw new BookError('invalid_input', '整理资源引用无效。');
      for (const ref of meta.resourceRefs) { validateIdentity(ref.resourceId, 'resourceId'); if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new BookError('invalid_input', '整理资源哈希无效。'); integer(ref.resourceRevision, 0, Number.MAX_SAFE_INTEGER, 'resourceRevision'); }
    }
  }
  if (entry.fact) {
    const f = entry.fact; validateIdentity(f.sourceId, 'sourceId');
    for (const value of [f.sourceHash, f.key]) if (!/^[a-f0-9]{64}$/.test(value)) throw new BookError('invalid_input', '事实 hash 无效。');
    for (const key of ['subject', 'predicate', 'value', 'quote'] as const) text(f[key], key === 'quote' ? 4000 : 1000, key);
    integer(f.start, 0, 65536, 'start'); integer(f.end, f.start + 1, 65536, 'end');
    if (!f.subject.trim() || !f.predicate.trim() || !f.value.trim() || !f.quote.trim() || f.key !== createHash('sha256').update(`${f.subject}\0${f.predicate}`).digest('hex') || f.end - f.start !== f.quote.length || !f.quote.includes(f.value) || !['source_asserted', 'confirmed'].includes(f.status)) throw new BookError('invalid_input', '事实证据无效。');
  }
  if (entry.synthesis) {
    const meta = entry.synthesis;
    if (entry.type !== 'wiki' || !entry.pairingId || entry.fact || meta.version !== 'allmind-wiki/v1' || !['canon', 'author', 'simulated', 'real', 'external'].includes(meta.domain)) throw new BookError('invalid_input', '派生Wiki类型或作用域无效。');
    validateIdentity(meta.pageId);
    if (meta.pageType !== undefined && !['entity', 'topic', 'event'].includes(meta.pageType)) throw new BookError('invalid_input', '派生Wiki页面类型无效。');
    if (!Array.isArray(meta.basis) || !meta.basis.length || meta.basis.length > 64 || new Set(meta.basis.map(ref => ref.entryId)).size !== meta.basis.length || !Array.isArray(meta.sources) || meta.sources.length > 64 || !Array.isArray(meta.relations) || meta.relations.length > 64) throw new BookError('invalid_input', '派生Wiki依据无效。');
    for (const ref of meta.basis) { validateIdentity(ref.entryId); integer(ref.revision, 0, Number.MAX_SAFE_INTEGER, 'basis revision'); if (!/^[a-f0-9]{64}$/.test(ref.hash)) throw new BookError('invalid_input', '派生Wiki依据hash无效。'); }
    for (const ref of meta.sources) { validateIdentity(ref.id); integer(ref.revision, 1, Number.MAX_SAFE_INTEGER, 'source revision'); if (!/^[a-f0-9]{64}$/.test(ref.hash)) throw new BookError('invalid_input', '派生Wiki来源hash无效。'); }
    for (const relation of meta.relations) { validateIdentity(relation.targetId); text(relation.label, 80, '关系标签'); list(relation.basisEntryIds, '关系依据'); if (!relation.basisEntryIds.length) throw new BookError('invalid_input', '关系缺少依据。'); relation.basisEntryIds.forEach(id => validateIdentity(id)); }
  }
}
export function validateWikiSource(source: WikiSource): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new BookError('invalid_input', 'Wiki 来源必须是对象。');
  validateIdentity(source.id, 'sourceId'); text(source.title, 200, 'source title');
  if (source.uri !== null) text(source.uri, 2000, 'source URI');
  if (source.pairingId !== null) validateIdentity(source.pairingId);
  if (typeof source.enabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(source.hash)) throw new BookError('invalid_input', '来源状态/hash 无效。');
  integer(source.revision, 1, Number.MAX_SAFE_INTEGER, 'source revision');
  if (!Array.isArray(source.forgottenKeys) || source.forgottenKeys.length > 512 || source.forgottenKeys.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new BookError('invalid_input', '遗忘记录无效。');
  if (!Array.isArray(source.snapshots) || !source.snapshots.length || source.snapshots.length > 16) throw new BookError('invalid_input', '来源快照最多 16 个；达到上限需显式归档，不自动删除。');
  const hashes = new Set<string>();
  for (const snapshot of source.snapshots) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new BookError('invalid_input', 'Wiki 来源快照必须是对象。');
    text(snapshot.text, 65536, 'source text');
    if (Buffer.byteLength(snapshot.text) > 65536 || !Number.isFinite(Date.parse(snapshot.capturedAt)) || hashes.has(snapshot.hash) || createHash('sha256').update(snapshot.text).digest('hex') !== snapshot.hash) throw new BookError('invalid_input', '来源快照内容/时间/hash 无效。');
    hashes.add(snapshot.hash);
  }
  if (!hashes.has(source.hash)) throw new BookError('invalid_input', '来源缺当前快照。');
}
export function validateFactSources(entries: BookEntry[], sources: WikiSource[]): void {
  for (const entry of entries) if (entry.fact) {
    const source = sources.find(item => item.id === entry.fact!.sourceId), snapshot = source?.snapshots.find(item => item.hash === entry.fact!.sourceHash);
    if (!source || source.pairingId !== entry.pairingId || !snapshot || snapshot.text.slice(entry.fact.start, entry.fact.end) !== entry.fact.quote) throw new BookError('invalid_input', `事实来源无法回查：${entry.id}`);
  }
}
/** Shared by saved runtime config and the explicit draft model test; one source of binding truth. */
export function validateModelBinding(model: ModelBinding): void {
  if (!model || typeof model !== 'object') throw new BookError('invalid_input', '模型绑定无效。');
  if(model.imageInput!==undefined&&typeof model.imageInput!=='boolean')throw new BookError('invalid_input','API 图片输入设置无效。');
  if(model.structuredOutput!==undefined&&!['json-object','json-schema','prompt'].includes(model.structuredOutput))throw new BookError('invalid_input','结构化输出模式无效。');
  if (model.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(model.reasoningEffort)) throw new BookError('invalid_input', 'API reasoning effort 无效。');
  if (model.name !== undefined) text(model.name, 200, '来源名称');
  if (model.kind === 'chatgpt-web') {
    if (model.reasoningEffort !== undefined) throw new BookError('invalid_input', '网页思考强度由页面核验，不使用API参数。');
    // A web binding never pretends to be an API endpoint (RPD §3.1): no URL, no stored key.
    if (model.baseUrl !== 'chatgpt-web') throw new BookError('invalid_input', 'ChatGPT 网页绑定的地址标识必须为 chatgpt-web。');
    if (model.credentialId !== 'none') throw new BookError('invalid_input', 'ChatGPT 网页绑定不使用 API 凭据。');
    text(model.model, 200, 'model');
    integer(model.inputTokens, 512, 1000000, 'inputTokens'); integer(model.outputTokens, 1, 128000, 'outputTokens');
    if (model.outputTokens >= model.inputTokens) throw new BookError('invalid_input', '输出预留必须小于模型窗口。');
    return;
  }
  if (model.kind !== undefined && model.kind !== 'http') throw new BookError('invalid_input', '模型绑定类型无效。');
  let url: URL;
  try { url = new URL(model.baseUrl); } catch { throw new BookError('invalid_input', '模型地址无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BookError('invalid_input', '模型地址无效。');
  text(model.model, 200, 'model'); validateIdentity(model.credentialId, 'credentialId');
  integer(model.inputTokens, 512, 1000000, 'inputTokens'); integer(model.outputTokens, 1, 128000, 'outputTokens');
  if (model.outputTokens >= model.inputTokens) throw new BookError('invalid_input', '输出预留必须小于模型窗口。');
}
/** Validation-only subset view of RuntimeConfig fields this helper needs. */
export function validateChatgptWebSource(source: ChatgptWebSourceConfig): void {
  if (!source || typeof source !== 'object') throw new BookError('invalid_input', 'ChatGPT 网页来源配置无效。');
  if (source.transport !== undefined && !['bridge', 'cli', 'embedded'].includes(source.transport)) throw new BookError('invalid_input', 'ChatGPT 连接方式无效。');
  text(source.profile, 128, 'profile');
  text(source.session, 64, 'session');
  if (!source.profile.trim() || !source.session.trim()) throw new BookError('invalid_input', 'ChatGPT 网页来源的浏览器上下文与会话名不能为空。');
  if (source.binDir !== null) text(source.binDir, 1024, 'binDir');
  integer(source.replyBudgetMs, 5000, 900000, 'replyBudgetMs');
  integer(source.wikiBudgetMs, 5000, 900000, 'wikiBudgetMs');
  if (typeof source.temporaryChatTests !== 'boolean') throw new BookError('invalid_input', 'ChatGPT 网页来源的临时聊天选项无效。');
  if (source.conversationMode !== undefined && !['temporary', 'regular'].includes(source.conversationMode)) throw new BookError('invalid_input', 'ChatGPT 正式聊天模式无效。');
  if(source.thinkingLevel!==undefined)integer(source.thinkingLevel,0,8,'thinkingLevel');
  if (!['auto', 'token', 'page'].includes(source.submitMechanism)) throw new BookError('invalid_input', 'ChatGPT 网页来源的提交机制无效。');
  if (!Array.isArray(source.authorizedPurposes)) throw new BookError('invalid_input', 'ChatGPT 网页来源授权列表无效。');
  const seen = new Set<string>();
  for (const purpose of source.authorizedPurposes) {
    if (purpose !== 'reply' && purpose !== 'wiki') throw new BookError('invalid_input', 'ChatGPT 网页来源授权用途无效。');
    if (seen.has(purpose)) throw new BookError('invalid_input', 'ChatGPT 网页来源授权用途重复。');
    seen.add(purpose);
  }
}
export function validateRuntime(config: RuntimeConfig): void {
  if(config?.dialogueRouting!==undefined){
    const routing=config.dialogueRouting;
    if(!routing||typeof routing!=='object'||Array.isArray(routing)||Object.keys(routing).some(key=>!['defaultMode','profiles'].includes(key))||!['auto','smart','quick','rp'].includes(routing.defaultMode)||!routing.profiles||typeof routing.profiles!=='object'||Array.isArray(routing.profiles)||Object.keys(routing.profiles).some(key=>!['smart','quick','rp'].includes(key)))throw new BookError('invalid_input','场景路由配置无效。');
    for(const profile of Object.values(routing.profiles)){
      if(!profile||typeof profile!=='object'||Array.isArray(profile)||Object.keys(profile).some(key=>!['model','presetId','recallMode','memoryDomain','inputTokens','outputTokens'].includes(key)))throw new BookError('invalid_input','场景配置字段无效。');
      if(profile.model!==undefined)validateModelBinding(profile.model);
      if(profile.presetId!==undefined&&profile.presetId!==null&&!config.promptPresets?.some(row=>row.id===profile.presetId))throw new BookError('invalid_input','场景预设不存在。');
      if(profile.recallMode!==undefined&&!['off','smart','deep','story-rp'].includes(profile.recallMode))throw new BookError('invalid_input','场景召回模式无效。');
      if(profile.memoryDomain!==undefined&&!['all','core-only','fiction'].includes(profile.memoryDomain))throw new BookError('invalid_input','场景记忆域无效。');
      for(const value of [profile.inputTokens,profile.outputTokens])if(value!==undefined&&(!Number.isInteger(value)||value<256||value>2000000))throw new BookError('invalid_input','场景 Token 预算无效。');
      if(profile.inputTokens!==undefined&&profile.outputTokens!==undefined&&profile.inputTokens<=profile.outputTokens)throw new BookError('invalid_input','场景输入窗口必须大于输出预算。');
    }
  }
  if(config?.recall?.memoryDomain!==undefined&&!['all','core-only','fiction'].includes(config.recall.memoryDomain))throw new BookError('invalid_input','召回记忆域无效。');
  if(config?.gptNiangStarterVersion!==undefined&&config.gptNiangStarterVersion!==1)throw new BookError('invalid_input','初始角色版本无效。');
  if(config?.promptPresets!==undefined){
    if(!Array.isArray(config.promptPresets)||config.promptPresets.length>32)throw new BookError('invalid_input','对话预设最多32份。');
    const ids=new Set<string>();for(const preset of config.promptPresets){validateStoredPreset(preset);if(ids.has(preset.id))throw new BookError('invalid_input','预设 ID 重复。');ids.add(preset.id);}
  }
  if(config?.incognitoDefault!==undefined&&typeof config.incognitoDefault!=='boolean')throw new BookError('invalid_input','无痕默认设置必须为布尔值。');
  if (config?.companion !== undefined) { try { validateCompanionSettings(config.companion); } catch (cause) { throw new BookError('invalid_input', '陪伴设置无效。', { cause }); } }
  if (!config || config.schemaVersion !== 'memory-runtime/v1') throw new BookError('invalid_input', 'Runtime schema 无效。');
  if (config.replyLanguage !== undefined && !['zh-CN', 'ja-JP', 'en', 'zh-ja-ruby'].includes(config.replyLanguage)) throw new BookError('invalid_input', '回复语言无效。');
  integer(config.revision, 0, Number.MAX_SAFE_INTEGER, 'revision'); validateIdentity(config.currentCharacterId);
  if (!Array.isArray(config.characters) || !config.characters.length || config.characters.length > 128) throw new BookError('invalid_input', '角色列表无效。');
  const seen = new Set<string>();
  if(config.archivedCharacters!==undefined&&(!Array.isArray(config.archivedCharacters)||config.archivedCharacters.length>128))throw new BookError('invalid_input','归档角色列表无效。');
  for (const role of [...config.characters,...config.archivedCharacters??[]]) {
    if(role.userName!==undefined)text(role.userName,100,'用户称呼');
    if(role.promptPresetId){const preset=config.promptPresets?.find(row=>row.id===role.promptPresetId);if(!preset)throw new BookError('invalid_input','所选对话预设不存在。');const result=presetCompatibility(preset);if(result.errors.length)throw new BookError('invalid_input',result.errors.join('\n'));}
    if(role.replyLength!==undefined)validateReplyLength(role.replyLength);
    if(role.replyStyle!==undefined)validateReplyStyle(role.replyStyle);
    if(role.voice!==undefined)validateBookVoice(role.voice);if(role.screen!==undefined)validateBookScreen(role.screen);
    validateIdentity(role.id); text(role.name, 200, '角色名'); text(role.intro, 4000, '简介');
    if (role.appearancePath !== null) text(role.appearancePath, 2048, '形象路径');
    if (role.appearanceSkinId !== undefined && role.appearanceSkinId !== null) validateIdentity(role.appearanceSkinId, '形象包 ID');
    if (role.knowledgeView) { validateIdentity(role.knowledgeView.worldId); validateIdentity(role.knowledgeView.branch); integer(role.knowledgeView.cutoff, 0, 1000000, 'cutoff'); }
    if (seen.has(role.id)) throw new BookError('invalid_input', '重复角色 ID。'); seen.add(role.id);
  }
  if (!config.characters.some(role=>role.id===config.currentCharacterId)) throw new BookError('invalid_input', '当前角色不存在或已归档。');
  for (const model of [config.mainModel, config.fastModel, config.wikiModel ?? null]) {
    if (model === null) continue;
    validateModelBinding(model);
  }
  // The recall planner runs under recall.limits.plannerMs (0.1–30s): a web source would time out on
  // nearly every call, so it is refused instead of silently degrading recall (RPD D6).
  if (config.fastModel?.kind === 'chatgpt-web') throw new BookError('invalid_input', 'Fast Recall 绑定不支持 ChatGPT 网页来源（规划预算 0.1–30 秒）；请将网页来源用于主回复或 Wiki 编纂。');
  if (config.chatgptWeb !== undefined) validateChatgptWebSource(config.chatgptWeb);
  if (config.chatgptProjects !== undefined) {
    if (!Array.isArray(config.chatgptProjects) || config.chatgptProjects.length > 128) throw new BookError('invalid_input','项目绑定数量无效。');
    const instances = new Set<string>(), projects = new Set<string>(), ids = new Set<string>();
    for (const binding of config.chatgptProjects) {
      validateProjectBinding(binding);
      if (!seen.has(binding.characterId)) throw new BookError('invalid_input','项目绑定角色不存在。');
      const instance = JSON.stringify([binding.characterId,binding.pairingId]);
      const project = JSON.stringify([binding.account,binding.projectId]);
      if (instances.has(instance) || projects.has(project) || ids.has(binding.id)) throw new BookError('invalid_input','项目或实例重复绑定。');
      instances.add(instance); projects.add(project); ids.add(binding.id);
      if (binding.enabled && config.chatgptWeb?.transport !== 'embedded') throw new BookError('invalid_input','项目路由首版仅支持 AIKI 独立页面。');
    }
  }
  // A web binding selects the source declared by chatgptWeb; without that declaration it has no
  // browser context at all, so it is rejected at the config boundary instead of failing per turn.
  if ((config.mainModel?.kind === 'chatgpt-web' || config.wikiModel?.kind === 'chatgpt-web'||Object.values(config.dialogueRouting?.profiles??{}).some(row=>row.model?.kind==='chatgpt-web')) && config.chatgptWeb === undefined) {
    throw new BookError('invalid_input', 'ChatGPT 网页绑定需要同时配置 chatgptWeb 来源（浏览器上下文与会话）。');
  }
  if (!config.recall || !['off', 'smart', 'deep', 'story-rp'].includes(config.recall.mode) || typeof config.recall.continueLocalOnError !== 'boolean' || typeof config.recall.regexEnabled !== 'boolean') throw new BookError('invalid_input', '召回配置无效。');
  if (config.recall.regexEnabled) throw new BookError('unavailable', 'Regex 尚未启用。');
  const limits = config.recall.limits;
  if (!limits) throw new BookError('invalid_input', '召回限额缺失。');
  integer(limits.perRoute, 1, 10, 'perRoute'); integer(limits.candidates, 1, 40, 'candidates'); integer(limits.selected, 1, 8, 'selected'); integer(limits.related, 0, 8, 'related'); integer(limits.plannerMs, 100, 30000, 'plannerMs');
}
export function entryVisible(entry: BookEntry, scope: BookScope, now = Date.now()): boolean {
  return entry.enabled && (entry.pairingId === null || entry.pairingId === scope.pairingId)
    && (!entry.validFrom || Date.parse(entry.validFrom) <= now) && (!entry.validUntil || Date.parse(entry.validUntil) > now);
}
/** Strict frozen-turn marker: known keys only, no message bodies can be smuggled through this port. */
const FROZEN_TURN_KEYS = ['turnId','characterId','pairingId','sessionId','state','requestHash','at'] as const;
export function validateFrozenTurn(record: unknown, characterId: string): asserts record is import('../contracts/memory-book.js').FrozenTurn {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new BookError('invalid_input','失败轮次冻结标记无效。');
  const row = record as Record<string, unknown>;
  if (Object.keys(row).some(key => !(FROZEN_TURN_KEYS as readonly string[]).includes(key))) throw new BookError('invalid_input','失败轮次冻结标记含未允许字段。');
  validateIdentity(row.turnId, 'turnId'); validateIdentity(row.characterId, 'characterId');
  validateIdentity(row.pairingId, 'pairingId'); validateIdentity(row.sessionId, 'sessionId');
  if (row.characterId !== characterId) throw new BookError('invalid_input','失败轮次冻结标记不属于当前角色。');
  if (!['submitted', 'failed', 'cancelled', 'timeout'].includes(row.state as string)) throw new BookError('invalid_input','失败轮次冻结状态无效。');
  if (typeof row.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestHash)) throw new BookError('invalid_input','失败轮次冻结哈希无效。');
  if (typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) throw new BookError('invalid_input','失败轮次冻结时间无效。');
}

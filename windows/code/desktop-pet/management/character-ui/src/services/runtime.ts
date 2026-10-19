import type { Character, CompanionStats, TodayActivity, RuntimeServiceStatus, TimelineEvent, LongTermMemory, CanonSection, KnowledgeCard, TraceSession } from '../types'
export class ApiError extends Error { constructor(message: string, public status = 0) { super(message) } }
const sessionKey = 'pet-management-session-v1'
/**
 * LUI-06: the retired console is gone, so its `page`/`section` deep links resolve to in-app routes
 * (LUI_CONTRACTS §2.3) instead of being forwarded to `/legacy.html`. Returns `null` for a target this
 * UI has no home for; the caller then falls back to `/characters` rather than to an old page.
 */
function legacyTarget(page: string, section: string, id: string | null): string | null {
  const character = id ? `/characters/${encodeURIComponent(id)}` : '/current'
  const config = (tab?: string) => `${character}/config${tab ? `?tab=${tab}` : ''}`
  switch (page) {
    case 'settings': {
      if (!section) return '/settings'
      const tabs: Record<string, string> = { general: '', sources: 'sources', shortcuts: 'shortcuts', companion: 'companion', privacy: 'privacy', collection: 'collection', diagnostics: 'diagnostics', work: 'work', integrations: 'integrations', companion_knowledge: 'companion-knowledge', developer_mode: 'developer' }
      const tab = tabs[section]
      return tab === undefined ? null : tab ? `/settings?tab=${tab}` : '/settings'
    }
    case 'health': return '/settings?tab=diagnostics'
    case 'projects': case 'tasks': return '/settings?tab=work'
    case 'wechat': return '/settings?tab=integrations'
    case 'proactive': case 'perception': return '/settings?tab=privacy'
    case 'overview': case 'dashboard': return `${character}/overview`
    // `characters` with no explicit id and no section stays on the roster, as it always did.
    case 'characters':
      if (!id && !section) return '/characters'
      if (!section || ['preset', 'general', 'persona'].includes(section)) return config()
      if (section === 'models') return config('model')
      if (section === 'voice') return config('voice')
      if (section === 'appearance') return config('character')
      return null
    case 'models': return config('model')
    case 'voice': return config('voice')
    case 'skins': case 'presentation': return config('character')
    case 'memory':
      if (!section || section === 'records') return `${character}/memory`
      if (section === 'prompt') return config()
      if (section === 'context') return `${character}/chat?tab=context`
      if (section === 'dynamics' || section === 'fragments') return `${character}/memory?tab=dynamics`
      if (section === 'import') return `${character}/memory?tab=import`
      if (section === 'emotion') return config('emotion')
      return null
    case 'knowledge':
      if (!section || ['wiki', 'facts'].includes(section)) return `${character}/memory?tab=wiki`
      if (['reference', 'library', 'doc'].includes(section)) return `${character}/memory?tab=reference`
      if (section === 'import') return `${character}/memory?tab=import`
      return null
    case 'timeline': return `${character}/timeline`
    case 'events': case 'developer': return `${character}/trace`
    case 'plugins': case 'packages': return `${character}/plugins`
    case 'playground': return `${character}/chat`
    default: return null
  }
}
export function consumeSession(location: Pick<Location, 'hash' | 'pathname' | 'search'>, storage: Pick<Storage, 'getItem' | 'setItem'>, replace: (url: string) => void) {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''))
  const token = params.get('token') || storage.getItem(sessionKey) || ''
  if (token) storage.setItem(sessionKey, token)
  const page = params.get('page'), section = params.get('section'), id = params.get('character') || params.get('characterId')
  let url = location.pathname + location.search
  if (location.pathname === '/' && (page || section)) {
    // An unclaimed legacy target keeps the token scope but lands on the roster; it is never forwarded
    // to the retired console, and the token never survives in the address.
    url = (page ? legacyTarget(page, section || '', id) : null) ?? '/characters'
  }
  if (location.hash) replace(url)
  return token
}
let token = ''
if (typeof window !== 'undefined') { try { token = consumeSession(window.location, sessionStorage, url => history.replaceState(null, '', url)) } catch {} }
export function createRuntime(getToken: () => string, transport: typeof fetch = globalThis.fetch.bind(globalThis)) {
  async function request(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; responseType?: 'bytes'; timeoutMs?: number } = {}): Promise<any> {
    if (!path.startsWith('/api/') || path.includes('://')) throw new ApiError('仅允许同源管理 API')
    if (!getToken()) throw new ApiError('请在地址栏直接打开本机管理页面后重试。', 401)
    // A cloud voice-clone confirm legitimately outlives the default budget, so a caller that knows its
    // own operation is slow passes `timeoutMs` explicitly. Everything else keeps the tight default:
    // an unbounded management request is how a stalled page hides a dead backend.
    const budget = options.timeoutMs ?? (path === '/api/desktop/resource-picker' ? 5 * 60_000 : path === '/api/playground/turns' ? 75000 : 30000)
    const deadline = AbortSignal.timeout(budget), signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
    let response: Response
    try { response = await transport(path, { method: options.method || 'GET', signal, redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }) }
    catch (error) { if (options.signal?.aborted) throw error; throw new ApiError(deadline.aborted ? '请求超时，操作结果待确认，请刷新回读。' : '无法连接本机服务。旧数据不代表实时状态。') }
    if (response.ok && options.responseType === 'bytes') return response.arrayBuffer()
    let data: any
    try { data = await response.json() } catch { throw new ApiError('服务返回格式无效', response.status) }
    if (!response.ok) throw new ApiError(data?.error?.message || '管理请求失败', response.status)
    return data
  }
  const query = (path: string, values: Record<string, string>) => `${path}?${new URLSearchParams(values)}`
  const op = () => crypto.randomUUID()
  const records = (id: string, kind = 'memory', extra: Record<string,string> = {}) => request(query('/api/records', { characterId: id, kind, state: 'active', limit: '100', offset: '0', ...extra }))
  const registry = () => request('/api/characters')
  async function pairing(id: string) {
    const session = await request('/api/playground/session')
    const p = session.pairing
    return { userId: p.userId, characterId: id, characterInstanceId: p.characterId === id ? p.characterInstanceId : `${id}-default` }
  }
  const wiki = async (id: string) => request('/api/continuity/snapshot', { method: 'POST', body: { pairing: await pairing(id), includeCandidates: false } })
  const profile = (id: string) => request(query('/api/characters/profile', { characterId: id }))
  const prompt = (id: string) => request(query('/api/prompt', { characterId: id }))
  function descriptor(c: any): Character { return { id: c.id, name: c.label, tagline: c.intro || '尚未填写简介', description: c.intro || '', avatar: '/assets/avatar-neutral.svg', status: 'ready', createdAt: c.createdAt, greeting: '', personality: '', speechStyle: '', speechExamples: [], traits: [], likes: [], basicInfo: [] } }
  function timelineType(item: any): TimelineEvent['type'] | null {
    if (item.companionDetails || item.type === 'companion.turn.saved') return 'chat'
    if (item.type?.includes('invitation') || item.type?.includes('greeting')) return 'proactive'
    if (item.type?.includes('ocr')) return 'ocr'
    if (item.type?.includes('vlm') || item.type?.includes('perception')) return 'vlm'
    if (item.type?.includes('memory')) return 'memory'
    return null
  }
  async function timelinePage(id: string, extra: Record<string,string> = {}) { return request(query('/api/unified-timeline', { ...await pairing(id), domains: 'companion,collection', order: 'desc', limit: '100', ...extra })) }
  return {
    request, registry, records, wiki, profile, prompt, pairing,
    async listCharacters(): Promise<Character[]> { return (await registry()).characters.map(descriptor) },
    async getCharacter(id: string): Promise<Character | undefined> {
      const c = (await registry()).characters.find((v: any) => v.id === id); if (!c) return undefined
      const [p, body] = await Promise.all([profile(id), prompt(id)])
      return { ...descriptor(c), tagline: p.identity?.intro || c.intro || '尚未填写简介', description: p.persona?.scenario || p.identity?.intro || '', greeting: p.persona?.firstMessage || '', personality: body.text, speechExamples: p.persona?.exampleDialogue ? [p.persona.exampleDialogue] : [] }
    },
    async createCharacter(label: string, operationId: string) { return request('/api/characters', { method: 'POST', body: { label, operationId } }) },
    async selectCharacter(id: string, expectedRevision: number) { return request('/api/characters/selection', { method: 'PUT', body: { characterId: id, expectedRevision, operationId: op() } }) },
    async getStats(id: string): Promise<CompanionStats> {
      const [mem, w, turns] = await Promise.allSettled([records(id), wiki(id), request(query('/api/traces', { characterId: id, limit: '1' }))])
      return { companionshipDays: '未提供', conversationCount: turns.status === 'fulfilled' ? turns.value.total : '读取失败', longTermMemoryCount: mem.status === 'fulfilled' ? mem.value.total : '读取失败', wikiCount: w.status === 'fulfilled' ? w.value.wiki.length : '读取失败' }
    },
    async getTodayActivity(id: string): Promise<TodayActivity> {
      const from = new Date(); from.setHours(0,0,0,0)
      const page = await timelinePage(id, { from: from.toISOString(), to: new Date().toISOString() }), items = page.items
      if (page.nextCursor) return { chats: '未提供', perceptions: '未提供', memoriesGenerated: '未提供', proactiveCount: '未提供' }
      return { chats: items.filter((v: any) => timelineType(v) === 'chat').length, perceptions: '未提供', memoriesGenerated: '未提供', proactiveCount: items.filter((v: any) => timelineType(v) === 'proactive').length }
    },
    async getRuntimeStatus(id: string): Promise<RuntimeServiceStatus[]> {
      const snap = await request('/api/snapshot')
      if (snap.runtime.characterId !== id) return [{ key: 'inactive', label: '角色运行', status: 'unconfigured', detail: '该角色未运行，浏览不会切换运行角色' }]
      return snap.modules.map((m: any) => ({ key: m.id, label: m.label, status: ({ ready: 'ok', busy: 'loading', error: 'error', unavailable: 'unconfigured', unknown: 'unconfigured' } as any)[m.status] || 'unconfigured', detail: m.detail }))
    },
    async listTimeline(id: string): Promise<TimelineEvent[]> {
      return (await timelinePage(id)).items.flatMap((v: any) => { const type = timelineType(v); if (!type) return []
        return [{ id: v.eventId, characterId: id, type, timestamp: v.occurredAt, time: new Date(v.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: type === 'chat' ? '对话' : v.summary, summary: v.summary, source: v.sourceRef?.id || v.type, detail: v.companionDetails ? `你：${v.companionDetails.userText}\n角色：${v.companionDetails.assistantText}` : v.summary }] })
    },
    async listLongTermMemories(id: string): Promise<LongTermMemory[]> { return (await records(id)).records.map((v: any) => ({ id: v.id, date: new Date(v.createdAt).toLocaleDateString(), time: new Date(v.createdAt).toLocaleTimeString(), title: '长期记忆', summary: v.text, tags: [{ label: v.origin, tone: 'blue' }] })) },
    async listCanonSections(id: string): Promise<CanonSection[]> { const [p,b] = await Promise.all([profile(id), prompt(id)]); return [{ id: 'persona', title: '人格设定', summary: b.text, items: [] }, { id: 'scenario', title: '背景', summary: p.persona?.scenario || '尚未填写', items: [] }, { id: 'examples', title: '示例对话', summary: p.persona?.exampleDialogue || '尚未填写', items: [] }] },
    async listKnowledge(id: string): Promise<KnowledgeCard[]> { return (await wiki(id)).wiki.map((v: any) => ({ id: v.id, title: v.title || v.kind || '陪伴知识', summary: v.text || v.content || '', tags: v.tags || [], category: 'other', source: 'chat', updatedAt: v.updatedAt || v.createdAt || '' })) },
    knowledgeCategories() { return [{ id: 'all' as const, label: '全部' }, { id: 'other' as const, label: '未分类知识' }] },
    knowledgeSourceFilters() { return [{ id: 'all' as const, label: '全部' }, { id: 'chat' as const, label: '陪伴记录' }] },
    async listTraceSessions(id: string): Promise<TraceSession[]> { return (await request(query('/api/traces', { characterId: id, limit: '100' }))).traces.map((v: any) => ({ id: v.traceId || v.turnId || v.id, time: v.startedAt || v.createdAt || '', summary: v.status || '轮次', tokensIn: v.tokens?.inputTokens, tokensOut: v.tokens?.outputTokens, steps: (v.stages || []).map((s: any) => ({ name: s.label || s.name, status: s.status === 'failed' ? 'error' : s.status === 'ok' ? 'ok' : 'pending', latencyMs: s.elapsedMs, provider: s.details?.provider, detail: JSON.stringify(s.details || { status: s.status }, null, 2) })) })) },
    async getBindings(id: string) { return request(query('/api/characters/bindings', { characterId: id })) },
    async saveBinding(id: string, slot: string, view: any, selection: any, mode: string) {
      let binding: any = { mode: 'inherit-default' }
      if (mode === 'own') { const source = await request('/api/provider-sources', { method: 'POST', body: { characterId: id, slot, selection } }); binding = { mode: 'own', sourceInstanceId: source.entry.source.sourceId, modelProfileId: source.entry.profile.modelProfileId, ...(source.entry.source.auth.kind === 'credentialRef' ? { credentialRef: source.entry.source.auth.ref } : {}) } }
      return request('/api/characters/bindings', { method: 'PUT', body: { characterId: id, expectedRevision: view.configuration.savedRevision, operationId: op(), bindings: { [slot]: binding } } })
    },
    async savePrompt(id: string, revision: number, text: string) { return request('/api/prompt', { method: 'PUT', body: { characterId: id, expectedRevision: revision, text, operationId: op() } }) },
    async saveProfile(id: string, view: any, fields: any) { return request('/api/characters/profile', { method: 'PUT', body: { characterId: id, expectedFieldRevision: view.fieldRevision, operationId: op(), ...fields } }) },
    async fetchModels(id: string, slot: string, selection: any) { return request('/api/provider-sources/discover', { method: 'POST', body: { characterId: id, slot, protocol: selection.protocol || 'openai-compatible', endpoint: selection.endpoint, credentialRef: selection.credentialRef || '', auth: selection.auth || 'credentialRef' } }) },
    async getSession(id: string) { const session = await request('/api/playground/session'); if (session.pairing.characterId !== id) throw new ApiError('该角色尚未运行；请显式选择并重启后再对话。'); return session },
    async submitTurn(session: any, text: string, operationId: string) { return request('/api/playground/turns', { method: 'POST', body: { pairing: session.pairing, sessionId: session.sessionId, expectedConfigRevision: session.effectiveConfigRevision, text, operationId } }) },
    async getTurn(id: string, signal?: AbortSignal) { return request(`/api/playground/turns/${encodeURIComponent(id)}`, { signal }) },
    async cancelTurn(id: string) { return request(`/api/playground/turns/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }) },
    // RUX-02: ask the host to restart the managed backend. The request settles only when the host
    // acknowledged; the page reloads itself afterwards to re-read the new instance's state.
    async restartDesktop() {
      await request('/api/desktop/restart', { method: 'POST', body: {}, timeoutMs: 40000 })
    },
    async getSnapshotSafe(): Promise<any> { try { return await request('/api/snapshot') } catch { return null } },
    // --- WV0-03: character Wiki v0 import endpoints (same Bearer/timeout/no-store as above) ---
    async previewWikiImport(characterId: string, inputKind: 'file' | 'clipboard', sourceName: string, text: string) {
      return request('/api/characters/wiki/import/preview', { method: 'POST', body: { apiVersion: 1, characterId, inputKind, sourceName, text } })
    },
    async saveWikiDraft(characterId: string, inputKind: 'file' | 'clipboard', sourceName: string, text: string, operationId: string, previewHash: string) {
      return request('/api/characters/wiki/import/drafts', { method: 'POST', body: { apiVersion: 1, characterId, inputKind, sourceName, text, operationId, previewHash } })
    },
    async previewWikiApply(characterId: string, importId: string) {
      return request('/api/characters/wiki/apply/preview', { method: 'POST', body: { characterId, importId } })
    },
    async applyWiki(characterId: string, importId: string, documentHash: string, expectedPackRevision: number, operationId: string) {
      return request('/api/characters/wiki/apply', { method: 'POST', body: { characterId, importId, documentHash, expectedPackRevision, operationId, userConfirmed: true } })
    },
    async wikiVersions(characterId: string) { return request(query('/api/characters/wiki/versions', { characterId })) },
    /** CB-04: the active pack's canon Wiki facts (read-only), so the Wiki tab shows real content. */
    async wikiFacts(characterId: string) { return request(query('/api/characters/wiki/facts', { characterId })) },
    async previewWikiRollback(characterId: string, targetPackId: string) {
      return request('/api/characters/wiki/rollback/preview', { method: 'POST', body: { characterId, targetPackId } })
    },
    async rollbackWiki(characterId: string, targetPackId: string, expectedPackRevision: number, operationId: string) {
      return request('/api/characters/wiki/rollback', { method: 'POST', body: { characterId, targetPackId, expectedPackRevision, operationId, userConfirmed: true } })
    },
    // --- CB-04: unified character document (.aiki.md) import endpoints ---
    // Same Bearer/timeout/no-store path as the Wiki methods; the panel never sees the token.
    async previewDocument(characterId: string, inputKind: 'file' | 'paste', sourceName: string, text: string) {
      return request('/api/characters/documents/preview', { method: 'POST', body: { apiVersion: 1, characterId, inputKind, sourceName, text } })
    },
    async saveDocumentDraft(characterId: string, inputKind: 'file' | 'paste', sourceName: string, text: string, operationId: string, previewHash: string) {
      return request('/api/characters/documents/drafts', { method: 'POST', body: { apiVersion: 1, characterId, inputKind, sourceName, text, operationId, previewHash } })
    },
    async listDocumentDrafts(characterId: string) { return request(query('/api/characters/documents/drafts', { characterId })) },
    async previewDocumentApply(characterId: string, importId: string, expectedRevisions: Record<string, number | null>) {
      return request('/api/characters/documents/apply/preview', { method: 'POST', body: { apiVersion: 1, characterId, importId, expectedRevisions } })
    },
    async applyDocument(characterId: string, importId: string, documentHash: string, selection: any, expectedRevisions: Record<string, number | null>, operationId: string) {
      return request('/api/characters/documents/apply', { method: 'POST', body: { apiVersion: 1, characterId, importId, documentHash, selection, expectedRevisions, operationId, userConfirmed: true } })
    },
    async previewDocumentRollback(characterId: string, operationId: string) {
      return request('/api/characters/documents/rollback/preview', { method: 'POST', body: { apiVersion: 1, characterId, operationId } })
    },
    async rollbackDocument(characterId: string, operationId: string) {
      return request('/api/characters/documents/rollback', { method: 'POST', body: { apiVersion: 1, characterId, operationId, userConfirmed: true } })
    },
    async getDocumentOperation(characterId: string, operationId: string) {
      return request(query(`/api/characters/documents/operations/${encodeURIComponent(operationId)}`, { characterId }))
    },
    async exportDocument(characterId: string) {
      return request(query('/api/characters/documents/export', { characterId }))
    },
    /** CB-04: author initial state, shown separately from real Continuity state. */
    async authorState(characterId: string) {
      return request(query('/api/characters/documents/author-state', { characterId }))
    },
  }
}
export const runtime = createRuntime(() => sessionStorage.getItem(sessionKey) || token)

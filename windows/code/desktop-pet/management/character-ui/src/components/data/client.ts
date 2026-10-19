/**
 * 记忆 / 知识 / Timeline / Trace 的真实管理 API 适配层。
 *
 * 规则（LUI-03 AC 与 LUI_CONTRACTS §3）：
 *  - 只经 `runtime.request(path, opts)` 访问同源管理 API；不 import 旧 `management/ui` 视图/session/dom helper。
 *  - 端点名、方法与 body 字段以 `management/*-routes.ts` 与 `management/server.ts` 的实际实现为准。
 *  - 读失败抛错，绝不返回 `{ total: 0 }` 之类的假零；服务返回的角色/归属不匹配时拒绝显示。
 *  - 写操作保留 `operationId`（幂等）与 `expectedRevision`（409 不覆盖草稿），由 `actions.ts` 统一维护。
 */
export interface PairingScope {
  userId: string
  characterId: string
  characterInstanceId: string
}

export type RequestFn = (
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
) => Promise<any>

export class DataError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = '',
  ) {
    super(message)
    this.name = 'DataError'
  }
}

export const isAbort = (error: unknown) => (error as { name?: string } | null)?.name === 'AbortError'

const fail = (message: string): never => {
  throw new DataError(message)
}
const isSafeInt = (value: unknown): value is number => Number.isSafeInteger(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isDate = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value))

function expectObject(value: unknown, what: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${what}返回的数据格式无效，已拒绝显示。`)
  return value as Record<string, any>
}

function expectArray(value: unknown, what: string): any[] {
  if (!Array.isArray(value)) fail(`${what}返回的数据不完整，已拒绝显示。`)
  return value as any[]
}

// ---------------------------------------------------------------- 记录（长期记忆 / 对话原文 / 摘要 / 索引）

export const RECORD_KINDS = [
  { id: 'memory', label: '长期记忆' },
  { id: 'transcript', label: '对话原文' },
  { id: 'summary', label: '会话摘要' },
  { id: 'keyword_index', label: '关键词索引' },
  { id: 'vector_index', label: '向量索引' },
  { id: 'context_cache', label: '上下文缓存' },
] as const

export type RecordKind = (typeof RECORD_KINDS)[number]['id']

export interface ManagedRecord {
  characterId: string
  id: string
  kind: RecordKind
  version: number
  state: 'active' | 'invalidated' | 'deleted' | 'expired' | 'purged'
  text: string
  createdAt: string
  role: 'user' | 'assistant' | null
  sources: { id: string; version: number }[]
  editable: boolean
  origin: 'conversation' | 'automatic' | 'manual'
}

export interface RecordPage {
  characterId: string
  revision: number
  records: ManagedRecord[]
  total: number
  offset: number
  limit: number
}

export interface RecordQueryInput {
  kind: RecordKind
  state: 'active' | 'all'
  query?: string
  offset?: number
  limit?: number
  from?: string
  to?: string
}

function managedRecord(value: unknown, characterId: string): ManagedRecord {
  const record = expectObject(value, '记录')
  if (record.characterId !== characterId) fail('服务返回的记录不属于当前角色，已隐藏这批记录。')
  if (!isText(record.id) || !isSafeInt(record.version)) fail('记录标识或版本无效，已隐藏这批记录。')
  if (!RECORD_KINDS.some(kind => kind.id === record.kind)) fail('记录类别无法识别，已隐藏这批记录。')
  return record as ManagedRecord
}

export async function readRecords(
  request: RequestFn,
  characterId: string,
  input: RecordQueryInput,
  signal?: AbortSignal,
): Promise<RecordPage> {
  const params = new URLSearchParams({
    characterId,
    kind: input.kind,
    state: input.state,
    query: input.query ?? '',
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 30),
  })
  if (input.from) params.set('from', input.from)
  if (input.to) params.set('to', input.to)
  const page = expectObject(await request(`/api/records?${params.toString()}`, { signal }), '记录列表')
  if (page.characterId !== characterId) fail('服务返回的角色与当前页面不一致，已隐藏这批记录。')
  if (!Array.isArray(page.records) || !isSafeInt(page.total) || !isSafeInt(page.offset) || !isSafeInt(page.limit)) {
    fail('记录列表返回的数据不完整，已隐藏这批记录。')
  }
  return {
    characterId,
    revision: page.revision,
    records: (page.records as unknown[]).map(value => managedRecord(value, characterId)),
    total: page.total as number,
    offset: page.offset as number,
    limit: page.limit as number,
  }
}

// ---------------------------------------------------------------- 记忆动态 / 实际召回 / 上下文

export interface MemoryDynamicsItem {
  record: ManagedRecord & { kind: RecordKind | 'emotion' }
  dynamics: {
    activation: number
    emotion: number
    traits: {
      category: 'event' | 'stable_profile' | 'unassessed'
      importance: 0 | 0.5 | 1
      emotion: { status: 'missing' | 'invalid' | 'observed'; intensity: number | null; sources: { id: string; version: number }[] }
      evidenceSources: { id: string; version: number }[]
    }
    halfLifeDays: number | null
    evaluatedAt: string
    anchorAt: string
    policyRevision: number
    lastReinforcedDay: string | null
    lineageIds: string[]
  } | null
  relatedIds: string[]
}

export interface MemoryDynamicsSnapshot {
  characterId: string
  dataRevision: number
  evaluatedAt: string
  policy: { revision: number; effectiveAt: string; policy: MemoryPolicy; restoredFromRevision: number | null }
  policyHistory: { revision: number; effectiveAt: string; policy: MemoryPolicy; restoredFromRevision: number | null }[]
  items: MemoryDynamicsItem[]
  total: number
  offset: number
  limit: number
  timeZone: string
}

export interface MemoryPolicy {
  baseHalfLifeDays: number
  emotionHalfLifeDays: number
  baselineWeight: number
  activationWeight: number
  importanceWeight: number
  emotionWeight: number
}

export const MEMORY_POLICY_LIMITS: Record<keyof MemoryPolicy, [number, number]> = {
  baseHalfLifeDays: [15, 60],
  emotionHalfLifeDays: [3.5, 14],
  baselineWeight: [0.5, 0.6],
  activationWeight: [0.2, 0.3],
  importanceWeight: [0.1, 0.2],
  emotionWeight: [0, 0.1],
}

export function policyProblem(policy: Partial<MemoryPolicy> | null | undefined): string {
  if (!policy) return '尚未读取到记忆策略。'
  for (const [key, [min, max]] of Object.entries(MEMORY_POLICY_LIMITS) as [keyof MemoryPolicy, [number, number]][]) {
    const value = policy[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      return `${key} 必须在 ${min}–${max} 之间。`
    }
  }
  const sum = policy.baselineWeight! + policy.activationWeight! + policy.importanceWeight! + policy.emotionWeight!
  if (Math.abs(sum - 1) > 1e-9) return '四项权重之和必须为 1。'
  return ''
}

export async function readMemoryDynamics(
  request: RequestFn,
  characterId: string,
  input: { query?: string; state?: 'active' | 'all'; offset?: number; limit?: number },
  signal?: AbortSignal,
): Promise<MemoryDynamicsSnapshot> {
  const params = new URLSearchParams({
    characterId,
    query: input.query ?? '',
    state: input.state ?? 'active',
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 20),
  })
  const data = expectObject(await request(`/api/memory/dynamics?${params.toString()}`, { signal }), '记忆动态')
  if (data.characterId !== characterId) fail('服务返回了其他角色的记忆动态，已拒绝显示。')
  if (!isSafeInt(data.dataRevision) || !isDate(data.evaluatedAt) || !isSafeInt(data.total)) fail('记忆动态快照格式不匹配，请刷新后重试。')
  const policy = expectObject(data.policy, '记忆策略')
  if (!isSafeInt(policy.revision) || !isDate(policy.effectiveAt)) fail('记忆策略版本无效，已拒绝显示。')
  expectArray(data.policyHistory, '记忆策略历史')
  expectArray(data.items, '记忆动态条目')
  return data as MemoryDynamicsSnapshot
}

export interface RecallTrace {
  id: string
  kind: 'actual'
  scope: { characterId: string; sessionId: string; turnId: string; generation: number }
  dataRevision: number
  policyRevision: number
  evaluatedAt: string
  candidates: {
    source: { id: string; version: number }
    activation: number
    importance: number
    emotion: number
    relevance: number
    priority: number
    matchedTerms: string[]
    cueKind: 'keywords' | 'phrase' | 'supported_relation' | 'none'
    selected: boolean
    omission: string | null
  }[]
  countedInputTokens: number
  inputTokenBudget: number
  status: 'assembled' | 'consumed' | 'invalidated'
}

export async function readRecallTraces(
  request: RequestFn,
  characterId: string,
  input: { offset?: number; limit?: number },
  signal?: AbortSignal,
): Promise<{ records: RecallTrace[]; total: number; offset: number; limit: number }> {
  const params = new URLSearchParams({ characterId, offset: String(input.offset ?? 0), limit: String(input.limit ?? 10) })
  const data = expectObject(await request(`/api/memory/traces?${params.toString()}`, { signal }), '实际召回轨迹')
  if (data.characterId !== characterId) fail('服务返回了其他角色的召回轨迹，已拒绝显示。')
  const records = expectArray(data.records, '实际召回轨迹')
  for (const value of records) {
    const trace = expectObject(value, '召回轨迹')
    if (trace.scope?.characterId !== characterId) fail('召回轨迹归属不匹配，已拒绝显示。')
    expectArray(trace.candidates, '召回候选')
  }
  if (!isSafeInt(data.total)) fail('实际召回轨迹缺少总数，已拒绝显示。')
  return { records: records as RecallTrace[], total: data.total, offset: data.offset ?? input.offset ?? 0, limit: data.limit ?? input.limit ?? 10 }
}

export interface ManagedContext {
  characterId: string
  revision: number
  query: string
  prompt: string
  recent: ManagedRecord[]
  summaries: ManagedRecord[]
  memories: ManagedRecord[]
  note: string
  inspection?: Record<string, any>
}

/** 只读试算：按当前数据重新组装上下文，不代表历史实际使用记录。 */
export async function readContext(request: RequestFn, characterId: string, query: string, signal?: AbortSignal): Promise<ManagedContext> {
  const params = new URLSearchParams({ characterId, query })
  const data = expectObject(await request(`/api/context?${params.toString()}`, { signal }), '上下文试算')
  if (data.characterId !== characterId) fail('服务返回了其他角色的上下文，已拒绝显示。')
  return data as ManagedContext
}

export interface PromptView {
  characterId: string
  revision: number
  text: string
}

export async function readPrompt(request: RequestFn, characterId: string, signal?: AbortSignal): Promise<PromptView> {
  const data = expectObject(await request(`/api/prompt?${new URLSearchParams({ characterId })}`, { signal }), '角色设定')
  if (data.characterId !== characterId) fail('服务返回了其他角色的设定，已拒绝显示。')
  if (!isSafeInt(data.revision)) fail('角色设定缺少修订号，已拒绝显示。')
  return data as PromptView
}

export async function readProfile(request: RequestFn, characterId: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const data = expectObject(await request(`/api/characters/profile?${new URLSearchParams({ characterId })}`, { signal }), '角色资料')
  if (data.characterId && data.characterId !== characterId) fail('服务返回了其他角色的资料，已拒绝显示。')
  return data
}

// ---------------------------------------------------------------- 连续性（用户事实 / 待审候选）

export interface ContinuityFact {
  id: string
  pairing: PairingScope
  layer: 'user_soul' | 'user_wiki' | 'relationship'
  kind: string
  status: 'candidate' | 'active' | 'superseded' | 'revoked' | 'expired'
  text: string
  sourceIds: string[]
  origin: string
  evidenceEligible: boolean
  createdAt: string
  updatedAt: string
  version: number
  revision: number
}

export interface ContinuitySnapshot {
  pairing: PairingScope
  revision: number
  soul: ContinuityFact[]
  wiki: ContinuityFact[]
  relationship: ContinuityFact[]
  candidates: ContinuityFact[]
}

const CONTINUITY_LAYERS = ['user_soul', 'user_wiki', 'relationship']

function continuityFact(value: unknown, pairing: PairingScope): ContinuityFact {
  const fact = expectObject(value, '连续性条目')
  if (!isText(fact.id) || !isText(fact.text) || !isSafeInt(fact.version)) fail('连续性条目格式不匹配，已拒绝显示。')
  if (!CONTINUITY_LAYERS.includes(fact.layer)) fail('连续性层无法识别，已拒绝显示。')
  const owned = fact.pairing as PairingScope | undefined
  if (owned && (owned.userId !== pairing.userId || owned.characterId !== pairing.characterId || owned.characterInstanceId !== pairing.characterInstanceId)) {
    fail('服务返回了其他配对的知识条目，已拒绝显示。')
  }
  return { ...(fact as ContinuityFact), sourceIds: Array.isArray(fact.sourceIds) ? fact.sourceIds : [] }
}

export async function readContinuity(
  request: RequestFn,
  pairing: PairingScope,
  includeCandidates: boolean,
  signal?: AbortSignal,
): Promise<ContinuitySnapshot> {
  const data = expectObject(
    await request('/api/continuity/snapshot', { method: 'POST', body: { pairing, includeCandidates }, signal }),
    '知识 Wiki',
  )
  if (!isSafeInt(data.revision)) fail('知识 Wiki 缺少修订号，已拒绝显示。')
  const owned = data.pairing as PairingScope | undefined
  if (owned && owned.characterInstanceId !== pairing.characterInstanceId) fail('知识 Wiki 的配对与当前角色不一致，已拒绝显示。')
  return {
    pairing,
    revision: data.revision,
    soul: expectArray(data.soul, '用户底色').map(value => continuityFact(value, pairing)),
    wiki: expectArray(data.wiki, '用户 Wiki').map(value => continuityFact(value, pairing)),
    relationship: expectArray(data.relationship, '关系事实').map(value => continuityFact(value, pairing)),
    candidates: expectArray(data.candidates, '待审候选').map(value => continuityFact(value, pairing)),
  }
}

// ---------------------------------------------------------------- 资料库（每角色独立）

export interface KnowledgeSnapshot {
  revision: number
  activeLibraryId: string | null
  libraries: { id: string; ownerCharacterId: string; name: string; revision: number; createdAt: string; documentCount: number; bytes: number }[]
}

export interface KnowledgeDocument {
  id: string
  libraryId: string
  sourceName: string
  bytes: number
  revision: number
  createdAt: string
}

const knowledgeQuery = (characterId: string) => new URLSearchParams({ characterId }).toString()

function knowledgeSnapshot(value: unknown, characterId: string): KnowledgeSnapshot {
  const data = expectObject(value, '资料库')
  if (!isSafeInt(data.revision) || !Array.isArray(data.libraries)) fail('资料库返回的数据不完整，已拒绝显示。')
  for (const library of data.libraries) {
    const entry = expectObject(library, '资料库条目')
    if (entry.ownerCharacterId && entry.ownerCharacterId !== characterId) fail('服务返回了其他角色的资料库，已拒绝显示。')
    if (!isText(entry.id) || !isText(entry.name)) fail('资料库条目格式无效，已拒绝显示。')
  }
  return data as KnowledgeSnapshot
}

export async function readKnowledge(request: RequestFn, characterId: string, signal?: AbortSignal): Promise<KnowledgeSnapshot> {
  return knowledgeSnapshot(await request(`/api/knowledge?${knowledgeQuery(characterId)}`, { signal }), characterId)
}

export async function createKnowledgeLibrary(request: RequestFn, characterId: string, name: string): Promise<KnowledgeSnapshot> {
  return knowledgeSnapshot(await request(`/api/knowledge/libraries?${knowledgeQuery(characterId)}`, { method: 'POST', body: { name } }), characterId)
}

export async function renameKnowledgeLibrary(
  request: RequestFn,
  characterId: string,
  input: { libraryId: string; name: string; expectedRevision: number },
): Promise<KnowledgeSnapshot> {
  return knowledgeSnapshot(
    await request(`/api/knowledge/rename?${knowledgeQuery(characterId)}`, { method: 'POST', body: input }),
    characterId,
  )
}

export async function activateKnowledgeLibrary(
  request: RequestFn,
  characterId: string,
  input: { libraryId: string | null; expectedRevision: number },
): Promise<KnowledgeSnapshot> {
  return knowledgeSnapshot(
    await request(`/api/knowledge/activate?${knowledgeQuery(characterId)}`, { method: 'POST', body: input }),
    characterId,
  )
}

export async function importKnowledgeDocuments(
  request: RequestFn,
  characterId: string,
  input: { libraryId: string; files: { sourceName: string; text: string }[] },
): Promise<KnowledgeSnapshot> {
  return knowledgeSnapshot(
    await request(`/api/knowledge/import?${knowledgeQuery(characterId)}`, { method: 'POST', body: input }),
    characterId,
  )
}

export async function readKnowledgeDocuments(request: RequestFn, characterId: string, libraryId: string, signal?: AbortSignal): Promise<KnowledgeDocument[]> {
  const docs = await request(`/api/knowledge/documents/list?${knowledgeQuery(characterId)}`, { method: 'POST', body: { libraryId }, signal })
  return expectArray(docs, '文档列表') as KnowledgeDocument[]
}

/** 正文按需读取：只在用户点击时请求，不在列表里预取，也不落盘。 */
export async function readKnowledgeDocumentContent(
  request: RequestFn,
  characterId: string,
  input: { libraryId: string; documentId: string },
  signal?: AbortSignal,
): Promise<KnowledgeDocument & { text: string }> {
  const content = expectObject(
    await request(`/api/knowledge/documents/content?${knowledgeQuery(characterId)}`, { method: 'POST', body: input, signal }),
    '文档正文',
  )
  if (!isText(content.text)) fail('文档正文为空或格式无效。')
  return content as KnowledgeDocument & { text: string }
}

export async function removeKnowledgeDocument(
  request: RequestFn,
  characterId: string,
  input: { libraryId: string; documentId: string; expectedRevision: number },
): Promise<KnowledgeSnapshot> {
  return knowledgeSnapshot(
    await request(`/api/knowledge/documents/remove?${knowledgeQuery(characterId)}`, { method: 'POST', body: input }),
    characterId,
  )
}

export async function deleteKnowledgeLibrary(
  request: RequestFn,
  characterId: string,
  input: { libraryId: string; expectedRevision: number },
): Promise<KnowledgeSnapshot> {
  return knowledgeSnapshot(
    await request(`/api/knowledge/libraries/delete?${knowledgeQuery(characterId)}`, { method: 'POST', body: input }),
    characterId,
  )
}

// ---------------------------------------------------------------- 陪伴知识（来源 / 活动 / 知识域 / 日摘要）

export async function readCompanionSources(request: RequestFn, signal?: AbortSignal): Promise<Record<string, any>> {
  const data = expectObject(await request('/api/companion/sources', { signal }), '正文来源')
  if (data.available === false) return data
  return { ...data, sources: expectArray(data.sources, '正文来源') }
}

export async function readCompanionKnowledgeDomains(request: RequestFn, signal?: AbortSignal): Promise<Record<string, any>> {
  const data = expectObject(await request('/api/companion/knowledge', { signal }), '陪伴知识域')
  return { ...data, domains: expectObject(data.domains, '陪伴知识域') }
}

export async function readCompanionActivities(request: RequestFn, input: { date?: string; limit?: number }, signal?: AbortSignal): Promise<Record<string, any>> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 50) })
  if (input.date) params.set('date', input.date)
  const data = expectObject(await request(`/api/companion/activities?${params.toString()}`, { signal }), '陪伴活动')
  return { ...data, events: expectArray(data.events, '陪伴活动') }
}

export async function readCompanionSummary(request: RequestFn, input: { date?: string }, signal?: AbortSignal): Promise<Record<string, any>> {
  const params = new URLSearchParams()
  if (input.date) params.set('date', input.date)
  return expectObject(await request(`/api/companion/daily-summaries${params.size ? `?${params.toString()}` : ''}`, { signal }), '日摘要')
}

// ---------------------------------------------------------------- Trace（工程证据）

export interface TraceStage {
  name: string
  label: string
  status: string
  elapsedMs: number
  category?: string
  details?: Record<string, unknown>
}

export interface RuntimeTrace {
  traceId: string
  turnId: string
  characterId: string
  sessionId: string
  userText: string
  replyText: string
  totalElapsedMs: number
  status: 'ok' | 'failed'
  tokens?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  stages: TraceStage[]
  createdAt: string
}

export interface TraceListResult {
  total: number
  offset: number
  limit: number
  traces: RuntimeTrace[]
  summary: { totalCount: number; avgElapsedMs: number; successRate: number; totalTokens: number }
}

export async function readTraces(
  request: RequestFn,
  characterId: string,
  input: { limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<TraceListResult> {
  const params = new URLSearchParams({ characterId, limit: String(input.limit ?? 20), offset: String(input.offset ?? 0) })
  const data = expectObject(await request(`/api/traces?${params.toString()}`, { signal }), 'Trace 列表')
  const traces = expectArray(data.traces, 'Trace 列表')
  for (const value of traces) {
    const trace = expectObject(value, 'Trace')
    if (trace.characterId !== characterId) fail('服务返回了其他角色的 Trace，已拒绝显示。')
    if (!isText(trace.traceId) || !isText(trace.turnId)) fail('Trace 标识无效，已拒绝显示。')
  }
  if (!isSafeInt(data.total) || !data.summary) fail('Trace 列表返回的数据不完整，已拒绝显示。')
  return { ...(data as TraceListResult), traces: traces as RuntimeTrace[] }
}

/** 正文按需读取；服务器按历史所有者返回 available/forgotten/unavailable，不在此处持久化。 */
export type TraceContentStatus = 'available' | 'forgotten' | 'unavailable'
export interface TraceContent {
  status: TraceContentStatus
  userText?: string
  replyText?: string
  reason?: string
}

export async function readTraceContent(request: RequestFn, traceId: string, signal?: AbortSignal): Promise<TraceContent> {
  const data = expectObject(await request(`/api/traces/${encodeURIComponent(traceId)}/content`, { signal }), 'Trace 正文')
  if (!['available', 'forgotten', 'unavailable'].includes(data.status)) fail('Trace 正文状态无法识别，已拒绝显示。')
  return data as TraceContent
}

// ---------------------------------------------------------------- 统一时间线

export const TIMELINE_DOMAINS = [
  { id: 'companion', label: 'Companion' },
  { id: 'canon', label: 'Canon' },
  { id: 'work', label: 'Work' },
  { id: 'collection', label: 'Collection' },
] as const

export type TimelineDomain = (typeof TIMELINE_DOMAINS)[number]['id']

export interface TimelineItem {
  eventId: string
  domain: TimelineDomain
  type: string
  occurredAt: string
  summary: string
  sourceRef: { id: string; version: number }
  canonDetails?: { awareness?: string; scene?: string }
  companionDetails?: { userText: string; assistantText: string; sourceIds?: string[] }
  companionActivityDetails?: { invitationId: string; actionKind: string; status: string; sourceKind?: string }
  workDetails?: { executorId: string; status: string; targetTitle: string; instruction?: string; resultSummary?: string }
}

export interface TimelineQueryInput {
  characterId: string
  userId: string
  characterInstanceId: string
  domains: TimelineDomain[]
  limit?: number
  cursor?: string | null
  from?: string
  to?: string
  activitiesOnly?: boolean
  order?: 'asc' | 'desc'
}

function timelineItem(value: unknown, domains: TimelineDomain[]): TimelineItem {
  const item = expectObject(value, '时间线事件')
  if (!isText(item.eventId) || !item.eventId) fail('时间线事件缺少标识，已拒绝显示。')
  if (!domains.includes(item.domain)) fail('时间线事件领域与筛选不符，已拒绝显示。')
  if (!isText(item.type) || !isText(item.summary) || !isDate(item.occurredAt)) fail('时间线事件格式不匹配，已拒绝显示。')
  if (!item.sourceRef || !isText(item.sourceRef.id) || !isSafeInt(item.sourceRef.version) || item.sourceRef.version < 1) {
    fail('时间线事件来源引用无效，已拒绝显示。')
  }
  return item as TimelineItem
}

export async function readTimeline(
  request: RequestFn,
  input: TimelineQueryInput,
  signal?: AbortSignal,
): Promise<{ items: TimelineItem[]; nextCursor: string | null; totalMatching: number }> {
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('时间线分页大小必须在 1–200 之间。')
  const params = new URLSearchParams({
    characterId: input.characterId,
    userId: input.userId,
    characterInstanceId: input.characterInstanceId,
    domains: input.domains.join(','),
    limit: String(limit),
  })
  if (input.cursor) params.set('cursor', input.cursor)
  if (input.from) params.set('from', input.from)
  if (input.to) params.set('to', input.to)
  if (input.activitiesOnly) params.set('activitiesOnly', 'true')
  if (input.order === 'desc') params.set('order', 'desc')
  const data = expectObject(await request(`/api/unified-timeline?${params.toString()}`, { signal }), '统一时间线')
  const items = expectArray(data.items, '统一时间线')
  if (items.length > limit) fail('统一时间线返回的事件数超过请求上限，已拒绝显示。')
  if (!isSafeInt(data.totalMatching) || data.totalMatching < 0) fail('统一时间线缺少匹配总数，已拒绝显示。')
  if (!(data.nextCursor === null || isText(data.nextCursor))) fail('统一时间线分页游标无效，已拒绝显示。')
  if (input.cursor && data.nextCursor === input.cursor) fail('时间线分页游标没有前进，请刷新后重试。')
  return { items: items.map(value => timelineItem(value, input.domains)), nextCursor: data.nextCursor, totalMatching: data.totalMatching }
}

// ---------------------------------------------------------------- 导入旧聊天 / 未完成请求

export interface ImportJob {
  id: string
  revision: number
  characterId: string
  pairing?: PairingScope
  source: { kind: 'codex-project' | 'text-export'; projectName: string; path: string }
  status: 'discovering' | 'running' | 'paused' | 'failed' | 'completed'
  createdAt: string
  updatedAt: string
  discoveredMessages: number
  processedMessages: number
  skippedMessages: number
  totalBatches: number
  completedBatches: number
  importedMemories: number
  estimatedCalls: number
  estimatedMicros: number | null
  actualCalls: number
  accountedMicros: number
  unknownCostCalls: number
  failures: { item: string; code: string }[]
  configuration: {
    model: string
    endpointHost: string
    batchMessages: number
    maxInputBytes: number
    maxOutputTokens: number
    concurrency: 1
    timeoutMs: number
    budgetMode: 'unlimited' | 'bounded'
    limitMicros: number | null
    inputMicrosPerToken: number
    outputMicrosPerToken: number
    currency: 'CNY'
    textExportFormat: string
  }
}

export interface ImportSnapshot {
  instanceId: string
  configuration: ImportJob['configuration']
  jobs: ImportJob[]
}

const IMPORT_STATUSES = ['discovering', 'running', 'paused', 'failed', 'completed']

export async function readMemoryImport(request: RequestFn, characterId: string, pairing: PairingScope | null, signal?: AbortSignal): Promise<ImportSnapshot> {
  const params = new URLSearchParams({ characterId, ...(pairing ? { userId: pairing.userId, characterInstanceId: pairing.characterInstanceId } : {}) })
  const data = expectObject(await request(`/api/memory-import?${params.toString()}`, { signal }), '导入状态')
  if (!isText(data.instanceId) || !Array.isArray(data.jobs)) fail('导入状态返回的数据不完整，已拒绝显示。')
  for (const value of data.jobs) {
    const job = expectObject(value, '导入任务')
    if (!isText(job.id) || !isSafeInt(job.revision) || job.revision < 1) fail('导入任务标识或版本无效，已拒绝显示。')
    if (!IMPORT_STATUSES.includes(job.status)) fail('导入任务状态无法识别，已拒绝显示。')
    if (job.characterId !== characterId) fail('服务返回了其他角色的导入任务，已拒绝显示。')
  }
  return data as ImportSnapshot
}

export interface PendingRequest {
  id: string
  intent: string
  status: string
  preview: string
  createdAt: string | null
}

export async function readPendingMemory(request: RequestFn, signal?: AbortSignal): Promise<{ instanceId: string; requests: PendingRequest[]; busy: boolean }> {
  const data = expectObject(await request('/api/memory-pending', { signal }), '未完成请求')
  if (!isText(data.instanceId)) fail('未完成请求缺少实例标识，已拒绝显示。')
  return { instanceId: data.instanceId, requests: expectArray(data.requests, '未完成请求') as PendingRequest[], busy: data.busy === true }
}

// ---------------------------------------------------------------- 配对

export const DEFAULT_USER = 'local-user'

/**
 * 角色 Wiki 使用的配对。
 *
 * 与 RWR-08 (F10) 一致：运行中的角色沿用服务器给出的实例标识；被浏览的其他角色按
 * `<role>-default` 派生自己的实例，绝不复用另一个角色的实例串。
 */
export function pairingFor(roleId: string, running?: Partial<PairingScope> | null): PairingScope {
  return {
    userId: running?.userId || DEFAULT_USER,
    characterId: roleId,
    characterInstanceId:
      running?.characterId === roleId && running?.characterInstanceId ? running.characterInstanceId : `${roleId}-default`,
  }
}

/** 读取运行配对；读取失败不静默伪造，交由调用方显示错误并停用写入。 */
export async function readRunningPairing(request: RequestFn, signal?: AbortSignal): Promise<PairingScope> {
  const session = expectObject(await request('/api/playground/session', { signal }), '运行会话')
  const pairing = expectObject(session.pairing, '运行配对')
  if (!isText(pairing.userId) || !isText(pairing.characterId) || !isText(pairing.characterInstanceId)) fail('运行配对格式无效，已拒绝显示。')
  return pairing as PairingScope
}

export function pairingKey(pairing: PairingScope): string {
  return `${pairing.userId}\u0000${pairing.characterId}\u0000${pairing.characterInstanceId}`
}

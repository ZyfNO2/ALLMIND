// 领域类型：Character-first 信息架构
// 注意：Timeline（故事）与 Trace（证据）模型必须保持分离

export type CharacterStatus = 'ready' | 'building'

export interface Character {
  id: string
  name: string
  kana?: string
  tagline: string
  description: string
  avatar: string
  hero?: string
  status: CharacterStatus
  lastUsedAt?: string
  createdAt: string
  // 角色设定（Character Canon）
  greeting: string
  personality: string
  speechStyle: string
  speechExamples: string[]
  traits: string[]
  likes: { icon: string; text: string }[]
  basicInfo: { label: string; value: string }[]
}

export type ServiceStatusKind = 'ok' | 'unconfigured' | 'error' | 'loading'

export interface RuntimeServiceStatus {
  key: string
  label: string
  status: ServiceStatusKind
  detail: string
}

export interface CompanionStats {
  companionshipDays: number | string
  conversationCount: number | string
  longTermMemoryCount: number | string
  wikiCount: number | string
}

export interface TodayActivity {
  chats: number | string
  perceptions: number | string
  memoriesGenerated: number | string
  proactiveCount: number | string
}

// ---- Timeline：面向用户的“故事”，不含 confidence/token/latency 等工程字段 ----
export type TimelineType = 'chat' | 'ocr' | 'vlm' | 'memory' | 'proactive'

export interface TimelineRelatedEntry {
  title: string
  kind: string
  date: string
}

export interface TimelineEvent {
  id: string
  characterId: string
  type: TimelineType
  time: string // 展示用 HH:mm
  timestamp: string // 完整时间
  title: string
  summary: string
  source: string
  detail: string
  extractedContent?: string[]
  relatedEntries?: TimelineRelatedEntry[]
  thumbnail?: string
  traceId?: string // 仅用于“查看技术详情”跳转 Trace
}

// ---- Knowledge：一级分类按语义，不按文件格式/来源 ----
export type KnowledgeCategory =
  | 'about_aika'
  | 'about_you'
  | 'people'
  | 'work'
  | 'interest'
  | 'other'

export type KnowledgeSource = 'chat' | 'ocr' | 'vlm' | 'manual' | 'wiki' | 'import'

export interface KnowledgeCard {
  id: string
  title: string
  summary: string
  tags: string[]
  category: KnowledgeCategory
  source: KnowledgeSource
  updatedAt: string
}

export interface LongTermMemory {
  id: string
  date: string
  time: string
  title: string
  summary: string
  tags: { label: string; tone: 'blue' | 'pink' | 'amber' | 'green' | 'violet' }[]
}

export interface CanonSection {
  id: string
  title: string
  summary: string
  items: string[]
}

// ---- Trace：工程证据，只存在于 Debug 区域 ----
export interface TraceStep {
  name: string
  status: 'ok' | 'error' | 'pending'
  latencyMs?: number
  provider?: string
  detail: string
}

export interface TraceSession {
  id: string
  time: string
  summary: string
  tokensIn?: number
  tokensOut?: number
  steps: TraceStep[]
}

export interface ModelConfig {
  llmProvider: string
  llmModel: string
  llmEndpoint: string
  sttEnabled: boolean
  sttProvider: string
  sttModel: string
  ttsEnabled: boolean
  ttsProvider: string
  ttsVoice: string
  vectorDb: string
  vectorPath: string
  embeddingModel: string
  retrievalLimit: number
}

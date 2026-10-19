/**
 * LUI-01: the setup vocabulary and the wire-shape validators, ported from the retired
 * `management/ui/self-setup-view.mjs`.
 *
 * The old console view is the authority for every rule in this file; it is kept independent of React
 * so the semantics can be exercised directly (node tests) instead of only through a rendered page.
 * Nothing here talks to the network, to storage or to the DOM.
 */

/** `GET /api/self-setup` is the only snapshot the first-run page trusts. */
export const SETUP_API_VERSION = 1

export const PROVIDERS = [
  { value: 'deepseek', label: 'DeepSeek · 文本模型' },
  { value: 'dashscope', label: '阿里云百炼 · 转写、多模态与 MiniMax' },
  { value: 'gemini', label: 'Google Gemini · 文本模型' },
] as const

export const VOICE_MODELS = [
  { value: 'MiniMax/speech-2.8-turbo', label: 'MiniMax Turbo · 阿里云百炼' },
  { value: 'MiniMax/speech-2.8-hd', label: 'MiniMax HD · 阿里云百炼' },
] as const

/** Server phases, in the same words the old page used. */
export const PHASES: Record<string, string> = {
  prepared: '等待确认云端创建',
  cloning: '正在创建试听',
  clone_ready: '试听已生成，尚未正式启用',
  activating: '正在正式启用',
  registered: '已登记，可选择',
  failed: '未完成',
  unknown: '结果待核实',
  cancelled: '已取消',
}

/**
 * The only error text the page may show. Anything the server did not classify is reported as an
 * unconfirmed outcome instead of an invented cause — the old page did the same.
 */
export const SAFE_ERRORS: Record<string, string> = {
  version_conflict: '配置或任务已变化，请刷新核对后再操作。',
  invalid_request: '填写的信息不符合要求，请检查后再操作。',
  unavailable: '设置服务暂不可用，请稍后刷新。',
  source_changed: '参考音频已变化，请重新选择。',
  config_changed: '模型或凭据配置已变化，请重新准备音色。',
  configuration_changed: '模型或凭据配置已变化，请重新准备音色。',
  provider_not_enabled: '请先在百炼开通所选模型及声音复刻权限。',
  credential_unavailable: '对应服务的凭据不可用，请先保存 API Key。',
  provider_rejected: '云端未完成请求，请检查模型开通与配置。',
  transport_unknown: '云端结果待核实，请刷新；不会自动重复收费。',
  operation_unavailable: '当前音色操作不可用，请刷新核对。',
  invalid_reference: '参考音频不可用，请重新上传。',
  probe_unavailable: '本机音频校验暂不可用。',
  credential_missing: '请先保存对应服务的 API Key。',
  invalid_audio: '无法使用这份参考音频，请检查格式、时长和大小。',
}

/** No server code arrives (network drop, timeout, parse failure): never guess, never auto-retry. */
export const UNCONFIRMED_OUTCOME = '操作结果尚未确认，请刷新核对；不会自动重复收费。'

export const SLOT_LABELS: Record<string, string> = {
  asr: '语音转写',
  dialogue: '对话大模型',
  memory_turn: '记忆维护',
  summary: '摘要',
  perception: '视频情绪',
  tts: '语音合成 TTS',
  admission: '轮次判断',
}

export const CREDENTIAL_STATUS_LABELS: Record<string, string> = {
  configured: '已保存（未验证调用）',
  missing: '尚未配置',
  unavailable: '不可用',
}

/** Reference audio limits, mirrored from `management/voice-reference-store.ts`. */
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
export const MIN_REFERENCE_MS = 10_000
export const MAX_REFERENCE_MS = 300_000
export const REFERENCE_SAMPLE_RATE = 24_000

export interface ProviderSelection {
  adapterId: string
  protocol?: string
  provider: string
  model: string
  endpoint: string
  credentialRef: string
  auth?: string
  inputTokenLimit: number
  outputTokenLimit: number
  reservationMicros: number
  inputMicrosPerToken: number
  outputMicrosPerToken: number
  characterMicros?: number
  audioMicrosPerSecond?: number
  thinking?: string
  voice?: string
  language?: string
  temperature?: number
}

export interface ContextSettings {
  maxRecentMessages: number
  maxMemories: number
  summaryLimit: number
  summaryMinMessages: number
  summaryMaxMessages: number
  timeoutMs: number
}

export interface ManagedSettings {
  providers: Record<string, ProviderSelection>
  context: ContextSettings
}

export interface SettingsSnapshot {
  revision: number
  effectiveRevision: number
  savedAt: string | null
  pending: boolean
  applyOn: 'restart'
  effective: ManagedSettings
  saved: ManagedSettings
  history: readonly { revision: number; savedAt: string }[]
}

export interface SetupCredential {
  id: string
  label: string
  status: 'configured' | 'missing' | 'unavailable'
  masked: string
  provider: string
  managed: boolean
}

export interface SetupAdapter {
  id: string
  label: string
  slots: readonly string[]
  provider: string
  endpoints: readonly string[]
  modelHint: string
  models: readonly string[]
  choices?: readonly { label: string; configuration: Omit<ProviderSelection, 'credentialRef'>; voices?: readonly { id: string; label: string }[] }[]
  capabilities: { instructions: boolean; cloning: boolean; voice: boolean; language: boolean; temperature: boolean }
  status: 'available' | 'not_integrated'
  note: string
  open?: true
  auth?: 'none' | 'credentialRef'
}

export interface SetupReference {
  id: string
  format: 'wav' | 'mp3' | 'm4a'
  bytes: number
  sha256: string
  durationMs: number
  createdAt: string
}

export interface SetupVoiceOperation {
  operationId: string
  revision: number
  phase: string
  referenceId: string
  label: string
  targetModel: string
  credentialRef: string
  endpoint: string
  configRevision: number
  voiceId: string
  text: string
  cloneUpperBoundMicros: number
  activationUpperBoundMicros: number
  createdAt: string
  updatedAt: string
  errorCode: string | null
  retryAvailable?: boolean
  demoAvailable: boolean
  activationAvailable: boolean
}

export interface SetupSnapshot {
  apiVersion: 1
  instanceId: string
  mode: 'first-run' | 'runtime'
  credentialRevision: number
  credentials: readonly SetupCredential[]
  adapters: readonly SetupAdapter[]
  settings: SettingsSnapshot
  references: readonly SetupReference[]
  operations: readonly SetupVoiceOperation[]
  budget: { mode: 'bounded' | 'unlimited'; limitMicros: number | null; currency: 'CNY' }
  initialization: { completed: boolean; blockers: readonly string[] }
  links: {
    dashscopeConsole: string
    dashscopeKeys: string
    voiceClone: string
    voicePricing: string
    deepseekKeys: string
    harness: string
    codex: string
  }
}

export const whole = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
export const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const knownProvider = (value: unknown): boolean => typeof value === 'string' && PROVIDERS.some(p => p.value === value || p.value === value.split('-')[0])

export const money = (micros: number): string =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(micros / 1e6) + ' 元'

/** Only an https link may become an anchor; anything else is shown as plain text. */
export function safeLink(label: string, url: unknown): { label: string; href: string | null } {
  if (typeof url !== 'string') return { label, href: null }
  try {
    if (new URL(url).protocol === 'https:') return { label, href: url }
  } catch {
    /* not a URL: rendered as text */
  }
  return { label, href: null }
}

export function validReference(value: unknown): value is SetupReference {
  const r = value as SetupReference
  return !!r && text(r.id) && ['wav', 'mp3', 'm4a'].includes(r.format) && whole(r.bytes) && r.bytes <= MAX_REFERENCE_BYTES
    && Number.isFinite(r.durationMs) && r.durationMs >= MIN_REFERENCE_MS && r.durationMs <= MAX_REFERENCE_MS && text(r.sha256)
}

export function validOperation(value: unknown): value is SetupVoiceOperation {
  const o = value as SetupVoiceOperation
  return !!o && text(o.operationId) && whole(o.revision) && Object.prototype.hasOwnProperty.call(PHASES, o.phase) && text(o.referenceId) && text(o.label)
    && VOICE_MODELS.some(m => m.value === o.targetModel) && text(o.credentialRef) && whole(o.configRevision) && typeof o.text === 'string'
    && Number.isFinite(o.cloneUpperBoundMicros) && o.cloneUpperBoundMicros >= 0
    && Number.isFinite(o.activationUpperBoundMicros) && o.activationUpperBoundMicros >= 0
    && typeof o.demoAvailable === 'boolean' && typeof o.activationAvailable === 'boolean'
}

export function validSettings(value: unknown): value is SettingsSnapshot {
  const s = value as SettingsSnapshot
  return !!s && whole(s.revision) && whole(s.effectiveRevision) && s.applyOn === 'restart'
    && !!s.saved?.providers && !!s.effective?.providers && !!s.saved.context && Array.isArray(s.history)
}

/**
 * The snapshot guard from the old page. A malformed or stale payload is refused instead of being
 * rendered as a partially-true configuration.
 */
export function snapshotProblem(value: unknown): string {
  const v = value as SetupSnapshot
  if (!v || v.apiVersion !== SETUP_API_VERSION || !text(v.instanceId) || !['first-run', 'runtime'].includes(v.mode)
    || !whole(v.credentialRevision) || !Array.isArray(v.credentials) || !Array.isArray(v.adapters) || !Array.isArray(v.references)
    || !Array.isArray(v.operations) || !v.initialization || !Array.isArray(v.initialization.blockers) || !v.links) return 'Invalid setup snapshot'
  if (!v.credentials.every(c => (text(c.id) && knownProvider(c.provider)) || (text(c.provider) && ['configured', 'missing', 'unavailable'].includes(c.status)))) return 'Invalid setup snapshot'
  if (!v.adapters.every(a => (text(a.id) && knownProvider(a.provider)) || (text(a.provider) && Array.isArray(a.models) && Array.isArray(a.slots) && Array.isArray(a.endpoints)))) return 'Invalid setup snapshot'
  if (!v.references.every(validReference)) return 'Invalid setup snapshot'
  if (!v.operations.every(validOperation)) return 'Invalid setup snapshot'
  if (!validSettings(v.settings)) return 'Invalid setup snapshot'
  return ''
}

/** A later snapshot may never move a revision backwards; the old page treated that as stale. */
export function snapshotStale(previous: SetupSnapshot | null, next: SetupSnapshot): boolean {
  if (!previous || previous.instanceId !== next.instanceId) return false
  if (next.credentialRevision < previous.credentialRevision || next.settings.revision < previous.settings.revision) return true
  return next.operations.some(o => {
    const old = previous.operations.find(p => p.operationId === o.operationId)
    return !!old && o.revision < old.revision
  })
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) if (!deepEqual(left[key], right[key])) return false
  return true
}

export function settingsChanged(base: ManagedSettings | null, draft: ManagedSettings | null): boolean {
  if (!base || !draft) return false
  return !deepEqual(base, draft)
}

/**
 * A settings draft may only be saved while every referenced credential still resolves to a
 * configured key; the server rejects the same condition, this keeps the button honest.
 */
export function bindingsValid(settings: ManagedSettings | null, credentials: readonly SetupCredential[]): boolean {
  if (!settings?.providers) return true
  return Object.values(settings.providers).every(p => {
    if (!p || !p.credentialRef) return true
    return credentials.some(c => c.id === p.credentialRef && c.status === 'configured')
  })
}

/** Reviewed catalog choice for a model, carrying the current credential when the provider matches. */
export function providerChoice(draft: ProviderSelection, adapter: SetupAdapter | undefined, model: string): ProviderSelection | null {
  const choice = adapter?.choices?.find(c => c.configuration.model === model)
  if (!choice) return null
  return { ...structuredClone(choice.configuration), credentialRef: draft.provider === choice.configuration.provider ? draft.credentialRef : '' }
}

export const operationKey = (operation: { operationId: string; revision: number }): string => operation.operationId + '/' + operation.revision

export interface ReferenceFile {
  readonly name: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * PCM16 mono WAV from decoded channel data, byte-identical in layout to `media/wav.ts::pcm16Wav` and
 * to the retired in-page encoder: channels are averaged, samples are clamped, negatives scale by 32768.
 */
export function encodeChannelsToPcm16Wav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const length = channels[0]?.length ?? 0
  const bytes = 44 + length * 2
  const buffer = new ArrayBuffer(bytes), v = new DataView(buffer)
  const put = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) v.setUint8(offset + i, value.charCodeAt(i)) }
  put(0, 'RIFF'); v.setUint32(4, bytes - 8, true); put(8, 'WAVE'); put(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); put(36, 'data'); v.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    let sample = 0
    for (const channel of channels) sample += channel[i] / channels.length
    sample = Math.max(-1, Math.min(1, sample))
    v.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  return new Uint8Array(buffer)
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(binary)
}

/**
 * Offline decoding only: no microphone, no AudioContext output and no network. The original file is
 * never modified; only the converted mono 24 kHz WAV leaves this function.
 */
export async function encodeSetupReference(file: ReferenceFile): Promise<{ filename: string; audioBase64: string }> {
  if (!file || !file.size || file.size > MAX_REFERENCE_BYTES || !/\.(wav|mp3|m4a)$/i.test(file.name))
    throw Error('请选择不超过 20 MiB 的 WAV、MP3 或 M4A 文件。')
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext
    ?? (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext
  if (!Offline) throw Error('此浏览器不支持本地音频处理，请换用支持的浏览器。')
  let decoded: AudioBuffer
  try {
    decoded = await new Offline(1, 1, REFERENCE_SAMPLE_RATE).decodeAudioData(await file.arrayBuffer())
  } catch {
    throw Error('无法解码这份音频，请换用 WAV、MP3 或 M4A 文件。')
  }
  if (decoded.duration < MIN_REFERENCE_MS / 1000 || decoded.duration > MAX_REFERENCE_MS / 1000) throw Error('参考音频须为 10 秒至 5 分钟。')
  const length = decoded.length
  if (44 + length * 2 > MAX_REFERENCE_BYTES) throw Error('转换后的音频超过 20 MiB，请缩短后再上传。')
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index))
  return {
    filename: file.name.replace(/\.(wav|mp3|m4a)$/i, '.wav'),
    audioBase64: toBase64(encodeChannelsToPcm16Wav(channels, decoded.sampleRate)),
  }
}

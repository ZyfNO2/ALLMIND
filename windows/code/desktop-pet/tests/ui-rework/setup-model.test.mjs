/**
 * LUI-01: the setup semantics ported out of the retired console view.
 *
 * These cases are plain Node tests: `components/setup/model.ts` has no React, DOM or network
 * dependency on purpose, so the rules that used to live inside `self-setup-view.mjs` can be asserted
 * directly. The audio encoder is cross-checked against the production `inspectPcmWav` so "24 kHz mono
 * PCM16 WAV" is verified by the same parser the server uses, not by a copy of the same assumption.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectPcmWav } from '../../dist/media/wav.js'
import {
  MAX_REFERENCE_BYTES, PROVIDERS, SAFE_ERRORS, UNCONFIRMED_OUTCOME, VOICE_MODELS, bindingsValid, deepEqual,
  encodeChannelsToPcm16Wav, encodeSetupReference, money, operationKey, safeLink, settingsChanged, snapshotProblem,
  snapshotStale, validOperation, validReference,
} from '../../management/character-ui/src/components/setup/model.ts'

const reference = (over = {}) => ({ id: 'a'.repeat(32), format: 'wav', bytes: 480_000, sha256: 'b'.repeat(64), durationMs: 10_000, createdAt: '2026-10-08T00:00:00.000Z', ...over })
const operation = (over = {}) => ({
  operationId: 'op-1', revision: 1, phase: 'prepared', referenceId: 'a'.repeat(32), label: '自己的声音',
  targetModel: 'MiniMax/speech-2.8-turbo', credentialRef: 'dashscope-0123456789ab', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  configRevision: 0, voiceId: 'Voice1', text: '你好。', cloneUpperBoundMicros: 200, activationUpperBoundMicros: 9_900_200,
  createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', errorCode: null, demoAvailable: false,
  activationAvailable: false, ...over,
})
const selection = (over = {}) => ({
  adapterId: 'strict-deepseek', protocol: 'openai-compatible', provider: 'deepseek', model: 'deepseek-v4-pro',
  endpoint: 'https://api.deepseek.com/chat/completions', credentialRef: 'deepseek-0123456789ab', inputTokenLimit: 32768,
  outputTokenLimit: 393216, reservationMicros: 11_000_000, inputMicrosPerToken: 9, outputMicrosPerToken: 27, ...over,
})
const settings = () => ({ providers: { dialogue: selection() }, context: { maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, summaryMinMessages: 12, summaryMaxMessages: 24, timeoutMs: 300_000 } })
const snapshot = (over = {}) => ({
  apiVersion: 1, instanceId: 'instance-1', mode: 'first-run', credentialRevision: 0, credentials: [], adapters: [], settings: { revision: 0, effectiveRevision: 0, savedAt: null, pending: false, applyOn: 'restart', effective: settings(), saved: settings(), history: [] },
  references: [], operations: [], budget: { mode: 'unlimited', limitMicros: null, currency: 'CNY' },
  initialization: { completed: false, blockers: ['请保存所需Key'] },
  links: { dashscopeConsole: 'https://bailian.console.aliyun.com/', dashscopeKeys: 'https://bailian.console.aliyun.com/?tab=model#/api-key', voiceClone: 'https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api', voicePricing: 'https://help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api', deepseekKeys: 'https://platform.deepseek.com/api_keys', harness: 'https://github.com/deepseek-ai/deepseek-harness', codex: 'https://openai.com/codex/for-work/' },
  ...over,
})

test('LUI-01 snapshot guard accepts the real shape and refuses a partially-true payload', () => {
  assert.equal(snapshotProblem(snapshot()), '')
  assert.equal(snapshotProblem(snapshot({ apiVersion: 2 })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ instanceId: '' })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ mode: 'trial' })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ links: undefined })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ initialization: { completed: false } })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ references: [reference({ durationMs: 9_999 })] })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ references: [reference()] })), '')
  assert.equal(snapshotProblem(snapshot({ operations: [operation({ phase: 'charged' })] })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ operations: [operation({ targetModel: 'MiniMax/unknown' })] })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ operations: [operation({ cloneUpperBoundMicros: -1 })] })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ operations: [operation()] })), '')
  assert.equal(snapshotProblem(snapshot({ settings: { ...snapshot().settings, applyOn: 'immediate' } })), 'Invalid setup snapshot')
  assert.equal(snapshotProblem(snapshot({ credentials: [{ id: 'deepseek-x', provider: 'deepseek' }] })), '')
})

test('LUI-01 a snapshot may not move a revision backwards, and a new instance is a reset rather than stale', () => {
  const base = snapshot({ credentialRevision: 2, settings: { ...snapshot().settings, revision: 3 }, operations: [operation({ revision: 2 })] })
  assert.equal(snapshotStale(base, base), false)
  assert.equal(snapshotStale(base, snapshot({ credentialRevision: 3, settings: { ...snapshot().settings, revision: 3 }, operations: [operation({ revision: 2 })] })), false)
  assert.equal(snapshotStale(base, snapshot({ credentialRevision: 1, settings: { ...snapshot().settings, revision: 3 }, operations: [operation({ revision: 2 })] })), true)
  assert.equal(snapshotStale(base, snapshot({ credentialRevision: 2, settings: { ...snapshot().settings, revision: 2 }, operations: [operation({ revision: 2 })] })), true)
  assert.equal(snapshotStale(base, snapshot({ credentialRevision: 2, settings: { ...snapshot().settings, revision: 3 }, operations: [operation({ revision: 1 })] })), true)
  assert.equal(snapshotStale(base, snapshot({ instanceId: 'instance-2' })), false)
  assert.equal(snapshotStale(null, base), false)
})

test('LUI-01 reference and operation boundaries match the server store', () => {
  assert.equal(validReference(reference({ durationMs: 9_999 })), false)
  assert.equal(validReference(reference({ durationMs: 10_000 })), true)
  assert.equal(validReference(reference({ durationMs: 300_000 })), true)
  assert.equal(validReference(reference({ durationMs: 300_001 })), false)
  assert.equal(validReference(reference({ bytes: MAX_REFERENCE_BYTES })), true)
  assert.equal(validReference(reference({ bytes: MAX_REFERENCE_BYTES + 1 })), false)
  assert.equal(validReference(reference({ format: 'flac' })), false)
  assert.equal(validReference(reference({ sha256: '' })), false)
  for (const model of VOICE_MODELS) assert.equal(validOperation(operation({ targetModel: model.value })), true)
  assert.equal(validOperation(operation({ retryAvailable: true, phase: 'failed', errorCode: 'provider_not_enabled' })), true)
  assert.equal(validOperation({ ...operation(), revision: -1 }), false)
})

test('LUI-01 only an https link becomes an anchor, and the error map keeps the old wording', () => {
  assert.deepEqual(safeLink('百炼控制台', 'https://bailian.console.aliyun.com/'), { label: '百炼控制台', href: 'https://bailian.console.aliyun.com/' })
  assert.deepEqual(safeLink('百炼控制台', 'javascript:alert(1)'), { label: '百炼控制台', href: null })
  assert.deepEqual(safeLink('百炼控制台', 'http://bailian.console.aliyun.com/'), { label: '百炼控制台', href: null })
  assert.deepEqual(safeLink('百炼控制台', undefined), { label: '百炼控制台', href: null })
  assert.equal(SAFE_ERRORS.transport_unknown, '云端结果待核实，请刷新；不会自动重复收费。')
  assert.match(UNCONFIRMED_OUTCOME, /不会自动重复收费/)
  assert.deepEqual(PROVIDERS.map(p => p.value), ['deepseek', 'dashscope', 'gemini'])
})

test('LUI-01 the settings draft only counts as dirty when it really changed, and a stale credential blocks the save', () => {
  const draft = settings()
  assert.equal(settingsChanged(draft, structuredClone(draft)), false)
  const edited = structuredClone(draft)
  edited.providers.dialogue.model = 'deepseek-chat'
  assert.equal(settingsChanged(draft, edited), true)
  assert.equal(settingsChanged(null, edited), false)
  assert.equal(bindingsValid(draft, [{ id: 'deepseek-0123456789ab', status: 'configured' }]), true)
  assert.equal(bindingsValid(draft, [{ id: 'deepseek-0123456789ab', status: 'missing' }]), false)
  assert.equal(bindingsValid(draft, []), false)
  assert.equal(bindingsValid(settings().providers.dialogue.auth === 'none' ? settings() : settings(), []), false)
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), false)
  assert.equal(operationKey({ operationId: 'op-1', revision: 4 }), 'op-1/4')
})

test('LUI-01 the local WAV conversion is 24 kHz mono PCM16 accepted by the production parser', () => {
  const channels = [new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2])]
  const wav = encodeChannelsToPcm16Wav(channels, 24_000)
  const parsed = inspectPcmWav(wav)
  assert.equal(parsed.sampleRate, 24_000)
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.bits, 16)
  assert.equal(wav.length, 44 + channels[0].length * 2)
  const view = new DataView(wav.buffer)
  assert.equal(view.getInt16(44 + 0 * 2, true), 0)
  assert.equal(view.getInt16(44 + 1 * 2, true), Math.round(0.5 * 32767))
  assert.equal(view.getInt16(44 + 2 * 2, true), Math.round(-0.5 * 32768))
  // Out-of-range samples are clamped, exactly like the old in-page encoder and media/wav.ts.
  assert.equal(view.getInt16(44 + 3 * 2, true), 32767)
  assert.equal(view.getInt16(44 + 4 * 2, true), -32768)
  assert.equal(view.getInt16(44 + 5 * 2, true), 32767)
  assert.equal(view.getInt16(44 + 6 * 2, true), -32768)
  const stereo = encodeChannelsToPcm16Wav([new Float32Array([1, 0]), new Float32Array([0, 1])], 24_000)
  assert.equal(inspectPcmWav(stereo).channels, 1)
  assert.equal(new DataView(stereo.buffer).getInt16(44, true), Math.round(0.5 * 32767))
})

test('LUI-01 encodeSetupReference rejects bad files locally and never needs the network', async () => {
  const saved = { OfflineAudioContext: globalThis.OfflineAudioContext }
  const decode = async () => { throw Error('decode must not run for a rejected file') }
  globalThis.OfflineAudioContext = class { decodeAudioData = decode }
  try {
    await assert.rejects(encodeSetupReference({ name: 'a.flac', size: 10, arrayBuffer: async () => new ArrayBuffer(10) }), /不超过 20 MiB 的 WAV、MP3 或 M4A/)
    await assert.rejects(encodeSetupReference({ name: 'a.wav', size: MAX_REFERENCE_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(10) }), /不超过 20 MiB 的 WAV、MP3 或 M4A/)
    await assert.rejects(encodeSetupReference({ name: 'a.wav', size: 0, arrayBuffer: async () => new ArrayBuffer(0) }), /不超过 20 MiB 的 WAV、MP3 或 M4A/)
    await assert.rejects(encodeSetupReference({ name: 'a.wav', size: 10, arrayBuffer: async () => { throw Error('unreadable') } }), /无法解码这份音频/)
    globalThis.OfflineAudioContext = undefined
    await assert.rejects(encodeSetupReference({ name: 'a.wav', size: 10, arrayBuffer: async () => new ArrayBuffer(10) }), /此浏览器不支持本地音频处理/)
  } finally {
    globalThis.OfflineAudioContext = saved.OfflineAudioContext
  }
})

test('LUI-01 a decoded reference outside 10s..5min is refused before any upload', async () => {
  const saved = globalThis.OfflineAudioContext
  const buffer = (duration) => ({ duration, length: Math.round(duration * 24_000), sampleRate: 24_000, numberOfChannels: 1, getChannelData: () => new Float32Array(Math.round(duration * 24_000)) })
  globalThis.OfflineAudioContext = class { constructor() {} decodeAudioData = async () => buffer(9.5) }
  try {
    await assert.rejects(encodeSetupReference({ name: 'short.wav', size: 100, arrayBuffer: async () => new ArrayBuffer(100) }), /10 秒至 5 分钟/)
    globalThis.OfflineAudioContext = class { constructor() {} decodeAudioData = async () => buffer(300.5) }
    await assert.rejects(encodeSetupReference({ name: 'long.wav', size: 100, arrayBuffer: async () => new ArrayBuffer(100) }), /10 秒至 5 分钟/)
    globalThis.OfflineAudioContext = class { constructor() {} decodeAudioData = async () => buffer(10) }
    const result = await encodeSetupReference({ name: 'good.mp3', size: 100, arrayBuffer: async () => new ArrayBuffer(100) })
    assert.equal(result.filename, 'good.wav')
    const bytes = Buffer.from(result.audioBase64, 'base64')
    assert.equal(inspectPcmWav(bytes).durationMs, 10_000)
    assert.match(result.audioBase64, /^[A-Za-z0-9+/]+={0,2}$/)
  } finally {
    globalThis.OfflineAudioContext = saved
  }
})

test('LUI-01 money is rendered in yuan from micros', () => {
  assert.equal(money(9_900_000), '9.9 元')
  assert.equal(money(0), '0 元')
  assert.equal(money(200), '0.0002 元')
})

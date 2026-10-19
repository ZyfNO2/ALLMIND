/**
 * CUX-06: dialogue 模型最小表单的投影与草稿构造。
 *
 * 被测对象是生产模块 `management/character-ui/src/components/character/model-form.ts`，不复制逻辑。
 * 这里只证明**投影与隐藏字段映射**：显示五项、继承隐藏字段、连接变更清理、预算缺失阻止保存。
 * 真实的 validateManagedSettings/ProviderSourceStore 校验在 `cux-06-model-form.browser.test.mjs`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'aika-cux06-model-'))
const bundle = join(dir, 'model-form.mjs')
buildSync({ entryPoints: ['management/character-ui/src/components/character/model-form.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm' })
const { projectModelForm, buildModelDraft, connectionChanged, sameConnection, CUSTOM_PROVIDER, OPEN_ADAPTER, BUDGET_KEYS } = await import(pathToFileURL(bundle).href)
test.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'aika-cux06-model-'))); rmSync(dir, { recursive: true, force: true }) })

/** 一个已审核的 DeepSeek own 基线：含 tariff 与 protocol。 */
const DEEPSEEK_SELECTION = {
  adapterId: 'deepseek-dialogue', provider: 'deepseek', protocol: 'openai-compatible',
  endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', credentialRef: 'cred-ds',
  inputTokenLimit: 32768, outputTokenLimit: 393216, reservationMicros: 3_211_264,
  inputMicrosPerToken: 2, outputMicrosPerToken: 8, thinking: 'high',
}
const ownView = (over = {}) => ({
  apiVersion: 1,
  configuration: {
    schemaVersion: 2, characterId: 'role-b', revision: 3, savedRevision: 3, effectiveRevision: 2, applyOn: 'restart',
    identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: '' },
    bindings: {
      dialogue: { mode: 'own', sourceInstanceId: 'source.ds', modelProfileId: 'profile.ds', credentialRef: 'cred-ds', parameters: {} },
      asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' },
    },
  },
  selections: { dialogue: { ...DEEPSEEK_SELECTION }, tts: {}, asr: {} },
  readErrors: {}, effective: null, ...over,
})
const inheritView = (over = {}) => ({
  apiVersion: 1,
  configuration: {
    schemaVersion: 2, characterId: 'role-b', revision: 3, savedRevision: 3, effectiveRevision: 3, applyOn: 'restart',
    identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: '' },
    bindings: { dialogue: { mode: 'inherit-default' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } },
  },
  selections: { dialogue: { ...DEEPSEEK_SELECTION }, tts: {}, asr: {} },
  readErrors: {}, effective: null, ...over,
})
const ADAPTERS = [
  { id: 'deepseek-dialogue', label: 'DeepSeek', slots: ['dialogue'], provider: 'deepseek', status: 'available' },
  { id: OPEN_ADAPTER, label: '自定义文本（OpenAI 兼容）', slots: ['dialogue', 'memory_turn', 'summary', 'admission'], provider: 'dashscope', open: true, status: 'available' },
]
const CREDENTIALS = [
  { id: 'cred-ds', label: 'DeepSeek凭据', provider: 'deepseek', status: 'configured' },
  { id: 'cred-ofm', label: 'ofm 凭据', provider: 'ofm', status: 'configured' },
  { id: 'cred-dash', label: 'DashScope 凭据', provider: 'dashscope', status: 'configured' },
]

// ---------------------------------------------------------------- 初始读取

test('CUX-06 projection reads saved binding and selections, never falling back to a default DeepSeek', () => {
  const form = projectModelForm(ownView(), CREDENTIALS)
  assert.equal(form.mode, 'own')
  assert.equal(form.endpoint, 'https://api.deepseek.com/chat/completions')
  assert.equal(form.model, 'deepseek-flash')
  assert.equal(form.credentialRef, 'cred-ds')
  assert.equal(form.key, '', 'the plaintext key is never prefilled')
  assert.equal(form.baseline.adapterId, 'deepseek-dialogue', 'the reviewed adapter is kept in the hidden baseline')
  assert.equal(form.baseline.thinking, 'high', 'supported hidden parameters survive projection')
  // 读失败的槽位：不填任何默认来源。
  const broken = projectModelForm(ownView({ selections: { ...ownView().selections, dialogue: null }, readErrors: { dialogue: '已保存的来源或模型配置无法解析，请重新选择此角色的来源。' } }), CREDENTIALS)
  assert.equal(broken.endpoint, '', 'a failed slot must not be filled with a default endpoint')
  assert.equal(broken.model, '')
  assert.match(broken.readError, /无法解析/)
})

test('CUX-06 projection surfaces a saved reference that is not in the configured list', () => {
  const form = projectModelForm(ownView({ configuration: { ...ownView().configuration, bindings: { ...ownView().configuration.bindings, dialogue: { mode: 'own', sourceInstanceId: 's', modelProfileId: 'p', credentialRef: 'cred-role-only' } } } }), CREDENTIALS)
  assert.equal(form.credentialRef, 'cred-role-only')
  assert.equal(form.credentials.some(item => item.id === 'cred-role-only'), true, 'the role\'s own saved reference must be selectable, not dropped')
})

// ---------------------------------------------------------------- 继承：不改 mode

test('CUX-06 an untouched inherit-default save is a no-op and never becomes own', () => {
  const form = projectModelForm(inheritView(), CREDENTIALS)
  assert.equal(form.mode, 'inherit-default')
  const plan = buildModelDraft(form, { adapters: ADAPTERS }, { touched: false })
  assert.equal(plan.blocked, '')
  assert.equal(plan.draft.mode, 'inherit-default', 'opening or discovering must not change the mode')
  assert.deepEqual(plan.draft.selection, {}, 'a no-op save sends no selection')
  assert.equal(plan.becomesOwn, false)
})

test('CUX-06 editing a visible field in inherit-default turns the save into own with an explicit note', () => {
  const form = { ...projectModelForm(inheritView(), CREDENTIALS), model: 'custom-model', key: 'sk-anonymous-cux06' }
  const plan = buildModelDraft(form, { adapters: ADAPTERS }, { touched: true })
  assert.equal(plan.blocked, '')
  assert.equal(plan.draft.mode, 'own', 'a real edit must become an own binding')
  assert.match(plan.notes.join(' '), /保存为此角色配置/)
})

// ---------------------------------------------------------------- 隐藏字段继承

test('CUX-06 an unedited own binding keeps the reviewed adapter, protocol, tariff and parameters', () => {
  const form = { ...projectModelForm(ownView(), CREDENTIALS), model: 'deepseek-flash-v2' }
  const plan = buildModelDraft(form, { adapters: ADAPTERS }, { touched: true })
  assert.equal(plan.blocked, '')
  const selection = plan.draft.selection
  assert.equal(selection.adapterId, 'deepseek-dialogue', 'an unedited endpoint must keep the reviewed adapter')
  assert.equal(selection.provider, 'deepseek')
  assert.equal(selection.protocol, 'openai-compatible')
  assert.equal(selection.credentialRef, 'cred-ds')
  assert.equal(selection.thinking, 'high', 'a supported hidden parameter must survive')
  for (const key of BUDGET_KEYS) assert.equal(selection[key], DEEPSEEK_SELECTION[key], `${key} must be carried over unchanged`)
})

test('CUX-06 changing the endpoint cleans stale connection fields and does not reuse the old credential', () => {
  const form = { ...projectModelForm(ownView(), CREDENTIALS), endpoint: 'http://127.0.0.1:18899/v1/chat/completions', model: 'ofm-model', key: 'sk-anonymous-cux06-ofm' }
  assert.equal(connectionChanged(form), true)
  const plan = buildModelDraft(form, { adapters: ADAPTERS }, { touched: true })
  assert.equal(plan.blocked, '')
  const selection = plan.draft.selection
  assert.equal(selection.provider, CUSTOM_PROVIDER, 'a custom connection uses the generic local provider id, not a guessed vendor')
  assert.equal(selection.adapterId, OPEN_ADAPTER)
  assert.equal(selection.protocol, 'openai-compatible')
  assert.equal(selection.modelsEndpoint, undefined, 'the old models endpoint must not be carried to a new target')
  assert.equal(selection.thinking, undefined, 'connection-specific parameters must be dropped')
  // 旧引用不得自动发送到新地址。
  assert.notEqual(selection.credentialRef, 'cred-ds')
  // 但预算上界保留（SPEC：同连接原值保留；这里是「沿用本机调用限制」的起点）。
  for (const key of BUDGET_KEYS) assert.equal(selection[key], DEEPSEEK_SELECTION[key], `${key} must still be present`)
  assert.match(plan.notes.join(' '), /本机分组标识/, 'the note must not claim the id is a real vendor')
})

test('CUX-06 explicitly reusing a credential adopts its registered provider and never infers from the label', () => {
  const form = { ...projectModelForm(ownView(), CREDENTIALS), endpoint: 'http://127.0.0.1:18899/v1/chat/completions', model: 'm', useExisting: true, credentialRef: 'cred-ofm' }
  const plan = buildModelDraft(form, { adapters: ADAPTERS }, { touched: true })
  assert.equal(plan.blocked, '')
  assert.equal(plan.draft.selection.provider, 'ofm', 'the registered provider of the chosen credential wins')
  assert.equal(plan.draft.selection.credentialRef, 'cred-ofm')
  // 显示名称里的 "ofm" 不被当作依据：换一个 label 也得到同样的 provider。
  const relabeled = { ...form, credentials: [{ id: 'cred-ofm', label: '完全不同的显示名', provider: 'ofm' }] }
  assert.equal(buildModelDraft(relabeled, { adapters: ADAPTERS }, { touched: true }).draft.selection.provider, 'ofm')
})

// ---------------------------------------------------------------- 免 Key / 预算

test('CUX-06 no-key requires an explicit opt-in; an empty key alone is not免 Key', () => {
  const emptyKey = { ...projectModelForm(inheritView(), CREDENTIALS), endpoint: 'http://127.0.0.1:8080/v1/chat/completions', model: 'm', key: '', noKey: false }
  const blocked = buildModelDraft(emptyKey, { adapters: ADAPTERS }, { touched: true })
  assert.match(blocked.blocked, /API Key|已有凭据/, 'an empty key must not silently become免 Key')
  assert.equal(blocked.draft.mode, 'own')

  const noKey = { ...emptyKey, noKey: true }
  const plan = buildModelDraft(noKey, { adapters: ADAPTERS }, { touched: true })
  assert.equal(plan.blocked, '')
  assert.equal(plan.draft.selection.auth, 'none')
  assert.equal(plan.draft.selection.credentialRef, '')
})

test('CUX-06 a missing local budget baseline blocks the save instead of inventing numbers', () => {
  const bare = {
    apiVersion: 1,
    configuration: {
      schemaVersion: 2, characterId: 'role-b', revision: 1, savedRevision: 1, effectiveRevision: 1, applyOn: 'restart',
      identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: '' },
      bindings: { dialogue: { mode: 'own', sourceInstanceId: 's', modelProfileId: 'p', credentialRef: 'cred-ofm' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } },
    },
    // 服务端只解析出 endpoint/model，没有任何调用上界。
    selections: { dialogue: { adapterId: OPEN_ADAPTER, provider: 'ofm', protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:18899/v1/chat/completions', model: 'm', credentialRef: 'cred-ofm' } },
    readErrors: {}, effective: null,
  }
  const form = projectModelForm(bare, CREDENTIALS)
  const plan = buildModelDraft(form, { adapters: ADAPTERS }, { touched: true })
  assert.match(plan.blocked, /缺少本机调用策略/, 'a missing budget baseline must block, not be filled with arbitrary numbers')
  for (const key of BUDGET_KEYS) assert.match(plan.blocked, new RegExp(key))
  assert.deepEqual(plan.draft.selection, {}, 'a blocked save must not carry a half-built selection')
})

test('CUX-06 a credential confirmed on the NEW endpoint is kept, so a saved key is not re-requested', () => {
  // 回归：换地址 + 刚在新地址上保存了新 Key（credentialConfirmedForEndpoint=true）。
  // 这时引用必须被沿用，否则保存按钮会继续显示「请填写新的 API Key」，把一次成功说成未完成。
  const base = projectModelForm(ownView(), CREDENTIALS)
  const form = { ...base, endpoint: 'http://127.0.0.1:18899/v1/chat/completions', model: 'ofm-model', credentialRef: 'cred-ofm' }
  assert.equal(connectionChanged(form), true, '这确实是换了连接')
  const plan = buildModelDraft(form, { adapters: ADAPTERS, credentialConfirmedForEndpoint: true }, { touched: true })
  assert.equal(plan.blocked, '', `已在新地址确认过的引用不得被要求重填：${plan.blocked}`)
  assert.equal(plan.draft.selection.credentialRef, 'cred-ofm', '确认过的引用必须保留')
  // 反向：**没有**确认过时仍然必须拦住（不能把旧凭据静默发到新地址）。
  const unconfirmed = buildModelDraft(form, { adapters: ADAPTERS, credentialConfirmedForEndpoint: false }, { touched: true })
  assert.match(unconfirmed.blocked, /API Key|已有凭据/, '未确认的旧引用必须要求重新填写或显式复用')
})

test('CUX-06 the DeepSeek → ofm scenario can inherit the existing legal policy and pass through', () => {
  // 正常场景：从已审核的 DeepSeek 换成自定义 ofm 连接，预算沿用本机已有上界 → 不阻止。
  const form = { ...projectModelForm(ownView(), CREDENTIALS), endpoint: 'http://127.0.0.1:18899/v1/chat/completions', model: 'ofm-model', key: 'sk-anonymous-cux06-inherit' }
  const plan = buildModelDraft(form, { adapters: ADAPTERS }, { touched: true })
  assert.equal(plan.blocked, '', 'the normal DeepSeek → ofm path must not be blocked')
  for (const key of BUDGET_KEYS) assert.equal(typeof plan.draft.selection[key], 'number', `${key} must be inherited as a number`)
})

test('CUX-06 an invalid provider id is refused rather than silently sent', () => {
  const view = ownView({ selections: { ...ownView().selections, dialogue: { ...DEEPSEEK_SELECTION, provider: 'Not A Provider!' } } })
  const form = projectModelForm(view, CREDENTIALS)
  const plan = buildModelDraft({ ...form, model: 'm' }, { adapters: ADAPTERS }, { touched: true })
  assert.match(plan.blocked, /供应商标识无效/)
})

// ---------------------------------------------------------------- 连接比较

test('CUX-06 sameConnection ignores query, hash and trailing slash', () => {
  assert.equal(sameConnection('https://a.example/v1/chat/completions', 'https://a.example/v1/chat/completions'), true)
  assert.equal(sameConnection('https://a.example/v1/chat/completions/', 'https://a.example/v1/chat/completions'), true)
  assert.equal(sameConnection('https://a.example/v1/chat/completions?x=1', 'https://a.example/v1/chat/completions'), true)
  assert.equal(sameConnection('https://a.example/v1', 'https://b.example/v1'), false)
  assert.equal(sameConnection('https://a.example/v1', 'http://a.example/v1'), false)
  assert.equal(sameConnection('', 'https://a.example/v1'), false)
})

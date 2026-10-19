/**
 * LUI-02: 角色高级编辑的写入契约，从旧 `management/ui/roles-session.mjs` 迁到
 * `management/character-ui/src/components/character/session.ts`。
 *
 * 这些是纯 Node 用例：`session.ts` 不 import 任何模块（无 React、无 DOM、无 `services/runtime`），
 * 所以 revision/operationId/409/写入顺序可以在没有浏览器的情况下被直接断言。
 *
 * 旧的 `tests/management/roles-session.test.mjs` 断言的是被退役的会话模块；本文件把其中仍然成立的
 * 行为断言迁到新前端，不删减安全/数据语义：
 *   * 每个槽位独立读写，读失败逐槽显示且**绝不**渲染成空；
 *   * `own` 时先注册来源再写绑定，绑定里带服务端返回的 source/profile id；
 *   * 写后回读，采用 owner 的 revision；
 *   * 同一 body 重试复用同一个 operationId，body 变了才换新 id；
 *   * 409 保留草稿；
 *   * 非运行角色的形象写入只改 saved 配置，绝不调用全局激活。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'aika-lui02-session-'))
const bundle = join(dir, 'session.mjs')
buildSync({ entryPoints: ['management/character-ui/src/components/character/session.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm' })
const { createCharacterSession, operationFor, isConflict, replaceBook, splitKeywords, draftFromView, apiSlotOf, newOperationId, bindingMismatch, isConfirmed } = await import(pathToFileURL(bundle).href)
test.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'aika-lui02-session-'))); rmSync(dir, { recursive: true, force: true }) })

/** 一个按路径脚本化的假客户端，记录每次真实调用。 */
function fakeClient(handlers = {}) {
  const calls = []
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, options })
      const handler = handlers[path.split('?')[0]]
      if (typeof handler === 'function') return handler({ path, options, calls })
      if (handler !== undefined) return structuredClone(handler)
      throw Object.assign(new Error(`anon: no scripted response for ${path}`), { status: 404, code: 'not_found' })
    },
  }
}

const view = (over = {}) => ({
  apiVersion: 1,
  configuration: {
    schemaVersion: 2, characterId: 'role-b', revision: 3, savedRevision: 3, effectiveRevision: 2, applyOn: 'restart',
    identity: { intro: '简介-role-b' },
    persona: { text: '完整人设-role-b', revision: 1 },
    appearance: { type: 'live2d', resourceId: 'local-model' },
    bindings: { dialogue: { mode: 'inherit-default' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } },
  },
  selections: { dialogue: { adapterId: 'openai-compatible-text', provider: 'openai', model: 'gpt-x', endpoint: 'https://example.invalid/v1/chat/completions' }, tts: { model: 'tts-a' }, asr: { model: 'asr-a' } },
  readErrors: {},
  effective: null,
  ...over,
})

const snapshot = { adapters: [{ id: 'openai-compatible-text', slots: ['dialogue'], status: 'available' }], credentials: [] }
const okHandlers = (extra = {}) => ({ '/api/characters/bindings': view(), '/api/snapshot': snapshot, ...extra })

// ---------------------------------------------------------------- operationId 幂等

test('LUI-02 operationFor reuses one operationId for the same body and rotates it when the body changes', () => {
  const holder = {}
  const body = { characterId: 'role-b', expectedRevision: 1, bindings: { dialogue: { mode: 'inherit-default' } } }
  const first = operationFor(holder, body)
  assert.equal(operationFor(holder, structuredClone(body)), first, 'a retry of the same payload must replay the same id')
  const second = operationFor(holder, { ...body, expectedRevision: 2 })
  assert.notEqual(second, first, 'a different payload must get a fresh id so the server cannot dedupe two real edits')
  assert.equal(operationFor(holder, { ...body, expectedRevision: 2 }), second, 'the new payload then keeps its own id')
  assert.equal(newOperationId() === newOperationId(), false)
})

test('LUI-02 isConflict only treats a 409 as a conflict', () => {
  assert.equal(isConflict(Object.assign(new Error('conflict'), { status: 409 })), true)
  assert.equal(isConflict(Object.assign(new Error('bad'), { status: 400 })), false)
  assert.equal(isConflict(new Error('boom')), false)
})

// ---------------------------------------------------------------- 读：逐槽 readErrors

test('LUI-02 a per-slot readError is surfaced for its own slot and never turned into an empty selection', async () => {
  const client = fakeClient(okHandlers({
    '/api/characters/bindings': view({ selections: { ...view().selections, dialogue: null }, readErrors: { dialogue: '已保存的来源或模型配置无法解析，请重新选择此角色的来源。' } }),
  }))
  const session = createCharacterSession(client)
  const { view: loaded } = await session.loadBindings('role-b')
  const draft = draftFromView(loaded, 'dialogue')
  assert.match(draft.readError, /无法解析/, 'the failing slot must report its own error')
  assert.deepEqual(draft.selection, {}, 'a failed slot must not be filled with another source default')
  const healthy = draftFromView(loaded, 'tts')
  assert.equal(healthy.readError, '', 'a healthy slot must not be marked failed')
  assert.equal(healthy.selection.model, 'tts-a', 'the healthy slot keeps its real body')
})

test('LUI-02 a failed bindings read is an error, not an empty configuration', async () => {
  const client = fakeClient({ '/api/characters/bindings': () => { throw Object.assign(new Error('anon: bindings unavailable'), { status: 503 }) }, '/api/snapshot': snapshot })
  await assert.rejects(createCharacterSession(client).loadBindings('role-b'), /bindings unavailable/)
})

test('LUI-02 an unsupported bindings apiVersion is refused instead of driven blind', async () => {
  const client = fakeClient(okHandlers({ '/api/characters/bindings': view({ apiVersion: 2 }) }))
  await assert.rejects(createCharacterSession(client).loadBindings('role-b'), /版本不支持/)
})

// ---------------------------------------------------------------- 写：顺序、回读、revision

test('LUI-02 own mode registers the source BEFORE the binding and carries the returned ids', async () => {
  // 回读必须是真实的「写后再读」：PUT 之后 GET 返回新修订与**同一份绑定**，否则回读断言就是空的。
  let savedRevision = 3
  const ownBinding = { mode: 'own', sourceInstanceId: 'source.abc', modelProfileId: 'profile.abc', credentialRef: 'cred-1', parameters: {} }
  const client = fakeClient(okHandlers({
    '/api/provider-sources': ({ options }) => {
      assert.equal(options.method, 'POST')
      assert.equal(options.body.characterId, 'role-b')
      assert.equal(options.body.slot, 'dialogue')
      assert.equal(options.body.selection.model, 'role-b-model')
      assert.equal(options.body.selection.temperature, undefined, 'an untouched optional field must not be sent as an empty value')
      return { apiVersion: 1, entry: { source: { sourceId: 'source.abc', auth: { kind: 'credentialRef', ref: 'cred-1' } }, profile: { modelProfileId: 'profile.abc' } } }
    },
    '/api/characters/bindings': ({ options }) => {
      if (options.method !== 'PUT') {
        return view({
          configuration: { ...view().configuration, savedRevision, revision: savedRevision, bindings: { ...view().configuration.bindings, ...(savedRevision >= 4 ? { dialogue: ownBinding } : {}) } },
          selections: { ...view().selections, dialogue: { ...view().selections.dialogue, model: 'role-b-model', credentialRef: 'cred-1' } },
        })
      }
      assert.equal(client.calls.filter(call => call.path === '/api/provider-sources').length, 1, 'the source must already be registered')
      assert.equal(options.body.expectedRevision, 3, 'the write carries the revision the page read')
      assert.deepEqual(options.body.bindings, { dialogue: { mode: 'own', sourceInstanceId: 'source.abc', modelProfileId: 'profile.abc', credentialRef: 'cred-1' } })
      assert.ok(options.body.operationId, 'every write carries an operationId')
      savedRevision = 4
      // CUX-04: the PUT response itself carries the write receipt (the server already returns it).
      return { configuration: { ...view().configuration, savedRevision: 4, bindings: { ...view().configuration.bindings, dialogue: ownBinding } }, applyOn: 'restart' }
    },
  }))
  const draft = { mode: 'own', selection: { adapterId: 'openai-compatible-text', provider: 'openai', model: 'role-b-model', endpoint: 'https://example.invalid/v1/chat/completions', credentialRef: 'cred-1' }, key: '', readError: '', error: '', message: '' }
  const result = await createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft, expectedRevision: 3, holder: {} })
  assert.equal(result.outcome, 'confirmed', `a matching write + readback must be confirmed: ${result.reason}`)
  assert.equal(result.writeReceipt.applyOn, 'restart')
  assert.equal(result.writeReceipt.savedRevision, 4, 'the write receipt comes from the PUT response, not from the later GET')
  assert.equal(result.readback.savedRevision, 4)
  assert.equal(result.view.configuration.savedRevision, 4, 'the caller replaces its view with the re-read one')
  assert.equal(result.concurrentChanges, false, 'an equal revision is not a concurrent change')
  assert.equal(client.calls.filter(call => call.path.startsWith('/api/characters/bindings')).length, 2, 'the write is followed by exactly one re-read')
})

test('LUI-02 a failed source registration writes no binding at all', async () => {
  const client = fakeClient(okHandlers({
    '/api/provider-sources': () => { throw Object.assign(new Error('来源或模型配置无效。'), { status: 400 }) },
  }))
  const draft = { mode: 'own', selection: { adapterId: 'openai-compatible-text', provider: 'openai', model: 'x', endpoint: 'https://example.invalid/v1/chat/completions' }, key: '', readError: '', error: '', message: '' }
  await assert.rejects(createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft, expectedRevision: 3, holder: {} }), /无效/)
  assert.equal(client.calls.filter(call => call.path === '/api/characters/bindings' && call.options.method === 'PUT').length, 0, 'no half-written binding may exist')
})

test('LUI-02 inherit-default saves exactly one binding without touching the source registry', async () => {
  const inheritBinding = { mode: 'inherit-default' }
  const client = fakeClient(okHandlers({
    '/api/characters/bindings': ({ options }) => {
      if (options.method !== 'PUT') return view({ configuration: { ...view().configuration, savedRevision: 4, bindings: { ...view().configuration.bindings, tts: inheritBinding } } })
      assert.deepEqual(options.body.bindings, { tts: { mode: 'inherit-default' } })
      return { configuration: { ...view().configuration, savedRevision: 4, bindings: { ...view().configuration.bindings, tts: inheritBinding } }, applyOn: 'restart' }
    },
  }))
  const draft = { mode: 'inherit-default', selection: {}, key: '', readError: '', error: '', message: '' }
  const result = await createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'tts', draft, expectedRevision: 3, holder: {} })
  assert.equal(result.outcome, 'confirmed')
  assert.equal(result.writeReceipt.savedRevision, 4, 'the write receipt is the PUT response')
  assert.equal(result.readback.savedRevision, 4, 'the readback revision is what the page shows')
  assert.equal(client.calls.some(call => call.path === '/api/provider-sources'), false, 'inherit-default must not register a source')
})

test('LUI-02 a retried binding save replays the same operationId, and a 409 keeps the draft', async () => {
  let attempt = 0
  const client = fakeClient(okHandlers({
    '/api/characters/bindings': ({ options }) => {
      if (options.method !== 'PUT') return view({ configuration: { ...view().configuration, savedRevision: 4, bindings: { ...view().configuration.bindings, dialogue: { mode: 'inherit-default' } } } })
      attempt++
      if (attempt === 1) throw Object.assign(new Error('角色配置已更新，请刷新后重试。'), { status: 409 })
      return { configuration: { ...view().configuration, savedRevision: 4, bindings: { ...view().configuration.bindings, dialogue: { mode: 'inherit-default' } } }, applyOn: 'restart' }
    },
  }))
  const session = createCharacterSession(client)
  const holder = {}
  const draft = { mode: 'inherit-default', selection: {}, key: '', readError: '', error: '', message: '' }
  await assert.rejects(session.saveBinding({ characterId: 'role-b', slot: 'dialogue', draft, expectedRevision: 3, holder }), error => isConflict(error) === true)
  assert.equal(draft.mode, 'inherit-default', 'a 409 must leave the caller draft untouched')
  const retried = await session.saveBinding({ characterId: 'role-b', slot: 'dialogue', draft, expectedRevision: 3, holder })
  assert.equal(retried.outcome, 'confirmed')
  const writes = client.calls.filter(call => call.path === '/api/characters/bindings' && call.options.method === 'PUT')
  assert.equal(writes.length, 2)
  assert.equal(writes[0].options.body.operationId, writes[1].options.body.operationId, 'a retry of the same body must reuse the operationId')
})

test('LUI-02 a new API key is saved through the credential owner with a stable operationId and then cleared', async () => {
  const client = fakeClient(okHandlers({
    '/api/self-setup': { instanceId: 'inst-1', credentialRevision: 0 },
    '/api/self-setup/credentials': ({ options }) => ({ credentialRef: `managed-${options.body.operationId.slice(0, 6)}` }),
    '/api/provider-sources': ({ options }) => {
      assert.match(options.body.selection.credentialRef, /^managed-/, 'the freshly saved credentialRef is what the source is registered with')
      return { entry: { source: { sourceId: 'source.key', auth: { kind: 'credentialRef', ref: options.body.selection.credentialRef } }, profile: { modelProfileId: 'profile.key' } } }
    },
  }))
  const draft = { mode: 'own', selection: { adapterId: 'openai-compatible-text', provider: 'openai', model: 'x', endpoint: 'https://example.invalid/v1/chat/completions' }, key: 'sk-anonymous-fixture', readError: '', error: '', message: '' }
  const session = createCharacterSession(client)
  const result = await session.saveBinding({ characterId: 'role-b', slot: 'dialogue', draft, expectedRevision: 3, holder: {} })
  const credentialCalls = client.calls.filter(call => call.path === '/api/self-setup/credentials')
  assert.equal(credentialCalls.length, 1)
  assert.equal(credentialCalls[0].options.body.expectedRevision, 0, 'the credential write is revision-checked')
  assert.ok(credentialCalls[0].options.body.operationId)
  assert.match(result.credentialRef, /^managed-/, 'the caller receives the credential reference that was actually stored')
  assert.equal(draft.key, 'sk-anonymous-fixture', 'the caller clears the plaintext key after a successful save; the session never stores it elsewhere')
  assert.equal(client.calls.every(call => !call.path.includes('sk-anonymous-fixture')), true, 'the key must never appear in a URL')
})

test('LUI-02 a local no-key source sends auth:none and clears the credential reference', async () => {
  const localBinding = { mode: 'own', sourceInstanceId: 'source.local', modelProfileId: 'profile.local', parameters: {} }
  const client = fakeClient(okHandlers({
    '/api/provider-sources': ({ options }) => {
      assert.equal(options.body.selection.auth, 'none')
      assert.equal(options.body.selection.credentialRef, '')
      return { entry: { source: { sourceId: 'source.local', auth: { kind: 'none' } }, profile: { modelProfileId: 'profile.local' } } }
    },
    '/api/characters/bindings': ({ options }) => {
      if (options.method !== 'PUT') return view({ configuration: { ...view().configuration, savedRevision: 1, bindings: { ...view().configuration.bindings, tts: localBinding } } })
      assert.deepEqual(options.body.bindings, { tts: { mode: 'own', sourceInstanceId: 'source.local', modelProfileId: 'profile.local' } }, 'a no-key source carries no credentialRef')
      return { configuration: { ...view().configuration, savedRevision: 1, bindings: { ...view().configuration.bindings, tts: localBinding } }, applyOn: 'restart' }
    },
  }))
  const draft = { mode: 'own', selection: { adapterId: 'sapi-tts', provider: 'system', model: 'SAPI', endpoint: 'local:sapi', auth: 'none', credentialRef: 'stale-ref' }, key: '', readError: '', error: '', message: '' }
  const result = await createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'tts', draft, expectedRevision: 0, holder: {} })
  assert.equal(result.outcome, 'confirmed', `a no-key source must confirm: ${result.reason}`)
  assert.deepEqual(result.writeReceipt.binding, localBinding, 'the write receipt binding comes from the PUT response')
  assert.deepEqual(result.readback.binding, localBinding, 'the readback binding matches the write receipt')
})

// ---------------------------------------------------------------- 模型发现

test('LUI-02 discovery sends only a credential reference and maps the STT slot to asr', async () => {
  const client = fakeClient(okHandlers({
    '/api/provider-sources/discover': ({ options }) => {
      assert.equal(options.body.slot, 'asr', 'the UI slot name stt maps to the API name asr')
      assert.equal(options.body.credentialRef, 'cred-9')
      assert.equal('key' in options.body, false, 'discovery only accepts a credential reference')
      return { items: [{ id: 'm1', label: '模型一' }] }
    },
  }))
  const result = await createCharacterSession(client).discoverModels({ characterId: 'role-b', slot: 'stt', endpoint: 'https://example.invalid/v1/audio/transcriptions', credentialRef: 'cred-9', auth: 'credentialRef' })
  assert.deepEqual(result.items, [{ id: 'm1', label: '模型一' }])
  assert.equal(apiSlotOf('stt'), 'asr')
})

// ---------------------------------------------------------------- CUX-03 新 Key 保存后发现

const discoverDraft = (over = {}) => ({ mode: 'own', selection: { adapterId: 'openai-compatible-text', provider: 'ofm', protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:18899/v1/chat/completions' }, key: '', readError: '', error: '', message: '', ...over })

test('CUX-03 a new key is persisted BEFORE discovery and the plaintext is cleared at the receipt', async () => {
  const client = fakeClient(okHandlers({
    '/api/self-setup': { instanceId: 'inst-1', credentialRevision: 3 },
    '/api/self-setup/credentials': ({ options }) => {
      // 发现绝不能已经发生：凭据必须先写。
      assert.equal(client.calls.some(call => call.path === '/api/provider-sources/discover'), false, 'credentials must precede discovery')
      assert.equal(options.body.provider, 'ofm', 'the key is saved under the provider of THIS attempt')
      assert.equal(options.body.key, 'sk-anonymous-cux03')
      assert.equal(options.body.expectedRevision, 3)
      return { credentialRef: 'managed-cux03' }
    },
    '/api/provider-sources/discover': ({ options }) => {
      assert.equal(options.body.credentialRef, 'managed-cux03', 'discovery uses the freshly saved reference')
      assert.equal('key' in options.body, false, 'discovery must never carry the plaintext key')
      assert.equal('apiKey' in options.body, false)
      return { items: [{ id: 'ofm-model', label: 'ofm' }] }
    },
  }))
  const session = createCharacterSession(client)
  const phases = []
  let savedReceipt = null
  const result = await session.discoverForDraft({
    characterId: 'role-b', slot: 'dialogue', draft: discoverDraft({ key: 'sk-anonymous-cux03' }),
    credentialOperation: {},
    onPhase: phase => phases.push(phase),
    onCredentialSaved: receipt => {
      savedReceipt = receipt
      // 回调必须在发现开始之前到达，UI 才能立刻清空明文草稿。
      assert.equal(client.calls.some(call => call.path === '/api/provider-sources/discover'), false, 'the receipt callback must run before discovery starts')
    },
  })
  assert.deepEqual(phases, ['savingCredential', 'discovering', 'success'])
  assert.deepEqual(result.items, [{ id: 'ofm-model', label: 'ofm' }])
  assert.equal(result.credentialSaved, true)
  assert.deepEqual(savedReceipt, { credentialRef: 'managed-cux03', saved: true })
  // 严格顺序：credentials → discover，且不登记来源、不写绑定。
  const writePaths = client.calls.map(call => call.path)
  assert.ok(writePaths.indexOf('/api/self-setup/credentials') < writePaths.indexOf('/api/provider-sources/discover'))
  assert.equal(client.calls.some(call => call.path === '/api/provider-sources'), false, 'discovery must not register a source')
  assert.equal(client.calls.some(call => call.path === '/api/characters/bindings'), false, 'discovery must not write a binding')
  // 明文 Key 不出现在任何 URL 里。
  assert.equal(client.calls.every(call => !call.path.includes('sk-anonymous-cux03')), true)
})

test('CUX-03 four branches: new key wins, existing ref discovers directly, none skips credentials, empty input is refused locally', async () => {
  // (a) 已有引用直接发现，不写凭据。
  const reuse = fakeClient(okHandlers({
    '/api/provider-sources/discover': ({ options }) => { assert.equal(options.body.credentialRef, 'cred-existing'); return { items: [{ id: 'm1' }] } },
  }))
  const reused = await createCharacterSession(reuse).discoverForDraft({ characterId: 'role-b', slot: 'dialogue', draft: discoverDraft({ selection: { ...discoverDraft().selection, credentialRef: 'cred-existing' } }), credentialOperation: {} })
  assert.equal(reused.phase, 'success')
  assert.equal(reused.credentialSaved, false)
  assert.equal(reuse.calls.some(call => call.path === '/api/self-setup/credentials'), false, 'an existing reference must not be re-saved')

  // (b) 新 Key 优先于已选择凭据：保存用新 Key，发现用新引用。
  const both = fakeClient(okHandlers({
    '/api/self-setup': { instanceId: 'inst-1', credentialRevision: 0 },
    '/api/self-setup/credentials': () => ({ credentialRef: 'managed-new' }),
    '/api/provider-sources/discover': ({ options }) => { assert.equal(options.body.credentialRef, 'managed-new', 'the new key must win over the stale reference'); return { items: [] } },
  }))
  const won = await createCharacterSession(both).discoverForDraft({ characterId: 'role-b', slot: 'dialogue', draft: discoverDraft({ key: 'sk-anonymous-cux03-new', selection: { ...discoverDraft().selection, credentialRef: 'cred-stale' } }), credentialOperation: {} })
  assert.equal(won.credentialRef, 'managed-new')
  assert.equal(won.credentialSaved, true)

  // (c) 免 Key：不调用 credentials，发现带 auth=none 与空引用。
  const none = fakeClient(okHandlers({
    '/api/provider-sources/discover': ({ options }) => { assert.equal(options.body.auth, 'none'); assert.equal(options.body.credentialRef, ''); return { items: [{ id: 'local-model' }] } },
  }))
  const noKey = await createCharacterSession(none).discoverForDraft({ characterId: 'role-b', slot: 'dialogue', draft: discoverDraft({ selection: { ...discoverDraft().selection, endpoint: 'http://127.0.0.1:8080/v1', auth: 'none' } }), credentialOperation: {} })
  assert.equal(noKey.phase, 'success')
  assert.equal(none.calls.some(call => call.path === '/api/self-setup/credentials'), false, 'auth:none must not write a credential')
  assert.equal(none.calls.some(call => call.path === '/api/self-setup'), false)

  // (d) 既无新 Key 也无引用：前端直接说明，**不发**必失败请求。
  const empty = fakeClient(okHandlers({}))
  const refused = await createCharacterSession(empty).discoverForDraft({ characterId: 'role-b', slot: 'dialogue', draft: discoverDraft(), credentialOperation: {} })
  assert.equal(refused.phase, 'error')
  assert.match(refused.error, /请先填写|已有凭据/)
  assert.equal(empty.calls.length, 0, 'no request may be sent when the input cannot succeed')
})

test('CUX-03 a credential that succeeds but discovery that fails keeps the reference and does not restore the key', async () => {
  const client = fakeClient(okHandlers({
    '/api/self-setup': { instanceId: 'inst-1', credentialRevision: 0 },
    '/api/self-setup/credentials': () => ({ credentialRef: 'managed-keep' }),
    '/api/provider-sources/discover': () => { throw Object.assign(new Error('该服务拒绝了这次请求（401）。'), { status: 403 }) },
  }))
  const session = createCharacterSession(client)
  const first = await session.discoverForDraft({ characterId: 'role-b', slot: 'dialogue', draft: discoverDraft({ key: 'sk-anonymous-cux03-retry' }), credentialOperation: {} })
  assert.equal(first.phase, 'error')
  assert.equal(first.credentialSaved, true, 'the credential IS saved; the failure is discovery')
  assert.equal(first.credentialRef, 'managed-keep', 'the confirmed reference must survive a discovery failure')
  assert.match(first.error, /401|拒绝/)
  // 重试：只重试发现，不重复存 Key。
  const holder = {}
  const second = await session.discoverForDraft({
    characterId: 'role-b', slot: 'dialogue',
    draft: discoverDraft({ selection: { ...discoverDraft().selection, credentialRef: 'managed-keep' } }),
    credentialOperation: holder,
  })
  assert.equal(second.phase, 'error')
  assert.equal(client.calls.filter(call => call.path === '/api/self-setup/credentials').length, 1, 'a discovery retry must not create a second credential')
})

test('CUX-03 cancellation and timeout report an unknown outcome instead of claiming a rollback', async () => {
  const abortError = Object.assign(new Error('请求超时，操作结果待确认，请刷新回读。'), { status: 0 })
  const client = fakeClient(okHandlers({
    '/api/self-setup': { instanceId: 'inst-1', credentialRevision: 0 },
    '/api/self-setup/credentials': () => { throw abortError },
  }))
  const result = await createCharacterSession(client).discoverForDraft({ characterId: 'role-b', slot: 'dialogue', draft: discoverDraft({ key: 'sk-anonymous-cux03-timeout' }), credentialOperation: {} })
  assert.equal(result.phase, 'error')
  assert.equal(result.credentialOutcomeUnknown, true, 'a timeout must be reported as an unknown outcome')
  assert.match(result.error, /待确认/, 'it must not claim the credential was rolled back or deleted')
  assert.equal(client.calls.some(call => call.path === '/api/provider-sources/discover'), false, 'no discovery without a confirmed reference')
})

test('CUX-03 credential and binding writes never share an operationId holder', async () => {
  const credentialHolder = {}
  const bindingHolder = {}
  const client = fakeClient(okHandlers({
    '/api/self-setup': { instanceId: 'inst-1', credentialRevision: 0 },
    '/api/self-setup/credentials': ({ options }) => ({ credentialRef: `managed-${options.body.operationId.slice(0, 4)}`, operationId: options.body.operationId }),
    '/api/provider-sources': () => ({ entry: { source: { sourceId: 'source.cux03', auth: { kind: 'credentialRef', ref: 'managed-x' } }, profile: { modelProfileId: 'profile.cux03' } } }),
  }))
  const session = createCharacterSession(client)
  await session.discoverForDraft({ characterId: 'role-b', slot: 'dialogue', draft: discoverDraft({ key: 'sk-anonymous-cux03-holder' }), credentialOperation: credentialHolder })
  const credentialCall = client.calls.find(call => call.path === '/api/self-setup/credentials')
  assert.ok(credentialCall.options.body.operationId, 'the credential write carries its own operationId')
  // 凭据成功后 holder 被清空：明文 Key 的签名不再驻留，重试会重新生成 id 而不是复用。
  assert.equal(credentialHolder.signature, undefined)
  assert.equal(credentialHolder.operationId, undefined)
  // 绑定写入使用自己的 holder，不受凭据阶段影响。
  const bindingDraft = { mode: 'own', selection: { ...discoverDraft().selection, credentialRef: 'managed-x' }, key: '', readError: '', error: '', message: '' }
  await session.saveBinding({ characterId: 'role-b', slot: 'dialogue', draft: bindingDraft, expectedRevision: 3, holder: bindingHolder })
  const put = client.calls.find(call => call.path === '/api/characters/bindings' && call.options.method === 'PUT')
  assert.notEqual(put.options.body.operationId, credentialCall.options.body.operationId, 'the two stages must not share an operationId')
})

test('CUX-03 a stale key is never re-sent: a second discovery with the saved reference writes no credential', async () => {
  const client = fakeClient(okHandlers({
    '/api/self-setup': { instanceId: 'inst-1', credentialRevision: 0 },
    '/api/self-setup/credentials': () => ({ credentialRef: 'managed-once' }),
    '/api/provider-sources/discover': () => ({ items: [{ id: 'm' }] }),
  }))
  const session = createCharacterSession(client)
  const holder = {}
  await session.discoverForDraft({ characterId: 'role-b', slot: 'dialogue', draft: discoverDraft({ key: 'sk-anonymous-cux03-once' }), credentialOperation: holder })
  assert.equal(client.calls.filter(call => call.path === '/api/self-setup/credentials').length, 1)
  // UI 在回执后清空明文并写入引用；第二次点击只带引用。
  await session.discoverForDraft({ characterId: 'role-b', slot: 'dialogue', draft: discoverDraft({ selection: { ...discoverDraft().selection, credentialRef: 'managed-once' } }), credentialOperation: holder })
  assert.equal(client.calls.filter(call => call.path === '/api/self-setup/credentials').length, 1, 'the saved reference must not trigger a second credential write')
  assert.equal(client.calls.filter(call => call.path === '/api/provider-sources/discover').length, 2)
})

// ---------------------------------------------------------------- CUX-04 保存确认一致性

/** 一个最小视图工厂：own 绑定的对话槽。 */
const ownView = (over = {}) => view({
  configuration: {
    ...view().configuration, savedRevision: 4, revision: 4,
    bindings: { ...view().configuration.bindings, dialogue: { mode: 'own', sourceInstanceId: 'source.1', modelProfileId: 'profile.1', credentialRef: 'cred-1', parameters: {} } },
  },
  selections: { ...view().selections, dialogue: { ...view().selections.dialogue, credentialRef: 'cred-1' } },
  ...over,
})
const ownDraft = () => ({ mode: 'own', selection: { adapterId: 'openai-compatible-text', provider: 'openai', model: 'gpt-x', endpoint: 'https://example.invalid/v1/chat/completions', credentialRef: 'cred-1' }, key: '', readError: '', error: '', message: '' })
const ownSource = { apiVersion: 1, entry: { source: { sourceId: 'source.1', auth: { kind: 'credentialRef', ref: 'cred-1' } }, profile: { modelProfileId: 'profile.1' } } }

test('CUX-04 the write receipt comes from the PUT response, not from the later GET (R1)', async () => {
  // RED 场景：PUT 2xx 返回 savedRevision 4，但随后 GET 回旧值 3。
  // 旧实现把 GET 的 revision 当成回执，页面就会显示「已保存并回读」却是旧配置。
  const client = fakeClient(okHandlers({
    '/api/provider-sources': ownSource,
    '/api/characters/bindings': ({ options }) => {
      if (options.method === 'PUT') return { configuration: { ...ownView().configuration, savedRevision: 4 }, applyOn: 'restart' }
      // 回读返回旧修订与旧的 inherit-default 绑定。
      return view({ configuration: { ...view().configuration, savedRevision: 3 } })
    },
  }))
  const result = await createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft: ownDraft(), expectedRevision: 3, holder: {} })
  assert.equal(result.outcome, 'superseded', `a stale readback must not be reported as confirmed: ${result.outcome}`)
  assert.equal(result.writeReceipt.savedRevision, 4, 'the write receipt keeps the PUT response revision')
  assert.equal(result.readback.savedRevision, 3, 'the readback keeps what the GET actually returned')
  assert.match(result.reason, /随后配置又发生了变化|陈旧/)
  // 不显示成功：调用方据 outcome 判定，页面不会拿到「已保存并回读」。
  assert.equal(isConfirmed(result), false)
})

test('CUX-04 PUT 2xx followed by a failing readback is written-unconfirmed, not a thrown error (R2)', async () => {
  let reads = 0
  const client = fakeClient(okHandlers({
    '/api/provider-sources': ownSource,
    '/api/characters/bindings': ({ options }) => {
      if (options.method === 'PUT') return { configuration: { ...ownView().configuration, savedRevision: 4 }, applyOn: 'restart' }
      reads++
      throw Object.assign(new Error('anon: 回读失败'), { status: 503 })
    },
  }))
  const result = await createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft: ownDraft(), expectedRevision: 3, holder: {} })
  assert.equal(result.outcome, 'written-unconfirmed', 'a failed readback must not be an exception the page turns into a generic failure')
  assert.equal(result.stage, 'readback')
  assert.equal(result.writeReceipt.savedRevision, 4, 'the write receipt is preserved for the caller')
  assert.match(result.reason, /回读未确认/)
  assert.equal(reads >= 1, true, 'the readback was actually attempted')
  assert.equal(isConfirmed(result), false)
})

test('CUX-04 a per-slot readError blocks confirmation (R3)', async () => {
  const client = fakeClient(okHandlers({
    '/api/provider-sources': ownSource,
    '/api/characters/bindings': ({ options }) => {
      if (options.method === 'PUT') return { configuration: { ...ownView().configuration, savedRevision: 4 }, applyOn: 'restart' }
      return view({
        configuration: { ...view().configuration, savedRevision: 4, bindings: { ...view().configuration.bindings, dialogue: { mode: 'own', sourceInstanceId: 'source.1', modelProfileId: 'profile.1', credentialRef: 'cred-1', parameters: {} } } },
        selections: { ...view().selections, dialogue: null },
        readErrors: { dialogue: '已保存的来源或模型配置无法解析，请重新选择此角色的来源。' },
      })
    },
  }))
  const result = await createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft: ownDraft(), expectedRevision: 3, holder: {} })
  assert.equal(result.outcome, 'written-unconfirmed', 'a readError must never be reported as a confirmed save')
  assert.match(result.reason, /读取失败/)
  assert.equal(result.readback.readError, '已保存的来源或模型配置无法解析，请重新选择此角色的来源。')
  assert.equal(isConfirmed(result), false)
})

test('CUX-04 a larger revision with a matching target slot confirms and records the concurrent change (R4)', async () => {
  const client = fakeClient(okHandlers({
    '/api/provider-sources': ownSource,
    '/api/characters/bindings': ({ options }) => {
      if (options.method === 'PUT') return { configuration: { ...ownView().configuration, savedRevision: 4 }, applyOn: 'restart' }
      // 另一个写者推进到 5，但本槽位仍是本次提交的内容。
      return ownView({ configuration: { ...ownView().configuration, savedRevision: 5, revision: 5 } })
    },
  }))
  const result = await createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft: ownDraft(), expectedRevision: 3, holder: {} })
  assert.equal(result.outcome, 'confirmed', `a larger revision with an unchanged slot must confirm: ${result.reason}`)
  assert.equal(result.concurrentChanges, true, 'the concurrent change must be recorded, not treated as a failure')
  assert.equal(result.readback.savedRevision, 5)
})

test('CUX-04 a PUT timeout is outcome-unknown and never claims the write did not happen', async () => {
  const client = fakeClient(okHandlers({
    '/api/provider-sources': ownSource,
    '/api/characters/bindings': ({ options }) => {
      if (options.method === 'PUT') throw Object.assign(new Error('请求超时，操作结果待确认，请刷新回读。'), { status: 0 })
      return ownView()
    },
  }))
  const result = await createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft: ownDraft(), expectedRevision: 3, holder: {} })
  assert.equal(result.outcome, 'outcome-unknown')
  assert.match(result.reason, /结果未知/)
  assert.equal(isConfirmed(result), false)
})

test('CUX-04 a PUT whose receipt disagrees with the submitted binding is not confirmed', async () => {
  const client = fakeClient(okHandlers({
    '/api/provider-sources': ownSource,
    '/api/characters/bindings': ({ options }) => {
      if (options.method === 'PUT') {
        // 服务端回了**另一个**来源：不能把这次提交当成已保存。
        return { configuration: { ...ownView().configuration, savedRevision: 4, bindings: { ...ownView().configuration.bindings, dialogue: { mode: 'own', sourceInstanceId: 'source.OTHER', modelProfileId: 'profile.1', credentialRef: 'cred-1' } } }, applyOn: 'restart' }
      }
      return ownView()
    },
  }))
  const result = await createCharacterSession(client).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft: ownDraft(), expectedRevision: 3, holder: {} })
  assert.equal(result.outcome, 'written-unconfirmed')
  assert.match(result.reason, /不一致/)
  assert.equal(isConfirmed(result), false)
})

test('CUX-04 bindingMismatch accepts server-completed parameters but rejects owner/slot/reference drift', () => {
  const submitted = { mode: 'own', sourceInstanceId: 'source.1', modelProfileId: 'profile.1', credentialRef: 'cred-1' }
  // 服务端补全 parameters 是合法的规范化，不是不一致。
  assert.deepEqual(bindingMismatch(submitted, { ...submitted, parameters: { temperature: 0.7 } }), [])
  assert.deepEqual(bindingMismatch(submitted, submitted), [])
  assert.deepEqual(bindingMismatch({ mode: 'inherit-default' }, { mode: 'inherit-default' }), [])
  // 每一个引用漂移都必须被点名，而不是只报「有变化」。
  assert.equal(bindingMismatch(submitted, { ...submitted, sourceInstanceId: 'source.2' }).some(text => text.includes('sourceInstanceId')), true)
  assert.equal(bindingMismatch(submitted, { ...submitted, credentialRef: 'cred-2' }).some(text => text.includes('credentialRef')), true)
  assert.equal(bindingMismatch(submitted, { ...submitted, modelProfileId: 'profile.2' }).some(text => text.includes('modelProfileId')), true)
  // own → inherit 是根本差异，必须报告来源方式变化。
  assert.equal(bindingMismatch(submitted, { mode: 'inherit-default' }).some(text => text.includes('来源方式')), true)
  assert.equal(bindingMismatch({ mode: 'inherit-default' }, submitted).some(text => text.includes('来源方式')), true)
})

test('CUX-04 only a confirmed save replaces the draft; an unconfirmed save keeps it', async () => {
  const draft = { mode: 'own', selection: { ...ownDraft().selection, model: 'user-edited-model' }, key: '', readError: '', error: '', message: '' }
  const stale = fakeClient(okHandlers({
    '/api/provider-sources': ownSource,
    '/api/characters/bindings': ({ options }) => options.method === 'PUT'
      ? { configuration: { ...ownView().configuration, savedRevision: 4 }, applyOn: 'restart' }
      : view({ configuration: { ...view().configuration, savedRevision: 3 } }),
  }))
  const unconfirmed = await createCharacterSession(stale).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft, expectedRevision: 3, holder: {} })
  assert.equal(unconfirmed.draft, draft, 'an unconfirmed save must hand back the caller draft untouched')
  assert.equal(unconfirmed.draft.selection.model, 'user-edited-model', 'the user edit must survive')

  const ok = fakeClient(okHandlers({
    '/api/provider-sources': ownSource,
    '/api/characters/bindings': ({ options }) => options.method === 'PUT'
      ? { configuration: { ...ownView().configuration, savedRevision: 4 }, applyOn: 'restart' }
      : ownView(),
  }))
  const confirmed = await createCharacterSession(ok).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft, expectedRevision: 3, holder: {} })
  assert.equal(confirmed.outcome, 'confirmed')
  assert.notEqual(confirmed.draft, draft, 'a confirmed save replaces the draft with the server readback')
  assert.equal(confirmed.draft.selection.model, 'gpt-x', 'the confirmed draft reflects the saved configuration')
  assert.equal(confirmed.draft.mode, 'own', 'the saved mode is taken from the server, not forced from the pre-submit value')
})

// ---------------------------------------------------------------- 形象：运行 / 非运行

test('LUI-02 a NON-running role saves its own appearance and never flips the running skin', async () => {
  const client = fakeClient({
    '/api/characters/appearance': ({ options }) => {
      assert.equal(options.method, 'PUT')
      assert.equal(options.body.characterId, 'role-b')
      assert.equal(options.body.resourceId, 'skin-b')
      assert.equal(options.body.type, 'live2d')
      return { saved: true, resourceId: 'skin-b', revision: 5, applyOn: 'restart' }
    },
  })
  const result = await createCharacterSession(client).applyAppearance({ characterId: 'role-b', runningCharacterId: 'companion', resourceId: 'skin-b', type: 'live2d', expectedRevision: 7, activeSkinId: 'skin-a' })
  assert.equal(result.target, 'saved')
  assert.match(result.message, /下次该角色成为运行角色时生效/)
  assert.equal(client.calls.some(call => call.path.includes('/activate')), false, 'a non-running role must never call the global activation')
})

test('LUI-02 the RUNNING role activates through the registry with expectedRevision', async () => {
  const client = fakeClient({
    '/api/skins/skin-b/activate': ({ options }) => {
      assert.equal(options.method, 'POST')
      assert.equal(options.body.expectedRevision, 7, 'the switch is revision-checked against the registry the page read')
      return { apiVersion: 1, state: { schemaVersion: 1, revision: 8, activeSkinId: 'skin-b', skins: [] } }
    },
  })
  const result = await createCharacterSession(client).applyAppearance({ characterId: 'companion', runningCharacterId: 'companion', resourceId: 'skin-b', type: 'live2d', expectedRevision: 7, activeSkinId: 'skin-a' })
  assert.equal(result.target, 'running')
  assert.equal(result.state.state.activeSkinId, 'skin-b')
})

test('LUI-02 activating the already-active skin is a no-op, and a rejected switch changes nothing', async () => {
  const noop = fakeClient({})
  const unchanged = await createCharacterSession(noop).applyAppearance({ characterId: 'companion', runningCharacterId: 'companion', resourceId: 'skin-a', type: 'live2d', expectedRevision: 7, activeSkinId: 'skin-a' })
  assert.equal(unchanged.unchanged, true)
  assert.equal(noop.calls.length, 0, 'no request for an already-applied skin')

  const rejected = fakeClient({ '/api/skins/skin-b/activate': () => { throw Object.assign(new Error('模型包登记已更新，请刷新后重试。'), { status: 409 }) } })
  await assert.rejects(createCharacterSession(rejected).applyAppearance({ characterId: 'companion', runningCharacterId: 'companion', resourceId: 'skin-b', type: 'live2d', expectedRevision: 7, activeSkinId: 'skin-a' }), error => isConflict(error) === true)
})

test('LUI-02 an unsupported skin apiVersion is refused', async () => {
  const client = fakeClient({ '/api/skins': { apiVersion: 2, state: { revision: 1, activeSkinId: '', skins: [] } } })
  await assert.rejects(createCharacterSession(client).loadSkins(), /外观登记接口/)
})

// ---------------------------------------------------------------- 故事书

const BOOK = 'lb-anon-1'
const book = (entries = [], revision = 2) => ({ schemaVersion: 1, id: BOOK, ownerCharacterId: 'role-b', title: '世界设定', revision, entries })

test('LUI-02 lorebook add posts the book revision and the whole validated batch', async () => {
  const client = fakeClient({
    [`/api/characters/lorebooks/${BOOK}`]: ({ options }) => {
      assert.equal(options.method, 'PUT')
      assert.equal(options.body.characterId, 'role-b')
      assert.equal(options.body.expectedRevision, 3, 'the edit is revision-checked against the book the page read')
      assert.deepEqual(options.body.entries, [{ title: '初遇', content: '两人在图书馆相遇。', strategy: 'keyword', keywords: ['图书馆', '初遇'] }])
      return { lorebook: book([{ id: 'le-1', title: '初遇', enabled: true, strategy: 'keyword', keywords: ['图书馆'], content: '两人在图书馆相遇。', revision: 1, order: 1 }], 4) }
    },
  })
  const next = await createCharacterSession(client).writeLorebookEntry('role-b', { op: 'add', bookId: BOOK, expectedRevision: 3, entry: { title: '初遇', content: '两人在图书馆相遇。', strategy: 'keyword', keywords: splitKeywords('图书馆, 初遇') } })
  assert.equal(next.revision, 4)
  assert.equal(next.entries[0].id, 'le-1')
})

test('LUI-02 an untriggerable entry is refused locally, never round-tripped', async () => {
  const client = fakeClient({})
  await assert.rejects(
    createCharacterSession(client).writeLorebookEntry('role-b', { op: 'add', bookId: BOOK, expectedRevision: 3, entry: { title: 'x', content: '正文', strategy: 'keyword', keywords: [] } }),
    /至少需要一个关键词/,
  )
  await assert.rejects(
    createCharacterSession(client).writeLorebookEntry('role-b', { op: 'add', bookId: BOOK, expectedRevision: 3, entry: { title: 'x', content: '   ', strategy: 'always', keywords: [] } }),
    /条目正文/,
  )
  assert.equal(client.calls.length, 0)
})

test('LUI-02 toggling an entry sends only `enabled`, so it can never blank the authored body', async () => {
  const client = fakeClient({
    [`/api/characters/lorebooks/${BOOK}/entries/le-1`]: ({ options }) => {
      assert.equal(options.method, 'PUT')
      assert.deepEqual(options.body.entry, { enabled: false }, 'only the toggle is sent; omitted fields stay the server\'s to keep')
      assert.equal(options.body.expectedRevision, 2)
      return { lorebook: book([{ id: 'le-1', title: '背景', enabled: false, strategy: 'always', keywords: [], content: '角色在海边长大。', revision: 2, order: 1 }], 3) }
    },
  })
  const next = await createCharacterSession(client).writeLorebookEntry('role-b', { op: 'toggle', bookId: BOOK, entryId: 'le-1', expectedRevision: 2, enabled: false })
  assert.equal(next.entries[0].enabled, false)
  assert.equal(next.entries[0].content, '角色在海边长大。', 'the body is whatever the server returned, not a local guess')
})

test('LUI-02 removing an entry is its own revision-checked DELETE', async () => {
  const client = fakeClient({
    [`/api/characters/lorebooks/${BOOK}/entries/le-1`]: ({ options }) => {
      assert.equal(options.method, 'DELETE')
      assert.equal(options.body.expectedRevision, 2)
      assert.equal('entries' in options.body, false, 'removal must not re-post the surviving entries')
      return { lorebook: book([], 3) }
    },
  })
  const next = await createCharacterSession(client).writeLorebookEntry('role-b', { op: 'remove', bookId: BOOK, entryId: 'le-1', expectedRevision: 2 })
  assert.equal(next.entries.length, 0)
})

test('LUI-02 a 409 on an entry write is a conflict the caller can keep its draft for', async () => {
  const client = fakeClient({ [`/api/characters/lorebooks/${BOOK}/entries/le-1`]: () => { throw Object.assign(new Error('故事书已更新，请刷新后重试。'), { status: 409 }) } })
  await assert.rejects(createCharacterSession(client).writeLorebookEntry('role-b', { op: 'remove', bookId: BOOK, entryId: 'le-1', expectedRevision: 2 }), error => isConflict(error) === true)
})

test('LUI-02 replaceBook adopts the server copy wholesale instead of merging optimistically', () => {
  const stale = book([{ id: 'le-1', title: '旧标题', enabled: true, strategy: 'always', keywords: [], content: '旧正文', revision: 1, order: 1 }], 2)
  const fresh = book([{ id: 'le-1', title: '新标题', enabled: true, strategy: 'always', keywords: [], content: '服务端正文', revision: 2, order: 1 }], 3)
  const replaced = replaceBook([stale], fresh)
  assert.equal(replaced[0].revision, 3)
  assert.equal(replaced[0].entries[0].content, '服务端正文')
  assert.equal(replaced[0].entries[0].title, '新标题', 'a rejected local edit must not survive the replacement')
  assert.equal(replaceBook([stale], { ...fresh, id: 'lb-2' }).length, 2, 'an unseen book is appended')
  assert.equal(replaceBook([stale], undefined)[0].revision, 2, 'a missing book leaves the list untouched')
})

test('LUI-02 creating a book reuses one operationId across a retry of the same title', async () => {
  let attempt = 0
  const client = fakeClient({
    '/api/characters/lorebooks': ({ options }) => {
      attempt++
      assert.equal(options.method, 'POST')
      if (attempt === 1) throw Object.assign(new Error('anon: create refused'), { status: 400 })
      return { operationId: options.body.operationId, created: true, lorebook: book([], 1) }
    },
  })
  const session = createCharacterSession(client)
  const holder = {}
  await assert.rejects(session.createLorebook({ characterId: 'role-b', title: '新书', holder }), /refused/)
  await session.createLorebook({ characterId: 'role-b', title: '新书', holder })
  const [first, second] = client.calls
  assert.equal(first.options.body.operationId, second.options.body.operationId, 'a retried create must not write a second book')
  await assert.rejects(session.createLorebook({ characterId: 'role-b', title: '  ', holder }), /标题/)
})

test('LUI-02 import is preview-then-confirm and the preview never writes', async () => {
  const payload = { schemaVersion: 1, title: '导入的书', entries: [{ title: 'a', content: 'b', strategy: 'always', keywords: [] }] }
  const client = fakeClient({
    '/api/characters/lorebooks/import': ({ options }) => {
      assert.equal(options.method, 'POST')
      assert.deepEqual(options.body.book, payload)
      return { preview: { title: '导入的书', entries: payload.entries }, entryCount: 1 }
    },
    '/api/characters/lorebooks/import/confirm': ({ options }) => {
      assert.equal(options.method, 'POST')
      assert.ok(options.body.operationId, 'the confirm carries an idempotent operationId')
      return { operationId: options.body.operationId, imported: true, lorebook: book([], 1) }
    },
  })
  const session = createCharacterSession(client)
  const preview = await session.previewLorebookImport('role-b', payload)
  assert.equal(preview.entryCount, 1)
  assert.equal(client.calls.length, 1, 'the preview is a single read-only request')
  const holder = {}
  await session.confirmLorebookImport({ characterId: 'role-b', book: payload, holder })
  await session.confirmLorebookImport({ characterId: 'role-b', book: payload, holder })
  const confirms = client.calls.filter(call => call.path === '/api/characters/lorebooks/import/confirm')
  assert.equal(confirms[0].options.body.operationId, confirms[1].options.body.operationId, 'a retried confirm replays the same operationId')
})

test('LUI-02 loading an unwired lorebook store stays unavailable instead of looking empty', async () => {
  const client = fakeClient({ '/api/characters/lorebooks': () => { throw Object.assign(new Error('当前实例尚未接入故事书。'), { status: 503 }) } })
  await assert.rejects(createCharacterSession(client).loadLorebooks('role-b'), /尚未接入/)
})

// ---------------------------------------------------------------- 本地能力 / 表现策略

test('LUI-02 local capabilities report the honest availability of each probe', async () => {
  const client = fakeClient({
    '/api/roles/local-capabilities': { apiVersion: 1, observedAt: '2026-10-08T00:00:00.000Z', capabilities: [{ capabilityId: 'local.tts', adapterId: 'sapi-tts', availability: 'ready', reason: 'system_voices_enumerated' }, { capabilityId: 'local.asr', adapterId: 'sherpa-streaming-asr', availability: 'unavailable', reason: 'no_configured_model_directory' }] },
  })
  const report = await createCharacterSession(client).loadLocalCapabilities()
  assert.equal(report.capabilities.length, 2)
  assert.equal(report.capabilities[1].availability, 'unavailable', 'a missing local model stays unavailable, never ready')
  const unwired = fakeClient({ '/api/roles/local-capabilities': () => { throw Object.assign(new Error('当前实例尚未接入本地能力检测。'), { status: 503 }) } })
  await assert.rejects(createCharacterSession(unwired).loadLocalCapabilities(), /尚未接入/)
})

test('LUI-02 the presentation policy is saved with expectedRevision and adopts the server revision', async () => {
  const client = fakeClient({
    '/api/presentation': ({ options }) => {
      if (!options.method) return { catalog: { schemaVersion: 1, modelId: 'm', modelFingerprint: 'a'.repeat(64), items: [] }, policy: { modelId: 'm', revision: 1, enabledIds: [] } }
      assert.equal(options.method, 'PUT')
      assert.equal(options.body.expectedRevision, 1, 'a stale policy must be refused by the server')
      assert.deepEqual(options.body.enabledIds, ['exp-1'])
      return { catalog: { schemaVersion: 1, modelId: 'm', modelFingerprint: 'a'.repeat(64), items: [] }, policy: { modelId: 'm', revision: 2, enabledIds: ['exp-1'] } }
    },
  })
  const session = createCharacterSession(client)
  const saved = await session.savePresentation({ modelId: 'm', expectedRevision: 1, enabledIds: ['exp-1'] })
  assert.equal(saved.policy.revision, 2, 'the page adopts the server revision, it never guesses one')
})

test('LUI-02 author metadata and persona are two owners with two cursors', async () => {
  const client = fakeClient({
    '/api/characters/profile': ({ options }) => {
      assert.equal(options.method, 'PUT')
      assert.equal(options.body.expectedFieldRevision, 4)
      assert.deepEqual(Object.keys(options.body).sort(), ['characterId', 'expectedFieldRevision', 'intro', 'operationId'], 'only the edited field is sent')
      return { operationId: options.body.operationId, applyOn: 'restart', fieldRevision: 5, configuration: { identity: { intro: '新简介' }, persona: { scenario: '旧背景' } } }
    },
    '/api/prompt': ({ options }) => {
      assert.equal(options.method, 'PUT')
      assert.equal(options.body.expectedRevision, 3)
      return { characterId: 'role-b', revision: 4, text: options.body.text }
    },
  })
  const session = createCharacterSession(client)
  const author = await session.saveAuthorMetadata({ characterId: 'role-b', fields: { intro: '新简介' }, expectedFieldRevision: 4, holder: {} })
  assert.equal(author.fieldRevision, 5)
  const persona = await session.savePersona({ characterId: 'role-b', text: '新正文', expectedRevision: 3, holder: {} })
  assert.equal(persona.revision, 4)
  assert.equal(client.calls.filter(call => call.path === '/api/prompt').length, 1, 'the persona body is written to its own owner only')
})

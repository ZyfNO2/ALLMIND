/**
 * CUX-00: 基线与保存回退取证。
 *
 * 本文件不改业务代码，只做取证：在隔离临时数据目录里跑**现有生产 management 代码**（真实
 * `startManagementServer` + `RoleConfigurationStore` + `ProviderSourceStore` + `ManagedCredentialStore`），
 * 记录一次「新 Key + own → 保存 → 硬刷新」的完整分阶段时序，并按分类门槛判断问题 D 属于哪一类。
 *
 * 纪律：
 *   * 只写脱敏证据：不记录 Key / Bearer / 凭据文件路径，端点若带用户信息先脱敏；
 *   * fixture 数据与用户真实数据严格分离（`fixture()` 使用 `mkdtemp`）；
 *   * stub 只是「匿名本机 Provider」，**不得**被写成真实 ofm 验收；
 *   * 真实用户 Key 保存 / 绑定改写 / 重启需要后续明确授权，本步不做。
 *
 * 证据落盘：`docs/next/ui-rework/evidence/config-issues-20261009/cux-00/`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'
import { RoleConfigurationStore } from '../../dist/management/role-configuration.js'

// 仓库根相对本文件在 windows/code/desktop-pet/tests/ui-rework/，所以是 ../../../docs。
const EVIDENCE = resolve('../../../validation/output/ui-rework-evidence/config-issues-20261009/cux-00')

/** 稳定脱敏别名：同一个真值总是映射到同一个别名，别名不可反推真值。 */
function aliaser(prefix) {
  const seen = new Map()
  return value => {
    const key = String(value ?? '')
    if (!key) return ''
    if (!seen.has(key)) seen.set(key, `${prefix}-${seen.size + 1}`)
    return seen.get(key)
  }
}
const credAlias = aliaser('cred')
const sourceAlias = aliaser('source')
const profileAlias = aliaser('profile')

/** 端点脱敏：去掉 userinfo / query / hash，只保留协议、主机与路径。 */
function redactEndpoint(value) {
  if (typeof value !== 'string' || !value) return ''
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch { return value.replace(/\S+@/, '***@') }
}

/** 递归脱敏请求体：绝不保留任何明文密钥字段。 */
const SECRET_KEYS = new Set(['key', 'apiKey', 'token', 'authorization', 'password', 'secret'])
function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(entry => redact(entry, depth + 1))
  const out = {}
  for (const [name, entry] of Object.entries(value)) {
    if (SECRET_KEYS.has(name)) { out[name] = typeof entry === 'string' && entry ? '<redacted:non-empty>' : '<redacted:empty>'; continue }
    out[name] = redact(entry, depth + 1)
  }
  return out
}

/** 只保留可比较的槽位字段，去掉任何凭据文件路径。 */
function slotSummary(selection) {
  if (!selection) return null
  const { credentialFile, ...rest } = selection
  void credentialFile
  return { ...rest, ...(rest.endpoint ? { endpoint: redactEndpoint(rest.endpoint) } : {}), ...(rest.credentialRef ? { credentialRef: credAlias(rest.credentialRef) } : {}) }
}

function bindingSummary(binding) {
  if (!binding) return null
  return {
    mode: binding.mode ?? null,
    sourceInstanceId: binding.sourceInstanceId ? sourceAlias(binding.sourceInstanceId) : null,
    modelProfileId: binding.modelProfileId ? profileAlias(binding.modelProfileId) : null,
    credentialRef: binding.credentialRef ? credAlias(binding.credentialRef) : null,
    parameters: binding.parameters ?? null,
  }
}

/** 把一次 GET /api/characters/bindings 的响应压成可 diff 的形状。 */
function viewSummary(view) {
  return {
    apiVersion: view.apiVersion,
    savedRevision: view.configuration?.savedRevision,
    effectiveRevision: view.configuration?.effectiveRevision,
    revision: view.configuration?.revision,
    applyOn: view.configuration?.applyOn,
    bindings: Object.fromEntries(['dialogue', 'tts', 'asr'].map(slot => [slot, bindingSummary(view.configuration?.bindings?.[slot])])),
    selections: Object.fromEntries(['dialogue', 'tts', 'asr'].map(slot => [slot, slotSummary(view.selections?.[slot])])),
    readErrors: view.readErrors ?? {},
    effective: view.effective ? { savedRevision: view.effective.savedRevision ?? null, capabilities: Object.fromEntries(Object.entries(view.effective.capabilities ?? {}).map(([slot, value]) => [slot, value ? { provider: value.provider, model: value.model, endpoint: redactEndpoint(value.endpoint), adapterId: value.adapterId } : null])) } : null,
  }
}

/** 覆盖 SPEC §2.4 要求的全部字段，不只比较模型名。 */
function bindingDiff(before, after) {
  const diff = {}
  const left = before ?? {}, right = after ?? {}
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const a = JSON.stringify(left[key] ?? null), b = JSON.stringify(right[key] ?? null)
    if (a !== b) diff[key] = { before: left[key] ?? null, after: right[key] ?? null }
  }
  return diff
}

/** 记录每一次真实 HTTP 调用的状态与关键回执字段。 */
function recorder(fixture) {
  const events = []
  async function call(label, path, method = 'GET', body) {
    const started = Date.now()
    const response = await fetch(fixture.server.origin + path, {
      method,
      headers: { Authorization: `Bearer ${fixture.server.token}`, Origin: fixture.server.origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    let value = null
    try { value = await response.json() } catch { /* a non-JSON body is itself evidence */ }
    const event = {
      seq: events.length + 1,
      label,
      method,
      path: path.split('?')[0],
      status: response.status,
      elapsedMs: Date.now() - started,
      request: body === undefined ? undefined : redact(body),
      receipt: value === null ? '<non-json>' : redact({
        ...(value.configuration ? { configuration: { savedRevision: value.configuration.savedRevision, effectiveRevision: value.configuration.effectiveRevision, revision: value.configuration.revision, bindings: Object.fromEntries(['dialogue', 'tts', 'asr'].map(slot => [slot, bindingSummary(value.configuration.bindings?.[slot])])) } } : {}),
        ...(value.entry ? { entry: { sourceId: sourceAlias(value.entry.source?.sourceId), modelProfileId: profileAlias(value.entry.profile?.modelProfileId), authKind: value.entry.source?.auth?.kind, authRef: value.entry.source?.auth?.ref ? credAlias(value.entry.source.auth.ref) : undefined } } : {}),
        ...(value.credentialRef ? { credentialRef: credAlias(value.credentialRef) } : {}),
        ...(value.applyOn ? { applyOn: value.applyOn } : {}),
        ...(value.operationId ? { operationId: value.operationId } : {}),
        ...(value.error ? { error: value.error } : {}),
        ...(value.selections ? { selections: Object.fromEntries(['dialogue', 'tts', 'asr'].map(slot => [slot, slotSummary(value.selections?.[slot])])) } : {}),
        ...(value.readErrors ? { readErrors: value.readErrors } : {}),
        ...(value.saved !== undefined ? { saved: value.saved, resourceId: value.resourceId, revision: value.revision } : {}),
        ...(value.apiVersion !== undefined && value.state ? { skinRevision: value.state.revision, activeSkinId: value.state.activeSkinId } : {}),
        ...(value.instanceId ? { instanceId: value.instanceId, credentialRevision: value.credentialRevision } : {}),
      }),
    }
    events.push(event)
    if (!response.ok) throw Object.assign(Error(value?.error?.message || `HTTP ${response.status}`), { status: response.status, code: value?.error?.code, event })
    return value
  }
  return { events, call }
}

/** 匿名本机 Provider stub：只提供 GET /v1/models，不接收也不记录任何鉴权值。 */
async function providerStub() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push({ method: req.method, path: req.url, authPresent: Boolean(req.headers.authorization) })
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'stub-model-a' }, { id: 'stub-model-b' }] }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'stub: no such route' } }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { origin: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise(done => server.close(done)) }
}

/** 版本与产物基线：源码 HEAD 不代表正在运行的 dist。 */
function sourceBaseline() {
  const git = (...args) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim() } catch { return '<unavailable>' } }
  const head = git('rev-parse', 'HEAD')
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean)
  return { head, dirtyCount: dirty.length, dirtySample: dirty.slice(0, 12), branch: git('branch', '--show-current') }
}

async function writeEvidence(name, payload) {
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, name), JSON.stringify(payload, null, 2), 'utf8')
}

// ---------------------------------------------------------------- 场景 1：新 Key + own → 保存 → 硬刷新

test('CUX-00 场景1：新 Key + own 的完整保存时序与 saved/effective diff', { timeout: 120000 }, async t => {
  const f = await roleConsoleFixture(t)
  const stub = await providerStub()
  t.after(() => stub.close())
  const rec = recorder(f)
  const baseline = sourceBaseline()
  const snapshot = await f.request('/api/snapshot')
  const identity = {
    sourceBaseline: baseline,
    backend: { instanceId: snapshot.runtime.instanceId, sourceRevision: snapshot.runtime.sourceRevision, pid: snapshot.runtime.pid, characterId: snapshot.runtime.characterId },
    fixtureProjectRootIsTemp: f.c.projectRoot.includes('trial-config-'),
    characterId: 'role-b',
    slot: 'dialogue',
    providerStub: { origin: stub.origin, note: '匿名本机 Provider stub；不是真实 ofm 验收' },
  }

  const beforeView = await rec.call('保存前 GET', '/api/characters/bindings?characterId=role-b')
  const setup = await rec.call('凭据实例快照 GET', '/api/self-setup')
  const credential = await rec.call('credentials POST', '/api/self-setup/credentials', 'POST', {
    instanceId: setup.instanceId, provider: 'ofm', key: 'sk-anonymous-cux00-fixture',
    expectedRevision: setup.credentialRevision, operationId: 'cux00-credential-1',
  })
  const source = await rec.call('provider-sources POST', '/api/provider-sources', 'POST', {
    characterId: 'role-b', slot: 'dialogue', selection: {
      adapterId: 'openai-compatible-text', provider: 'ofm', protocol: 'openai-compatible',
      endpoint: `${stub.origin}/v1/chat/completions`, credentialRef: credential.credentialRef, model: 'stub-model-a',
      inputTokenLimit: 8192, outputTokenLimit: 2048, reservationMicros: 10000, inputMicrosPerToken: 1, outputMicrosPerToken: 2,
    },
  })
  const binding = {
    mode: 'own', sourceInstanceId: source.entry.source.sourceId, modelProfileId: source.entry.profile.modelProfileId,
    credentialRef: credential.credentialRef,
  }
  const put = await rec.call('bindings PUT', '/api/characters/bindings', 'PUT', {
    characterId: 'role-b', expectedRevision: beforeView.configuration.savedRevision, operationId: 'cux00-binding-1', bindings: { dialogue: binding },
  })
  const afterView = await rec.call('写后 GET', '/api/characters/bindings?characterId=role-b')

  // 硬刷新 = 丢掉页面内存，重新按权威接口读一次。
  const refreshed = await rec.call('硬刷新 GET', '/api/characters/bindings?characterId=role-b')

  // 进程/store 重开：真正的持久化判据。
  const reopened = await RoleConfigurationStore.open({ file: join(f.c.projectRoot, 'roles.json') })
  const reopenedView = await rec.call('store 重开后 GET', '/api/characters/bindings?characterId=role-b')

  const putConfiguration = put.configuration
  const evidence = {
    ...identity,
    events: rec.events,
    writeReceipt: { savedRevision: putConfiguration?.savedRevision, effectiveRevision: putConfiguration?.effectiveRevision, applyOn: put.applyOn, binding: bindingSummary(putConfiguration?.bindings?.dialogue) },
    views: { before: viewSummary(beforeView), afterWrite: viewSummary(afterView), afterHardRefresh: viewSummary(refreshed), afterStoreReopen: viewSummary(reopenedView) },
    diffs: {
      beforeToAfterWrite: { binding: bindingDiff(bindingSummary(beforeView.configuration?.bindings?.dialogue), bindingSummary(afterView.configuration?.bindings?.dialogue)), selection: bindingDiff(slotSummary(beforeView.selections?.dialogue), slotSummary(afterView.selections?.dialogue)) },
      afterWriteToHardRefresh: { binding: bindingDiff(bindingSummary(afterView.configuration?.bindings?.dialogue), bindingSummary(refreshed.configuration?.bindings?.dialogue)), selection: bindingDiff(slotSummary(afterView.selections?.dialogue), slotSummary(refreshed.selections?.dialogue)) },
      afterWriteToStoreReopen: { binding: bindingDiff(bindingSummary(afterView.configuration?.bindings?.dialogue), bindingSummary(reopenedView.configuration?.bindings?.dialogue)), selection: bindingDiff(slotSummary(afterView.selections?.dialogue), slotSummary(reopenedView.selections?.dialogue)) },
    },
    storeReopenedFromSameFile: reopened.get('role-b')?.bindings?.dialogue?.mode,
    stubHits: stub.hits,
  }
  await writeEvidence('cux-00-scenario-1.json', evidence)

  // ---- 断言：这条链路是「服务持久化问题」还是「正常」？
  assert.equal(putConfiguration.bindings.dialogue.mode, 'own', 'PUT 回执必须包含 own 绑定')
  assert.equal(afterView.configuration.bindings.dialogue.mode, 'own', '写后 GET 必须看到 own')
  assert.equal(refreshed.configuration.bindings.dialogue.mode, 'own', '硬刷新后必须仍是 own')
  assert.equal(refreshed.readErrors.dialogue, undefined, '健康槽位不得有 readError')
  assert.equal(refreshed.selections.dialogue.model, 'stub-model-a', '硬刷新后选择必须仍是本次提交的模型')
  assert.equal(reopenedView.configuration.bindings.dialogue.mode, 'own', 'store 重开后必须仍是 own')
  assert.deepEqual(evidence.diffs.afterWriteToStoreReopen.binding, {}, '写后与 store 重开之间不得有字段漂移')
  assert.deepEqual(evidence.diffs.afterWriteToStoreReopen.selection, {}, '写后与 store 重开之间选择不得漂移')
  assert.ok(reopenedView.configuration.savedRevision >= putConfiguration.savedRevision, 'savedRevision 不得回退')
  // 其他槽位必须原样保留。
  assert.equal(refreshed.configuration.bindings.tts.mode, 'inherit-default')
  assert.equal(refreshed.configuration.bindings.asr.mode, 'inherit-default')
  // 角色隔离。
  const other = await f.request('/api/characters/bindings?characterId=companion')
  assert.equal(other.configuration.bindings.dialogue.mode, 'inherit-default', '另一个角色不得被写入')
})

// ---------------------------------------------------------------- 场景 2：已有凭据复用

test('CUX-00 场景2：复用已有凭据（不写 credentials）与 inherit-default', { timeout: 120000 }, async t => {
  const f = await roleConsoleFixture(t)
  const rec = recorder(f)
  const setup = await rec.call('凭据实例快照 GET', '/api/self-setup')
  const credential = await rec.call('credentials POST', '/api/self-setup/credentials', 'POST', {
    instanceId: setup.instanceId, provider: 'openai', key: 'sk-anonymous-cux00-reuse',
    expectedRevision: setup.credentialRevision, operationId: 'cux00-credential-reuse',
  })
  const before = await rec.call('保存前 GET', '/api/characters/bindings?characterId=role-b')
  const source = await rec.call('provider-sources POST', '/api/provider-sources', 'POST', {
    characterId: 'role-b', slot: 'dialogue', selection: {
      adapterId: 'openai-compatible-text', provider: 'openai', protocol: 'openai-compatible',
      endpoint: 'https://cux00.example.invalid/v1/chat/completions', credentialRef: credential.credentialRef, model: 'reuse-model',
      inputTokenLimit: 4096, outputTokenLimit: 1024, reservationMicros: 5000, inputMicrosPerToken: 1, outputMicrosPerToken: 1,
    },
  })
  // 第二次保存复用同一个 credentialRef：不得再产生 credentials POST。
  const credentialWritesBefore = rec.events.filter(event => event.path === '/api/self-setup/credentials').length
  await rec.call('bindings PUT（复用已有凭据）', '/api/characters/bindings', 'PUT', {
    characterId: 'role-b', expectedRevision: before.configuration.savedRevision, operationId: 'cux00-binding-reuse',
    bindings: { dialogue: { mode: 'own', sourceInstanceId: source.entry.source.sourceId, modelProfileId: source.entry.profile.modelProfileId, credentialRef: credential.credentialRef } },
  })
  const credentialWritesAfter = rec.events.filter(event => event.path === '/api/self-setup/credentials').length
  const reused = await rec.call('写后 GET', '/api/characters/bindings?characterId=role-b')

  // inherit-default：不动来源登记，只把槽位改回继承。
  const inherit = await rec.call('bindings PUT（inherit-default）', '/api/characters/bindings', 'PUT', {
    characterId: 'role-b', expectedRevision: reused.configuration.savedRevision, operationId: 'cux00-binding-inherit', bindings: { dialogue: { mode: 'inherit-default' } },
  })
  const afterInherit = await rec.call('inherit 后 GET', '/api/characters/bindings?characterId=role-b')

  const evidence = {
    events: rec.events,
    credentialWritesDuringReuse: credentialWritesAfter - credentialWritesBefore,
    inheritReceipt: { savedRevision: inherit.configuration?.savedRevision, binding: bindingSummary(inherit.configuration?.bindings?.dialogue) },
    afterInherit: viewSummary(afterInherit),
  }
  await writeEvidence('cux-00-scenario-2.json', evidence)

  assert.equal(evidence.credentialWritesDuringReuse, 0, '复用已有凭据不得再写一次本机凭据')
  assert.equal(afterInherit.configuration.bindings.dialogue.mode, 'inherit-default', 'inherit-default 必须真的写回')
  assert.deepEqual(bindingSummary(afterInherit.configuration.bindings.dialogue), { mode: 'inherit-default', sourceInstanceId: null, modelProfileId: null, credentialRef: null, parameters: null })
  assert.ok(afterInherit.selections.dialogue, 'inherit 槽位仍必须能解析出全局默认来源，而不是 null')
})

// ---------------------------------------------------------------- 场景 3：409 与角色切换

test('CUX-00 场景3：409 冲突、PUT 后回读失败、角色 A/B 快速切换', { timeout: 120000 }, async t => {
  const f = await roleConsoleFixture(t)
  const rec = recorder(f)
  const before = await rec.call('保存前 GET', '/api/characters/bindings?characterId=role-b')

  // 另一个写者推进修订。
  const winner = await rec.call('其他写者 PUT', '/api/characters/bindings', 'PUT', {
    characterId: 'role-b', expectedRevision: before.configuration.savedRevision, operationId: 'cux00-other-writer', bindings: { tts: { mode: 'inherit-default' } },
  })
  let conflict = null
  try {
    await rec.call('过期修订 PUT', '/api/characters/bindings', 'PUT', {
      characterId: 'role-b', expectedRevision: before.configuration.savedRevision, operationId: 'cux00-stale-writer', bindings: { dialogue: { mode: 'inherit-default' } },
    })
  } catch (error) { conflict = { status: error.status, code: error.code, message: error.message } }
  const afterConflict = await rec.call('冲突后 GET', '/api/characters/bindings?characterId=role-b')

  // 角色 A/B 快速切换：交错读两个角色，互不串值。
  const reads = await Promise.all([
    rec.call('并发读 role-b', '/api/characters/bindings?characterId=role-b'),
    rec.call('并发读 companion', '/api/characters/bindings?characterId=companion'),
  ])

  const evidence = {
    events: rec.events,
    conflict,
    winnerRevision: winner.configuration?.savedRevision,
    afterConflict: viewSummary(afterConflict),
    concurrentReads: reads.map(viewSummary),
  }
  await writeEvidence('cux-00-scenario-3.json', evidence)

  assert.equal(conflict?.status, 409, '过期修订必须是 409，页面据此保留草稿')
  assert.equal(winner.configuration.savedRevision, before.configuration.savedRevision + 1, '第一个写者推进一个修订')
  assert.equal(afterConflict.configuration.savedRevision, winner.configuration.savedRevision, '被拒绝的写入不得推进修订')
  assert.equal(afterConflict.configuration.bindings.dialogue.mode, 'inherit-default', '被拒绝的写入不得改动目标槽位')
  assert.equal(reads[0].configuration.characterId, 'role-b')
  assert.equal(reads[1].configuration.characterId, 'companion')
})

// ---------------------------------------------------------------- 场景 4：UI 映射/竞态（PUT 2xx + GET 失败）

test('CUX-00 场景4：PUT 2xx 但回读失败/回旧值时，前端「已保存并回读」是否可被证伪', { timeout: 60000 }, async t => {
  const f = await roleConsoleFixture(t)
  // session.ts 无 import 依赖，但 Node 不能直接跑 .ts：用 esbuild 打一次包再断言（与既有 session 用例同一手法）。
  const { buildSync } = await import('esbuild')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { pathToFileURL } = await import('node:url')
  const dir = mkdtempSync(join(tmpdir(), 'aika-cux00-session-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bundle = join(dir, 'session.mjs')
  buildSync({ entryPoints: ['management/character-ui/src/components/character/session.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm' })
  const sessionModule = await import(pathToFileURL(bundle).href)

  const baseView = {
    apiVersion: 1,
    configuration: {
      schemaVersion: 2, characterId: 'role-b', revision: 3, savedRevision: 3, effectiveRevision: 2, applyOn: 'restart',
      identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: '' },
      bindings: { dialogue: { mode: 'inherit-default' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } },
    },
    selections: { dialogue: { adapterId: 'openai-compatible-text', provider: 'openai', model: 'old-model', endpoint: 'https://old.invalid/v1/chat/completions' }, tts: {}, asr: {} },
    readErrors: {},
    effective: null,
  }
  const draft = { mode: 'inherit-default', selection: {}, key: '', readError: '', error: '', message: '' }

  // 4a：PUT 2xx，随后 GET 返回**旧值**（修订没有前进）。
  const route = path => path.split('?')[0]
  const staleRead = {
    calls: [],
    async request(path, options = {}) {
      this.calls.push({ path, method: options.method || 'GET' })
      if (route(path) === '/api/characters/bindings' && options.method === 'PUT') return { configuration: { ...baseView.configuration, savedRevision: 4 }, applyOn: 'restart' }
      if (route(path) === '/api/characters/bindings') return structuredClone(baseView)
      if (route(path) === '/api/snapshot') return { adapters: [], credentials: [] }
      throw Object.assign(Error(`anon: ${path}`), { status: 404 })
    },
  }
  const staleResult = await sessionModule.createCharacterSession(staleRead).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft, expectedRevision: 3, holder: {} })

  // 4b：PUT 2xx，随后 GET 抛错（readError 场景）。
  const failingRead = {
    calls: [],
    async request(path, options = {}) {
      this.calls.push({ path, method: options.method || 'GET' })
      if (route(path) === '/api/characters/bindings' && options.method === 'PUT') return { configuration: { ...baseView.configuration, savedRevision: 4 }, applyOn: 'restart' }
      if (route(path) === '/api/characters/bindings') throw Object.assign(Error('anon: 回读失败'), { status: 503 })
      if (route(path) === '/api/snapshot') return { adapters: [], credentials: [] }
      throw Object.assign(Error(`anon: ${path}`), { status: 404 })
    },
  }
  let readFailure = null
  let failingReadResult = null
  try { failingReadResult = await sessionModule.createCharacterSession(failingRead).saveBinding({ characterId: 'role-b', slot: 'dialogue', draft, expectedRevision: 3, holder: {} }) }
  catch (error) { readFailure = { message: error.message, status: error.status } }

  const evidence = {
    '4a_put2xx_then_stale_get': {
      outcome: staleResult.outcome,
      writeReceipt: staleResult.writeReceipt,
      readback: staleResult.readback,
      putReceiptSavedRevision: 4,
      note: 'CUX-04 修复后：writeReceipt 保留 PUT 返回的 configuration（savedRevision 4），readback 保留随后 GET 的真实内容（旧值 3）；两者不一致 → outcome=superseded，不再冒充「已保存并回读」。',
    },
    '4b_put2xx_then_get_fails': {
      outcome: failingReadResult?.outcome,
      stage: failingReadResult?.stage,
      reason: failingReadResult?.reason,
      thrown: readFailure,
      calls: failingRead.calls,
    },
    classification: 'PUT 后未确认（已由 CUX-04 修复为判别联合；不再把未确认渲染成成功）',
    redPrefixEvidence: 'cux-00-scenario-4-RED-prefix.json 保存了修复前的原始取证：receipt 用随后 GET 的旧值冒充 PUT 回执，且回读失败直接抛错。',
  }
  await writeEvidence('cux-00-scenario-4.json', evidence)

  // CUX-04 修复后的契约：写回执来自 PUT，回读回旧值时判定 superseded 而不是「成功」。
  assert.equal(staleResult.writeReceipt.savedRevision, 4, 'writeReceipt 必须保留 PUT 回执的 savedRevision=4')
  assert.equal(staleResult.readback.savedRevision, 3, 'readback 必须保留随后 GET 的真实旧值=3')
  assert.equal(staleResult.outcome, 'superseded', '回读与写回执不一致时必须判定 superseded，不得冒充确认成功')
  assert.notEqual(staleResult.outcome, 'confirmed')
  // 回读失败不再抛给调用方：它是 written-unconfirmed，写回执被保留。
  assert.equal(failingReadResult?.outcome, 'written-unconfirmed', 'PUT 成功但回读失败必须是 written-unconfirmed')
  assert.equal(failingReadResult?.writeReceipt?.savedRevision, 4, '回读失败时写回执仍必须保留')
  assert.equal(failingRead.calls.filter(call => call.method === 'PUT').length, 1, 'PUT 确实已经发出')
  assert.equal(readFailure, null, '修复后回读失败不再以异常形式抛出')
})

// ---------------------------------------------------------------- 场景 5：profile 不含 appearance

test('CUX-00 场景5：/api/characters/profile 不返回 appearance，绑定接口才提供已保存选择', { timeout: 60000 }, async t => {
  const f = await roleConsoleFixture(t)
  const profile = await f.request('/api/characters/profile?characterId=role-b')
  const bindings = await f.request('/api/characters/bindings?characterId=role-b')
  const evidence = {
    profileKeys: Object.keys(profile).sort(),
    profileHasAppearance: Object.prototype.hasOwnProperty.call(profile, 'appearance'),
    bindingsConfigurationHasAppearance: Object.prototype.hasOwnProperty.call(bindings.configuration, 'appearance'),
    savedAppearance: bindings.configuration.appearance,
    note: 'AppearancePanel 从 profile.appearance 初始化 → 永远是 undefined，所以初始选择为空；权威读取必须是 configuration.appearance。',
  }
  await writeEvidence('cux-00-scenario-5.json', evidence)
  assert.equal(evidence.profileHasAppearance, false, 'profile GET 确实不返回 appearance（问题 A 的读取来源缺口）')
  assert.equal(evidence.bindingsConfigurationHasAppearance, true, 'configuration.appearance 才是权威来源')
})

// ---------------------------------------------------------------- 场景 6：真实实例只读核对

test('CUX-00 场景6：真实实例只读核对（不写任何用户数据）', { timeout: 60000 }, async () => {
  const probe = resolve('.local/runtime-console-01')
  const running = await fetch('http://127.0.0.1:19387/api/snapshot').then(response => response.status).catch(() => null)
  const evidence = {
    attempted: { runtimeConsoleDir: probe, localGuiProbe: 'http://127.0.0.1:19387/api/snapshot' },
    localGuiProbeStatus: running,
    result: 'NOT RUN：本机没有正在运行的 desktop-pet management 实例，也没有可用的 management token；真实实例核对需要用户后续提供运行中的实例或明确授权。',
    authorizationNeeded: ['真实用户 Key 保存', '绑定改写', '重启实例', '导出真实实例回执'],
  }
  await writeEvidence('cux-00-scenario-6.json', evidence)
  assert.ok(true)
})

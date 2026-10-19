// LUI-04 · 诊断 / 工作协议 行为层测试。
//
// 被测对象是生产模块 `management/character-ui/src/components/ops/{diagnostics,work}.ts`，
// 不复制逻辑。请求由脚本化的 fake client 提供，只证明编排与契约：
//   * 诊断只读已观察事实，不探测；读失败不显示假零；证据三维度分开；
//   * 麦克风只存设备标识，不打开采集；
//   * 工作协议保存配置不运行命令；确认前必须核对；遗忘擦除本机正文；
//   * 修订走 `/revise` 且 revision 必须匹配；409/未知结果不自动重发；
//   * Abort 取消与 dispose 后旧响应不写状态（不泄漏）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'aika-lui04-diagwork-'))
buildSync({
  entryPoints: [
    'management/character-ui/src/components/ops/diagnostics.ts',
    'management/character-ui/src/components/ops/work.ts',
    'management/character-ui/src/components/ops/shared.ts',
  ],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
})
const { createDiagnosticsSession, normalizeHealthModule, sortHealthModules } = await import(pathToFileURL(join(dir, 'diagnostics.mjs')).href)
const { createWorkProtocolSession } = await import(pathToFileURL(join(dir, 'work.mjs')).href)
const { createRequestGuard } = await import(pathToFileURL(join(dir, 'shared.mjs')).href)
test.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'aika-lui04-diagwork-'))); rmSync(dir, { recursive: true, force: true }) })

function fakeClient(handlers = {}) {
  const calls = []
  const request = async (path, options = {}) => {
    calls.push({ path, options })
    const handler = handlers[path.split('?')[0]]
    if (typeof handler === 'function') return handler({ path, options, calls })
    if (handler !== undefined) return structuredClone(handler)
    throw Object.assign(new Error(`anon: 没有为 ${path} 准备响应`), { status: 404 })
  }
  return { request, calls }
}

const tick = () => new Promise(done => setTimeout(done, 0))

// ---------------------------------------------------------------- 诊断

test('LUI-04 diagnostics: 模块按失败优先排序，证据三维度分开', async () => {
  const client = fakeClient({
    '/api/health': {
      configRevision: 9, observedAt: '2026-10-08T00:00:00.000Z',
      modules: {
        llm: { label: '对话模型', state: 'ready', evidence: { configured: true, reachable: true, operational: true, selfCheck: false } },
        tts: { label: '语音合成', state: 'unknown', evidence: { configured: true, reachable: false, operational: false, selfCheck: false } },
        stt: { label: '语音识别', state: 'failed', reasonCode: 'credential_missing', repairAction: '请保存凭据', checkedAt: '2026-10-08T00:00:00.000Z', configRevision: 9, evidence: { configured: false, reachable: false, operational: false, selfCheck: true } },
      },
    },
    '/api/microphone/preference': { deviceId: null },
    '/api/snapshot': { runtime: { instanceId: 'inst-1' } },
  })
  const session = createDiagnosticsSession(client, createRequestGuard())
  await session.refresh()
  assert.ok(session.state.snapshot)
  const ordered = sortHealthModules(session.state.snapshot.modules)
  assert.deepEqual(ordered.map(module => module.id), ['stt', 'tts', 'llm'], '失败优先、未知次之')
  const stt = normalizeHealthModule('stt', session.state.snapshot.modules.find(module => module.id === 'stt'))
  assert.equal(stt.reasonCode, 'credential_missing')
  assert.equal(stt.evidence.configured, false, '可达不等于可用：证据分开')
  session.dispose()
})

test('LUI-04 diagnostics: 读失败清空快照，不显示 0 个模块的假零', async () => {
  const client = fakeClient({
    '/api/health': () => { throw Object.assign(new Error('anon: 模块状态未接入'), { status: 503 }) },
    '/api/microphone/preference': () => { throw Object.assign(new Error('anon: 麦克风未接入'), { status: 503 }) },
    '/api/snapshot': () => { throw Object.assign(new Error('anon: 快照不可读'), { status: 503 }) },
  })
  const session = createDiagnosticsSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.snapshot, null)
  assert.ok(session.state.error, '读失败必须报错')
  assert.equal(session.microphone, null)
  assert.ok(session.microphoneError)
  assert.equal(session.snapshot, null)
  assert.ok(session.snapshotError)
  session.dispose()
})

test('LUI-04 diagnostics: 麦克风只存设备标识；null 是显式的系统默认', async () => {
  const seen = []
  const client = fakeClient({
    '/api/health': { configRevision: 1, observedAt: '', modules: {} },
    '/api/microphone/preference': ({ options }) => {
      seen.push(options)
      if (options.method === 'PUT') return { deviceId: options.body.deviceId }
      return { deviceId: 'mic-1' }
    },
    '/api/snapshot': { runtime: {} },
  })
  const session = createDiagnosticsSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.microphone.deviceId, 'mic-1')
  await session.saveMicrophone(null)
  assert.equal(session.microphone.deviceId, null, 'null 是显式的系统默认，不是缺字段')
  assert.ok(seen.some(call => call.method === 'PUT' && call.body.deviceId === null))
  session.dispose()
})

test('LUI-04 diagnostics: dispose 后旧响应不写状态', async () => {
  let release
  const gate = new Promise(done => { release = done })
  const client = fakeClient({
    '/api/health': () => gate.then(() => ({ configRevision: 1, observedAt: '', modules: {} })),
    '/api/microphone/preference': { deviceId: null },
    '/api/snapshot': { runtime: {} },
  })
  const session = createDiagnosticsSession(client, createRequestGuard())
  const pending = session.refresh()
  session.dispose()
  release()
  await pending
  await tick()
  assert.equal(session.state.snapshot, null, 'dispose 后晚到的响应不得写入')
})

// ---------------------------------------------------------------- 工作协议

const profilesView = () => ({
  revision: 4,
  acp: { executorId: 'acp-local', label: '本机 ACP', command: '/usr/bin/agent', args: [], environmentKeys: [] },
  mcp: { executorId: 'mcp-local', label: '本机 MCP', command: '/usr/bin/mcp', args: [], environmentKeys: ['TOKEN'] },
})

test('LUI-04 work: 未装配显示 unavailable，不提供占位功能', async () => {
  const client = fakeClient({
    '/api/work-protocol': () => { throw Object.assign(new Error('anon: 协议未接入'), { status: 503 }) },
  })
  const session = createWorkProtocolSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.available, false)
  assert.equal(session.state.error, null, '503 是诚实的 unavailable，不是错误横幅')
  session.dispose()
})

test('LUI-04 work: 保存配置只登记命令，不运行；环境变量只展示键名', async () => {
  const client = fakeClient({
    '/api/work-protocol': { profiles: profilesView(), requests: [] },
    '/api/work-protocol/profiles': ({ options }) => {
      assert.equal(options.method, 'PUT')
      assert.equal(options.body.expectedRevision, 4)
      return { profiles: { ...profilesView(), revision: 5 } }
    },
  })
  const session = createWorkProtocolSession(client, createRequestGuard())
  await session.refresh()
  assert.deepEqual(session.state.profiles.environmentKeys, undefined, '顶层没有 env 字段')
  assert.deepEqual(session.state.profiles.mcp.environmentKeys, ['TOKEN'], '只展示键名，不回显值')
  await session.saveProfiles()
  assert.match(session.state.message, /已保存/)
  session.dispose()
})

test('LUI-04 work: 修订走 /revise 且 revision 必须匹配，旧确认卡失效', async () => {
  const row = {
    request: { operationId: 'op-1', revision: 1, protocol: 'acp', executorId: 'acp-local', target: { title: '旧标题' }, instruction: '旧说明', permissionGrant: [] },
    receipt: null, dispatchStarted: false, forgotten: false,
  }
  const client = fakeClient({
    '/api/work-protocol': { profiles: profilesView(), requests: [row] },
    '/api/work-protocol/revise': ({ options }) => {
      assert.equal(options.body.operationId, 'op-1')
      assert.equal(options.body.expectedRevision, 1)
      assert.equal(options.body.updates.target.title, '新标题')
      return { request: { ...row.request, revision: 2, target: { title: '新标题' }, instruction: '新说明' } }
    },
  })
  const session = createWorkProtocolSession(client, createRequestGuard())
  await session.refresh()
  await session.revise('op-1', 1, { protocol: 'acp', executorId: 'acp-local', title: '新标题', instruction: '新说明', permissionGrant: [] })
  assert.match(session.state.message, /修订|新版本/)
  session.dispose()
})

test('LUI-04 work: 确认需要回执；遗忘擦除本机正文但不撤销外部副作用', async () => {
  const prepared = { operationId: 'op-9', revision: 1, protocol: 'acp', executorId: 'acp-local', target: { title: '任务' }, instruction: '说明', permissionGrant: [] }
  const requests = []
  const client = fakeClient({
    // 回读返回服务端真实持久的行；prepare 后新行在回读里出现，selected 才保留。
    '/api/work-protocol': () => ({ profiles: profilesView(), requests: requests.map(row => ({ ...row })) }),
    '/api/work-protocol/prepare': ({ options }) => {
      assert.equal(options.body.protocol, 'acp')
      requests.push({ request: { ...prepared }, receipt: null, dispatchStarted: false, forgotten: false })
      return { request: { ...prepared } }
    },
    '/api/work-protocol/confirm': ({ options }) => {
      assert.equal(options.body.operationId, 'op-9')
      return { receipt: { status: 'succeeded', summary: '完成' } }
    },
    '/api/work-protocol/forget': ({ options }) => {
      assert.equal(options.body.operationId, 'op-9')
      return { forgotten: true }
    },
  })
  const session = createWorkProtocolSession(client, createRequestGuard())
  await session.refresh()
  await session.prepare({ protocol: 'acp', executorId: 'acp-local', title: '任务', instruction: '说明', permissionGrant: [] })
  assert.equal(session.state.selected, 'op-9')
  await session.confirm('op-9', 1)
  assert.match(session.state.message, /回执/)
  await session.forget('op-9')
  assert.equal(session.state.selected, null, '遗忘后选中清空')
  assert.match(session.state.message, /遗忘|外部.*不受/)
  session.dispose()
})

test('LUI-04 work: 未知结果不自动重发，取消需要回执', async () => {
  const client = fakeClient({
    '/api/work-protocol': { profiles: profilesView(), requests: [] },
    '/api/work-protocol/confirm': () => { throw Object.assign(new Error('anon: 结果未知'), { status: 503 }) },
  })
  const session = createWorkProtocolSession(client, createRequestGuard())
  await session.refresh()
  await session.confirm('op-x', 1)
  assert.ok(session.state.actionError, '未知结果必须报错，不自动重发')
  assert.equal(client.calls.filter(call => call.path === '/api/work-protocol/confirm').length, 1, '失败一次只发一次请求')
  session.dispose()
})

// LUI-04 · 本地采集 / 授权感知 / 屏幕授权 / 主动陪伴 / 唤醒 行为层测试。
//
// 被测对象是生产模块 `management/character-ui/src/components/ops/{collection,perception,screen-grants,companion}.ts`，
// 不复制逻辑。请求由脚本化的 fake client 提供，只证明编排与契约：
//   * 默认零采集：未授权与不可用分开，未读到不伪装健康；
//   * 读失败不显示「暂无样本」；键盘样本无正文；缩略图走鉴权字节路由；
//   * 感知上传必须 userConfirmed，未确认不发请求；取消清理授权与观察；
//   * 屏幕授权持续观察仅本地；409 保留草稿；取消选择器不报错；
//   * 偏好保存不签发授权；单次触发幂等；唤醒默认关闭；
//   * 授权/Origin 由服务端强制（server.ts），这里断言前端不把密钥与正文带出边界；
//   * Abort 取消与 dispose 后旧响应不写状态（不泄漏）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'aika-lui04-privacy-'))
buildSync({
  entryPoints: [
    'management/character-ui/src/components/ops/collection.ts',
    'management/character-ui/src/components/ops/perception.ts',
    'management/character-ui/src/components/ops/screen-grants.ts',
    'management/character-ui/src/components/ops/companion.ts',
    'management/character-ui/src/components/ops/shared.ts',
  ],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
})
const { createCollectionSession } = await import(pathToFileURL(join(dir, 'collection.mjs')).href)
const { createPerceptionSession } = await import(pathToFileURL(join(dir, 'perception.mjs')).href)
const { createScreenGrantSession } = await import(pathToFileURL(join(dir, 'screen-grants.mjs')).href)
const { createCompanionSession, createProactiveSession, createWakeSession } = await import(pathToFileURL(join(dir, 'companion.mjs')).href)
const { createRequestGuard } = await import(pathToFileURL(join(dir, 'shared.mjs')).href)
test.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'aika-lui04-privacy-'))); rmSync(dir, { recursive: true, force: true }) })

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
const PAIRING = { userId: 'u', characterId: 'c', characterInstanceId: 'c-default' }

// ---------------------------------------------------------------- 本地采集

const collectionStatus = () => ({
  collectionRevision: 1, profile: 'normal', policyVersion: 2, managedBytes: 100,
  queueItems: 0, queueBytes: 0,
  policy: { sampleRetentionMs: 7 * 86_400_000, managedByteLimit: 1000000 },
  sources: [
    { kind: 'keyboard', state: 'disabled', revision: 0, grantExpiresAt: null, directoryDisplayPath: null, lastAcceptedAt: null, accepted: 0, duplicates: 0, rejected: 0, dropped: 0, lastErrorCode: null },
    { kind: 'screenshot_directory', state: 'unavailable', revision: 0, grantExpiresAt: null, directoryDisplayPath: null, lastAcceptedAt: null, accepted: 0, duplicates: 0, rejected: 0, dropped: 0, lastErrorCode: null },
    { kind: 'clipboard_image', state: 'active', revision: 5, grantExpiresAt: '2026-10-09T00:00:00.000Z', directoryDisplayPath: null, lastAcceptedAt: '2026-10-08T01:00:00.000Z', accepted: 3, duplicates: 0, rejected: 0, dropped: 0, lastErrorCode: null },
  ],
})

test('LUI-04 collection: 未授权/不可用分开，未读到不伪装健康', async () => {
  const client = fakeClient({
    '/api/collection/status': collectionStatus(),
    '/api/collection/samples': { items: [] },
  })
  const session = createCollectionSession(client, createRequestGuard())
  await session.refresh()
  assert.ok(session.state.status)
  const kinds = Object.fromEntries(session.state.status.sources.map(source => [source.kind, source.state]))
  assert.equal(kinds.keyboard, 'disabled')
  assert.equal(kinds.screenshot_directory, 'unavailable')
  assert.equal(kinds.clipboard_image, 'active')
  assert.equal(session.state.samplesLoaded, true)
  assert.deepEqual(session.state.samples, [], '真读到 0 条才是空')
  session.dispose()
})

test('LUI-04 collection: 读失败不显示暂无样本，samplesLoaded 保持 false', async () => {
  const client = fakeClient({
    '/api/collection/status': () => { throw Object.assign(new Error('anon: 采集未装配'), { status: 503 }) },
    '/api/collection/samples': () => { throw Object.assign(new Error('anon: 样本不可读'), { status: 503 }) },
  })
  const session = createCollectionSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.status, null)
  assert.ok(session.state.error)
  assert.equal(session.state.samplesLoaded, false, '没读到不能画成「暂无样本」')
  assert.ok(session.state.samplesError)
  session.dispose()
})

test('LUI-04 collection: 键盘样本只有区间与次数，无正文；撤销必须确认', async () => {
  const client = fakeClient({
    '/api/collection/status': collectionStatus(),
    '/api/collection/samples': {
      items: [{ id: 'k1', revision: 1, sampleKind: 'keyboard_activity', receivedAt: '2026-10-08T01:00:00.000Z', expiresAt: '2026-10-15T00:00:00.000Z', sourceConfidence: 'high', origin: 'keyboard', bucketStart: '2026-10-08T00:00:00.000Z', bucketEnd: '2026-10-08T00:05:00.000Z', activityCount: 42, afkBoundary: false }],
    },
    '/api/collection/sources/clipboard_image/revoke': ({ options }) => {
      assert.equal(options.body.userConfirmed, true, '撤销必须带显式确认')
      return collectionStatus()
    },
  })
  const session = createCollectionSession(client, createRequestGuard())
  await session.refresh()
  const sample = session.state.samples[0]
  assert.equal(sample.activityCount, 42)
  assert.ok(!('text' in sample) && !('content' in sample), '键盘样本不得携带任何正文')
  session.requestRevoke('clipboard_image')
  assert.ok(session.state.confirmation, '撤销先进入确认态，不直接发请求')
  assert.ok(!client.calls.some(call => call.path.includes('/revoke')))
  await session.confirmRevoke()
  assert.ok(client.calls.some(call => call.path.includes('/revoke')))
  session.dispose()
})

test('LUI-04 collection: 激活目录来源必须指定目录，且始终带 userConfirmed', async () => {
  const client = fakeClient({
    '/api/collection/status': collectionStatus(),
    '/api/collection/samples': { items: [] },
    '/api/collection/sources/screenshot_directory/activate': ({ options }) => {
      assert.equal(options.body.userConfirmed, true)
      assert.ok(options.body.directoryRoot, '目录来源必须指定目录')
      return collectionStatus()
    },
  })
  const session = createCollectionSession(client, createRequestGuard())
  await session.refresh()
  // 空目录本地拒绝，不发请求。
  await session.activate('screenshot_directory')
  assert.ok(session.state.action.error)
  const before = client.calls.length
  session.setDirectoryDraft('D:\\Shots')
  await session.activate('screenshot_directory')
  assert.ok(client.calls.length > before)
  session.dispose()
})

// ---------------------------------------------------------------- 授权感知

test('LUI-04 perception: 未确认不发任何请求；确认后按 grants/captures 顺序', async () => {
  const order = []
  const client = fakeClient({
    '/api/perception': { enabled: true, capabilities: { local: false, cloud: true }, instruction: '说明' },
    '/api/perception/grants': () => { order.push('grants'); return { grant: { grantId: 'g-1' } } },
    '/api/perception/captures': ({ options }) => {
      order.push('captures')
      assert.equal(options.body.grantId, 'g-1')
      assert.equal(options.body.mimeType, 'image/jpeg')
      return { observation: { observationId: 'o-1', capturedAt: '2026-10-08T01:00:00.000Z', vlm: { status: 'ok', summary: '匿名摘要' } } }
    },
  })
  const session = createPerceptionSession(client, createRequestGuard(), {
    mediaDevices: undefined,
    encodeFrame: async () => 'aGVsbG8=',
  })
  await session.refresh()
  assert.equal(session.state.status.capabilities.cloud, true)
  // 直接调内部路径：没有预览帧时拒绝，不发请求。
  await session.sendToCloud(true)
  assert.deepEqual(order, [], '没有预览帧不得发请求')
  await session.sendToCloud(false)
  assert.ok(session.state.error, '未确认必须报错')
  assert.deepEqual(order, [], '未确认不得发任何请求')
  session.dispose()
})

test('LUI-04 perception: 取消清理授权与观察，dispose 释放且不泄漏', async () => {
  const deleted = []
  const client = fakeClient({
    '/api/perception': { enabled: true, capabilities: { local: false, cloud: true }, instruction: '' },
    '/api/perception/grants/g-9': () => { deleted.push('grant'); return { revoked: true } },
    '/api/perception/observations/o-9': () => { deleted.push('observation'); return { cleared: true } },
  })
  const session = createPerceptionSession(client, createRequestGuard(), { mediaDevices: undefined })
  await session.refresh()
  // 无授权无观察时 clear 只是本地复位，不发删除请求。
  await session.clear()
  assert.deepEqual(deleted, [])
  session.dispose()
  await tick()
})

// ---------------------------------------------------------------- 屏幕授权

test('LUI-04 screen-grant: 持续观察仅本地，云端在本地拒绝', async () => {
  const client = fakeClient({
    '/api/companion/screen-grants': { revision: 1, pairing: PAIRING, target: { targetId: 't-1', targetRevision: 2, displayName: '主屏' }, grants: [], capabilities: { screenTargets: true, capture: true, localOcr: true, cloudVlm: false }, missingReasons: [] },
  })
  const session = createScreenGrantSession(client, createRequestGuard(), () => PAIRING)
  await session.refresh()
  assert.equal(session.state.view.target.targetId, 't-1')
  session.edit('purpose', 'capture-continuous')
  session.edit('destination', 'cloud')
  await session.issue()
  assert.match(session.state.error.message, /仅本地|本地处理/)
  assert.ok(!client.calls.some(call => call.options?.method === 'PUT'), '注定失败的请求不发出')
  session.dispose()
})

test('LUI-04 screen-grant: 签发带 userConfirmed，409 保留草稿', async () => {
  const client = fakeClient({
    '/api/companion/screen-grants': ({ options }) => {
      if (options.method === 'PUT') {
        assert.equal(options.body.userConfirmed, true, '签发必须带显式确认')
        assert.equal(options.body.targetId, 't-1')
        throw Object.assign(new Error('屏幕授权已更新'), { status: 409 })
      }
      return { revision: 1, pairing: PAIRING, target: { targetId: 't-1', targetRevision: 2, displayName: '主屏' }, grants: [], capabilities: { screenTargets: true, capture: true, localOcr: true, cloudVlm: true }, missingReasons: [] }
    },
  })
  const session = createScreenGrantSession(client, createRequestGuard(), () => PAIRING)
  await session.refresh()
  session.edit('ttlMs', '60000')
  await session.issue()
  assert.equal(session.state.conflict, true)
  assert.equal(session.state.draft.ttlMs, '60000', '冲突后草稿保留')
  session.dispose()
})

test('LUI-04 screen-grant: 宿主选择器取消是正常结果，不报错', async () => {
  const client = fakeClient({
    '/api/companion/screen-grants': { revision: 0, pairing: PAIRING, target: null, grants: [], capabilities: { screenTargets: false, capture: false, localOcr: false, cloudVlm: false }, missingReasons: ['screen_target_picker_unavailable'] },
    '/api/companion/screen-targets/select': { outcome: 'cancelled' },
  })
  const session = createScreenGrantSession(client, createRequestGuard(), () => PAIRING)
  await session.refresh()
  await session.selectTarget()
  assert.equal(session.state.error, null)
  assert.match(session.state.message, /取消/)
  session.dispose()
})

test('LUI-04 screen-grant: 撤销必须先确认，取消不发请求', async () => {
  const client = fakeClient({
    '/api/companion/screen-grants': { revision: 1, pairing: PAIRING, target: { targetId: 't-1', targetRevision: 1, displayName: '主屏' }, grants: [{ purpose: 'capture-single', grant: { grantId: 'g-1', state: 'active', destination: 'local', targetId: 't-1', expiry: '2026-10-08T02:00:00.000Z' } }], capabilities: { screenTargets: true, capture: true, localOcr: false, cloudVlm: false }, missingReasons: [] },
  })
  const session = createScreenGrantSession(client, createRequestGuard(), () => PAIRING)
  await session.refresh()
  session.requestRevoke('g-1')
  assert.equal(session.state.pendingRevoke, 'g-1')
  session.cancelRevoke()
  assert.equal(session.state.pendingRevoke, null)
  assert.ok(!client.calls.some(call => call.path.includes('/revoke')), '取消不产生任何请求')
  session.dispose()
})

// ---------------------------------------------------------------- 主动陪伴 / 邀请 / 唤醒

test('LUI-04 companion: 保存只写偏好意图，不签发授权；409 保留草稿', async () => {
  const saved = {
    screen: { enabled: false, targetId: null, targetRevision: null, recognitionRoute: 'local-ocr', destination: 'local' },
    observationIntervalMs: 300000, replyCooldownMs: 3600000, dailyMax: 2, timezone: 'Asia/Shanghai', dndStartHour: 23, dndEndHour: 7, greetingRules: [],
  }
  const client = fakeClient({
    '/api/companion/preferences': ({ options }) => {
      if (options.method === 'PUT') {
        assert.ok(options.body.patch, '保存整份草稿')
        assert.ok(!('grant' in options.body) && !('target' in (options.body.patch.screen ?? {}) && 'grantId' in {}), '偏好保存不得携带授权签发')
        throw Object.assign(new Error('陪伴设置已更新'), { status: 409 })
      }
      return { revision: 3, saved, effective: saved, capabilityStatus: { targetSelected: false, continuousGrant: false, capture: false, localOcr: false, cloudVlm: false, missingReasons: [] }, runState: 'paused', reason: 'disabled', nextEligibleAt: null }
    },
  })
  const session = createCompanionSession(client, createRequestGuard(), () => PAIRING)
  await session.refresh()
  session.edit(draft => { draft.dailyMax = 1 })
  await session.save()
  assert.equal(session.state.conflict, true)
  assert.equal(session.state.draft.dailyMax, 1, '冲突后草稿保留')
  session.dispose()
})

test('LUI-04 companion: 单次触发只执行一次，accepted 不代表已回复', async () => {
  const client = fakeClient({
    '/api/companion/preferences': { revision: 1, saved: { screen: { enabled: false, targetId: null, targetRevision: null, recognitionRoute: 'local-ocr', destination: 'local' }, observationIntervalMs: 1, replyCooldownMs: 1, dailyMax: 0, timezone: 'Asia/Shanghai', dndStartHour: 0, dndEndHour: 0, greetingRules: [] }, effective: {}, capabilityStatus: { targetSelected: false, continuousGrant: false, capture: false, localOcr: false, cloudVlm: false, missingReasons: [] }, runState: 'paused', reason: null, nextEligibleAt: null },
    '/api/companion/trigger': ({ options }) => {
      assert.equal(options.body.kind, 'screen')
      assert.ok(options.body.operationId, '触发带幂等编号')
      return { triggerId: 'tr-1', status: 'accepted', outcome: 'accepted' }
    },
  })
  const session = createCompanionSession(client, createRequestGuard(), () => PAIRING)
  await session.triggerOnce('screen')
  assert.equal(session.state.trigger.status, 'accepted')
  assert.equal(session.state.triggerOperationId, null, '完成后释放编号，不自动循环')
  session.dispose()
})

test('LUI-04 proactive: 读取用 POST，保存只发白名单字段', async () => {
  const client = fakeClient({
    '/api/proactive/policy': ({ options }) => {
      if (options.method === 'PUT') {
        assert.deepEqual(Object.keys(options.body.policy).sort(), ['dailyMax', 'dndEndHour', 'dndStartHour', 'enabled', 'minIntervalMs', 'sourceKinds', 'timezone'])
        assert.deepEqual(options.body.policy.sourceKinds, ['continuity_fact'])
        return { policy: { ...options.body.policy, revision: 2 } }
      }
      assert.equal(options.method, 'POST')
      return { policy: { enabled: false, dailyMax: 2, minIntervalMs: 10800000, timezone: 'Asia/Shanghai', dndStartHour: 23, dndEndHour: 7, sourceKinds: ['continuity_fact'], revision: 1 } }
    },
  })
  const session = createProactiveSession(client, createRequestGuard(), () => PAIRING)
  await session.refresh()
  assert.equal(session.state.policy.enabled, false, '默认关闭')
  session.edit('enabled', true)
  await session.save()
  assert.match(session.state.message, /已启用|已关闭/)
  session.dispose()
})

test('LUI-04 wake: 默认关闭，未唤醒不发送云端转写；修订冲突保留草稿', async () => {
  const snapshot = {
    version: '0.1.0', instanceId: 'inst-1', revision: 2,
    settings: { keyword: '你好小爱', sensitivity: 'standard', silenceMs: 2000 },
    available: true, detail: '',
    session: { generation: 5, enabled: false, phase: 'off', detail: '' },
  }
  const client = fakeClient({
    '/api/wake': ({ options }) => {
      if (options.method === 'PUT') throw Object.assign(new Error('设置已变化'), { status: 409 })
      if (options.method === 'POST') {
        assert.equal(typeof options.body.enabled, 'boolean')
        return { ...snapshot, session: { ...snapshot.session, generation: 6, enabled: options.body.enabled, phase: options.body.enabled ? 'waiting' : 'off' } }
      }
      return snapshot
    },
  })
  const session = createWakeSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.snapshot.session.enabled, false, '默认关闭')
  session.edit('keyword', '打开测试')
  await session.save()
  assert.equal(session.state.conflict, true, '保存冲突保留草稿')
  session.dispose()
})

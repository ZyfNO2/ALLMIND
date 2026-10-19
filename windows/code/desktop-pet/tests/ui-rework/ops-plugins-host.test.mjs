// LUI-04 · 插件 / 宿主偏好 / 余额凭据 行为层测试。
//
// 被测对象是生产模块 `management/character-ui/src/components/ops/{plugins,host,integrations}.ts`，
// 不复制逻辑。请求由脚本化的 fake client 提供，只证明编排与契约：
//   * 读失败**不能**被渲染成空列表或假零；
//   * ready/enabled/loaded/active 四态分开，缺失 ready 是未知不是 false；
//   * 卸载必须先确认且对象一致；导入失败保留草稿；
//   * 宿主 409 保留草稿；宿主缺席显示 unavailable；
//   * 凭据保存后由后端回执更新，密钥不回显；
//   * Abort 取消不写状态；取消与 teardown（dispose）后旧响应失效。

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'aika-lui04-plugins-'))
buildSync({
  entryPoints: [
    'management/character-ui/src/components/ops/plugins.ts',
    'management/character-ui/src/components/ops/host.ts',
    'management/character-ui/src/components/ops/integrations.ts',
    'management/character-ui/src/components/ops/shared.ts',
  ],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
})
const { createPluginsSession, packageStatusLabel } = await import(pathToFileURL(join(dir, 'plugins.mjs')).href)
const { createDesktopHostSession, hotkeyLabel, hotkeyScopeNote } = await import(pathToFileURL(join(dir, 'host.mjs')).href)
const { createBalancesSession, createWeChatSession } = await import(pathToFileURL(join(dir, 'integrations.mjs')).href)
const { createRequestGuard } = await import(pathToFileURL(join(dir, 'shared.mjs')).href)
test.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'aika-lui04-plugins-'))); rmSync(dir, { recursive: true, force: true }) })

/** 按路径脚本化的管理客户端；未脚本化的路径直接失败，避免测试静默走空实现。 */
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

// ---------------------------------------------------------------- 插件

test('LUI-04 plugins: 真实列表回读，四态分开，缺失 ready 是未知', async () => {
  const client = fakeClient({
    '/api/next65/packages': [
      { packageId: 'pkg-a', enabled: true, ready: true, loaded: true, active: false, manifestLabels: ['问候'], installed: [{ version: '1.0.0' }] },
      { packageId: 'pkg-b', enabled: true, manifestLabels: [], installed: [{ version: '0.1.0' }] },
    ],
    '/api/next65/truth': { hostAvailable: true, flowAvailable: false, installedCount: 2, loadedPackages: ['pkg-a'], activePackages: [], registeredCapabilities: [] },
    '/api/next65/profiles': { profiles: [], active: null },
  })
  const session = createPluginsSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.loaded, true)
  assert.equal(session.state.packages.length, 2)
  const [a, b] = session.state.packages
  assert.equal(a.ready, true)
  assert.equal(b.ready, null, '缺失 ready 必须是未知，不能伪装成 false')
  assert.equal(packageStatusLabel(a).label, '已就绪')
  assert.equal(packageStatusLabel(b).label, '已启用 · 就绪未知')
  assert.equal(session.state.truth.hostAvailable, true)
  session.dispose()
})

test('LUI-04 plugins: 读失败不显示空列表，loaded 保持 false', async () => {
  const client = fakeClient({
    '/api/next65/packages': () => { throw Object.assign(new Error('anon: 包管理未接入'), { status: 503 }) },
    '/api/next65/truth': () => { throw Object.assign(new Error('anon: 运行时未接入'), { status: 503 }) },
    '/api/next65/profiles': { profiles: [], active: null },
  })
  const session = createPluginsSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.loaded, false)
  assert.deepEqual(session.state.packages, [])
  assert.ok(session.state.error, '读失败必须有错误，不能画成「暂无插件」')
  session.dispose()
})

test('LUI-04 plugins: 包列表成功但真值失败时，真值错误单独展示', async () => {
  const client = fakeClient({
    '/api/next65/packages': [],
    '/api/next65/truth': () => { throw Object.assign(new Error('anon: 运行时未接入'), { status: 503 }) },
    '/api/next65/profiles': { profiles: [], active: null },
  })
  const session = createPluginsSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.loaded, true, '包列表真读到 0 条')
  assert.deepEqual(session.state.packages, [])
  assert.ok(session.state.truthError, '真值读失败同样必须报错，不能当成无能力')
  session.dispose()
})

test('LUI-04 plugins: 卸载必须先确认且对象一致，确认后回读', async () => {
  let list = [{ packageId: 'pkg-a', enabled: false, ready: false, loaded: false, active: false, manifestLabels: [], installed: [{ version: '1.0.0' }] }]
  const client = fakeClient({
    '/api/next65/packages': () => list,
    '/api/next65/truth': { hostAvailable: false, flowAvailable: false, installedCount: 1, loadedPackages: [], activePackages: [], registeredCapabilities: [] },
    '/api/next65/profiles': { profiles: [], active: null },
    '/api/next65/packages/pkg-a/uninstall': () => { list = []; return { uninstalled: true, packageId: 'pkg-a' } },
  })
  const session = createPluginsSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.packages.length, 1)
  // 未确认时提交是空操作，不发请求。
  await session.confirmUninstall()
  assert.ok(!client.calls.some(call => call.path.includes('/uninstall')))
  session.requestUninstall('pkg-a')
  assert.equal(session.state.pendingUninstall, 'pkg-a')
  session.cancelUninstall()
  assert.equal(session.state.pendingUninstall, null)
  assert.ok(!client.calls.some(call => call.path.includes('/uninstall')), '取消不产生任何请求')
  session.requestUninstall('pkg-a')
  await session.confirmUninstall()
  assert.equal(session.state.packages.length, 0, '卸载后回读真实列表')
  session.dispose()
})

test('LUI-04 plugins: 导入失败保留草稿，成功才清空', async () => {
  const client = fakeClient({
    '/api/next65/packages': [],
    '/api/next65/truth': { hostAvailable: false, flowAvailable: false, installedCount: 0, loadedPackages: [], activePackages: [], registeredCapabilities: [] },
    '/api/next65/profiles': { profiles: [], active: null },
    '/api/next65/packages/import': ({ options }) => {
      assert.equal(options.body.sourceRoot, 'D:\\pkgs\\demo')
      throw Object.assign(new Error('anon: 包校验失败'), { status: 400 })
    },
  })
  const session = createPluginsSession(client, createRequestGuard())
  session.setImportRoot('D:\\pkgs\\demo')
  await session.importPackage()
  assert.ok(session.state.action.error, '导入失败必须报错')
  assert.equal(session.state.importRoot, 'D:\\pkgs\\demo', '失败时草稿保留')
  session.dispose()
})

test('LUI-04 plugins: 取消后旧响应不写状态（teardown 不泄漏）', async () => {
  let release
  const gate = new Promise(done => { release = done })
  const client = fakeClient({
    '/api/next65/packages': () => gate.then(() => [{ packageId: 'late', enabled: false, ready: null, loaded: false, active: false, manifestLabels: [], installed: [] }]),
    '/api/next65/truth': { hostAvailable: false, flowAvailable: false, installedCount: 0, loadedPackages: [], activePackages: [], registeredCapabilities: [] },
    '/api/next65/profiles': { profiles: [], active: null },
  })
  const guard = createRequestGuard()
  const session = createPluginsSession(client, guard)
  const pending = session.refresh()
  session.dispose()
  release()
  await pending
  await tick()
  assert.equal(session.state.loaded, false, 'dispose 后晚到的响应不得写入')
})

// ---------------------------------------------------------------- 宿主偏好

test('LUI-04 host: 真实偏好回读，window-only 必须说清不是系统级热键', async () => {
  const client = fakeClient({
    '/api/desktop/preferences': { revision: 3, hotkey: 'Space', replySound: true, display: { mode: 'full', preferredWidth: 320, modelWidth: 300, modelHeight: 400, drawerHeight: 120 }, capabilities: { hotkey: 'window-only', filePicker: true, display: true, preferences: true } },
  })
  const session = createDesktopHostSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.preferences.revision, 3)
  assert.equal(hotkeyLabel(session.state.preferences.hotkey), '空格')
  assert.match(hotkeyScopeNote(session.state.preferences.capabilities), /仅在桌宠窗口获得焦点时生效/)
  session.dispose()
})

test('LUI-04 host: 409 保留草稿并提示刷新，不静默覆盖', async () => {
  const client = fakeClient({
    '/api/desktop/preferences': ({ options }) => {
      if (options.method === 'PUT') throw Object.assign(new Error('设置已在别处更新'), { status: 409 })
      return { revision: 3, hotkey: 'Space', replySound: true, display: null, capabilities: { hotkey: 'window-only', filePicker: false, display: false, preferences: true } }
    },
  })
  const session = createDesktopHostSession(client, createRequestGuard())
  await session.refresh()
  session.edit('replySound', false)
  await session.setReplySound(false)
  assert.equal(session.state.conflict, true)
  assert.equal(session.state.dirty, true, '冲突后草稿保留')
  assert.match(session.state.error.message, /刷新/)
  session.dispose()
})

test('LUI-04 host: 宿主缺席显示 unavailable，不显示已保存', async () => {
  const client = fakeClient({
    '/api/desktop/preferences': () => { throw Object.assign(new Error('anon: 宿主缺席'), { status: 503 }) },
  })
  const session = createDesktopHostSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.preferences, null)
  assert.equal(session.state.error.code, 'unavailable')
  session.dispose()
})

// ---------------------------------------------------------------- 余额与凭据

test('LUI-04 balances: 未读到时 loaded=false，不显示假零', async () => {
  const client = fakeClient({
    '/api/balances': () => { throw Object.assign(new Error('anon: 余额服务暂不可用'), { status: 503 }) },
  })
  const session = createBalancesSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.loaded, false)
  assert.ok(session.state.error)
  session.dispose()
})

test('LUI-04 balances: 真实快照回读，刷新只读余额', async () => {
  const client = fakeClient({
    '/api/balances': { providers: [{ provider: 'aliyun', status: 'ready', configured: true, credentialRevision: 2, updatedAt: '2026-10-08T00:00:00.000Z', stale: false, rows: [{ currency: 'CNY', amount: '12.34' }], message: null }] },
    '/api/balances/refresh': ({ options }) => {
      assert.deepEqual(options.body, { provider: 'aliyun' })
      return { providers: [{ provider: 'aliyun', status: 'ready', configured: true, credentialRevision: 2, updatedAt: '2026-10-08T00:01:00.000Z', stale: false, rows: [{ currency: 'CNY', amount: '12.34' }], message: null }] }
    },
  })
  const session = createBalancesSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.loaded, true)
  assert.equal(session.state.providers[0].rows[0].amount, '12.34')
  await session.refreshProvider('aliyun')
  assert.equal(session.state.providers[0].updatedAt, '2026-10-08T00:01:00.000Z')
  session.dispose()
})

test('LUI-04 balances: 凭据保存带 expectedRevision，密钥不回显', async () => {
  const client = fakeClient({
    '/api/balances': { providers: [{ provider: 'aliyun', status: 'unconfigured', configured: false, credentialRevision: 4, updatedAt: null, stale: false, rows: [], message: null }] },
    '/api/balances/aliyun-credentials': ({ options }) => {
      assert.equal(options.body.expectedRevision, 4)
      assert.equal(typeof options.body.accessKeyId, 'string')
      assert.equal(typeof options.body.accessKeySecret, 'string')
      return { providers: [{ provider: 'aliyun', status: 'ready', configured: true, credentialRevision: 5, updatedAt: '2026-10-08T00:00:00.000Z', stale: false, rows: [], message: null }] }
    },
  })
  const session = createBalancesSession(client, createRequestGuard())
  await session.refresh()
  await session.saveCredentials('AKID-TEST', 'SECRET-TEST')
  assert.equal(session.state.credentials.editing, false, '保存后编辑态关闭，调用方清空输入框')
  assert.equal(session.state.providers[0].credentialRevision, 5)
  // 回执里没有密钥字段：凭据只以引用形式出现。
  assert.ok(!JSON.stringify(session.state.providers[0]).includes('SECRET-TEST'))
  session.dispose()
})

// ---------------------------------------------------------------- 微信

test('LUI-04 wechat: accepted 不等于已送达，verified 后清空验证码', async () => {
  const client = fakeClient({
    '/api/wechat': ({ options }) => {
      if (options.method === 'POST' && options.body.action === 'verify') {
        assert.equal(options.body.code, '123456')
        return { replyMode: 'follow_input', revision: 2, status: 'connected', enabled: true, detail: '', boundUser: { userId: 'u', botId: 'b' }, qr: null, lastInputAt: null, lastOutputAt: null, lastDelivery: 'accepted' }
      }
      return { replyMode: 'follow_input', revision: 1, status: 'need_verification', enabled: false, detail: '', boundUser: null, qr: null, lastInputAt: null, lastOutputAt: null, lastDelivery: 'none' }
    },
  })
  const session = createWeChatSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.view.status, 'need_verification')
  session.setVerificationCode('123456')
  await session.verify()
  assert.equal(session.state.view.lastDelivery, 'accepted')
  assert.equal(session.state.verificationCode, '', '验证码用后即清，不留在状态里')
  session.dispose()
})

test('LUI-04 wechat: 读失败不显示假连接', async () => {
  const client = fakeClient({
    '/api/wechat': () => { throw Object.assign(new Error('anon: 微信未接入'), { status: 503 }) },
  })
  const session = createWeChatSession(client, createRequestGuard())
  await session.refresh()
  assert.equal(session.state.view, null)
  assert.ok(session.state.error)
  session.dispose()
})

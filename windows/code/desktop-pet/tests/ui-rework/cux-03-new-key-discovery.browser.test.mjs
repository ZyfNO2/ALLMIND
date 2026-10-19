/**
 * CUX-03: 新 Key 保存后发现模型（真实浏览器 + 真实生产 HTTP）。
 *
 *   * 03-1 填新 Key 可发现，严格 credentials → discover 顺序；
 *   * 03-2 新 Key 优先；已有引用直接发现；none 分支和空输入正确；
 *   * 03-3 凭据成功、发现失败后重试不重复创建，不写绑定；
 *   * 03-4 Key 不进发现/来源/绑定/URL/Web Storage/日志；成功立即清空。
 *
 * CUX-06 之后 dialogue 的入口是五项最小表单（`ModelPanel`），provider 不再由用户手填：
 * 同连接沿用原 provider，换连接用通用标识 `custom-openai`，显式复用凭据时用其**登记** provider。
 * 本文件按这个真实契约断言，不再假设存在「供应商标识」输入框。
 *
 * 环境是 fixture（临时目录、匿名 Key、真实 HTTP + 真实存储）。真实 ofm 成功 NOT RUN。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium, expect } from '@playwright/test'
import { join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'
import { startManagementServer } from '../../dist/management/server.js'
import { desktopHostManagement } from '../../dist/management/desktop-host-routes.js'
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js'
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js'

/** 匿名本机 Provider stub：只提供 GET /v1/models。记录收到的鉴权值。 */
async function providerStub({ models = ['stub-a', 'stub-b'], fail = null } = {}) {
  const hits = []
  const server = createServer((req, res) => {
    hits.push({ method: req.method, path: req.url, authorization: req.headers.authorization ?? '' })
    if (fail) { res.writeHead(fail, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `stub ${fail}` } })); return }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: models.map(id => ({ id })) }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'stub: no such route' } }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { origin: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise(done => server.close(done)) }
}

async function startServer(f) {
  const presets = await CharacterPresetStore.open({ memory: f.memory, settings: f.settings, skins: f.skins, base: f.c, roleConfigurations: f.roles })
  return startManagementServer({
    uiRoot: resolve('management'), settings: f.settings, memory: f.memory, presets, roleConfigurations: f.roles, skins: f.skins,
    // CUX-03 的核心：新 Key 走**已有的**同源凭据写入端点。缺了它，凭据阶段必然 503。
    selfSetup: f.selfSetup,
    desktopHost: desktopHostManagement({ async request() { return { outcome: 'cancelled' } } }, { instanceId: 'cux03', skins: f.skins }),
    lorebooks: f.lorebooks,
    presentationAssets: await presentationAssetRoutes(resolve('../..')),
    snapshot: () => f.request('/api/snapshot'),
  })
}

/** 打开模型页并等面板就绪。 */
async function openModel(page, server, characterId = 'role-b') {
  await page.goto(`${server.origin}/characters/${characterId}/config?tab=model#token=${server.token}`)
  await expect(page.locator('#model-endpoint')).toBeVisible({ timeout: 60000 })
}

test('CUX-03 新 Key 保存后发现：真实 HTTP 顺序、无泄密、重试不重复创建', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const stub = await providerStub()
  t.after(() => stub.close())
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = request.url()
    requests.push({ method: request.method(), url, path: new URL(url).pathname, body: request.postData() ?? '' })
  })
  const server = await startServer(f)
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-03')
  await mkdir(reports, { recursive: true })

  const ANON_KEY = 'sk-anonymous-cux03-browser-key'
  await openModel(page, server)
  await page.locator('#model-endpoint').fill(`${stub.origin}/v1/chat/completions`)

  // 点击前告知必须可见（不用事后 toast 代替）。
  await page.locator('#model-key').fill(ANON_KEY)
  await expect(page.locator('#model-key-notice')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存 Key 并获取模型', exact: true })).toBeVisible()
  await page.screenshot({ path: join(reports, '03-1-key-notice-before-click.png'), fullPage: true })

  const mark = requests.length
  const credentialsBefore = (await f.request('/api/self-setup')).credentials.length
  await page.getByRole('button', { name: '保存 Key 并获取模型', exact: true }).click()
  await expect(page.getByText(/已获取 2 个模型/)).toBeVisible({ timeout: 60000 })

  // 严格顺序：credentials → discover。
  const mine = requests.slice(mark)
  const credentialIndex = mine.findIndex(request => request.path === '/api/self-setup/credentials')
  const discoverIndex = mine.findIndex(request => request.path === '/api/provider-sources/discover')
  assert.ok(credentialIndex >= 0, '新 Key 必须先写入本机凭据')
  assert.ok(discoverIndex >= 0, '随后必须发生一次发现')
  assert.ok(credentialIndex < discoverIndex, `凭据写入必须早于发现：${JSON.stringify(mine.map(r => r.path))}`)
  // 发现请求体只带引用，不带明文。
  const discover = mine[discoverIndex]
  assert.equal(discover.body.includes(ANON_KEY), false, '发现请求体绝不能含明文 Key')
  assert.match(discover.body, /credentialRef/, '发现请求必须带凭据引用')
  assert.equal(/'key'|"key"|apiKey|token/.test(discover.body), false, `发现请求不得含 key/apiKey/token：${discover.body}`)
  // 凭据确实落盘，且发现用的是这个新引用。
  const after = await f.request('/api/self-setup')
  assert.equal(after.credentials.length, credentialsBefore + 1, '新 Key 必须真实保存到本机凭据库')
  const saved = after.credentials.at(-1)
  // CUX-06 契约：换连接后 provider 是通用标识（不按 URL/模型名猜厂商）。
  assert.equal(saved.provider, 'custom-openai', '全新自定义连接必须使用合法的通用 provider 标识')
  const ref = JSON.parse(discover.body).credentialRef
  assert.equal(ref, saved.id, '发现必须使用本次保存的引用')
  // stub 收到的是这个 Key（证明凭据真的被解析并使用，而不是空引用）。
  assert.equal(stub.hits.some(hit => hit.authorization === `Bearer ${ANON_KEY}`), true, `stub 必须收到本次保存的 Key：${JSON.stringify(stub.hits.map(h => h.authorization))}`)
  // 明文 Key 成功保存后立即从输入框清空。
  await expect(page.locator('#model-key')).toHaveValue('')
  // 不写绑定、不登记来源。
  assert.equal(mine.some(request => request.path === '/api/characters/bindings' && request.method === 'PUT'), false, '发现不得写绑定')
  assert.equal(mine.some(request => request.path === '/api/provider-sources' && request.method === 'POST'), false, '发现不得登记来源')
  // 03-4：Key 不进 URL、不进 Web Storage。
  const storage = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }))
  assert.equal(storage.local.includes(ANON_KEY), false, 'Key 不得进 localStorage')
  assert.equal(storage.session.includes(ANON_KEY), false, 'Key 不得进 sessionStorage')
  assert.equal(requests.some(request => request.url.includes(ANON_KEY)), false, 'Key 不得出现在任何 URL 中')
  await page.screenshot({ path: join(reports, '03-1-discovered-models.png'), fullPage: true })

  // 03-3：重试发现不重复创建凭据（此时表单里已是引用，Key 输入框为空）。
  const beforeRetry = requests.length
  await page.getByRole('button', { name: '获取模型', exact: true }).click()
  await expect(page.getByText(/已获取 2 个模型/)).toBeVisible({ timeout: 60000 })
  const retry = requests.slice(beforeRetry)
  assert.equal(retry.some(request => request.path === '/api/self-setup/credentials'), false, '重试发现不得再写一次凭据')
  assert.equal(retry.some(request => request.path === '/api/provider-sources/discover'), true, '重试必须真的重新发现')
  assert.equal((await f.request('/api/self-setup')).credentials.length, credentialsBefore + 1, '凭据数量不得增加')

  assert.deepEqual(errors, [])
})

test('CUX-03 凭据已保存但发现失败：明确区分两阶段，保留引用，只重试发现', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const stub = await providerStub({ fail: 401 })
  t.after(() => stub.close())
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const server = await startServer(f)
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-03')
  await mkdir(reports, { recursive: true })

  const ANON_KEY = 'sk-anonymous-cux03-fail-key'
  await openModel(page, server)
  await page.locator('#model-endpoint').fill(`${stub.origin}/v1/chat/completions`)
  await page.locator('#model-key').fill(ANON_KEY)
  const credentialsBefore = (await f.request('/api/self-setup')).credentials.length
  await page.getByRole('button', { name: '保存 Key 并获取模型', exact: true }).click()
  // 必须明确区分「Key 已保存在本机」与「获取模型失败」。
  await expect(page.getByText(/Key 已保存在本机；获取模型失败/)).toBeVisible({ timeout: 60000 })
  assert.equal((await f.request('/api/self-setup')).credentials.length, credentialsBefore + 1, '凭据必须真的已保存')
  // 明文不恢复：Key 输入框保持为空。
  await expect(page.locator('#model-key')).toHaveValue('')
  await page.screenshot({ path: join(reports, '03-3-credential-saved-discovery-failed.png'), fullPage: true })

  // 换到一个可用的 stub：不得把旧凭据静默发给新地址。
  await stub.close()
  const ok = await providerStub({ models: ['recovered-model'] })
  t.after(() => ok.close())
  await page.locator('#model-endpoint').fill(`${ok.origin}/v1/chat/completions`)
  await page.getByRole('button', { name: '获取模型', exact: true }).click()
  await expect(page.getByText(/服务地址已变更，已保存的凭据不会自动发送到新地址/)).toBeVisible({ timeout: 30000 })
  assert.equal(ok.hits.length, 0, '连接变更后不得把旧凭据静默发给新地址')

  // 重新打开页面（重新读取凭据列表），显式复用刚保存的本机凭据。
  // 用 reload 而不是 goto：同一 URL 的 goto 可能被当成同文档导航，组件不会重新挂载。
  await page.reload()
  await expect(page.locator('#model-endpoint')).toBeVisible({ timeout: 60000 })
  await page.locator('#model-endpoint').fill(`${ok.origin}/v1/chat/completions`)
  await page.locator('#model-key-toggle').click()
  await expect(page.locator('#model-credential')).toBeVisible()
  const options = await page.locator('#model-credential option').allTextContents()
  const reusable = options.find(text => text.includes('custom-openai'))
  assert.ok(reusable, `凭据列表必须列出刚保存的本机凭据：${JSON.stringify(options)}`)
  await page.locator('#model-credential').selectOption({ label: reusable })
  await page.getByRole('button', { name: '获取模型', exact: true }).click()
  await expect(page.getByText(/已获取 1 个模型/)).toBeVisible({ timeout: 60000 })
  assert.equal((await f.request('/api/self-setup')).credentials.length, credentialsBefore + 1, '重试发现不得再写凭据')
  await page.screenshot({ path: join(reports, '03-5-endpoint-change-explicit-reuse.png'), fullPage: true })

  assert.deepEqual(errors, [])
})

test('CUX-03 空输入与免 Key 分支：不发必失败请求，免 Key 不写凭据', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const stub = await providerStub({ models: ['local-model'] })
  t.after(() => stub.close())
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postData() ?? '' }))
  const server = await startServer(f)
  t.after(() => server.close())

  await openModel(page, server)

  // 本 fixture 的 role-b 是 inherit-default，但服务端解析出的默认来源**带一个引用**。
  // 按 CUX-03 §2「没有新 Key 且有有效引用时直接发现」，这里应当真的发起一次发现，
  // 并由服务端诚实地报告该引用无法解析 —— 而不是前端伪造成功或静默跳过。
  const mark = requests.length
  await page.getByRole('button', { name: '获取模型', exact: true }).click()
  await expect(page.getByText(/获取模型失败：/)).toBeVisible({ timeout: 30000 })
  const inherited = requests.slice(mark).filter(request => request.path === '/api/provider-sources/discover')
  assert.equal(inherited.length, 1, `有引用时必须发起一次发现：${JSON.stringify(requests.slice(mark).map(r => r.path))}`)
  assert.equal(inherited[0].body.includes('"credentialRef":""'), false, '必须带上解析出的引用，而不是空引用')
  assert.equal(inherited[0].body.includes('sk-'), false, '发现请求不得含明文 Key')

  // (c) 免 Key：不写凭据，也不带鉴权头。
  const credentialsBefore = (await f.request('/api/self-setup')).credentials.length
  const mark2 = requests.length
  await page.locator('#model-endpoint').fill(`${stub.origin}/v1/chat/completions`)
  await page.locator('#model-no-key').check()
  await page.getByRole('button', { name: '获取模型', exact: true }).click()
  await expect(page.getByText(/已获取 1 个模型/)).toBeVisible({ timeout: 60000 })
  const mine = requests.slice(mark2)
  assert.equal(mine.some(request => request.path === '/api/self-setup/credentials'), false, '免 Key 不得写凭据')
  assert.equal((await f.request('/api/self-setup')).credentials.length, credentialsBefore, '凭据数量不得变化')
  assert.equal(stub.hits.every(hit => !hit.authorization), true, '免 Key 发现不得携带鉴权头')

  assert.deepEqual(errors, [])
})

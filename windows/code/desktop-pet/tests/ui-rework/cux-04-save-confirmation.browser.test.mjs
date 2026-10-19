/**
 * CUX-04: 保存确认一致性与刷新回退（真实浏览器 + 真实生产 HTTP + 真实 store 重开）。
 *
 *   * 04-1 正常 own/inherit 保存 → 硬刷新 → store 重开值一致（核对所有字段，不只模型名）；
 *   * 04-2 PUT 2xx + 旧 GET/失败/readError 不报确认成功；
 *   * 04-3 409、超时、并发后写有明确状态，无草稿或他槽丢失；
 *   * 04-4 A/B 角色切换与延迟响应不串配置。
 *
 * D 的持久化回退根因在 CUX-00 已判定「无法复现」，因此本文件**不**断言 D 已修复；
 * 它验证的是 SPEC §2 要求的「准确报告保存结果」这一独立可证部分。
 *
 * CUX-06 之后 model tab 换成了五项最小表单，因此本文件驱动的是仍在用 `BindingPanel` 的
 * **voice tab · STT 槽位**。被验证的语义（写回执、写后回读、409 保留草稿、修订推进）位于
 * `session.saveBinding`，与槽位无关。
 *
 * 环境是 fixture（临时目录、匿名凭据、真实 HTTP + 真实存储）。真实 Provider NOT RUN。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'
import { startManagementServer } from '../../dist/management/server.js'
import { desktopHostManagement } from '../../dist/management/desktop-host-routes.js'
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js'
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js'
import { RoleConfigurationStore } from '../../dist/management/role-configuration.js'

async function startServer(f, extra = {}) {
  const presets = await CharacterPresetStore.open({ memory: f.memory, settings: f.settings, skins: f.skins, base: f.c, roleConfigurations: f.roles })
  return startManagementServer({
    uiRoot: resolve('management'), settings: f.settings, memory: f.memory, presets, roleConfigurations: f.roles, skins: f.skins,
    selfSetup: f.selfSetup,
    desktopHost: desktopHostManagement({ async request() { return { outcome: 'cancelled' } } }, { instanceId: 'cux04', skins: f.skins }),
    lorebooks: f.lorebooks,
    presentationAssets: await presentationAssetRoutes(resolve('../..')),
    snapshot: () => f.request('/api/snapshot'),
    ...extra,
  })
}

/** 登记一个可复用的匿名凭据。 */
async function saveCredential(f, provider, operationId) {
  const setup = await f.request('/api/self-setup')
  const receipt = await f.request('/api/self-setup/credentials', 'POST', {
    instanceId: setup.instanceId, provider, key: 'sk-anonymous-cux04-fixture',
    expectedRevision: setup.credentialRevision, operationId,
  })
  return receipt.credentialRef
}

/** 打开 voice tab，返回 STT 区域。 */
async function openStt(page, server, characterId = 'role-b') {
  await page.goto(`${server.origin}/characters/${characterId}/config?tab=voice#token=${server.token}`)
  const stt = page.getByRole('region', { name: 'STT · 语音转文字' })
  await expect(stt.getByLabel('来源方式')).toBeVisible({ timeout: 60000 })
  return stt
}

/** 把 STT 槽填成一个可保存的 own 配置（含全部必需上界）。 */
async function fillOwn(page, stt, { endpoint, model, provider = 'openai', credentialRef, audioMicrosPerSecond = '1' }) {
  await stt.getByLabel('来源方式').selectOption('own')
  await stt.getByLabel('服务 / 适配器').selectOption('openai-compatible-asr')
  await stt.getByLabel('服务端点 · Endpoint').fill(endpoint)
  await stt.getByLabel('供应商标识').fill(provider)
  await stt.getByLabel('鉴权').selectOption('credentialRef')
  await page.locator('#binding-stt-credential').selectOption(credentialRef)
  await stt.getByLabel('模型 · Model').fill(model)
  const advanced = stt.locator('details').filter({ hasText: '高级参数与计费' })
  if (!(await advanced.evaluate(node => node.open))) await advanced.locator('summary').click()
  await page.locator('#binding-stt-inputTokenLimit').fill('0')
  await page.locator('#binding-stt-outputTokenLimit').fill('0')
  await page.locator('#binding-stt-reservationMicros').fill('1000')
  await page.locator('#binding-stt-inputMicrosPerToken').fill('0')
  await page.locator('#binding-stt-outputMicrosPerToken').fill('0')
  await page.locator('#binding-stt-audioMicrosPerSecond').fill(audioMicrosPerSecond)
}

/** 保存 STT 绑定。 */
async function saveStt(stt) {
  await stt.getByRole('button', { name: '保存绑定', exact: true }).click()
}

test('CUX-04 正常保存 → 硬刷新 → store 重开：所有字段一致，且不显示未确认', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const server = await startServer(f)
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-04')
  await mkdir(reports, { recursive: true })

  const credentialRef = await saveCredential(f, 'openai', 'cux04-cred-save')
  const stt = await openStt(page, server)
  await fillOwn(page, stt, { endpoint: 'https://cux04.example.invalid/v1/audio/transcriptions', model: 'cux04-asr', credentialRef })
  await saveStt(stt)
  await expect(stt.getByText('绑定已保存并回读，重启后生效。', { exact: true })).toBeVisible({ timeout: 60000 })
  // 未确认的提示绝不能出现。
  await expect(stt.getByText(/写入已完成，回读未确认/)).toHaveCount(0)
  await expect(stt.getByText(/写入已完成，随后配置又发生变化/)).toHaveCount(0)
  await page.screenshot({ path: join(reports, '04-1-confirmed-save.png'), fullPage: true })

  // 服务端事实：核对**所有**字段，不只模型名。
  const saved = f.roles.get('role-b')
  assert.equal(saved.bindings.asr.mode, 'own')
  const own = f.roles.sources.resolve('asr', saved.bindings.asr.sourceInstanceId, saved.bindings.asr.modelProfileId)
  assert.ok(own, 'own 绑定必须引用真实登记的来源')
  const sel = own.selection
  assert.equal(sel.adapterId, 'openai-compatible-asr')
  assert.equal(sel.provider, 'openai')
  assert.equal(sel.protocol, 'openai-compatible')
  assert.equal(sel.endpoint, 'https://cux04.example.invalid/v1/audio/transcriptions')
  assert.equal(sel.model, 'cux04-asr')
  assert.equal(sel.inputTokenLimit, 0)
  assert.equal(sel.outputTokenLimit, 0)
  assert.equal(sel.reservationMicros, 1000)
  assert.equal(sel.inputMicrosPerToken, 0)
  assert.equal(sel.outputMicrosPerToken, 0)
  assert.equal(sel.audioMicrosPerSecond, 1)
  assert.equal(saved.bindings.asr.credentialRef, sel.credentialRef, '绑定的凭据引用必须与来源一致')
  // 其他槽位保持 inherit-default。
  assert.equal(saved.bindings.tts.mode, 'inherit-default')
  assert.equal(saved.bindings.dialogue.mode, 'inherit-default')

  // 硬刷新：重新读权威接口，值必须一致。
  await page.reload()
  await expect(stt.getByLabel('来源方式')).toHaveValue('own', { timeout: 30000 })
  await expect(stt.getByLabel('服务端点 · Endpoint')).toHaveValue('https://cux04.example.invalid/v1/audio/transcriptions')
  await expect(stt.getByLabel('模型 · Model')).toHaveValue('cux04-asr')
  await page.screenshot({ path: join(reports, '04-1-after-hard-reload.png'), fullPage: true })

  // store 重开：真正的持久化判据（进程内重开同一文件，不是刷新）。
  const reopened = await RoleConfigurationStore.open({ file: join(f.c.projectRoot, 'roles.json') })
  const after = reopened.get('role-b')
  assert.equal(after.bindings.asr.mode, 'own', 'store 重开后必须仍是 own')
  assert.equal(after.bindings.asr.sourceInstanceId, saved.bindings.asr.sourceInstanceId)
  assert.equal(after.bindings.asr.modelProfileId, saved.bindings.asr.modelProfileId)
  assert.equal(after.bindings.asr.credentialRef, saved.bindings.asr.credentialRef)
  assert.deepEqual(after.bindings.asr.parameters, saved.bindings.asr.parameters)
  assert.ok(after.savedRevision >= saved.savedRevision, 'savedRevision 不得回退')
  // 另一个角色完全未受影响。
  assert.equal(reopened.get('companion').bindings.asr.mode, 'inherit-default')

  // inherit-default：写回后 store 重开仍是 inherit。
  await stt.getByLabel('来源方式').selectOption('inherit-default')
  await saveStt(stt)
  await expect(stt.getByText('绑定已保存并回读，重启后生效。', { exact: true })).toBeVisible({ timeout: 60000 })
  const reopenedAgain = await RoleConfigurationStore.open({ file: join(f.c.projectRoot, 'roles.json') })
  assert.equal(reopenedAgain.get('role-b').bindings.asr.mode, 'inherit-default', 'inherit-default 必须真的持久化')

  assert.deepEqual(errors, [])
})

test('CUX-04 回读失败不报成功：显示未确认、保留草稿、重新读取只回读', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))

  const server = await startServer(f)
  t.after(() => server.close())
  const credentialRef = await saveCredential(f, 'openai', 'cux04-cred-readback')
  const stt = await openStt(page, server)
  await fillOwn(page, stt, { endpoint: 'https://cux04-readback.example.invalid/v1/audio/transcriptions', model: 'cux04-readback', credentialRef })

  // 用 route 拦截实现「PUT 之后的那一次 GET 失败」：写请求放行，紧随的读请求返回 503。
  let putSeen = false
  let failReadOnce = false
  await page.route('**/api/characters/bindings**', async route => {
    const request = route.request()
    if (request.method() === 'PUT') { putSeen = true; await route.continue(); return }
    if (putSeen && failReadOnce) { failReadOnce = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'anon: 回读失败' } }) }); return }
    await route.continue()
  })
  failReadOnce = true
  const reports = resolve('.local/reports/cux-04')
  await mkdir(reports, { recursive: true })

  await saveStt(stt)
  // 必须显示「写入已完成，回读未确认」，而**不是**成功。
  await expect(stt.getByText(/写入已完成，回读未确认/)).toBeVisible({ timeout: 60000 })
  await expect(stt.getByText('绑定已保存并回读，重启后生效。', { exact: true })).toHaveCount(0)
  // 草稿保留：用户编辑的模型名仍在。
  await expect(stt.getByLabel('模型 · Model')).toHaveValue('cux04-readback')
  // 写入确实发生了（服务端已有 own 绑定）。
  assert.equal(f.roles.get('role-b').bindings.asr.mode, 'own', 'PUT 已经成功写入')
  await page.screenshot({ path: join(reports, '04-2-written-unconfirmed.png'), fullPage: true })

  // 「重新读取」只回读：不重发来源登记、不重发绑定写入。
  const writesBefore = f.roles.get('role-b').savedRevision
  await page.getByRole('button', { name: '重新读取服务端配置', exact: true }).click()
  await expect(stt.getByText('已重新读取服务端配置。', { exact: true })).toBeVisible({ timeout: 30000 })
  assert.equal(f.roles.get('role-b').savedRevision, writesBefore, '重新读取绝不能推进修订')
  assert.deepEqual(errors, [])
})

test('CUX-04 409 与 A/B 角色切换：草稿保留、他槽不变、不串配置', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const server = await startServer(f)
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-04')
  await mkdir(reports, { recursive: true })

  const credentialRef = await saveCredential(f, 'openai', 'cux04-cred-conflict')
  const stt = await openStt(page, server)
  await fillOwn(page, stt, { endpoint: 'https://cux04-conflict.example.invalid/v1/audio/transcriptions', model: 'cux04-conflict', credentialRef })

  // 另一个写者推进修订：页面持有的 savedRevision 变旧 → 409。
  const before = await f.request('/api/characters/bindings?characterId=role-b')
  await f.request('/api/characters/bindings', 'PUT', {
    characterId: 'role-b', expectedRevision: before.configuration.savedRevision, operationId: 'cux04-other-writer',
    bindings: { tts: { mode: 'inherit-default' } },
  })
  await saveStt(stt)
  await expect(stt.getByText(/草稿已保留，请刷新后合并再保存/)).toBeVisible({ timeout: 60000 })
  // 草稿保留：用户编辑的模型名仍在；没有成功提示。
  await expect(stt.getByLabel('模型 · Model')).toHaveValue('cux04-conflict')
  await expect(stt.getByText('绑定已保存并回读，重启后生效。', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: join(reports, '04-3-conflict-draft-kept.png'), fullPage: true })

  // 另一个写者的 tts 变更保留；本槽位未被写入。
  const after = await f.request('/api/characters/bindings?characterId=role-b')
  assert.equal(after.configuration.bindings.tts.mode, 'inherit-default')
  assert.equal(after.configuration.bindings.asr.mode, 'inherit-default', '被拒绝的写入不得改动目标槽位')
  assert.equal(after.configuration.savedRevision, before.configuration.savedRevision + 1)

  // A/B 角色切换：切到另一个角色，页面显示它自己的配置，不串 A 的草稿。
  const companionStt = await openStt(page, server, 'companion')
  await expect(companionStt.getByLabel('来源方式')).toHaveValue('inherit-default')
  await expect(companionStt.getByLabel('模型 · Model')).not.toHaveValue('cux04-conflict')
  // 回到 B：显示服务端事实（inherit-default），不是之前未提交的草稿。
  const backStt = await openStt(page, server, 'role-b')
  await expect(backStt.getByLabel('来源方式')).toHaveValue('inherit-default')
  await page.screenshot({ path: join(reports, '04-4-role-switch-isolated.png'), fullPage: true })

  assert.deepEqual(errors, [])
})

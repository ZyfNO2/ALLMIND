/**
 * CUX-07 补充取证 A：**真实运行实例**的只读浏览器核对。
 *
 * 为什么需要这一步：CUX-00～07 的所有截图都来自隔离 fixture。本文件连到用户**正在运行**的
 * management 实例，用真实浏览器打开真实路由，为「待用户视觉验收」提供真机画面证据。
 *
 * 严格只读纪律：
 *   * 只做 GET 导航、DOM 读取与截图；
 *   * **绝不**点击保存 / 应用 / 获取模型 / 授权 / 撤销 / 删除；
 *   * 不读取、不记录、不打印任何凭据明文；不导出含 Authorization 的原始 HAR；
 *   * 不修改任何文件、不重启实例、不执行 refresh:runtime。
 *
 * 若实例未运行或描述符不可读，本文件如实记录 NOT RUN，不伪造画面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const DESCRIPTOR = 'F:/workspace/project/windows/.local/model-evaluation/trial/user-trial/management-session.json'
const EVIDENCE = resolve('../../../validation/output/ui-rework-evidence/config-issues-20261009/cux-07')
const REPORTS = resolve('.local/reports/cux-07')

/** 只读地读描述符并确认进程存活。 */
async function liveInstance() {
  if (!existsSync(DESCRIPTOR)) return null
  const raw = JSON.parse(await readFile(DESCRIPTOR, 'utf8'))
  const origin = new URL(raw.url).origin
  const token = new URL(raw.url).hash.replace(/^#token=/, '')
  let alive = false
  try { process.kill(raw.pid, 0); alive = true } catch { alive = false }
  return { ...raw, origin, token, alive }
}

/** 只读 GET：记录状态码与关键字段，绝不写。 */
async function readJson(inst, path) {
  const response = await fetch(inst.origin + path, { headers: { Authorization: `Bearer ${inst.token}` } })
  const value = await response.json().catch(() => null)
  return { status: response.status, value }
}

test('CUX-07 真实运行实例只读核对：基线、五处修复面与 D 现场', { timeout: 240000 }, async t => {
  const inst = await liveInstance()
  if (!inst || !inst.alive) {
    await mkdir(EVIDENCE, { recursive: true })
    await writeFile(join(EVIDENCE, 'cux-07-real-instance.json'), JSON.stringify({ result: 'NOT RUN', reason: inst ? 'descriptor exists but pid is not alive' : 'no management-session.json descriptor' }, null, 2), 'utf8')
    t.skip('本机没有正在运行的真实 management 实例；已如实记录 NOT RUN')
    return
  }
  await mkdir(EVIDENCE, { recursive: true })
  await mkdir(REPORTS, { recursive: true })

  // ---------------------------------------------------------------- 基线（只读）
  const snapshot = await readJson(inst, '/api/snapshot')
  assert.equal(snapshot.status, 200, '真实实例必须响应 /api/snapshot')
  const registry = await readJson(inst, '/api/characters')
  const sourceRegistry = await readJson(inst, '/api/provider-sources')
  const selfSetup = await readJson(inst, '/api/self-setup')
  const bindings = {}
  for (const character of registry.value.characters) {
    bindings[character.id] = (await readJson(inst, `/api/characters/bindings?characterId=${encodeURIComponent(character.id)}`)).value
  }

  // 脱敏：凭据只留 provider + 稳定别名，不留任何 id 之外的东西。
  const credentialSummary = (selfSetup.value.credentials || []).map(item => ({ provider: item.provider, status: item.status }))
  const sourceSummary = (sourceRegistry.value.entries || []).map(entry => ({ slot: entry.slot, provider: entry.selection?.provider, model: entry.selection?.model }))
  const bindingSummary = Object.fromEntries(Object.entries(bindings).map(([id, view]) => [id, {
    savedRevision: view.configuration?.savedRevision,
    effectiveRevision: view.configuration?.effectiveRevision,
    dialogueMode: view.configuration?.bindings?.dialogue?.mode,
    dialogueProvider: view.selections?.dialogue?.provider ?? null,
    dialogueModel: view.selections?.dialogue?.model ?? null,
    readErrors: view.readErrors ?? {},
    appearanceResourceId: view.configuration?.appearance?.resourceId ?? '',
  }]))

  const baseline = {
    result: 'RUN (read-only)',
    instance: {
      origin: inst.origin,
      pid: inst.pid,
      instanceId: inst.instanceId,
      runningSourceRevision: inst.sourceRevision,
      runningCharacterId: snapshot.value.runtime?.characterId,
      startedAt: snapshot.value.runtime?.startedAt,
    },
    characters: registry.value.characters.map(c => ({ id: c.id, label: c.label })),
    selection: registry.value.selection,
    bindings: bindingSummary,
    providerSources: { count: sourceSummary.length, entries: sourceSummary },
    credentials: { revision: selfSetup.value.credentialRevision, count: credentialSummary.length, entries: credentialSummary },
    globalDialogue: {
      saved: { provider: snapshot.value.settings?.saved?.providers?.dialogue?.provider, model: snapshot.value.settings?.saved?.providers?.dialogue?.model },
      effective: { provider: snapshot.value.settings?.effective?.providers?.dialogue?.provider, model: snapshot.value.settings?.effective?.providers?.dialogue?.model },
      settingsRevision: snapshot.value.settings?.revision,
      pending: snapshot.value.settings?.pending,
    },
  }
  await writeFile(join(EVIDENCE, 'cux-07-real-instance.json'), JSON.stringify(baseline, null, 2), 'utf8')

  // ---------------------------------------------------------------- 只读浏览器核对
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = []
  const writes = []
  page.on('pageerror', error => errors.push(error.message))
  /**
   * 只读纪律的机器化保证。
   *
   * 注意：本仓库有几处**读**语义的 POST（`POST /api/continuity/snapshot` 读取快照、
   * `POST /api/proactive/policy` 读取策略，对应的写入是 PUT）。它们不改数据，因此单独放行；
   * 其余任何非 GET 都视为写入并断言为空。
   */
  const READ_SHAPED_POSTS = new Set(['/api/continuity/snapshot', '/api/proactive/policy'])
  page.on('request', request => {
    if (request.method() === 'GET') return
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && READ_SHAPED_POSTS.has(path)) return
    writes.push(`${request.method()} ${path}`)
  })

  const hash = `#token=${inst.token}`
  const first = registry.value.characters.find(c => c.id !== snapshot.value.runtime?.characterId) || registry.value.characters[0]
  const running = snapshot.value.runtime?.characterId
  const observed = {}

  // 角色工作区：顶栏/侧栏不得有「全局设置」入口（CUX-05），侧栏头像必须渲染（CUX-02）。
  await page.goto(`${inst.origin}/characters/${encodeURIComponent(first.id)}/overview${hash}`)
  await expect(page.getByRole('button', { name: '角色切换', exact: true })).toBeVisible()
  observed.settingsEntryButtons = await page.getByRole('button', { name: '全局设置', exact: true }).count()
  observed.settingsEntryLinks = await page.locator('a[href^="/settings"]').count()
  await page.waitForFunction(() => [...document.querySelectorAll('img[data-avatar-status]')].some(img => img.dataset.avatarStatus !== 'loading'), undefined, { timeout: 90000 })
  observed.avatars = await page.evaluate(() => [...document.querySelectorAll('img[data-avatar-character]')].map(img => ({ character: img.dataset.avatarCharacter, status: img.dataset.avatarStatus, isBlob: img.src.startsWith('blob:') })))
  await page.screenshot({ path: join(REPORTS, 'real-01-workspace-no-settings-entry.png'), fullPage: true })

  // 形象 tab：内嵌预览区（CUX-01）与已保存选择来源（configuration.appearance）。
  await page.goto(`${inst.origin}/characters/${encodeURIComponent(first.id)}/config?tab=appearance${hash}`)
  await expect(page.getByRole('heading', { name: '形象与资源来源', exact: true })).toBeVisible({ timeout: 60000 })
  observed.appearance = {
    hasInlinePreview: await page.getByRole('heading', { name: '实际资源预览', exact: true }).count(),
    importButtonLabel: await page.getByRole('button', { name: '导入资源', exact: true }).count(),
    legacyDialogButton: await page.getByRole('button', { name: '资源导入 / 预览', exact: true }).count(),
    savedSelectionShown: await page.getByText(/已保存的选择：/).count(),
    resourceValue: await page.locator('#appearance-resource').inputValue().catch(() => null),
  }
  await page.screenshot({ path: join(REPORTS, 'real-02-appearance-inline-preview.png'), fullPage: true })

  // 模型 tab：五项最小表单（CUX-06）。
  await page.goto(`${inst.origin}/characters/${encodeURIComponent(first.id)}/config?tab=model${hash}`)
  await expect(page.locator('#model-endpoint')).toBeVisible({ timeout: 60000 })
  observed.model = {
    endpoint: await page.locator('#model-endpoint').inputValue(),
    model: await page.locator('#model-name').inputValue(),
    keyEmpty: (await page.locator('#model-key').inputValue()) === '',
    hasFiveControls: {
      endpoint: await page.locator('#model-endpoint').count(),
      key: await page.locator('#model-key').count(),
      discover: await page.locator('#model-discover').count(),
      model: await page.locator('#model-name').count(),
      save: await page.getByRole('button', { name: '保存', exact: true }).count(),
    },
    hiddenFields: {
      mode: await page.locator('#binding-dialogue-mode').count(),
      adapter: await page.locator('#binding-dialogue-adapter').count(),
      provider: await page.locator('#binding-dialogue-provider').count(),
      advanced: await page.locator('#binding-dialogue-inputTokenLimit').count(),
      revisionChip: await page.getByText(/保存修订 \d+ \/ 生效修订 \d+/).count(),
    },
    legacyTitle: await page.getByText(/三组能力分别配置/).count(),
  }
  await page.screenshot({ path: join(REPORTS, 'real-03-model-five-fields.png'), fullPage: true })

  // 感知 tab：内嵌真实 PrivacyPanel（CUX-05）。
  await page.goto(`${inst.origin}/characters/${encodeURIComponent(first.id)}/config?tab=perception${hash}`)
  await expect(page.getByRole('heading', { name: '感知与隐私', exact: true })).toBeVisible({ timeout: 60000 })
  observed.perception = {
    hasPrivacyPanel: await page.getByRole('heading', { name: '本地采集与留存', exact: true }).count(),
    hasOwnershipNotice: await page.getByText(/作用于整个运行实例/).count(),
    hasScopedNotice: await page.getByText(/按当前角色和运行配对/).count(),
    linksToSettings: await page.locator('a[href^="/settings"]').count(),
  }
  await page.screenshot({ path: join(REPORTS, 'real-04-perception-inline-panel.png'), fullPage: true })

  // /settings 深链仍然有效（CUX-05 保留维护路由）。
  await page.goto(`${inst.origin}/settings?tab=privacy${hash}`)
  await expect(page.getByRole('heading', { name: '全局设置', exact: true })).toBeVisible({ timeout: 60000 })
  observed.settingsDeepLink = { reachable: true, hasPrivacyPanel: await page.getByRole('heading', { name: '本地采集与留存', exact: true }).count() }
  await page.screenshot({ path: join(REPORTS, 'real-05-settings-deeplink.png'), fullPage: true })

  // 运行角色（companion/haru）的模型页也必须可用。
  if (running && running !== first.id) {
    await page.goto(`${inst.origin}/characters/${encodeURIComponent(running)}/config?tab=model${hash}`)
    await expect(page.locator('#model-endpoint')).toBeVisible({ timeout: 60000 })
    observed.runningCharacterModel = { characterId: running, endpoint: await page.locator('#model-endpoint').inputValue(), model: await page.locator('#model-name').inputValue() }
  }

  // ---------------------------------------------------------------- 只读纪律断言
  assert.deepEqual(writes, [], `真实实例核对期间不得产生任何写请求：${writes.join(', ')}`)
  assert.equal(observed.settingsEntryButtons, 0, '角色工作区不得有「全局设置」按钮')
  assert.equal(observed.settingsEntryLinks, 0, '角色工作区不得有指向 /settings 的链接')
  assert.equal(observed.appearance.hasInlinePreview, 1, '形象页必须有内嵌预览区')
  assert.equal(observed.appearance.legacyDialogButton, 0, '旧「资源导入 / 预览」按钮必须已移除')
  assert.equal(observed.model.hiddenFields.mode, 0, '模型页不得再显示来源方式下拉')
  assert.equal(observed.model.hiddenFields.adapter, 0, '模型页不得再显示服务/适配器')
  assert.equal(observed.model.hiddenFields.provider, 0, '模型页不得再显示供应商标识')
  assert.equal(observed.model.hiddenFields.advanced, 0, '模型页不得再显示高级参数')
  assert.equal(observed.model.hiddenFields.revisionChip, 0, '模型页不得常驻工程修订 chip')
  assert.equal(observed.model.legacyTitle, 0, '模型页不得再出现「三组能力分别配置」')
  assert.equal(observed.model.keyEmpty, true, 'Key 明文绝不能被回填')
  assert.equal(observed.perception.hasPrivacyPanel, 1, '感知 tab 必须内嵌真实 PrivacyPanel')
  assert.equal(observed.perception.linksToSettings, 0, '感知 tab 不得再指向 /settings')
  assert.equal(observed.settingsDeepLink.reachable, true, '/settings 深链必须仍然可达')
  assert.equal(observed.settingsDeepLink.hasPrivacyPanel, 1, '/settings?tab=privacy 必须仍渲染隐私面板')
  assert.deepEqual(errors, [], `真实实例页面不得有未捕获错误：${errors.join(', ')}`)

  await writeFile(join(EVIDENCE, 'cux-07-real-instance-browser.json'), JSON.stringify({ ...baseline, observed }, null, 2), 'utf8')
})

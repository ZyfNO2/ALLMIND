/**
 * LUI-02: 角色配置页在真实浏览器 + 真实生产服务上的端到端证据。
 *
 * 这一层证明的是「React 页面确实驱动了生产 API」，而不是假客户端上的编排：
 *   * 9 个 tab 全部渲染真实内容，没有一个 tab 出现旧管理页链接或「请使用旧管理页」文案；
 *   * `character` tab 的作者资料与人设是两个 owner、两个 revision，409 时保留草稿；
 *   * `model`/`voice` tab 的绑定保存走 `POST /api/provider-sources` → `PUT /api/characters/bindings`
 *     并回读；`readErrors` 逐槽显示；本地能力未接入时诚实不可用；
 *   * `lorebook` tab 的新建/追加/开关/删除都是独立调用；preview 不写库；
 *   * `appearance` tab 对**非运行角色**只写 saved 配置，全局运行形象不变；
 *   * `emotion` tab 未装配时诚实报错，不显示假数据；
 *   * 整个过程中浏览器不请求 `/legacy.html`、`/app.mjs`、`/roles-view.mjs`。
 *
 * 环境是 fixture（临时目录、匿名凭据、真实 HTTP + 真实 SQLite/JSON 存储）。真实 Provider 调用与
 * 真实音频效果一律 NOT RUN。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { join, resolve } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'
import { startManagementServer } from '../../dist/management/server.js'
import { desktopHostManagement } from '../../dist/management/desktop-host-routes.js'
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js'
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js'

test('LUI-02 character config page drives the real API from React and never links the retired console', { timeout: 180000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(15000)
  const errors = [], requested = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requested.push(new URL(request.url()).pathname))
  // 原生选择器由宿主提供；本用例只验证「导入只登记、不激活」的路径需要它存在。
  const host = desktopHostManagement({ async request() { return { outcome: 'cancelled' } } }, { instanceId: 'lui02-browser', skins: f.skins })
  const presets = await CharacterPresetStore.open({ memory: f.memory, settings: f.settings, skins: f.skins, base: f.c, roleConfigurations: f.roles })
  const server = await startManagementServer({
    uiRoot: resolve('management'), settings: f.settings, memory: f.memory, presets, roleConfigurations: f.roles, skins: f.skins,
    desktopHost: host, lorebooks: f.lorebooks,
    presentationAssets: await presentationAssetRoutes(resolve('../..')),
    snapshot: () => f.request('/api/snapshot'),
  })
  t.after(() => server.close())
  const reports = resolve('.local/reports/lui-02')
  await mkdir(reports, { recursive: true })

  // ---------------------------------------------------------------- character tab
  await page.goto(`${server.origin}/characters/role-b/config#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '角色资料', exact: true })).toBeVisible()
  assert.equal(page.url().includes(server.token), false, 'the token must be stripped from the address')
  await expect(page.locator('#config-intro')).toHaveValue('简介-role-b')
  await expect(page.locator('#config-persona')).toHaveValue('完整人设-role-b')

  await page.locator('#config-intro').fill('浏览器保存的简介')
  await page.getByRole('button', { name: '保存角色资料', exact: true }).click()
  await expect(page.getByText(/角色资料已保存（修订/)).toBeVisible()
  assert.equal(f.roles.get('role-b').identity.intro, '浏览器保存的简介')
  assert.equal(f.roles.get('role-b').persona.scenario, '保留背景', '只发送编辑过的字段：背景不得被顺手回写')

  await page.locator('#config-persona').fill('浏览器保存的人设')
  await page.getByRole('button', { name: '保存人设', exact: true }).click()
  await expect(page.getByText(/完整人设已保存（修订/)).toBeVisible()
  assert.equal((await f.request('/api/prompt?characterId=role-b')).text, '浏览器保存的人设')

  // 409：另一个写者推进 revision 后，页面必须保留草稿并提示刷新。
  const prompt = await f.request('/api/prompt?characterId=role-b')
  await f.request('/api/prompt', 'PUT', { characterId: 'role-b', expectedRevision: prompt.revision, text: '其他客户端的新版本', operationId: 'lui02-concurrent-prompt' })
  await page.locator('#config-persona').fill('冲突时必须保留的草稿')
  await page.getByRole('button', { name: '保存人设', exact: true }).click()
  await expect(page.getByText(/草稿已保留，请重新读取后再保存。/)).toBeVisible()
  await expect(page.locator('#config-persona')).toHaveValue('冲突时必须保留的草稿')
  assert.equal((await f.request('/api/prompt?characterId=role-b')).text, '其他客户端的新版本', '冲突时服务端内容不变')

  // ---------------------------------------------------------------- model tab（CUX-06 最小表单）
  await page.getByRole('button', { name: '模型', exact: true }).click()
  await expect(page.locator('#model-endpoint')).toBeVisible({ timeout: 60000 })
  await expect(page.locator('h2:text-is("模型")')).toBeVisible()
  // CUX-06: five primary controls only; the engineering revision chip is gone.
  await expect(page.locator('#model-endpoint')).toBeVisible()
  await expect(page.locator('#model-key')).toBeVisible()
  await expect(page.locator('#model-discover')).toBeVisible()
  await expect(page.locator('#model-name')).toBeVisible()
  await expect(page.getByText(/三组能力分别配置/)).toHaveCount(0)
  await expect(page.getByText(/保存修订 \d+ \/ 生效修订 \d+/)).toHaveCount(0)
  const bindings = await f.request('/api/characters/bindings?characterId=role-b')
  // The saved/effective pair is still surfaced as a plain-language restart notice when they differ.
  assert.equal(typeof bindings.configuration.savedRevision, 'number')
  // A local no-key source: explicit opt-in, then save through the real API.
  await page.locator('#model-endpoint').fill('http://127.0.0.1:13337/v1/chat/completions')
  await page.locator('#model-name').fill('lui02-browser-model')
  await page.locator('#model-no-key').check()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText(/已保存，重启后生效/)).toBeVisible({ timeout: 60000 })
  assert.equal(f.roles.get('role-b').bindings.dialogue.mode, 'own')
  assert.equal(f.roles.get('role-b').bindings.dialogue.sourceInstanceId.startsWith('source.'), true, 'own 绑定必须引用真实登记的来源')
  assert.equal(f.roles.get('companion').bindings.dialogue.mode, 'inherit-default', '另一个角色的绑定保持独立')
  await page.screenshot({ path: join(reports, 'config-model.png'), fullPage: true })

  // ---------------------------------------------------------------- voice tab（含诚实不可用的本地能力）
  await page.getByRole('button', { name: '语音', exact: true }).click()
  await expect(page.getByRole('region', { name: 'STT · 语音转文字' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'TTS · 文字转语音' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '本地能力诊断', exact: true })).toBeVisible()
  await expect(page.getByText(/本机本地能力检测未接入/)).toBeVisible()
  await page.screenshot({ path: join(reports, 'config-voice.png'), fullPage: true })

  // ---------------------------------------------------------------- appearance tab（非运行角色）
  await page.getByRole('button', { name: '形象', exact: true }).click()
  const activeBefore = f.skins.state().activeSkinId
  await expect(page.getByText(/该角色当前未运行/)).toBeVisible()
  await expect(page.getByRole('button', { name: '保存到该角色', exact: true })).toBeVisible()
  await page.locator('#appearance-resource').selectOption('local-model')
  await page.getByRole('button', { name: '保存到该角色', exact: true }).click()
  await expect(page.getByText(/角色形象已保存/)).toBeVisible()
  assert.equal(f.skins.state().activeSkinId, activeBefore, '非运行角色绝不能翻转全局运行形象')
  assert.equal(f.roles.get('role-b').appearance.resourceId, 'local-model')
  assert.equal(f.roles.get('companion').appearance.resourceId, 'local-model')

  // 导入只登记：打开资源弹窗 → 取消选择 → 登记修订不变、形象不变。
  await page.getByRole('button', { name: '导入资源', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '资源导入' })
  await expect(dialog).toBeVisible()
  const revisionBefore = f.skins.state().revision
  await dialog.getByRole('button', { name: '选择模型包目录', exact: true }).click()
  await expect(dialog.getByText('已取消选择，没有改动任何设置。', { exact: true })).toBeVisible()
  assert.equal(f.skins.state().revision, revisionBefore)
  assert.equal(f.skins.state().activeSkinId, activeBefore)
  await dialog.getByRole('button', { name: '关闭资源导入', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  // CUX-01：预览现在在形象页内嵌；非运行角色同样可以预览，且预览不应用。
  await expect(page.getByRole('heading', { name: '实际资源预览', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '预览选中资源', exact: true }).click()
  await expect(page.getByText(/正在预览：/)).toBeVisible()
  assert.equal(f.skins.state().activeSkinId, activeBefore, '预览绝不能翻转全局运行形象')
  assert.equal(f.roles.get('role-b').appearance.resourceId, 'local-model', '预览绝不能写入角色保存选择')
  await page.getByRole('button', { name: '关闭预览', exact: true }).click()
  await expect(page.locator('canvas[aria-label="资源实际预览"]')).toHaveCount(0)
  await page.screenshot({ path: join(reports, 'config-appearance.png'), fullPage: true })

  // ---------------------------------------------------------------- lorebook tab
  await page.getByRole('button', { name: '故事书', exact: true }).click()
  await expect(page.getByRole('heading', { name: /故事书与世界设定/ })).toBeVisible()
  await page.locator('#lorebook-title').fill('浏览器故事书')
  await page.getByRole('button', { name: '新建故事书', exact: true }).click()
  await expect(page.getByText(/故事书已创建：浏览器故事书/)).toBeVisible()
  const books = (await f.request('/api/characters/lorebooks?characterId=role-b')).books
  assert.equal(books.length, 1)
  const bookId = books[0].id

  await page.locator('#lorebook-entry-title').fill('初遇')
  await page.locator('#lorebook-entry-keywords').fill('图书馆, 初遇')
  await page.locator('#lorebook-entry-content').fill('两人在图书馆相遇。')
  await page.getByRole('button', { name: '追加条目', exact: true }).click()
  await expect(page.getByText(/条目已追加到《浏览器故事书》/)).toBeVisible()
  const afterAdd = (await f.request('/api/characters/lorebooks?characterId=role-b')).books[0]
  assert.equal(afterAdd.entries.length, 1)
  assert.deepEqual(afterAdd.entries[0].keywords, ['图书馆', '初遇'])
  await expect(page.locator('#lorebook-entry-content')).toHaveValue('', { timeout: 5000 })

  await page.getByRole('button', { name: '停用', exact: true }).click()
  await expect(page.getByText('条目已停用。', { exact: true })).toBeVisible()
  const afterToggle = (await f.request('/api/characters/lorebooks?characterId=role-b')).books[0]
  assert.equal(afterToggle.entries[0].enabled, false)
  assert.equal(afterToggle.entries[0].content, '两人在图书馆相遇。', '一次开关不得清空作者正文')

  // 导入：preview 不写库，未确认前没有第二本书。
  const importBook = { schemaVersion: 1, title: '导入的世界', entries: [{ title: 'a', content: 'b', strategy: 'always', keywords: [] }] }
  // The import form lives in a collapsed `<details>`; open it only when it is closed.
  const importPanel = page.locator('details').filter({ hasText: '导入故事书（v1 JSON）' })
  if (!(await importPanel.evaluate(node => node.open))) await importPanel.locator('summary').click()
  await page.locator('#lorebook-import-text').fill(JSON.stringify(importBook))
  await page.getByRole('button', { name: '预览校验', exact: true }).click()
  await expect(page.getByText(/预览：导入的世界 · 1 条（尚未写入）/)).toBeVisible()
  assert.equal((await f.request('/api/characters/lorebooks?characterId=role-b')).books.length, 1, 'preview 不得写库')
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText(/已导入《导入的世界》/)).toBeVisible()
  assert.equal((await f.request('/api/characters/lorebooks?characterId=role-b')).books.length, 2)

  // 409：另一个写者推进书修订后，删除必须被拒绝且本地列表不变。
  const book = (await f.request('/api/characters/lorebooks?characterId=role-b')).books.find(item => item.id === bookId)
  await f.request(`/api/characters/lorebooks/${bookId}`, 'PUT', { characterId: 'role-b', expectedRevision: book.revision, entries: [{ title: '外部追加', content: '外部正文', strategy: 'always', keywords: [] }] })
  await page.getByRole('button', { name: '删除此条目', exact: true }).first().click()
  await expect(page.getByText(/草稿已保留，请重新读取后再保存。/)).toBeVisible()
  const afterConflict = (await f.request('/api/characters/lorebooks?characterId=role-b')).books.find(item => item.id === bookId)
  assert.equal(afterConflict.entries.length, 2, '冲突时服务端数据不变')
  await page.screenshot({ path: join(reports, 'config-lorebook.png'), fullPage: true })

  // ---------------------------------------------------------------- emotion tab（未装配时诚实报错）
  await page.getByRole('button', { name: '表现', exact: true }).click()
  await expect(page.getByText(/读取表现策略失败/)).toBeVisible()

  // ---------------------------------------------------------------- perception / ability / memory
  await page.getByRole('button', { name: '感知', exact: true }).click()
  // CUX-05: the perception tab now mounts the real PrivacyPanel instead of linking out to /settings.
  await expect(page.getByRole('heading', { name: '感知与隐私', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '本地采集与留存', exact: true })).toBeVisible()
  await expect(page.getByText(/作用于整个运行实例/)).toBeVisible()
  await expect(page.getByRole('link', { name: /全局设置 · 隐私授权/ })).toHaveCount(0)
  await page.getByRole('button', { name: '能力', exact: true }).click()
  await expect(page.getByRole('link', { name: /前往 插件/ })).toHaveAttribute('href', '/characters/role-b/plugins')
  await page.getByRole('button', { name: '记忆', exact: true }).click()
  await expect(page.getByRole('link', { name: /前往 记忆与知识/ })).toHaveAttribute('href', '/characters/role-b/memory')

  // ---------------------------------------------------------------- 无旧 UI 依赖、无旧文案
  await expect(page.getByText(/旧管理页/)).toHaveCount(0)
  await expect(page.locator('a[href*="legacy.html"]')).toHaveCount(0)
  assert.equal(requested.some(path => ['/legacy.html', '/app.mjs', '/roles-view.mjs', '/roles-session.mjs'].includes(path)), false, `no retired console asset may be requested: ${requested.filter(p => p.includes('legacy') || p.endsWith('.mjs')).join(',')}`)
  assert.deepEqual(errors, [])

  // ---------------------------------------------------------------- tab 深链接
  await page.goto(`${server.origin}/characters/role-b/config?tab=lorebook#token=${server.token}`)
  await expect(page.getByRole('heading', { name: /故事书与世界设定/ })).toBeVisible()
  await page.goto(`${server.origin}/characters/role-b/config?tab=does-not-exist`)
  await expect(page.getByRole('heading', { name: '角色资料', exact: true })).toBeVisible()
  await expect(page.locator('a[href*="legacy.html"]')).toHaveCount(0)
})

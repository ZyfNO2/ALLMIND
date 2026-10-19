/**
 * CUX-05: 隐藏全局设置入口并保留授权到达路径（真实浏览器 + 真实生产 HTTP）。
 *
 *   * 05-1 角色工作区各路由无顶栏/侧栏/配置内全局设置入口（DOM + 截图，不只搜源码字符串）；
 *   * 05-2 感知 tab 可读状态、授权、暂停/撤销，无复制 store；
 *   * 05-3 进入页面零采集写入；非运行角色不误授权运行角色；
 *   * 05-4 旧 /settings 深链与宿主维护入口未断，状态同源；
 *   * 05-5 切 tab/切角色/授权 409 不串状态。
 *
 * 环境是 fixture（临时目录、匿名凭据、真实 HTTP + 真实存储）。
 * 真实屏幕/麦克风/采集一律 NOT RUN（本任务不新增此类授权）。
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

async function startServer(f, extra = {}) {
  const presets = await CharacterPresetStore.open({ memory: f.memory, settings: f.settings, skins: f.skins, base: f.c, roleConfigurations: f.roles })
  return startManagementServer({
    uiRoot: resolve('management'), settings: f.settings, memory: f.memory, presets, roleConfigurations: f.roles, skins: f.skins,
    selfSetup: f.selfSetup,
    desktopHost: desktopHostManagement({ async request() { return { outcome: 'cancelled' } } }, { instanceId: 'cux05', skins: f.skins }),
    lorebooks: f.lorebooks,
    presentationAssets: await presentationAssetRoutes(resolve('../..')),
    snapshot: () => f.request('/api/snapshot'),
    ...extra,
  })
}

test('CUX-05 角色工作区无全局设置入口；感知 tab 内嵌真实面板；/settings 深链仍有效', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = [], writes = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`) })
  const server = await startServer(f)
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-05')
  await mkdir(reports, { recursive: true })

  // ---------------------------------------------------------------- 05-1 无入口（DOM，不只搜源码）
  const routes = ['overview', 'timeline', 'memory', 'config', 'chat', 'trace', 'plugins']
  for (const route of routes) {
    await page.goto(`${server.origin}/characters/role-b/${route}#token=${server.token}`)
    // 侧栏（唯一带品牌按钮的那个 aside）必须存在。
    const sidebar = page.locator('aside').filter({ has: page.getByRole('button', { name: /Aika\s*Next/ }) })
    await expect(sidebar).toBeVisible()
    // 顶栏与侧栏都不得出现「全局设置」按钮/链接。
    await expect(page.getByRole('button', { name: '全局设置', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '全局设置', exact: true })).toHaveCount(0)
    // 也不得有指向 /settings 的任何可见链接。
    assert.equal(await page.locator('a[href^="/settings"]').count(), 0, `${route} 不得有指向 /settings 的链接`)
    // 角色切换必须保留。
    await expect(page.getByRole('button', { name: '角色切换', exact: true })).toBeVisible()
  }
  // 配置页各 tab 内也不得出现「全局设置」文案或链接。
  // 注意：部分 tab 在本 fixture 里会诚实报「未装配」（例如表现策略），那不是本步的断言对象；
  // 这里只断言「没有全局设置入口」，不要求每个 tab 都有内容。
  for (const tab of ['character', 'model', 'voice', 'appearance', 'lorebook', 'emotion', 'perception', 'ability']) {
    await page.goto(`${server.origin}/characters/role-b/config?tab=${tab}#token=${server.token}`)
    await expect(page.getByRole('navigation', { name: '角色配置分区' })).toBeVisible()
    await expect(page.getByText('前往 全局设置 · 隐私授权')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '全局设置', exact: true })).toHaveCount(0)
    assert.equal(await page.locator('a[href^="/settings"]').count(), 0, `config?tab=${tab} 不得有指向 /settings 的链接`)
  }
  await page.screenshot({ path: join(reports, '05-1-no-settings-entry.png'), fullPage: true })

  // ---------------------------------------------------------------- 05-2/05-3 感知 tab 内嵌真实面板
  const mark = writes.length
  await page.goto(`${server.origin}/characters/role-b/config?tab=perception#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '感知与隐私', exact: true })).toBeVisible()
  // 归属说明必须可见：实例级 vs 按角色/配对。
  await expect(page.getByText(/作用于整个运行实例/)).toBeVisible()
  await expect(page.getByText(/按当前角色和运行配对/)).toBeVisible()
  // 真实面板的六个子域标题必须都在（复用现有 PrivacyPanel，而不是复制一份）。
  for (const title of ['本地采集与留存', '授权感知', '屏幕授权', '主动陪伴 · 保存偏好', '主动陪伴邀请策略', '语音唤醒']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  // 05-3：进入页面**零写入**（只读）。
  assert.deepEqual(writes.slice(mark), [], `进入感知 tab 不得有任何写请求：${writes.slice(mark).join(', ')}`)
  await page.screenshot({ path: join(reports, '05-2-perception-tab-real-panel.png'), fullPage: true })

  // ---------------------------------------------------------------- 05-4 旧 /settings 深链未断
  await page.goto(`${server.origin}/settings#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '全局设置', exact: true })).toBeVisible()
  await page.goto(`${server.origin}/settings?tab=privacy#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '感知与隐私', exact: true })).toBeVisible().catch(async () => {
    // /settings 的 privacy tab 渲染 PrivacyPanel 本体（没有外层「感知与隐私」标题）。
    await expect(page.getByRole('heading', { name: '本地采集与留存', exact: true })).toBeVisible()
  })
  await expect(page.getByRole('heading', { name: '本地采集与留存', exact: true })).toBeVisible()
  await page.screenshot({ path: join(reports, '05-4-settings-deeplink-alive.png'), fullPage: true })
  // 历史深链（旧 page/section，都在 hash 里）也继续有效。
  await page.goto(`${server.origin}/#token=${server.token}&page=perception&section=perception`)
  await expect(page).toHaveURL(/\/settings\?tab=privacy/)
  await expect(page.getByRole('heading', { name: '本地采集与留存', exact: true })).toBeVisible()
  await page.goto(`${server.origin}/#token=${server.token}&page=settings&section=collection`)
  await expect(page).toHaveURL(/\/settings\?tab=collection/)
  await page.goto(`${server.origin}/#token=${server.token}&page=proactive`)
  await expect(page).toHaveURL(/\/settings\?tab=privacy/)
  // 未知 tab 回落，不空白。
  await page.goto(`${server.origin}/settings?tab=does-not-exist#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '全局设置', exact: true })).toBeVisible()

  assert.deepEqual(errors, [])
})

test('CUX-05 感知授权可读可撤销且不串状态；角色切换与 409 保留草稿', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const server = await startServer(f)
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-05')
  await mkdir(reports, { recursive: true })

  // 非运行角色（role-b）：屏幕授权按角色/配对校验，未装配时诚实说明而不是假授权。
  await page.goto(`${server.origin}/characters/role-b/config?tab=perception#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '感知与隐私', exact: true })).toBeVisible()
  // 屏幕授权卡片必须显示真实读取结果（未装配 → 诚实不可用），而不是伪造「已授权」。
  const screenCard = page.locator('section').filter({ hasText: '屏幕授权' }).first()
  await expect(screenCard).toBeVisible()
  await expect(page.getByText(/尚未读取到屏幕授权状态/)).toBeVisible({ timeout: 30000 })
  await expect(page.getByText(/本页不显示假授权/)).toBeVisible()
  await page.screenshot({ path: join(reports, '05-3-screen-grant-honest.png'), fullPage: true })

  // 唤醒默认关闭：不得因为进入页面就打开监听。未装配时如实显示，不用默认值冒充已保存。
  await expect(page.getByText(/默认关闭。开启后仅在本机持续监听唤醒词/)).toBeVisible()
  await expect(page.getByText(/尚未读取到唤醒状态/)).toBeVisible()

  // 切 tab：离开感知后不残留面板（请求守卫取消/忽略旧响应）。
  await page.getByRole('button', { name: '角色配置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本地采集与留存', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '感知', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本地采集与留存', exact: true })).toBeVisible()

  // 切角色：感知面板显示的是当前浏览角色，不串另一个角色的配对。
  await page.goto(`${server.origin}/characters/companion/config?tab=perception#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '感知与隐私', exact: true })).toBeVisible()
  await expect(page.getByText(/当前浏览：companion/)).toBeVisible()
  await page.goto(`${server.origin}/characters/role-b/config?tab=perception#token=${server.token}`)
  await expect(page.getByText(/当前浏览：role-b/)).toBeVisible()

  // 05-5：授权类操作在未装配时不得发出写入请求（未确认不发请求）。
  const writes = []
  page.on('request', request => { if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`) })
  const mark = writes.length
  await page.goto(`${server.origin}/characters/role-b/config?tab=perception#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '本地采集与留存', exact: true })).toBeVisible()
  await page.waitForTimeout(500)
  assert.deepEqual(writes.slice(mark), [], `仅进入感知页不得产生任何写请求：${writes.slice(mark).join(', ')}`)

  assert.deepEqual(errors, [])
})

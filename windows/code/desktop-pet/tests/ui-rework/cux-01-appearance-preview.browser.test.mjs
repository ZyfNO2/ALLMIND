/**
 * CUX-01: 形象页内嵌预览、导入后自动显示、外观选择正确回读。
 *
 * 这一层证明的是**真实浏览器 + 真实生产服务**上的行为，不是假客户端编排：
 *   * 01-1 A/B 角色的初始外观来自 `configuration.appearance`（profile 不返回 appearance）；
 *   * 01-2 Live2D 与 Sprite 导入后自动页内预览，且登记动作不含 activate / characters appearance 写入；
 *   * 01-3 七状态只驱动画布；失败与取消诚实展示；
 *   * 01-4 连续切换/关闭/角色离开不残留实例或旧画面；
 *   * 01-5 运行/非运行显式应用边界保留，写后回读同步局部状态。
 *
 * 环境是 fixture（临时目录、匿名凭据、真实 HTTP + 真实存储）。真实 Provider 与真实音频 NOT RUN。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { join, resolve } from 'node:path'
import { mkdir, writeFile, cp, rename, rm } from 'node:fs/promises'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'
import { startManagementServer } from '../../dist/management/server.js'
import { desktopHostManagement } from '../../dist/management/desktop-host-routes.js'
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js'
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js'

/** 一个只服务 sprite 选择器的宿主桥；Live2D 走真实包目录。 */
function hostWith(skins, spriteImage) {
  return desktopHostManagement({
    async request(_method, input) {
      if (input.type === 'sprite') return { outcome: 'selected', source: spriteImage, root: spriteImage, displayName: 'cux01-sprite.png', entries: [] }
      if (input.selectionKind === 'directory') return { outcome: 'selected', source: input.root ?? '', root: input.root ?? '', displayName: 'cux01-live2d', entries: [{ entry: 'model/pet.model3.json' }] }
      return { outcome: 'cancelled' }
    },
  }, { instanceId: 'cux01-browser', skins })
}

async function startServer(f, host) {
  const presets = await CharacterPresetStore.open({ memory: f.memory, settings: f.settings, skins: f.skins, base: f.c, roleConfigurations: f.roles })
  return startManagementServer({
    uiRoot: resolve('management'), settings: f.settings, memory: f.memory, presets, roleConfigurations: f.roles, skins: f.skins,
    desktopHost: host, lorebooks: f.lorebooks,
    presentationAssets: await presentationAssetRoutes(resolve('../..')),
    snapshot: () => f.request('/api/snapshot'),
  })
}

test('CUX-01 形象页内嵌预览：导入自动预览、七状态、显式应用边界与清理', { timeout: 180000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(20000)
  const errors = [], writes = []
  page.on('pageerror', error => errors.push(`${error.message}\n${error.stack ?? ''}`))
  // 记录所有**写**请求：导入与预览都不得产生 activate / characters/appearance 写入。
  page.on('request', request => { if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`) })

  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 32; c.height = 32; const x = c.getContext('2d'); x.fillStyle = 'red'; x.fillRect(0, 0, 32, 32); return c.toDataURL().split(',')[1] })
  const spriteImage = join(f.c.projectRoot, 'cux01-sprite.png')
  await writeFile(spriteImage, Buffer.from(png, 'base64'))
  const live2dPack = join(f.c.projectRoot, 'cux01-live2d')
  await mkdir(join(live2dPack, 'model'), { recursive: true })
  await cp(join(f.root, 'desktop/assets/local-model'), join(live2dPack, 'model'), { recursive: true })

  // 让宿主桥能在 directory 选择时返回真实包根。
  const host = desktopHostManagement({
    async request(_method, input) {
      if (input.type === 'sprite') return { outcome: 'selected', source: spriteImage, root: spriteImage, displayName: 'cux01-sprite.png', entries: [] }
      if (input.selectionKind === 'directory') return { outcome: 'selected', source: live2dPack, root: live2dPack, displayName: 'cux01-live2d', entries: [{ entry: 'model/pet.model3.json' }] }
      return { outcome: 'cancelled' }
    },
  }, { instanceId: 'cux01-browser', skins: f.skins })
  const server = await startServer(f, host)
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-01')
  await mkdir(reports, { recursive: true })

  // ---------------------------------------------------------------- 01-1 初始外观来自 configuration.appearance
  // 先把 role-b 的已保存外观改成 local-model（fixture 默认即如此），再断言页面回显它。
  const bindingsBefore = await f.request('/api/characters/bindings?characterId=role-b')
  const profileBefore = await f.request('/api/characters/profile?characterId=role-b')
  assert.equal(Object.prototype.hasOwnProperty.call(profileBefore, 'appearance'), false, 'profile 不返回 appearance（CUX-00 场景5）')
  assert.equal(bindingsBefore.configuration.appearance.resourceId, 'local-model')

  await page.goto(`${server.origin}/characters/role-b/config?tab=appearance#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '形象与资源来源', exact: true })).toBeVisible()
  await expect(page.getByText(/已保存的选择：local-model/)).toBeVisible()
  await expect(page.locator('#appearance-resource')).toHaveValue('local-model')
  await expect(page.locator('#appearance-type')).toHaveValue('live2d')
  await page.screenshot({ path: join(reports, '01-1-initial-from-configuration.png'), fullPage: true })

  // 非运行角色：按钮是「保存到该角色」，且预览可用。
  await expect(page.getByText(/该角色当前未运行/)).toBeVisible()
  await expect(page.getByRole('button', { name: '保存到该角色', exact: true })).toBeVisible()

  // ---------------------------------------------------------------- 01-3 预览只读 + 七状态
  // DUX-02：选中即渲染 —— 初始已保存资源（local-model）自动出现画布，无常驻预览/关闭按钮。
  const activeBefore = f.skins.state().activeSkinId
  const writesBeforePreview = writes.length
  await expect(page.getByText(/正在预览：/)).toBeVisible({ timeout: 30000 })
  assert.equal(await page.getByRole('button', { name: '预览选中资源', exact: true }).count(), 0, '常驻「预览选中资源」按钮必须移除')
  assert.equal(await page.getByRole('button', { name: '关闭预览', exact: true }).count(), 0, '常驻「关闭预览」按钮必须移除')
  await page.waitForFunction(() => { const c = document.querySelector('canvas[aria-label="资源实际预览"]'); return Boolean(c && c.width > 1 && c.height > 1) })
  // 七状态必须全部可选，且切换只驱动画布。
  const stateSelect = page.getByLabel('角色状态测试', { exact: true })
  const options = await stateSelect.locator('option').allTextContents()
  assert.deepEqual(options, ['待机', '倾听', '思考', '说话', '工作', '开心', '睡眠'], '七状态必须齐备')
  for (const value of ['listening', 'thinking', 'speaking', 'working', 'happy', 'sleeping', 'idle']) {
    await stateSelect.selectOption(value)
    await expect(stateSelect).toHaveValue(value)
  }
  assert.equal(f.skins.state().activeSkinId, activeBefore, '预览绝不能翻转全局运行形象')
  assert.deepEqual(f.roles.get('role-b').appearance.resourceId, 'local-model', '预览绝不能写入角色保存选择')
  assert.deepEqual(writes.slice(writesBeforePreview), [], `预览不得产生任何写请求：${writes.slice(writesBeforePreview).join(', ')}`)
  await page.screenshot({ path: join(reports, '01-3-preview-seven-states.png'), fullPage: true })

  // ---------------------------------------------------------------- 01-2 Sprite 导入后自动页内预览
  await page.getByRole('button', { name: '导入资源', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '资源导入' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('导入类型', { exact: true }).selectOption('sprite')
  await dialog.getByRole('button', { name: '选择 PNG / WebP', exact: true }).click()
  await expect(dialog.getByText('已选择：cux01-sprite.png', { exact: true })).toBeVisible()
  const revisionBeforeImport = f.skins.state().revision
  const roleBeforeImport = structuredClone(f.roles.get('role-b'))
  const writesBeforeImport = writes.length
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  // 导入成功：关闭弹窗、选中新资源、自动展开页内预览、提示尚未应用。
  // 导入本身包含宿主选择器往返 + 登记 + 预览引擎创建，给足时间（并行跑测试时机器可能很忙）。
  await expect(page.getByText('已导入并预览，尚未应用。', { exact: true })).toBeVisible({ timeout: 60000 })
  await expect(dialog).toHaveCount(0, { timeout: 60000 })
  await expect(page.getByText(/正在预览：cux01-sprite/)).toBeVisible()
  await page.waitForFunction(() => {
    // DUX-02: sprite 与 live2d 各有稳定画布；只检查**可见**（未 hidden）的那个。
    const c = [...document.querySelectorAll('canvas[aria-label="资源实际预览"]')].find(item => !item.hidden)
    const x = c?.getContext('2d'); return Boolean(x && c && c.width > 1 && x.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0))
  })
  const importedSprite = f.skins.list().find(skin => skin.origin === 'imported' && skin.type === 'sprite')
  assert.ok(importedSprite, 'Sprite 必须真实登记')
  assert.equal(f.skins.state().revision, revisionBeforeImport + 1, '导入只推进登记修订')
  assert.equal(f.skins.state().activeSkinId, activeBefore, '导入不得激活')
  assert.deepEqual(f.roles.get('role-b'), roleBeforeImport, '导入不得写角色保存选择')
  const importWrites = writes.slice(writesBeforeImport)
  assert.equal(importWrites.some(entry => entry.includes('/activate')), false, `导入不得调用 activate：${importWrites.join(', ')}`)
  assert.equal(importWrites.some(entry => entry.includes('/api/characters/appearance')), false, `导入不得写 characters/appearance：${importWrites.join(', ')}`)
  assert.equal(importWrites.every(entry => entry.startsWith('POST /api/desktop/resource-picker')), true, `导入只应走资源选择器：${importWrites.join(', ')}`)
  await page.screenshot({ path: join(reports, '01-2-import-auto-preview-sprite.png'), fullPage: true })

  // ---------------------------------------------------------------- 01-4 连续切换无残留
  // DUX-02：预览跟随选择，连续换资源 20 次，每次画布都重建且不串图；结束时回到初始资源仍有画布。
  for (let i = 0; i < 20; i++) {
    await page.locator('#appearance-type').selectOption('sprite')
    await page.locator('#appearance-resource').selectOption(importedSprite.skinId)
    await expect(page.getByText(/正在预览：cux01-sprite/)).toBeVisible({ timeout: 30000 })
    await page.locator('#appearance-type').selectOption('live2d')
    await page.locator('#appearance-resource').selectOption('local-model')
    await expect(page.getByText(/正在预览：内建模型/)).toBeVisible({ timeout: 30000 })
  }
  await expect(page.locator('canvas[aria-label="资源实际预览"]:not([hidden])')).toHaveCount(1)
  // 切换类型清空草稿 → 预览回到选择提示（不串图）；画布常驻（context 复用），live2d 画布 hidden。
  await page.locator('#appearance-type').selectOption('sprite')
  await expect(page.getByText('请选择要预览的已登记资源。', { exact: true })).toBeVisible()
  const visibleCanvas = page.locator('canvas[aria-label="资源实际预览"]:not([hidden])')
  assert.equal(await visibleCanvas.count(), 1, '无选择时仍只有一个可见画布（常驻 DOM，引擎已停）')
  // 选回资源 → 预览跟随到新资源。
  await page.locator('#appearance-resource').selectOption(importedSprite.skinId)
  await expect(page.getByText(/正在预览：cux01-sprite/)).toBeVisible()
  assert.equal(f.roles.get('role-b').appearance.resourceId, 'local-model', '草稿切换不得写入后端')

  // ---------------------------------------------------------------- 01-5 非运行角色显式保存 + 回读同步
  await page.locator('#appearance-type').selectOption('sprite')
  await page.locator('#appearance-resource').selectOption(importedSprite.skinId)
  await page.getByRole('button', { name: '保存到该角色', exact: true }).click()
  await expect(page.getByText(/角色形象已保存/)).toBeVisible()
  assert.equal(f.roles.get('role-b').appearance.resourceId, importedSprite.skinId)
  assert.equal(f.roles.get('role-b').appearance.type, 'sprite')
  assert.equal(f.skins.state().activeSkinId, activeBefore, '非运行角色绝不能翻转全局运行形象')
  // 回读同步：局部状态必须反映后端事实（而不是只更新父组件 initial）。
  await expect(page.getByText(new RegExp(`已保存的选择：${importedSprite.skinId}`))).toBeVisible()
  // 硬刷新后仍显示已保存选择（01-1 的写后版本）。
  await page.reload()
  await expect(page.getByText(new RegExp(`已保存的选择：${importedSprite.skinId}`))).toBeVisible()
  await expect(page.locator('#appearance-resource')).toHaveValue(importedSprite.skinId)
  await page.screenshot({ path: join(reports, '01-5-saved-and-reloaded.png'), fullPage: true })

  // ---------------------------------------------------------------- 角色离开：预览释放
  await page.getByRole('button', { name: '保存到该角色', exact: true }).click()
  await expect(page.getByText(/角色形象已保存/)).toBeVisible()
  await expect(page.locator('canvas[aria-label="资源实际预览"]:not([hidden])')).toHaveCount(1)
  await page.goto(`${server.origin}/characters/companion/config?tab=appearance#token=${server.token}`)
  await expect(page.getByRole('heading', { name: '形象与资源来源', exact: true })).toBeVisible()
  // DUX-02：companion 也有已保存资源（local-model），预览随其自身选择自动渲染 —— 旧画布必须先释放。
  await expect(page.getByText(/已保存的选择：local-model/)).toBeVisible()
  await expect(page.getByText(/正在预览：内建模型/)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('canvas[aria-label="资源实际预览"]:not([hidden])')).toHaveCount(1)

  assert.deepEqual(errors, [])
})

test('CUX-01 Live2D 导入后自动页内预览，且不激活', { timeout: 180000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = [], writes = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`) })

  // 真实 Live2D 包：复制内建包并改一个入口名，确保是「新登记」而不是复用内建。
  const pack = join(f.c.projectRoot, 'cux01-pack')
  await mkdir(pack, { recursive: true })
  await cp(join(f.root, 'desktop/assets/local-model'), join(pack, 'model'), { recursive: true })
  await rename(join(pack, 'model/pet.model3.json'), join(pack, 'model/cux01.model3.json'))
  await rm(join(pack, 'model/presets.json'), { force: true })

  const host = desktopHostManagement({
    async request(_method, input) {
      if (input.type === 'sprite') return { outcome: 'cancelled' }
      return { outcome: 'selected', source: pack, root: pack, displayName: 'cux01-pack', entries: [{ entry: 'model/cux01.model3.json' }] }
    },
  }, { instanceId: 'cux01-live2d', skins: f.skins })
  const server = await startServer(f, host)
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-01')
  await mkdir(reports, { recursive: true })

  const activeBefore = f.skins.state().activeSkinId
  await page.goto(`${server.origin}/characters/role-b/config?tab=appearance#token=${server.token}`)
  await page.getByRole('button', { name: '导入资源', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '资源导入' })
  await dialog.getByRole('button', { name: '选择模型包目录', exact: true }).click()
  await expect(dialog.getByText('已选择：cux01-pack', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('已导入并预览，尚未应用。', { exact: true })).toBeVisible()
  await expect(page.getByText(/正在预览：cux01-pack/)).toBeVisible()
  // 真实 Live2D 渲染出非空像素（不是诊断 JSON，也不是纹理图集）。
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas[aria-label="资源实际预览"]')
    if (!c || c.width < 2) return false
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    if (!gl) return false
    const pixels = new Uint8Array(4 * c.width * c.height)
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels.some((v, i) => i % 4 === 3 && v > 0)
  }, undefined, { timeout: 45000 })
  assert.equal(f.skins.state().activeSkinId, activeBefore, 'Live2D 导入不得激活')
  assert.equal(writes.some(entry => entry.includes('/activate')), false, `Live2D 导入不得调用 activate：${writes.join(', ')}`)
  assert.equal(f.roles.get('role-b').appearance.resourceId, 'local-model', '导入不得写角色保存选择')
  await page.screenshot({ path: join(reports, '01-2-import-auto-preview-live2d.png'), fullPage: true })
  assert.deepEqual(errors, [])
})

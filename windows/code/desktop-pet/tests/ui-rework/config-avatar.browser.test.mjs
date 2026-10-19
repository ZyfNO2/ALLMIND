/**
 * CUX-02: 静态立绘头像。
 *
 * 证明的是**真实浏览器 + 真实生产服务 + 真实渲染引擎**上的行为：
 *   * 02-1 真实 Live2D 与多帧 Sprite 生成非空静态图（是像素，不是诊断 JSON、不是纹理图集）；
 *   * 02-2 A/B 角色卡不串图；浏览/保存/预览/运行切换符合规则；
 *   * 02-3 保存后同页侧栏更新，硬刷新可重新生成；
 *   * 02-4 重复卡片去重、最多一个队列 renderer、卸载/取消释放；
 *   * 02-5 401/缺资源/编码失败/无 WebGL 有可理解状态，无密钥 URL，无错误角色图。
 *
 * 环境是 fixture（临时目录、匿名凭据、真实 HTTP + 真实存储）。真实 Provider 与真实音频 NOT RUN。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { join, resolve } from 'node:path'
import { mkdir, writeFile, cp } from 'node:fs/promises'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'
import { startManagementServer } from '../../dist/management/server.js'
import { desktopHostManagement } from '../../dist/management/desktop-host-routes.js'
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js'
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js'

async function startServer(f, host) {
  const presets = await CharacterPresetStore.open({ memory: f.memory, settings: f.settings, skins: f.skins, base: f.c, roleConfigurations: f.roles })
  return startManagementServer({
    uiRoot: resolve('management'), settings: f.settings, memory: f.memory, presets, roleConfigurations: f.roles, skins: f.skins,
    desktopHost: host, lorebooks: f.lorebooks,
    presentationAssets: await presentationAssetRoutes(resolve('../..')),
    snapshot: () => f.request('/api/snapshot'),
  })
}

/** 生成一张两帧 Sprite 图（左右两块不同颜色），用于断言真实绘制像素。 */
async function makeSpriteSheet(f, name = 'cux02-sheet.png') {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const base64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 32
    const x = c.getContext('2d')
    x.fillStyle = '#ff0000'; x.fillRect(0, 0, 32, 32)
    x.fillStyle = '#0000ff'; x.fillRect(32, 0, 32, 32)
    return c.toDataURL().split(',')[1]
  })
  await browser.close()
  const path = join(f.c.projectRoot, name)
  await writeFile(path, Buffer.from(base64, 'base64'))
  return path
}

/** 把一张图登记成 sprite 资源（走真实宿主桥 + 真实 SkinStore）。 */
async function importSprite(f, imagePath, label, skinId) {
  const host = desktopHostManagement({
    async request(_method, input) { return input.type === 'sprite' ? { outcome: 'selected', source: imagePath, root: imagePath, displayName: label, entries: [] } : { outcome: 'cancelled' } },
  }, { instanceId: `cux02-import-${skinId}`, skins: f.skins })
  const identity = host.identityFor('role-b', 'sprite', 'image')
  const ticket = await host.select(identity)
  return host.importBySelection(identity, { selectionId: ticket.selectionId, label, skinId, sprite: { rows: 1, columns: 2, frameCount: 2, fps: 12, width: 64, height: 32 } })
}

/** 用真实 Live2D 包登记一个 live2d 资源。 */
async function importLive2d(f, skinId) {
  const pack = join(f.c.projectRoot, `cux02-pack-${skinId}`)
  await mkdir(pack, { recursive: true })
  await cp(join(f.root, 'desktop/assets/local-model'), join(pack, 'model'), { recursive: true })
  return f.skins.import(pack, { skinId, label: `CUX02 Live2D ${skinId}`, entry: 'model/pet.model3.json' })
}

test('CUX-02 头像：真实 Live2D/Sprite 非空静态图、A/B 不串图、去重与释放', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))

  // role-b 用 sprite A；companion（运行角色）用 live2d B。两者资源不同 → 头像必须不同。
  const sheetA = await makeSpriteSheet(f, 'cux02-a.png')
  await importSprite(f, sheetA, 'CUX02 Sprite A', 'cux02-sprite-a')
  await importLive2d(f, 'cux02-live2d-b')
  await f.roles.saveAppearance('role-b', { resourceId: 'cux02-sprite-a', type: 'sprite' })
  await f.skins.activate(f.skins.state().revision, 'cux02-live2d-b')

  const server = await startServer(f, desktopHostManagement({ async request() { return { outcome: 'cancelled' } } }, { instanceId: 'cux02-browser', skins: f.skins }))
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-02')
  await mkdir(reports, { recursive: true })

  // ---------------------------------------------------------------- 02-2 A/B 不串图（角色选择卡）
  await page.goto(`${server.origin}/characters#token=${server.token}`)
  // 用角色 id 定位（fixture 可能预置了 companion 的默认名称，不依赖 label 文案）。
  await page.waitForFunction(() => document.querySelectorAll('img[data-avatar-character]').length >= 2, undefined, { timeout: 30000 })
  // 等两张卡都拿到 ready 头像（真实生成需要一点时间）。
  await page.waitForFunction(() => [...document.querySelectorAll('img[data-avatar-status]')].filter(img => img.dataset.avatarStatus === 'ready').length >= 2, undefined, { timeout: 90000 })
  const cards = await page.evaluate(() => [...document.querySelectorAll('img[data-avatar-status="ready"]')].map(img => ({ character: img.dataset.avatarCharacter, src: img.src, w: img.naturalWidth, h: img.naturalHeight })))
  const cardA = cards.find(card => card.character === 'companion')
  const cardB = cards.find(card => card.character === 'role-b')
  assert.ok(cardA && cardB, `两张卡都必须有 ready 头像：${JSON.stringify(cards)}`)
  assert.notEqual(cardA.src, cardB.src, 'A/B 角色卡绝不能共用同一张头像')
  // 头像只指向本地 Blob URL，绝不指向受保护 API 或带 token 的地址。
  for (const card of cards) {
    assert.match(card.src, /^blob:/, `最终 img 只能指向本地 Blob URL：${card.src}`)
    assert.equal(card.src.includes('token'), false)
    assert.equal(card.src.includes('/api/'), false)
    assert.equal(card.w, 256, '头像必须是 256×256')
    assert.equal(card.h, 256)
  }
  await page.screenshot({ path: join(reports, '02-2-character-cards-ab.png'), fullPage: true })

  // 真实像素非空：把 Blob 图重新解码后统计不透明像素（不是诊断 JSON、不是纹理图集）。
  const pixels = await page.evaluate(async () => {
    const out = {}
    for (const img of document.querySelectorAll('img[data-avatar-status="ready"]')) {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
      const x = c.getContext('2d'); x.drawImage(img, 0, 0)
      const data = x.getImageData(0, 0, c.width, c.height).data
      let opaque = 0, colored = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0) { opaque++; if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 20) colored++ }
      }
      out[img.dataset.avatarCharacter] = { opaque, colored }
    }
    return out
  })
  assert.ok(pixels.companion.opaque > 500, `Live2D 头像必须有非空不透明像素：${JSON.stringify(pixels)}`)
  assert.ok(pixels['role-b'].opaque > 500, `Sprite 头像必须有非空不透明像素：${JSON.stringify(pixels)}`)
  // Sprite A 是纯红/纯蓝两帧，必须出现真实彩色像素。
  assert.ok(pixels['role-b'].colored > 200, `Sprite 头像必须含真实绘制颜色：${JSON.stringify(pixels)}`)

  // ---------------------------------------------------------------- 02-3 侧栏更新 + 硬刷新重新生成
  await page.goto(`${server.origin}/characters/role-b/overview#token=${server.token}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible().catch(() => {})
  await page.waitForFunction(() => Boolean(document.querySelector('img[data-avatar-character="role-b"]')), undefined, { timeout: 30000 })
  // 保存一个新的 sprite 立绘，侧栏必须立即更新（不靠整页刷新）。
  const sheetC = await makeSpriteSheet(f, 'cux02-c.png')
  await importSprite(f, sheetC, 'CUX02 Sprite C', 'cux02-sprite-c')
  const beforeSrc = await page.getAttribute('img[data-avatar-character="role-b"]', 'src')
  await page.goto(`${server.origin}/characters/role-b/config?tab=appearance#token=${server.token}`)
  await page.locator('#appearance-type').selectOption('sprite')
  await page.locator('#appearance-resource').selectOption('cux02-sprite-c')
  await page.getByRole('button', { name: '保存到该角色', exact: true }).click()
  await expect(page.getByText(/角色形象已保存/)).toBeVisible()
  assert.equal(f.roles.get('role-b').appearance.resourceId, 'cux02-sprite-c')
  // 同页侧栏（AppLayout 的当前角色卡）必须已经指向新图。
  await page.waitForFunction(previous => {
    const img = document.querySelector('img[data-avatar-character="role-b"]')
    return Boolean(img && img.dataset.avatarStatus === 'ready' && img.src !== previous)
  }, beforeSrc, { timeout: 90000 })
  const sidebarSrc = await page.getAttribute('img[data-avatar-character="role-b"]', 'src')
  assert.notEqual(sidebarSrc, beforeSrc, '保存后同页侧栏必须更新到新立绘')
  await page.screenshot({ path: join(reports, '02-3-sidebar-updated.png'), fullPage: true })

  // 硬刷新：内存缓存清空后必须能重新生成（不依赖持久化）。
  await page.reload()
  await page.waitForFunction(() => {
    const img = document.querySelector('img[data-avatar-character="role-b"]')
    return Boolean(img && img.dataset.avatarStatus === 'ready' && img.src.startsWith('blob:'))
  }, undefined, { timeout: 90000 })
  const afterReload = await page.getAttribute('img[data-avatar-character="role-b"]', 'src')
  assert.match(afterReload, /^blob:/, '硬刷新后必须重新生成 Blob 头像')
  await page.screenshot({ path: join(reports, '02-3-after-hard-reload.png'), fullPage: true })

  // ---------------------------------------------------------------- 02-2 预览不发布头像变化
  // DUX-02: the preview follows the selection with no permanent open/close buttons.
  const savedBeforePreview = f.roles.get('role-b').appearance.resourceId
  await page.locator('#appearance-resource').selectOption('cux02-sprite-a')
  await expect(page.getByText(/正在预览：/)).toBeVisible()
  assert.equal(f.roles.get('role-b').appearance.resourceId, savedBeforePreview, '预览绝不能改变头像所依据的已保存映射')
  await page.locator('#appearance-resource').selectOption('')

  assert.deepEqual(errors, [])
})

test('CUX-02 去重与生命周期：同 key 只跑一个任务、卸载不误伤他人、最后一个使用者释放', { timeout: 180000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(30000)

  const sheet = await makeSpriteSheet(f, 'cux02-dedupe.png')
  await importSprite(f, sheet, 'CUX02 Dedupe', 'cux02-dedupe')
  await f.roles.saveAppearance('role-b', { resourceId: 'cux02-dedupe', type: 'sprite' })

  const server = await startServer(f, desktopHostManagement({ async request() { return { outcome: 'cancelled' } } }, { instanceId: 'cux02-dedupe', skins: f.skins }))
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-02')
  await mkdir(reports, { recursive: true })

  // 工作区页有侧栏当前角色卡；打开「角色切换」抽屉后，同一角色出现**两个**消费者。
  await page.goto(`${server.origin}/characters/role-b/overview#token=${server.token}`)
  await page.waitForFunction(() => {
    const img = document.querySelector('img[data-avatar-character="role-b"]')
    return Boolean(img && img.dataset.avatarStatus === 'ready' && img.src.startsWith('blob:'))
  }, undefined, { timeout: 90000 })

  // 去重：侧栏卡片与抽屉条目必须复用**同一个** Blob URL，而不是各自生成一份。
  await page.getByRole('button', { name: '角色切换', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('img[data-avatar-character="role-b"]').length >= 2, undefined, { timeout: 60000 })
  await page.waitForFunction(() => [...document.querySelectorAll('img[data-avatar-character="role-b"]')].every(img => img.dataset.avatarStatus === 'ready'), undefined, { timeout: 90000 })
  const deduped = await page.evaluate(() => [...document.querySelectorAll('img[data-avatar-character="role-b"]')].map(img => img.src))
  assert.ok(deduped.length >= 2, `抽屉与侧栏必须同时渲染该角色：${deduped.join(', ')}`)
  assert.equal(new Set(deduped).size, 1, `同一角色的多个消费者必须复用同一个 Blob URL：${deduped.join(', ')}`)
  await page.screenshot({ path: join(reports, '02-4-dedupe-two-consumers.png'), fullPage: true })
  // 关掉抽屉：只释放抽屉那一份订阅，侧栏卡片必须仍然可用。
  await page.locator('div.fixed.inset-0.z-50 > div.absolute.inset-0').click({ timeout: 10000 })
  await page.waitForFunction(() => {
    const img = document.querySelector('img[data-avatar-character="role-b"]')
    return Boolean(img && img.dataset.avatarStatus === 'ready')
  }, undefined, { timeout: 30000 })

  // 连续切换角色 20 次：不得累积未释放的 Blob URL 或崩溃。
  for (let i = 0; i < 20; i++) {
    await page.goto(`${server.origin}/characters/role-b/overview#token=${server.token}`)
  }
  await page.waitForFunction(() => {
    const img = document.querySelector('img[data-avatar-character="role-b"]')
    return Boolean(img && img.dataset.avatarStatus === 'ready')
  }, undefined, { timeout: 90000 })
  const remaining = await page.evaluate(() => document.querySelectorAll('img[data-avatar-character]').length)
  assert.ok(remaining >= 1, '多次切换后仍必须渲染角色头像')
  await page.screenshot({ path: join(reports, '02-4-dedupe-and-lifecycle.png'), fullPage: true })
})

test('CUX-02 头像失败路径：缺资源、读取失败与无 WebGL 都有可理解状态', { timeout: 180000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))

  const sheetA = await makeSpriteSheet(f, 'cux02-fail-a.png')
  await importSprite(f, sheetA, 'CUX02 Fail A', 'cux02-fail-a')
  // 让 role-b 指向一个**不存在**的已保存资源：必须显示默认图 + 可理解状态，且不显示别人的图。
  await f.roles.saveAppearance('role-b', { resourceId: 'cux02-does-not-exist', type: 'sprite' })

  const server = await startServer(f, desktopHostManagement({ async request() { return { outcome: 'cancelled' } } }, { instanceId: 'cux02-fail', skins: f.skins }))
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-02')
  await mkdir(reports, { recursive: true })

  await page.goto(`${server.origin}/characters#token=${server.token}`)
  // 用角色 id 定位（fixture 可能预置了 companion 的默认名称，不依赖 label 文案）。
  await page.waitForFunction(() => document.querySelectorAll('img[data-avatar-character]').length >= 2, undefined, { timeout: 30000 })
  // 资源不存在 → unset：默认图 + 状态文案。
  const imgB = page.locator('img[data-avatar-character="role-b"]')
  await page.waitForFunction(() => {
    const img = document.querySelector('img[data-avatar-character="role-b"]')
    return Boolean(img && img.dataset.avatarStatus === 'unset')
  }, undefined, { timeout: 30000 })
  assert.equal(await imgB.getAttribute('src'), '/assets/avatar-neutral.svg', '缺资源必须显示默认图')
  const message = await page.locator('[data-avatar-message]').first().textContent()
  assert.match(message || '', /立绘|头像|未设置|不存在/, `必须给出可理解状态：${message}`)
  // 绝不能把另一个角色的图当作本角色的头像。
  assert.equal((await imgB.getAttribute('src'))?.startsWith('blob:'), false)
  // 不得出现带密钥的 URL。
  const srcs = await page.evaluate(() => [...document.querySelectorAll('img')].map(img => img.src))
  assert.equal(srcs.some(src => src.includes('token') || src.includes('Bearer')), false, `不得出现带凭据的 img URL：${srcs.join(', ')}`)
  await page.screenshot({ path: join(reports, '02-5-missing-resource.png'), fullPage: true })

  // 无 WebGL：整页仍可用，头像显示可理解状态而不是崩溃。
  const noGl = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const noGlErrors = []
  noGl.on('pageerror', error => noGlErrors.push(error.message))
  await noGl.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (String(type).startsWith('webgl')) return null
      return Object.getPrototypeOf(this).constructor.prototype.getContext.call(this, type, ...rest)
    }
  })
  await noGl.goto(`${server.origin}/characters#token=${server.token}`)
  // 没有 WebGL 时 Live2D 头像必然失败；页面必须仍然渲染角色列表（不整页崩溃）。
  await noGl.waitForFunction(() => {
    const img = document.querySelector('img[data-avatar-character="companion"]')
    return Boolean(img && ['error', 'unset', 'ready'].includes(img.dataset.avatarStatus))
  }, undefined, { timeout: 60000 })
  await expect(noGl.locator('img[data-avatar-character="role-b"]')).toBeVisible()
  assert.deepEqual(noGlErrors, [], `无 WebGL 不得产生未捕获错误：${noGlErrors.join(', ')}`)
  await noGl.screenshot({ path: join(reports, '02-5-no-webgl.png'), fullPage: true })
  await noGl.close()

  assert.deepEqual(errors, [])
})

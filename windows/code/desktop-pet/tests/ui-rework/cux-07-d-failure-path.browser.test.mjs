/**
 * CUX-07 补充取证 D：D 失败路径的**用户可见行为**（隔离 fixture + 真实浏览器 + 真实 HTTP）。
 *
 * 为什么不直接在用户的真实实例上跑这一步：本计划 §4 明确要求「真实凭据写入须另有明确授权」。
 * 这一步会写入一条新凭据（这正是「凭据成功、来源未成功」那一半），因此**只在隔离 fixture 上做**。
 * 真实实例只做只读核对（见 cux-07-real-instance.browser.test.mjs）。
 *
 * 复现的输入严格对齐截图 4：自定义 OpenAI 兼容 endpoint + 用户新填的 Key + provider 沿用当前值。
 * 真实实例的只读证据（cux-07-real-instance.json）已确定 D 的现场是：
 *   * 凭据成功（两条 ofm 凭据），来源登记从未成功（provider-sources.json 不存在），绑定未写入；
 *   * 角色仍是 inherit-default，刷新后读到继承的全局默认（DeepSeek）—— 看起来就像「回退」。
 *
 * 本文件验证修复后 UI 在这条路径上的三件事：
 *   1. 明确区分「Key 已保存在本机」与「获取模型失败」，而不是笼统一句失败；
 *   2. 成功保存 Key 后明文立即清空，且不恢复；
 *   3. 这次失败尝试**绝不**写入绑定、不推进角色配置修订、不激活形象。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'
import { startManagementServer } from '../../dist/management/server.js'
import { desktopHostManagement } from '../../dist/management/desktop-host-routes.js'
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js'
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js'

const EVIDENCE = resolve('../../../validation/output/ui-rework-evidence/config-issues-20261009/cux-07')
const REPORTS = resolve('.local/reports/cux-07')
/** 明显的匿名 fixture Key：不是任何真实凭据。 */
const ANON_KEY = 'sk-anonymous-cux07-failpath-not-a-real-key'
/** 一个必然连不上的回环端口：避免任何真实外呼。 */
const DEAD_ENDPOINT = 'http://127.0.0.1:9/v1/chat/completions'

async function startServer(f) {
  const presets = await CharacterPresetStore.open({ memory: f.memory, settings: f.settings, skins: f.skins, base: f.c, roleConfigurations: f.roles })
  return startManagementServer({
    uiRoot: resolve('management'), settings: f.settings, memory: f.memory, presets, roleConfigurations: f.roles, skins: f.skins,
    selfSetup: f.selfSetup,
    desktopHost: desktopHostManagement({ async request() { return { outcome: 'cancelled' } } }, { instanceId: 'cux07-d', skins: f.skins }),
    lorebooks: f.lorebooks,
    presentationAssets: await presentationAssetRoutes(resolve('../..')),
    snapshot: () => f.request('/api/snapshot'),
  })
}

test('CUX-07 D 失败路径：凭据成功 + 发现失败时 UI 诚实报告两阶段，且不误写绑定', { timeout: 240000 }, async t => {
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
  await mkdir(EVIDENCE, { recursive: true })
  await mkdir(REPORTS, { recursive: true })

  // 起点对齐截图 4：该角色是 inherit-default。
  const before = await f.request('/api/characters/bindings?characterId=role-b')
  assert.equal(before.configuration.bindings.dialogue.mode, 'inherit-default', '复现起点必须是 inherit-default')
  const savedRevisionBefore = before.configuration.savedRevision
  const credentialsBefore = (await f.request('/api/self-setup')).credentials.length
  const sourcesBefore = (await f.request('/api/provider-sources')).entries.length

  await page.goto(`${server.origin}/characters/role-b/config?tab=model#token=${server.token}`)
  await expect(page.locator('#model-endpoint')).toBeVisible({ timeout: 60000 })

  // 截图 4 的同一条路径：自定义 endpoint + 新 Key。
  await page.locator('#model-endpoint').fill(DEAD_ENDPOINT)
  await page.locator('#model-key').fill(ANON_KEY)
  await expect(page.locator('#model-key-notice')).toBeVisible()
  await page.getByRole('button', { name: '保存 Key 并获取模型', exact: true }).click()

  // 1) 必须区分「Key 已保存在本机」与「获取模型失败」。
  const notice = page.getByText(/Key 已保存在本机；获取模型失败/)
  await expect(notice).toBeVisible({ timeout: 90000 })
  const failureText = String(await notice.textContent())
  // 2) 明文必须已清空且不恢复。
  const keyValueAfter = await page.locator('#model-key').inputValue()
  await page.screenshot({ path: join(REPORTS, 'real-06-d-failure-path-honest.png'), fullPage: true })

  // 3) 只读复核：绑定/修订/形象都不得被这次失败尝试改动。
  const after = await f.request('/api/characters/bindings?characterId=role-b')
  const credentialsAfter = (await f.request('/api/self-setup')).credentials.length
  const sourcesAfter = (await f.request('/api/provider-sources')).entries.length
  const skinsAfter = await f.request('/api/skins')

  const evidence = {
    method: 'isolated fixture + real browser + real HTTP; anonymous key; no real instance data touched',
    path: { endpoint: DEAD_ENDPOINT, keyKind: 'anonymous fixture key (not a real credential)' },
    screenshot4Input: { provider: 'custom-openai (generic id for a new connection)', model: 'deepseek-flash (unchanged)', endpoint: DEAD_ENDPOINT },
    observed: {
      noticeText: failureText,
      keyClearedAfterSuccess: keyValueAfter === '',
      bindingUnchanged: after.configuration.bindings.dialogue.mode === 'inherit-default' && after.configuration.savedRevision === savedRevisionBefore,
      credentialsDelta: credentialsAfter - credentialsBefore,
      providerSourcesBefore: sourcesBefore,
      providerSourcesAfter: sourcesAfter,
      activeSkinId: skinsAfter.state.activeSkinId,
    },
    writeRequests: writes,
  }
  await writeFile(join(EVIDENCE, 'cux-07-d-failure-path.json'), JSON.stringify(evidence, null, 2), 'utf8')

  assert.match(failureText, /Key 已保存在本机/, '必须明确说明 Key 已落盘')
  assert.match(failureText, /获取模型失败/, '必须明确说明发现阶段失败')
  assert.equal(keyValueAfter, '', '成功保存 Key 后明文必须立即清空')
  assert.equal(after.configuration.bindings.dialogue.mode, 'inherit-default', '这次失败尝试不得写入绑定')
  assert.equal(after.configuration.savedRevision, savedRevisionBefore, '这次失败尝试不得推进角色配置修订')
  assert.equal(credentialsAfter, credentialsBefore + 1, 'Key 必须真的已保存（「凭据成功、来源未成功」的那一半）')
  assert.equal(sourcesAfter, 0, '发现不登记来源（与真实实例 0 条来源一致）')
  assert.equal(writes.some(w => w.includes('/api/characters/bindings')), false, `不得写绑定：${writes.join(', ')}`)
  assert.equal(writes.some(w => w.includes('/activate')), false, `不得激活形象：${writes.join(', ')}`)
  assert.deepEqual(errors, [], `页面不得有未捕获错误：${errors.join(', ')}`)
})

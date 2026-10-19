/**
 * CUX-06: 模型页投影输出必须通过**真实生产校验**，而不是只拿到一个「形似正确」的对象。
 *
 * SPEC §4 明确要求：先用当前生产 `validateManagedSettings` / `ProviderSourceStore` 验证投影输出，
 * 再实现 UI。本文件做两件事：
 *   1. 把 `buildModelDraft` 的 selection 交给真实 `ProviderSourceStore.save()` + `roles.saveBindings()`，
 *      确认它真的能被登记与写回（不是 mock-only）；
 *   2. 用真实浏览器确认 model tab 只有五项主操作、隐藏字段不丢、STT/TTS 不回归。
 *
 * 环境是 fixture（临时目录、匿名凭据、真实 HTTP + 真实存储）。真实 ofm/推理/语音 NOT RUN。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'
import { startManagementServer } from '../../dist/management/server.js'
import { desktopHostManagement } from '../../dist/management/desktop-host-routes.js'
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js'
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js'

/** 打一次包，拿到投影/草稿纯函数。 */
async function modelFormModule(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aika-cux06-prod-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bundle = join(dir, 'model-form.mjs')
  buildSync({ entryPoints: ['management/character-ui/src/components/character/model-form.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm' })
  return import(pathToFileURL(bundle).href)
}

async function startServer(f) {
  const presets = await CharacterPresetStore.open({ memory: f.memory, settings: f.settings, skins: f.skins, base: f.c, roleConfigurations: f.roles })
  return startManagementServer({
    uiRoot: resolve('management'), settings: f.settings, memory: f.memory, presets, roleConfigurations: f.roles, skins: f.skins,
    selfSetup: f.selfSetup,
    desktopHost: desktopHostManagement({ async request() { return { outcome: 'cancelled' } } }, { instanceId: 'cux06', skins: f.skins }),
    lorebooks: f.lorebooks,
    presentationAssets: await presentationAssetRoutes(resolve('../..')),
    snapshot: () => f.request('/api/snapshot'),
  })
}

/** 登记一个凭据，返回它的 credentialRef。 */
async function saveCredential(f, provider, operationId) {
  const setup = await f.request('/api/self-setup')
  const receipt = await f.request('/api/self-setup/credentials', 'POST', {
    instanceId: setup.instanceId, provider, key: 'sk-anonymous-cux06-fixture',
    expectedRevision: setup.credentialRevision, operationId,
  })
  return receipt.credentialRef
}

test('CUX-06 投影输出通过真实 ProviderSourceStore + saveBindings 校验（非 mock-only）', { timeout: 120000 }, async t => {
  const f = await roleConsoleFixture(t)
  const { projectModelForm, buildModelDraft } = await modelFormModule(t)

  // 基线：把 role-b 的对话槽做成一个已审核的 own 绑定（走真实 HTTP）。
  const credentialRef = await saveCredential(f, 'openai', 'cux06-cred-baseline')
  const before = await f.request('/api/characters/bindings?characterId=role-b')
  const baselineSource = await f.request('/api/provider-sources', 'POST', {
    characterId: 'role-b', slot: 'dialogue', selection: {
      adapterId: 'openai-compatible-text', provider: 'openai', protocol: 'openai-compatible',
      endpoint: 'https://cux06.example.invalid/v1/chat/completions', credentialRef, model: 'cux06-baseline',
      inputTokenLimit: 8192, outputTokenLimit: 2048, reservationMicros: 10000, inputMicrosPerToken: 1, outputMicrosPerToken: 2,
    },
  })
  await f.request('/api/characters/bindings', 'PUT', {
    characterId: 'role-b', expectedRevision: before.configuration.savedRevision, operationId: 'cux06-baseline',
    bindings: { dialogue: { mode: 'own', sourceInstanceId: baselineSource.entry.source.sourceId, modelProfileId: baselineSource.entry.profile.modelProfileId, credentialRef } },
  })

  const snapshot = await f.request('/api/snapshot')
  const view = await f.request('/api/characters/bindings?characterId=role-b')
  const form = projectModelForm(view, snapshot.credentials)
  // 1) 未编辑隐藏字段：只改模型名 → 必须保留 adapter/protocol/provider/预算。
  const keepPlan = buildModelDraft({ ...form, model: 'cux06-renamed' }, { adapters: snapshot.adapters }, { touched: true })
  assert.equal(keepPlan.blocked, '', `未编辑隐藏字段不得被阻止：${keepPlan.blocked}`)
  const keepSource = await f.request('/api/provider-sources', 'POST', { characterId: 'role-b', slot: 'dialogue', selection: keepPlan.draft.selection })
  assert.equal(keepSource.entry.selection.adapterId, 'openai-compatible-text')
  assert.equal(keepSource.entry.selection.model, 'cux06-renamed')
  assert.equal(keepSource.entry.selection.inputTokenLimit, 8192, '真实校验后预算上界仍在')
  assert.equal(keepSource.entry.selection.reservationMicros, 10000)

  // 2) 换连接 + **显式复用** ofm 凭据：provider 必须取该凭据登记的 provider，投影输出才能被真实校验接受。
  const ofmRef = await saveCredential(f, 'ofm', 'cux06-cred-ofm')
  // 刷新快照：新建的凭据必须出现在可选列表里，否则「显式复用」无从选择。
  const snapshotAfter = await f.request('/api/snapshot')
  const formWithOfm = projectModelForm(view, snapshotAfter.credentials)
  const changed = buildModelDraft({
    ...formWithOfm, endpoint: 'http://127.0.0.1:18899/v1/chat/completions', model: 'ofm-real-model',
    key: '', useExisting: true, credentialRef: ofmRef,
  }, { adapters: snapshotAfter.adapters }, { touched: true })
  assert.equal(changed.blocked, '', `DeepSeek→ofm 类连接不得被阻止：${changed.blocked}`)
  assert.equal(changed.draft.selection.provider, 'ofm', '显式复用必须采用该凭据登记的 provider')
  assert.equal(changed.draft.selection.credentialRef, ofmRef)
  // 用**真实** ProviderSourceStore 校验。
  const ofmSource = await f.request('/api/provider-sources', 'POST', { characterId: 'role-b', slot: 'dialogue', selection: changed.draft.selection })
  assert.equal(ofmSource.entry.selection.provider, 'ofm')
  assert.equal(ofmSource.entry.selection.endpoint, 'http://127.0.0.1:18899/v1/chat/completions')
  assert.equal(ofmSource.entry.source.auth.ref, ofmRef, '保存凭据与来源必须同一 provider/引用')
  // 换连接时旧凭据不得被沿用：新引用就是显式选择的那个。
  assert.notEqual(changed.draft.selection.credentialRef, credentialRef)
  const changedSelection = changed.draft.selection
  // 真实写绑定并回读。
  const current = await f.request('/api/characters/bindings?characterId=role-b')
  const written = await f.request('/api/characters/bindings', 'PUT', {
    characterId: 'role-b', expectedRevision: current.configuration.savedRevision, operationId: 'cux06-ofm',
    bindings: { dialogue: { mode: 'own', sourceInstanceId: ofmSource.entry.source.sourceId, modelProfileId: ofmSource.entry.profile.modelProfileId, credentialRef: ofmRef } },
  })
  assert.equal(written.configuration.bindings.dialogue.mode, 'own')
  const reread = await f.request('/api/characters/bindings?characterId=role-b')
  assert.equal(reread.selections.dialogue.model, 'ofm-real-model', '真实回读必须看到新模型')
  assert.equal(reread.selections.dialogue.endpoint, 'http://127.0.0.1:18899/v1/chat/completions')
  assert.equal(reread.readErrors.dialogue, undefined, '合法来源不得报 readError')
  // 3) 缺预算基线必须被**真实校验**拒绝（而不是只在纯函数里被拦）。
  const noBudget = { ...changedSelection }
  for (const key of ['inputTokenLimit', 'outputTokenLimit', 'reservationMicros', 'inputMicrosPerToken', 'outputMicrosPerToken']) delete noBudget[key]
  await assert.rejects(
    f.request('/api/provider-sources', 'POST', { characterId: 'role-b', slot: 'dialogue', selection: noBudget }),
    error => error.status === 400,
    '缺调用上界的来源必须被真实校验拒绝',
  )
  // 4) 不合法 provider 也必须被真实校验拒绝。
  await assert.rejects(
    f.request('/api/provider-sources', 'POST', { characterId: 'role-b', slot: 'dialogue', selection: { ...changedSelection, provider: 'Not A Provider!' } }),
    error => error.status === 400,
  )
})

test('CUX-06 model tab 只有五项主操作；隐藏字段与 STT/TTS 不回归', { timeout: 240000 }, async t => {
  const f = await roleConsoleFixture(t)
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const server = await startServer(f)
  t.after(() => server.close())
  const reports = resolve('.local/reports/cux-06')
  await mkdir(reports, { recursive: true })

  // 基线：role-b 的对话槽是已审核的 own 绑定。
  const credentialRef = await saveCredential(f, 'openai', 'cux06-ui-cred')
  // STT 复用的凭据必须在页面加载**之前**就存在，否则页面的凭据列表里没有它。
  const sttCredential = await saveCredential(f, 'openai', 'cux06-voice-cred')
  const before = await f.request('/api/characters/bindings?characterId=role-b')
  const source = await f.request('/api/provider-sources', 'POST', {
    characterId: 'role-b', slot: 'dialogue', selection: {
      adapterId: 'openai-compatible-text', provider: 'openai', protocol: 'openai-compatible',
      endpoint: 'https://cux06-ui.example.invalid/v1/chat/completions', credentialRef, model: 'cux06-ui-baseline',
      inputTokenLimit: 8192, outputTokenLimit: 2048, reservationMicros: 10000, inputMicrosPerToken: 1, outputMicrosPerToken: 2,
    },
  })
  await f.request('/api/characters/bindings', 'PUT', {
    characterId: 'role-b', expectedRevision: before.configuration.savedRevision, operationId: 'cux06-ui-baseline',
    bindings: { dialogue: { mode: 'own', sourceInstanceId: source.entry.source.sourceId, modelProfileId: source.entry.profile.modelProfileId, credentialRef } },
  })

  await page.goto(`${server.origin}/characters/role-b/config?tab=model#token=${server.token}`)
  // 等到面板真正挂载（useAsync 先渲染 Spinner）。给足超时：并行跑测试时 CPU 可能很忙。
  await expect(page.locator('#model-endpoint')).toBeVisible({ timeout: 60000 })
  // 只断言**面板标题**（level 2），不是导航里的「模型」按钮。
  await expect(page.locator('h2:text-is("模型")')).toBeVisible()
  // 五项主操作必须都在。
  await expect(page.locator('#model-endpoint')).toBeVisible()
  await expect(page.locator('#model-key')).toBeVisible()
  await expect(page.locator('#model-discover')).toBeVisible()
  await expect(page.locator('#model-name')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible()
  // 被隐藏的字段不得出现在页面上（DOM 断言）。
  await expect(page.locator('#binding-dialogue-mode')).toHaveCount(0)
  await expect(page.locator('#binding-dialogue-adapter')).toHaveCount(0)
  await expect(page.locator('#binding-dialogue-protocol')).toHaveCount(0)
  await expect(page.locator('#binding-dialogue-provider')).toHaveCount(0)
  await expect(page.locator('#binding-dialogue-auth')).toHaveCount(0)
  await expect(page.locator('#binding-dialogue-credential')).toHaveCount(0)
  await expect(page.locator('#binding-dialogue-models-endpoint')).toHaveCount(0)
  await expect(page.locator('#binding-dialogue-inputTokenLimit')).toHaveCount(0)
  await expect(page.locator('#binding-dialogue-reservationMicros')).toHaveCount(0)
  // 页面标题不是「三组能力分别配置」。
  await expect(page.getByText(/三组能力分别配置/)).toHaveCount(0)
  // 工程修订 chip 不得常驻（只有待重启说明可以出现）。
  await expect(page.getByText(/保存修订 \d+ \/ 生效修订 \d+/)).toHaveCount(0)
  await page.screenshot({ path: join(reports, '06-1-five-fields.png'), fullPage: true })

  // 未编辑隐藏字段保存：只改模型名，真实 HTTP 必须保留 adapter/预算。
  const savedBefore = f.roles.get('role-b')
  await page.locator('#model-name').fill('cux06-ui-renamed')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText(/已保存，重启后生效/)).toBeVisible({ timeout: 60000 })
  const after = f.roles.get('role-b')
  assert.equal(after.bindings.dialogue.mode, 'own')
  const stored = f.roles.sources.resolve('dialogue', after.bindings.dialogue.sourceInstanceId, after.bindings.dialogue.modelProfileId)
  assert.ok(stored, 'own 绑定必须引用真实登记的来源')
  assert.equal(stored.selection.model, 'cux06-ui-renamed')
  assert.equal(stored.selection.adapterId, 'openai-compatible-text', '未编辑的 adapter 不得丢')
  assert.equal(stored.selection.provider, 'openai', '未编辑的 provider 不得丢')
  assert.equal(stored.selection.inputTokenLimit, 8192, '未编辑的预算上界不得丢')
  assert.equal(stored.selection.reservationMicros, 10000)
  assert.equal(stored.selection.credentialRef, credentialRef, '未编辑的凭据引用不得丢')
  assert.ok(after.savedRevision > savedBefore.savedRevision)
  await page.screenshot({ path: join(reports, '06-2-saved-hidden-fields-kept.png'), fullPage: true })

  // 硬刷新后仍显示已保存值。
  await page.reload()
  await expect(page.locator('#model-name')).toHaveValue('cux06-ui-renamed', { timeout: 30000 })
  await expect(page.locator('#model-endpoint')).toHaveValue('https://cux06-ui.example.invalid/v1/chat/completions')
  await expect(page.locator('#model-key')).toHaveValue('', { timeout: 5000 })

  // ---------------------------------------------------------------- voice tab 不回归
  await page.getByRole('button', { name: '语音', exact: true }).click()
  await expect(page.getByRole('region', { name: 'STT · 语音转文字' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'TTS · 文字转语音' })).toBeVisible()
  // voice tab 仍使用完整 BindingPanel：来源方式、适配器、高级参数都还在。
  // 注意：适配器/高级参数只在「角色独立来源」下渲染，所以先切到 own。
  const stt = page.getByRole('region', { name: 'STT · 语音转文字' })
  await expect(stt.getByLabel('来源方式')).toBeVisible()
  await stt.getByLabel('来源方式').selectOption('own')
  await expect(page.locator('#binding-stt-adapter')).toBeVisible()
  await expect(page.locator('#binding-stt-protocol')).toBeVisible()
  await expect(page.locator('#binding-stt-provider')).toBeVisible()
  await expect(page.locator('#binding-stt-auth')).toBeVisible()
  const tts = page.getByRole('region', { name: 'TTS · 文字转语音' })
  await tts.getByLabel('来源方式').selectOption('own')
  await expect(page.locator('#binding-tts-adapter')).toBeVisible()
  // 高级参数与计费仍完整保留（含语音专用费率）。
  const sttAdvanced = stt.locator('details').filter({ hasText: '高级参数与计费' })
  if (!(await sttAdvanced.evaluate(node => node.open))) await sttAdvanced.locator('summary').click()
  await expect(page.locator('#binding-stt-audioMicrosPerSecond')).toHaveCount(1)
  const ttsAdvanced = tts.locator('details').filter({ hasText: '高级参数与计费' })
  if (!(await ttsAdvanced.evaluate(node => node.open))) await ttsAdvanced.locator('summary').click()
  await expect(page.locator('#binding-tts-characterMicros')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: '本地能力诊断', exact: true })).toBeVisible()
  await page.screenshot({ path: join(reports, '06-6-voice-not-regressed.png'), fullPage: true })

  // voice 的保存仍然可用（STT 走真实 HTTP）。
  await stt.getByLabel('服务 / 适配器').selectOption('openai-compatible-asr')
  await stt.getByLabel('服务端点 · Endpoint').fill('https://cux06-voice.example.invalid/v1/audio/transcriptions')
  // 凭据下拉按 provider 过滤：把 provider 设成该凭据登记的 openai。
  await stt.getByLabel('供应商标识').fill('openai')
  await stt.getByLabel('鉴权').selectOption('credentialRef')
  await page.locator('#binding-stt-credential').selectOption(sttCredential)
  await stt.getByLabel('模型 · Model').fill('cux06-asr')
  await page.locator('#binding-stt-inputTokenLimit').fill('0')
  await page.locator('#binding-stt-outputTokenLimit').fill('0')
  await page.locator('#binding-stt-reservationMicros').fill('0')
  await page.locator('#binding-stt-inputMicrosPerToken').fill('0')
  await page.locator('#binding-stt-outputMicrosPerToken').fill('0')
  await page.locator('#binding-stt-audioMicrosPerSecond').fill('1')
  await stt.getByRole('button', { name: '保存绑定', exact: true }).click()
  await expect(page.getByText(/绑定已保存并回读/)).toBeVisible({ timeout: 60000 })
  assert.equal(f.roles.get('role-b').bindings.asr.mode, 'own', 'STT 保存不得回归')
  assert.equal(f.roles.get('role-b').bindings.dialogue.mode, 'own', '语音保存不得影响对话槽位')
  await page.screenshot({ path: join(reports, '06-6-voice-save-ok.png'), fullPage: true })

  assert.deepEqual(errors, [])
})

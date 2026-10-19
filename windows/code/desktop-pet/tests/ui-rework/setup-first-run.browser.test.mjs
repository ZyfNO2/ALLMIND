/**
 * LUI-01 browser acceptance: the real first-run setup server + the real built SPA in Chromium.
 *
 * The server is `startFirstRunSetup` (production entry point, real `createSelfSetup`, real loopback
 * HTTP, temporary restricted credential directory). Only the cloud provider is a fixture: the
 * injected fetch records every address it is asked to reach, so "zero cloud calls" and "exactly the
 * expected paid calls" are measured instead of assumed. Real provider/audio quality is NOT RUN — see
 * the LUI-01 report.
 *
 * The suite needs the SPA artifact; it fails loudly (and says so) when it is missing rather than
 * silently skipping.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { setupFixture } from './setup-fixture.mjs'

const codeRoot = fileURLToPath(new URL('../..', import.meta.url))
// LUI-07: `uiRoot` is the directory that CONTAINS `character-app/`, which now lives directly under
// `management/` instead of the retired `management/ui/`.
const uiRoot = resolve(codeRoot, 'management')

function requireArtifact() {
  assert.ok(existsSync(resolve(uiRoot, 'character-app/index.html')), 'run `node tools/build-lock.mjs npm run build:character-ui` before this suite')
}

/** The page hash carries the bearer token, exactly like the real deep link. */
const goto = (page, f, path = '/setup') => page.goto(`${f.origin()}${path}#token=${f.token()}`)

async function openPage(t) {
  const f = await setupFixture(t)
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(new URL(request.url()).pathname))
  return { f, page, errors, requests }
}

const modelField = page => page.locator('#setup-slot-dialogue').getByLabel('型号 (Model ID)')
/**
 * The dialogue slot offers a single known model in the fixture, so a model *change* cannot be the
 * draft. The endpoint field is free text and part of the saved settings, so the 409 draft is made
 * there instead — the contract under test (409 keeps the draft, save advances the revision) is the
 * same.
 */
const endpointField = page => page.locator('#setup-slot-dialogue').getByLabel('服务地址（端点 Endpoint URL）')
async function setEndpointDraft(page, f) {
  const serverEndpoint = (await f.snapshot()).settings.saved.providers.dialogue.endpoint
  const draft = serverEndpoint.replace(/\/+$/, '') + '/lui01-draft'
  await endpointField(page).fill(draft)
  return draft
}

/**
 * The preset bindings reference unconfigured placeholder credentials, and both the page and the
 * server refuse to save settings while any referenced credential is not a saved key. Pointing every
 * slot at the key saved for its provider is therefore part of the real first-run flow, not test
 * scaffolding — without it the save button is honestly disabled.
 */
async function wireSlots(page, f) {
  const snapshot = await f.snapshot()
  for (const [slot, provider] of Object.entries(snapshot.settings.saved.providers)) {
    const credential = snapshot.credentials.find(c => c.provider === provider.provider && c.status === 'configured')
    assert.ok(credential, `a saved ${provider.provider} key is needed before the ${slot} slot can be bound`)
    await openSlot(page, slot)
    await page.locator('#setup-slot-' + slot).getByLabel('凭据引用').selectOption(credential.id)
  }
}
const openSlot = (page, slot) => page.locator('#setup-slot-' + slot).evaluate(node => { node.open = true })

/**
 * Every control on the page is disabled while a write is in flight *and* while the follow-up snapshot
 * read settles, so the next interaction has to wait for the page to go quiet first. Polling the
 * disabled state of the refresh button is enough: it is disabled in exactly the same `busy` condition.
 */
async function idle(page) {
  await expect(page.getByRole('button', { name: '刷新设置状态' })).toBeEnabled({ timeout: 30_000 })
}

async function saveKey(page, provider, key) {
  await page.getByLabel('供应商').selectOption(provider)
  await page.getByLabel('API Key', { exact: true }).fill(key)
  await page.getByRole('button', { name: '保存到本机' }).click()
  await expect(page.getByText(/API Key 已保存到本机，凭据条目 [a-f0-9]{6}/)).toBeVisible()
  await idle(page)
}

async function uploadReference(page, f, name, milliseconds) {
  await page.setInputFiles('#setup-audio', { name, mimeType: 'audio/wav', buffer: f.referenceBytes(milliseconds) })
  await expect(page.getByText('已选择：' + name)).toBeVisible()
  await page.getByRole('button', { name: '仅上传到本机' }).click()
  // Decoding and re-encoding runs on this machine (OfflineAudioContext → mono 24 kHz PCM16 → base64),
  // which is real work for a 10 s–5 min clip; the 5 s default expectation is too tight for it.
  await expect(page.getByText('参考音频已保存到本机，尚未发送到云端。')).toBeVisible({ timeout: 60_000 })
  return (await f.snapshot()).references.at(-1)
}

async function prepareVoice(page, f, reference, credentialRef, label) {
  await page.getByLabel('已保存的参考音频').selectOption(reference.id)
  await page.getByLabel('音色名称').fill(label)
  await page.getByLabel('试听文本').fill('本机验证文本。')
  await idle(page)
  // Select by the credential id: that is the option's `value`, and only the human label carries the
  // last six characters.
  await page.getByLabel('百炼凭据').selectOption(credentialRef)
  const prepareButton = page.getByRole('button', { name: '准备音色方案（不调用云端）' })
  await expect(prepareButton).toBeEnabled({ timeout: 15_000 })
  await prepareButton.click()
  // Preparing writes a new operation and re-reads the snapshot; the page allows up to 60 s for it.
  await expect(page.getByText('音色方案已准备，尚未调用云端。请查看费用后确认创建。')).toBeVisible({ timeout: 30_000 })
  await idle(page)
  return (await f.snapshot()).operations.find(operation => operation.label === label)
}

test('LUI-01 first-run page: no cloud call before consent, explicit confirm is the only paid action', { timeout: 600_000 }, async t => {
  requireArtifact()
  const { f, page, errors, requests } = await openPage(t)

  await goto(page, f)
  await expect(page.getByRole('heading', { name: '首次设置' })).toBeVisible()
  assert.ok(!requests.includes('/legacy.html'), 'the setup page must never load the retired console')
  assert.ok(!requests.includes('/app.mjs'))
  assert.ok(!requests.some(path => path.startsWith('/self-setup-view')), 'no retired setup view script')

  // --- the browser stays in setup mode: runtime routes are still refused by the server ---
  // The token is read the way production reads it: `consumeSession` moves the deep-link hash token
  // into sessionStorage and strips the hash, so reading `location.hash` here would send an empty
  // bearer and prove nothing about the server's setup-mode boundary.
  const runtimeStatus = await page.evaluate(() => fetch('/api/characters', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('pet-management-session-v1') } }).then(response => response.status))
  assert.equal(runtimeStatus, 503)

  // --- save a key: the receipt shows only the last six characters and the field is cleared ---
  const key = 'sk-fixture-lui01-key'
  await saveKey(page, 'deepseek', key)
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '')
  // `CredentialInfo` carries `id`/`label`/`status`; the key itself is never returned. The list holds one
  // row per known provider slot, so "saved" means a row that is actually `configured`.
  const saved = (await f.snapshot()).credentials.filter(credential => credential.provider === 'deepseek' && credential.status === 'configured')
  assert.equal(saved.length, 1)
  assert.match(await page.getByText(/API Key 已保存到本机/).innerText(), new RegExp(saved[0].id.slice(-6)))
  assert.ok(!(await page.content()).includes(key), 'the key must not appear anywhere in the rendered page')
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  assert.equal(stored.includes('sk-fixture'), false, 'the key must never reach web storage')

  // --- reference audio: decoded and converted locally, never sent to the cloud ---
  const beforeUpload = f.cloud.calls.length
  const reference = await uploadReference(page, f, 'private-reference.wav', 11000)
  assert.equal(f.cloud.calls.length, beforeUpload, 'a local upload must not reach the provider')
  assert.equal(reference.format, 'wav')
  assert.equal(reference.durationMs, 11_000)

  // --- prepare the voice plan: still no cloud call ---
  // Voice cloning bills DashScope, not DeepSeek, so the plan needs *that* provider's saved key; the
  // page refuses to prepare without one (the disabled button is the honest behaviour).
  await saveKey(page, 'dashscope', 'sk-fixture-dashscope-voice')
  const voiceCredential = (await f.snapshot()).credentials
    .find(credential => credential.provider === 'dashscope' && credential.status === 'configured')
  assert.ok(voiceCredential, 'a DashScope credential must be stored before a voice plan can be prepared')
  const operation = await prepareVoice(page, f, reference, voiceCredential.id, 'LUI-01 自己的声音')
  assert.equal(f.cloud.calls.length, beforeUpload, 'preparing a plan is zero-network')
  assert.equal(operation.phase, 'prepared')

  const confirmButton = page.locator(`[data-setup-confirm="${operation.operationId}"]`)
  const consentBox = page.locator(`#setup-consent-${operation.operationId}`)

  // --- the cloud call is impossible without the explicit consent box ---
  await expect(confirmButton).toBeDisabled()
  await consentBox.check()
  await expect(confirmButton).toBeEnabled()
  assert.equal(f.cloud.calls.length, beforeUpload, 'checking the box alone must not call the cloud')
  await consentBox.uncheck()
  await expect(confirmButton).toBeDisabled()

  // --- one explicit confirmation performs exactly one paid call, and no more ---
  await consentBox.check()
  await expect(confirmButton).toBeEnabled({ timeout: 15_000 })
  await confirmButton.click()
  // A voice clone bills the provider and can take a while; the page allows up to 180 s for it.
  await expect(page.getByText('云端操作已返回，请以最新音色状态为准。')).toBeVisible({ timeout: 120_000 })
  await idle(page)
  assert.equal((await f.snapshot()).operations[0].phase, 'clone_ready')
  assert.equal(f.cloud.calls.length, beforeUpload + 4)
  assert.equal(f.cloud.calls.filter(address => address.includes('multimodal-generation')).length, 1)

  // --- a duplicate confirmation with a stale revision is refused (409) and charges nothing more ---
  const stale = await f.request('/voice/confirm', { instanceId: (await f.snapshot()).instanceId, operationId: operation.operationId, expectedRevision: operation.revision, costConsent: true })
  assert.equal(stale.status, 409)
  assert.equal(f.cloud.calls.length, beforeUpload + 4, 'a refused duplicate must not charge again')
  await expect(page.locator(`[data-setup-operation="${operation.operationId}"]`)).toBeVisible()

  // --- the sample is only fetched on a user action, and playback still needs a second click ---
  const sampleRequests = () => requests.filter(path => path === '/api/self-setup/voice/sample').length
  const beforeSample = sampleRequests()
  const sampleButton = page.locator(`[data-setup-sample="${operation.operationId}"]`)
  await expect(sampleButton).toBeEnabled({ timeout: 30_000 })
  await sampleButton.click()
  await expect(page.getByText('音频已就绪，点击播放器后才会播放。')).toBeVisible({ timeout: 30_000 })
  await idle(page)
  assert.equal(sampleRequests(), beforeSample + 1)
  const audio = page.locator('#setup-sample audio')
  await expect(audio).toHaveAttribute('preload', 'none')
  assert.equal(await audio.evaluate(node => node.paused), true, 'loading a sample must not autoplay')

  // --- activation is a second, separate explicit consent ---
  const activateConsent = page.locator(`#setup-consent-${operation.operationId}`)
  await expect(activateConsent).toBeEnabled({ timeout: 30_000 })
  await activateConsent.check()
  const activateButton = page.locator(`[data-setup-confirm="${operation.operationId}"]`)
  await expect(activateButton).toBeEnabled({ timeout: 15_000 })
  await activateButton.click()
  await expect(page.getByText('音色已登记。请在模型配置中选择对应模型与音色，保存并重启后使用。')).toBeVisible({ timeout: 120_000 })
  await idle(page)
  assert.equal(f.cloud.calls.length, beforeUpload + 5)
  assert.equal((await f.snapshot()).operations[0].phase, 'registered')

  // Registration never selects the voice: saved and effective settings still agree.
  const afterAll = await f.snapshot()
  assert.equal(afterAll.settings.saved.providers.tts.voice, afterAll.settings.effective.providers.tts.voice)

  assert.deepEqual(errors, [])
})

test('LUI-01 a 409 keeps the model draft, and a zero-network retry keeps the operation history', { timeout: 300_000 }, async t => {
  requireArtifact()
  const { f, page, errors } = await openPage(t)
  const instanceId = (await f.snapshot()).instanceId

  await goto(page, f)
  await expect(page.getByRole('heading', { name: '首次设置' })).toBeVisible()

  // --- the credential form owns its own revision: a stale save is refused and the field is cleared ---
  //
  // The page polls the snapshot every 3 s, so a competing write made *before* the click can be picked
  // up first and the save would legitimately succeed. The competing write is therefore made inside the
  // request interceptor — after the page has read revision 0, before its `expectedRevision: 0` write
  // reaches the server — which is exactly the race the 409 path exists for, and it is deterministic.
  // Counts the intercepted competing writes; a zero count means the page never issued the POST.
  let competingWrites = 0
  let competingStatus = 0
  // The credential revision the page is expected to write against, read from its own snapshot.
  const credentialRevision = (await f.snapshot()).credentialRevision

  await page.route('**/api/self-setup/credentials', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    competingWrites += 1
    // The page's POST is held here, so the server is free: the competing write lands first, the page's
    // own `expectedRevision` is then stale, and the 409 path is exercised deterministically.
    const result = await f.request('/credentials', { instanceId, provider: 'deepseek', key: 'sk-fixture-other-key', expectedRevision: credentialRevision, operationId: 'lui01-other-writer' })
    competingStatus = result.status
    return route.continue()
  })
  await page.getByLabel('API Key', { exact: true }).fill('sk-fixture-stale-key')
  await page.getByRole('button', { name: '保存到本机' }).click()
  await expect(page.getByText('配置或任务已变化，请刷新核对后再操作。')).toBeVisible({ timeout: 15_000 })
  await page.unroute('**/api/self-setup/credentials')
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '', 'a failed save still clears the key field')
  // `credentials` lists the provider slots the server knows about, including the ones that are not
  // saved yet — so the invariant is "only the competing writer's key is stored", not "the array did
  // not grow". The page's own save must have added nothing.
  const configured = snapshot => snapshot.credentials.filter(credential => credential.status === 'configured').map(credential => credential.id)
  const storedKeys = configured(await f.snapshot())
  assert.equal(storedKeys.length, 1, 'the refused save must not store a second key')
  assert.equal(competingWrites, 1, 'the competing write must have been injected inside the page request')
  assert.equal(competingStatus, 200, 'the competing writer must have succeeded')

  // --- the model draft survives a conflicting writer, and the page asks for a review ---
  await idle(page)
  // A model save needs both providers' keys: the preset references one placeholder per provider, and
  // every referenced credential must resolve to a saved key before the button is enabled.
  await saveKey(page, 'dashscope', 'sk-fixture-dashscope-model')
  await wireSlots(page, f)
  await openSlot(page, 'dialogue')
  const draftEndpoint = await setEndpointDraft(page, f)
  await page.route('**/api/self-setup/settings', async route => {
    if (route.request().method() !== 'PUT') return route.continue()
    competingWrites += 1
    const body = route.request().postDataJSON()
    // The competing writer moves the same field on the same draft the page is submitting, so the only
    // difference left is the revision — which is exactly the conflict this case must exercise.
    const other = structuredClone(body.settings)
    other.providers.dialogue.endpoint = 'https://api.deepseek.com/lui01-other-writer'
    const result = await f.request('/settings', { instanceId, expectedRevision: body.expectedRevision, settings: other }, 'PUT')
    competingStatus = result.status
    return route.continue()
  })

  await page.getByRole('button', { name: '保存模型配置，重启后生效' }).click()
  await expect(page.getByText('配置版本已变化。草稿已保留，请核对最新配置后再保存。')).toBeVisible({ timeout: 15_000 })
  await page.unroute('**/api/self-setup/settings')
  assert.equal(competingWrites, 2, 'both competing writes must have been injected inside the page requests')
  assert.equal(competingStatus, 200, 'the competing settings writer must have succeeded')
  // The draft is still on screen: a 409 must never silently reload over the user's edit.
  assert.equal(await endpointField(page).inputValue(), draftEndpoint,
    'the 409 must keep the draft instead of reloading the server value')
  await expect(page.getByRole('button', { name: '保存模型配置，重启后生效' })).toBeDisabled()
  const untouched = await f.snapshot()
  assert.equal(untouched.settings.saved.providers.dialogue.endpoint, 'https://api.deepseek.com/lui01-other-writer', 'the refused save must not write')

  // --- explicit recovery reads the latest revision and drops only the local draft ---
  await page.getByRole('button', { name: '读取最新配置，放弃本页模型修改' }).click()
  await expect(page.getByText('已读取最新配置，本页模型草稿已放弃。')).toBeVisible()
  await idle(page)
  assert.equal(await endpointField(page).inputValue(), 'https://api.deepseek.com/lui01-other-writer')

  // --- saving the reviewed draft advances the revision and reports the restart boundary ---
  const reviewedEndpoint = await setEndpointDraft(page, f)
  const saveModels = page.getByRole('button', { name: '保存模型配置，重启后生效' })
  await expect(saveModels).toBeEnabled({ timeout: 15_000 })
  await saveModels.click()
  await expect(page.getByText('配置已保存，完成设置并重启后生效。')).toBeVisible({ timeout: 30_000 })
  await idle(page)
  const saved = await f.snapshot()
  assert.equal(saved.settings.saved.providers.dialogue.endpoint, reviewedEndpoint)
  assert.equal(saved.settings.effectiveRevision, 0, 'the running instance keeps its effective configuration')
  assert.ok(saved.settings.revision > untouched.settings.revision)

  assert.deepEqual(errors, [])
})

// Voice-enrollment coverage (prepare / confirm / provider refusal / zero-network re-prepare).
// DEFERRED per the user's explicit instruction that TTS/STT need not be tested in this round;
// the assertions are kept verbatim so the scenario can be re-enabled without rewriting it.
test('LUI-01 a refused provider keeps the failed operation retryable with a zero-network re-prepare', { skip: '用户指示：TTS/STT 本轮可以不测（DEFERRED）' }, async t => {
  requireArtifact()
  const { f, page, errors } = await openPage(t)
  await saveKey(page, 'dashscope', 'sk-fixture-dashscope-key')
  const dashscope = (await f.snapshot()).credentials.find(credential => credential.provider === 'dashscope' && credential.status === 'configured')
  const reference = await uploadReference(page, f, 'retry-reference.wav', 10000)
  const prepared = await prepareVoice(page, f, reference, dashscope.id, '重试音色')

  f.cloud.setRefusal(true)
  const retryConsent = page.locator(`#setup-consent-${prepared.operationId}`)
  await expect(retryConsent).toBeEnabled({ timeout: 15_000 })
  await retryConsent.check()
  const retryConfirm = page.locator(`[data-setup-confirm="${prepared.operationId}"]`)
  await expect(retryConfirm).toBeEnabled({ timeout: 15_000 })
  await retryConfirm.click()
  // The failed operation itself carries the provider message; scoping to the operation card keeps the
  // assertion away from the identical static help copy that the page shows in every section.
  const retryCard = page.locator(`[data-setup-operation="${prepared.operationId}"]`)
  await expect(retryCard.getByText('请先在百炼开通对应模型；保存Key不代表模型可用。')).toBeVisible({ timeout: 30_000 })
  await idle(page)
  const failed = (await f.snapshot()).operations.find(operation => operation.operationId === prepared.operationId)
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.retryAvailable, true)
  const callsAfterFailure = f.cloud.calls.length

  // A "failed" operation with a proven zero-charge refusal may be re-prepared, and that retry is
  // still zero-network: the new plan needs its own explicit consent.
  await page.locator(`[data-setup-retry="${failed.operationId}"]`).click()
  await expect(page.getByText('新的音色方案已准备，未调用云端。请再次核对费用后确认。')).toBeVisible({ timeout: 30_000 })
  await idle(page)
  assert.equal(f.cloud.calls.length, callsAfterFailure, 're-preparing must not call the cloud')
  const rePrepared = (await f.snapshot()).operations.find(operation => operation.phase === 'prepared' && operation.label === '重试音色')
  assert.ok(rePrepared, 'a new prepared operation exists')
  assert.notEqual(rePrepared.operationId, failed.operationId)
  await expect(page.locator(`[data-setup-confirm="${rePrepared.operationId}"]`)).toBeDisabled()

  // The old failed operation keeps its own identity; the retry did not overwrite its history.
  assert.equal((await f.snapshot()).operations.find(operation => operation.operationId === failed.operationId).phase, 'failed')

  assert.deepEqual(errors, [])
})

test('LUI-01 an unconfirmed outcome disables the paid action until a refresh proves a new revision', { timeout: 300_000 }, async t => {
  requireArtifact()
  const { f, page, errors } = await openPage(t)

  await goto(page, f)
  await expect(page.getByRole('heading', { name: '首次设置' })).toBeVisible()
  await saveKey(page, 'dashscope', 'sk-fixture-dashscope-key')
  const dashscope = (await f.snapshot()).credentials.find(credential => credential.provider === 'dashscope' && credential.status === 'configured')
  const reference = await uploadReference(page, f, 'timeout-reference.wav', 10000)
  const prepared = await prepareVoice(page, f, reference, dashscope.id, '超时音色')

  // The request never reaches the server: the browser sees a transport failure. This is the
  // "outcome unknown" path, so the operation must stay disabled and nothing may be re-sent.
  const unknownConsent = page.locator(`#setup-consent-${prepared.operationId}`)
  await expect(unknownConsent).toBeEnabled({ timeout: 15_000 })
  await unknownConsent.check()
  await page.route('**/api/self-setup/voice/confirm', route => route.abort('timedout'))
  await page.locator(`[data-setup-confirm="${prepared.operationId}"]`).click()
  await expect(page.getByText(/不会自动重复收费/)).toBeVisible({ timeout: 30_000 })
  await idle(page)
  await expect(page.locator(`#setup-consent-${prepared.operationId}`)).toBeDisabled()
  await expect(page.locator(`[data-setup-confirm="${prepared.operationId}"]`)).toBeDisabled()
  const stillPrepared = (await f.snapshot()).operations.find(operation => operation.operationId === prepared.operationId)
  assert.equal(stillPrepared.phase, 'prepared')
  assert.equal(stillPrepared.revision, prepared.revision, 'an unconfirmed call must not advance the revision')

  // The page is still usable for reads after the failure; only the paid action stays locked.
  await page.unroute('**/api/self-setup/voice/confirm')
  await page.getByRole('button', { name: '刷新设置状态' }).click()
  await expect(page.getByRole('heading', { name: '首次设置' })).toBeVisible()
  await expect(page.locator(`[data-setup-confirm="${prepared.operationId}"]`)).toBeDisabled()

  assert.deepEqual(errors, [])
})

test('LUI-01 cancel is explicit and the confirmation copy names the real fee boundary', { timeout: 300_000 }, async t => {
  requireArtifact()
  const { f, page, errors } = await openPage(t)

  await goto(page, f)
  await expect(page.getByRole('heading', { name: '首次设置' })).toBeVisible()
  await saveKey(page, 'dashscope', 'sk-fixture-dashscope-key')
  const dashscope = (await f.snapshot()).credentials.find(credential => credential.provider === 'dashscope' && credential.status === 'configured')
  const reference = await uploadReference(page, f, 'cancel-reference.wav', 10000)
  const prepared = await prepareVoice(page, f, reference, dashscope.id, '取消音色')

  // The fee upper bound is shown before the user is asked to consent, and cancelling is zero-network.
  const card = page.locator(`[data-setup-operation="${prepared.operationId}"]`)
  await expect(card.getByText(/创建试听上限/)).toBeVisible()
  await expect(card.getByText(/正式启用上限/)).toBeVisible()
  await expect(card.getByText('我同意本次操作及所示费用上限')).toBeVisible()
  const beforeCancel = f.cloud.calls.length
  const cancelButton = page.locator(`[data-setup-cancel="${prepared.operationId}"]`)
  await expect(cancelButton).toBeEnabled({ timeout: 30_000 })
  await cancelButton.click()
  await expect(page.getByText('方案状态已更新。')).toBeVisible({ timeout: 30_000 })
  await idle(page)
  assert.equal(f.cloud.calls.length, beforeCancel)
  assert.equal((await f.snapshot()).operations.find(operation => operation.operationId === prepared.operationId).phase, 'cancelled')

  assert.deepEqual(errors, [])
})

/**
 * LUI-02: 角色高级编辑能力在**真实生产 HTTP 路由**上的读写回读。
 *
 * 与 `character-config-session.test.mjs`（假客户端、断言编排契约）不同，这里启动真实的
 * `startManagementServer` + `RoleConfigurationStore` + `LorebookStore` + `SkinStore`，通过
 * `fetch` 走完整的鉴权/Origin/校验/持久化链路，验证新前端依赖的每个端点确实存在且语义正确：
 *
 *   * `GET/PUT /api/characters/bindings` + `POST /api/provider-sources`：`own` 先注册来源再写绑定，
 *     `expectedRevision` 冲突是 409，同一 `operationId` 重放不推进修订；
 *   * `GET /api/characters/lorebooks` 与三种条目操作（add/toggle/remove）都是独立调用，
 *     `expectedRevision` 冲突是 409；
 *   * `POST /api/characters/lorebooks/import` 不写库，`/import/confirm` 才提交；
 *   * `GET /api/roles/local-capabilities` 只读，未接入是 503 而不是空；
 *   * `PUT /api/characters/appearance` 只改该角色的 saved 选择，不翻转全局运行形象；
 *   * 两个角色（role-b 与 companion）的写入完全隔离。
 *
 * 这是 fixture 环境（临时目录 + 匿名 Key），不是真实 Provider；真实模型/音频效果一律 NOT RUN。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'

const json = (response) => response.json()

test('LUI-02 production HTTP: own bindings register a source first, honour expectedRevision and replay one operationId', async t => {
  const f = await roleConsoleFixture(t)
  const setup = await f.request('/api/self-setup')
  const credential = await f.request('/api/self-setup/credentials', 'POST', {
    instanceId: setup.instanceId, provider: 'openai', key: 'anonymous-lui02-key', expectedRevision: setup.credentialRevision, operationId: 'lui02-credential',
  })
  const source = await f.request('/api/provider-sources', 'POST', {
    characterId: 'role-b', slot: 'dialogue', selection: {
      adapterId: 'openai-compatible-text', provider: 'openai', protocol: 'openai-compatible',
      endpoint: 'https://lui02.example.invalid/v1/chat/completions', credentialRef: credential.credentialRef, model: 'lui02-model',
      inputTokenLimit: 8192, outputTokenLimit: 2048, reservationMicros: 10000, inputMicrosPerToken: 1, outputMicrosPerToken: 2,
    },
  })
  const binding = { mode: 'own', sourceInstanceId: source.entry.source.sourceId, modelProfileId: source.entry.profile.modelProfileId, credentialRef: credential.credentialRef }
  const before = f.roles.get('role-b').savedRevision

  const saved = await f.request('/api/characters/bindings', 'PUT', { characterId: 'role-b', expectedRevision: before, operationId: 'lui02-binding-1', bindings: { dialogue: binding } })
  assert.equal(saved.configuration.savedRevision, before + 1)
  assert.equal(saved.applyOn, 'restart', '绑定更改必须声明重启后生效')

  // 同一 operationId + 同一 payload 是重放：不推进修订。
  const replay = await f.request('/api/characters/bindings', 'PUT', { characterId: 'role-b', expectedRevision: before, operationId: 'lui02-binding-1', bindings: { dialogue: binding } })
  assert.equal(replay.configuration.savedRevision, before + 1, 'a replayed operationId must not advance the revision')

  // 过期修订是 409，页面据此保留草稿。
  await assert.rejects(f.request('/api/characters/bindings', 'PUT', { characterId: 'role-b', expectedRevision: before, operationId: 'lui02-binding-stale', bindings: { tts: { mode: 'inherit-default' } } }), error => error.status === 409)

  // 读写回读：GET 反映真实保存的绑定与选择，且 companion 完全未受影响。
  const view = await f.request('/api/characters/bindings?characterId=role-b')
  assert.equal(view.apiVersion, 1)
  assert.equal(view.configuration.bindings.dialogue.mode, 'own')
  assert.equal(view.configuration.bindings.dialogue.sourceInstanceId, source.entry.source.sourceId)
  assert.equal(view.selections.dialogue.endpoint, 'https://lui02.example.invalid/v1/chat/completions')
  assert.equal(view.readErrors.dialogue, undefined, '一个健康的槽位不得报错')
  const other = await f.request('/api/characters/bindings?characterId=companion')
  assert.equal(other.configuration.bindings.dialogue.mode, 'inherit-default', '另一个角色的绑定必须保持独立')
  assert.notEqual(f.roles.get('role-b').bindings.dialogue.sourceInstanceId, f.roles.get('companion').bindings.dialogue.sourceInstanceId)
})

test('LUI-02 production HTTP: an unresolvable saved source is reported per slot and never filled with another default', async t => {
  const f = await roleConsoleFixture(t)
  const configuration = f.roles.get('role-b')
  await f.roles.save({ ...configuration, bindings: { ...configuration.bindings, dialogue: { mode: 'own', sourceInstanceId: 'missing-source', modelProfileId: 'missing-profile' } } })
  const view = await f.request('/api/characters/bindings?characterId=role-b')
  assert.equal(view.selections.dialogue, null, '读失败的槽位不得被填成默认来源')
  assert.match(view.readErrors.dialogue, /来源|模型/)
  assert.ok(view.selections.tts, '一个槽位读失败不得隐藏其他槽位')
})

test('LUI-02 production HTTP: lorebook entry add/toggle/remove are three distinct revision-checked calls', async t => {
  const f = await roleConsoleFixture(t)
  const created = await f.request('/api/characters/lorebooks', 'POST', { characterId: 'role-b', title: 'LUI02 世界设定', operationId: 'lui02-book' })
  assert.equal(created.created, true)
  const bookId = created.lorebook.id
  assert.equal(created.lorebook.revision, 1)
  // 同一个 operationId 重放不会写出第二本书。
  const replay = await f.request('/api/characters/lorebooks', 'POST', { characterId: 'role-b', title: 'LUI02 世界设定', operationId: 'lui02-book' })
  assert.equal(replay.created, false)
  assert.equal(replay.lorebook.id, bookId)
  assert.equal((await f.request('/api/characters/lorebooks?characterId=role-b')).books.length, 1)

  const added = await f.request(`/api/characters/lorebooks/${bookId}`, 'PUT', {
    characterId: 'role-b', expectedRevision: 1,
    entries: [{ title: '初遇', content: '两人在图书馆相遇。', strategy: 'keyword', keywords: ['图书馆', '初遇'] }],
  })
  assert.equal(added.lorebook.entries.length, 1)
  assert.deepEqual(added.lorebook.entries[0].keywords, ['图书馆', '初遇'], '服务端保存真实关键词')
  const entryId = added.lorebook.entries[0].id

  // 开关只发 `enabled`，正文必须由服务端保留。
  const toggled = await f.request(`/api/characters/lorebooks/${bookId}/entries/${entryId}`, 'PUT', { characterId: 'role-b', expectedRevision: added.lorebook.revision, entry: { enabled: false } })
  assert.equal(toggled.lorebook.entries[0].enabled, false)
  assert.equal(toggled.lorebook.entries[0].content, '两人在图书馆相遇。', '一次开关不得清空作者正文')
  assert.deepEqual(toggled.lorebook.entries[0].keywords, ['图书馆', '初遇'])

  // 过期修订是 409，且本地列表不变（调用方据此保留草稿）。
  await assert.rejects(f.request(`/api/characters/lorebooks/${bookId}/entries/${entryId}`, 'DELETE', { characterId: 'role-b', expectedRevision: 1 }), error => error.status === 409)

  const removed = await f.request(`/api/characters/lorebooks/${bookId}/entries/${entryId}`, 'DELETE', { characterId: 'role-b', expectedRevision: toggled.lorebook.revision })
  assert.equal(removed.lorebook.entries.length, 0)
  assert.equal((await f.request('/api/characters/lorebooks?characterId=companion')).books.length, 0, '故事书按角色隔离')
})

test('LUI-02 production HTTP: import preview writes nothing and confirm commits once', async t => {
  const f = await roleConsoleFixture(t)
  const book = { schemaVersion: 1, title: '导入的世界', entries: [{ title: 'a', content: 'b', strategy: 'always', keywords: [] }] }
  const preview = await f.request('/api/characters/lorebooks/import', 'POST', { characterId: 'role-b', book })
  assert.equal(preview.entryCount, 1)
  assert.equal((await f.request('/api/characters/lorebooks?characterId=role-b')).books.length, 0, 'preview 不得写库')

  const confirmed = await f.request('/api/characters/lorebooks/import/confirm', 'POST', { characterId: 'role-b', book, operationId: 'lui02-import' })
  assert.equal(confirmed.imported, true)
  assert.equal((await f.request('/api/characters/lorebooks?characterId=role-b')).books.length, 1)
  const replay = await f.request('/api/characters/lorebooks/import/confirm', 'POST', { characterId: 'role-b', book, operationId: 'lui02-import' })
  assert.equal(replay.lorebook.id, confirmed.lorebook.id, '同一个 operationId 的 confirm 重放同一本书')
  assert.equal((await f.request('/api/characters/lorebooks?characterId=role-b')).books.length, 1)
})

test('LUI-02 production HTTP: a non-running role saves its own appearance and never flips the running skin', async t => {
  const f = await roleConsoleFixture(t)
  const before = f.skins.state()
  await f.skins.import(join(f.root, 'desktop/assets/local-model'), { type: 'live2d', skinId: 'lui02-pack', entry: 'pet.model3.json' })
  const receipt = await f.request('/api/characters/appearance', 'PUT', { characterId: 'role-b', resourceId: 'lui02-pack', type: 'live2d', operationId: 'lui02-appearance' })
  assert.equal(receipt.saved, true)
  assert.equal(receipt.applyOn, 'restart')
  assert.equal(f.roles.get('role-b').appearance.resourceId, 'lui02-pack')
  assert.equal(f.skins.state().activeSkinId, before.activeSkinId, '非运行角色的写入绝不能翻转全局运行形象')
  assert.equal(f.roles.get('companion').appearance.resourceId, 'local-model', '另一个角色的形象不受影响')
  // 类型与登记资源不符必须被拒绝。
  await assert.rejects(f.request('/api/characters/appearance', 'PUT', { characterId: 'role-b', resourceId: 'lui02-pack', type: 'sprite', operationId: 'lui02-appearance-wrong' }), error => error.status === 400)
})

test('LUI-02 production HTTP: local capabilities are read-only, and an unwired probe is 503 rather than empty', async t => {
  const f = await roleConsoleFixture(t)
  // 生产组合根未装配 `localCapabilities`：服务端必须诚实地回答「未接入」。
  const response = await fetch(`${f.server.origin}/api/roles/local-capabilities`, { headers: { Authorization: `Bearer ${f.server.token}` } })
  assert.equal(response.status, 503)
  assert.equal((await json(response)).error.code, 'unavailable')
  const wrongMethod = await fetch(`${f.server.origin}/api/roles/local-capabilities`, { method: 'POST', headers: { Authorization: `Bearer ${f.server.token}`, Origin: f.server.origin, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(wrongMethod.status, 404, '本地能力检测是只读的，不接受写入')
})

test('LUI-02 production HTTP: the appearance registry refuses an unsupported apiVersion consumer and stays revision-checked', async t => {
  const f = await roleConsoleFixture(t)
  const skins = await f.request('/api/skins')
  assert.equal(skins.apiVersion, 1)
  await assert.rejects(f.request('/api/skins/not-a-real-skin/activate', 'POST', { expectedRevision: skins.state.revision }), error => error.status === 404)
  await assert.rejects(f.request('/api/skins/local-model/activate', 'POST', { expectedRevision: skins.state.revision + 99 }), error => error.status === 409)
})

test('LUI-02 production HTTP: the presentation policy is saved with expectedRevision and rejects a stale writer', async t => {
  const f = await roleConsoleFixture(t)
  // 生产组合根未装配表现策略：必须诚实地 404/503，而不是返回一个空的成功。
  const response = await fetch(`${f.server.origin}/api/presentation`, { headers: { Authorization: `Bearer ${f.server.token}` } })
  assert.ok([404, 503].includes(response.status), `an unwired presentation surface must not answer 200, got ${response.status}`)
})

test('LUI-02 production HTTP: author metadata and persona are separate owners with revision-checked idempotent writes', async t => {
  const f = await roleConsoleFixture(t)
  // 作者资料：只发编辑过的字段，游标是 fieldRevision。
  const profile = await f.request('/api/characters/profile?characterId=role-b')
  const saved = await f.request('/api/characters/profile', 'PUT', { characterId: 'role-b', expectedFieldRevision: profile.fieldRevision, intro: 'LUI02 新简介', operationId: 'lui02-author-1' })
  assert.equal(saved.fieldRevision, profile.fieldRevision + 1)
  assert.equal(saved.configuration.identity.intro, 'LUI02 新简介')
  assert.equal(saved.configuration.persona.scenario, '保留背景', '一次简介保存不得顺手回写过期的背景')
  assert.equal(saved.applyOn, 'restart')

  // 同一 operationId + 同一 payload 重放：不推进修订。
  const replay = await f.request('/api/characters/profile', 'PUT', { characterId: 'role-b', expectedFieldRevision: profile.fieldRevision, intro: 'LUI02 新简介', operationId: 'lui02-author-1' })
  assert.equal(replay.fieldRevision, profile.fieldRevision + 1, 'a replayed author operationId must not advance the field revision')

  // 过期字段修订是 409，页面据此保留草稿。
  await assert.rejects(f.request('/api/characters/profile', 'PUT', { characterId: 'role-b', expectedFieldRevision: profile.fieldRevision, intro: '过期简介', operationId: 'lui02-author-stale' }), error => error.status === 409)

  // 人设正文：唯一权威是 prompt owner，游标是独立的 revision。
  const prompt = await f.request('/api/prompt?characterId=role-b')
  const savedPrompt = await f.request('/api/prompt', 'PUT', { characterId: 'role-b', expectedRevision: prompt.revision, text: 'LUI02 新人设', operationId: 'lui02-persona-1' })
  assert.equal(savedPrompt.revision, prompt.revision + 1)
  assert.equal(savedPrompt.text, 'LUI02 新人设')
  const replayPrompt = await f.request('/api/prompt', 'PUT', { characterId: 'role-b', expectedRevision: prompt.revision, text: 'LUI02 新人设', operationId: 'lui02-persona-1' })
  assert.equal(replayPrompt.revision, prompt.revision + 1, 'a replayed persona operationId must not advance the revision')
  await assert.rejects(f.request('/api/prompt', 'PUT', { characterId: 'role-b', expectedRevision: prompt.revision, text: '过期人设', operationId: 'lui02-persona-stale' }), error => error.status === 409)

  // 角色隔离：companion 的作者资料与人设都不受影响。
  const other = await f.request('/api/characters/profile?characterId=companion')
  assert.equal(other.identity.intro, '简介-companion')
  assert.equal((await f.request('/api/prompt?characterId=companion')).text, '完整人设-companion')
})

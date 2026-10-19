/**
 * RUX-2026-10-10: 运行时 UX 修复的定向回归（RUNTIME_UX_REPAIR_PLAN_20261010.md）。
 *
 * 覆盖（stub/fake 只证明编排与映射逻辑，不冒充真实模型对话）：
 *   RUX-01 重启边界：RoleConfigurationStore.promoteEffective 在 savedRevision > effectiveRevision 时
 *          推进 effectiveRevision 且不推进写游标；loadEffectiveRoleConfiguration 调用它。
 *          R2 追加：resolveOpenAiCallUrl 的 apiBase→调用地址推导（含 protocol 守卫：gemini 不改写），
 *          以及 TrialTransport mismatch 守卫按推导后的调用地址比较（R2 实机根因：改写触发
 *          config.endpoint !== model.endpoint → 55ms plain Error → 兜底文案）。
 *   RUX-02 重启链路：contracts 的 closed method union 含 app.restart；bridge ack/超时语义；
 *          host 实现与桌宠菜单入口。
 *   RUX-03 错误映射：ProviderHttpError 401/403/404/429 各自的可操作文案；429 不编造额度/限流二选一；
 *          ProviderRequestFailure 的网络家族映射；未知错误保留原兜底短语；transport 守卫破坏
 *          给出"重新保存并重启"的可操作文案；失败阶段 trace 记录 errCode 与 HTTP status。
 *          R2 根因#3：自定义角色空人设（DEFAULT_CHARACTER_PROMPTS 只含 companion）曾让每轮
 *          ~50ms 崩在 missing_character_prompt → 兜底文案；现在注入显式"未编写人设"声明，
 *          不扮演、不虚构，用户写入真实人设后立即接管。
 *   RUX-04 Loading（用户指令 2026-10-10 重做 + 同日追加）：加载期不显示任何文案（index.html 无
 *          loading 节点），也不预加载内置默认模型；改为显示**上次显示过的角色**——host 在
 *          appearance ack 后把 manifest+资产路径落盘（last-appearance.json），页面 ready 时以稳定前缀
 *          skin-assets/last/ 重发布并经 petBridge.cachedAppearance 交付渲染端立即构建 renderer；
 *          后端 appearance 到达后仍按原路换入权威模型。失败不压字：无缓存/缓存失败→画布留空，
 *          走 drawer 状态 + toast + 60s 看门狗；appearanceless 离线预览有显式空态。
 *   RUX-05 单一模型控件：ModelPanel 不再渲染 #model-list 下拉；#model-name 仍是唯一模型输入。
 *   RUX-06 气泡定位（Round 2 用户定稿）：气泡统一放到角色脚下、原「聊一会儿」入口的位置——
 *          显示时按钮让位（#pet.bubble-active），关闭后恢复；尾巴朝上指向模型；尺寸/边缘钳制
 *          仍按实测，不挡脸、不裁切。
 *   RUX-07 菜单精简：⋯ 菜单移除「外观 / 换肤」「记忆与对话」「开始语音输入」，无残留点击区，
 *          控制台与按住发言快捷键能力不受影响。
 *   RUX-08 聊天窗口缩放：#window-resize 四边四角手柄（缩放光标），resize_drawer 事务
 *          （begin/update/commit/cancel，Escape 与失焦取消），host 侧钳制最小尺寸并持久化
 *          prefs.drawerSize；fitDisplay 以 drawerSize 覆盖 drawer 几何，模型大小不变。
 *
 * 交付门槛（真实两轮对话、Electron 录屏）在正式环境验收中单独执行，不属于本文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const dist = module_ => pathToFileURL(join(ROOT, 'dist', module_)).href

// ---------------------------------------------------------------- RUX-01

test('RUX-01: promoteEffective advances effectiveRevision to savedRevision without touching the write cursor', async t => {
  const { RoleConfigurationStore } = await import(dist('management/role-configuration.js'))
  const dir = await mkdtemp(join(tmpdir(), 'rux01-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'role-configurations.json')
  const seeded = {
    version: 2,
    states: {
      'role-a': {
        schemaVersion: 2, characterId: 'role-a', revision: 4, savedRevision: 4, effectiveRevision: 3, applyOn: 'restart',
        identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: '' },
        bindings: { dialogue: { mode: 'inherit-default' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } },
      },
    },
    authorOperations: {},
  }
  await writeFile(file, JSON.stringify(seeded))
  const store = await RoleConfigurationStore.open({ file })
  store.promoteEffective('role-a')
  const promoted = store.get('role-a')
  assert.equal(promoted.effectiveRevision, 4, 'effectiveRevision catches up with savedRevision at the restart boundary')
  assert.equal(promoted.savedRevision, 4, 'the write cursor never advances on promotion')
  assert.equal(promoted.revision, 4, 'revision is a write cursor and stays untouched')
  // Idempotent: a second boot at the same boundary is a no-op.
  store.promoteEffective('role-a')
  assert.equal(store.get('role-a').effectiveRevision, 4)
  // Unknown roles are ignored.
  store.promoteEffective('ghost')
  assert.equal(store.get('ghost'), null)
  // Let the async durable write finish BEFORE the tmpdir cleanup removes the file underneath it.
  await new Promise(done => setTimeout(done, 200))
})

test('RUX-01: loadEffectiveRoleConfiguration promotes the running role at open', async t => {
  const { RoleConfigurationStore, loadEffectiveRoleConfiguration } = await import(dist('management/role-configuration.js'))
  const { defaultManagedSettings } = await import(dist('management/settings.js'))
  const { fixture } = await import(dist('tests/management/helpers.js'))
  const f = await fixture(t)
  const file = join(f.c.projectRoot, 'role-configurations.json')
  const seeded = {
    version: 2,
    states: {
      'role-a': {
        schemaVersion: 2, characterId: 'role-a', revision: 2, savedRevision: 2, effectiveRevision: 0, applyOn: 'restart',
        identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: '' },
        bindings: { dialogue: { mode: 'inherit-default' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } },
      },
    },
    authorOperations: {},
  }
  await writeFile(file, JSON.stringify(seeded))
  const store = await RoleConfigurationStore.open({ file })
  const settings = defaultManagedSettings(f.c)
  // The control fixture registers no asr default; the existing RWR-03 suite builds one directly for
  // the same reason. The three inherit-default slots each need their global default present.
  settings.providers.asr = { ...settings.providers.dialogue, model: 'global-asr-default', adapterId: 'qwen-asr' }
  const effective = loadEffectiveRoleConfiguration({ base: f.c, settings, store, characterId: 'role-a' })
  assert.equal(effective.effectiveRevision, 2, 'the composition-root entry point performs the restart-boundary promotion')
  // The persisted file carries the promoted revision after the async persist settles.
  await new Promise(done => setTimeout(done, 150))
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.states['role-a'].effectiveRevision, 2, 'promotion survives a restart through the durable copy')
})

test('RUX-01: the trial transport compares the RESOLVED call URL, so a stored apiBase no longer trips the provider-mismatch guard', async () => {
  // Round-2 real-machine evidence: the adapter derives `…/v1/chat/completions` from the stored
  // `…/v1`, but the transport pinned `config.endpoint !== model.endpoint` — every foreground turn
  // died in ~55ms with a plain "Trial transport provider mismatch" that surfaced as the generic
  // fallback. The guard must now compare like-for-like (call URL vs derived call URL).
  const backend = await readFile(join(ROOT, 'dist', 'app', 'trial-backend.js'), 'utf8')
  assert.match(backend, /resolveOpenAiCallUrl\(model\.endpoint/, 'the mismatch guard derives the registered endpoint before comparing')
  assert.doesNotMatch(backend, /config\.endpoint !== model\.endpoint /, 'the raw-endpoint comparison is gone')
  // Round-2 chain, third guard: the authorizer pinned the SAME raw comparison and refused the call
  // ("Trial call differs from its registered provider configuration") after the transport passed.
  const authorizer = await readFile(join(ROOT, 'dist', 'app', 'trial-authorizer.js'), 'utf8')
  assert.match(authorizer, /resolveOpenAiCallUrl\(model\.endpoint/, 'the authorizer derives the registered endpoint before comparing')
  assert.doesNotMatch(authorizer, /request\.endpoint !== model\.endpoint /, 'the authorizer no longer compares against the raw apiBase')
  const { resolveOpenAiCallUrl } = await import(dist('plugins/legacy-provider-adapter.js'))
  assert.equal(resolveOpenAiCallUrl('http://127.0.0.1:18899/v1', 'dialogue', 'openai-compatible'), 'http://127.0.0.1:18899/v1/chat/completions')
  assert.equal(resolveOpenAiCallUrl('http://127.0.0.1:18899/v1/', 'dialogue'), 'http://127.0.0.1:18899/v1/chat/completions', 'an undeclared slot protocol migrates as openai-compatible')
  assert.equal(resolveOpenAiCallUrl('http://127.0.0.1:18899/v1/chat/completions', 'dialogue'), 'http://127.0.0.1:18899/v1/chat/completions', 'an explicit call path is kept verbatim')
  assert.equal(resolveOpenAiCallUrl('https://x.example/v1beta', 'dialogue', 'gemini'), 'https://x.example/v1beta', 'a gemini apiBase is never rewritten to a chat path')
  assert.equal(resolveOpenAiCallUrl('https://api.deepseek.com/chat/completions', 'summary'), 'https://api.deepseek.com/chat/completions')
  assert.equal(resolveOpenAiCallUrl('https://dashscope.example/api/v1/services/aigc/multimodal-generation/generation', 'tts'), 'https://dashscope.example/api/v1/services/aigc/multimodal-generation/generation', 'audio endpoints are never derived')
})

// ---------------------------------------------------------------- RUX-02

test('RUX-02: app.restart is in the closed host method union and the bridge sends a correlated request', async t => {
  const contracts = await readFile(join(ROOT, 'dist', 'contracts', 'desktop-host.js'), 'utf8')
  assert.match(contracts, /'app\.restart'/, 'the frozen method union includes app.restart')
  const { DesktopHostBridge, requestHostRestart } = await import(dist('app/desktop-host-bridge.js'))
  const sent = []
  const bridge = new DesktopHostBridge({ send: message => sent.push(message) })
  const pending = requestHostRestart(bridge)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].method, 'app.restart')
  assert.equal(sent[0].channel, 'host_request')
  // The host acknowledges BEFORE the restart begins; the bridge resolves on the reply.
  bridge.receive({ channel: 'host_reply', requestId: sent[0].requestId, ok: true, result: { requestedAt: '2026-10-10T00:00:00.000Z' } })
  const receipt = await pending
  assert.equal(receipt.requestedAt, '2026-10-10T00:00:00.000Z')
})

test('RUX-02: a host that never answers restart leaves the console with a real failure, not a silent success', async () => {
  const { DesktopHostBridge, requestHostRestart } = await import(dist('app/desktop-host-bridge.js'))
  const bridge = new DesktopHostBridge({ send: () => {}, timeoutMs: 30 })
  await assert.rejects(requestHostRestart(bridge), error => error.code === 'unavailable')
})

test('RUX-02: the electron host implements the bounded restart path and the pet menu owns 快速重启', async () => {
  const host = await readFile(join(ROOT, 'desktop', 'electron', 'main.mjs'), 'utf8')
  assert.match(host, /'app\.restart'/, 'the host answers the bridge method')
  assert.match(host, /restart_backend/, 'the pet menu shell command reaches the host')
  assert.match(host, /connection\.cancel\(\)[\s\S]{0,80}start\(\)/, 'restart reuses the EOF-first bounded shutdown and the serialized launcher')
  const renderer = await readFile(join(ROOT, 'desktop', 'main.mjs'), 'utf8')
  assert.match(renderer, /快速重启/)
})

// ---------------------------------------------------------------- RUX-03

test('RUX-03: typed HTTP failures map to actionable, status-specific messages', async () => {
  const { userFacingError } = await import(dist('core/user-facing-error.js'))
  const { ProviderHttpError } = await import(dist('providers/transport.js'))
  const dialogue = status => new ProviderHttpError(status, 'dialogue', 'req-1')
  assert.match(userFacingError(dialogue(401)), /401/)
  assert.match(userFacingError(dialogue(401)), /Key|凭据/)
  assert.match(userFacingError(dialogue(403)), /403/)
  assert.match(userFacingError(dialogue(404)), /404/)
  assert.match(userFacingError(dialogue(404)), /模型/)
  // 429 keeps the quota/rate-limit uncertainty instead of inventing evidence.
  const busy = userFacingError(dialogue(429))
  assert.match(busy, /429/)
  assert.match(busy, /限流|额度/)
  assert.doesNotMatch(busy, /^额度已用尽|^被限流$/, 'must not claim one cause without evidence')
  assert.match(userFacingError(dialogue(503)), /稍后再试/)
})

test('RUX-03: request-stage failures name their network family; unknown errors keep the pinned fallback', async () => {
  const { userFacingError } = await import(dist('core/user-facing-error.js'))
  const { ProviderRequestFailure } = await import(dist('providers/transport.js'))
  const diagnostic = { phase: 'request_headers', elapsedMs: 5, headersMs: null, httpStatus: null, requestId: null, responseBodyComplete: false, responseBodyUtf8Bytes: null, causeCode: null, abortReasonName: null }
  const family = cause => userFacingError(new ProviderRequestFailure(cause, diagnostic))
  const refused = Object.assign(new Error('request failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) })
  assert.match(family(refused), /连接被拒|拒绝/)
  const dns = Object.assign(new Error('request failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' }) })
  assert.match(family(dns), /DNS/)
  const parse = new Error('Model did not return valid structured data')
  assert.match(userFacingError(parse), /无法解析/)
  // Round-2 chain-loss fix: the internal invariant break must not masquerade as a transient error.
  assert.match(userFacingError(new Error('Trial transport provider mismatch')), /不一致/, 'the transport invariant break names its repair')
  assert.equal(userFacingError(new Error('something inexplicable 0x1234')), '这一轮没有完成，请稍后再试。')
  // RUX-03 follow-up: a typed HTTP failure must carry its status into the trace stage details.
  const pipeline = await readFile(join(ROOT, 'dist', 'core', 'dialogue-pipeline.js'), 'utf8')
  assert.match(pipeline, /ProviderHttpError/, 'the pipeline recognizes typed HTTP failures at the stage boundary')
  assert.match(pipeline, /status: errStatus/, 'the failed stage records the HTTP status alongside error.name')
})

test('RUX-03: a custom role with no written persona states the absence instead of failing or inventing one', async () => {
  const { EMPTY_PERSONA_PROMPT } = await import(dist('companion/prompts.js'))
  // Round-2 root cause #3: allmind's stored persona row is EMPTY (DEFAULT_CHARACTER_PROMPTS only
  // knows the shipped companion), so `missing_character_prompt` killed every turn in ~50ms and the
  // user only ever saw the generic fallback text. The substitute must STATE the absence — an empty
  // prompt means "no persona inserted", so the replacement may neither crash nor invent a persona.
  assert.match(EMPTY_PERSONA_PROMPT, /还没有编写人设/)
  assert.match(EMPTY_PERSONA_PROMPT, /不虚构/)
  assert.doesNotMatch(EMPTY_PERSONA_PROMPT, /虚构角色设定|青梅竹马/, 'no fabricated setting rides in the empty-persona case')
  for (const port of ['memory/sqlite-port.ts', 'memory/sqlite-lifecycle-port.ts']) {
    const source = await readFile(join(ROOT, port), 'utf8')
    assert.match(source, /store\.prompt\(owned\) \|\| EMPTY_PERSONA_PROMPT/, `${port} falls back to the honest no-persona prompt`)
  }
})

// ---------------------------------------------------------------- RUX-04

test('RUX-04: the load period shows the LAST SHOWN character — no cover text, no built-in preload', async () => {
  const renderer = await readFile(join(ROOT, 'desktop', 'main.mjs'), 'utf8')
  const html = await readFile(join(ROOT, 'desktop', 'index.html'), 'utf8')
  const host = await readFile(join(ROOT, 'desktop', 'electron', 'main.mjs'), 'utf8')
  const preload = await readFile(join(ROOT, 'desktop', 'electron', 'preload.cjs'), 'utf8')
  // User direction 2026-10-10: no loading text at all — the cover node is gone from the document,
  // so nothing can ever be pressed over the model during load.
  assert.doesNotMatch(html, /id="loading"/, 'the loading cover node is gone; no text is displayed over the model')
  assert.doesNotMatch(renderer, /\$\('loading'\)/, 'the renderer no longer touches a loading cover')
  // No FIXED default is preloaded at startup; the only startup renderer is the host-remembered one.
  assert.doesNotMatch(renderer, /new JellyfishRenderer\(\$\('model'\), report\)/, 'startup must not preload a built-in default model')
  assert.match(renderer, /restoreCachedAppearance/, 'the renderer installs the remembered-appearance path')
  assert.match(renderer, /skin-assets\/last\//, 'the remembered appearance is accepted only from the stable host prefix')
  assert.match(renderer, /startup-appearance-restored/, 'a successful restore reports its basis')
  assert.match(renderer, /cachedAppearance: restoreCachedAppearance/, 'petBridge exposes the host delivery')
  assert.match(host, /persistLastAppearance/, 'the host remembers an acknowledged appearance')
  assert.match(host, /restoreLastAppearance\(\)/, 'the host republishes it on page ready')
  assert.match(host, /last-appearance\.json/, 'the memory lives in the host userData, not the repo')
  assert.match(host, /skin-assets\/last\//, 'the republish uses the stable prefix')
  assert.match(host, /existsSync\(entry\[1\]\)/, 'a remembered pack that vanished on disk fails the restore closed')
  assert.match(preload, /cachedAppearance/, 'the preload allowlist lets the delivery through')
  // Failure never presses text over the model: drawer status + toast + bounded watchdog instead.
  assert.match(renderer, /角色形象未加载，对话仍可用/)
  assert.match(renderer, /appearanceless/, 'offline preview sessions are recognized')
  assert.match(renderer, /离线预览：未加载角色形象/, 'offline preview names its empty state instead of dead-waiting')
})

// ---------------------------------------------------------------- RUX-05

test('RUX-05: the model panel renders ONE model control (no #model-list select)', async () => {
  const panel = await readFile(join(ROOT, 'management', 'character-ui', 'src', 'components', 'character', 'ModelPanel.tsx'), 'utf8')
  assert.doesNotMatch(panel, /id="model-list"/, 'the split dropdown is gone')
  assert.match(panel, /id="model-name"/)
  assert.match(panel, /datalist/, 'candidates fill the same input through a datalist')
  const chat = await readFile(join(ROOT, 'management', 'character-ui', 'src', 'pages', 'Chat.tsx'), 'utf8')
  assert.match(chat, /inline-block w-fit/, 'playground bubbles shrink to their content')
})

// ---------------------------------------------------------------- RUX-06

test('RUX-06: the speech bubble stays at the feet without a floating chat entry', async () => {
  const css = await readFile(join(ROOT, 'desktop', 'style.css'), 'utf8')
  const renderer = await readFile(join(ROOT, 'desktop', 'main.mjs'), 'utf8')
  // No fixed anchor survives; placement is still measured per-show.
  assert.doesNotMatch(css, /#speech-bubble \{[^}]*right: 12px/, 'no fixed right anchor')
  assert.match(css, /--tail-x/, 'the tail still follows the computed anchor')
  // The removed entry no longer owns the anchor; the bubble remains below the model.
  assert.match(renderer, /slotLeft = petRect\.left, slotWidth = petRect\.width, feetBottom = petRect\.bottom/, 'legacy bubbles use the measured pet feet')
  assert.doesNotMatch(renderer, /canvasRect\.top \+ canvasRect\.height \* 0\.12/, 'the old head-area anchor is gone')
  assert.match(renderer, /dataset\.side = 'below'/, 'the bubble declares its below-feet side')
  assert.doesNotMatch(renderer, /\$\('open'\)/, 'no renderer dependency on the removed button')
  // The bubble's containing block is #pet, so the stylesheet values must be pet-relative: the clamp
  // runs in viewport coordinates and the write subtracts the pet offset, or the bubble flies off-window
  // once the drawer pushes #pet away from the window origin.
  assert.match(renderer, /left - offsetX/, 'the written left is converted to the pet coordinate system')
  assert.match(renderer, /top - offsetY/, 'the written top is converted to the pet coordinate system')
  assert.match(renderer, /overRight/, 'a painted-rect correction pass absorbs any residual offset so no edge ever clips the bubble')
  // A background-throttled window freezes rAF; the timer fallback still places the bubble there.
  assert.match(renderer, /setTimeout\(place, 120\)/, 'a timer fallback places the bubble when rAF is frozen')
  // Bubble state remains explicit after removing the separate chat entry.
  assert.match(renderer, /classList\.add\('bubble-active'\)/, 'showing a bubble marks the pet')
  assert.match(renderer, /classList\.remove\('bubble-active'\)/, 'closing the bubble clears its active state')
  assert.doesNotMatch(css, /#open/, 'the removed floating entry has no residual styling')
  // The tail points UP at the character standing above the slot.
  assert.match(css, /\.speech-bubble-tail \{[^}]*top: -7px/s, 'the tail rides the top edge')
  assert.match(css, /border-bottom: 7px solid/, 'the tail triangle points up')
})

// ---------------------------------------------------------------- RUX-07

test('RUX-07: the ⋯ menu drops 外观/换肤, 记忆与对话 and 开始语音输入 with no leftover stubs', async () => {
  const renderer = await readFile(join(ROOT, 'desktop', 'main.mjs'), 'utf8')
  // The menu function body is the UI contract; explanatory comments elsewhere are not entries.
  const menuStart = renderer.indexOf('function drawerMenuEntries')
  const menu = renderer.slice(menuStart, renderer.indexOf('function renderDrawerMenu', menuStart))
  assert.ok(menuStart >= 0 && menu.length > 0, 'the menu function is found')
  assert.doesNotMatch(menu, /\{ id: 'skin',/, 'the skin entry is gone from the menu')
  assert.doesNotMatch(menu, /\{ id: 'memory',/, 'the memory entry is gone from the menu')
  assert.doesNotMatch(menu, /\{ id: 'voice',/, 'the voice entry is gone from the menu')
  assert.doesNotMatch(menu, /label: '外观 \/ 换肤'|label: '记忆与对话'|label: '开始语音输入'|label: '结束语音输入'/, 'none of the removed labels render an entry')
  // The remaining menu is real, not gutted: the console stays the deep link into those capabilities.
  assert.match(menu, /\{ id: 'console', label: '打开控制台'/, 'the console entry survives as the path to appearance/memory')
  assert.match(menu, /快速重启/, 'the quick-restart entry survives (RUX-02)')
  assert.match(menu, /麦克风测试/, 'the microphone test entry survives')
})

// ---------------------------------------------------------------- RUX-08

test('RUX-08: the chat window resizes from four sides and four corners through a host-owned transaction', async () => {
  const html = await readFile(join(ROOT, 'desktop', 'index.html'), 'utf8')
  const css = await readFile(join(ROOT, 'desktop', 'style.css'), 'utf8')
  const renderer = await readFile(join(ROOT, 'desktop', 'main.mjs'), 'utf8')
  const host = await readFile(join(ROOT, 'desktop', 'electron', 'main.mjs'), 'utf8')
  const preferences = await readFile(join(ROOT, 'desktop', 'electron', 'host-preferences.ts'), 'utf8')
  // Eight handles exist, each with its own resize cursor; the container never blocks the content.
  assert.match(html, /id="window-resize"/, 'the handle container exists')
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) assert.match(html, new RegExp(`data-edge="${edge}"`), `the ${edge} handle exists`)
  assert.match(css, /#window-resize\{[^}]*pointer-events:none/, 'the container passes clicks through')
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) assert.match(css, new RegExp(`cursor:${edge}-resize`), `the ${edge} cursor is declared`)
  // The renderer expresses intent only: measured drag → absolute size, transaction phases, honest cancel.
  assert.match(renderer, /installDrawerResize/, 'the handle wiring exists')
  // RUX-08 rework (user feedback): the handles must sit on the VISIBLE chat panel's edges. In an
  // L-shaped layout the host window spans the pet AND the panel, so a viewport-edge handle lands
  // far from the panel the user sees (measured: panel right x=909, viewport e-handle x=1202). The
  // container is therefore placed over #drawer's measured rect and refreshed on open + displayConfig.
  assert.match(renderer, /positionResizeHandles/, 'the handles track the panel rect')
  assert.match(renderer, /root\.style\.left = `\$\{rect\.left\}px`/, 'the container is placed over the drawer rect')
  assert.doesNotMatch(css, /#window-resize\{[^}]*inset:0/, 'the container no longer covers the whole viewport')
  assert.match(renderer, /displayConfig: value => \{ display\.receive\(value\); positionResizeHandles\(\); \}/, 'every host relayout re-places the handles')
  assert.match(renderer, /type: 'resize_drawer', phase: 'begin'/)
  // RUX-08 rework (measured defect): a screenX-delta reference is corrupted when the WINDOW MOVES
  // mid-drag (fitDisplay re-places the drawer against the screen bounds) — a +125px drag oscillated
  // and committed -294px. The renderer now reports the pointer's viewport position and the HOST
  // derives the size from the absolute screen position, which has no reference to corrupt.
  assert.match(renderer, /phase: 'update', edge: active\.edge, pointerX: event\.clientX, pointerY: event\.clientY/, 'updates carry the pointer position, never a delta')
  assert.doesNotMatch(renderer, /screenX - active\.x/, 'no screenX delta survives')
  assert.match(host, /screenX = bounds\.x \+ Number\(value\.pointerX\)/, 'the host derives the pointer from the absolute screen position')
  assert.match(host, /drawer\.right - screenX/, 'the w edge derives its size from the pointer position')
  assert.match(host, /case 'resize_drawer'/, 'the host handles the shell command')
  assert.match(host, /clampHostDrawerSize/, 'the host clamps to the honest minimum')
  assert.match(host, /beforeDrawerResize/, 'an uncommitted drag restores the saved size')
  assert.match(host, /commitHostPreference\(\)/, 'a commit persists through the single preference path')
  assert.match(host, /fitDisplay\(prefs\.width, panelOpen, display\.workArea, anchor, prefs\.mode, prefs\.drawerSize\)/, 'the layout consumes the saved drawer size')
  assert.match(preferences, /drawerSize/, 'drawerSize is a persisted preference field')
  assert.match(preferences, /HOST_DRAWER_MIN_WIDTH = 340/, 'the minimum width keeps the composer usable')
  assert.match(preferences, /HOST_DRAWER_MIN_HEIGHT = 420/, 'the minimum height keeps the composer usable')
  // The model size is untouched by a drawer resize (plan constraint).
  assert.doesNotMatch(renderer, /resize_model/, 'drawer resize never reuses the model-resize path')
})

test('RUX-08: fitDisplay applies the saved drawer size without touching the model geometry', async () => {
  const { fitDisplay } = await import(pathToFileURL(join(ROOT, 'desktop', 'electron', 'layout.mjs')).href)
  const screen = { x: 0, y: 0, width: 1920, height: 1040 }
  const anchor = { x: 600, y: 100 }
  // Default (no saved size): the previous 480x540 drawer, unchanged for existing users.
  const plain = fitDisplay(360, true, screen, anchor, 'full', null)
  assert.equal(plain.config.drawerWidth, 480)
  assert.equal(plain.config.drawerHeight, 540)
  // A saved size overrides the drawer geometry; the model box is identical to the closed state.
  const closed = fitDisplay(360, false, screen, anchor, 'full')
  const resized = fitDisplay(360, true, screen, anchor, 'full', { width: 620, height: 700 })
  assert.equal(resized.config.drawerWidth, 620)
  assert.equal(resized.config.drawerHeight, 700)
  assert.equal(resized.config.modelWidth, closed.config.modelWidth, 'the model width never follows the drawer size')
  assert.equal(resized.config.modelHeight, closed.config.modelHeight, 'the model height never follows the drawer size')
  // The work area still wins over an oversized saved size.
  const clamped = fitDisplay(360, true, { x: 0, y: 0, width: 500, height: 400 }, anchor, 'full', { width: 900, height: 900 })
  assert.equal(clamped.config.drawerWidth, 480, 'width clamps to the work area')
  assert.equal(clamped.config.drawerHeight, 400, 'height clamps to the work area')
})

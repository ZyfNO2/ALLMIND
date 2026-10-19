/**
 * CUX-07 补充取证 B：**D 的最小失败复现**。
 *
 * 动机：CUX-07 §5 把「D 的真实根因」列为 NOT RUN。真实实例的只读证据显示：
 *   * `role-configurations.json` 里 `allmind` 是 `dialogue.mode = inherit-default`、`savedRevision = 0`；
 *   * `provider-sources.json` **根本不存在**（0 条来源登记）；
 *   * 但本机凭据库里有**两条 `ofm` 凭据**（2026-10-07T16:30:06 与 16:30:36，相隔 30 秒）。
 *
 * 这三条合起来指向一个具体假设：用户点「保存绑定」时**凭据写入成功**，但**来源登记失败**，
 * 因此绑定一个字节都没写；刷新后页面读到的仍是继承的全局默认（DeepSeek），看起来就像「回退」。
 * 这正是 CUX-00 §3 分类表里的「凭据/来源失败」，也是 CUX-04 要修的「不把部分成功包装成成功」。
 *
 * 本文件用截图 4 的**原始输入**在隔离 fixture 上复现该阶段失败，取得最小失败测试与准确错误文案。
 * 隔离环境，匿名 Key，不触碰真实实例数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'

/** 截图 4 的原始输入（endpoint 无 /chat/completions，provider=ofm，模型沿用 deepseek-flash）。 */
const SCREENSHOT_4 = {
  adapterId: 'openai-compatible-text',
  protocol: 'openai-compatible',
  provider: 'ofm',
  endpoint: 'http://127.0.0.1:18899/v1',
  model: 'deepseek-flash',
}

/** 登记一个 ofm 凭据，模拟用户在图 4 里填入的新 Key 已被 ensureCredential 落盘。 */
async function saveOfmCredential(f, operationId) {
  const setup = await f.request('/api/self-setup')
  const receipt = await f.request('/api/self-setup/credentials', 'POST', {
    instanceId: setup.instanceId, provider: 'ofm', key: 'sk-anonymous-cux07-ofm',
    expectedRevision: setup.credentialRevision, operationId,
  })
  return receipt.credentialRef
}

test('CUX-07 D 最小复现：凭据成功但来源登记失败时，绑定一个字节都不写', { timeout: 120000 }, async t => {
  const f = await roleConsoleFixture(t)
  const before = await f.request('/api/characters/bindings?characterId=allmind').catch(() => null)
  // fixture 预置的是 role-b/companion；用 allmind 复刻真实实例的角色名需要先登记。
  if (!before) {
    await f.request('/api/characters', 'POST', { label: 'ALLMIND', id: 'allmind', operationId: 'cux07-create-allmind' })
  }
  const credentialRef = await saveOfmCredential(f, 'cux07-cred-1')
  // 关键：凭据确实已落盘（这是真实实例里那两条 ofm 凭据的来源）。
  const setupAfter = await f.request('/api/self-setup')
  assert.equal(setupAfter.credentials.some(c => c.provider === 'ofm'), true, 'ofm 凭据必须已保存在本机')

  const savedBefore = await f.request('/api/characters/bindings?characterId=allmind')
  assert.equal(savedBefore.configuration.bindings.dialogue.mode, 'inherit-default', '复现起点：该角色是 inherit-default')
  const savedRevisionBefore = savedBefore.configuration.savedRevision

  // 阶段 2：登记来源。截图 4 的输入在这里必须被服务端拒绝，才能解释「凭据有、来源没有」。
  let sourceError = null
  try {
    await f.request('/api/provider-sources', 'POST', {
      characterId: 'allmind', slot: 'dialogue',
      selection: { ...SCREENSHOT_4, credentialRef, inputTokenLimit: 32768, outputTokenLimit: 393216, reservationMicros: 3_211_264, inputMicrosPerToken: 2, outputMicrosPerToken: 8 },
    })
  } catch (error) { sourceError = { status: error.status, code: error.code, message: error.message } }

  // 阶段 3：绑定写入**不会**发生（旧实现与现实现都在来源失败时终止）。
  const savedAfter = await f.request('/api/characters/bindings?characterId=allmind')

  const evidence = {
    screenshot4Input: SCREENSHOT_4,
    credentialSaved: true,
    sourceRegistration: sourceError ?? { status: 200, note: '本环境接受了该来源' },
    binding: {
      modeBefore: savedBefore.configuration.bindings.dialogue.mode,
      modeAfter: savedAfter.configuration.bindings.dialogue.mode,
      savedRevisionBefore,
      savedRevisionAfter: savedAfter.configuration.savedRevision,
      unchanged: savedBefore.configuration.bindings.dialogue.mode === savedAfter.configuration.bindings.dialogue.mode
        && savedRevisionBefore === savedAfter.configuration.savedRevision,
    },
    interpretation: sourceError
      ? '来源登记被拒绝 → 绑定未写入 → 刷新后仍读到继承的全局默认（DeepSeek）。这与真实实例的三条证据一致。'
      : '本环境接受了该来源；说明真实实例的失败点需要更多证据（保持 OPEN）。',
  }

  // 无论来源是否被接受，**绑定都不该在这次调用里被写入**（我们没调 PUT）。
  assert.equal(savedAfter.configuration.savedRevision, savedRevisionBefore, '没有 PUT 时修订不得推进')
  assert.equal(savedAfter.configuration.bindings.dialogue.mode, 'inherit-default', '没有 PUT 时模式不得改变')

  const { mkdir, writeFile } = await import('node:fs/promises')
  const dir = 'F:/workspace/project/docs/next/ui-rework/evidence/config-issues-20261009/cux-07'
  await mkdir(dir, { recursive: true })
  await writeFile(`${dir}/cux-07-d-minimal-repro.json`, JSON.stringify(evidence, null, 2), 'utf8')

  // 记录结论，但**不**据此断言 D 已定论：需要真实实例的回执才能定案。
  t.diagnostic(`来源登记结果：${JSON.stringify(sourceError ?? 'accepted')}`)
})

test('CUX-07 D 最小复现（续）：真实实例的 endpoint 形态是否被现有 resolver 接受', { timeout: 120000 }, async t => {
  const f = await roleConsoleFixture(t)
  const credentialRef = await saveOfmCredential(f, 'cux07-cred-2')
  await f.request('/api/characters', 'POST', { label: 'ALLMIND', id: 'allmind', operationId: 'cux07-create-allmind-2' }).catch(() => {})

  const base = { ...SCREENSHOT_4, credentialRef, inputTokenLimit: 32768, outputTokenLimit: 393216, reservationMicros: 3_211_264, inputMicrosPerToken: 2, outputMicrosPerToken: 8 }
  const variants = [
    ['截图 4 原样（http://127.0.0.1:18899/v1）', base],
    ['补 /chat/completions', { ...base, endpoint: 'http://127.0.0.1:18899/v1/chat/completions' }],
    ['缺调用上界（模拟未填高级参数）', { ...base, endpoint: 'http://127.0.0.1:18899/v1/chat/completions', inputTokenLimit: undefined, outputTokenLimit: undefined, reservationMicros: undefined, inputMicrosPerToken: undefined, outputMicrosPerToken: undefined }],
    ['provider 用 deepseek（旧代码 chooseAdapter 的默认）', { ...base, endpoint: 'http://127.0.0.1:18899/v1/chat/completions', provider: 'deepseek' }],
  ]
  const results = []
  for (const [label, selection] of variants) {
    const clean = Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== undefined))
    try {
      await f.request('/api/provider-sources', 'POST', { characterId: 'allmind', slot: 'dialogue', selection: clean })
      results.push({ label, accepted: true })
    } catch (error) {
      results.push({ label, accepted: false, status: error.status, code: error.code, message: error.message })
    }
  }

  const { mkdir, writeFile } = await import('node:fs/promises')
  const dir = 'F:/workspace/project/docs/next/ui-rework/evidence/config-issues-20261009/cux-07'
  await mkdir(dir, { recursive: true })
  await writeFile(`${dir}/cux-07-d-endpoint-variants.json`, JSON.stringify({ variants: results }, null, 2), 'utf8')
  for (const r of results) t.diagnostic(`${r.label} → ${r.accepted ? 'ACCEPTED' : `REJECTED ${r.status} ${r.message}`}`)
  assert.equal(results.length, 4)
})

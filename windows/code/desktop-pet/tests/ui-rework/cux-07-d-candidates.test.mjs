/**
 * CUX-07 补充取证 C：D 的候选失败模式枚举。
 *
 * 真实实例的只读证据（`cux-07-real-instance.json`）给出 D 的**取证签名**：
 *   * `allmind`：`dialogue.mode = inherit-default`、`savedRevision = 0`、`effectiveRevision = 0`；
 *   * `provider-sources.json` 不存在 → **0 条来源登记**；
 *   * 本机凭据库有**两条 `ofm` 凭据**（2026-10-07T16:30:06 与 16:30:36，相隔 30 秒）。
 *
 * 即：**凭据阶段成功，来源登记阶段从未成功，绑定因此一个字节都没写**；刷新后页面读到的仍是继承的
 * 全局默认（DeepSeek），看起来就是「回退」。
 *
 * 本文件枚举「旧 UI 在截图 4 那种操作下可能产生的 selection」，用**真实** ProviderSourceStore 判定
 * 哪几种会被拒绝，并记录服务端返回的**用户可见文案**（旧 UI 直接把它显示为「保存失败：…」）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { roleConsoleFixture } from '../management/role-console-fixture.mjs'
import { mkdir, writeFile } from 'node:fs/promises'

const DIR = 'F:/workspace/project/docs/next/ui-rework/evidence/config-issues-20261009/cux-07'

/** 已审核 DeepSeek 基线里解析出来的 budget（旧 UI 的 current.selection 来源）。 */
const DEEPSEEK_BUDGET = { inputTokenLimit: 32768, outputTokenLimit: 393216, reservationMicros: 3_211_264, inputMicrosPerToken: 2, outputMicrosPerToken: 8 }

async function saveCredential(f, provider, operationId) {
  const setup = await f.request('/api/self-setup')
  const receipt = await f.request('/api/self-setup/credentials', 'POST', {
    instanceId: setup.instanceId, provider, key: 'sk-anonymous-cux07-cand', expectedRevision: setup.credentialRevision, operationId,
  })
  return receipt.credentialRef
}

test('CUX-07 D 候选失败模式：哪些 selection 会被真实来源登记拒绝', { timeout: 180000 }, async t => {
  const f = await roleConsoleFixture(t)
  await f.request('/api/characters', 'POST', { label: 'ALLMIND', id: 'allmind', operationId: 'cux07-cand-create' })
  const ofmRef = await saveCredential(f, 'ofm', 'cux07-cand-ofm')
  const dsRef = await saveCredential(f, 'deepseek', 'cux07-cand-ds')

  const candidates = [
    ['A 完整：截图4 输入 + 继承的预算上界', { adapterId: 'openai-compatible-text', protocol: 'openai-compatible', provider: 'ofm', endpoint: 'http://127.0.0.1:18899/v1', model: 'deepseek-flash', credentialRef: ofmRef, ...DEEPSEEK_BUDGET }],
    ['B 高级参数为空（用户没展开、没填）', { adapterId: 'openai-compatible-text', protocol: 'openai-compatible', provider: 'ofm', endpoint: 'http://127.0.0.1:18899/v1', model: 'deepseek-flash', credentialRef: ofmRef }],
    ['C 只有部分预算（只填了输入上限）', { adapterId: 'openai-compatible-text', protocol: 'openai-compatible', provider: 'ofm', endpoint: 'http://127.0.0.1:18899/v1', model: 'deepseek-flash', credentialRef: ofmRef, inputTokenLimit: 32768 }],
    ['D 凭据引用为空（旧 chooseAdapter 会清空它）', { adapterId: 'openai-compatible-text', protocol: 'openai-compatible', provider: 'ofm', endpoint: 'http://127.0.0.1:18899/v1', model: 'deepseek-flash', credentialRef: '', ...DEEPSEEK_BUDGET }],
    ['E 凭据 provider 与选择 provider 不一致（ofm 选择 + deepseek 引用）', { adapterId: 'openai-compatible-text', protocol: 'openai-compatible', provider: 'ofm', endpoint: 'http://127.0.0.1:18899/v1', model: 'deepseek-flash', credentialRef: dsRef, ...DEEPSEEK_BUDGET }],
    ['F 没改 provider（旧 chooseAdapter 把它设成 dashscope）', { adapterId: 'openai-compatible-text', protocol: 'openai-compatible', provider: 'dashscope', endpoint: 'http://127.0.0.1:18899/v1', model: 'deepseek-flash', credentialRef: ofmRef, ...DEEPSEEK_BUDGET }],
  ]

  const results = []
  for (const [label, selection] of candidates) {
    try {
      const saved = await f.request('/api/provider-sources', 'POST', { characterId: 'allmind', slot: 'dialogue', selection })
      results.push({ label, accepted: true, sourceId: saved.entry.source.sourceId, authRefMatches: saved.entry.source.auth.ref === selection.credentialRef })
    } catch (error) {
      results.push({ label, accepted: false, status: error.status, code: error.code, userVisibleMessage: error.message })
    }
  }

  // 绑定是否被写入：这些候选只做来源登记，从不 PUT，所以 allmind 必须仍是 inherit-default。
  const view = await f.request('/api/characters/bindings?characterId=allmind')
  const binding = { mode: view.configuration.bindings.dialogue.mode, savedRevision: view.configuration.savedRevision }

  const accepted = results.filter(r => r.accepted)
  const rejected = results.filter(r => !r.accepted)
  await mkdir(DIR, { recursive: true })
  await writeFile(`${DIR}/cux-07-d-candidates.json`, JSON.stringify({
    method: 'isolated fixture, real ProviderSourceStore, anonymous keys; no real instance data touched',
    candidates: results,
    bindingAfterSourceOnly: binding,
    conclusion: {
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      genericMessageCandidates: rejected.map(r => r.userVisibleMessage),
    },
  }, null, 2), 'utf8')

  for (const r of results) t.diagnostic(`${r.label} → ${r.accepted ? 'ACCEPTED' : `REJECTED ${r.status}: ${r.userVisibleMessage}`}`)

  // 无论来源登记成功与否，只要没有 PUT，绑定就不该变化。
  assert.equal(binding.mode, 'inherit-default', '只登记来源不得改变绑定')
  assert.equal(binding.savedRevision, 0, '只登记来源不得推进角色配置修订')
  // 至少要有一种「旧 UI 可能产生」的输入被拒绝，否则说明这个假设不成立。
  assert.ok(rejected.length > 0, '必须至少复现一种被拒绝的候选输入，否则 D 的假设不成立')
})

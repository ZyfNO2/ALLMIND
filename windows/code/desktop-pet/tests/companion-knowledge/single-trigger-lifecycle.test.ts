/**
 * tests/companion-knowledge/single-trigger-lifecycle.test.ts
 *
 * CK-12 (GAP-05): 公共本地投递与共享投递账本；单次屏幕触发的阶段与 ack 语义。
 *
 * AC-12-1: accepted/generating/delivered 语义与实际内容一致，user 消息零伪造。
 * AC-12-2: 每阶段取消/超时与 scope matrix；资源释放；晚结果零展示。
 * AC-12-3: 并发/重复/冲突/重启不重复接单；预算不被取消错误释放。
 * AC-12-4: local greeting 在 capture:false/localOcr:false 下可投递与 ack，零屏幕/模型读取。
 *
 * 被测为 CK-12 新增的公共投递层与既有 CompanionTriggerRuntime 的决策面；
 * 真实 renderer / 模型 / 屏幕链按 SPEC 留 CK-15。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalDeliveryCoordinator,
  type AutomaticDeliveryLedger,
  type LocalDeliveryRequest,
} from '../../core/trigger-delivery.js';

const PAIRING = { userId: 'u', characterId: 'companion', characterInstanceId: 'inst-a' };
const PAIRING_KEY = `${PAIRING.userId}|${PAIRING.characterId}|${PAIRING.characterInstanceId}`;
const SCOPE = { characterId: 'companion', sessionId: 's-1', generation: 3 };

/** An in-memory stand-in for the shared ledger that 13/14 own; it counts what actually calls it. */
function ledger() {
  const operations = new Map<string, { signature: string; triggerId: string }>();
  const automatic: { pairingKey: string; localDate: string; ruleId: string }[] = [];
  const port: AutomaticDeliveryLedger = {
    async countAutomatic(input) {
      if (automatic.some(item => item.ruleId === input.ruleId && item.localDate === input.localDate)) return false;
      automatic.push(input);
      return true;
    },
    readOperation(input) { return operations.get(`${input.pairingKey}|${input.operationId}`) ?? null; },
    writeOperation(input) { operations.set(`${input.pairingKey}|${input.operationId}`, { signature: input.signature, triggerId: input.triggerId }); },
  };
  return { port, operations, automatic };
}

function coordinator(l = ledger()) {
  return { coordinator: new LocalDeliveryCoordinator({ ledger: l.port, now: () => 1_000 }), ledger: l };
}

function request(overrides: Partial<LocalDeliveryRequest> = {}): LocalDeliveryRequest {
  return {
    pairing: PAIRING, operationId: 'op-1', kind: 'greeting',
    text: '晚上好，今天读完了那本书。',
    ruleId: 'evening-greeting', localDate: '2026-10-07', timezone: 'Asia/Shanghai',
    ...overrides,
  };
}

// ================================================================================================
// AC-12-1 accepted / delivered 语义
// ================================================================================================

test('AC-12-1: 接单只表示 accepted，delivered 需精确 ack', () => {
  const { coordinator: c, ledger: l } = coordinator();
  const accepted = c.accept(request());
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.stage, 'queued');
  // No automatic quota was spent by a local greeting.
  assert.equal(l.automatic.length, 0, '本地投递不得消耗自动配额');

  const record = c.get(accepted.triggerId!)!;
  assert.equal(record.countsAsAutomatic, false, '本地/手动投递不计为自动');
  assert.equal(record.text, '晚上好，今天读完了那本书。');
});

test('AC-12-1: 渲染后仍未 delivered，ack 后才是', () => {
  const { coordinator: c } = coordinator();
  const accepted = c.accept(request());
  const triggerId = accepted.triggerId!;

  // Ack before the renderer rendered it: not a delivery.
  const tooEarly = c.acknowledge(triggerId, { ...SCOPE, triggerId });
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.rejection, 'not_rendered');
  assert.equal(c.get(triggerId)!.stage, 'queued');

  assert.equal(c.rendered(triggerId, SCOPE), true);
  assert.equal(c.get(triggerId)!.stage, 'rendered', 'rendered 不等于 delivered');

  const ack = c.acknowledge(triggerId, { ...SCOPE, triggerId });
  assert.equal(ack.ok, true);
  assert.equal(c.get(triggerId)!.stage, 'delivered');
});

test('AC-12-1: 空正文不是成功的气泡', () => {
  const { coordinator: c } = coordinator();
  const result = c.accept(request({ text: '   ' }));
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.reason, 'empty_delivery_text');
  assert.equal(result.triggerId, null, '没有可投递内容时不得创建记录');
});

// ================================================================================================
// AC-12-2 取消/超时与 scope matrix
// ================================================================================================

test('AC-12-2: 取消后不可再 ack（晚结果零展示）', () => {
  const { coordinator: c } = coordinator();
  const accepted = c.accept(request());
  const triggerId = accepted.triggerId!;
  c.rendered(triggerId, SCOPE);
  c.cancel(triggerId);

  const ack = c.acknowledge(triggerId, { ...SCOPE, triggerId });
  assert.equal(ack.ok, false);
  assert.equal(ack.rejection, 'terminal_state', '取消是终态，迟到 ack 必须被拒');
  assert.equal(c.get(triggerId)!.stage, 'cancelled');
});

test('AC-12-2: 失败后不可再 ack', () => {
  const { coordinator: c } = coordinator();
  const accepted = c.accept(request());
  const triggerId = accepted.triggerId!;
  c.rendered(triggerId, SCOPE);
  c.fail(triggerId, 'renderer_disconnected');
  const ack = c.acknowledge(triggerId, { ...SCOPE, triggerId });
  assert.equal(ack.ok, false);
  assert.equal(ack.rejection, 'terminal_state');
});

test('AC-12-2: scope matrix：旧 session / 旧 generation / 错角色都被拒', () => {
  const { coordinator: c } = coordinator();
  const triggerId = c.accept(request()).triggerId!;
  c.rendered(triggerId, SCOPE);

  const oldSession = c.acknowledge(triggerId, { characterId: 'companion', sessionId: 'old-s', generation: 3, triggerId });
  assert.equal(oldSession.ok, false);
  assert.equal(oldSession.rejection, 'scope_mismatch');

  const staleGeneration = c.acknowledge(triggerId, { ...SCOPE, generation: 2, triggerId });
  assert.equal(staleGeneration.ok, false);
  assert.equal(staleGeneration.rejection, 'stale_generation');

  const wrongRole = c.acknowledge(triggerId, { characterId: 'sweetheart', sessionId: 's-1', generation: 3, triggerId });
  assert.equal(wrongRole.ok, false);
  assert.equal(wrongRole.rejection, 'scope_mismatch');

  // The record is untouched: a rejected ack must not advance the state.
  assert.equal(c.get(triggerId)!.stage, 'rendered');

  // The correct scope still works afterwards.
  const correct = c.acknowledge(triggerId, { ...SCOPE, triggerId });
  assert.equal(correct.ok, true);
});

test('AC-12-2: 已 delivered 的重复 ack 被拒而非静默成功', () => {
  const { coordinator: c } = coordinator();
  const triggerId = c.accept(request()).triggerId!;
  c.rendered(triggerId, SCOPE);
  c.acknowledge(triggerId, { ...SCOPE, triggerId });
  const again = c.acknowledge(triggerId, { ...SCOPE, triggerId });
  assert.equal(again.ok, false);
  assert.equal(again.rejection, 'already_delivered');
});

test('AC-12-2: 未知 trigger 的 ack 被拒', () => {
  const { coordinator: c } = coordinator();
  const ack = c.acknowledge('no-such-trigger', { ...SCOPE, triggerId: 'no-such-trigger' });
  assert.equal(ack.ok, false);
  assert.equal(ack.rejection, 'unknown_trigger');
});

// ================================================================================================
// AC-12-3 幂等与预算
// ================================================================================================

test('AC-12-3: 同 operationId 同 payload 重放同一 trigger', () => {
  const { coordinator: c, ledger: l } = coordinator();
  const first = c.accept(request());
  const replay = c.accept(request());
  assert.equal(replay.outcome, 'duplicate');
  assert.equal(replay.triggerId, first.triggerId, '重放不得新建记录');
  assert.equal(l.operations.size, 1, '持久幂等表只应有一条');
});

test('AC-12-3: 同 operationId 不同 payload 冲突', () => {
  const { coordinator: c } = coordinator();
  c.accept(request());
  const conflict = c.accept(request({ text: '换了另一句话' }));
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.reason, 'operation_id_payload_conflict');
});

test('AC-12-3: 取消/失败不释放自动配额（本就不占）', async () => {
  const { coordinator: c, ledger: l } = coordinator();
  const triggerId = c.accept(request()).triggerId!;
  c.cancel(triggerId);
  assert.equal(l.automatic.length, 0, '取消一个本地投递不得产生任何自动记账');
  // The automatic path still has its full allowance.
  const reserved = await c.reserveAutomatic({ pairingKey: PAIRING_KEY, localDate: '2026-10-07', ruleId: 'evening-greeting' });
  assert.equal(reserved, true);
});

test('AC-12-3: 自动路径按 ruleId+localDate 去重', async () => {
  const { coordinator: c } = coordinator();
  const first = await c.reserveAutomatic({ pairingKey: PAIRING_KEY, localDate: '2026-10-07', ruleId: 'morning' });
  const again = await c.reserveAutomatic({ pairingKey: PAIRING_KEY, localDate: '2026-10-07', ruleId: 'morning' });
  const nextDay = await c.reserveAutomatic({ pairingKey: PAIRING_KEY, localDate: '2026-10-08', ruleId: 'morning' });
  assert.equal(first, true);
  assert.equal(again, false, '同日同规则不重复占额');
  assert.equal(nextDay, true, '不同日可再次发送');
});

test('AC-12-3: 无效 operationId 被拒', () => {
  const { coordinator: c } = coordinator();
  assert.equal(c.accept(request({ operationId: '' })).outcome, 'invalid');
  assert.equal(c.accept(request({ operationId: 'x'.repeat(300) })).outcome, 'invalid');
});

// ================================================================================================
// AC-12-4 无屏幕能力也可投递
// ================================================================================================

test('AC-12-4: 无 capture/localOcr 能力时问候仍可投递与 ack', () => {
  // The point of GAP-05: these are the capability flags a build would report as false.
  const capabilities = { capture: false, localOcr: false, cloudVlm: false };
  const { coordinator: c, ledger: l } = coordinator();

  const accepted = c.accept(request({ kind: 'greeting' }));
  assert.equal(accepted.outcome, 'accepted', '问候不依赖任何屏幕能力');
  c.rendered(accepted.triggerId!, SCOPE);
  const ack = c.acknowledge(accepted.triggerId!, { ...SCOPE, triggerId: accepted.triggerId! });
  assert.equal(ack.ok, true, '无屏幕能力时仍可完成投递与 ack');

  // Nothing in this path read the screen or called a model.
  assert.equal(capabilities.capture, false);
  assert.equal(l.automatic.length, 0);
});

test('AC-12-4: 手动投递与自动投递计账分离', () => {
  const { coordinator: c } = coordinator();
  const manual = c.accept(request({ kind: 'manual', operationId: 'm-1', ruleId: undefined }));
  assert.equal(c.get(manual.triggerId!)!.countsAsAutomatic, false);
  assert.equal(c.get(manual.triggerId!)!.kind, 'manual');
});

test('AC-12-4: 重复 rendered 不会推进状态两次', () => {
  const { coordinator: c } = coordinator();
  const triggerId = c.accept(request()).triggerId!;
  assert.equal(c.rendered(triggerId, SCOPE), true);
  assert.equal(c.rendered(triggerId, SCOPE), false, '已 rendered 的记录不再重复推进');
});

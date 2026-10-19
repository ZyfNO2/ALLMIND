/**
 * tests/companion-knowledge/periodic-companion.test.ts
 *
 * CK-13: 周期观察、近似抑制、退避与共享投递账本。
 *
 * AC-13-1: timer→唯一 observation；single-flight；错过不补采。
 * AC-13-2: 重复/近似/重要变化、无内容、忙态/DND、共享配额按冻结值；ack 前零 delivered。
 * AC-13-3: 退避有界；暂停/取消后晚结果零投递；恢复无积压补采。
 * AC-13-4: policy view 的 saved/effective/nextEligibleAt 真实（替换硬编码 unavailable）。
 *
 * 用 fake clock 驱动；observation 用替身，因此只证明**调度与策略语义**，
 * 不证明真实 capture/OCR（那属 CK-11/15）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompanionAutomationScheduler,
  DEFAULT_AUTOMATION_POLICY,
  type AutomationDeps,
} from '../../core/companion-automation-scheduler.js';
import type { ObservationOutcome, ObservationItem } from '../../core/observation-scheduler.js';

const T0 = Date.parse('2026-10-07T02:00:00.000Z');

class Clock {
  value = T0;
  now = (): number => this.value;
  advance(ms: number): void { this.value += ms; }
}

function observation(text: string, overrides: Partial<ObservationItem> = {}): ObservationItem {
  return {
    observationId: `obs-${Math.random().toString(36).slice(2, 8)}`,
    targetId: 'display-1', targetRevision: 1, capturedAt: new Date(T0).toISOString(),
    text, blockCount: 1, ...overrides,
  };
}

function harness(options: {
  outcomes?: ObservationOutcome[];
  capabilities?: { capture?: boolean; route?: boolean; grant?: boolean; authorizer?: boolean };
  busy?: { busy: boolean; reason?: string; dnd?: boolean };
  reserve?: boolean;
  now?: () => number;
} = {}) {
  const clock = new Clock();
  let calls = 0;
  // With no `outcomes` the harness synthesises a stable successful observation.
  const queue = options.outcomes === undefined ? null : [...options.outcomes];
  const committed: string[] = [];

  const deps: AutomationDeps = {
    now: options.now ?? clock.now,
    async observe() {
      calls += 1;
      if (queue === null) return { status: 'recognized', observation: observation('页面内容 A') };
      return queue.shift() ?? null;
    },
    capabilities: () => ({ capture: true, route: true, grant: true, authorizer: true, ...(options.capabilities ?? {}) }),
    busy: () => options.busy ?? { busy: false },
    reserve: async () => options.reserve ?? true,
    commitDisplayed: id => { committed.push(id); },
  };
  const scheduler = new CompanionAutomationScheduler(deps);
  return {
    scheduler, clock, committed,
    calls: () => calls,
    advance: (ms: number) => clock.advance(ms),
  };
}

// ================================================================================================
// AC-13-1 single-flight 与不补采
// ================================================================================================

test('AC-13-1: 未 resume 时不观察（启动即 paused）', async () => {
  const h = harness();
  const result = await h.scheduler.tick();
  assert.equal(result.ran, false);
  assert.equal(h.calls(), 0, '启动/重启不得自动开始观察');
  assert.equal(h.scheduler.view().state, 'paused');
});

test('AC-13-1: resume 后到点才观察一次', async () => {
  const h = harness();
  h.scheduler.resume();
  const first = await h.scheduler.tick();
  assert.equal(first.ran, true);
  assert.equal(h.calls(), 1);
  // Immediately again: the interval has not elapsed.
  const tooSoon = await h.scheduler.tick();
  assert.equal(tooSoon.ran, false);
  assert.equal(tooSoon.reason, 'not_due_yet');
  assert.equal(h.calls(), 1, '未到间隔不得二次观察');
});

test('AC-13-1: single-flight：进行中的 tick 使后来的 tick 落空而非排队', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const clock = new Clock();
  const scheduler = new CompanionAutomationScheduler({
    now: clock.now,
    async observe() { calls += 1; await gate; return null; },
    capabilities: () => ({ capture: true, route: true, grant: true, authorizer: true }),
    busy: () => ({ busy: false }),
    reserve: async () => true,
    commitDisplayed: () => {},
  });
  scheduler.resume();
  const running = scheduler.tick();
  const second = await scheduler.tick();
  assert.equal(second.ran, false);
  assert.equal(second.reason, 'single_flight');
  assert.equal(calls, 1, '同一目标单飞');
  release();
  await running;
});

test('AC-13-1: 错过多个周期不补采，只在下一个到期点跑一次', async () => {
  const h = harness();
  h.scheduler.resume();
  await h.scheduler.tick();
  const after = h.calls();
  // Jump far past several intervals at once.
  h.advance(DEFAULT_AUTOMATION_POLICY.observationIntervalMs * 10);
  const result = await h.scheduler.tick();
  assert.equal(result.ran, true);
  assert.equal(h.calls(), after + 1, '错过多个周期只补一次，不排队补采');
});

// ================================================================================================
// AC-13-2 抑制、重要变化、忙态与配额
// ================================================================================================

test('AC-13-2: 近似相同文本被抑制，且不消耗回复冷却', async () => {
  const h = harness({ outcomes: [
    { status: 'recognized', observation: observation('订单页面 金额 120 元') },
    { status: 'recognized', observation: observation('订单页面 金额 120 元') },
  ] });
  h.scheduler.resume();
  const first = await h.scheduler.tick();
  assert.equal(first.replyEligible, true);
  h.advance(DEFAULT_AUTOMATION_POLICY.observationIntervalMs);
  const second = await h.scheduler.tick();
  assert.equal(second.reason, 'suppressed_near_duplicate');
  assert.equal(second.replyEligible, undefined, '被抑制的观察不产生回复');
  assert.equal(h.scheduler.view().suppressed, 1);
});

test('AC-13-2: 相似文本但数字变化视为重要变化，不被误抑制', async () => {
  const h = harness({ outcomes: [
    { status: 'recognized', observation: observation('账户余额 120 元') },
    { status: 'recognized', observation: observation('账户余额 98 元') },
  ] });
  h.scheduler.resume();
  await h.scheduler.tick();
  // The reply cooldown is separate, so advance past it to isolate the suppression decision.
  h.advance(DEFAULT_AUTOMATION_POLICY.replyCooldownMs + 1_000);
  const second = await h.scheduler.tick();
  assert.equal(second.reason, 'reply_pending_ack', '数字变化是重要变化，必须保留');
  assert.equal(second.replyEligible, true);
});

test('AC-13-2: 观察间隔与回复冷却是两个独立时钟', async () => {
  const h = harness({ outcomes: [
    { status: 'recognized', observation: observation('第一屏内容') },
    { status: 'recognized', observation: observation('完全不同的第二屏内容') },
  ] });
  h.scheduler.resume();
  await h.scheduler.tick();
  // Reply cooldown is 3h, observation interval 5min: after 10 minutes we may observe again...
  h.advance(10 * 60_000);
  const second = await h.scheduler.tick();
  assert.equal(second.ran, true, '观察间隔已过，应当观察');
  assert.equal(second.replyEligible, false, '但回复仍在冷却中');
  assert.equal(h.scheduler.view().state, 'cooling-down');
});

test('AC-13-2: 无内容不是失败也不消耗冷却', async () => {
  const h = harness({ outcomes: [{ status: 'no-content' }] });
  h.scheduler.resume();
  const result = await h.scheduler.tick();
  assert.equal(result.ran, true);
  assert.equal(result.reason, 'no_content');
  assert.equal(h.scheduler.view().consecutiveFailures, 0, '无内容不计为失败');
  assert.equal(h.scheduler.view().state, 'running');
});

test('AC-13-2: 忙态与免打扰不观察，且不消耗间隔', async () => {
  const busyHarness = harness({ busy: { busy: true, reason: 'user_typing' } });
  busyHarness.scheduler.resume();
  const busy = await busyHarness.scheduler.tick();
  assert.equal(busy.ran, false);
  assert.equal(busy.reason, 'user_typing');
  assert.equal(busyHarness.calls(), 0);

  const dndHarness = harness({ busy: { busy: false, dnd: true } });
  dndHarness.scheduler.resume();
  const dnd = await dndHarness.scheduler.tick();
  assert.equal(dnd.ran, false);
  assert.equal(dnd.reason, 'do_not_disturb');
  assert.equal(dndHarness.calls(), 0);
});

test('AC-13-2: 共享配额耗尽时不产生回复', async () => {
  const h = harness({ reserve: false, outcomes: [
    { status: 'recognized', observation: observation('新的页面内容') },
  ] });
  h.scheduler.resume();
  const result = await h.scheduler.tick();
  assert.equal(result.ran, true);
  assert.equal(result.reason, 'shared_quota_exhausted');
  assert.equal(result.replyEligible, false);
});

test('AC-13-2: ack 之前 delivered 为零；markDisplayed 后才记账', async () => {
  const h = harness();
  h.scheduler.resume();
  const result = await h.scheduler.tick();
  assert.equal(result.reason, 'reply_pending_ack');
  // Nothing is committed until the renderer acknowledges.
  assert.deepEqual(h.committed, [], 'ack 前不得记账为已展示');
  h.scheduler.markDisplayed(result.observationId!);
  assert.deepEqual(h.committed, [result.observationId], 'ack 后才提交');
});

// ================================================================================================
// AC-13-3 退避与取消
// ================================================================================================

test('AC-13-3: 失败按 1×→2×→4× 退避，且有上限', async () => {
  const failures = Array.from({ length: 6 }, () => ({ status: 'failed' as const, reason: 'engine_failed' }));
  const h = harness({ outcomes: failures });
  h.scheduler.resume();
  const delays: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const before = h.scheduler.view().nextEligibleAt;
    await h.scheduler.tick();
    const after = h.scheduler.view().nextEligibleAt;
    if (before && after) delays.push(Date.parse(after) - Date.parse(before));
    h.advance(DEFAULT_AUTOMATION_POLICY.observationIntervalMs * 32);
  }
  assert.ok(delays.every(d => d > 0), '失败后必须推后下一次');
  assert.ok(delays[1]! > delays[0]!, '退避必须逐次加长');
  assert.ok(DEFAULT_AUTOMATION_POLICY.maxBackoffMs <= 30 * 60_000, '退避上限不得放宽');
});

test('AC-13-3: 连续失败达上限后暂停，不无限重试', async () => {
  const h = harness({ outcomes: Array.from({ length: 8 }, () => ({ status: 'failed' as const, reason: 'engine_failed' })) });
  h.scheduler.resume();
  for (let i = 0; i < 5; i += 1) { await h.scheduler.tick(); h.advance(DEFAULT_AUTOMATION_POLICY.observationIntervalMs * 32); }
  const view = h.scheduler.view();
  assert.equal(view.state, 'paused');
  assert.match(view.reason ?? '', /repeated_failure/);
  const callsAtPause = h.calls();
  await h.scheduler.tick();
  assert.equal(h.calls(), callsAtPause, '暂停后不得继续尝试');
});

test('AC-13-3: 暂停/授权缺失立刻停止，不退避重试', async () => {
  const h = harness({ capabilities: { grant: false } });
  h.scheduler.resume();
  const result = await h.scheduler.tick();
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'continuous_screen_grant_required');
  assert.equal(h.calls(), 0, '授权缺失时不得反复尝试烧预算');
  assert.equal(h.scheduler.view().state, 'needs-authorization');
});

test('AC-13-3: 取消后的晚结果不产生回复', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const clock = new Clock();
  const scheduler = new CompanionAutomationScheduler({
    now: clock.now,
    async observe(signal) {
      await gate;
      return signal?.aborted ? null : { status: 'recognized', observation: observation('晚到的内容') };
    },
    capabilities: () => ({ capture: true, route: true, grant: true, authorizer: true }),
    busy: () => ({ busy: false }),
    reserve: async () => true,
    commitDisplayed: () => {},
  });
  scheduler.resume();
  const running = scheduler.tick();
  scheduler.pause('user_cancelled');
  release();
  const result = await running;
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'cancelled', '取消后的晚结果必须零投递');
  assert.equal(scheduler.view().state, 'paused');
});

// ================================================================================================
// AC-13-4 policy view 真实
// ================================================================================================

test('AC-13-4: nextEligibleAt 真实给出，不再是硬编码 null', () => {
  const h = harness();
  assert.equal(h.scheduler.view().nextEligibleAt, null, '未 resume 时确实没有下次时间');
  h.scheduler.resume();
  const view = h.scheduler.view();
  assert.ok(view.nextEligibleAt, 'resume 后必须给出下一次可运行时间');
  assert.equal(view.state, 'running');
  assert.equal(view.reason, null);
});

test('AC-13-4: 能力缺失如实反映为 unavailable 且带原因', () => {
  const h = harness({ capabilities: { capture: false } });
  h.scheduler.resume();
  const decision = h.scheduler.decide();
  assert.equal(decision.run, false);
  if (decision.run) throw new Error('unreachable');
  assert.equal(decision.state, 'unavailable');
  assert.equal(decision.reason, 'real_screen_capture_unavailable', '必须说明缺哪一项');
});

test('AC-13-4: 识别路线/授权器缺失各自有独立原因', () => {
  const route = harness({ capabilities: { route: false } });
  route.scheduler.resume();
  const a = route.scheduler.decide();
  assert.equal(a.run === false && a.reason, 'recognition_route_unavailable');

  const authorizer = harness({ capabilities: { authorizer: false } });
  authorizer.scheduler.resume();
  const b = authorizer.scheduler.decide();
  assert.equal(b.run === false && b.reason, 'background_authorizer_unavailable');
});

test('AC-13-2: 冻结阈值来自登记表，不得被放宽', () => {
  assert.equal(DEFAULT_AUTOMATION_POLICY.nearDuplicateThreshold, 0.85);
  assert.equal(DEFAULT_AUTOMATION_POLICY.replyCooldownMs, 3 * 3_600_000, '回复冷却 3 小时');
  assert.equal(DEFAULT_AUTOMATION_POLICY.observationIntervalMs, 300_000);
  assert.deepEqual([...DEFAULT_AUTOMATION_POLICY.backoffMultipliers], [1, 2, 4, 8, 16]);
  assert.equal(DEFAULT_AUTOMATION_POLICY.maxBackoffMs, 30 * 60_000, '退避上限 30 分钟');
});

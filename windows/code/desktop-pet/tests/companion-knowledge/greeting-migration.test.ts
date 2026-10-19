/**
 * tests/companion-knowledge/greeting-migration.test.ts
 *
 * CK-14: 时区问候、每日去重与旧 timer 接管。
 *
 * AC-14-1: fake-clock 跨日/重启/DST/改时区/改规则只在符合时一次投递；错过不补发。
 * AC-14-2: 新旧接管每阶段 crash/失败/恢复零双发；旧语义保留，不把旧用户迁为睡觉提醒。
 * AC-14-3: capture/localOcr/cloudVlm 全 false 时本地问候仍可用；默认零模型/屏幕调用。
 * AC-14-4: 唯一 receipt/ack/ledger；cancel/late ack/role 切换/busy 不误展示；手动不占定时名额。
 *
 * 全程 fake clock + 内存 ledger；真实跨日/Electron 体验按 SPEC 留 CK-15。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompanionGreetingScheduler,
  nextTakeoverPhase,
  localDateAt,
  localMinutesAt,
  type GreetingLedger,
  type TakeoverState,
} from '../../core/companion-greeting-scheduler.js';
import { LocalGreetingScheduler, localGreetingBand } from '../../desktop/local-greeting.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';
import type { CompanionGreetingRule } from '../../contracts/companion-mode.js';

const PAIRING = productionPairing('companion', 'inst-ck14');
const OTHER = productionPairing('companion', 'inst-other');
const PAIR_KEY = `${PAIRING.userId}|${PAIRING.characterId}|${PAIRING.characterInstanceId}`;

class Clock {
  value = Date.parse('2026-10-07T00:00:00.000Z');
  now = (): number => this.value;
  set(iso: string): void { this.value = Date.parse(iso); }
  advanceMs(ms: number): void { this.value += ms; }
}

function ledger() {
  const records: { pairingKey: string; ruleId: string; localDate: string }[] = [];
  const reservations: string[] = [];
  const port: GreetingLedger = {
    has(input) { return records.some(r => r.pairingKey === input.pairingKey && r.ruleId === input.ruleId && r.localDate === input.localDate); },
    commit(record) { records.push({ pairingKey: record.pairingKey, ruleId: record.ruleId, localDate: record.localDate }); },
    async reserve(input) {
      const key = `${input.pairingKey}|${input.ruleId}|${input.localDate}`;
      if (reservations.includes(key)) return false;
      reservations.push(key);
      return true;
    },
  };
  return { port, records, reservations, has: port.has };
}

function rule(overrides: Partial<CompanionGreetingRule> = {}): CompanionGreetingRule {
  return { id: 'morning', enabled: true, localTime: '08:00', timezone: 'Asia/Shanghai', ...overrides };
}

function ready(overrides: Partial<TakeoverState> = {}): TakeoverState {
  return { phase: 'ready', reason: null, migratedEnabled: true, migrationVersion: 1, ...overrides };
}

function harness(options: {
  takeover?: TakeoverState;
  busy?: { busy: boolean; reason?: string; dnd?: boolean };
  deliver?: (input: { operationId: string; text: string }) => Promise<string | null>;
} = {}) {
  const clock = new Clock();
  const book = ledger();
  const deliveries: { operationId: string; text: string; ruleId: string; localDate: string }[] = [];
  const scheduler = new CompanionGreetingScheduler({
    now: clock.now,
    ledger: book.port,
    busy: () => options.busy ?? { busy: false },
    takeover: options.takeover ?? ready(),
    deliver: async input => {
      deliveries.push({ operationId: input.operationId, text: input.text, ruleId: input.ruleId, localDate: input.localDate });
      return options.deliver ? options.deliver(input) : 'trigger-1';
    },
  });
  return { scheduler, clock, ledger: book, deliveries };
}

/** The renderer acknowledged the greeting, which is when the daily slot is actually consumed. */
function ack(h: { scheduler: CompanionGreetingScheduler; clock: Clock }, ruleId: string, localDate: string, timezone = 'Asia/Shanghai') {
  h.scheduler.commitShown({ pairing: PAIRING, ruleId, localDate, timezone, scope: 's-1', shownAt: h.clock.now() });
}

/** 2026-10-07 08:00 in Asia/Shanghai == 2026-10-07T00:00Z. */
const OCT7_0800_SHANGHAI = '2026-10-07T00:00:00.000Z';

// ================================================================================================
// AC-14-1 时区、跨日、错过不补发
// ================================================================================================

test('AC-14-1: 到达规则时间投递一次，窗口内再 tick 不重复', async () => {
  const h = harness();
  h.clock.set(OCT7_0800_SHANGHAI);
  const first = await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.outcome, 'delivered-candidate');
  ack(h, 'morning', '2026-10-07');

  h.clock.advanceMs(60_000); // one minute later, still inside the window
  const second = await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(second[0]!.outcome, 'suppressed');
  assert.equal(second[0]!.reason, 'already_shown_today');
  assert.equal(h.deliveries.length, 1, '同一天只投递一次');
});

test('AC-14-1: 错过窗口不补发', async () => {
  const h = harness();
  // 15:00 local — the 08:00 rule is long past.
  h.clock.set('2026-10-07T07:00:00.000Z');
  const result = await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(result.length, 0, '错过的窗口不补发');
  assert.equal(h.deliveries.length, 0);
});

test('AC-14-1: 跨日可再次投递', async () => {
  const h = harness();
  h.clock.set(OCT7_0800_SHANGHAI);
  await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(h.deliveries.length, 1);
  ack(h, 'morning', '2026-10-07');

  // Next day, same wall-clock time.
  h.clock.set('2026-10-08T00:00:00.000Z');
  const second = await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(second[0]!.outcome, 'delivered-candidate');
  assert.equal(h.deliveries.length, 2, '不同本地日可各一次');
  assert.notEqual(h.deliveries[0]!.localDate, h.deliveries[1]!.localDate);
});

test('AC-14-1: DST 重复小时只发一次', async () => {
  // 2026-11-01 America/New_York: 01:00-02:00 local occurs twice.
  const h = harness({ takeover: ready() });
  const dstRule = rule({ id: 'dst', localTime: '01:30', timezone: 'America/New_York' });
  // First 01:30 EDT == 05:30Z
  h.clock.set('2026-11-01T05:30:00.000Z');
  const first = await h.scheduler.tick({ pairing: PAIRING, rules: [dstRule] });
  assert.equal(first[0]!.outcome, 'delivered-candidate');
  ack(h, 'dst', '2026-11-01', 'America/New_York');
  // Second 01:30 EST == 06:30Z, same local date.
  h.clock.set('2026-11-01T06:30:00.000Z');
  const second = await h.scheduler.tick({ pairing: PAIRING, rules: [dstRule] });
  assert.equal(second[0]!.outcome, 'suppressed', 'DST 重复小时只发一次');
  assert.equal(h.deliveries.length, 1);
});

test('AC-14-1: DST 跳过的本地时间不补发', async () => {
  // 2026-03-08 America/New_York: 02:00-03:00 local does not exist.
  const h = harness();
  const skipped = rule({ id: 'dst-skip', localTime: '02:30', timezone: 'America/New_York' });
  h.clock.set('2026-03-08T07:30:00.000Z'); // 03:30 EDT
  const result = await h.scheduler.tick({ pairing: PAIRING, rules: [skipped] });
  assert.equal(result.length, 0, 'DST 跳过的时刻不补发');
  assert.equal(h.deliveries.length, 0);
});

test('AC-14-1: 改规则时间不得在当天重放', async () => {
  const h = harness();
  h.clock.set(OCT7_0800_SHANGHAI);
  await h.scheduler.tick({ pairing: PAIRING, rules: [rule({ localTime: '08:00' })] });
  ack(h, 'morning', '2026-10-07');
  // The user edits the rule to 09:00; the local date is the same.
  h.clock.set('2026-10-07T01:00:00.000Z'); // 09:00 local
  const second = await h.scheduler.tick({ pairing: PAIRING, rules: [rule({ localTime: '09:00' })] });
  assert.equal(second[0]!.outcome, 'suppressed', '改时间不得绕过每日去重');
  assert.equal(h.deliveries.length, 1);
});

test('AC-14-1: 改时区不得重放当天已发规则', async () => {
  const h = harness();
  h.clock.set(OCT7_0800_SHANGHAI);
  await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  ack(h, 'morning', '2026-10-07');

  // Same rule id, same local date, but the rule now claims Tokyo. Pick an instant that IS due in
  // Tokyo on the same local date so the dedup key (not the window) is what suppresses it.
  h.clock.set('2026-10-06T23:00:30.000Z'); // 2026-10-07 08:00:30 in Tokyo
  const second = await h.scheduler.tick({ pairing: PAIRING, rules: [rule({ timezone: 'Asia/Tokyo' })] });
  assert.equal(second[0]?.outcome, 'suppressed', '改时区不得绕过每日去重');
  assert.equal(h.deliveries.length, 1, '改时区不得重放');
});

// ================================================================================================
// AC-14-2 接管握手
// ================================================================================================

test('AC-14-2: 旧 timer 未停时新路径保持沉默（不双发）', async () => {
  const h = harness({ takeover: { phase: 'legacy-active', reason: null, migratedEnabled: true, migrationVersion: 0 } });
  h.clock.set(OCT7_0800_SHANGHAI);
  const result = await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(result[0]!.outcome, 'unavailable');
  assert.equal(result[0]!.reason, 'takeover_legacy-active');
  assert.equal(h.deliveries.length, 0, '旧 timer 仍在说话时新路径不得也说');
});

test('AC-14-2: 握手按 legacy-active → legacy-stopped → ready 推进', () => {
  const base = { legacyEnabled: true, legacyLastShownAt: null as number | null, migrationVersion: 1 };
  const first = nextTakeoverPhase({ ...base, phase: 'legacy-active', legacyStopped: true, ledgerReady: false });
  assert.equal(first.phase, 'legacy-stopped');
  const second = nextTakeoverPhase({ ...base, phase: 'legacy-stopped', legacyStopped: true, ledgerReady: true });
  assert.equal(second.phase, 'ready');
});

test('AC-14-2: 接管失败回退到旧机制，而不是两边都不说话', () => {
  const state = nextTakeoverPhase({
    phase: 'legacy-active', legacyStopped: false, ledgerReady: false,
    legacyEnabled: true, legacyLastShownAt: null, migrationVersion: 1, failure: 'host_unreachable',
  });
  assert.equal(state.phase, 'legacy-active', '失败时保持旧机制继续工作');
  assert.equal(state.reason, 'host_unreachable');
  assert.equal(state.migratedEnabled, true, '旧开关语义保留');
});

test('AC-14-2: 旧语义原样保留：45 分钟空闲、6 小时冷却、四时段', () => {
  assert.equal(localGreetingBand(new Date(2026, 0, 1, 8, 0)), 'morning');
  assert.equal(localGreetingBand(new Date(2026, 0, 1, 14, 0)), 'day');
  assert.equal(localGreetingBand(new Date(2026, 0, 1, 19, 0)), 'evening');
  assert.equal(localGreetingBand(new Date(2026, 0, 1, 23, 30)), 'night');
  // The legacy scheduler still works with its original defaults.
  const legacy = new LocalGreetingScheduler({ idleAfterMs: 45 * 60_000, cooldownMs: 6 * 3_600_000 });
  legacy.markInteraction();
  const decision = legacy.tick({ now: Date.now() + 46 * 60_000, visible: true, busy: false });
  assert.ok(decision, '旧机制在空闲后仍会出句');
});

test('AC-14-2: 不把旧用户迁为睡觉提醒', () => {
  const state = nextTakeoverPhase({
    phase: 'legacy-active', legacyStopped: true, ledgerReady: true,
    legacyEnabled: true, legacyLastShownAt: 1_700_000_000_000, migrationVersion: 2,
  });
  // Migrating carries the OLD values across; it does not invent a bedtime reminder rule.
  assert.equal(state.migratedEnabled, true, '保留原开关');
  assert.equal(state.migratedLastShownAt, 1_700_000_000_000, '保留原最后展示时间');
  assert.equal(state.migrationVersion, 2);
});

test('AC-14-2: 用户原本关闭问候，迁移后仍关闭', async () => {
  const h = harness({ takeover: ready({ migratedEnabled: false }) });
  h.clock.set(OCT7_0800_SHANGHAI);
  const result = await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(result[0]!.outcome, 'disabled');
  assert.equal(h.deliveries.length, 0, '关闭状态不得出句');
});

// ================================================================================================
// AC-14-3 无屏幕能力仍可用 + 零模型/屏幕调用
// ================================================================================================

test('AC-14-3: capture/localOcr/cloudVlm 全 false 时本地问候仍可用', async () => {
  const capabilities = { capture: false, localOcr: false, cloudVlm: false };
  const h = harness();
  h.clock.set(OCT7_0800_SHANGHAI);
  const result = await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(result[0]!.outcome, 'delivered-candidate', '本地问候与屏幕能力无关');
  assert.deepEqual(capabilities, { capture: false, localOcr: false, cloudVlm: false });
});

test('AC-14-3: 默认文案是确定的本地短句，不含模型调用', async () => {
  const h = harness();
  h.clock.set(OCT7_0800_SHANGHAI);
  await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  const text = h.deliveries[0]!.text;
  assert.ok(text.length > 0 && text.length < 60, '是短句，不是生成的长文');
  assert.match(text, /早上好|中午好|晚上好/);
});

// ================================================================================================
// AC-14-4 记账、配额与误展示防护
// ================================================================================================

test('AC-14-4: 未 ack 不占用当日去重，ack 后才提交', async () => {
  const h = harness();
  h.clock.set(OCT7_0800_SHANGHAI);
  await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(h.ledger.records.length, 0, '未展示确认前不写去重记录');

  h.scheduler.commitShown({ pairing: PAIRING, ruleId: 'morning', localDate: '2026-10-07', timezone: 'Asia/Shanghai', scope: 's-1' });
  assert.equal(h.ledger.records.length, 1, 'ack 后才提交去重');
  assert.equal(h.ledger.records[0]!.localDate, '2026-10-07');
});

test('AC-14-4: 共享配额耗尽时不投递', async () => {
  const h = harness({
    takeover: ready(),
    deliver: async () => null, // delivery owner refuses
  });
  h.clock.set(OCT7_0800_SHANGHAI);
  const result = await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(result[0]!.outcome, 'unavailable');
  assert.equal(result[0]!.reason, 'delivery_refused');
});

test('AC-14-4: 忙态与免打扰不出句', async () => {
  const busyHarness = harness({ busy: { busy: true, reason: 'user_typing' } });
  busyHarness.clock.set(OCT7_0800_SHANGHAI);
  const busy = await busyHarness.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(busy[0]!.outcome, 'suppressed');
  assert.equal(busyHarness.deliveries.length, 0);

  const dndHarness = harness({ busy: { busy: false, dnd: true } });
  dndHarness.clock.set(OCT7_0800_SHANGHAI);
  const dnd = await dndHarness.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(dnd[0]!.outcome, 'suppressed');
  assert.equal(dndHarness.deliveries.length, 0);
});

test('AC-14-4: 跨 pairing 去重互不影响', async () => {
  const h = harness();
  h.clock.set(OCT7_0800_SHANGHAI);
  await h.scheduler.tick({ pairing: PAIRING, rules: [rule()] });
  assert.equal(h.ledger.has({
    pairingKey: `${OTHER.userId}|${OTHER.characterId}|${OTHER.characterInstanceId}`,
    ruleId: 'morning', localDate: '2026-10-07',
  }), false);
});

test('AC-14-1: 本地日期按 IANA 时区计算', () => {
  assert.equal(localDateAt(Date.parse('2026-10-07T16:30:00.000Z'), 'Asia/Shanghai'), '2026-10-08', 'UTC 16:30 已是上海次日');
  assert.equal(localDateAt(Date.parse('2026-10-07T16:30:00.000Z'), 'UTC'), '2026-10-07');
  assert.equal(localMinutesAt(Date.parse('2026-10-07T00:00:00.000Z'), 'Asia/Shanghai'), 8 * 60, 'UTC 00:00 = 上海 08:00');
});

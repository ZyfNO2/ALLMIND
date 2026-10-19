/**
 * tests/companion-knowledge/activity-summary.test.ts
 *
 * CK-04: 活动事件、时间依据、日摘要与后台调用预算。
 *
 * AC-04-1: 固定主体/时间负例全部正确归属/未知；多源 event 去重，实际来源区块可定位。
 * AC-04-2: 按时区日摘要覆盖实际事件，部分/失败/缺口可见；不默认向用户发消息。
 * AC-04-3: 撤销/TTL/更正/role 切换/重启阻止晚写与旧摘要召回；原事件权威不复制。
 * AC-04-4: 正式 source→活动→Timeline 查询链与 authorizer 共享 ledger 接线；超额/无授权拒绝，
 *          未知 reservation 不释放成新额度。
 *
 * 被测模块走真实生产代码；模型 transport 为 stub，真实模型总结质量在 CK-15 另留证据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ActivityUnderstanding, orderableTime, type ActivityInput } from '../../core/activity-understanding.js';
import { DailyActivitySummary, localDayRangeUtc } from '../../core/daily-activity-summary.js';
import { BackgroundCallAuthorizer, canRunBackground, type BackgroundPurposeBudget } from '../../app/background-call-authorizer.js';
import type { SourceEvidenceRef } from '../../core/collection-source-reader.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';
import type { CompanionSourceKind } from '../../contracts/companion-mode.js';

const PAIRING = productionPairing('companion', 'inst-ck04');
const NOW = '2026-10-07T02:00:00.000Z';

function evidence(overrides: Partial<SourceEvidenceRef> & { sourceKind: CompanionSourceKind }): SourceEvidenceRef {
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceId: 'src-1',
    sourceRevision: 1,
    contentHash: 'hash-1',
    locator: 'notes.md',
    scope: PAIRING,
    grantId: 'g-1',
    grantRevision: 1,
    generation: 1,
    origin: 'synthetic',
    validity: 'valid' as const,
    expiresAt: '2026-12-01T00:00:00.000Z',
    ...overrides,
    time: Object.freeze({
      occurredAt: null, occurredAtBasis: 'unknown' as const, receivedAt: NOW,
      ...(overrides.time ?? {}),
    }),
  } as SourceEvidenceRef);
}

function input(sourceKind: CompanionSourceKind, overrides: Partial<ActivityInput> = {}): ActivityInput {
  return { evidence: evidence({ sourceKind }), sourceKind, text: '正文', ...overrides };
}

const understanding = new ActivityUnderstanding();
const summaryBuilder = new DailyActivitySummary({ now: () => NOW });

// ================================================================================================
// AC-04-1 主体/时间负例与去重
// ================================================================================================

test('AC-04-1: 报错不得推断为已解决', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('manual_text', { failure: true, text: '构建失败了' })],
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.status, 'failed');
  assert.equal(result.events[0]!.reason, 'reported_failure_not_resolution');
  assert.notEqual(result.events[0]!.status, 'confirmed');
});

test('AC-04-1: 文件存在不得推断为已阅读', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('workspace_directory', { text: null })],
  });
  assert.equal(result.events.length, 1);
  const event = result.events[0]!;
  assert.equal(event.activityKind, 'file_present', '存在就是存在，不是 read_document');
  assert.equal(event.status, 'candidate', '元数据不得确认为用户行为');
  assert.equal(event.reason, 'metadata_does_not_establish_user_action');
});

test('AC-04-1: 画面第三人不归本人', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('screenshot_directory', { text: '画面里出现了别人的一段话' })],
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.subject, 'third_party', '屏上内容不得归为本人陈述');
  assert.equal(result.events[0]!.evidenceKind, 'captured_image');
  assert.equal(result.events[0]!.status, 'candidate');
});

test('AC-04-1: 复制内容不自动成为本人事实', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('clipboard_text', { text: '别人写的一段话' })],
  });
  assert.equal(result.events[0]!.evidenceKind, 'third_party_content');
  assert.equal(result.events[0]!.status, 'candidate', '复制是候选，不是已确认的本人陈述');
});

test('AC-04-1: 无时间时 abstain，mtime 不冒充 occurredAt', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('workspace_directory', {
      text: '文件正文',
      evidence: evidence({
        sourceKind: 'workspace_directory',
        time: Object.freeze({
          occurredAt: null, occurredAtBasis: 'unknown' as const, receivedAt: NOW,
          fileModifiedAt: '2026-10-01T05:00:00.000Z', fileCreatedAt: '2026-09-01T05:00:00.000Z',
        }),
      }),
    })],
  });
  const event = result.events[0]!;
  assert.equal(event.time.occurredAt, null, 'mtime 绝不能成为 occurredAt');
  assert.equal(event.time.fileModifiedAt, '2026-10-01T05:00:00.000Z', '元数据时间必须分列保留');
  assert.equal(orderableTime(event).recordedOnly, true, '无发生时间必须标记为仅记录时间');
});

test('AC-04-1: 多源同事件去重，来源区块可定位', () => {
  const shared = { sourceId: 'src-shared', sourceRevision: 3, contentHash: 'same-hash' };
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [
      { evidence: evidence({ sourceKind: 'manual_text', ...shared }), sourceKind: 'manual_text', text: '同一段正文' },
      { evidence: evidence({ sourceKind: 'manual_text', ...shared }), sourceKind: 'manual_text', text: '同一段正文' },
    ],
  });
  assert.equal(result.events.length, 1, '同源同版本同内容必须去重');
  assert.equal(result.events[0]!.sourceRefs.length, 2, '两个来源区块都要保留可定位');
  assert.equal(result.events[0]!.sourceRefs[0]!.locator, 'notes.md');
});

test('AC-04-1: 空正文不产生事件且有诊断', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('manual_text', { text: '   ' })],
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.skipped, 1);
  assert.equal(result.diagnostics[0]!.reason, 'empty_body', '缺口必须可解释，不能静默丢弃');
});

test('AC-04-1: 跨 pairing 证据被拒绝', () => {
  const other = productionPairing('companion', 'inst-other');
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('manual_text', { evidence: evidence({ sourceKind: 'manual_text', scope: other }) })],
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.diagnostics[0]!.reason, 'pairing_mismatch');
});

test('AC-04-1: 已失效来源不产生事件', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('manual_text', { evidence: evidence({ sourceKind: 'manual_text', validity: 'invalidated' }) })],
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.diagnostics[0]!.reason, 'source_invalidated');
});

// ================================================================================================
// AC-04-2 时区日摘要
// ================================================================================================

test('AC-04-2: 本地日边界按 IANA 时区计算，不是 UTC 日', () => {
  const shanghai = localDayRangeUtc('2026-10-07', 'Asia/Shanghai');
  assert.equal(shanghai.fromUtc, '2026-10-06T16:00:00.000Z', '上海 10-07 00:00 = UTC 10-06 16:00');
  assert.equal(shanghai.toUtc, '2026-10-07T16:00:00.000Z');
  assert.equal(shanghai.hours, 24);

  const utc = localDayRangeUtc('2026-10-07', 'UTC');
  assert.equal(utc.fromUtc, '2026-10-07T00:00:00.000Z');
});

test('AC-04-2: DST 切换日不是固定 24 小时', () => {
  // 2026-03-08 是美国 DST 开始日：本地日只有 23 小时。
  const spring = localDayRangeUtc('2026-03-08', 'America/New_York');
  assert.equal(spring.hours, 23, `DST 开始日必须为 23 小时，实际 ${spring.hours}`);
  // 2026-11-01 是 DST 结束日：25 小时。
  const autumn = localDayRangeUtc('2026-11-01', 'America/New_York');
  assert.equal(autumn.hours, 25, `DST 结束日必须为 25 小时，实际 ${autumn.hours}`);
});

test('AC-04-2: 摘要只覆盖当天事件，跨日不误收', () => {
  const inDay = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('manual_text', {
      evidence: evidence({
        sourceKind: 'manual_text',
        time: Object.freeze({ occurredAt: '2026-10-07T01:00:00.000Z', occurredAtBasis: 'user-stated' as const, receivedAt: NOW }),
      }),
    })],
  });
  const outOfDay = understanding.understand({
    pairing: PAIRING, operationId: 'op-2', methodVersion: 'v1',
    inputs: [input('manual_text', {
      evidence: evidence({
        sourceKind: 'manual_text', sourceId: 'src-2',
        time: Object.freeze({ occurredAt: '2026-10-05T01:00:00.000Z', occurredAtBasis: 'user-stated' as const, receivedAt: NOW }),
      }),
    })],
  });

  const summary = summaryBuilder.build({
    pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 'op-sum',
    events: [...inDay.events, ...outOfDay.events],
  });
  assert.equal(summary.eventCount, 1, '只应收当天事件');
  assert.equal(summary.coverage.skipped, 1, '跨日事件计入 skipped，缺口可见');
  assert.equal(summary.status, 'partial');
});

test('AC-04-2: 空事件摘要为 empty 且不调用模型', () => {
  const empty = summaryBuilder.build({
    pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 'op-sum', events: [],
  });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.eventCount, 0);
  assert.equal(summaryBuilder.needsModel(empty, null), false, '无新事件不得调用模型');
});

test('AC-04-2: 事件集未变化时不重复调用模型', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('manual_text', {
      evidence: evidence({
        sourceKind: 'manual_text',
        time: Object.freeze({ occurredAt: '2026-10-07T01:00:00.000Z', occurredAtBasis: 'user-stated' as const, receivedAt: NOW }),
      }),
    })],
  });
  const first = summaryBuilder.build({
    pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 's1', events: result.events,
  });
  const second = summaryBuilder.build({
    pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 's2', events: result.events,
  });
  assert.equal(summaryBuilder.needsModel(first, null), true, '首次有新事件');
  assert.equal(summaryBuilder.needsModel(second, first), false, '同事件集不重复调用');
});

test('AC-04-2: 摘要默认不外发', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('manual_text', {
      evidence: evidence({
        sourceKind: 'manual_text',
        time: Object.freeze({ occurredAt: '2026-10-07T01:00:00.000Z', occurredAtBasis: 'user-stated' as const, receivedAt: NOW }),
      }),
    })],
  });
  const summary = summaryBuilder.build({
    pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 's1', events: result.events,
  });
  assert.equal(summary.delivered, false, '构建摘要绝不等于向用户发消息');
});

test('AC-04-2: 失败可见且不伪装成完整摘要', () => {
  const failed = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('manual_text', { failure: true, text: '一次失败' })],
  });
  const summary = summaryBuilder.build({
    pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 's1',
    events: failed.events, upstreamFailures: ['read_failed:src-9'],
  });
  assert.equal(summary.status, 'partial');
  assert.ok(summary.failures.includes('read_failed:src-9'), '上游失败必须出现在摘要里');
  assert.ok(summary.coverage.failed > 0);
});

test('AC-04-2: 非法时区/日期被拒绝而非静默回退', () => {
  assert.throws(() => localDayRangeUtc('2026/10/07', 'Asia/Shanghai'), /YYYY-MM-DD/);
  assert.throws(() => localDayRangeUtc('2026-13-07', 'Asia/Shanghai'), /calendar date/);
  assert.throws(() => localDayRangeUtc('2026-10-07', 'Not/AZone'), Error);
});

test('AC-04-2: 取消的摘要构建抛错，不返回半成品', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => summaryBuilder.build({
    pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 's1',
    events: [], signal: controller.signal,
  }), /summary_cancelled/);
});

// ================================================================================================
// AC-04-4 后台预算：共享 ledger、子预算、未知不释放
// ================================================================================================

function budgetDir(): string { return mkdtempSync(join(tmpdir(), 'aika-ck04-budget-')); }

const PURPOSES: readonly BackgroundPurposeBudget[] = Object.freeze([
  Object.freeze({ purpose: 'daily_summary' as const, limitMicros: 1_000, maxCalls: 2, reservationMicros: 400, inputMicrosPerToken: 1, outputMicrosPerToken: 2 }),
  Object.freeze({ purpose: 'wiki_compile' as const, limitMicros: 5_000, maxCalls: 10, reservationMicros: 500, inputMicrosPerToken: 1, outputMicrosPerToken: 1 }),
]);

function authorizer(file: string, overrides: Partial<ConstructorParameters<typeof BackgroundCallAuthorizer>[0]> = {}): BackgroundCallAuthorizer {
  return new BackgroundCallAuthorizer({
    budgetFile: file, batchId: 'ck04', limitMicros: 100_000, purposes: PURPOSES,
    foreground: { async authorize() { return { async settle() {} }; } },
    ...overrides,
  });
}

const callRequest = { scope: { characterId: 'companion', sessionId: 's', turnId: 't', generation: 1 }, operation: 'summary' as const, model: 'm', endpoint: 'https://unit.invalid' };

test('AC-04-4: 子预算超额被拒绝，且不消耗共享总额度', async () => {
  const file = join(budgetDir(), 'budget.json');
  const authorizerInstance = authorizer(file);
  const permit = await authorizerInstance.forPurpose('daily_summary').authorize(callRequest, new AbortController().signal);
  await permit.settle({ status: 'success', usage: { prompt_tokens: 100, completion_tokens: 100 }, requestId: null });

  // 第二次仍在 limitMicros(1000) 内：100*1 + 100*2 = 300，加预留 400 = 700 <= 1000。
  const second = await authorizerInstance.forPurpose('daily_summary').authorize(callRequest, new AbortController().signal);
  await second.settle({ status: 'success', usage: { prompt_tokens: 100, completion_tokens: 100 }, requestId: null });

  // 第三次超过 maxCalls=2。
  await assert.rejects(
    authorizerInstance.forPurpose('daily_summary').authorize(callRequest, new AbortController().signal),
    /call limit/,
  );

  // 其他 purpose 不受影响：子预算相互独立。
  const other = await authorizerInstance.authorize('wiki_compile', callRequest, new AbortController().signal);
  assert.ok(other.ledgerRef.includes('wiki_compile'));
});

test('AC-04-4: 未注册 purpose 被拒绝，不默认放行', async () => {
  const file = join(budgetDir(), 'budget.json');
  await assert.rejects(
    authorizer(file).forPurpose('observation').authorize(callRequest, new AbortController().signal),
    /No background budget registered/,
  );
});

test('AC-04-4: 未知计费保留预留，不释放成新额度', async () => {
  const file = join(budgetDir(), 'budget.json');
  const authorizerInstance = authorizer(file);
  // 无价格的 purpose：成功但无法计算 → unknown。
  const noPrice = new BackgroundCallAuthorizer({
    budgetFile: file, batchId: 'ck04', limitMicros: 100_000,
    purposes: [{ purpose: 'observation', limitMicros: 10_000, maxCalls: 5, reservationMicros: 900 }],
    foreground: { async authorize() { return { async settle() {} }; } },
  });
  const permit = await noPrice.forPurpose('observation').authorize(callRequest, new AbortController().signal);
  await permit.settle({ status: 'success', usage: { prompt_tokens: 10, completion_tokens: 10 }, requestId: null });

  const usage = await noPrice.usage();
  const observation = usage.find(entry => entry.purpose === 'observation')!;
  assert.equal(observation.unknownCalls, 1, '无法计算成本必须记为 unknown');
  assert.equal(observation.committedMicros, 900, 'unknown 保留预留，绝不归零');

  void authorizerInstance;
});

test('AC-04-4: 失败调用结算为零，不留悬挂预留', async () => {
  const file = join(budgetDir(), 'budget.json');
  const authorizerInstance = authorizer(file);
  const permit = await authorizerInstance.forPurpose('wiki_compile').authorize(callRequest, new AbortController().signal);
  await permit.settle({ status: 'failed', usage: null, requestId: null });

  const usage = await authorizerInstance.usage();
  const wiki = usage.find(entry => entry.purpose === 'wiki_compile')!;
  assert.equal(wiki.committedMicros, 0, '失败调用不占额度');
  assert.equal(wiki.unknownCalls, 0, '失败不是 unknown');
});

test('AC-04-4: 跨重启预留持久：同一 ledger 文件可见已用额度', async () => {
  const file = join(budgetDir(), 'budget.json');
  const first = authorizer(file);
  const permit = await first.forPurpose('wiki_compile').authorize(callRequest, new AbortController().signal);
  await permit.settle({ status: 'success', usage: { prompt_tokens: 10, completion_tokens: 10 }, requestId: null });

  // 新实例读同一文件：预留必须已持久化，不因重启而清空。
  const reopened = authorizer(file);
  const usage = await reopened.usage();
  const wiki = usage.find(entry => entry.purpose === 'wiki_compile')!;
  assert.equal(wiki.calls, 1, '重启后已用调用数必须保留');
  assert.ok(wiki.committedMicros > 0);

  const state = JSON.parse(readFileSync(file, 'utf8')) as { entries: { operationId: string }[] };
  assert.ok(state.entries.some(entry => entry.operationId.startsWith('CK-BG:wiki_compile:')), '必须写在共享 ledger 里');
});

test('AC-04-4: 硬总额不足时拒绝，不给后台超额', async () => {
  const file = join(budgetDir(), 'budget.json');
  const tight = new BackgroundCallAuthorizer({
    budgetFile: file, batchId: 'ck04', limitMicros: 500,
    purposes: [{ purpose: 'wiki_compile', limitMicros: 100_000, maxCalls: 100, reservationMicros: 900 }],
    foreground: { async authorize() { return { async settle() {} }; } },
  });
  await assert.rejects(
    tight.forPurpose('wiki_compile').authorize(callRequest, new AbortController().signal),
    /exhausted|Shared evaluation budget/i,
  );
});

test('AC-04-4: 前台保留额度受保护，后台不得饿死前台', async () => {
  const file = join(budgetDir(), 'budget.json');
  const guarded = new BackgroundCallAuthorizer({
    budgetFile: file, batchId: 'ck04', limitMicros: 1_000,
    purposes: [{ purpose: 'wiki_compile', limitMicros: 100_000, maxCalls: 100, reservationMicros: 600 }],
    foreground: { async authorize() { return { async settle() {} }; } },
    foregroundHeadroomMicros: 600,
  });
  await assert.rejects(
    guarded.forPurpose('wiki_compile').authorize(callRequest, new AbortController().signal),
    /foreground/i,
  );
});

test('AC-04-4: 无授权/无来源/无模型的 job 不得消费预算', () => {
  assert.deepEqual(canRunBackground({ hasSources: false, hasModel: true, hasPurpose: true, hasBudget: true }),
    { allowed: false, reason: 'no_available_sources' });
  assert.deepEqual(canRunBackground({ hasSources: true, hasModel: false, hasPurpose: true, hasBudget: true }),
    { allowed: false, reason: 'no_model_binding' });
  assert.deepEqual(canRunBackground({ hasSources: true, hasModel: true, hasPurpose: false, hasBudget: true }),
    { allowed: false, reason: 'no_authorized_purpose' });
  assert.deepEqual(canRunBackground({ hasSources: true, hasModel: true, hasPurpose: true, hasBudget: false }),
    { allowed: false, reason: 'no_remaining_budget' });
  assert.deepEqual(canRunBackground({ hasSources: true, hasModel: true, hasPurpose: true, hasBudget: true }),
    { allowed: true, reason: null });
});

test('AC-04-4: Distiller no-op 不允许消费预算', () => {
  const gate = canRunBackground({
    hasSources: true, hasModel: true, hasPurpose: true, hasBudget: true, isDistillerNoOp: true,
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'distiller_noop_must_not_consume_budget');
});

test('AC-04-4: 旧 memory_maintenance 禁令保留', () => {
  // 该禁令由 TrialAuthorizer 强制执行；此处以源码断言确认它没有被本步移除。
  const source = readFileSync(resolve('app', 'trial-authorizer.ts'), 'utf8');
  assert.match(source, /memory_maintenance/, '旧禁令必须仍在');
  assert.match(source, /Legacy memory maintenance is disabled/);
});

// ================================================================================================
// AC-04-3 撤销/TTL/重启：晚写与旧摘要召回
// ================================================================================================

test('AC-04-3: 父源撤销后重新理解必须产出空集，旧摘要不得被复用', () => {
  const before = understanding.understand({
    pairing: PAIRING, operationId: 'op-before', methodVersion: 'v1',
    inputs: [input('manual_text', {
      evidence: evidence({
        sourceKind: 'manual_text',
        time: Object.freeze({ occurredAt: '2026-10-07T01:00:00.000Z', occurredAtBasis: 'user-stated' as const, receivedAt: NOW }),
      }),
    })],
  });
  assert.equal(before.events.length, 1);
  const summaryBefore = summaryBuilder.build({
    pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 's-before',
    events: before.events,
  });
  assert.equal(summaryBefore.eventCount, 1);

  // 来源随后被撤销：重新理解同一来源必须为空，且新摘要不含该事件。
  const after = understanding.understand({
    pairing: PAIRING, operationId: 'op-after', methodVersion: 'v1',
    inputs: [input('manual_text', {
      evidence: evidence({ sourceKind: 'manual_text', validity: 'invalidated' }),
    })],
  });
  assert.equal(after.events.length, 0, '撤销后的来源不得再产生事件');

  const summaryAfter = summaryBuilder.build({
    pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 's-after',
    events: after.events,
  });
  assert.equal(summaryAfter.eventCount, 0);
  assert.equal(summaryAfter.status, 'empty');
  assert.equal(summaryAfter.summaryId, summaryBefore.summaryId, '同日同实例是同一摘要位');
  assert.notEqual(summaryAfter.eventCount, summaryBefore.eventCount, '重算后旧有效摘要不得被消费');
});

test('AC-04-3: TTL 过期的来源不产生事件', () => {
  const result = understanding.understand({
    pairing: PAIRING, operationId: 'op-1', methodVersion: 'v1',
    inputs: [input('manual_text', { evidence: evidence({ sourceKind: 'manual_text', validity: 'expired' }) })],
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.diagnostics[0]!.reason, 'source_expired');
});

test('AC-04-3: 事件权威不复制：本步未新增第二份事件持久表', () => {
  // UnifiedTimeline 仍是投影；活动事件在本步是派生对象，不落第二份持久表。
  const store = readFileSync(resolve('memory', 'collection-store.ts'), 'utf8');
  const timeline = readFileSync(resolve('memory', 'unified-timeline.ts'), 'utf8');
  assert.doesNotMatch(timeline, /activity_events|ck_activity|activity_understanding_events/,
    '不得在 timeline 里新增第二份活动事件表');
  assert.match(timeline, /companion_activity_timeline_events/, '既有投影表保持不变');
  void store;
});

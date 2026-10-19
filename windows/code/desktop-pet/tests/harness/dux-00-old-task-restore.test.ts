/**
 * DUX-00 基线 → DUX-04 实施后的目标契约。
 *
 * DUX-00 时本文件是特征化测试（钉住「旧草稿回填当前卡片」的缺陷行为作为失败证据）；
 * DUX-04 实施时断言翻转为**目标行为**：
 *   1. 启动/重连**不默认选**未提交旧草稿（open/prepared/confirming）——保留原持久记录，
 *      主界面 current 为空；已发送任务的回执跟踪/未读数仍正常发布；
 *   2. companion 新输入不清 current（current 本就不含旧草稿），`sourceInput` 不回填旧正文；
 *   3. 恢复过程零外部派发。
 *
 * 全部走真实 `ForwardReceipts`（SQLite）与真实 `DesktopWork`/`HarnessForwarding`；派发端是匿名
 * stub 且计数，证明「不恢复」不需要任何外部发送。
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ForwardReceipts } from '../../harness/receipts.js';
import { HarnessForwarding } from '../../harness/forwarding.js';
import { DesktopWork } from '../../harness/desktop-work.js';
import { SqliteProjectIndex } from '../../projects/sqlite-project-index.js';
import type { DesktopWorkState, WorkIntent, WorkContinuationIntent, PendingWorkContext } from '../../contracts/desktop-work.js';
import type { TurnScope } from '../../contracts/index.js';

const scope: TurnScope = { characterId: 'companion', sessionId: 'session-dux00', turnId: 'turn-dux00', generation: 1 };
const HALF_MONTH_AGO = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString();

async function fixture(t: TestContext) {
  const parent = resolve('../../.local/dux-00/tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'old-task-'));
  const receipts = new ForwardReceipts(join(root, 'harness-relay.sqlite'));
  const projects = new SqliteProjectIndex(join(root, 'project-index.sqlite'));
  const sends = { native: 0, harness: 0, codex: 0 };
  const observation = { intent: { kind: 'companion' } as WorkIntent, continuation: { kind: 'confirm' } as WorkContinuationIntent, contexts: [] as PendingWorkContext[] };
  const forwarding = new HarnessForwarding({
    receipts, projects, compatible: async () => true, presetReady: async () => true, presetId: 'desktop-pet-relay-v1', workspace: root, workPresetReady: async () => true,
    nativeWork: { createWorkSession: async () => {}, submitWork: async () => { sends.native++; }, workReceipt: async () => ({ status: 'working', result: 'stub' }) },
    harness: { probe: async () => ({ state: 'ready', observedAt: 'now', codexDelivery: 'unverified' }), createRelaySession: async () => {}, submitConfirmedOperation: async () => { sends.harness++; } },
    codex: { list: () => [], discover: async () => ({ available: false }), send: async () => { sends.codex++; return { threadId: randomUUID(), turnId: randomUUID(), requestId: randomUUID() }; }, receipt: async () => ({ threadId: 'x', turnId: 'y', status: 'unknown', reply: '' }) },
  });
  const states: DesktopWorkState[] = [];
  const work = new DesktopWork({
    receipts, projects, forwarding, classify: async () => observation.intent, emit: state => states.push(state),
  });
  t.after(async () => { await work.close(); await forwarding.close(); await projects.close(); await rm(root, { recursive: true, force: true }); });
  return { root, receipts, projects, forwarding, work, states, sends, observation };
}

test('DUX-04 启动不把半月前的未提交旧草稿恢复为当前卡片（原记录保留）', async t => {
  const f = await fixture(t);
  // 直接用真实 receipts 公开方法创建匿名旧草稿，并把 createdAt 改到半个月前。
  const oldDraft = f.receipts.createDraft(scope, '1111');
  f.receipts.mutateDraft(oldDraft.id, oldDraft.version, row => { row.createdAt = HALF_MONTH_AGO; });
  assert.equal(f.receipts.drafts().length, 1, '匿名旧草稿必须真实落库（保留原记录）');
  await f.work.close();

  // 重启（新 DesktopWork 实例，同一 SQLite）：目标行为 = 不选旧草稿为 current。
  const states: DesktopWorkState[] = [];
  const reopened = new DesktopWork({ receipts: f.receipts, projects: f.projects, forwarding: f.forwarding, classify: async () => ({ kind: 'companion' }), emit: state => states.push(state) });
  t.after(async () => { await reopened.close(); });
  await reopened.start(60000);
  const published = states.at(-1);
  assert.ok(published, 'start 必须发布状态');
  assert.equal(published!.draft, undefined, '目标行为：启动后 current 不携带旧草稿（不回填主界面）');
  assert.equal(published!.sourceInput, undefined, '目标行为：sourceInput 不回填旧正文');
  // 旧记录不删：持久草稿仍在库里，可经工程记录主动查看。
  assert.equal(f.receipts.drafts().length, 1, '旧草稿必须保留（不按天数隐藏、不删除）');
  // 且没有任何外部派发发生（恢复 purely 本地）。
  assert.deepEqual(f.sends, { native: 0, harness: 0, codex: 0 }, '恢复流程不得触发任何派发');
});

test('DUX-04 companion 新输入不会复活旧草稿（sourceInput 不回填旧正文）', async t => {
  const f = await fixture(t);
  const oldDraft = f.receipts.createDraft(scope, '111111');
  f.receipts.mutateDraft(oldDraft.id, oldDraft.version, row => { row.createdAt = HALF_MONTH_AGO; });
  await f.work.close();

  const states: DesktopWorkState[] = [];
  const reopened = new DesktopWork({ receipts: f.receipts, projects: f.projects, forwarding: f.forwarding, classify: async () => ({ kind: 'companion' }), emit: state => states.push(state) });
  t.after(async () => { await reopened.close(); });
  await reopened.start(60000);
  // 用户开始新输入「你好」：companion 焦点。目标行为 = 无 current 草稿，无 sourceInput 回填。
  reopened.onInput();
  const afterInput = states.at(-1);
  assert.equal(afterInput!.focus, 'companion', 'onInput 应把焦点切回 companion');
  assert.equal(afterInput!.draft, undefined, '目标行为：companion 输入后旧草稿不回填当前卡片');
  assert.equal(afterInput!.sourceInput, undefined, '目标行为：sourceInput 不携带旧正文（输入框不被 1111 填充）');
  // 且没有任何外部派发发生。
  assert.deepEqual(f.sends, { native: 0, harness: 0, codex: 0 }, '恢复/onInput 不得触发任何派发');
});

test('DUX-04 已发送任务（confirmed/unknown）启动后仍正常跟踪回执', async t => {
  const f = await fixture(t);
  // 建一条已发送记录：create + confirmedAt（匿名 stub 派发记录）。
  const row = f.receipts.create({ text: '已发送的匿名任务', target: { hostId: 'local', threadId: 'thread-x' }, executor: 'codex' } as never);
  f.receipts.mutate(row.id, r => { r.confirmedAt = new Date().toISOString(); r.phase = 'unknown'; });
  await f.work.close();

  const states: DesktopWorkState[] = [];
  const reopened = new DesktopWork({ receipts: f.receipts, projects: f.projects, forwarding: f.forwarding, classify: async () => ({ kind: 'companion' }), emit: state => states.push(state) });
  t.after(async () => { await reopened.close(); });
  await reopened.start(60000);
  await reopened.observe();
  const published = states.at(-1);
  assert.ok(published, 'start 必须发布状态');
  // 已发送任务的跟踪不受影响：requests 里包含该记录（观察/未读数仍工作），但没有 current 草稿。
  assert.ok(published!.requests.some(entry => entry.id === row.id), '已发送任务必须仍在跟踪列表中');
  assert.equal(published!.draft, undefined, '已发送任务不得变成可编辑 current 草稿');
  assert.deepEqual(f.sends, { native: 0, harness: 0, codex: 0 }, '启动跟踪不得重发已发任务');
});

test('DUX-04 显式「继续此任务」（resume_draft）让旧草稿重新成为 current，confirm 前零派发', async t => {
  const f = await fixture(t);
  const oldDraft = f.receipts.createDraft(scope, '1111');
  f.receipts.mutateDraft(oldDraft.id, oldDraft.version, row => { row.createdAt = HALF_MONTH_AGO; });
  await f.work.close();

  const states: DesktopWorkState[] = [];
  const reopened = new DesktopWork({ receipts: f.receipts, projects: f.projects, forwarding: f.forwarding, classify: async () => ({ kind: 'companion' }), emit: state => states.push(state) });
  t.after(async () => { await reopened.close(); });
  await reopened.start(60000);
  assert.equal(states.at(-1)!.draft, undefined, '启动后 current 为空');
  // 用户在工程记录里点「继续此任务」：显式意图让草稿重新成为 current（版本取实时值）。
  await reopened.action({ type: 'resume_draft', draftId: oldDraft.id, expectedVersion: f.receipts.draft(oldDraft.id).version });
  const resumed = states.at(-1)!;
  assert.ok(resumed.draft, '显式 resume 后草稿成为 current');
  assert.equal(resumed.draft!.id, oldDraft.id);
  assert.equal(resumed.sourceInput?.draftId, oldDraft.id, 'resume 后 sourceInput 指向被恢复的草稿');
  assert.equal(f.sends.codex + f.sends.harness + f.sends.native, 0, '显式 resume 之前/期间零派发');
  // stale version 拒绝：版本不匹配的 resume 是无效操作 —— current 保持不变，错误可见（detail），
  // 不清除合法 current、不建立新 current、零派发。
  await reopened.action({ type: 'resume_draft', draftId: oldDraft.id, expectedVersion: f.receipts.draft(oldDraft.id).version + 999 });
  assert.equal(states.at(-1)!.draft?.id, oldDraft.id, 'stale resume 不得改变已有 current');
  assert.ok(states.at(-1)!.detail, 'stale resume 的错误必须可见');
  // dismissed 草稿不得 resume（同样是无效操作：current 不变）。
  const dismissed = f.receipts.createDraft(scope, '已放弃的任务');
  f.receipts.mutateDraft(dismissed.id, dismissed.version, row => { row.status = 'dismissed'; });
  await reopened.action({ type: 'resume_draft', draftId: dismissed.id, expectedVersion: f.receipts.draft(dismissed.id).version });
  assert.equal(states.at(-1)!.draft?.id, oldDraft.id, 'dismissed 草稿不得成为 current');
});

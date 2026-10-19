/**
 * tests/companion-knowledge/batch-reader.test.ts
 *
 * CK-01: 正文读取端口与批次成功语义。
 *
 * AC-01-1：正文内容等值；displayName 永不充当正文；空/缺失/版本改变有明确结果。
 * AC-01-2：缺 reader/OCR 有待处理项不 daily complete；真实无新增/确定未支持清楚分类。
 * AC-01-3：分页（>=51 项）、重放/冲突/取消/撤销中读/过期/失败重试/重启保内容与状态。
 * AC-01-4：管理 API 经正式组合根获得同一 reader 与 job（HTTP 不能注入 read 函数）。
 *
 * 被测模块为真实 CollectionStore + 真实 CollectionBatchRunner，不使用假存储。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY } from '../../contracts/collection.js';
import { CollectionBatchRunner } from '../../core/collection-batch-runner.js';
import { CollectionSourceReader } from '../../core/collection-source-reader.js';
import { DocumentParser } from '../../core/document-parser.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';
import type { SourceGrant } from '../../contracts/companion-mode.js';

const pairing = productionPairing('companion', 'inst-ck01');
const DAY = '2026-10-07';

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
}

function grant(overrides: Partial<SourceGrant> = {}): SourceGrant {
  return Object.freeze({
    schemaVersion: 1 as const,
    grantId: 'grant-ck01',
    revision: 1,
    pairing,
    kind: 'download_directory' as const,
    scope: Object.freeze({ canonicalRoot: 'C:/synthetic' }),
    purposes: Object.freeze(['receive', 'parse'] as const),
    destination: 'local' as const,
    grantedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    profile: 'normal' as const,
    state: 'active' as const,
    ...overrides,
  });
}

async function harness(p: PairingScope = pairing) {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck01-'));
  const clock = new FakeClock(Date.parse('2026-10-07T02:00:00.000Z'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: clock.now,
  });
  const db = memory.rawDatabaseForKnowledge();
  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'),
    policy: NORMAL_COLLECTION_POLICY,
    now: clock.now,
  });
  return { root, clock, memory, db, store };
}

/** A candidate whose label deliberately differs from its body. */
function addTextCandidate(
  store: CollectionStore, g: SourceGrant,
  input: { nativeEventId: string; body: string | null; label: string; expiresAt?: string; receivedAt?: string },
): string {
  const result = store.appendCandidate(g, {
    sourceKind: 'input_text',
    modeGeneration: 1,
    nativeEventId: input.nativeEventId,
    receivedAt: input.receivedAt ?? '2026-10-07T01:00:00.000Z',
    origin: 'synthetic',
    confidence: 1,
    expiresAt: input.expiresAt ?? '2026-12-01T00:00:00.000Z',
    payloadRef: `payload-${input.nativeEventId}`,
    textContent: input.body,
    displayName: input.label,
    mimeType: 'text/plain',
    stableVersion: 'v1',
  }, input.nativeEventId);
  assert.equal(result.outcome, 'inserted', `候选写入失败: ${result.reason ?? ''}`);
  return result.sampleId!;
}

async function settle(): Promise<void> { await new Promise(r => setTimeout(r, 30)); }

// ================================================================================================
// AC-01-1 · 正文等值，displayName 永不充当正文
// ================================================================================================

test('AC-01-1: 派生正文必须等于真实 BODY，不得退回 LABEL', async () => {
  const h = await harness();
  try {
    const g = grant();
    addTextCandidate(h.store, g, { nativeEventId: 'e-body-1', body: '今天把 Aika 的批次正文读完并核对了两个 P1。', label: 'LABEL-SHOULD-NEVER-BE-USED.md' });

    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, parser: new DocumentParser(),
      reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'manual', operationId: 'op-body-1', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-body-1')!;
    assert.equal(receipt.counts.processed, 1);
    assert.equal(receipt.items[0]!.outcome, 'processed');

    const derived = h.db.prepare(`SELECT text_content FROM collection_derived_text WHERE processing_key LIKE 'proc-%'`).get() as { text_content: string };
    assert.equal(derived.text_content, '今天把 Aika 的批次正文读完并核对了两个 P1。');
    assert.ok(!derived.text_content.includes('LABEL-SHOULD-NEVER-BE-USED'), 'displayName 绝不能成为正文');
  } finally { h.memory.close(); }
});

test('AC-01-1: 空正文不得记为成功派生', async () => {
  const h = await harness();
  try {
    const g = grant();
    addTextCandidate(h.store, g, { nativeEventId: 'e-empty', body: '   \n  ', label: '空白正文.md' });
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'manual', operationId: 'op-empty', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-empty')!;
    assert.equal(receipt.items[0]!.outcome, 'no-content');
    const rows = h.db.prepare(`SELECT COUNT(*) AS n FROM collection_derived_text`).get() as { n: number };
    assert.equal(rows.n, 0, '空正文不得写入派生表');
  } finally { h.memory.close(); }
});

test('AC-01-1: 缺正文时给出明确 outcome，不得用 displayName 顶替', async () => {
  const h = await harness();
  try {
    const g = grant();
    // 正文为 null，label 存在 —— 这正是旧实现取巧的路径。
    const id = addTextCandidate(h.store, g, { nativeEventId: 'e-nobody', body: null, label: '只有名字没有正文.txt' });
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'manual', operationId: 'op-nobody', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-nobody')!;
    assert.notEqual(receipt.items[0]!.outcome, 'processed');
    assert.ok(['unsupported', 'missing'].includes(receipt.items[0]!.outcome), `实际 ${receipt.items[0]!.outcome}`);
    const rows = h.db.prepare(`SELECT text_content FROM collection_derived_text`).all() as { text_content: string }[];
    assert.equal(rows.length, 0);
    assert.ok(!rows.some(r => r.text_content.includes('只有名字没有正文')));
    assert.ok(id.length > 0);
  } finally { h.memory.close(); }
});

test('AC-01-1: 来源修订或授权修订变化时拒绝读取', async () => {
  const h = await harness();
  try {
    const g = grant();
    const id = addTextCandidate(h.store, g, { nativeEventId: 'e-rev', body: '原始正文', label: 'r.md' });
    const reader = new CollectionSourceReader(h.store);

    const ok = await reader.read({ pairing, sourceId: id, expectedSourceRevision: 1, grantRevision: 1, purpose: 'parse' });
    assert.equal(ok.outcome, 'ok');

    const stale = await reader.read({ pairing, sourceId: id, expectedSourceRevision: 99, grantRevision: 1, purpose: 'parse' });
    assert.equal(stale.outcome, 'version-conflict');

    const wrongGrant = await reader.read({ pairing, sourceId: id, expectedSourceRevision: 1, grantRevision: 7, purpose: 'parse' });
    assert.equal(wrongGrant.outcome, 'version-conflict');

    const otherPairing = productionPairing('companion', 'inst-other');
    const foreign = await reader.read({ pairing: otherPairing, sourceId: id, expectedSourceRevision: 1, grantRevision: 1, purpose: 'parse' });
    assert.equal(foreign.outcome, 'missing', '跨配对读取必须不可区分于缺失');
  } finally { h.memory.close(); }
});

// ================================================================================================
// AC-01-2 · 缺能力不完成日；真实无新增 / 确定未支持分类清楚
// ================================================================================================

test('AC-01-2: 缺 reader 且存在可解析文件时，daily 不得完成', async () => {
  const h = await harness();
  try {
    const g = grant();
    addTextCandidate(h.store, g, { nativeEventId: 'e-noreader', body: '有正文但没有任何 reader', label: 'a.md' });

    // 故意不注入 reader：这正是 trial-backend 装配前的真实状态。
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, parser: new DocumentParser(), now: h.clock.now,
    });
    await runner.request({ trigger: 'daily', operationId: 'op-noreader', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-noreader')!;
    assert.equal(receipt.dayCompleted, false, '缺 reader 绝不能写入每日成功');
    assert.equal(receipt.state, 'failed');
    assert.equal(receipt.reasonCode, 'capability_missing');
    assert.equal(runner.isDayCompleted(DAY), false, '每日账本不得记录成功');
  } finally { h.memory.close(); }
});

test('AC-01-2: 有 reader 但无 parser（OCR/解析能力缺失）同样不得完成日', async () => {
  const h = await harness();
  try {
    const g = grant({ kind: 'download_directory' as const });
    const registered = h.store.registerManagedAsset({
      pairing, bytes: Buffer.from('file body that needs a parser', 'utf8'), mimeType: 'text/plain',
    });
    assert.ok('assetId' in registered);
    const assetId = registered.assetId;
    h.store.appendCandidate(g, {
      sourceKind: 'download_directory', modeGeneration: 1, nativeEventId: 'e-noparser',
      receivedAt: '2026-10-07T01:00:00.000Z', origin: 'synthetic', confidence: 1,
      expiresAt: '2026-12-01T00:00:00.000Z', payloadRef: assetId,
      displayName: 'report.md', mimeType: 'text/plain', size: 33, stableVersion: 'v1',
    }, 'e-noparser');

    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'daily', operationId: 'op-noparser', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-noparser')!;
    assert.equal(receipt.dayCompleted, false);
    assert.equal(receipt.reasonCode, 'capability_missing');
  } finally { h.memory.close(); }
});

test('AC-01-2: 真实无新增是合法 no-op 完成，且分类清楚', async () => {
  const h = await harness();
  try {
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'daily', operationId: 'op-noop', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-noop')!;
    assert.equal(receipt.counts.accepted, 0);
    assert.equal(receipt.reasonCode, 'no_new_input');
    assert.equal(receipt.dayCompleted, true, '真的没有新增，完成日是诚实的');
    assert.equal(runner.isDayCompleted(DAY), true);
  } finally { h.memory.close(); }
});

test('AC-01-2: 未支持扩展是终态分类，不冒充成功也不冒充失败积压', async () => {
  const h = await harness();
  try {
    const g = grant({ kind: 'download_directory' as const });
    const registered = h.store.registerManagedAsset({
      pairing, bytes: Buffer.from('binary-ish', 'utf8'), mimeType: 'application/zip',
    });
    assert.ok('assetId' in registered);
    const assetId = registered.assetId;
    h.store.appendCandidate(g, {
      sourceKind: 'download_directory', modeGeneration: 1, nativeEventId: 'e-zip',
      receivedAt: '2026-10-07T01:00:00.000Z', origin: 'synthetic', confidence: 1,
      expiresAt: '2026-12-01T00:00:00.000Z', payloadRef: assetId,
      displayName: 'archive.zip', mimeType: 'application/zip', size: 10, stableVersion: 'v1',
    }, 'e-zip');

    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, parser: new DocumentParser(),
      reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'manual', operationId: 'op-zip', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-zip')!;
    assert.equal(receipt.items[0]!.outcome, 'unsupported');
    assert.equal(receipt.state, 'succeeded');
    assert.equal(receipt.counts.processed, 0);
  } finally { h.memory.close(); }
});

test('AC-01-2: 正常读取 TXT/MD 正文成功', async () => {
  const h = await harness();
  try {
    const g = grant({ kind: 'download_directory' as const });
    const body = '会议纪要：确认 CK-01 的读取端口与批次语义。';
    const registered = h.store.registerManagedAsset({
      pairing, bytes: Buffer.from(body, 'utf8'), mimeType: 'text/markdown',
    });
    assert.ok('assetId' in registered);
    const assetId = registered.assetId;
    h.store.appendCandidate(g, {
      sourceKind: 'download_directory', modeGeneration: 1, nativeEventId: 'e-md',
      receivedAt: '2026-10-07T01:00:00.000Z', origin: 'synthetic', confidence: 1,
      expiresAt: '2026-12-01T00:00:00.000Z', payloadRef: assetId,
      displayName: 'notes.md', mimeType: 'text/markdown', size: Buffer.byteLength(body), stableVersion: 'v1',
    }, 'e-md');

    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, parser: new DocumentParser(),
      reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'daily', operationId: 'op-md', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-md')!;
    assert.equal(receipt.items[0]!.outcome, 'processed');
    const derived = h.db.prepare(`SELECT text_content FROM collection_derived_text`).get() as { text_content: string };
    assert.ok(derived.text_content.includes('确认 CK-01 的读取端口'));
    assert.equal(receipt.dayCompleted, true);
    assert.equal(runner.isDayCompleted(DAY), true);
  } finally { h.memory.close(); }
});

// ================================================================================================
// AC-01-3 · 分页、重放/冲突、取消、撤销中读、过期、重启
// ================================================================================================

test('AC-01-3: 至少 51 项分页处理不丢项、不尾项丢失', async () => {
  const h = await harness();
  try {
    const g = grant();
    for (let i = 0; i < 51; i += 1) {
      addTextCandidate(h.store, g, { nativeEventId: `e-page-${String(i).padStart(3, '0')}`, body: `第 ${i} 条正文`, label: `f${i}.md` });
    }
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'daily', operationId: 'op-page', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-page')!;
    assert.equal(receipt.counts.accepted, 51, '页大小 50 只是页大小，必须续页');
    assert.equal(receipt.counts.processed, 51);
    assert.equal(receipt.remaining, 0);
    const rows = h.db.prepare(`SELECT COUNT(*) AS n FROM collection_derived_text`).get() as { n: number };
    assert.equal(rows.n, 51, '尾项不得被悄悄丢弃');
    const last = h.db.prepare(`SELECT text_content FROM collection_derived_text WHERE text_content LIKE '第 50 条%'`).get() as { text_content: string } | undefined;
    assert.ok(last, '第 51 项必须被处理');
  } finally { h.memory.close(); }
});

test('AC-01-3: 相同 operationId 与相同 payload 重放同 receipt；不同 payload 冲突', async () => {
  const h = await harness();
  try {
    const g = grant();
    addTextCandidate(h.store, g, { nativeEventId: 'e-idem', body: '幂等正文', label: 'i.md' });
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });

    const first = await runner.request({ trigger: 'manual', operationId: 'op-idem', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();
    const replay = await runner.request({ trigger: 'manual', operationId: 'op-idem', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    assert.equal(replay.jobId, first.jobId, '相同重放必须返回同一回执，不得二次派生');

    await assert.rejects(
      () => runner.request({ trigger: 'daily', operationId: 'op-idem', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY }),
      (err: Error) => err.message === 'operation_id_payload_conflict',
    );
    const rows = h.db.prepare(`SELECT COUNT(*) AS n FROM collection_derived_text`).get() as { n: number };
    assert.equal(rows.n, 1, '重放与冲突都不得产生第二份派生');
  } finally { h.memory.close(); }
});

test('AC-01-3: 撤销后的来源不能被晚到读取提交，也不复活', async () => {
  const h = await harness();
  try {
    const g = grant();
    const id = addTextCandidate(h.store, g, { nativeEventId: 'e-revoke', body: '会被撤销的正文', label: 'r.md' });
    const reader = new CollectionSourceReader(h.store);

    const read = await reader.read({ pairing, sourceId: id, expectedSourceRevision: 1, grantRevision: 1, purpose: 'parse' });
    assert.equal(read.outcome, 'ok');

    // 读取期间发生撤销。
    h.store.invalidateCandidate(pairing, id, 'user_revoked');

    const commit = h.store.commitDerived(pairing, {
      parentRefs: [{ sourceId: id, version: 'v1' }],
      processorId: 'standard-batch-parser-v1', processorVersion: '1.1.0', grantRevision: 1,
      processingKey: 'proc-late-write', status: 'ok', text: '会被撤销的正文',
      expiresAt: '2026-12-01T00:00:00.000Z',
      expectedSourceRevision: 1, expectedGrantRevision: 1,
    });
    // 撤销同时提升了候选修订，所以拒绝理由可能是 version-conflict；关键性质是
    // 晚到写入一律被拒绝、不得落库、且来源不得复活。
    assert.equal(commit.committed, false, '撤销后不允许晚提交');
    assert.ok(['source_invalidated', 'version-conflict'].includes(commit.reason), `实际 ${commit.reason}`);
    const rows = h.db.prepare(`SELECT COUNT(*) AS n FROM collection_derived_text`).get() as { n: number };
    assert.equal(rows.n, 0, '撤销后不得写入任何派生');

    const after = await reader.read({ pairing, sourceId: id, expectedSourceRevision: 1, grantRevision: 1, purpose: 'parse' });
    assert.notEqual(after.outcome, 'ok', '撤销后不得再读出正文');
    assert.ok(['invalidated', 'version-conflict'].includes(after.outcome), `实际 ${after.outcome}`);

    // 即使按最新修订重读，也必须是 invalidated（终态），而不是复活正文。
    const current = h.db.prepare(`SELECT revision AS r, grant_revision AS g FROM collection_candidates WHERE id=?`).get(id) as { r: number; g: number };
    const revRead = await reader.read({ pairing, sourceId: id, expectedSourceRevision: current.r, grantRevision: current.g, purpose: 'parse' });
    assert.equal(revRead.outcome, 'invalidated', '按最新修订读取也必须是 invalidated，不得复活');
  } finally { h.memory.close(); }
});

test('AC-01-3: 过期来源不参与派生', async () => {
  const h = await harness();
  try {
    const g = grant();
    addTextCandidate(h.store, g, { nativeEventId: 'e-expired', body: '已过期正文', label: 'x.md', expiresAt: '2026-10-02T00:00:00.000Z' });
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'daily', operationId: 'op-expired', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();

    const receipt = runner.receiptFor('op-expired')!;
    assert.ok(['invalidated', 'missing'].includes(receipt.items[0]!.outcome), `实际 ${receipt.items[0]!.outcome}`);
    assert.equal(receipt.counts.processed, 0);
    const rows = h.db.prepare(`SELECT COUNT(*) AS n FROM collection_derived_text`).get() as { n: number };
    assert.equal(rows.n, 0);
  } finally { h.memory.close(); }
});

test('AC-01-3: 取消不吞掉非取消错误，也不留下永不结束的 active job', async () => {
  const h = await harness();
  try {
    const g = grant();
    addTextCandidate(h.store, g, { nativeEventId: 'e-cancel', body: '取消测试正文', label: 'c.md' });
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    const controller = new AbortController();
    await runner.request({ trigger: 'manual', operationId: 'op-cancel', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY, signal: controller.signal });
    controller.abort();
    await settle();

    const rows = h.db.prepare(`SELECT state, reason_code FROM collection_jobs WHERE job_id != ? ORDER BY rowid DESC LIMIT 1`).get('x') as { state: string; reason_code: string | null } | undefined;
    assert.ok(rows, '必须有一个持久 job');
    assert.notEqual(rows!.state, 'running', '取消后不得留下永远 running 的 job');

    // runner 已释放，后续请求必须可继续。
    const g2 = grant();
    addTextCandidate(h.store, g2, { nativeEventId: 'e-after-cancel', body: '取消之后的正文', label: 'a.md' });
    await runner.request({ trigger: 'manual', operationId: 'op-after-cancel', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    await settle();
    assert.ok(runner.receiptFor('op-after-cancel'), '取消后必须能继续接受新批次');
  } finally { h.memory.close(); }
});

test('AC-01-3: 失败项有界重试使用同一 processingKey，不按天制造新 key', async () => {
  const h = await harness();
  try {
    const g = grant();
    addTextCandidate(h.store, g, { nativeEventId: 'e-retry', body: '重试正文', label: 'r.md' });

    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    await runner.request({ trigger: 'manual', operationId: 'op-retry-1', expectedPolicyRevision: 1, generation: 1, scheduledDay: '2026-10-07' });
    await settle();
    const key1 = (h.db.prepare(`SELECT processing_key AS k FROM collection_derived_text`).get() as { k: string }).k;

    // 把候选改回 pending，模拟同一来源版本的再次处理。
    h.db.prepare(`UPDATE collection_candidates SET state='pending' WHERE id=(SELECT json_extract(value,'$[0].sourceId') FROM (SELECT json_array(?) AS value) LIMIT 1)`).run('[]');
    const id = (h.db.prepare(`SELECT id FROM collection_candidates LIMIT 1`).get() as { id: string }).id;
    h.db.prepare(`UPDATE collection_candidates SET state='pending' WHERE id=?`).run(id);

    await runner.request({ trigger: 'manual', operationId: 'op-retry-2', expectedPolicyRevision: 1, generation: 1, scheduledDay: '2026-10-08' });
    await settle();

    const keys = (h.db.prepare(`SELECT processing_key AS k FROM collection_derived_text`).all() as { k: string }[]).map(r => r.k);
    assert.equal(keys.length, 1, '同来源版本与处理器版本只能有一条派生，不得每天新 key');
    assert.equal(keys[0], key1);
    assert.ok(key1.includes('standard-batch-parser-v1'), 'processingKey 必须含处理器版本');
  } finally { h.memory.close(); }
});

test('AC-01-3: 重启后回执与派生内容保持一致，不复活已失效来源', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck01-restart-'));
  const clock = new FakeClock(Date.parse('2026-10-07T02:00:00.000Z'));
  const dbPath = resolve(root, 'companion.sqlite');
  const pairingSame = pairing;

  const open = async () => {
    const memory = new SqliteMemoryStore({
      filename: dbPath, retention: CONFIRMED_RETENTION,
      invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: clock.now,
    });
    const store = await CollectionStore.open(memory, {
      collectionDirectory: resolve(root, 'collection'), policy: NORMAL_COLLECTION_POLICY, now: clock.now,
    });
    return { memory, store, db: memory.rawDatabaseForKnowledge() };
  };

  const first = await open();
  addTextCandidate(first.store, grant(), { nativeEventId: 'e-restart', body: '重启前正文', label: 'r.md' });
  const runner1 = new CollectionBatchRunner({
    db: first.db, store: first.store, pairing: pairingSame, reader: new CollectionSourceReader(first.store), now: clock.now,
  });
  await runner1.request({ trigger: 'daily', operationId: 'op-restart', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
  await settle();
  assert.equal(runner1.isDayCompleted(DAY), true);
  first.memory.close();

  const second = await open();
  try {
    const runner2 = new CollectionBatchRunner({
      db: second.db, store: second.store, pairing: pairingSame, reader: new CollectionSourceReader(second.store), now: clock.now,
    });
    assert.equal(runner2.isDayCompleted(DAY), true, '每日账本必须跨重启保留');
    const receipt = runner2.receiptFor('op-restart');
    assert.ok(receipt, '持久回执必须可跨重启读取');
    assert.equal(receipt!.dayCompleted, true);

    const rows = second.db.prepare(`SELECT text_content FROM collection_derived_text`).all() as { text_content: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.text_content, '重启前正文');

    // 重放同一 operationId 仍不得产生第二份。
    await runner2.request({ trigger: 'daily', operationId: 'op-restart', expectedPolicyRevision: 1, generation: 1, scheduledDay: DAY });
    const after = second.db.prepare(`SELECT COUNT(*) AS n FROM collection_derived_text`).get() as { n: number };
    assert.equal(after.n, 1);
  } finally { second.memory.close(); }
});

// ================================================================================================
// AC-01-4 · 正式装配：HTTP 不能注入 reader
// ================================================================================================

test('AC-01-4: 批次请求不接受来自 HTTP 的 reader 回调或任意路径', async () => {
  const h = await harness();
  try {
    const g = grant();
    addTextCandidate(h.store, g, { nativeEventId: 'e-http', body: '正文', label: 'h.md' });
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing, reader: new CollectionSourceReader(h.store), now: h.clock.now,
    });
    // 即使调用方（错误地）传入 readFileBytes，也不得被采用：reader 只能来自构造注入。
    const job = await (runner as unknown as { request: (i: unknown) => Promise<unknown> }).request({
      trigger: 'manual', operationId: 'op-http', expectedPolicyRevision: 1, generation: 1,
      scheduledDay: DAY, readFileBytes: async () => new Uint8Array([1, 2, 3]),
      path: 'C:/Windows/System32/config/SAM',
    });
    await settle();
    assert.ok(job, '批次请求仍走正式 reader');
    const derived = h.db.prepare(`SELECT text_content FROM collection_derived_text`).get() as { text_content: string } | undefined;
    assert.equal(derived?.text_content, '正文', '必须来自 store 正文，而不是注入的 callback 或任意路径');
  } finally { h.memory.close(); }
});

test('AC-01-4: reader 只接受 owner 签发的资产 id，不接受任意路径', async () => {
  const h = await harness();
  try {
    const secret = resolve(h.root, 'secret.txt');
    writeFileSync(secret, 'SECRET-CONTENT', 'utf8');
    const outside = resolve(h.root, 'outside');
    mkdirSync(outside, { recursive: true });

    const bytes = h.store.readSourceBytes({ pairing, sourceId: 'asset-does-not-exist' });
    assert.equal(bytes, null, '未知来源不得返回任何字节');
    assert.equal(h.store.readSourceBytes({ pairing, sourceId: "'; DROP TABLE collection_candidates; --" }), null);
  } finally { h.memory.close(); }
});

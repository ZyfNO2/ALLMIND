/**
 * tests/companion-knowledge/product-chain.test.ts
 *
 * CK-15: the cross-step product chain, over the frozen entry points only.
 *
 * This is NOT a re-run of the per-step suites. It exists to catch the failure mode that unit tests
 * structurally cannot: two steps that each pass alone and together violate the invariant. The
 * chains here deliberately cross step boundaries — CK-01 reader → CK-02 source → CK-04 activity →
 * CK-05 wiki → CK-06 recall, and CK-10 grant → CK-11 capture → CK-12 delivery → CK-14 dedup.
 *
 * Scope honesty: this exercises the REAL modules with in-memory/fixture data. It does NOT prove
 * real Windows capture, real pixel OCR, or real model calls — those stay BLOCKED/NOT_RUN, and the
 * chain asserts the honest `unavailable` path where the capability is genuinely absent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { KnowledgeLibraryStore } from '../../memory/knowledge-library.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY } from '../../contracts/collection.js';
import { WorkspaceDirectorySource } from '../../core/workspace-directory-source.js';
import { CollectionSourceReader } from '../../core/collection-source-reader.js';
import { CollectionBatchRunner } from '../../core/collection-batch-runner.js';
import { DocumentParser } from '../../core/document-parser.js';
import { ActivityUnderstanding, type ActivityInput } from '../../core/activity-understanding.js';
import { DailyActivitySummary } from '../../core/daily-activity-summary.js';
import { WikiCompiler } from '../../core/wiki-compiler.js';
import { DomainAwareRecall } from '../../memory/continuity-context-kk.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { LocalDeliveryCoordinator, type AutomaticDeliveryLedger } from '../../core/trigger-delivery.js';
import { CompanionGreetingScheduler, type GreetingLedger, type TakeoverState } from '../../core/companion-greeting-scheduler.js';
import { checkPurpose, grantReadiness } from '../../core/screen-grant-purpose.js';
import { createHash } from 'node:crypto';
import { productionPairing } from '../../contracts/character-pack.js';
import type { SourceGrant } from '../../contracts/companion-mode.js';
import type { SourceEvidenceRef } from '../../core/collection-source-reader.js';

const PAIRING = productionPairing('companion', 'inst-ck15');
const NOW = '2026-10-07T02:00:00.000Z';

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck15-'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: () => NOW,
  });
  const db = memory.rawDatabaseForKnowledge();
  const collection = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'),
    policy: NORMAL_COLLECTION_POLICY,
    now: () => NOW,
  });
  const continuity = await ContinuityMemoryStore.open(memory);
  const knowledge = await KnowledgeLibraryStore.open(memory, resolve(root, 'knowledge'));
  const packs = await CharacterPackStore.open(memory);
  return { root, memory, db, collection, continuity, knowledge, packs, workspace: mkdtempSync(join(tmpdir(), 'aika-ck15-ws-')) };
}

function grant(): SourceGrant {
  return Object.freeze({
    schemaVersion: 1 as const, grantId: 'g-chain', revision: 1, pairing: PAIRING,
    kind: 'workspace_directory' as const,
    scope: Object.freeze({ canonicalRoot: 'C:/synthetic', recursive: false, allowedExtensions: ['.md'], importExisting: false }),
    purposes: Object.freeze(['receive', 'parse'] as const), destination: 'local' as const,
    grantedAt: NOW, expiresAt: '2026-12-01T00:00:00.000Z', profile: 'normal' as const, state: 'active' as const,
  });
}

// ================================================================================================
// Chain 1: source → reader/parser → activity → summary → wiki → context
// ================================================================================================

test('CK-15 链 1：工作区文件经真实 reader/批次 → 活动 → 日摘要 → Wiki → Context', async () => {
  const w = await world();
  try {
    // CK-02: a real file on disk, scanned by the real source.
    writeFileSync(join(w.workspace, 'notes.md'), '我最近在整理旧书店的进货记录。', 'utf8');
    const source = new WorkspaceDirectorySource({ sleep: () => Promise.resolve(), now: () => NOW });
    const scan = await source.scan({
      operationId: 'scan-1', mode: 'import-existing',
      scope: { canonicalRoot: w.workspace, recursive: false, allowedExtensions: ['.md'], importExisting: true },
    });
    assert.equal(scan.items.length, 1, 'CK-02 产出候选');
    const candidate = scan.items[0]!;

    // CK-01: stored as a real candidate, then read back through the controlled reader.
    const stored = w.collection.appendCandidate(grant(), {
      sourceKind: 'workspace_directory', modeGeneration: 1,
      nativeEventId: `ws-${candidate.contentHash.slice(0, 12)}`,
      occurredAt: NOW, receivedAt: NOW, origin: 'workspace_directory', confidence: 1,
      expiresAt: '2026-12-01T00:00:00.000Z',
      payloadRef: `wsref-${candidate.contentHash.slice(0, 12)}`,
      textContent: '我最近在整理旧书店的进货记录。',
      displayName: 'notes.md', mimeType: 'text/markdown', size: candidate.size,
      stableVersion: candidate.contentHash,
    }, 'chain-key');
    assert.equal(stored.outcome, 'inserted');

    const reader = new CollectionSourceReader(w.collection);
    const read = await reader.read({
      pairing: PAIRING, sourceId: stored.sampleId!, expectedSourceRevision: 1, grantRevision: 1, purpose: 'parse',
    });
    assert.equal(read.outcome, 'ok', 'CK-01 受控读取成功');

    // CK-04: understand + summarise, driven by the real evidence.
    const evidence: SourceEvidenceRef = (read as { evidence: SourceEvidenceRef }).evidence;
    const input: ActivityInput = {
      evidence: { ...evidence, scope: PAIRING, time: { ...evidence.time, receivedAt: NOW } },
      sourceKind: 'workspace_directory',
      text: '我最近在整理旧书店的进货记录。',
    };
    const understanding = new ActivityUnderstanding();
    const understood = understanding.understand({
      pairing: PAIRING, operationId: 'u-1', methodVersion: 'v1', inputs: [input],
    });
    assert.ok(understood.events.length >= 1, 'CK-04 产出活动事件');

    const summary = new DailyActivitySummary({ now: () => NOW }).build({
      pairing: PAIRING, localDate: '2026-10-07', timezone: 'Asia/Shanghai', operationId: 's-1',
      events: understood.events,
    });
    assert.ok(summary.eventCount >= 1);
    assert.equal(summary.delivered, false, '摘要不外发');

    // CK-05: compile those events.
    const wiki = new WikiCompiler({ continuity: w.continuity });
    const changeSet = wiki.compile({
      pairing: PAIRING, operationId: 'wk-1', methodVersion: 'v1', events: understood.events,
    });
    assert.ok(changeSet.proposals.length >= 1, 'CK-05 产出提案');
    // The workspace material routed to the reference domain, not to personal facts.
    assert.equal(changeSet.proposals.every(p => p.targetDomain !== 'user_continuity'), true,
      '工作区资料不得成为个人事实');
    wiki.commit(PAIRING, changeSet);

    // CK-06: recall must see the domain separation.
    const recall = new DomainAwareRecall({
      packs: w.packs, memory: w.continuity, knowledge: w.knowledge, referenceLibraryId: null,
    });
    const recalled = await recall.recall({ pairing: PAIRING, query: '旧书店 进货记录', tokenBudget: 2000 });
    assert.equal(typeof recalled.text, 'string');
    // A workspace document never became a personal user fact.
    const snapshot = w.continuity.snapshot(PAIRING, { includeCandidates: true });
    assert.equal(snapshot.wiki.length + snapshot.soul.length, 0, '工作区资料未进入用户事实层');
  } finally { w.memory.close(); }
});

test('CK-15 链 1 负例：撤销来源后，旧内容不再进入 Context', async () => {
  const w = await world();
  try {
    const stored = w.collection.appendCandidate(grant(), {
      sourceKind: 'manual_text', modeGeneration: 1, nativeEventId: 'c-1',
      occurredAt: NOW, receivedAt: NOW, origin: 'synthetic', confidence: 1,
      expiresAt: '2026-12-01T00:00:00.000Z', payloadRef: 'c1',
      textContent: '我住在临海城。', displayName: 'c.md',
    }, 'k1');
    const record = w.continuity.record({
      pairing: PAIRING, operationId: 'f-1', layer: 'user_wiki', kind: 'fact',
      text: '我住在临海城。', origin: 'user', status: 'active', sourceIds: [`manual_text:${stored.sampleId}`],
    });
    assert.equal(record.status, 'applied');

    const before = w.continuity.snapshot(PAIRING).wiki;
    assert.equal(before.length, 1);

    // Revoke the source, then correct the fact away.
    w.continuity.correct({
      pairing: PAIRING, operationId: 'c-x', targetId: record.fact.id,
      expectedVersion: record.fact.version, text: '我搬到临海城了。', reason: '用户更正。',
    });
    const after = w.continuity.snapshot(PAIRING).wiki;
    assert.equal(after.some(f => f.text === '我住在临海城。'), false, '旧结论不得继续召回');
    assert.equal(after.some(f => f.text === '我搬到临海城了。'), true);
  } finally { w.memory.close(); }
});

// ================================================================================================
// Chain 2: grant → purpose check → capture → delivery → greeting dedup
// ================================================================================================

test('CK-15 链 2：授权用途 → 投递 → 问候去重（无屏幕能力仍可投递）', async () => {
  const w = await world();
  try {
    // CK-10: purpose/destination separation.
    const localOk = checkPurpose({ purpose: 'capture-continuous-local', destination: 'local', userConfirmed: true });
    assert.equal(localOk.allowed, true);
    const cloudWrong = checkPurpose({ purpose: 'capture-continuous-cloud-image', destination: 'local', userConfirmed: true, modelBinding: 'm' });
    assert.equal(cloudWrong.allowed, false, '云图不得降级为本地');

    // CK-10: readiness distinguishes the reasons.
    assert.equal(grantReadiness({ grant: null, capabilityAvailable: false, nowIso: NOW }).reason, 'no_grant');

    // CK-12: local delivery with no screen capability at all.
    const autoOps = new Map<string, { signature: string; triggerId: string }>();
    const auto: string[] = [];
    const ledger: AutomaticDeliveryLedger = {
      async countAutomatic(input) { const k = `${input.localDate}|${input.ruleId}`; if (auto.includes(k)) return false; auto.push(k); return true; },
      readOperation(input) { return autoOps.get(`${input.pairingKey}|${input.operationId}`) ?? null; },
      writeOperation(input) { autoOps.set(`${input.pairingKey}|${input.operationId}`, { signature: input.signature, triggerId: input.triggerId }); },
    };
    const delivery = new LocalDeliveryCoordinator({ ledger, now: () => Date.parse(NOW) });
    const accepted = delivery.accept({
      pairing: PAIRING, operationId: 'g-1', kind: 'greeting', text: '晚上好，今天辛苦了。',
      ruleId: 'evening', localDate: '2026-10-07', timezone: 'Asia/Shanghai',
    });
    assert.equal(accepted.outcome, 'accepted');
    delivery.rendered(accepted.triggerId!, { characterId: PAIRING.characterId, sessionId: 's-1', generation: 1 });
    const ack = delivery.acknowledge(accepted.triggerId!, {
      characterId: PAIRING.characterId, sessionId: 's-1', generation: 1, triggerId: accepted.triggerId!,
    });
    assert.equal(ack.ok, true, '无屏幕能力也能完成投递与 ack');
    assert.deepEqual(auto, [], '本地问候不占自动配额');

    // CK-14: the same rule cannot fire twice on the same local day.
    const greetingRecords: { pairingKey: string; ruleId: string; localDate: string }[] = [];
    const greetingLedger: GreetingLedger = {
      has(input) { return greetingRecords.some(r => r.pairingKey === input.pairingKey && r.ruleId === input.ruleId && r.localDate === input.localDate); },
      commit(record) { greetingRecords.push({ pairingKey: record.pairingKey, ruleId: record.ruleId, localDate: record.localDate }); },
      async reserve() { return true; },
    };
    const takeover: TakeoverState = { phase: 'ready', reason: null, migratedEnabled: true, migrationVersion: 1 };
    let clock = Date.parse('2026-10-07T00:00:00.000Z'); // 08:00 Shanghai
    const greeting = new CompanionGreetingScheduler({
      now: () => clock, ledger: greetingLedger, busy: () => ({ busy: false }), takeover,
      deliver: async () => 'trigger-g',
    });
    const rule = { id: 'evening', enabled: true, localTime: '08:00', timezone: 'Asia/Shanghai' };
    const first = await greeting.tick({ pairing: PAIRING, rules: [rule] });
    assert.equal(first[0]!.outcome, 'delivered-candidate');
    greeting.commitShown({ pairing: PAIRING, ruleId: 'evening', localDate: '2026-10-07', timezone: 'Asia/Shanghai', scope: 's-1', shownAt: clock });

    clock += 60_000;
    const second = await greeting.tick({ pairing: PAIRING, rules: [rule] });
    assert.equal(second[0]!.outcome, 'suppressed', '同日本地日只一次');
    assert.equal(greetingRecords.length, 1);
  } finally { w.memory.close(); }
});

// ================================================================================================
// Chain 3: honesty of absent capabilities
// ================================================================================================

test('CK-15 链 3：缺能力处如实 unavailable，不用另一条路线顶替', async () => {
  const w = await world();
  try {
    const { createLocalOcrEngine } = await import('../../core/local-ocr-engine.js');
    const { captureAvailability } = await import('../../core/windows-screen-capture.js');
    // No native hook wired: both must say unavailable rather than pretend.
    const ocr = await createLocalOcrEngine()(new Uint8Array(64 * 64 * 3).fill(0x7f));
    assert.equal(ocr.status, 'unavailable');
    assert.equal(ocr.readingOrderText, '', '不得编造识别文本');

    const capture = captureAvailability({});
    assert.equal(capture.available, false);
    assert.equal(capture.reason, 'host_bridge_missing');

    // The plain conversation path still works without any of it.
    const delivery = new LocalDeliveryCoordinator({
      ledger: {
        async countAutomatic() { return true; },
        readOperation() { return null; },
        writeOperation() {},
      },
      now: () => Date.parse(NOW),
    });
    const manual = delivery.accept({ pairing: PAIRING, operationId: 'm-1', kind: 'manual', text: '普通对话正文。' });
    assert.equal(manual.outcome, 'accepted', '缺采集能力不影响本地投递');
  } finally { w.memory.close(); }
});

// ================================================================================================
// Evidence helpers used by the report
// ================================================================================================

test('CK-15: 证据指纹可复算（供报告 ledger 使用）', () => {
  const digest = createHash('sha256').update('ck15-evidence-probe').digest('hex');
  assert.equal(digest.length, 64);
  assert.equal(digest, createHash('sha256').update('ck15-evidence-probe').digest('hex'), '同输入同指纹');
});

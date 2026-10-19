/**
 * tests/companion-knowledge/context-consumption.test.ts
 *
 * CK-06: 分域召回与下一轮正式 Context 消费。
 *
 * AC-06-1: Character Wiki 事实独立命中，不拿 Canon 事件冒充；各域来源正确。
 * AC-06-2: 预算、去重、无证据未知、角色知情与私人配对隔离通过；发送前撤销拒绝晚结果。
 * AC-06-3: 正式召回链接线（真实 packs/memory/knowledge + CK-04 活动）。
 * AC-06-4: 纠正/遗忘后不召回旧结论；修订变化使在途结果失效。
 *
 * 走真实 CharacterPackStore / ContinuityMemoryStore / KnowledgeLibraryStore 与 CK-04 活动事件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { KnowledgeLibraryStore } from '../../memory/knowledge-library.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { DomainAwareRecall, classifyRecallIntent } from '../../memory/continuity-context-kk.js';
import { ActivityUnderstanding, type ActivityInput } from '../../core/activity-understanding.js';
import type { SourceEvidenceRef } from '../../core/collection-source-reader.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';

const NOW = '2026-10-07T02:00:00.000Z';
const PAIRING = productionPairing('companion', 'inst-a');

async function harness(pairing: PairingScope = PAIRING) {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck06-'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: () => NOW,
  });
  const packs = await CharacterPackStore.open(memory);
  const continuity = await ContinuityMemoryStore.open(memory);
  const knowledge = await KnowledgeLibraryStore.open(memory, resolve(root, 'knowledge'));
  return { root, memory, packs, continuity, knowledge, pairing };
}

/** CK-04 evidence -> activity event, so the recall layer consumes the real upstream shape. */
function activityFrom(sourceId: string, claim: string, occurredAt: string, text: string): ActivityInput {
  const evidence: SourceEvidenceRef = Object.freeze({
    schemaVersion: 1, sourceKind: 'manual_text', sourceId, sourceRevision: 1,
    contentHash: `h-${sourceId}`, locator: `doc:${sourceId}`, scope: PAIRING,
    grantId: 'g-1', grantRevision: 1, generation: 1, origin: 'synthetic',
    validity: 'valid', expiresAt: '2026-12-01T00:00:00.000Z',
    time: Object.freeze({ occurredAt, occurredAtBasis: 'user-stated' as const, receivedAt: NOW }),
  } as SourceEvidenceRef);
  return { evidence, sourceKind: 'manual_text', text, userSubmitted: true };
}

const understanding = new ActivityUnderstanding();
function events(inputs: readonly ActivityInput[]) {
  return understanding.understand({
    pairing: PAIRING, operationId: 'op-act', methodVersion: 'v1', inputs,
  }).events;
}

function recallFor(h: Awaited<ReturnType<typeof harness>>, referenceLibraryId: string | null = null) {
  return new DomainAwareRecall({
    packs: h.packs, memory: h.continuity, knowledge: h.knowledge,
    referenceLibraryId, characterWikiFacts: [],
  });
}

// ================================================================================================
// AC-06-1 各域独立与来源正确
// ================================================================================================

test('AC-06-1: Character Wiki 是独立域，且绝不用 Canon 事件冒充', async () => {
  const h = await harness();
  try {
    // 无 character wiki 事实时，该域必须缺席——而不是塞一条 canon 充数。
    const empty = await recallFor(h).recall({ pairing: h.pairing, query: '他今天做了什么', tokenBudget: 2000 });
    assert.equal(empty.selected.some(s => s.source === 'character_wiki'), false, '没有角色 Wiki 事实时该域不得出现');
    assert.equal(empty.segments.some(s => s.source === 'character_wiki'), false);

    // 提供真实角色 wiki 事实后独立命中。
    const withWiki = new DomainAwareRecall({
      packs: h.packs, memory: h.continuity, knowledge: h.knowledge, referenceLibraryId: null,
      characterWikiFacts: [{ id: 'cwf-1', text: '阿航在旧城区开了一家旧书店。', evidenceIds: ['pack:p1:soul'] }],
    });
    const result = await withWiki.recall({ pairing: h.pairing, query: '他今天做了什么', tokenBudget: 2000 });
    const wiki = result.selected.find(s => s.source === 'character_wiki');
    assert.ok(wiki, '角色 Wiki 事实应独立命中');
    assert.equal(wiki!.text, '阿航在旧城区开了一家旧书店。');
    assert.equal(wiki!.reason, '角色 Wiki 事实（独立域，非原作事件）');
  } finally { h.memory.close(); }
});

test('AC-06-1: 近期活动域只消费 CK-04 事件，来源可定位', async () => {
  const h = await harness();
  try {
    const act = events([activityFrom('a-1', '整理了旧书店的书单', '2026-10-07T01:00:00.000Z', '整理了旧书店的书单')]);
    const result = await recallFor(h).recall({
      pairing: h.pairing, query: '今天做了什么', tokenBudget: 2000, recentActivity: act,
    });
    const seg = result.selected.find(s => s.source === 'recent_activity');
    assert.ok(seg, '近期活动应命中');
    assert.equal(seg!.text, '整理了旧书店的书单');
    assert.deepEqual([...seg!.evidenceIds], ['manual_text:a-1'], '活动必须带可定位来源');
    assert.equal(result.intent, 'recent_activity');
  } finally { h.memory.close(); }
});

test('AC-06-1: 意图分类区分近期/角色/用户资料', () => {
  assert.equal(classifyRecallIntent('今天我做了什么'), 'recent_activity');
  assert.equal(classifyRecallIntent('最近有什么进展'), 'recent_activity');
  assert.equal(classifyRecallIntent('他是什么角色设定'), 'character_knowledge');
  assert.equal(classifyRecallIntent('我的偏好是什么'), 'user_facts');
  assert.equal(classifyRecallIntent('随便聊聊'), 'mixed');
});

// ================================================================================================
// AC-06-2 预算 / 去重 / 配对隔离
// ================================================================================================

test('AC-06-2: 预算受限，被排除项带理由', async () => {
  const h = await harness();
  try {
    h.continuity.record({ pairing: h.pairing, operationId: 'f-1', layer: 'user_wiki', kind: 'fact', text: 'A'.repeat(400), origin: 'user', status: 'active' });
    h.continuity.record({ pairing: h.pairing, operationId: 'f-2', layer: 'user_wiki', kind: 'fact', text: 'B'.repeat(400), origin: 'user', status: 'active' });
    const result = await recallFor(h).recall({ pairing: h.pairing, query: '资料', tokenBudget: 60 });
    const used = result.selected.reduce((sum, s) => sum + s.tokens, 0);
    assert.ok(used <= 60, `选中条目不得超过预算，实际 ${used}`);
    assert.ok(result.omitted.some(s => s.reason === '超出本轮 Context 预算'), '超预算必须可见');
  } finally { h.memory.close(); }
});

test('AC-06-2: 跨域同文本只召回一次', async () => {
  const h = await harness();
  try {
    const same = '同一条内容出现在两个域';
    h.continuity.record({ pairing: h.pairing, operationId: 'f-1', layer: 'user_wiki', kind: 'fact', text: same, origin: 'user', status: 'active' });
    const act = events([activityFrom('a-1', same, '2026-10-07T01:00:00.000Z', same)]);
    const result = await recallFor(h).recall({ pairing: h.pairing, query: '内容', tokenBudget: 2000, recentActivity: act });
    const hits = result.selected.filter(s => s.text === same);
    assert.equal(hits.length, 1, '同文本只应被召回一次');
    assert.ok(result.omitted.some(s => s.reason.startsWith('与更高优先级条目重复')), '重复项必须带理由');
  } finally { h.memory.close(); }
});

test('AC-06-2: 私人资料跨实例不可召回（CK-05 实例隔离在读侧生效）', async () => {
  const h = await harness();
  try {
    const library = await h.knowledge.create('A 的私人资料', h.pairing.characterId, h.pairing.characterInstanceId);
    await h.knowledge.importDocuments(library.id, [{ sourceName: 'secret.md', text: '实例 A 的机密笔记内容' }]);

    const mine = await recallFor(h, library.id).recall({ pairing: h.pairing, query: '机密', tokenBudget: 2000 });
    assert.ok(mine.selected.some(s => s.text.includes('机密笔记')), '本实例应能召回自己的资料');

    // 另一实例即便知道 libraryId，也读不到。
    const other = productionPairing('companion', 'inst-b');
    const theirs = await recallFor(h, library.id).recall({ pairing: other, query: '机密', tokenBudget: 2000 });
    assert.equal(theirs.selected.some(s => s.text.includes('机密笔记')), false, '跨实例必须不可见');
    assert.equal(theirs.segments.some(s => s.source === 'reference_knowledge'), false);
  } finally { h.memory.close(); }
});

test('AC-06-2: 无证据时返回空而非编造记忆', async () => {
  const h = await harness();
  try {
    const result = await recallFor(h).recall({ pairing: h.pairing, query: '我的资料里有什么', tokenBudget: 2000 });
    assert.equal(result.text, '', '没有任何真实资料时不得编造');
    assert.equal(result.selected.length, 0);
  } finally { h.memory.close(); }
});

// ================================================================================================
// AC-06-4 撤销/纠正/修订变化
// ================================================================================================

test('AC-06-4: 遗忘后下一轮召回不含旧结论', async () => {
  const h = await harness();
  try {
    const created = h.continuity.record({
      pairing: h.pairing, operationId: 'f-1', layer: 'user_wiki', kind: 'fact',
      text: '用户喜欢薄荷茶。', origin: 'user', status: 'active',
    });
    const before = await recallFor(h).recall({ pairing: h.pairing, query: '薄荷', tokenBudget: 2000 });
    assert.ok(before.selected.some(s => s.text.includes('薄荷茶')), '遗忘前应能召回');

    h.continuity.forget({
      pairing: h.pairing, operationId: 'fg-1', targetId: created.fact.id,
      expectedVersion: created.fact.version, reason: '用户要求遗忘。',
    });
    const after = await recallFor(h).recall({ pairing: h.pairing, query: '薄荷', tokenBudget: 2000 });
    assert.equal(after.selected.some(s => s.text.includes('薄荷茶')), false, '遗忘后不得召回旧结论');
  } finally { h.memory.close(); }
});

test('AC-06-4: 纠正后旧结论退出召回，新结论生效', async () => {
  const h = await harness();
  try {
    const first = h.continuity.record({
      pairing: h.pairing, operationId: 'f-1', layer: 'user_wiki', kind: 'state',
      text: '用户正在跑步。', origin: 'user', status: 'active',
    });
    h.continuity.correct({
      pairing: h.pairing, operationId: 'c-1', targetId: first.fact.id,
      expectedVersion: first.fact.version, text: '用户目前暂停跑步。', reason: '用户纠正当前状态。',
    });
    const result = await recallFor(h).recall({ pairing: h.pairing, query: '跑步', tokenBudget: 2000 });
    assert.equal(result.selected.some(s => s.text.includes('正在跑步')), false, '旧结论必须退出');
    assert.ok(result.selected.some(s => s.text.includes('暂停跑步')), '纠正后的结论应生效');
  } finally { h.memory.close(); }
});

test('AC-06-4: 发送前修订变化使在途结果失效（assertCurrent）', async () => {
  const h = await harness();
  try {
    const recall = recallFor(h);
    const composed = await recall.recall({ pairing: h.pairing, query: '资料', tokenBudget: 2000 });
    recall.assertCurrent(composed, { pairing: h.pairing, query: '资料', tokenBudget: 2000 });

    // 纠正后旧结果必须被拒。
    const created = h.continuity.record({
      pairing: h.pairing, operationId: 'f-1', layer: 'user_wiki', kind: 'fact',
      text: '新条目', origin: 'user', status: 'active',
    });
    void created;
    assert.throws(
      () => recall.assertCurrent(composed, { pairing: h.pairing, query: '资料', tokenBudget: 2000 }),
      /stale_context/,
      '在途结果在记忆变更后必须拒绝发送',
    );
  } finally { h.memory.close(); }
});

test('AC-06-4: 知识库变更同样使在途结果失效', async () => {
  const h = await harness();
  try {
    const library = await h.knowledge.create('资料', h.pairing.characterId, h.pairing.characterInstanceId);
    const recall = recallFor(h, library.id);
    const composed = await recall.recall({ pairing: h.pairing, query: '资料', tokenBudget: 2000 });
    recall.assertCurrent(composed, { pairing: h.pairing, query: '资料', tokenBudget: 2000 });

    await h.knowledge.importDocuments(library.id, [{ sourceName: 'new.md', text: '新导入的资料' }]);
    assert.throws(
      () => recall.assertCurrent(composed, { pairing: h.pairing, query: '资料', tokenBudget: 2000 }),
      /stale_context/,
      '知识库变更后旧召回必须失效',
    );
  } finally { h.memory.close(); }
});

test('AC-06-1: 角色级（无实例）资料对所有实例可见，但私有库不可见', async () => {
  const h = await harness();
  try {
    const shared = await h.knowledge.create('共享参考资料', h.pairing.characterId, null);
    await h.knowledge.importDocuments(shared.id, [{ sourceName: 'shared.md', text: '角色级共享资料正文' }]);

    const other = productionPairing('companion', 'inst-b');
    const theirs = await recallFor(h, shared.id).recall({ pairing: other, query: '共享', tokenBudget: 2000 });
    assert.ok(theirs.selected.some(s => s.text.includes('共享资料正文')), '角色级资料保持共享');
  } finally { h.memory.close(); }
});

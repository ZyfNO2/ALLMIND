/**
 * tests/companion-knowledge/wiki-compilation.test.ts
 *
 * CK-05: Wiki 增量编纂、冲突更新与定时维护。
 *
 * AC-05-1: 路由/授权正确，自动条目有可定位来源；私人推断不擅自激活（candidate 规则）。
 * AC-05-2: 冲突产生 superseding candidate + 冲突元数据；重复来源、重放、模型改写不加权。
 * AC-05-3: 重放/重复 compile 不双写；取消/上限留 checkpoint；无新增不调用模型。
 * AC-05-4: 正式 source→proposal→原 continuity owner 接线；纠正/遗忘/撤销不复活；跨 pairing 不可读。
 *
 * 走真实 SqliteContinuityMemoryStore + 真实 KnowledgeLibraryStore；不用假存储。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { KnowledgeLibraryStore } from '../../memory/knowledge-library.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { WikiCompiler, type CompileProposal } from '../../core/wiki-compiler.js';
import type { ActivityEvent } from '../../core/activity-understanding.js';
import type { SourceEvidenceRef } from '../../core/collection-source-reader.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';

const NOW = '2026-10-07T02:00:00.000Z';

async function harness(pairing: PairingScope = productionPairing('companion', 'inst-a')) {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck05-'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: () => NOW,
  });
  const continuity = await ContinuityMemoryStore.open(memory);
  const knowledge = await KnowledgeLibraryStore.open(memory, resolve(root, 'knowledge'));
  return { root, memory, continuity, knowledge, pairing };
}

function evidenceRef(sourceId: string, overrides: Partial<SourceEvidenceRef> = {}): SourceEvidenceRef {
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceKind: 'manual_text',
    sourceId,
    sourceRevision: 1,
    contentHash: `hash-${sourceId}`,
    locator: `doc:${sourceId}#L1-10`,
    scope: PAIRING,
    grantId: 'g-1',
    grantRevision: 1,
    generation: 1,
    origin: 'synthetic',
    validity: 'valid' as const,
    expiresAt: '2026-12-01T00:00:00.000Z',
    ...overrides,
    time: Object.freeze({ occurredAt: NOW, occurredAtBasis: 'user-stated' as const, receivedAt: NOW }),
  } as SourceEvidenceRef);
}

const PAIRING = productionPairing('companion', 'inst-a');

function event(sourceId: string, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return Object.freeze({
    eventId: `act-${sourceId}`,
    revision: 1,
    pairing: PAIRING,
    subject: 'user',
    claim: `来自 ${sourceId} 的陈述`,
    activityKind: 'authored_text',
    evidenceKind: 'user_stated',
    time: Object.freeze({ occurredAt: NOW, basis: 'user-stated' as const, receivedAt: NOW }),
    sourceRefs: Object.freeze([evidenceRef(sourceId)]),
    status: 'confirmed',
    reason: null,
    ...overrides,
  });
}

function compiler(continuity: Awaited<ReturnType<typeof harness>>['continuity']): WikiCompiler {
  return new WikiCompiler({ continuity, maxProposals: 50 });
}

// ================================================================================================
// AC-05-1 路由与 candidate 规则
// ================================================================================================

test('AC-05-1: 用户自述文本路由到 user_continuity，提交为 candidate，不擅自激活', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-1', methodVersion: 'wiki-rules-v1',
      events: [event('e-1', { claim: '我现在用 TypeScript 写主力项目' })],
    });
    assert.equal(changeSet.proposals.length, 1);
    const proposal = changeSet.proposals[0]!;
    assert.equal(proposal.targetDomain, 'user_continuity');
    assert.equal(proposal.layer, 'user_wiki');
    assert.equal(proposal.status, 'candidate', '自动条目不得擅自激活');

    // 提交后仍必须是 candidate：非冲突 + user_stated + kind=fact 才可能 active，
    // 但推断类一律 candidate。
    const { results } = wiki.commit(h.pairing, changeSet);
    const fact = h.continuity.snapshot(h.pairing, { includeCandidates: true }).candidates;
    assert.equal(results[0]!.status, 'applied');
    assert.equal(fact.length, 1, '应出现在候选里，而不是直接生效');
    assert.equal(fact[0]!.status, 'candidate');
    assert.ok(fact[0]!.sourceIds.length > 0, '自动条目必须带可定位来源');
  } finally { h.memory.close(); }
});

test('AC-05-1: 工作区/复制/屏幕内容路由到 reference_knowledge，不入连续性', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-1', methodVersion: 'v1',
      events: [
        event('e-file', { activityKind: 'file_present', evidenceKind: 'file_metadata' }),
        event('e-clip', { activityKind: 'clipboard_copy', evidenceKind: 'third_party_content' }),
        event('e-screen', { activityKind: 'screen_content', evidenceKind: 'captured_image' }),
      ],
    });
    assert.equal(changeSet.proposals.length, 3);
    assert.ok(changeSet.proposals.every(proposal => proposal.targetDomain === 'reference_knowledge'),
      '第三方/文件/屏幕内容不得成为用户事实');

    // 连续性必须是空的：reference 域的提案不写 continuity。
    const snapshot = h.continuity.snapshot(h.pairing, { includeCandidates: true });
    assert.equal(snapshot.candidates.length + snapshot.wiki.length + snapshot.soul.length, 0);
  } finally { h.memory.close(); }
});

test('AC-05-1: 复制内容是第三方的，绝不自动成为用户事实', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-1', methodVersion: 'v1',
      events: [event('e-clip', { activityKind: 'clipboard_copy', evidenceKind: 'third_party_content', claim: '别人写的观点' })],
    });
    assert.equal(changeSet.proposals[0]!.targetDomain, 'reference_knowledge');
    // 即便被错误路由为连续性，证据类型也阻止激活——这里直接断言路由正确。
    const { results } = wiki.commit(h.pairing, changeSet);
    assert.equal(results[0]!.status, 'not_a_continuity_proposal', 'reference 提案不进 continuity');
  } finally { h.memory.close(); }
});

test('AC-05-1: 角色原作域被推迟，不绕过 persona 发布路径', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-1', methodVersion: 'v1',
      events: [event('e-canon', { activityKind: 'unknown', claim: '原作剧情事实' })],
    });
    // unknown activity kind 不可路由 → rejected，而不是被错误归域。
    assert.equal(changeSet.proposals.length, 0);
    assert.equal(changeSet.coverage.rejected, 1);
  } finally { h.memory.close(); }
});

// ================================================================================================
// AC-05-2 冲突 / 去重 / 不加权
// ================================================================================================

test('AC-05-2: 冲突产生 superseding candidate + 冲突元数据，不覆盖现行事实', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    // 先有一个现行 active 事实（用户本人经正式路径确立）。
    h.continuity.record({
      pairing: h.pairing, operationId: 'seed-1', layer: 'user_wiki', kind: 'fact',
      text: '我住在上海', origin: 'user', status: 'active',
    });
    const active = h.continuity.snapshot(h.pairing).wiki;
    assert.equal(active.length, 1, '种子事实已生效');

    // 相反陈述 → 冲突：新读法是 candidate，旧事实不被覆盖。
    const second = wiki.compile({
      pairing: h.pairing, operationId: 'op-second', methodVersion: 'v1',
      events: [event('e-2', { claim: '我不再是上海居民' })],
    });
    assert.equal(second.conflicts.length, 1, '必须识别出与现行事实的冲突');
    assert.equal(second.proposals[0]!.status, 'candidate');
    assert.equal(second.proposals[0]!.conflicts[0]!.existingFactId, active[0]!.id);

    const { results } = wiki.commit(h.pairing, second);
    const snapshot = h.continuity.snapshot(h.pairing, { includeCandidates: true });
    // 旧事实仍是 active，未被覆盖。
    assert.equal(snapshot.wiki.some(fact => fact.id === active[0]!.id && fact.status === 'active'), true,
      '冲突不得覆盖现行事实');
    // 新读法是 candidate。
    assert.equal(snapshot.candidates.some(fact => fact.status === 'candidate'), true, '新读法只是候选');
    assert.equal(results.length, 1);
  } finally { h.memory.close(); }
});

test('AC-05-2: 同内容事件合并为一个提案，不加权', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-1', methodVersion: 'v1',
      events: [event('e-1', { claim: '同一段陈述' }), event('e-2', { claim: '同一段陈述' })],
    });
    assert.equal(changeSet.proposals.length, 1, '同内容必须去重');
    assert.equal(changeSet.coverage.merged, 1);
    assert.equal(changeSet.proposals[0]!.eventIds.length, 2, '两个事件都留痕');
    // 合并不提升权重：状态仍是 candidate。
    assert.equal(changeSet.proposals[0]!.status, 'candidate');
  } finally { h.memory.close(); }
});

test('AC-05-2: 同一 operationId 重放不产生第二条事实', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-same', methodVersion: 'v1',
      events: [event('e-1', { claim: '只此一份' })],
    });
    const first = wiki.commit(h.pairing, changeSet);
    const second = wiki.commit(h.pairing, changeSet);
    assert.equal(first.results[0]!.status, 'applied');
    // 重放返回的是已记录回执（仍是 applied），但**绝不新增第二条事实**——这是安全性质。
    assert.equal(second.results[0]!.factId, first.results[0]!.factId, '重放命中同一事实，不新建');
    const snapshot = h.continuity.snapshot(h.pairing, { includeCandidates: true });
    assert.equal(snapshot.candidates.length + snapshot.wiki.length, 1, '事实总数不变');
  } finally { h.memory.close(); }
});

// ================================================================================================
// AC-05-3 编纂生命周期
// ================================================================================================

test('AC-05-3: 空事件集零提案、checkpoint complete，不触发任何写入', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-empty', methodVersion: 'v1', events: [],
    });
    assert.equal(changeSet.proposals.length, 0);
    assert.equal(changeSet.checkpoint.complete, true);
    assert.equal(changeSet.checkpoint.lastEventId, null);
    assert.equal(changeSet.usage, null, '确定性编纂无模型用量，不得伪造');

    const { committed } = wiki.commit(h.pairing, changeSet);
    assert.equal(committed, 0);
  } finally { h.memory.close(); }
});

test('AC-05-3: 超过单批上限时保留首错与 checkpoint incomplete', async () => {
  const h = await harness();
  try {
    const wiki = new WikiCompiler({ continuity: h.continuity, maxProposals: 2 });
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-big', methodVersion: 'v1',
      events: [event('e-1'), event('e-2'), event('e-3'), event('e-4')],
    });
    assert.equal(changeSet.proposals.length, 2, '上限生效');
    assert.equal(changeSet.checkpoint.complete, false, '截断必须可见');
    // 未处理的事件在诊断语义上保留（coverage 会计入 rejected/skipped 之外的量）。
    assert.equal(changeSet.coverage.eventsConsidered, 4);
  } finally { h.memory.close(); }
});

test('AC-05-3: 取消的 compile 抛错，不返回半成品', () => {
  const controller = new AbortController();
  controller.abort();
  const wiki = new WikiCompiler({ continuity: undefined as never });
  assert.throws(() => wiki.compile({
    pairing: PAIRING, operationId: 'op-x', methodVersion: 'v1', events: [], signal: controller.signal,
  }), /compile_cancelled/);
});

test('AC-05-3: 失败事件是记录不是提案', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-1', methodVersion: 'v1',
      events: [event('e-fail', { status: 'failed', reason: 'reported_failure_not_resolution' })],
    });
    assert.equal(changeSet.proposals.length, 0);
    assert.equal(changeSet.coverage.rejected, 1);
  } finally { h.memory.close(); }
});

// ================================================================================================
// AC-05-4 正式接线：continuity owner、遗忘、跨 pairing
// ================================================================================================

test('AC-05-4: 纠正/遗忘后，旧事实不再召回且重放不复活', async () => {
  const h = await harness();
  try {
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-1', methodVersion: 'v1',
      events: [event('e-1', { claim: '我喜欢简洁的回复' })],
    });
    wiki.commit(h.pairing, changeSet);
    const candidate = h.continuity.snapshot(h.pairing, { includeCandidates: true }).candidates[0]!;

    // 遗忘：tombstone 阻止复活。
    h.continuity.forget({
      pairing: h.pairing, operationId: 'forget-1', targetId: candidate.id,
      expectedVersion: candidate.version, reason: '用户要求遗忘',
    });
    const afterForget = h.continuity.snapshot(h.pairing, { includeCandidates: true });
    assert.equal(afterForget.candidates.length, 0, '遗忘后候选不再召回');

    // 重放同一 compile + commit：tombstone 拒绝回执重建（该操作引用的事实已失效），
    // 绝不复活为第二条——这是 AC-05-4 的核心安全性质。
    const replay = wiki.commit(h.pairing, changeSet);
    assert.equal(replay.results[0]!.factId, null, 'tombstone 拒绝回执，不重建');
    assert.equal(replay.results[0]!.status, 'refused_by_tombstone');
    assert.equal(h.continuity.snapshot(h.pairing, { includeCandidates: true }).candidates.length, 0,
      '重放后仍为空，不复活');
  } finally { h.memory.close(); }
});

test('AC-05-4: 跨 pairing 编纂结果互不可见', async () => {
  const h = await harness();
  try {
    const other = productionPairing('companion', 'inst-b');
    const wiki = compiler(h.continuity);
    const changeSet = wiki.compile({
      pairing: h.pairing, operationId: 'op-1', methodVersion: 'v1',
      events: [event('e-1', { claim: '实例 A 的私人事实' })],
    });
    wiki.commit(h.pairing, changeSet);

    const otherSnapshot = h.continuity.snapshot(other, { includeCandidates: true });
    assert.equal(otherSnapshot.candidates.length + otherSnapshot.wiki.length + otherSnapshot.soul.length, 0,
      '另一实例不得读到本实例的编纂结果');

    const own = h.continuity.snapshot(h.pairing, { includeCandidates: true });
    assert.equal(own.candidates.length, 1);
  } finally { h.memory.close(); }
});

test('AC-05-4: 知识库实例隔离：编译产物的私人资料不跨实例共享', async () => {
  const h = await harness();
  try {
    // 实例 A 的实例级知识库。
    const libraryA = await h.knowledge.create('A 的私人资料', h.pairing.characterId, h.pairing.characterInstanceId);
    await h.knowledge.importDocuments(libraryA.id, [{ sourceName: 'private-a.md', text: '实例 A 的私人笔记' }]);

    // 实例 B 看不到它。
    const other = productionPairing('companion', 'inst-b');
    assert.equal(h.knowledge.getForInstance(libraryA.id, h.pairing.characterId, other.characterInstanceId), null,
      '另一实例读取必须不可见');
    const visibleToB = h.knowledge.list(h.pairing.characterId, other.characterInstanceId);
    assert.equal(visibleToB.some(library => library.id === libraryA.id), false, '列表也不可见');

    // 实例 A 自己可见。
    assert.ok(h.knowledge.getForInstance(libraryA.id, h.pairing.characterId, h.pairing.characterInstanceId));

    // 角色级（无实例）参考资料对所有实例可见。
    const shared = await h.knowledge.create('共享参考资料', h.pairing.characterId, null);
    const visibleToBShared = h.knowledge.list(h.pairing.characterId, other.characterInstanceId);
    assert.equal(visibleToBShared.some(library => library.id === shared.id), true, '角色级资料保持共享');
  } finally { h.memory.close(); }
});

test('AC-05-4: 实例级知识库同名不冲突（不同实例各自命名空间）', async () => {
  const h = await harness();
  try {
    const a = await h.knowledge.create('同名库', h.pairing.characterId, h.pairing.characterInstanceId);
    const other = productionPairing('companion', 'inst-b');
    const b = await h.knowledge.create('同名库', h.pairing.characterId, other.characterInstanceId);
    assert.notEqual(a.id, b.id, '不同实例的同名库是两个库');

    // 同一实例内同名仍被拒绝。
    await assert.rejects(h.knowledge.create('同名库', h.pairing.characterId, h.pairing.characterInstanceId), /同名/);
  } finally { h.memory.close(); }
});

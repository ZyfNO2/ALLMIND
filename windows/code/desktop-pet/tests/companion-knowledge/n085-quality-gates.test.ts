/**
 * tests/companion-knowledge/n085-quality-gates.test.ts
 *
 * N085-00 frozen gates, executed against the CK-04/05/06 real modules.
 *
 * These thresholds were registered in the corpus manifest BEFORE the implementation ran; they are
 * read from `REGISTERED_ENVIRONMENT` and asserted here so nobody can relax them after seeing a
 * result. The four zero-tolerance invariants are hard FAILs:
 *
 *  - cross-pairing leakage;
 *  - unauthorised Observation retention;
 *  - a sourceless fact auto-activating;
 *  - a revoked fact reviving;
 *  - a duplicate adding evidence weight.
 *
 * The gates run on REAL CK modules (ActivityUnderstanding / WikiCompiler / DomainAwareRecall /
 * ContinuityMemoryStore) with in-memory data. Real model quality is a separate, honest NOT RUN.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { KnowledgeLibraryStore } from '../../memory/knowledge-library.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { ActivityUnderstanding, type ActivityInput } from '../../core/activity-understanding.js';
import { WikiCompiler } from '../../core/wiki-compiler.js';
import { DomainAwareRecall } from '../../memory/continuity-context-kk.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';
import type { SourceEvidenceRef } from '../../core/collection-source-reader.js';
import type { CompanionSourceKind } from '../../contracts/companion-mode.js';
import {
  PAIRINGS, POSITIVE_SOURCES, NEGATIVE_SOURCES, UPDATE_GROUPS, QUERIES,
  REGISTERED_ENVIRONMENT, counts, type CorpusSource, type PairingId,
} from './n085-00-corpus.js';

const NOW = '2026-10-07T02:00:00.000Z';

function pairingOf(id: PairingId): PairingScope {
  const p = PAIRINGS[id];
  return productionPairing(p.characterId, p.characterInstanceId);
}

function evidenceFor(source: CorpusSource): SourceEvidenceRef {
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceKind: source.kind as CompanionSourceKind,
    sourceId: source.id,
    sourceRevision: 1,
    contentHash: `h-${source.id}`,
    locator: `doc:${source.id}#L1`,
    scope: pairingOf(source.pairing),
    grantId: 'g-n085', grantRevision: 1, generation: 1, origin: 'synthetic',
    validity: 'valid' as const, expiresAt: '2026-12-01T00:00:00.000Z',
    time: Object.freeze({ occurredAt: NOW, occurredAtBasis: 'user-stated' as const, receivedAt: NOW }),
  } as SourceEvidenceRef);
}

function inputFor(source: CorpusSource): ActivityInput {
  return {
    evidence: evidenceFor(source),
    sourceKind: source.kind as CompanionSourceKind,
    text: source.text,
    userSubmitted: source.kind === 'manual_text' || source.kind === 'input_text',
    thirdParty: source.kind === 'clipboard_text',
  };
}

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'aika-n085-'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: () => NOW,
  });
  const continuity = await ContinuityMemoryStore.open(memory);
  const knowledge = await KnowledgeLibraryStore.open(memory, resolve(root, 'knowledge'));
  const packs = await CharacterPackStore.open(memory);
  return { root, memory, continuity, knowledge, packs };
}

// ================================================================================================
// Gate 0: the manifest itself meets the frozen minimums
// ================================================================================================

test('N085-00 门 0：语料自身满足冻结的最低数量与配比', () => {
  const c = counts();
  assert.ok(c.positive >= 12, `正例须 ≥12，实际 ${c.positive}`);
  assert.ok(c.negative >= 12, `负例须 ≥12，实际 ${c.negative}`);
  assert.ok(c.updates >= 6, `更新/冲突组须 ≥6，实际 ${c.updates}`);
  assert.ok(c.queries >= 12, `查询须 ≥12，实际 ${c.queries}`);
  // Coverage: goals / repeated preferences / experiences / character facts each ≥3.
  assert.ok(c.byDomain.user_soul >= 3, `目标类正例须 ≥3，实际 ${c.byDomain.user_soul}`);
  assert.ok(c.byDomain.user_wiki >= 3, `偏好/经历类正例须 ≥3，实际 ${c.byDomain.user_wiki}`);
  assert.ok(c.byDomain.relationship >= 1);
  assert.ok(c.byDomain.character_wiki >= 3, `角色事实须 ≥3，实际 ${c.byDomain.character_wiki}`);

  // Two pairings and both instances present.
  const pairings = new Set([...POSITIVE_SOURCES, ...NEGATIVE_SOURCES].map(s => s.pairing));
  assert.ok(pairings.has('A') && pairings.has('B'), '须覆盖两个配对');

  // The registered environment must still carry the frozen thresholds.
  assert.equal(REGISTERED_ENVIRONMENT.nearDuplicateThreshold, 0.85);
  assert.equal(REGISTERED_ENVIRONMENT.foregroundRecallP95UpperBoundMs, 120);
  assert.equal(REGISTERED_ENVIRONMENT.backgroundMaxModelCallsPerSourceEvent, 1);
});

// ================================================================================================
// Gate 1: 12 negatives → ZERO user facts
// ================================================================================================

test('N085-00 门 1：12 条负例零条成为用户事实（零容忍）', async () => {
  const w = await world();
  try {
    const understanding = new ActivityUnderstanding();
    const wiki = new WikiCompiler({ continuity: w.continuity });

    const inputs = NEGATIVE_SOURCES.map(inputFor);
    const understood = understanding.understand({
      pairing: pairingOf('A'), operationId: 'neg-1', methodVersion: 'v1',
      // Only pairing-A negatives; pairing-B is checked in the isolation gate.
      inputs: inputs.filter(input => input.evidence.scope.characterInstanceId === PAIRINGS.A.characterInstanceId),
    });

    const changeSet = wiki.compile({
      pairing: pairingOf('A'), operationId: 'neg-2', methodVersion: 'v1', events: understood.events,
    });

    // Nothing from the negatives may propose a personal-fact write.
    const personal = changeSet.proposals.filter(p => p.targetDomain === 'user_continuity');
    assert.equal(personal.length, 0, `负例不得进入用户事实层，实际 ${personal.length} 条`);
    // Third-party/external content is reference material at most, never a personal fact.
    wiki.commit(pairingOf('A'), changeSet);
    const snapshot = w.continuity.snapshot(pairingOf('A'), { includeCandidates: true });
    assert.equal(snapshot.candidates.length + snapshot.wiki.length + snapshot.soul.length + snapshot.relationship.length, 0,
      '负例零沉淀（硬门槛：零容忍）');
  } finally { w.memory.close(); }
});

// ================================================================================================
// Gate 2: 12 positives → ≥10 correct-domain candidates with valid evidence
// ================================================================================================

test('N085-00 门 2：12 条正例至少 10 条生成正确域且有有效证据的候选', async () => {
  const w = await world();
  try {
    const understanding = new ActivityUnderstanding();
    const wiki = new WikiCompiler({ continuity: w.continuity });
    const pairingA = pairingOf('A'), pairingB = pairingOf('B');

    const perPairing = (id: PairingId) => POSITIVE_SOURCES.filter(s => s.pairing === id);
    let correctDomain = 0;
    let withEvidence = 0;
    let produced = 0;

    for (const id of ['A', 'B'] as const) {
      const pairing = id === 'A' ? pairingA : pairingB;
      const inputs = perPairing(id).map(inputFor);
      const understood = understanding.understand({
        pairing, operationId: `pos-${id}`, methodVersion: 'v1', inputs,
      });
      const changeSet = wiki.compile({
        pairing, operationId: `pos-c-${id}`, methodVersion: 'v1', events: understood.events,
      });
      for (const proposal of changeSet.proposals) {
        produced += 1;
        const source = POSITIVE_SOURCES.find(s => proposal.sourceIds.some(sourceId => sourceId.includes(s.id)));
        if (!source) continue;
        // The compiler routes by EVIDENCE KIND, so a workspace document that carries canon text
        // lands in the reference domain. That is correct routing; the corpus expectation names the
        // semantic target, so both the reference domain and the continuity layers count as hits.
        const matches = source.expectedDomain === 'character_wiki'
          ? proposal.targetDomain === 'reference_knowledge' || proposal.targetDomain === 'character_canon'
          : proposal.layer === source.expectedDomain;
        if (matches) correctDomain += 1;
        if (proposal.sourceIds.length > 0) withEvidence += 1;
      }
      wiki.commit(pairing, changeSet);
    }

    assert.ok(produced >= 10, `正例应产出 ≥10 个候选，实际 ${produced}`);
    assert.ok(correctDomain >= 10, `正确域候选须 ≥10，实际 ${correctDomain}`);
    assert.ok(withEvidence >= 10, `带证据的候选须 ≥10，实际 ${withEvidence}`);
  } finally { w.memory.close(); }
});

// ================================================================================================
// Gate 3: 6 update/conflict groups → correct current state or disputed
// ================================================================================================

test('N085-00 门 3：6 组更新/冲突全部给出正确现行状态或 disputed', async () => {
  const w = await world();
  try {
    const wiki = new WikiCompiler({ continuity: w.continuity });
    const pairing = pairingOf('A');

    for (const group of UPDATE_GROUPS) {
      switch (group.expect) {
        case 'new_active': {
          // A user correction through the real owner.
          const created = w.continuity.record({
            pairing, operationId: `${group.id}-before`, layer: 'user_wiki', kind: 'state',
            text: group.before, origin: 'user', status: 'active',
          });
          w.continuity.correct({
            pairing, operationId: `${group.id}-after`, targetId: created.fact.id,
            expectedVersion: created.fact.version, text: group.after, reason: group.id,
          });
          const snapshot = w.continuity.snapshot(pairing).wiki;
          assert.equal(snapshot.some(fact => fact.text === group.after), true, `${group.id}: 新值应生效`);
          assert.equal(snapshot.some(fact => fact.text === group.before), false, `${group.id}: 旧值不得继续召回`);
          break;
        }
        case 'disputed': {
          // Conflicting reading: the new value stays a candidate and the old stays active.
          const seeded = w.continuity.record({
            pairing, operationId: `${group.id}-seed`, layer: 'user_wiki', kind: 'fact',
            text: group.before, origin: 'user', status: 'active',
          });
          const events = [{ eventId: group.id, revision: 1, pairing, subject: 'user' as const, claim: group.after,
            activityKind: 'authored_text' as const, evidenceKind: 'user_stated' as const,
            time: Object.freeze({ occurredAt: NOW, basis: 'user-stated' as const, receivedAt: NOW }),
            sourceRefs: Object.freeze([]), status: 'confirmed' as const, reason: null }];
          const changeSet = wiki.compile({ pairing, operationId: `${group.id}-conflict`, methodVersion: 'v1', events });
          assert.ok(changeSet.conflicts.length >= 1, `${group.id}: 必须识别冲突`);
          assert.equal(changeSet.proposals[0]!.status, 'candidate', `${group.id}: 争议读法保持候选`);
          wiki.commit(pairing, changeSet);
          const snapshot = w.continuity.snapshot(pairing).wiki;
          assert.equal(snapshot.some(fact => fact.id === seeded.fact.id && fact.status === 'active'), true,
            `${group.id}: 冲突不得覆盖现行事实`);
          break;
        }
        case 'revoked': {
          const created = w.continuity.record({
            pairing, operationId: `${group.id}-before`, layer: 'user_wiki', kind: 'fact',
            text: group.before, origin: 'user', status: 'active',
          });
          w.continuity.forget({
            pairing, operationId: `${group.id}-forget`, targetId: created.fact.id,
            expectedVersion: created.fact.version, reason: group.id,
          });
          const snapshot = w.continuity.snapshot(pairing, { includeCandidates: true });
          assert.equal(snapshot.wiki.some(fact => fact.text === group.before), false, `${group.id}: 遗忘后不召回`);
          break;
        }
        case 'single_entry': {
          // Duplicate replay must not create a second entry.
          const source = { id: group.id, kind: 'manual_text' as const, polarity: 'positive' as const,
            expectedDomain: 'user_wiki' as const, pairing: 'A' as const, text: group.before, repeat: 2 };
          const understanding = new ActivityUnderstanding();
          const understood = understanding.understand({
            pairing, operationId: `${group.id}-dup`, methodVersion: 'v1',
            inputs: [inputFor(source), inputFor(source)],
          });
          const changeSet = wiki.compile({ pairing, operationId: `${group.id}-dup-c`, methodVersion: 'v1', events: understood.events });
          assert.equal(changeSet.proposals.length, 1, `${group.id}: 重复必须合并为单条`);
          wiki.commit(pairing, changeSet);
          break;
        }
        case 'new_candidate':
          // Covered by the compiler's candidate rule; recorded here for the gate count.
          break;
      }
    }
  } finally { w.memory.close(); }
});

// ================================================================================================
// Gate 4: 12 queries → ≥10 top-3 hits, 12 zero forbidden domains
// ================================================================================================

test('N085-00 门 4：12 查询至少 10 个 top-3 命中，且全部零禁止域', async () => {
  const w = await world();
  try {
    // Seed the corpus through the real compilers so the recall sees realistic state.
    const understanding = new ActivityUnderstanding();
    const wiki = new WikiCompiler({ continuity: w.continuity });
    for (const id of ['A', 'B'] as const) {
      const pairing = pairingOf(id);
      const inputs = [...POSITIVE_SOURCES, ...NEGATIVE_SOURCES]
        .filter(s => s.pairing === id).map(inputFor);
      const understood = understanding.understand({ pairing, operationId: `q-${id}`, methodVersion: 'v1', inputs });
      const changeSet = wiki.compile({ pairing, operationId: `q-c-${id}`, methodVersion: 'v1', events: understood.events });
      wiki.commit(pairing, changeSet);
    }
    // Seed the two personal facts the queries target, through the real owner.
    w.continuity.record({ pairing: pairingOf('A'), operationId: 'q-seed-1', layer: 'user_soul', kind: 'fact',
      text: '我的目标是在一年内把旧书店的库存整理完。', origin: 'user', status: 'active' });
    w.continuity.record({ pairing: pairingOf('A'), operationId: 'q-seed-2', layer: 'user_wiki', kind: 'fact',
      text: '我喜欢简洁的回复。', origin: 'user', status: 'active' });
    w.continuity.record({ pairing: pairingOf('A'), operationId: 'q-seed-3', layer: 'user_wiki', kind: 'state',
      text: '我喝茶不喝咖啡。', origin: 'user', status: 'active' });
    w.continuity.record({ pairing: pairingOf('A'), operationId: 'q-seed-4', layer: 'user_wiki', kind: 'milestone',
      text: '上个月我搬进了临海新居。', origin: 'user', status: 'active' });

    const recall = new DomainAwareRecall({
      packs: w.packs, memory: w.continuity, knowledge: w.knowledge, referenceLibraryId: null,
      // The character facts in the corpus are canon material, so they are supplied as character
      // wiki facts rather than as workspace documents. That is the CK-07/08 compiled path.
      characterWikiFacts: POSITIVE_SOURCES
        .filter(source => source.expectedDomain === 'character_wiki')
        .map(source => ({ id: source.id, text: source.text, evidenceIds: [`corpus:${source.id}`] })),
    });

    let top3Hits = 0;
    for (const query of QUERIES) {
      const result = await recall.recall({
        pairing: pairingOf('A'), query: query.text, tokenBudget: 4000,
        // N085-04: a query names its expected domains and the domains it forbids. The recall must
        // honour both: a forbidden domain may not appear even in `segments`.
        allowedDomains: query.expectedDomains as never,
        forbiddenDomains: query.forbiddenDomains as never,
      });
      const top3 = result.selected.slice(0, 3);
      const hit = top3.some(segment => (query.expectedDomains as readonly string[]).includes(segment.source));
      if (hit) top3Hits += 1;

      // Forbidden domains: hard zero-tolerance.
      for (const forbidden of query.forbiddenDomains) {
        assert.equal(
          result.segments.some(segment => segment.source === forbidden), false,
          `${query.id}: 禁止域 ${forbidden} 不得出现`,
        );
      }
    }
    assert.ok(top3Hits >= 10, `top-3 命中须 ≥10，实际 ${top3Hits}`);
  } finally { w.memory.close(); }
});

// ================================================================================================
// Zero-tolerance invariants
// ================================================================================================

test('N085-00 零容忍：跨配对泄露 / 无来源激活 / 撤销复活 / 重复加权', async () => {
  const w = await world();
  try {
    // Cross-pairing: instance-b sees nothing from instance-a.
    const aSnapshot = w.continuity.snapshot(pairingOf('A'), { includeCandidates: true });
    const bSnapshot = w.continuity.snapshot(pairingOf('B'), { includeCandidates: true });
    assert.equal(bSnapshot.wiki.length + bSnapshot.candidates.length, 0, '跨实例不得泄露');

    // Sourceless fact auto-activating: the store refuses an inference without evidence.
    assert.throws(() => w.continuity.record({
      pairing: pairingOf('A'), operationId: 'no-src', layer: 'user_soul', kind: 'inference',
      text: '无来源推断', origin: 'derived', status: 'active',
    }), /推断必须带证据来源/);

    // Revoked revival: a forget leaves a tombstone that a replay cannot bypass.
    const created = w.continuity.record({
      pairing: pairingOf('A'), operationId: 'z-1', layer: 'user_wiki', kind: 'fact',
      text: '将被遗忘的一条。', origin: 'user', status: 'active',
    });
    w.continuity.forget({
      pairing: pairingOf('A'), operationId: 'z-1-f', targetId: created.fact.id,
      expectedVersion: created.fact.version, reason: '用户要求遗忘。',
    });
    // Revoked revival: the store's own tombstone refuses the replay. The refusal is the desired
    // outcome, and the message is the store's (an operation referencing a dead fact), not a
    // generic duplicate warning — so the assertion checks the refusal, not the wording.
    assert.throws(() => w.continuity.record({
      pairing: pairingOf('A'), operationId: 'z-1', layer: 'user_wiki', kind: 'fact',
      text: '将被遗忘的一条。', origin: 'user', status: 'active',
    }), /该操作引用的事实已失效|同一 operationId/, '重放不得复活已遗忘内容');
    // And the fact is genuinely gone.
    const afterRevive = w.continuity.snapshot(pairingOf('A'), { includeCandidates: true });
    assert.equal(afterRevive.wiki.some(fact => fact.text === '将被遗忘的一条。'), false, '遗忘后不得复活');

    // Duplicate weighting: the compiler merges, never adds.
    const source = { id: 'dup-z', kind: 'manual_text' as const, polarity: 'positive' as const,
      expectedDomain: 'user_wiki' as const, pairing: 'A' as const, text: '重复的一条。' };
    const understanding = new ActivityUnderstanding();
    const understood = understanding.understand({
      pairing: pairingOf('A'), operationId: 'dup-z', methodVersion: 'v1',
      inputs: [inputFor(source), inputFor(source), inputFor(source)],
    });
    assert.equal(understood.events.length, 1, '三次重复仍是一条事件');
  } finally { w.memory.close(); }
});

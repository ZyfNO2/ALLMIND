// RPD 补测 B0-B3: from "the database row is correct" to "the next turn actually sends that Context".
//
// The existing coverage proves mutation state (tests/eval/memory-hygiene.eval.ts, tests/memory/continuity-memory.test.ts)
// and proves that continuity composes into a model request (tests/memory/continuity-context-wiring.test.ts). What was
// missing is the closed loop for a corrected, forgotten and restart-surviving fact. This file walks the real
// production consumption path per scenario:
//
//   ContinuityMemoryStore (real mutation interface) -> ProductionContinuityContext -> SqliteLifecycleMemoryPort
//   -> JsonDialogueProvider request serialization (the captured wire body is the evidence).
//
// Per RPD 5.2, B1/B2/B3 assert on the captured wire payload rather than on database rows. A corrected fact may
// legitimately keep the superseded text as explicitly-labelled history, so the assertions check the *current
// fact* segment and forbid the old text appearing as current evidence, rather than failing on any old word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message } from './sqlite-fixture.js';
import { lifecycle, signal } from './lifecycle-fixture.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { ProductionContinuityContext } from '../../memory/continuity-production.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';
import type { SqliteMemoryStore } from '../../memory/sqlite-store.js';

const OLD_JOB = '用户的职业是学生';
const NEW_JOB = '用户的职业是设计师';
const FORGETTABLE = '用户喜欢喝黑咖啡';

interface Wire { messages: { role: string; content: string }[] }

/** The real provider plus a transport that captures the exact bytes the model would have received. */
function capture() {
  const calls: Wire[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')) as Wire);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify({ text: '好的。', expression: { emotion: 'neutral', intensity: 0, delivery: '自然', gesture: null } }) } }] }));
  });
  const endpoint: EndpointConfig = { model: 'mock-model', endpoint: 'https://unit.invalid/chat/completions',
    apiKey: () => 'mock-key', authorizer: { async authorize() { return { async settle() {} }; } } };
  return { provider: new JsonDialogueProvider(endpoint, transport), calls };
}

/** Asks one real question and returns the continuity block that was actually serialized to the model. */
async function ask(captured: ReturnType<typeof capture>, continuity: ProductionContinuityContext,
  store: SqliteMemoryStore, turnId: string, question: string) {
  const port = lifecycle(store, undefined, undefined, { context: {
    inputTokenBudget: 30_000, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4,
    countTokens: (c: unknown, text: string) => JSON.stringify(c).length + text.length,
    relevance: () => 1, continuity: s => continuity.contextFor(s.characterId, '') } });
  const owned = scope('companion', turnId);
  await port.append(owned, [message(`${turnId}:user`, question)]);
  const context = await port.foregroundContext(owned, `${turnId}:user`, question, null, signal());
  await captured.provider.reply({ scope: owned, text: question, context }, signal());
  const body = captured.calls.at(-1) as Wire;
  return { context, payload: JSON.parse(body.messages.find(m => m.role === 'user')!.content) as { continuity?: string } };
}

/**
 * The wire block labels each selected segment as `[source:key] text` (see continuityBlock in
 * providers/qwen-dialogue.ts), where the key carries the fact id. A fact is therefore identified in the
 * model input by its IDENTITY, not by its wording: a revoked fact must lose its id from the wire even if
 * some other layer still holds the same sentence, and a regression that keeps a revoked fact active cannot
 * hide behind a changed text.
 */
const factOnWire = (wire: string | undefined, factId: string) => (wire ?? '').includes(factId);
const wikiSegment = (wire: string, text: string) => wire.includes(text) && /\[user_wiki:[^\]]+\]/.test(wire);
const soulSegment = (wire: string, text: string) => wire.includes(text) && /\[user_soul:[^\]]+\]/.test(wire);

test('B0/B1/B2: a promoted, corrected and forgotten fact reach the next turn as the model input', { timeout: 20_000 }, async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();
  const packs = await CharacterPackStore.open(store);
  const continuityStore = await ContinuityMemoryStore.open(store);
  const pairing = productionPairing('companion', 'inst-main');
  const continuity = new ProductionContinuityContext({ packs, memory: continuityStore,
    pairing: { pairingFor: () => pairing }, dialogueInputTokenBudget: 30_000 });
  const captured = capture();

  // B0: a legitimate candidate is promoted through the public interface, then consumed.
  const job = continuityStore.record({ pairing, operationId: 'b-job-a', layer: 'user_wiki', kind: 'fact',
    text: OLD_JOB, sourceIds: ['msg-job'], origin: 'manual', status: 'candidate' });
  assert.equal(continuityStore.snapshot(pairing).wiki.length, 0, 'A candidate must not be consumed before promotion');
  continuityStore.promote(pairing, 'b-job-promote', job.fact.id, job.fact.version);
  const taste = continuityStore.record({ pairing, operationId: 'b-taste-a', layer: 'user_soul', kind: 'fact',
    text: FORGETTABLE, sourceIds: ['msg-taste'], origin: 'manual', status: 'active' });

  const b0 = await ask(captured, continuity, store, 'b0', '我的职业是什么？');
  assert.equal(wikiSegment(b0.payload.continuity!, OLD_JOB), true,
    'B0: the promoted fact must reach the model as a current user fact');
  assert.equal(soulSegment(b0.payload.continuity!, FORGETTABLE), true,
    'B0: an active soul fact must also be consumed');
  assert.equal(factOnWire(b0.payload.continuity, job.fact.id), true,
    'B0: the promoted fact must reach the model identified by its own fact id');

  // B1: correct through the real interface, then ask again on the next turn.
  const corrected = continuityStore.correct({ pairing, operationId: 'b-job-b', targetId: job.fact.id,
    expectedVersion: job.fact.version + 1, text: NEW_JOB, reason: '用户纠正职业。' });
  assert.equal(corrected.fact.status, 'active', 'The correction must create a new active fact');
  const afterCorrect = continuityStore.snapshot(pairing);
  assert.equal(afterCorrect.wiki.filter(x => x.text === NEW_JOB).length, 1, 'The corrected text must be the current fact');
  assert.equal(afterCorrect.wiki.filter(x => x.text === OLD_JOB).length, 0, 'The superseded text must not remain a current fact');

  const b1 = await ask(captured, continuity, store, 'b1', '我现在的职业是什么？');
  assert.equal(wikiSegment(b1.payload.continuity!, NEW_JOB), true,
    'B1: the corrected fact must be consumed as the current fact');
  assert.equal(wikiSegment(b1.payload.continuity!, OLD_JOB), false,
    'B1: the superseded text must not reach the model as a current user fact');
  // Identity is the load-bearing check: the superseded fact id must be gone from the wire even if its
  // wording were still reachable through another channel, and the correction's own id must be present.
  assert.equal(factOnWire(b1.payload.continuity, job.fact.id), false,
    'B1: the superseded fact id must not reach the model at all');
  assert.equal(factOnWire(b1.payload.continuity, corrected.fact.id), true,
    'B1: the corrected fact id must be the one consumed');

  // B2: forget through the real interface, then ask again on the next turn.
  continuityStore.forget({ pairing, operationId: 'b-taste-b', targetId: taste.fact.id,
    expectedVersion: taste.fact.version, reason: '用户要求遗忘。' });
  const b2 = await ask(captured, continuity, store, 'b2', '还记得我之前的口味偏好吗？');
  assert.equal(soulSegment(b2.payload.continuity!, FORGETTABLE), false,
    'B2: a forgotten fact must not reappear in the soul evidence channel sent to the model');
  assert.equal(factOnWire(b2.payload.continuity, taste.fact.id), false,
    'B2: the forgotten fact id must not reach the model through any continuity source');
  assert.equal(wikiSegment(b2.payload.continuity!, NEW_JOB), true,
    'B2: unrelated current facts must survive a forget, so this is not a "memory disabled" pass');
  assert.equal(factOnWire(b2.payload.continuity, corrected.fact.id), true,
    'B2: the surviving fact id must still be consumed');
});

test('B3: a forgotten fact stays forgotten across a restart on the same isolated database', { timeout: 20_000 }, async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();
  const filename = store.filename;
  const packs = await CharacterPackStore.open(store);
  const continuityStore = await ContinuityMemoryStore.open(store);
  const pairing = productionPairing('companion', 'inst-main');
  const continuity = new ProductionContinuityContext({ packs, memory: continuityStore,
    pairing: { pairingFor: () => pairing }, dialogueInputTokenBudget: 30_000 });
  const captured = capture();

  const job = continuityStore.record({ pairing, operationId: 'b3-job-a', layer: 'user_wiki', kind: 'fact',
    text: NEW_JOB, sourceIds: ['msg-job'], origin: 'manual', status: 'active' });
  const taste = continuityStore.record({ pairing, operationId: 'b3-taste-a', layer: 'user_soul', kind: 'fact',
    text: FORGETTABLE, sourceIds: ['msg-taste'], origin: 'manual', status: 'active' });
  const before = await ask(captured, continuity, store, 'b3-before', '我的口味和职业分别是什么？');
  assert.equal(factOnWire(before.payload.continuity, taste.fact.id), true,
    'B3: the fact must be consumed before the restart');
  assert.equal(factOnWire(before.payload.continuity, job.fact.id), true,
    'B3: the surviving fact must be consumed before the restart');

  // Forgetting through the real interface, then closing the connection and the session.
  continuityStore.forget({ pairing, operationId: 'b3-taste-b', targetId: taste.fact.id,
    expectedVersion: taste.fact.version, reason: '用户要求遗忘。' });
  store.close();

  // Reopen the SAME isolated database and rebuild the production consumer from scratch.
  const reopened = f.open();
  const reopenedPacks = await CharacterPackStore.open(reopened);
  const reopenedContinuity = await ContinuityMemoryStore.open(reopened);
  const afterRestartContinuity = new ProductionContinuityContext({ packs: reopenedPacks, memory: reopenedContinuity,
    pairing: { pairingFor: () => pairing }, dialogueInputTokenBudget: 30_000 });
  assert.equal(reopened.filename, filename, 'B3: the restart must reuse the same isolated database');

  // A new legitimate current message is appended on the new connection, then the question is asked.
  const b3 = await ask(captured, afterRestartContinuity, reopened, 'b3-after', '我的口味和职业分别是什么？');
  assert.equal(factOnWire(b3.payload.continuity, taste.fact.id), false,
    'B3: the forgotten fact id must not be resurrected in the evidence sent to the model after a restart');
  assert.equal(wikiSegment(b3.payload.continuity!, NEW_JOB), true,
    'B3: the surviving fact must still be consumed, so this is not a "memory disabled" pass');
  assert.equal(factOnWire(b3.payload.continuity, job.fact.id), true,
    'B3: the surviving fact id must still be consumed after the restart');
  assert.equal(reopenedContinuity.snapshot(pairing).soul.filter(x => x.id === taste.fact.id).length, 0,
    'B3: the forgotten fact must stay revoked in the reopened snapshot');
  // A revocation that survived the restart left a tombstone, not merely a filtered row.
  const tomb = reopened.rawDatabaseForKnowledge()
    .prepare('SELECT reason FROM continuity_tombstones WHERE fact_id=?').get(taste.fact.id) as { reason: string } | undefined;
  assert.equal(tomb?.reason, '用户要求遗忘。', 'B3: the forget must have left a durable tombstone after the restart');
});

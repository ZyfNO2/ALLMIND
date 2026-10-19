// RPD_RESUME_QUALITY_v1 section 6.1: separate the three retrieval layers and capture the real wire.
//
// The report must never collapse these into one "Recall@3":
//   1. lexicalRecall@3      - store.search(..., 'lexical'), raw lexical ranking
//   2. production rank      - snapshot.recall.candidates, including unselected candidates and omissions
//   3. contextEvidenceRecall - the facts that actually reach the serialized provider request
//
// This file walks all three over the real production stack (SqliteMemoryStore, SqliteMemoryPort and
// JsonDialogueProvider) and records what the model would actually receive. The network transport is a
// stub that only captures the request, so no model is called and no quality claim is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteMemoryPort, type SqliteContextOptions } from '../../memory/sqlite-port.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteImportedMemory } from '../../memory/sqlite-imported-memory.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';
import type { HistoricalMessage } from '../../memory/import-source.js';
import type { MemoryChange, MemoryReference, TurnScope } from '../../contracts/index.js';

const TRUTH: { id: string; text: string }[] = [
  { id: 'm-job', text: '我是一名产品设计师。' }, { id: 'm-name', text: '我叫小林。' },
  { id: 'm-city', text: '我住在杭州。' }, { id: 'm-drink', text: '我喜欢喝乌龙茶。' },
  { id: 'm-pet', text: '我养了一只叫豆豆的柴犬。' }, { id: 'm-color', text: '我最喜欢的颜色是深蓝色。' },
  { id: 'm-sport', text: '我平时跑步和游泳。' }, { id: 'm-book', text: '我最近在读《设计的生态学》。' },
];
// Resolved from this module rather than process.cwd(), so the suite behaves the same whether it is
// started from the project root or from a runner that changes directory.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = resolve(projectRoot, '../../..');
const rubric = JSON.parse(readFileSync(resolve(projectRoot, 'tests/eval/fixtures/resume-answers.v2.json'), 'utf8')) as {
  answerable: { id: string; query: string; relevantIds: string[] }[];
};
const scope = (turnId: string): TurnScope => ({ characterId: 'companion', sessionId: 'trace', turnId, generation: 1 });
const countTokens = (context: unknown, text: string) => JSON.stringify(context).length + text.length;

/**
 * The subject of a fact is NOT part of MemoryReference (contracts/index.ts:74). Reading it through a
 * widened type is how this suite proves the gap: if a subject ever appears, the trace records it.
 */
const subjectOf = (memory: MemoryReference): string | undefined =>
  (memory as unknown as { subject?: string }).subject;

function makeFixture() {
  const parent = resolve(projectRoot, '.local/eval-trace/tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-'));
  let time = Date.parse('2026-09-06T12:00:00.000Z');
  const options = { filename: join(directory, 'pet.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => new Date(time += 1000).toISOString() };
  const stores: SqliteMemoryStore[] = [];
  return { cleanup: () => { for (const s of stores) { try { s.close(); } catch { /* closed */ } } rmSync(directory, { recursive: true, force: true }); },
    open: () => { const s = new SqliteMemoryStore(options); stores.push(s); return s; } };
}

/** Seeds through the production import path so the answer never reaches the recent-chat channel. */
function seedFacts(store: SqliteMemoryStore) {
  const imported = new SqliteImportedMemory(store.rawDatabaseForKnowledge(), store);
  const owned = scope('import-seed');
  const base = Date.parse(store.now());
  const messages: HistoricalMessage[] = TRUTH.map((fact, index) => ({
    namespace: 'eval-fixture', itemId: fact.id, role: 'user' as const, text: fact.text,
    createdAt: new Date(base + index * 1000).toISOString() }));
  const added = imported.addEvidence(owned, { jobId: 'trace-seed', sourceKind: 'text-export',
    projectName: 'context trace fixture', messages });
  messages.forEach((message, index) => {
    const change: MemoryChange = { scope: owned, operationId: `add:${message.itemId}`, reason: 'context trace fixture',
      createdAt: new Date(base).toISOString(),
      operation: { type: 'add', id: message.itemId, text: message.text, sourceIds: [added[index]!.recordId] } };
    if (store.apply(change).status !== 'applied') throw new Error(`seed_failed:${message.itemId}`);
  });
}

interface LayerTrace {
  questionId: string; query: string; relevantIds: string[];
  lexicalTop3: string[]; lexicalRecallAt3: number;
  rankCandidates: { id: string; selected: boolean; omission: string | null; relevance: number; priority: number; matchedTerms: string[] }[];
  productionRankRecallAt3: number;
  contextFacts: { id: string; version: number; origin?: string; subject?: string | undefined }[];
  contextEvidenceRecall: number;
  wireMemories: { id: string; text: string; origin?: string; subject?: string | undefined }[];
  wireCarriesSubjectLabel: boolean;
}

test('three retrieval layers are separated and the wire carries no fact-subject label', { timeout: 120_000 }, async () => {
  const f = makeFixture();
  const store = f.open();
  try {
    seedFacts(store);
    const portOptions: SqliteContextOptions = { inputTokenBudget: 32_768, maxRecentMessages: 24,
      maxMemories: 32, summaryLimit: 8, countTokens, relevance: () => 1 };
    const port = new SqliteMemoryPort(store, portOptions);
    const captured: Record<string, unknown>[] = [];
    // Transport stub: records the real request body and returns a fixed reply. It proves what was sent,
    // never a model-quality result.
    const transport = new ProviderTransport(async (_url, init) => {
      captured.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
        message: { content: JSON.stringify({ text: '（固定桩回复，不计模型质量）', expression: { emotion: 'neutral', intensity: 0, delivery: '自然', gesture: null } }) } }] }));
    });
    const config: EndpointConfig = { model: 'stub-model', endpoint: 'https://stub.invalid/chat/completions',
      apiKey: () => 'stub-key', authorizer: { async authorize() { return { async settle() {} }; } } };
    const provider = new JsonDialogueProvider(config, transport);

    const traces: LayerTrace[] = [];
    for (const q of rubric.answerable) {
      const owned = scope(`trace-${q.id}`);
      await port.append(owned, [{ characterId: owned.characterId, id: `${owned.turnId}:user`, role: 'user', text: q.query, createdAt: store.now() }]);
      const snapshot = await port.contextSnapshot(owned, q.query, null, new AbortController().signal);
      const context = snapshot.context;
      await provider.reply({ scope: owned, text: q.query, context }, new AbortController().signal);

      // Layer 1: raw lexical ranking, independent of any gate.
      const lexicalTop3 = store.search(owned, q.query, 3, 'lexical').map(r => r.id);
      // Layer 2: production rank, including candidates that were never selected.
      const candidates = snapshot.recall?.candidates ?? [];
      const selected = candidates.filter(c => c.selected).map(c => c.source.id);
      // Layer 3: what the request actually carries.
      const userPayload = JSON.parse((captured.at(-1) as { messages: { role: string; content: string }[] })
        .messages.find(m => m.role === 'user')!.content) as { memories?: MemoryReference[] };
      const wireMemories = userPayload.memories ?? [];
      const contextFacts = (context.memories ?? []).map(m => ({ id: m.id, version: m.version,
        ...(m.origin ? { origin: m.origin } : {}), subject: subjectOf(m) }));

      const frac = (ids: readonly string[]) => q.relevantIds.length === 0 ? null
        : ids.slice(0, 3).filter(id => q.relevantIds.includes(id)).length / q.relevantIds.length;
      traces.push({
        questionId: q.id, query: q.query, relevantIds: q.relevantIds,
        lexicalTop3, lexicalRecallAt3: frac(lexicalTop3) ?? 0,
        rankCandidates: candidates.map(c => ({ id: c.source.id, selected: c.selected,
          omission: c.omission ?? null, relevance: c.relevance, priority: c.priority, matchedTerms: [...c.matchedTerms] })),
        productionRankRecallAt3: frac(selected) ?? 0,
        contextFacts, contextEvidenceRecall: frac(contextFacts.map(c => c.id)) ?? 0,
        wireMemories: wireMemories.map(m => ({ id: m.id, text: m.text, ...(m.origin ? { origin: m.origin } : {}),
          subject: subjectOf(m) })),
        // A fact-subject label would have to appear on the wire entry itself. It does not: the only
        // attribution reaching the model is the record origin, which is provenance, not subject.
        wireCarriesSubjectLabel: wireMemories.some(m => typeof subjectOf(m) === 'string' && subjectOf(m)!.length > 0),
      });
    }

    // The contract gap this whole section documents, asserted rather than only described.
    assert.ok(traces.length >= 8, 'the trace must cover the frozen answerable set');
    assert.ok(traces.some(t => t.wireMemories.length > 0), 'at least one turn must carry facts to the wire');
    assert.equal(traces.every(t => t.wireCarriesSubjectLabel === false), true,
      'No MemoryReference carries a fact-subject label, so the wire cannot attribute a fact to the user');

    mkdirSync(resolve(repoRoot, 'validation/output/eval/reports/RESUME-QUALITY-v1'), { recursive: true });
    writeFileSync(resolve(repoRoot, 'validation/output/eval/reports/RESUME-QUALITY-v1/context-traces.jsonl'),
      traces.map(t => JSON.stringify(t)).join('\n') + '\n', 'utf8');
    const mean = (pick: (t: LayerTrace) => number) => traces.reduce((s, t) => s + pick(t), 0) / traces.length;
    console.log(`layers over ${traces.length} answerable questions:`);
    console.log(`  lexicalRecall@3      = ${mean(t => t.lexicalRecallAt3).toFixed(4)}`);
    console.log(`  productionRankRecall@3 = ${mean(t => t.productionRankRecallAt3).toFixed(4)}`);
    console.log(`  contextEvidenceRecall  = ${mean(t => t.contextEvidenceRecall).toFixed(4)}`);
    console.log(`  wire carries a subject label: ${traces.some(t => t.wireCarriesSubjectLabel)}`);
  } finally { f.cleanup(); }
});

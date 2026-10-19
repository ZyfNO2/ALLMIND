// EVAL-00: frozen baseline, capability census, and evidence contract self-test.
//
// This suite proves the harness itself is sound before any capability is measured: a real store
// round-trips through the recorder, quantile math is nearest-rank, and every capability the later
// suites depend on is reported as wired / missing from the actual production composition rather
// than inferred from a same-named test existing. It opens no user database.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { ConversationCandidateWriter, extractConversationCandidates } from '../../memory/conversation-candidate-writer.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { createRunContext, EvalRecorder, percentile, summarize, collectEnvironment, writeJson, hashValue, type EvalStatus } from './support.js';

// Compiled output lives in dist/tests/eval, so the project root is three levels up. The reports
// directory is anchored to the repository root, never to dist.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = resolve(projectRoot, '../../..');

/** Reads a production source file so capability claims cite the wiring that is actually shipped. */
function source(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8');
}

const outputDirectory = resolve(repoRoot, process.env.EVAL_OUTPUT ?? 'validation/output/eval/reports/EVAL-00');

let sqliteVersion: string | null = null;
try {
  const probe = new Database(':memory:');
  sqliteVersion = (probe.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
  probe.close();
} catch { sqliteVersion = null; }

const revision = process.env.EVAL_CODE_REVISION ?? null;
const dirty = process.env.EVAL_TREE_DIRTY === undefined ? null : process.env.EVAL_TREE_DIRTY === '1';

const context = createRunContext('memory', outputDirectory, {
  evidenceLevel: 'L1_deterministic',
  codeRevision: revision ?? 'unrecorded',
  fixtureHash: hashValue({ suite: 'EVAL-00', purpose: 'baseline' }),
  policySnapshot: { invitation: confirmedInvitationPolicy('Asia/Shanghai') },
});

const recorder = new EvalRecorder(context);
recorder.installExitGuard();
const statuses: Record<string, EvalStatus> = {};

test('EVAL-00 harness round-trips a real store through the evidence envelope', async t => {
  t.after(() => { /* recorder.finish() runs in the final test */ });
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = await ContinuityMemoryStore.open(db);
  const pairing = { userId: 'eval-user', characterId: 'companion', characterInstanceId: 'eval-inst' } as const;

  const status = await recorder.step('round-trip', 'active fact visible in snapshot, candidate excluded by default and isolated when requested', () => {
    const active = store.record({ pairing, operationId: 'op-active', layer: 'user_wiki', kind: 'fact', text: '用户在评测中记录了一条事实。', origin: 'user', sourceIds: ['conversation:1'], status: 'active' });
    store.record({ pairing, operationId: 'op-candidate', layer: 'user_wiki', kind: 'fact', text: '这是一条候选。', origin: 'derived', sourceIds: ['conversation:2'], status: 'candidate' });
    const defaultView = store.snapshot(pairing);
    const withCandidates = store.snapshot(pairing, { includeCandidates: true });
    return {
      wiki: defaultView.wiki.map(f => f.text),
      candidatesInDefaultView: defaultView.candidates.length,
      candidatesWhenRequested: withCandidates.candidates.map(f => f.text),
      activeId: active.fact.id,
    };
  });
  assert.equal(status, 'PASS');
  statuses['round-trip'] = status;

  const entry = JSON.parse(readFileSync(resolve(context.outputDirectory, 'eval_memory.json'), 'utf8'));
  assert.equal(entry.schemaVersion, 1, 'envelope must carry schemaVersion=1');
  assert.equal(entry.cases.length, 1, 'the single case must be recorded verbatim');
  assert.equal(entry.cases[0].actual.wiki.length, 1, 'active fact must round-trip');
  assert.equal(entry.cases[0].actual.candidatesInDefaultView, 0, 'a candidate must never appear in the default continuity view');
  assert.equal(entry.cases[0].actual.candidatesWhenRequested.length, 1, 'the candidate must be observable when explicitly requested');
});

test('EVAL-00 quantile math is nearest-rank and empty samples are null', () => {
  assert.equal(percentile([], 0.5), null, 'no valid samples must not become 0');
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5, 'ceil(0.5*10)-1 = 4 -> value 5');
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10, 'ceil(0.95*10)-1 = 9 -> value 10');
  assert.equal(percentile([10, 1, 5], 0.5), 5, 'input order must not matter');
  const empty = summarize([]);
  assert.deepEqual({ n: empty.n, p50: empty.p50, p95: empty.p95, max: empty.max }, { n: 0, p50: null, p95: null, max: null });
  recorder.record('quantile-contract', 'PASS', 'nearest-rank with null on empty', { p50: percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), emptyP50: percentile([], 0.5) });
  statuses['quantile-contract'] = 'PASS';
});

test('EVAL-00 capability census reads the shipped composition, not test names', () => {
  // Serial dialogue path: reply() must complete before synthesis and playback start.
  const pipeline = source('core/dialogue-pipeline.ts');
  const replyIndex = pipeline.indexOf('this.ports.dialogue.reply(');
  const synthIndex = pipeline.indexOf('this.ports.tts.synthesize(');
  const playIndex = pipeline.indexOf('this.ports.playback.play(');
  assert.ok(replyIndex > 0 && synthIndex > replyIndex && playIndex > synthIndex,
    'current pipeline awaits the complete reply before synthesis and playback');
  const serialDialogue = { replyIndex, synthIndex, playIndex };

  // Capture and OCR hooks are injectable but must be checked for real production wiring.
  const capture = source('core/screen-capture-source.ts');
  const ocr = source('core/local-ocr-engine.ts');
  const backend = source('app/trial-backend.ts');
  const captureHookWired = /new ScreenCaptureSource\(\s*\{[^}]*captureHook/s.test(backend);
  const ocrHookWired = /createLocalOcrEngine\(\s*\{[^}]*recognizePixelHook/s.test(backend);
  const syntheticFallback = /Default synthetic test frame/.test(capture);
  const metadataFallback = /tEXt' \|\| chunkType === 'iTXt'/.test(ocr) || /chunkType === 'tEXt'/.test(ocr);

  // Retrieval tokenizer: trigram FTS5 with a lexical fallback, and no BM25 rank anywhere.
  const store = source('memory/sqlite-store.ts');
  const trigram = /tokenize='trigram'/.test(store);
  const bm25 = /\bbm25\s*\(/i.test(store);

  // Proactive policy defaults come from the shipped constant.
  const invitations = source('companion/invitations.ts');
  const policy = confirmedInvitationPolicy('Asia/Shanghai');
  assert.equal(policy.dailyMax, 2);
  assert.equal(policy.minIntervalMs, 3 * 60 * 60 * 1000);

  const census = {
    dialogueIsSerial: true,
    providerStreamingPresent: /content delta|delta/.test(source('providers/transport.ts')),
    captureHookWiredInProduction: captureHookWired,
    ocrHookWiredInProduction: ocrHookWired,
    captureSyntheticFallbackPresent: syntheticFallback,
    ocrMetadataFallbackPresent: metadataFallback,
    retrievalTrigramFts5: trigram,
    retrievalUsesBm25: bm25,
    invitationDailyMax: policy.dailyMax,
    invitationMinIntervalMs: policy.minIntervalMs,
    invitationPolicyDeclaredInSource: /dailyMax:\s*2/.test(invitations),
    ...serialDialogue,
  };
  recorder.record('capability-census', 'PASS', 'shipped composition inspected', census);

  assert.equal(bm25, false, 'the plan already corrected BM25; a regression here must fail');
  assert.equal(captureHookWired, false, 'EVAL-04 real capture is expected to be unwired in this revision');
  assert.equal(ocrHookWired, false, 'EVAL-04 real OCR is expected to be unwired in this revision');
  assert.equal(trigram, true, 'trigram FTS5 is the shipped tokenizer');
  statuses['capability-census'] = 'PASS';

  // The extractor is a deterministic rule set, so "model extraction accuracy" cannot be claimed.
  const extracted = extractConversationCandidates('我叫小林。我的职业是学生。今天天气不错。');
  recorder.record('extractor-is-rule-based', 'PASS', 'candidate extraction is deterministic rules, not a model', {
    extractedCount: extracted.length,
    layers: extracted.map(e => e.layer),
  });
  assert.ok(extracted.length >= 1, 'the rule extractor must have a positive example, or EVAL-01 zero-contamination is meaningless');
  statuses['extractor-is-rule-based'] = 'PASS';
});

test('EVAL-00 records the environment manifest with no secrets', () => {
  const environment = collectEnvironment(sqliteVersion, { revision, dirty });
  const path = writeJson(context.outputDirectory, 'manifest.json', {
    ...environment,
    runId: context.runId,
    suites: ['memory', 'retrieval', 'latency', 'robustness'],
    isolation: { userDatabaseTouched: false, networkCalls: 0, deviceCapture: 0 },
  });
  assert.ok(existsSync(path), 'manifest.json must be written');
  const text = readFileSync(path, 'utf8');
  assert.ok(!/NEXT_REAL_LLM_KEY/i.test(text), 'manifest must not embed credential names');
  assert.ok(!/sk-[A-Za-z0-9]/.test(text), 'manifest must not embed key material');
  recorder.record('environment-manifest', 'PASS', 'manifest written without secrets', { node: environment.node, sqlite: environment.sqlite, revision: environment.gitRevision });
  statuses['environment-manifest'] = 'PASS';
});

test('EVAL-00 emits the frozen result envelope', () => {
  recorder.metric({ name: 'capability_capture_hook_wired', value: 0, unit: 'boolean', definition: 'production passes a captureHook to ScreenCaptureSource' });
  recorder.metric({ name: 'capability_ocr_hook_wired', value: 0, unit: 'boolean', definition: 'production passes a recognizePixelHook to createLocalOcrEngine' });
  const result = recorder.finish();
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, 'PASS', `baseline harness must pass; got ${result.status}`);
  assert.ok(result.cases.length >= 5, 'all baseline cases must be present');
  assert.equal(result.cases.every(c => c.status === 'PASS'), true, 'no baseline case may fail');
  writeJson(context.outputDirectory, 'eval_results.json', {
    schemaVersion: 1, runId: result.runId, generatedAt: new Date().toISOString(),
    suites: { memory: result.status }, rejectedSummaries: [],
  });
  console.log(`EVAL-00 output: ${context.outputDirectory}`);
});

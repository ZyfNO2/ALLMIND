/** Bounded real-provider verification. Reads only the existing explicitly configured text binding. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FileBookRepository } from '../dist/memory/file-book-repository.js';
import { BookRuntime } from '../dist/app/book-runtime.js';
import { BookHttpModel } from '../dist/providers/book-model.js';
import { isPrivateFileSync } from '../dist/core/platform-files.js';

const localProxy = process.env.BOOK_VERIFY_PROXY_KEY;
const trialFile = resolve('../../.local/model-evaluation/trial/user-trial/config.json');
const source = localProxy ? { endpoint: 'http://127.0.0.1:18899/v1/chat/completions', model: process.env.BOOK_VERIFY_MODEL || 'deepseek-ai/deepseek-v4.1-flash', provider: 'user-local-proxy', credentialFile: 'environment-only' }
  : JSON.parse(readFileSync(trialFile, 'utf8')).models.dialogue;
assert.ok(source?.endpoint && source?.model && source?.credentialFile, 'Existing dialogue binding required');
if (!localProxy) assert.ok(isPrivateFileSync(source.credentialFile), 'Existing credential must be private');
const key = localProxy || readFileSync(source.credentialFile, 'utf8').trim();
assert.ok(key && !/[\r\n]/.test(key), 'Credential shape invalid');
const transport = new BookHttpModel(async id => { assert.equal(id, 'existing-dialogue'); return key; });
const requests = [];
const model = { async complete(binding, messages, signal, json) {
  const request = { stage: json ? 'fast' : 'main', model: binding.model, messages: structuredClone(messages), reply: null };
  requests.push(request);
  request.reply = await transport.complete(binding, messages, signal, json);
  return request.reply;
} };
const root = resolve('.local/memory-book-real-check'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-')), repository = new FileBookRepository(directory);
const binding = { baseUrl: source.endpoint, model: source.model, credentialId: 'existing-dialogue', inputTokens: 32768, outputTokens: 2048 };
const evidence = { date: new Date().toISOString(), model: source.model, provider: source.provider, modelProtocol: 'OpenAI-compatible', directory, requests, turns: [], planner: null, rerank: null, status: 'IN_PROGRESS' };
const evidenceDir = resolve('../../../docs/next/local-memory-book/evidence/real'); mkdirSync(evidenceDir, { recursive: true });
try {
  const config = repository.loadConfig();
  repository.commitConfig({ ...config, mainModel: binding, recall: { ...config.recall, mode: 'off' } }, 0, 'real-model');
  const runtime = new BookRuntime(repository, model), scope = runtime.scope('aika', 'real-check');
  const fixture = readFileSync(resolve('../../../docs/next/aiki-character-book/fixtures/allmind.aiki.md'), 'utf8');
  const preview = runtime.imports.preview(scope, fixture, 'allmind.aiki.md'); assert.deepEqual(preview.diagnostics, []);
  runtime.imports.apply(scope, preview.id, 'real-import');
  const queries = [{ query: '测试机库是什么地方？', entryId: 'wiki.location.test_hangar', expected: '机库' }, { query: '测试任务讨论时你建议了什么备用方案？', entryId: 'story.20261010.mission_discussion', expected: '备用' }];
  for (const item of queries) {
    const started = performance.now();
    const result = await runtime.chat(scope, item.query, AbortSignal.timeout(75000));
    assert.ok(result.context.consumed.some(ref => ref.entryId === item.entryId), 'Expected entry must reach main Prompt');
    assert.ok(result.turn.assistant.includes(item.expected), 'Answer must contain the relevant source fact');
    evidence.turns.push({ query: item.query, reply: result.turn.assistant, consumed: result.context.consumed, messages: result.context.messages, elapsedMs: performance.now() - started });
    process.stdout.write(`REAL_TEXT_TURN_PASS ${evidence.turns.length}: ${item.entryId}\n`);
  }
  // Exercise the actual runtime Fast LLM binding, Engine and Builder, not a standalone planner only.
  const next = repository.loadConfig();
  repository.commitConfig({ ...next, fastModel: { ...binding, outputTokens: 1024 }, recall: { ...next.recall, mode: 'deep', limits: { ...next.recall.limits, selected: 1, plannerMs: 30000 } } }, next.revision, 'real-fast-binding');
  const started = performance.now();
  const context = await runtime.inspect(scope, '测试机库是什么地方？之前测试任务讨论时 ALLMIND 为什么建议准备备用撤退方案？请查人物和事件。', AbortSignal.timeout(35000));
  const plan = context.recall.plan;
  assert.equal(plan.action, 'RETRIEVE'); assert.ok(plan.queries.length);
  assert.equal(context.recall.enhancement, 'planned');
  assert.ok(context.recall.timings.rerank !== undefined, 'Production Engine must actually execute rerank');
  assert.equal(requests.filter(request => request.stage === 'fast').length, 2);
  evidence.planner = { plan, elapsedMs: performance.now() - started, configuredTimeoutMs: 30000, context: context.messages };
  evidence.rerank = context.recall.candidates.filter(candidate => candidate.rawScores.rerank !== undefined);
  assert.ok(evidence.rerank.length, 'Validated existing candidate IDs must reach production Trace');
  evidence.status = 'PASS';
  process.stdout.write('REAL_PLANNER_AND_RERANK_PASS (explicit 30s verification budget; product default remains 2s).\n');
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = { name: error.name, message: error.message };
  process.stderr.write(`Real verification failed: ${error.name}: ${error.message}\n`); process.exitCode = 1;
} finally {
  repository.close(); writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
}

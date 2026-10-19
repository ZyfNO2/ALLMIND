import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { BookRuntime } from '../../app/book-runtime.js';
import { emptyEntry, type ChatMessage, type BookScope, type ModelBinding } from '../../contracts/memory-book.js';
import { BookImportService } from '../../memory/book-import.js';
import { BookModelPlanner, validateBookPlan } from '../../providers/book-model.js';
const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'runtime-session' };
const binding: ModelBinding = { baseUrl: 'http://127.0.0.1:9999/v1', model: 'protocol-stub', credentialId: 'local', inputTokens: 8192, outputTokens: 1024 };
function fixture(t: test.TestContext) {
  const root = join(process.cwd(), '.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'runtime-')), repository = new FileBookRepository(directory);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); }); return repository;
}
test('existing .aiki.md imports into new owner, duplicate/noop export roundtrip and manual conflicts are preserved', t => {
  const repository = fixture(t), service = new BookImportService(repository);
  const raw = readFileSync(resolve('../../../validation/fixtures/aiki-character-book/allmind.aiki.md'), 'utf8');
  const preview = service.preview(scope, raw, 'allmind.aiki.md');
  assert.deepEqual(preview.diagnostics, []); assert.equal(preview.entries.length, 12);
  const receipt = service.apply(scope, preview.id, 'apply-1');
  assert.deepEqual(service.apply(scope, preview.id, 'apply-1'), receipt);
  const duplicate = service.preview(scope, raw, 'allmind.aiki.md');
  assert.ok(duplicate.changes.every(change => change.action === 'noop'));
  service.apply(scope, duplicate.id, 'duplicate-1'); assert.equal(repository.snapshot(scope).revision, receipt.revision);
  const exported = service.export(scope), roundtrip = service.preview(scope, exported.text, exported.filename);
  assert.ok(roundtrip.changes.every(change => change.action === 'noop'));
  const markdown = service.export(scope, 'markdown'), markdownRoundtrip = service.preview(scope, markdown.text, markdown.filename);
  assert.deepEqual(markdownRoundtrip.diagnostics, []);
  assert.ok(markdownRoundtrip.changes.every(change => change.action === 'noop'));
  const book = repository.snapshot(scope), entry = book.entries.find(item => item.type === 'wiki')!;
  repository.commit(scope, { upsert: [{ ...entry, body: '手动修改' }] }, book.revision, 'hand-edit');
  const changed = service.preview(scope, raw, 'allmind.aiki.md');
  assert.equal(changed.changes.find(item => item.id === entry.id)?.action, 'conflict');
  service.apply(scope, changed.id, 'reimport'); assert.equal(repository.snapshot(scope).entries.find(item => item.id === entry.id)?.body, '手动修改');
});
test('formal chat and dry-run Inspector share exact Prompt; only successful formal turns persist/advance', async t => {
  const repository = fixture(t), observed: ChatMessage[][] = [];
  const runtime = new BookRuntime(repository, { async complete(_binding, messages) { observed.push(structuredClone(messages)); return '第一次见面是在机库。'; } });
  const config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: binding }, 0, 'model');
  repository.commit(scope, { upsert: [emptyEntry('core', 'persona', '人格', '温和诚实。'), emptyEntry('episode', 'story', '第一次见面', '我们第一次见面是在机库。')] }, 0, 'seed');
  const controller = new AbortController();
  const dry = await runtime.inspect(scope, '第一次见面在哪里？', controller.signal);
  assert.equal(observed.length, 0); assert.equal(repository.readSession(scope).length, 0);
  const result = await runtime.chat(scope, '第一次见面在哪里？', controller.signal);
  assert.deepEqual(result.context!.messages, dry.messages);
  assert.deepEqual(observed[0], result.context!.messages);
  assert.equal(repository.readSession(scope).length, 1);
  assert.deepEqual(runtime.trace(scope, result.turn.traceId).messages, observed[0]);
  assert.throws(() => runtime.trace({ ...scope, sessionId: 'other' }, result.turn.traceId), { code: 'not_found' });
});
test('invalid Planner schemas/unknown rerank IDs fail; NO_RETRIEVAL remains available', async () => {
  assert.throws(() => validateBookPlan({ action: 'RETRIEVE', queries: ['x'], arbitrary: true }), { code: 'invalid_input' });
  const valid = { action: 'NO_RETRIEVAL', intent: ['chat'], queries: [], entities: [], sources: [], timeRange: { from: null, to: null } };
  assert.equal(validateBookPlan(valid).action, 'NO_RETRIEVAL');
  const planner = new BookModelPlanner({ async complete() { return JSON.stringify({ ranking: [{ id: 'invented', rank: 1, reason: 'fake' }] }); } }, binding);
  await assert.rejects(planner.rerank({ query: 'x', candidates: [{ id: 'real', title: 'Title', text: 'body' }] }, new AbortController().signal), { code: 'invalid_input' });
});
test('model failure preserves history', async t => {
  const repository = fixture(t);
  const config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: binding }, 0, 'model');
  const runtime = new BookRuntime(repository, { async complete() { throw new Error('protocol failure'); } });
  await assert.rejects(runtime.chat(scope, '你好', new AbortController().signal), /protocol failure/);
  assert.equal(repository.readSession(scope).length, 0);
});

test('in-flight chat rejects concurrent turns, cancels on edit, and never commits old data', async t => {
  const repository = fixture(t), config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: binding }, 0, 'model');
  let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
  const runtime = new BookRuntime(repository, { async complete(_binding, _messages, signal) {
    entered(); return new Promise<string>((_done, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } });
  repository.commit(scope, { upsert: [emptyEntry('wiki', 'wiki', 'Alice', 'Alice 的旧正文')] }, 0, 'seed');
  const pending = runtime.chat(scope, 'Alice', new AbortController().signal);
  await started;
  await assert.rejects(runtime.chat(scope, '重复消息', new AbortController().signal), { code: 'busy' });
  const book = repository.snapshot(scope);
  repository.commit(scope, { upsert: [{ ...book.entries[0]!, body: 'Alice 的新正文' }] }, book.revision, 'edit');
  runtime.invalidate(scope.characterId);
  await assert.rejects(pending, { code: 'conflict' });
  assert.equal(repository.readSession(scope).length, 0);
});

test('Smart bypasses Fast LLM on greetings; timeout fails unless explicit local downgrade is enabled', async t => {
  const repository = fixture(t), config = repository.loadConfig();
  repository.commitConfig({ ...config, mainModel: binding, fastModel: { ...binding, model: 'fast-stub' }, recall: { ...config.recall, limits: { ...config.recall.limits, plannerMs: 100 } } }, 0, 'model');
  let calls = 0;
  const runtime = new BookRuntime(repository, { async complete(_binding, _messages, signal) {
    calls++; return new Promise<string>((_done, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } });
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  assert.equal((await runtime.inspect(scope, '你好', new AbortController().signal)).recall.enhancement, 'local');
  assert.equal(calls, 0);
  await assert.rejects(runtime.inspect(scope, '为什么我们之前讨论过这件事？', new AbortController().signal), { name: 'TimeoutError' });
  const next = repository.loadConfig(); repository.commitConfig({ ...next, recall: { ...next.recall, continueLocalOnError: true } }, next.revision, 'downgrade');
  const downgraded = await runtime.inspect(scope, '为什么我们之前讨论过这件事？', new AbortController().signal);
  assert.equal(downgraded.recall.enhancement, 'degraded'); assert.match(downgraded.recall.enhancementError!, /TimeoutError/);
  assert.equal(repository.readSession(scope).length, 0);
});

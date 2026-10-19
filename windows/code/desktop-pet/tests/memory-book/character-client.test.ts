import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { FileBookRepository, deriveSessionTitle } from '../../memory/file-book-repository.js';
import { BookRuntime } from '../../app/book-runtime.js';
import { BookHttpModel } from '../../providers/book-model.js';
import { BookCredentials } from '../../management/book-credentials.js';
import { startBookServer } from '../../management/book-server.js';
import { emptyEntry, DEFAULT_CHATGPT_WEB_SOURCE, type BookScope, type ModelBinding, type SavedTurn } from '../../contracts/memory-book.js';

/** Character-client backend round: session summaries, explicit model test, locate-by-turn replay. */
const fixtureRoot = () => { const root = join(process.cwd(), '.local', 'memory-book-tests'); mkdirSync(root, { recursive: true }); return root; };
const binding = (baseUrl: string, model = 'protocol-stub'): ModelBinding => ({ baseUrl, model, credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 });
const savedTurn = (scope: BookScope, id: string, at: string, user: string): SavedTurn => ({ ...scope, id, timestamp: at, user, assistant: `${id} 的回答`, traceId: `trace-${id}` });

test('session summaries derive from persisted turns, stay scoped and bound oversized files', t => {
  const directory = mkdtempSync(join(fixtureRoot(), 'sessions-'));
  const repository = new FileBookRepository(directory);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const aika = { characterId: 'aika', pairingId: 'local-user', sessionId: 'web-chat' };
  repository.appendTurn(aika, savedTurn(aika, 't1', '2026-10-11T01:00:00.000Z', ' 第一次   见面是在哪里？ '));
  repository.appendTurn(aika, savedTurn(aika, 't2', '2026-10-11T02:00:00.000Z', '后来呢'));
  const otherRole = { characterId: 'role-b', pairingId: 'local-user', sessionId: 'web-chat' };
  repository.appendTurn(otherRole, savedTurn(otherRole, 'o1', '2026-10-11T03:00:00.000Z', '其他角色的会话'));
  const otherPair = { characterId: 'aika', pairingId: 'other-pair', sessionId: 'pair-session' };
  repository.appendTurn(otherPair, savedTurn(otherPair, 'p1', '2026-10-11T04:00:00.000Z', '其他配对'));
  // Oversized session (> 8 MiB): the exact turn count is not paid for; head/tail still identify it.
  const bigScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'big-one' };
  const bigFile = join(directory, `session-${createHash('sha256').update(JSON.stringify(bigScope)).digest('hex')}.jsonl`);
  const filler = '长'.repeat(1024);
  let big = JSON.stringify(savedTurn(bigScope, 'big-first', '2026-10-11T05:00:00.000Z', '超大会话开头')) + '\n';
  for (let index = 0; index < 4000; index++) big += JSON.stringify({ ...bigScope, id: `big-${index}`, timestamp: '2026-10-11T06:00:00.000Z', user: '填充', assistant: filler, traceId: 'trace-big' }) + '\n';
  big += JSON.stringify(savedTurn(bigScope, 'big-last', '2026-10-11T07:00:00.000Z', '超大会话结尾')) + '\n';
  writeFileSync(bigFile, big);
  const sessions = repository.listSessions('aika', 'local-user');
  assert.deepEqual(sessions.map(item => item.sessionId), ['big-one', 'web-chat']);
  assert.ok(sessions.every(item => item.characterId === 'aika' && item.pairingId === 'local-user'), '其他角色/配对的会话不得泄漏');
  assert.equal(sessions[0]!.turnCount, -1);
  assert.equal(sessions[0]!.lastTurnId, 'big-last');
  assert.equal(sessions[0]!.title, '超大会话开头');
  assert.equal(sessions[0]!.updatedAt, '2026-10-11T07:00:00.000Z');
  assert.equal(sessions[1]!.title, '第一次 见面是在哪里？');
  assert.equal(sessions[1]!.turnCount, 2);
  assert.equal(sessions[1]!.createdAt, '2026-10-11T01:00:00.000Z');
  assert.equal(sessions[1]!.updatedAt, '2026-10-11T02:00:00.000Z');
  assert.equal(sessions[1]!.lastTurnId, 't2');
  assert.equal(deriveSessionTitle(null), '未命名会话');
});

test('GET /sessions exposes derived summaries for the requested scope only', async t => {
  const directory = mkdtempSync(join(fixtureRoot(), 'sessions-route-'));
  const repository = new FileBookRepository(directory);
  const runtime = new BookRuntime(repository, { async complete() { throw Error('listing must not call chat'); } });
  const server = await startBookServer({ runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management') });
  t.after(async () => { await server.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = new URL(server.url).origin, headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const web = { characterId: 'aika', pairingId: 'local-user', sessionId: 'web-chat' };
  repository.appendTurn(web, savedTurn(web, 'w1', '2026-10-11T01:00:00.000Z', '网页会话第一条'));
  const desktop = { characterId: 'aika', pairingId: 'local-user', sessionId: 'desktop' };
  repository.appendTurn(desktop, savedTurn(desktop, 'd1', '2026-10-11T08:00:00.000Z', '桌宠会话第一条'));
  const missing = await fetch(origin + '/api/memory-book/v1/sessions?characterId=missing', { headers });
  assert.equal(missing.status, 404);
  const response = await fetch(origin + '/api/memory-book/v1/sessions?characterId=aika', { headers });
  assert.equal(response.status, 200);
  const data = await response.json() as { sessions: { sessionId: string; turnCount: number }[] };
  assert.deepEqual(data.sessions.map(item => item.sessionId), ['desktop', 'web-chat']);
  assert.ok(data.sessions.every(item => item.turnCount === 1));
});

test('POST /models/test runs one minimal real request with the transient key and writes nothing', async t => {
  const directory = mkdtempSync(join(fixtureRoot(), 'model-test-'));
  const repository = new FileBookRepository(directory);
  const credentials = new BookCredentials(join(directory, 'credentials'));
  credentials.save('saved-key', 'saved-fixture-key');
  const upstreamSeen: { authorization: string; body: { model: string; messages: { role: string }[]; max_tokens: number; stream: boolean; response_format?: unknown } }[] = [];
  const upstream = createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; }); request.on('end', () => {
      const body = JSON.parse(raw);
      upstreamSeen.push({ authorization: request.headers.authorization ?? '', body });
      if (body.model === 'test-model') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '测试成功' } }] })); return; }
      response.writeHead(500); response.end(JSON.stringify({ error: 'upstream broken' }));
    });
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const port = upstream.address(); assert.ok(port && typeof port !== 'string');
  const runtime = new BookRuntime(repository, new BookHttpModel(id => credentials.get(id)));
  const server = await startBookServer({ runtime, credentials, uiRoot: resolve('management') });
  t.after(async () => { await server.close(); await new Promise<void>(done => { upstream.close(() => done()); upstream.closeIdleConnections(); }); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = new URL(server.url).origin, headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const call = (data: unknown) => fetch(origin + '/api/memory-book/v1/models/test', { method: 'POST', headers, body: JSON.stringify(data) });
  const draft = { baseUrl: `http://127.0.0.1:${port.port}/v1`, model: 'test-model', credentialId: 'saved-key', inputTokens: 8192, outputTokens: 2048 };
  const success = await call({ binding: draft, apiKey: 'draft-fixture-key' });
  assert.equal(success.status, 200);
  const result = await success.json() as { ok: boolean; reply: string; testedAt: string; durationMs: number; model: string };
  assert.deepEqual(result, { ok: true, reply: '测试成功', testedAt: result.testedAt, durationMs: result.durationMs, model: 'test-model' });
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0 && Number.isFinite(Date.parse(result.testedAt)));
  assert.equal(upstreamSeen.length, 1);
  assert.equal(upstreamSeen[0]!.authorization, 'Bearer draft-fixture-key');
  assert.deepEqual(upstreamSeen[0]!.body.messages, [{ role: 'user', content: '连接测试：请只回复「测试成功」。' }], '测试不触发召回，不携带任何 Book 内容');
  assert.equal(upstreamSeen[0]!.body.max_tokens, 512);
  assert.equal(upstreamSeen[0]!.body.stream, false);
  assert.equal(upstreamSeen[0]!.body.response_format, undefined);
  // Draft test persists nothing: no credential save, no config revision, no session file.
  assert.equal(await credentials.get('saved-key'), 'saved-fixture-key');
  assert.equal(repository.loadConfig().revision, 0);
  assert.deepEqual(repository.listSessions('aika', 'local-user'), []);
  // A failing upstream is an honest test result (HTTP 200 + ok:false + real reason), not a transport error.
  const failure = await call({ binding: { ...draft, model: 'broken-model' }, apiKey: '' });
  assert.equal(failure.status, 200);
  const failed = await failure.json() as { ok: boolean; error: { code: string; message: string } };
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'unavailable');
  assert.match(failed.error.message, /HTTP 500/);
  assert.equal(upstreamSeen[1]!.authorization, 'Bearer saved-fixture-key', '空 apiKey 时使用已保存凭据');
  // Endpoint rules match model discovery; malformed requests are rejected before any upstream call.
  assert.equal((await call({ binding: { ...draft, baseUrl: 'http://example.com/v1' } })).status, 400);
  assert.equal((await call({ binding: draft, apiKey: 'bad\nkey' })).status, 400);
  assert.equal((await call({ binding: draft, prompt: 'x'.repeat(2001) })).status, 400);
  assert.equal(upstreamSeen.length, 2);
});

test('model test reports bounded timeout and cancellation honestly', async t => {
  const directory = mkdtempSync(join(fixtureRoot(), 'model-test-limits-'));
  const repository = new FileBookRepository(directory);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const runtime = new BookRuntime(repository, { async complete(_binding, _messages, signal) {
    return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const timeout = await runtime.testModel(binding('http://127.0.0.1:9/v1'), { signal: AbortSignal.timeout(60) });
  assert.equal(timeout.ok, false); assert.equal(timeout.error!.code, 'timeout'); assert.match(timeout.error!.message, /时限/);
  const controller = new AbortController();
  const pending = runtime.testModel(binding('http://127.0.0.1:9/v1'), { signal: controller.signal });
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false); assert.equal(cancelled.error!.code, 'cancelled');
});

test('BookHttpModel keeps planner JSON strict, accepts capped test replies and transient keys', async () => {
  const calls: { authorization: string; body: Record<string, unknown> }[] = [];
  const transport = (async (_input: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ authorization: String((init.headers as Record<string, string>).Authorization ?? ''), body });
    // Planner JSON requests finish cleanly; plain replies report a length cap so truncation handling is exercised.
    const capped = !body.response_format;
    return new Response(JSON.stringify({ choices: [{ finish_reason: capped ? 'length' : 'stop', message: { content: capped ? '被截断但真实的回答' : '正常回答' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const model = new BookHttpModel(async () => 'stored-fixture-key', transport);
  const signal = new AbortController().signal, messages = [{ role: 'user' as const, content: 'x' }];
  assert.equal(await model.complete(binding('http://127.0.0.1:9/v1'), messages, signal, { allowTruncated: true, apiKey: 'transient-key' }), '被截断但真实的回答');
  assert.equal(calls[0]!.authorization, 'Bearer transient-key');
  await assert.rejects(model.complete(binding('http://127.0.0.1:9/v1'), messages, signal), { code: 'unavailable' }, '正式轮次仍拒绝被截断的回答');
  assert.equal(calls[1]!.authorization, 'Bearer stored-fixture-key', '未提供临时 key 时回退到已保存凭据');
  await model.complete(binding('http://127.0.0.1:9/v1'), messages, signal, { json: true });
  assert.deepEqual(calls[2]!.body.response_format, { type: 'json_object' }, 'planner 的 JSON 输出约束不受改动影响');
});

test('chat turnId replays the persisted turn instead of duplicating a success', async t => {
  const directory = mkdtempSync(join(fixtureRoot(), 'chat-replay-'));
  const repository = new FileBookRepository(directory);
  let calls = 0;
  const runtime = new BookRuntime(repository, { async complete() { calls++; return '机库答复'; } });
  const config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: binding('http://127.0.0.1:9999/v1') }, 0, 'model');
  const server = await startBookServer({ runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management') });
  // The server/repository are closed once mid-test to prove the restart behaviour; the after-hook tolerates that.
  t.after(async () => { await server.close().catch(() => {}); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = new URL(server.url).origin, headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const call = (data: unknown) => fetch(origin + '/api/memory-book/v1/chat', { method: 'POST', headers, body: JSON.stringify(data) });
  const payload = { characterId: 'aika', sessionId: 'replay', text: '第一次见面在哪里？', turnId: 'client-turn-1' };
  const first = await call(payload);
  assert.equal(first.status, 200);
  const firstData = await first.json() as { turn: SavedTurn; context: unknown; replayed: boolean };
  assert.equal(firstData.turn.id, 'client-turn-1');
  assert.equal(firstData.replayed, false);
  assert.ok(firstData.context, '首次提交返回本轮召回上下文');
  const retry = await call(payload);
  assert.equal(retry.status, 200);
  const retryData = await retry.json() as { turn: SavedTurn; context: unknown; replayed: boolean };
  assert.equal(retryData.turn.id, 'client-turn-1');
  assert.equal(retryData.replayed, true);
  assert.equal(calls, 1, '重试不得再次请求模型');
  assert.equal(repository.readSession({ characterId: 'aika', pairingId: 'local-user', sessionId: 'replay' }).length, 1);
  assert.equal((await call({ ...payload, text: '不同的消息' })).status, 409);
  assert.equal((await call({ ...payload, turnId: 'bad id!' })).status, 400);
  // After a restart the trace is gone; the turn itself stays readable and still replays exactly once.
  await server.close(); repository.close();
  const reopened = new FileBookRepository(directory);
  const restarted = new BookRuntime(reopened, { async complete() { calls++; return '不应被调用'; } });
  const replay = await restarted.chat({ characterId: 'aika', pairingId: 'local-user', sessionId: 'replay' }, payload.text, new AbortController().signal, { turnId: 'client-turn-1' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.context, null, '旧 Trace 过期明确为 null，历史仍可读');
  assert.equal(replay.turn.assistant, '机库答复');
  assert.equal(calls, 1);
  assert.equal(reopened.readSession({ characterId: 'aika', pairingId: 'local-user', sessionId: 'replay' }).length, 1);
  reopened.close();
});

test('desktop backend keeps one addressable session and replayed submits never duplicate a turn', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(fixtureRoot(), 'desktop-replay-'));
  let modelCalls = 0;
  const upstream = createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; }); request.on('end', () => {
      modelCalls++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '机库答复' } }] }));
    });
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const port = upstream.address(); assert.ok(port && typeof port !== 'string');
  const repository = new FileBookRepository(directory), config = repository.loadConfig();
  repository.commitConfig({ ...config, chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded' }, mainModel: binding(`http://127.0.0.1:${port.port}/v1`, 'ndjson-stub') }, 0, 'model');
  repository.close();
  const child = spawn(process.execPath, ['dist/app/book-backend.js'], { env: { ...process.env, AIKI_BOOK_DATA: directory, AIKI_BOOK_WEB_ONLY: '0', AIKI_BOOK_PORT: '' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: any[] = []; let raw = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { raw += chunk; let end; while ((end = raw.indexOf('\n')) >= 0) { messages.push(JSON.parse(raw.slice(0, end))); raw = raw.slice(end + 1); } });
  const exited = new Promise<number>(done => child.once('exit', code => done(code ?? -1)));
  t.after(async () => { await new Promise<void>(done => { upstream.close(() => done()); upstream.closeIdleConnections(); }); rmSync(directory, { recursive: true, force: true }); });
  const waitFor = async (predicate: (message: any) => boolean) => {
    for (let index = 0; index < 250; index++) {
      const message = messages.find(predicate);
      if (message) return message;
      if (child.exitCode !== null) throw Error(`Backend exited early: ${stderr}`);
      await new Promise(done => setTimeout(done, 40));
    }
    throw Error('Backend message timeout: ' + stderr);
  };
  try {
    const ready = await waitFor(message => message.channel === 'backend_ready');
    assert.equal(ready.sessionId, 'desktop', '桌宠会话必须稳定可寻址，便于完整聊天窗口定位');
    const submit = { channel: 'command', command: { type: 'submit_text', text: '第一次见面在哪里？', clientRequestId: 'retry-fixed-1' } };
    child.stdin.write(JSON.stringify(submit) + '\n');
    await waitFor(message => message.channel === 'event' && message.event?.type === 'reply' && message.event.reply?.scope?.turnId === 'retry-fixed-1');
    child.stdin.write(JSON.stringify(submit) + '\n');
    await waitFor(message => messages.filter(item => item.channel === 'event' && item.event?.type === 'reply' && item.event.reply?.scope?.turnId === 'retry-fixed-1').length >= 2);
    assert.equal(modelCalls, 1, '重试不得再次请求模型，也不得写第二条记录');
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    await exited; clearTimeout(timer);
  }
  const reopened = new FileBookRepository(directory);
  try {
    const turns = reopened.readSession({ characterId: 'aika', pairingId: 'local-user', sessionId: 'desktop' });
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.id, 'retry-fixed-1');
    assert.equal(turns[0]!.user, '第一次见面在哪里？');
  } finally { reopened.close(); }
});

test('session summaries still expose the persona-backed chat scope after entries exist', async t => {
  // Locating the desktop session in the list requires the summary route to coexist with book data.
  const directory = mkdtempSync(join(fixtureRoot(), 'sessions-book-'));
  const repository = new FileBookRepository(directory);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const runtime = new BookRuntime(repository, { async complete() { return '答复'; } });
  const config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: binding('http://127.0.0.1:9999/v1') }, 0, 'model');
  repository.commit({ characterId: 'aika', pairingId: 'local-user', sessionId: 'desktop' }, { upsert: [emptyEntry('core', 'persona', '人格', '温和诚实。')] }, 0, 'seed');
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'desktop' };
  const result = await runtime.chat(scope, '你好', new AbortController().signal);
  assert.equal(result.turn.assistant, '答复');
  const summary = repository.listSessions('aika', 'local-user');
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.sessionId, 'desktop');
  assert.equal(summary[0]!.title, '你好');
  assert.equal(summary[0]!.turnCount, 1);
  assert.equal(summary[0]!.lastTurnId, result.turn.id);
});

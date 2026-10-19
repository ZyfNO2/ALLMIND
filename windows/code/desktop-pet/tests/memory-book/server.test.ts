import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { BookRuntime } from '../../app/book-runtime.js';
import { BookCredentials } from '../../management/book-credentials.js';
import { startBookServer } from '../../management/book-server.js';
import { emptyEntry } from '../../contracts/memory-book.js';
import { createServer, request as httpRequest } from 'node:http';

test('direct browser navigation bootstraps a session without allowing cross-site or unauthenticated API access', async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'browser-session-')), repository = new FileBookRepository(directory);
  const runtime = new BookRuntime(repository, { async complete() { throw Error('no model call'); } });
  const server = await startBookServer({ runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management') });
  t.after(async () => { await server.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = new URL(server.url).origin;
  const document = (headers: Record<string, string>) => new Promise<import('node:http').IncomingMessage>((done, reject) => {
    const request = httpRequest(origin + '/memory-book', { headers }, response => { response.resume(); done(response); });
    request.on('error', reject); request.end();
  });
  const navigation = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none' };
  const page = await document(navigation);
  assert.equal(page.statusCode, 200);
  const cookieHeader = page.headers['set-cookie']?.[0]; assert.ok(cookieHeader);
  assert.match(cookieHeader, /HttpOnly; SameSite=Strict; Path=\/api\/management-session/);
  const cookie = cookieHeader.split(';')[0]!;
  const session = await fetch(origin + '/api/management-session', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(session.status, 200); assert.equal((await session.json()).token, server.token);
  for (const site of ['cross-site', 'same-site']) {
    const crossPage = await document({ ...navigation, 'Sec-Fetch-Site': site });
    assert.equal(crossPage.headers['set-cookie'], undefined);
    assert.equal((await fetch(origin + '/api/management-session', { headers: { Cookie: cookie, 'Sec-Fetch-Site': site } })).status, 403);
  }
  assert.equal((await fetch(origin + '/api/management-session', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
  assert.equal((await fetch(origin + '/api/management-session', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Origin: 'https://outside.invalid' } })).status, 403);
  assert.equal((await fetch(origin + '/api/snapshot', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(origin + '/memory-book')).headers.get('set-cookie'), null);
  assert.equal((await fetch(origin + '/assets/absent.js', { headers: navigation })).headers.get('set-cookie'), null);
});

test('model discovery uses saved or draft keys, normalizes completions endpoints and never commits drafts', async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'models-')), repository = new FileBookRepository(directory), credentials = new BookCredentials(join(directory, 'credentials'));
  credentials.save('model-key', 'saved-fixture-key');
  const keys: string[] = [];
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/v1/models'); keys.push(request.headers.authorization ?? '');
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fixture-a' }, { id: 'fixture-a' }, { id: 'fixture-b' }] }));
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const port = upstream.address(); assert.ok(port && typeof port !== 'string');
  const runtime = new BookRuntime(repository, { async complete() { throw Error('discovery must not call chat'); } });
  const server = await startBookServer({ runtime, credentials, uiRoot: resolve('management') });
  t.after(async () => { await server.close(); await new Promise<void>(done => { upstream.close(() => done()); upstream.closeIdleConnections(); }); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = new URL(server.url).origin, headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const discover = (data: unknown) => fetch(origin + '/api/memory-book/v1/models', { method: 'POST', headers, body: JSON.stringify(data) });
  const baseUrl = `http://127.0.0.1:${port.port}/v1/chat/completions`;
  const saved = await discover({ baseUrl, credentialId: 'model-key', apiKey: '' }); assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { models: ['fixture-a', 'fixture-b'] });
  assert.equal((await discover({ baseUrl, credentialId: 'model-key', apiKey: 'draft-fixture-key' })).status, 200);
  assert.deepEqual(keys, ['Bearer saved-fixture-key', 'Bearer draft-fixture-key']);
  assert.equal(await credentials.get('model-key'), 'saved-fixture-key'); assert.equal(repository.loadConfig().revision, 0);
  assert.equal((await discover({ baseUrl: 'http://example.com/v1', credentialId: 'model-key' })).status, 400);
  assert.equal((await discover({ baseUrl, credentialId: 'model-key', apiKey: 'bad\nkey' })).status, 400);
});

test('authenticated HTTP Book/Inspector/chat use one production service, scoped traces and disabled legacy routes', async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'server-')), repository = new FileBookRepository(directory);
  const runtime = new BookRuntime(repository, { async complete(_binding, messages) { assert.ok(messages.some(item => item.content.includes('机库'))); return '我们在机库第一次见面。'; } });
  const config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'stub', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 } }, 0, 'model');
  const server = await startBookServer({ runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management') });
  t.after(async () => { await server.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = new URL(server.url).origin, auth = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  async function call(route: string, method = 'GET', data?: unknown) { const response = await fetch(origin + '/api/memory-book/v1' + route, { method, headers: auth, ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: response.status, data: await response.json() }; }
  assert.equal((await fetch(origin + '/api/snapshot')).status, 401);
  assert.equal((await fetch(origin + '/api/records', { headers: auth })).status, 410);
  assert.equal((await fetch(origin + '/api/snapshot', { headers: { ...auth, Origin: 'https://outside.invalid' } })).status, 403);
  const entry = emptyEntry('first-meet', 'story', '第一次见面', '我们第一次见面是在机库。');
  assert.equal((await call('/entries', 'PUT', { characterId: 'aika', entry, expectedRevision: 0, operationId: 'seed' })).status, 200);
  assert.equal((await call('/entries', 'PUT', { characterId: 'missing', entry, expectedRevision: 0, operationId: 'bad' })).status, 404);
  const result = await call('/recall/test', 'POST', { characterId: 'aika', sessionId: 'web-chat', query: '第一次见面在哪里？' });
  assert.equal(result.status, 200); assert.ok(result.data.messages.some((message: { content: string }) => message.content.includes('机库')));
  assert.deepEqual((await call('/chat/history?characterId=aika&sessionId=web-chat')).data.turns, []);
  const reply = await call('/chat', 'POST', { characterId: 'aika', sessionId: 'web-chat', text: '第一次见面在哪里？' });
  assert.equal(reply.status, 200); assert.equal(reply.data.turn.assistant, '我们在机库第一次见面。');
  assert.deepEqual(reply.data.context.messages, result.data.messages);
  assert.equal((await call('/recall/traces/' + reply.data.turn.traceId + '?characterId=aika&sessionId=other')).status, 404);
  assert.equal((await call('/recall/traces/' + reply.data.turn.traceId + '?characterId=aika&sessionId=web-chat')).status, 200);
  assert.equal((await fetch(origin + '/memory-book', { headers: auth })).status, 200);
  assert.equal((await fetch(origin + '/assets/../../package.json', { headers: auth })).status, 404);
});

test('removing a role cancels its in-flight provider work before settings acknowledge success', async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'remove-role-')), repository = new FileBookRepository(directory);
  const config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'stub', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 } }, 0, 'model');
  let entered!: () => void; const started = new Promise<void>(done => { entered = done; }); let providerSignal: AbortSignal | undefined;
  const runtime = new BookRuntime(repository, { async complete(_binding, _messages, signal) {
    providerSignal = signal; entered(); return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const server = await startBookServer({ runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management') });
  t.after(async () => { runtime.invalidate('aika'); await server.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = new URL(server.url).origin, headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const pending = fetch(origin + '/api/memory-book/v1/chat', { method: 'POST', headers, body: JSON.stringify({ characterId: 'aika', sessionId: 'remove-test', text: '你好' }) });
  await started;
  const before = repository.loadConfig();
  const response = await fetch(origin + '/api/memory-book/v1/runtime', { method: 'PUT', headers, body: JSON.stringify({ config: { ...before, currentCharacterId: 'role-b', characters: [{ id: 'role-b', name: 'B', intro: '', appearancePath: null }] }, expectedRevision: before.revision, operationId: 'remove-role' }) });
  assert.equal(response.status, 200); assert.equal(providerSignal!.aborted, true);
  assert.equal((await pending).status, 409);
  assert.equal(repository.readSession({ characterId: 'aika', pairingId: 'local-user', sessionId: 'remove-test' }).length, 0);
});

test('timed out chat returns a clear recoverable error, saves no turn and freezes the failed identity for a new-turn retry', async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'chat-timeout-')), repository = new FileBookRepository(directory);
  let calls = 0;
  const runtime = new BookRuntime(repository, { async complete() {
    calls++;
    if (calls === 1) { const error = new Error('provider timeout'); error.name = 'TimeoutError'; throw error; }
    return '重试成功。';
  } });
  const config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'stub', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 } }, 0, 'model');
  const server = await startBookServer({ runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management') });
  t.after(async () => { await server.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = new URL(server.url).origin, headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'timeout-retry' };
  const send = (turnId = 'timeout-retry-turn') => fetch(origin + '/api/memory-book/v1/chat', { method: 'POST', headers, body: JSON.stringify({ ...scope, text: '继续吗？', turnId }) });
  const failed = await send(); assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: { code: 'timeout', message: '请求超过时限已停止；未自动重试。确认服务状态后可手动重试。' } });
  assert.equal(repository.readSession(scope).length, 0);
  // P0 4.2-1: a timeout is terminal for that turn identity; the same id may not recompile or resubmit.
  assert.equal(repository.readTurnFreeze(scope, 'timeout-retry-turn')?.state, 'timeout');
  const retried = await send(); assert.equal(retried.status, 409);
  assert.match(((await retried.json()) as { error: { message: string } }).error.message, /冻结/);
  assert.equal(calls, 1, '同一超时 turnId 不得再次调用模型');
  // The UI's explicit manual retry starts a NEW turn; that first successful submission persists once.
  const fresh = await send('timeout-retry-turn-2'); assert.equal(fresh.status, 200); assert.equal(((await fresh.json()) as { turn: { assistant: string } }).turn.assistant, '重试成功。');
  assert.equal(calls, 2); assert.equal(repository.readSession(scope).length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatgptExtensionHost } from '../../providers/chatgpt-extension-host.js';
import { ChatgptBackgroundBridge } from '../../providers/chatgpt-background-bridge.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../contracts/memory-book.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';

const origin = 'chrome-extension://' + 'a'.repeat(32);
test('extension bridge: rejects web origins, missing auth and malformed actions; binds loopback', async () => {
  const host = new ChatgptExtensionHost({ port: 0 });
  try {
    const pair = await host.pairing(); assert.match(pair.url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal((await fetch(pair.url + '/pull', { method: 'POST', headers: { Origin: 'https://chatgpt.com', Authorization: 'Bearer ' + pair.code }, body: '{}' })).status, 403);
    assert.equal((await fetch(pair.url + '/pull', { method: 'POST', headers: { Origin: origin }, body: '{}' })).status, 401);
    await assert.rejects(host.execute('eval', { text: 'process.exit()' }), /未知/);
    await assert.rejects(host.execute('write', { text: 'x'.repeat(3001) }), /过长/);
    await assert.rejects(host.execute('probe', {}), /尚未配对/);
  } finally { await host.close(); }
});

test('extension bridge: actual HTTP relay preserves prompts, model, temporary mode and never calls CLI', async () => {
  const host = new ChatgptExtensionHost({ port: 0, timeoutMs: 1000 });
  const pair = await host.pairing(); const controller = new AbortController(); const calls: any[] = [];
  const post = (path: string, body: object) => fetch(pair.url + path, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + pair.code }, body: JSON.stringify({ client: 'test-extension', ...body }), signal: controller.signal });
  let ready!: () => void; const connected = new Promise<void>(resolve => { ready = resolve; });
  const relay = (async () => {
    try {
      let response = post('/pull', {}); await new Promise(resolve => setTimeout(resolve, 20)); ready();
      for (;;) {
        const command = await (await response).json() as any;
        if (command.idle) { response = post('/pull', {}); continue; }
        calls.push(command);
        const value = command.action === 'probe' ? { ready: true, temporary: true, hasTurns: false }
          : command.action === 'prepare' ? { ready: true, temporary: true }
          : command.action === 'model' ? { model: command.input.model }
          : command.action === 'submit' ? { submitted: true }
          : command.action === 'read' ? { state: 'completed', text: '桥接回复', conversationId: 'fixture' } : { ok: true };
        assert.equal((await post('/result', { id: command.id, value })).status, 200);
        response = post('/pull', {});
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  try {
    await connected;
    const bridge = new ChatgptBackgroundBridge({ config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE }), pageHost: host, runner: async () => { throw new Error('CLI must never run'); }, intervalMs: 0, pollMs: 1 });
    const result = await bridge.ask({ requestId: 'bridge-reply', prompt: '问题', context: '设定\n召回事实\n历史', temporary: true, model: 'GPT-6', timeoutMs: 5000 });
    assert.equal(result.kind, 'completed');
    assert.equal(calls.filter(call => call.action === 'submit').length, 1);
    assert.equal(calls.find(call => call.action === 'model').input.model, 'GPT-6');
    assert.equal(calls.find(call => call.action === 'write').input.text, '设定\n召回事实\n历史\n\n[当前任务]\n问题');
    assert.equal((await bridge.ask({ requestId: 'bridge-reply', prompt: '重复', timeoutMs: 5000 })).kind, 'failed');
    assert.equal(calls.filter(call => call.action === 'submit').length, 1);
  } finally { controller.abort(); await relay; await host.close(); }
});

test('extension bridge: lost submit receipt times out without replay; stale replies rejected', async () => {
  const host = new ChatgptExtensionHost({ port: 0, timeoutMs: 100 });
  const pair = await host.pairing();
  const post = (path: string, body: object) => fetch(pair.url + path, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + pair.code }, body: JSON.stringify({ client: 'extension', ...body }) });
  try {
    const pull = post('/pull', {}); await new Promise(resolve => setTimeout(resolve, 15));
    const command = host.execute('submit', { id: 'turn-1' });
    const rejection = assert.rejects(command, /不自动重放/);
    const delivered = await (await pull).json() as any; assert.equal(delivered.action, 'submit');
    await rejection;
    assert.equal((await post('/result', { id: delivered.id, value: { submitted: true } })).status, 409);
    const probe = host.execute('probe', {}); const probeRejection = assert.rejects(probe, /不自动重放/);
    const next = await (await post('/pull', {})).json() as any; assert.equal(next.action, 'probe');
    await probeRejection;
  } finally { await host.close(); }
});

test('extension bridge: selected browser stays pinned across restart; reset explicitly permits a different browser', async () => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const keyPath = join(mkdtempSync(join(root, 'bridge-key-')), 'local-key');
  let host = new ChatgptExtensionHost({ port: 0, keyPath });
  let pair = await host.pairing();
  const post = (client: string) => fetch(pair.url + '/result', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + pair.code }, body: JSON.stringify({ client, id: 'stale', value: {} }) });
  try {
    assert.equal((await post('browser-A')).status, 409);
    await host.close(); host = new ChatgptExtensionHost({ port: 0, keyPath }); pair = await host.pairing();
    const wrong = await post('browser-B'); assert.equal(wrong.status, 409); assert.deepEqual(await wrong.json(), { error: 'another_extension' });
    const oldCode = pair.code; pair = await host.resetPairing(); assert.notEqual(pair.code, oldCode);
    const changed = await post('browser-B'); assert.equal(changed.status, 409); assert.deepEqual(await changed.json(), { error: 'stale_command' });
    await host.close(); host = new ChatgptExtensionHost({ port: 0, keyPath }); pair = await host.pairing();
    assert.deepEqual(await (await post('browser-A')).json(), { error: 'another_extension' });
  } finally { await host.close(); }
});

test('extension bridge: an already paired cold backend waits for reconnect without resetting its binding', async () => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const keyPath = join(mkdtempSync(join(root, 'bridge-reconnect-')), 'local-key');
  let host = new ChatgptExtensionHost({ port: 0, keyPath, reconnectMs: 1000 });
  let pair = await host.pairing();
  const post = (path: string, body: object) => fetch(pair.url + path, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + pair.code }, body: JSON.stringify(body) });
  try {
    await post('/result', { client: 'paired-browser', id: 'stale', value: {} });
    await host.close(); host = new ChatgptExtensionHost({ port: 0, keyPath, reconnectMs: 1000 }); pair = await host.pairing();
    assert.equal(pair.connected, false);
    const pending = host.execute('probe', {});
    await new Promise(resolve => setTimeout(resolve, 40));
    const command = await (await post('/pull', { client: 'paired-browser' })).json() as any;
    assert.equal(command.action, 'probe');
    await post('/result', { client: 'paired-browser', id: command.id, value: { ready: true } });
    assert.deepEqual(await pending, { ready: true });
    assert.equal((await host.pairing()).connected, true);
  } finally { await host.close(); }
});

test('extension bridge: fallback requires explicit CLI selection and never touches the extension host', async () => {
  let cliCalls = 0;
  const bridge = new ChatgptBackgroundBridge({ config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'cli', profile: 'explicit-profile' }),
    pageHost: { execute: async () => { throw new Error('Wrong transport'); }, navigate: async () => { throw new Error('Wrong transport'); }, login: async () => { throw new Error('Wrong transport'); } },
    runner: async () => { cliCalls++; return { exitCode: 0, stdout: JSON.stringify({ ready: true }), stderr: '', timedOut: false }; } });
  assert.equal((await bridge.probe()).state, 'signed-in'); assert.equal(cliCalls, 1);
});

test('extension bridge: a missing host must not silently activate CLI', async () => {
  let cliCalls = 0;
  const bridge = new ChatgptBackgroundBridge({ config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE }), runner: async () => { cliCalls++; throw new Error('CLI should not start'); } });
  const result = await bridge.probe();
  assert.equal(result.state, 'not-connected');
  assert.equal(cliCalls, 0);
  assert.match(result.detail!, /未装配/);
});

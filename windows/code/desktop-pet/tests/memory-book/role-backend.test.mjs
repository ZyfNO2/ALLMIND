import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { BUILT_IN_SKIN_ID } from '../../dist/management/skin-store.js';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../dist/contracts/memory-book.js';

test('formal file backend applies each selected role appearance and supports native picker replies', { timeout: 20000 }, async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'role-backend-'));
  // This test does not use ChatGPT: do not bind the real user's fixed extension port.
  const seed = new FileBookRepository(directory), configSeed = seed.loadConfig();
  seed.commitConfig({ ...configSeed, chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded' } }, 0, 'isolated-transport'); seed.close();
  const child = spawn(process.execPath, ['dist/app/book-backend.js'], { env: { ...process.env, AIKI_BOOK_DATA: directory, AIKI_BOOK_WEB_ONLY: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = []; let raw = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { raw += chunk; let end; while ((end = raw.indexOf('\n')) >= 0) { messages.push(JSON.parse(raw.slice(0, end))); raw = raw.slice(end + 1); } });
  const exited = new Promise(done => child.once('exit', code => done(code)));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill(), 3000); await exited; clearTimeout(timer); rmSync(directory, { recursive: true, force: true }); });
  async function waitFor(predicate) { for (let i = 0; i < 150; i++) { const item = messages.find(predicate); if (item) return item; if (child.exitCode !== null) throw Error(stderr); await new Promise(done => setTimeout(done, 40)); } throw Error('Backend message timeout: ' + stderr); }
  await waitFor(message => message.channel === 'appearance');
  const firstLife = await waitFor(message => message.channel === 'companion_state');
  assert.equal(firstLife.state.characterId, 'aika');
  child.stdin.write(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: '隔离无模型测试', clientRequestId: 'no-model-turn' } }) + '\n');
  const unavailable = await waitFor(message => message.channel === 'event' && message.event.type === 'error' && message.event.scope?.turnId === 'no-model-turn');
  assert.match(unavailable.event.message, /绑定文字主模型/);
  await waitFor(message => message.channel === 'companion_state' && message.sequence > firstLife.sequence);
  child.stdin.write(JSON.stringify({ channel: 'companion_action', characterId: 'aika', pairingId: 'local-user', action: 'touch' }) + '\n');
  await waitFor(message => message.channel === 'companion_state' && message.state.mood > firstLife.state.mood + 10);
  const session = JSON.parse(readFileSync(join(directory, 'management-session.json'), 'utf8')), url = new URL(session.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function call(path, method = 'GET', data) { const response = await fetch(url.origin + '/api/memory-book/v1' + path, { method, headers, ...(data ? { body: JSON.stringify(data) } : {}) }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); }
  const { config } = await call('/runtime');
  const next = { ...config, currentCharacterId: 'role-test', characters: [...config.characters, { id: 'role-test', name: '正式新角色', intro: '新角色简介', appearancePath: null, appearanceSkinId: BUILT_IN_SKIN_ID }] };
  const result = await call('/runtime', 'PUT', { config: next, expectedRevision: config.revision, operationId: 'add-role' });
  assert.equal(result.activationError, null);
  const ready = await waitFor(message => message.channel === 'backend_ready' && message.characterId === 'role-test');
  assert.equal(ready.characterLabel, '正式新角色');
  const otherLife = await waitFor(message => message.channel === 'companion_state' && message.state.characterId === 'role-test');
  assert.equal(otherLife.state.mood, 50, 'new role cannot inherit the previous role mood');
  assert.ok(messages.slice(messages.indexOf(ready) + 1).some(message => message.channel === 'appearance' && message.manifest.skinId === BUILT_IN_SKIN_ID));
  const picking = call('/appearance/select', 'POST', { characterId: 'role-test', selectionKind: 'model-entry' });
  const request = await waitFor(message => message.channel === 'host_request');
  assert.equal(request.method, 'resource-picker.select'); assert.equal(request.params.characterId, 'role-test');
  child.stdin.write(JSON.stringify({ channel: 'host_reply', requestId: request.requestId, ok: true, result: { outcome: 'cancelled' } }) + '\n');
  assert.equal((await picking).outcome, 'cancelled');
  const restored = { ...result.config, currentCharacterId: 'aika', characters: config.characters };
  assert.equal((await call('/runtime', 'PUT', { config: restored, expectedRevision: restored.revision, operationId: 'delete-role' })).activationError, null);
  assert.equal((await call('/runtime')).config.characters.length, 1);
});

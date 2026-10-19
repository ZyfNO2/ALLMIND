import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { emptyEntry, DEFAULT_CHATGPT_WEB_SOURCE } from '../../dist/contracts/memory-book.js';

const run = (args, env) => new Promise((done, reject) => {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const deadline = setTimeout(() => { child.kill(); reject(Error('Integration deadline exceeded')); }, 90000);
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.once('error', error => { clearTimeout(deadline); reject(error); });
  child.once('exit', code => { clearTimeout(deadline); done({ code, stdout, stderr }); });
});

test('default desktop launcher renders actual appearance and completes two turns through file backend', { timeout: 100000 }, async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'electron-')), received = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw); received.push(payload.messages);
      const prompt = JSON.stringify(payload.messages);
      assert.ok(prompt.includes('温和诚实')); assert.ok(prompt.includes(received.length === 1 ? '测试机库' : '结构检测'));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: received.length === 1 ? '作者故事里，第一次见面是在测试机库。' : 'Alice 负责结构检测。' } }] }));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise(done => server.close(done)); rmSync(directory, { recursive: true, force: true }); });
  const repository = new FileBookRepository(directory), config = repository.loadConfig();
  repository.commitConfig({ ...config, chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded' }, mainModel: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'electron-protocol-stub', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 } }, 0, 'model');
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'seed' };
  repository.commit(scope, { upsert: [emptyEntry('core', 'persona', '人格', '温和诚实，不编造共同经历。'), emptyEntry('episode', 'story', '第一次见面', '我们第一次见面是在测试机库。'), emptyEntry('alice', 'wiki', 'Alice', 'Alice 是搭档，负责结构检测。')] }, 0, 'seed');
  repository.close();
  const evidence = resolve('../../../validation/output/allmind-companion-v2/evidence/dialogue'); mkdirSync(evidence, { recursive: true });
  const result = await run(['dist/app/book-launcher.js', '--book-smoke-test', '--screenshot', join(evidence, 'desktop.png')], { AIKI_BOOK_DATA: directory });
  writeFileSync(join(evidence, 'smoke.json'), JSON.stringify({ ...result, prompts: received, externalModel: 'HTTP protocol stub' }, null, 2));
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /MEMORY_BOOK_ELECTRON_OK/);
  assert.match(result.stdout, /TRAY_CLOSE_RESTORE_OK/, 'native close hides and tray restores without destroying the window');
  assert.equal(received.length, 2);
  const reopened = new FileBookRepository(directory);
  try { assert.equal(reopened.loadConfig().mainModel.model, 'electron-protocol-stub'); } finally { reopened.close(); }
});

test('production root starts with legacy/native resolution explicitly blocked', { timeout: 30000 }, async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'no-native-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = new FileBookRepository(directory), seedConfig = seed.loadConfig();
  seed.commitConfig({ ...seedConfig, chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded' } }, 0, 'isolated-transport'); seed.close();
  const script = `import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier, context, next){ if (/better-sqlite3|sherpa-onnx|silk-wasm|\\.node$/.test(specifier)) throw Error('Forbidden legacy/native dependency: '+specifier); return next(specifier,context); }});
    const {runBookBackend}=await import('./dist/app/book-backend.js');
    const instance=await runBookBackend(process.env.AIKI_BOOK_DATA);
    if(instance.runtime.repository.loadConfig().schemaVersion!=='memory-runtime/v1') throw Error('Runtime not loaded');
    await instance.close(); console.log('NO_LEGACY_NATIVE_OK');`;
  const result = await run(['--input-type=module', '-e', script], { AIKI_BOOK_DATA: directory, AIKI_BOOK_WEB_ONLY: '1' });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /NO_LEGACY_NATIVE_OK/);
});

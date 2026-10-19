import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, cpSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { ChatgptExtensionHost } from '../../dist/providers/chatgpt-extension-host.js';
import { ChatgptBackgroundBridge } from '../../dist/providers/chatgpt-background-bridge.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../dist/contracts/memory-book.js';

test('production MV3 extension → real local bridge → browser-owned send/read; no focus switch or debugger', { timeout: 90000 }, async t => {
  const sourceExtension = resolve('desktop/chatgpt-extension');
  const manifest = JSON.parse(readFileSync(join(sourceExtension, 'manifest.json'), 'utf8'));
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.ok(!manifest.permissions.includes('nativeMessaging'));
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const profile = mkdtempSync(join(root, 'bridge-browser-'));
  const host = new ChatgptExtensionHost({ port: 0 });
  let context;
  t.after(async () => { await context?.close(); await host.close(); });
  const pairing = await host.pairing();
  // Isolate only the local endpoint from the running user service; all relay/page logic
  // is copied byte-for-byte from the generated production extension.
  const extension = join(profile, 'test-extension'); cpSync(sourceExtension, extension, { recursive: true });
  manifest.host_permissions = manifest.host_permissions.map(permission => permission === 'http://127.0.0.1:17643/*' ? pairing.url + '/*' : permission);
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(extension, 'background.mjs'), readFileSync(join(extension, 'background.mjs'), 'utf8').replace('http://127.0.0.1:17643', pairing.url));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  let sends = 0; let prompt = '';
  let account = 'fixture-account-A';
  let sessionFailures = 0;
  let sessionStatus = 503;
  let pageLoads = 0;
  await context.route('https://chatgpt.com/**', async route => {
    if (route.request().url().endsWith('/api/auth/session')) {
      if (sessionFailures > 0) { sessionFailures--; await route.fulfill({ status: sessionStatus, contentType: 'application/json', body: '{}' }); return; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: account }, accessToken: 'fixture-token-never-export' }) }); return;
    }
    if (route.request().url().includes('/backend-api/f/conversation')) {
      sends++; const data = route.request().postDataJSON();
      assert.equal(data.history_and_training_disabled, true);
      prompt = data.messages[0].content.parts.join('');
      const message = { id: 'a-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['来自生产扩展的回答'] }, status: 'finished_successfully', end_turn: true, channel: 'final' };
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ conversation_id: 'fixture-c', message }) + '\n\ndata: [DONE]\n\n' }); return;
    }
    pageLoads++;
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><button aria-label="Turn off temporary chat">临时聊天</button><textarea id="prompt-textarea"></textarea><button data-testid="send-button">发送</button><script>document.querySelector("[data-testid=send-button]").onclick=async()=>{await fetch("/backend-api/f/conversation",{method:"POST",body:JSON.stringify({history_and_training_disabled:true,messages:[{id:"u-1",author:{role:"user"},content:{content_type:"text",parts:[document.querySelector("textarea").value]}}]})});};</script>' });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  let options = await context.newPage(); await options.goto('chrome-extension://' + id + '/options.html');
  await options.locator('#code').fill(pairing.code);
  await options.locator('#pair').click();
  await options.getByText('已配对，回到 AIKI 检查连接。', { exact: true }).waitFor();
  await options.waitForTimeout(300);
  assert.equal(await options.evaluate(() => document.hasFocus()), true);
  const before = context.pages().length;
  const bridge = new ChatgptBackgroundBridge({ config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE }), pageHost: host, runner: async () => { throw new Error('No CLI allowed'); }, intervalMs: 0, pollMs: 100 });
  const pinned = await worker.evaluate(async () => (await chrome.storage.local.get('account')).account);
  await worker.evaluate(() => chrome.storage.local.remove('account'));
  sessionFailures = 2;
  const result = await bridge.ask({ requestId: 'browser-real-extension', prompt: '问题', context: '角色设定\n召回内容\n历史', temporary: true, model: 'current', timeoutMs: 15000 });
  assert.equal(result.kind, 'completed', JSON.stringify(result));
  assert.equal(result.text, '来自生产扩展的回答');
  assert.equal(prompt, '角色设定\n召回内容\n历史\n\n[当前任务]\n问题');
  assert.equal(sends, 1);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('account')).account), pinned, 'Legacy paired storage migrates a verified identity without changing browser binding');
  assert.equal(context.pages().length, before);
  assert.equal(await options.evaluate(() => document.hasFocus()), true, 'The background ChatGPT tab must not gain focus');
  account = 'fixture-account-B';
  const changed = await bridge.ask({ requestId: 'browser-changed-account', prompt: '不得换号', temporary: true, timeoutMs: 5000 });
  assert.equal(changed.kind, 'failed'); assert.equal(changed.submitted, 'no');
  assert.match(changed.message, /已确认.*账号.*不同/); assert.equal(sends, 1);
  const target = context.pages().find(page => page.url().startsWith('https://chatgpt.com/'));
  await target.close();
  const lost = await bridge.ask({ requestId: 'browser-closed-tab', prompt: '不得重发', temporary: true, timeoutMs: 5000 });
  assert.equal(lost.kind, 'failed'); assert.equal(lost.submitted, 'no');
  assert.match(lost.message, /已确认.*账号.*不同/);
  assert.equal(sends, 1); assert.equal(context.pages().length, before, 'Pre-submit recovery creates one background tab but still enforces the account pin');
  account = 'fixture-account-A';
  await context.pages().find(page => page.url().startsWith('https://chatgpt.com/')).close();
  const recovered = await bridge.ask({ requestId: 'browser-recovered-tab', prompt: '安全恢复', temporary: true, model: 'current', timeoutMs: 15000 });
  assert.equal(recovered.kind, 'completed', JSON.stringify(recovered)); assert.equal(sends, 2);
  assert.equal(context.pages().length, before);
  assert.equal(await options.evaluate(() => document.hasFocus()), true, 'Recovered background tab must not gain focus');
  // Chrome boundary fixture: emit the exact missing-receiver error observed after
  // the user's extension refresh. Recovery navigation/content scripts remain real.
  const beforeReloadLoads = pageLoads;
  await worker.evaluate(() => {
    const original = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = (...args) => {
      chrome.tabs.sendMessage = original;
      return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    };
  });
  const restoredScripts = await bridge.ask({ requestId: 'browser-extension-reload', prompt: '刷新扩展后恢复', temporary: true, model: 'current', timeoutMs: 15000 });
  assert.equal(restoredScripts.kind, 'completed', JSON.stringify(restoredScripts)); assert.equal(sends, 3);
  assert.equal(pageLoads, beforeReloadLoads + 1, 'A missing receiver triggers exactly one real owned-tab reload before submit');
  sessionStatus = 401; sessionFailures = 1;
  const unavailable = await bridge.ask({ requestId: 'browser-session-unavailable', prompt: '不得误报换号', temporary: true, timeoutMs: 5000 });
  assert.equal(unavailable.kind, 'failed'); assert.equal(unavailable.submitted, 'no');
  assert.match(unavailable.message, /登录状态接口 HTTP 401/); assert.doesNotMatch(unavailable.message, /账号.*不同|重新配对/);
  assert.equal(sends, 3);
});

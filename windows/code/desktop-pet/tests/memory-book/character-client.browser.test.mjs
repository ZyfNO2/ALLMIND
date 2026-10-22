async function selectSession(page,id){await page.getByRole('button',{name:'切换会话',exact:true}).click();await page.getByLabel('搜索会话',{exact:true}).fill(id);await page.getByRole('dialog',{name:'会话记录',exact:true}).locator('.mb-session-option').click()}
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { BookRuntime } from '../../dist/app/book-runtime.js';
import { BookHttpModel } from '../../dist/providers/book-model.js';
import { BookCredentials } from '../../dist/management/book-credentials.js';
import { startBookServer } from '../../dist/management/book-server.js';

test('character client preserves failed input, freezes the failed identity, restores sessions, and tests draft models honestly', { timeout: 90000 }, async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'client-')), repository = new FileBookRepository(directory), credentials = new BookCredentials(join(directory, 'credentials'));
  const modelRequests = [], submitted = [], errors = []; let nextFault = null;
  const upstream = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw); modelRequests.push({ payload, auth: request.headers.authorization });
    const fault = nextFault; nextFault = null;
    if (fault === 'hold') return;
    if (fault === 'fail') { response.writeHead(503); response.end('external fixture unavailable'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '真实链路测试回答。'.repeat(20) } }] }));
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const binding = { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'client-http-fixture', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 };
  const config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: binding }, 0, 'seed');
  const runtime = new BookRuntime(repository, new BookHttpModel(id => credentials.get(id)));
  const server = await startBookServer({ runtime, credentials, uiRoot: resolve('management') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/memory-book/v1/chat') && request.method() === 'POST') submitted.push(request.postDataJSON()); });
  await page.goto(server.url); await page.getByRole('button', { name: '开始新话题', exact: true }).waitFor();
  const input = page.getByLabel('聊天消息', { exact: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 }); await input.fill('');
    await page.evaluate(() => {
      window.composerTops = [];
      window.composerSampler = setInterval(() => window.composerTops.push(document.querySelector('.mb-composer textarea').getBoundingClientRect().top), 16);
    });
    await input.pressSequentially('测试，看看最近的情况', { delay: 200 });
    await page.waitForFunction(() => document.querySelector('.mb-chat-setup-hint') === null && document.querySelector('.mb-style-preview')?.textContent.includes('发送前：'));
    assert.equal(await page.locator('.mb-style-preview').count(),1,'bound model retains policy preview in reserved space');
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const tops = await page.evaluate(() => { clearInterval(window.composerSampler); return window.composerTops; });
    assert.ok(tops.length > 10);
    assert.ok(Math.max(...tops) - Math.min(...tops) < 1, `${width}px typing must not move the composer: ${Math.min(...tops)}..${Math.max(...tops)}`);
  }
  await page.setViewportSize({ width: 1440, height: 950 }); await input.fill('未发送的草稿');
  await input.press('Shift+Enter'); assert.ok((await input.inputValue()).includes('\n'));
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true }); assert.equal(modelRequests.length, 0, 'IME composition must not send');
  nextFault = 'fail'; await input.fill('失败后仍保留这句话'); await input.press('Enter');
  await page.getByRole('button', { name: '核对原请求结果（不重发）', exact: true }).waitFor(); assert.equal(await input.inputValue(), '失败后仍保留这句话');
  assert.equal(repository.readSession(runtime.scope('aika', 'web-chat')).length, 0);
  // P0 4.2-1: a provider failure is terminal for that turnId. The durable freeze marker makes the
  // explicit retry a NEW turn instead of recompiling/resubmitting the failed identity.
  const failedTurnId = submitted[0].turnId, failedScope = runtime.scope('aika', 'web-chat');
  assert.equal(runtime.repository.readTurnFreeze(failedScope, failedTurnId)?.state, 'failed');
  await assert.rejects(runtime.chat(failedScope, '失败后仍保留这句话', new AbortController().signal, { turnId: failedTurnId }), { code: 'conflict' });
  await page.getByRole('button', { name: '核对原请求结果（不重发）', exact: true }).click();await page.getByLabel('我已核对来源，理解重新请求可能重复生成或计费',{exact:true}).check();await page.getByRole('button',{name:'明确准备新请求',exact:true}).click();await page.getByRole('button',{name:'发送',exact:true}).click(); await page.waitForFunction(() => document.querySelector('textarea[aria-label="聊天消息"]').value === '');
  assert.equal(submitted.length, 2, '失败后只有用户显式重试才发第二次');
  assert.notEqual(submitted[1].turnId, failedTurnId, '已失败轮次冻结；重试必须是新的一轮编号');
  assert.equal(repository.readSession(runtime.scope('aika', 'web-chat')).length, 1, '只有成功的新轮次落库');
  const evidence = resolve('../../../validation/output/ui-rework-evidence/character-client'); mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, 'chat.png'), fullPage: true });
  await page.getByRole('button', { name: '查看引用的记忆 →', exact: true }).click(); await page.getByRole('dialog').getByRole('heading', { name: '为什么想起这些？' }).waitFor();
  assert.equal(await page.getByRole('dialog').isVisible(), true); await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').isVisible(), false);
  await input.fill('第一个会话草稿'); await page.getByRole('button', { name: '开始新话题', exact: true }).click(); await page.waitForFunction(() => (document.querySelector('textarea[aria-label="聊天消息"]') && !document.querySelector('textarea[aria-label="聊天消息"]').disabled));
  assert.equal(await input.inputValue(), ''); await input.fill('第二个会话的一轮'); await page.getByRole('button', { name: '发送', exact: true }).click(); await page.waitForFunction(() => document.querySelector('textarea[aria-label="聊天消息"]').value === '');
  const secondSession = submitted.at(-1).sessionId; assert.notEqual(secondSession, 'web-chat');
  await selectSession(page,'web-chat');
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="聊天消息"]').value === '第一个会话草稿');
  await selectSession(page,secondSession);
  await page.waitForFunction(() => (document.querySelector('textarea[aria-label="聊天消息"]') && !document.querySelector('textarea[aria-label="聊天消息"]').disabled) && document.querySelector('textarea[aria-label="聊天消息"]').value === '');
  await page.reload(); await input.waitFor(); await page.waitForFunction(() => (document.querySelector('textarea[aria-label="聊天消息"]') && !document.querySelector('textarea[aria-label="聊天消息"]').disabled));
  assert.equal(new URL(page.url()).searchParams.get('sessionId'), secondSession); assert.ok(await page.locator('.mb-user').innerText().then(text => text.includes('第二个会话')));
  await selectSession(page,'web-chat'); await page.waitForFunction(() => (document.querySelector('textarea[aria-label="聊天消息"]') && !document.querySelector('textarea[aria-label="聊天消息"]').disabled));
  // Ordinary drafts and committed records both survive a page reload; private drafts never persist.
  assert.equal(await input.inputValue(),'第一个会话草稿');
  await input.fill('取消后保留'); nextFault = 'hold'; await page.getByRole('button', { name: '发送', exact: true }).click(); await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByText('本地等待已停止，输入与请求编号已保留；请先核对原请求结果。', { exact: true }).waitFor(); assert.equal(await input.inputValue(), '取消后保留'); assert.equal(repository.readSession(runtime.scope('aika', 'web-chat')).length, 1);
  await input.fill(''); await page.getByRole('link', { name: '设置', exact: true }).click();

  const card = page.locator('.mb-model-card').filter({ has: page.getByRole('heading', { name: '文字主模型', exact: true }) });
  await card.getByLabel('API Key', { exact: true }).fill('temporary-draft-key'); await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await card.getByText('测试成功', { exact: true }).waitFor(); assert.equal(modelRequests.at(-1).auth, 'Bearer temporary-draft-key'); assert.equal(modelRequests.at(-1).payload.messages.length, 1);
  assert.equal(repository.loadConfig().revision, 1); assert.equal(await credentials.get('local-no-auth'), ''); assert.equal(repository.readSession(runtime.scope('aika', 'web-chat')).length, 1);
  nextFault = 'fail'; await card.getByRole('button', { name: '测试连接', exact: true }).click(); await card.getByText('测试失败', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'model-settings.png'), fullPage: true });
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('link', { name: '首页', exact: true }).click(); assert.ok(page.url().includes('/settings')); assert.equal(await card.getByLabel('API Key', { exact: true }).inputValue(), 'temporary-draft-key');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('link', { name: '首页', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(evidence, 'chat-narrow.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'narrow UI must not overflow horizontally');
  assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isVisible(), true);
  runtime.invalidate('aika'); await page.getByRole('button', { name: '查看引用的记忆 →', exact: true }).click(); await page.getByText('详细记录已过期，历史回答仍然保留。', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

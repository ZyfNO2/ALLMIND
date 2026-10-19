import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

test('pet composer sends the per-turn style and renders the frozen decision from real receipts', { timeout: 30000 }, async t => {
  const root = resolve('desktop');
  const server = createServer(async (request, response) => {
    const path = resolve(root, '.' + new URL(request.url, 'http://127.0.0.1').pathname);
    if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    try { const data = await readFile(path); response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream'); response.end(data); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 950 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.hostMessages = []; window.desktopHost = { postMessage(name, value) { window.hostMessages.push({ name, value }); }, subscribe() {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => !!window.petBridge);
  await page.evaluate(() => { window.petBridge.connectionChanged({ generation: 1, state: 'connecting' }); window.petBridge.receive({ channel: 'backend_ready', bridgeVersion: '0.8.0', characterId: 'aika', characterLabel: '验收角色', sessionId: 'desktop', productMode: 'memory-book' }, 1); });
  await page.locator('#model').click({button:'right'});
  const select = page.locator('#reply-style');
  await select.waitFor();
  assert.equal(await select.inputValue(), 'inherit');
  // per-turn selection travels on the real submit_text command and the pending turn locks the control
  await select.selectOption('short');
  await page.locator('#text').fill('你好'); await page.locator('#form').evaluate(form => form.requestSubmit());
  const command = await page.evaluate(() => window.hostMessages.findLast(message => message.value?.message?.command?.type === 'submit_text').value.message.command);
  assert.equal(command.replyStyle, 'short');
  assert.equal(await select.isDisabled(), true, '在途请求期间禁止修改本轮选择');
  const scope = { characterId: 'aika', sessionId: 'desktop', turnId: command.clientRequestId, generation: 1 };
  await page.evaluate(scope => window.petBridge.receive({ channel: 'book_turn_state', clientRequestId: scope.turnId, scope, state: 'completed', attachmentCount:2, text: '在的。', replyStyleDecision: { version: 1, requestedStyle: 'short', selectedStyle: 'short', source: 'turn', intent: null, certainty: 'matched', ruleIds: ['turn-selection-v1'], targetChars: 50, effectiveRange: { minChars: null, maxChars: null }, constrained: false, requestConflict: false } }, 1), scope);
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('本轮风格：简短'));
  await page.getByRole('button',{name:'本轮 2 个文件 · 打开完整聊天',exact:true}).click();
  const filesPath=await page.evaluate(()=>window.hostMessages.findLast(row=>row.name==='shell'&&row.value?.type==='open_management')?.value.path);
  const filesQuery=new URL(filesPath,'http://127.0.0.1').searchParams;
  assert.equal(filesQuery.get('sessionId'),scope.sessionId);assert.equal(filesQuery.get('messageId'),scope.turnId);
  assert.equal(await select.inputValue(), 'inherit', '成功交付后恢复沿用设置');
  assert.equal(await select.isDisabled(), false);
  // a failed turn keeps the selection for an explicit retry
  await select.selectOption('detailed');
  await page.locator('#text').fill('再试一次'); await page.locator('#form').evaluate(form => form.requestSubmit());
  const failedId = await page.evaluate(() => window.hostMessages.findLast(message => message.value?.message?.command?.type === 'submit_text').value.message.command.clientRequestId);
  await page.evaluate(id => window.petBridge.receive({ channel: 'book_turn_state', clientRequestId: id, scope: { characterId: 'aika', sessionId: 'desktop', turnId: id, generation: 1 }, state: 'failed', message: '本轮未完成。' }, 1), failedId);
  await page.waitForFunction(() => (document.getElementById('speech-bubble-text')?.textContent ?? '').includes('本轮未完成'));
  assert.equal(await select.inputValue(), 'detailed', '失败保留本轮选择');
  assert.equal(await page.locator('#text').inputValue(),'再试一次','失败回执恢复输入');
  const countBefore=await page.evaluate(()=>window.hostMessages.filter(row=>row.value?.message?.command?.type==='submit_text').length);
  await select.selectOption('short');await page.locator('#form').evaluate(form=>form.requestSubmit());
  assert.equal(await page.evaluate(()=>window.hostMessages.filter(row=>row.value?.message?.command?.type==='submit_text').length),countBefore,'失败后切档不以新请求重发');
  await select.selectOption('detailed');await page.locator('#form').evaluate(form=>form.requestSubmit());
  const retryId=await page.evaluate(()=>window.hostMessages.findLast(row=>row.value?.message?.command?.type==='submit_text').value.message.command.clientRequestId);
  assert.equal(retryId,failedId,'失败重试保持身份');
  await page.evaluate(id=>window.petBridge.receive({channel:'book_turn_state',clientRequestId:id,scope:{characterId:'aika',sessionId:'desktop',turnId:id,generation:2},state:'completed',text:'恢复成功。'},1),retryId);
  await select.selectOption('short');await page.locator('#text').fill('预览');
  const preview=await page.waitForFunction(()=>window.hostMessages.findLast(row=>row.value?.message?.channel==='book_reply_style')?.value.message);
  const previewMessage=await preview.jsonValue();
  await page.evaluate(request=>window.petBridge.receive({channel:'book_reply_style',requestId:request.requestId,characterId:'aika',sessionId:'desktop',decision:{selectedStyle:'short',requestConflict:true,effectiveRange:{minChars:200,maxChars:null}}},1),previewMessage);
  await page.locator('#reply-style-preview').filter({hasText:'字数边界优先'}).waitFor();
  await page.evaluate(()=>window.petBridge.receive({channel:'backend_ready',bridgeVersion:'0.8.0',characterId:'aika',characterLabel:'验收角色',sessionId:'new-session',productMode:'memory-book'},1));
  assert.equal(await select.inputValue(),'inherit','新会话不继承选择');
  // another character never inherits the draft selection
  await page.evaluate(() => window.petBridge.receive({ channel: 'backend_ready', bridgeVersion: '0.8.0', characterId: 'native-other', characterLabel: '隔离角色', sessionId: 'desktop', productMode: 'memory-book' }, 1));
  await page.waitForFunction(() => document.getElementById('reply-style').value === 'inherit');
  assert.equal(await select.inputValue(), 'inherit', '角色切换不继承本轮选择');
  assert.deepEqual(errors, []);
});

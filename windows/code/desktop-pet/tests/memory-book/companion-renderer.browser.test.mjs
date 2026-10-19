import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

test('production companion renderer keeps formal bubble, expands card and locates full chat through host bridge', { timeout: 45000 }, async t => {
  const root = resolve('desktop');
  const server = createServer(async (request, response) => {
    const path = resolve(root, '.' + new URL(request.url, 'http://127.0.0.1').pathname);
    if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    try { const data = await readFile(path); response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream'); response.end(data); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 950 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Only the external native transport is stubbed; the bundled production renderer owns all UI/state.
  await page.addInitScript(() => { window.hostMessages = []; window.desktopHost = { postMessage(name, value) { window.hostMessages.push({ name, value }); }, subscribe() {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => !!window.petBridge);
  await page.evaluate(() => { window.petBridge.connectionChanged({ generation: 1, state: 'connecting' }); window.petBridge.receive({ channel: 'backend_ready', bridgeVersion: '0.8.0', characterId: 'aika', characterLabel: '测试角色', sessionId: 'desktop', productMode: 'memory-book' }, 1); });
  assert.equal(await page.locator('#open').count(), 0, 'the floating chat entry has been removed');
  await page.locator('#model').click({ button: 'right' });
  await page.locator('#drawer').waitFor({ state: 'visible' });
  await page.locator('#text').fill('第一次见面？'); await page.locator('#form').evaluate(form => form.requestSubmit());
  const requestId = await page.evaluate(() => window.hostMessages.findLast(message => message.value?.message?.command?.type === 'submit_text').value.message.command.clientRequestId);
  await page.getByRole('button', { name: '收起对话', exact: true }).click(); await page.locator('#drawer').waitFor({ state: 'hidden' });
  await page.evaluate(async requestId => {
    const scope = { characterId: 'aika', sessionId: 'desktop', turnId: requestId, generation: 1 };
    const expression = { emotion: 'neutral', intensity: 0, delivery: '', gesture: null };
    for (const message of [
      { channel: 'event', event: { type: 'turn', input: { scope, kind: 'text', startedAt: new Date().toISOString(), text: '第一次见面？', clientRequestId: requestId } } },
      { channel: 'input_route', scope, route: 'companion' },
      { channel: 'event', event: { type: 'reply', reply: { scope, text: '记得，第一次见面是在机库。', expression } } },
      { channel: 'event', event: { type: 'presentation', presentation: { scope, state: 'idle', expression, mouth: 0 } } },
    ]) { await window.petBridge.receive(message, 1); await new Promise(done => setTimeout(done, 0)); }
  }, requestId);
  assert.equal(await page.locator('#reply').innerText().then(text => text.includes('记得，第一次见面是在机库。')), true, 'reply must be accepted by actual scope state');
  await page.locator('#speech-bubble').waitFor({ state: 'visible', timeout: 3000 });
  // showBubble deliberately measures off-screen for two frames (120 ms timer fallback).
  // Visible in Playwright means a nonempty box, not that positioning has completed.
  await page.waitForFunction(() => {
    const r = document.getElementById('speech-bubble').getBoundingClientRect();
    return r.width > 0 && r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  }, null, { timeout: 1000 });
  const geometry = await page.locator('#speech-bubble').boundingBox(); assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= 800 && geometry.y + geometry.height <= 950, JSON.stringify(geometry));
  // The previous renderer hid every formal answer after 6–10 seconds.
  await new Promise(done => setTimeout(done, 11000)); assert.equal(await page.locator('#speech-bubble').isVisible(), true);
  await page.getByRole('button', { name: '展开气泡完整对话', exact: true }).click(); await page.locator('#drawer').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#speech-bubble').isVisible(), false); assert.ok((await page.locator('#reply').innerText()).includes('记得，第一次见面是在机库。'));
  await page.getByRole('button', { name: '查看完整回答', exact: true }).click();
  const target = await page.evaluate(() => window.hostMessages.findLast(message => message.name === 'shell' && message.value.type === 'open_management').value.path);
  const url = new URL(target, 'http://127.0.0.1'); assert.equal(url.pathname, '/chat'); assert.equal(url.searchParams.get('sessionId'), 'desktop'); assert.equal(url.searchParams.get('characterId'), 'aika'); assert.equal(url.searchParams.get('messageId'), requestId);
  assert.ok(!target.includes('token')); assert.deepEqual(errors, []);
});

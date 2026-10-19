import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const session = JSON.parse(readFileSync('../../.local/memory-book/management-session.json', 'utf8'));
const address = new URL(session.url);
const token = new URLSearchParams(address.hash.slice(1)).get('token');
if (!token) throw new Error('Management token absent');
const url = address.origin + '/chat?sessionId=bridge-live-' + randomUUID() + '#token=' + encodeURIComponent(token);
const browser = await chromium.launch({ headless: true });
const errors = []; const apiErrors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(330000);
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) apiErrors.push({ status: response.status(), path: new URL(response.url()).pathname }); });
const evidence = { kind: 'real-chatgpt-via-extension', transport: 'bridge', reply: null, wiki: null, errors, apiErrors };
try {
  await page.goto(url);
  await page.getByLabel('聊天消息', { exact: true }).fill('这是 AIKI 连接验证。请只回复：桥接对话已恢复。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.mb-answer')].some(node => node.textContent.includes('桥接对话已恢复。')), null, { timeout: 320000 });
  evidence.reply = await page.locator('.mb-answer').last().innerText();
  assert.match(evidence.reply, /桥接对话已恢复。/);
  assert.equal(await page.getByLabel('聊天消息', { exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('link', { name: '记忆本', exact: true }).click();
  const wiki = page.getByRole('region', { name: '事实 Wiki' });
  await wiki.getByText('整理事实来源', { exact: true }).click();
  await wiki.getByLabel('Wiki 资料名称', { exact: true }).fill('Bridge 验证材料');
  await wiki.getByLabel('Wiki 事实资料', { exact: true }).fill('桥接测试伙伴最喜欢的饮品是乌龙茶。桥接测试伙伴的约定地点是北侧机库。');
  assert.equal(await wiki.getByRole('button', { name: 'AI 整理并预览', exact: true }).isEnabled(), true);
  await wiki.getByRole('button', { name: 'AI 整理并预览', exact: true }).click();
  await wiki.getByRole('button', { name: '确认事实并应用', exact: true }).waitFor({ timeout: 320000 });
  evidence.wiki = await wiki.locator('article').allTextContents();
  assert.ok(evidence.wiki.some(text => text.includes('乌龙茶')));
  assert.ok(evidence.wiki.some(text => text.includes('北侧机库')));
  assert.equal(await wiki.getByRole('alert').count(), 0);
  // Preview is reviewed but deliberately not applied to the user's knowledge base.
  assert.deepEqual(errors, []); assert.deepEqual(apiErrors, []);
  evidence.ok = true;
  await page.screenshot({ path: '.local/chatgpt-mvp-smoke/bridge-live-wiki.png', fullPage: true });
  console.log(JSON.stringify({ ok: true, reply: evidence.reply, wikiFacts: evidence.wiki.length, errors, apiErrors }));
} catch (error) { evidence.ok = false; evidence.error = String(error); console.error(JSON.stringify(evidence)); process.exitCode = 1; }
finally { writeFileSync('.local/chatgpt-mvp-smoke/bridge-live-ui.json', JSON.stringify(evidence, null, 2)); await browser.close(); }

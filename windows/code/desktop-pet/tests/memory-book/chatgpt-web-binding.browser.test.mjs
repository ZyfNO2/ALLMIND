/**
 * P0 4.2 addendum: the ChatGPT web binding UI must expose the model window / output reserve and save
 * the USER's values into mainModel/wikiModel. The old hardcoded 16384/4096 silently dropped all
 * older user/assistant history once the compiled prompt reached the local budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { BookRuntime } from '../../dist/app/book-runtime.js';
import { BookCredentials } from '../../dist/management/book-credentials.js';
import { startBookServer } from '../../dist/management/book-server.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../dist/contracts/memory-book.js';

test('ChatGPT web binding exposes model window/output reserve and saves the user value instead of 16384', { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'allmind-web-window-')), repository = new FileBookRepository(directory), credentials = new BookCredentials(join(directory, 'credentials'));
  const config = repository.loadConfig();
  repository.commitConfig({ ...config, chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded', submitMechanism: 'page', authorizedPurposes: ['reply', 'wiki'] } }, config.revision, 'web-source');
  const runtime = new BookRuntime(repository, { async complete() { throw Error('binding test must not call a model'); } });
  const server = await startBookServer({ runtime, credentials, uiRoot: resolve('management'),
    chatgptEmbedded: { async login() { return { opened: true }; }, async probe() { return { ready: true, temporary: true, hasTurns: false }; } } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  await page.goto(new URL(server.url).origin + '/settings');
  await page.getByRole('button', { name: 'ChatGPT 网页接入', exact: true }).first().click();
  const panel = page.getByRole('region', { name: 'ChatGPT 普通 Chat', exact: true });
  await panel.waitFor();
  const windowInput = panel.getByLabel('网页模型窗口', { exact: true }), outputInput = panel.getByLabel('网页输出预留', { exact: true });
  assert.equal(await windowInput.inputValue(), '16384', '未保存绑定前使用默认 16384');
  assert.equal(await outputInput.inputValue(), '4096', '未保存绑定前使用默认 4096');
  await windowInput.fill('32768'); await outputInput.fill('8192');
  await panel.getByRole('button', { name: '检查登录并绑定独立页面', exact: true }).click();
  await page.getByText('独立页面已登录，文字主模型已绑定并保存', { exact: false }).waitFor();
  const saved = repository.loadConfig();
  assert.equal(saved.mainModel?.kind, 'chatgpt-web');
  assert.equal(saved.mainModel.inputTokens, 32768, '保存的窗口必须是用户输入的 32768，而不是硬编码 16384');
  assert.equal(saved.mainModel.outputTokens, 8192);
  assert.equal(saved.wikiModel?.inputTokens, 32768, '“回复与整理”共用绑定时同样使用用户窗口');
  assert.equal(saved.wikiModel?.outputTokens, 8192);
});

test('slow embedded login shows an immediate status while the navigation is still pending', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'allmind-web-slow-')), repository = new FileBookRepository(directory), credentials = new BookCredentials(join(directory, 'credentials'));
  const config = repository.loadConfig();
  repository.commitConfig({ ...config, chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded', submitMechanism: 'page' } }, config.revision, 'web-source');
  let logins = 0; let release = () => {};
  const navigation = new Promise(resolve => { release = resolve; });
  const runtime = new BookRuntime(repository, { async complete() { throw Error('slow-login test must not call a model'); } });
  const server = await startBookServer({ runtime, credentials, uiRoot: resolve('management'),
    chatgptEmbedded: { login() { logins++; return navigation; }, async probe() { return { ready: false, temporary: true, hasTurns: false }; } } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { release?.(); await browser.close(); await server.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  await page.goto(new URL(server.url).origin + '/settings');
  await page.getByRole('button', { name: 'ChatGPT 网页接入', exact: true }).first().click();
  const panel = page.getByRole('region', { name: 'ChatGPT 普通 Chat', exact: true });
  await panel.waitFor();
  await panel.getByRole('button', { name: '打开独立登录窗口', exact: true }).click();
  // The host is still navigating (login promise unresolved), yet the user already sees what is happening.
  await panel.getByText('正在打开登录窗口…首次加载或慢网络时页面需要等待，窗口会先显示；不会自动重试发送。', { exact: false }).waitFor();
  assert.equal(logins, 1);
  release();
});

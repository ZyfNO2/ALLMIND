import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { BookRuntime } from '../../dist/app/book-runtime.js';
import { BookCredentials } from '../../dist/management/book-credentials.js';
import { startBookServer } from '../../dist/management/book-server.js';
import { DEFAULT_CHATGPT_WEB_SOURCE, BookError } from '../../dist/contracts/memory-book.js';

/** B01 §5 UI isolation row: an in-flight check or save locks the role switch, stale
 * results never land on another role, other unsaved drafts survive the project save
 * and a denied/failed check keeps the previous binding untouched. */
test('project settings isolate roles and drafts across in-flight checks, saves, reloads and role switches', { timeout: 90000 }, async t => {
  mkdirSync(resolve('.local/memory-book-tests'), { recursive: true });
  const repository = new FileBookRepository(mkdtempSync(resolve('.local/memory-book-tests/project-isolation-')));
  const initial = repository.loadConfig();
  repository.commitConfig({ ...initial, chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded' }, characters: [...initial.characters, { id: 'role-b', name: '角色B', intro: '', appearancePath: null }] }, initial.revision, 'seed-isolation');
  const replyLanguageBefore = repository.loadConfig().replyLanguage;
  const runtime = new BookRuntime(repository, { complete: async () => { throw Error('Settings must not call a model'); } });
  const projectId = 'g-p-' + 'a'.repeat(32), deniedId = 'g-p-' + 'c'.repeat(32);
  let checks = 0, checkDelay = 0;
  const server = await startBookServer({ runtime, credentials: new BookCredentials(join(repository.directory, 'credentials')), uiRoot: resolve('management'), chatgptWeb: {
    async probe() { return { state: 'signed-in', checkedAt: new Date().toISOString() }; }, async openLoginPage() {},
    async inspectProject(id) { checks++; if (id === deniedId) throw new BookError('unavailable', '项目不可访问或未登录。'); if (checkDelay) await new Promise(done => setTimeout(done, checkDelay)); return { projectId: id, name: '链接测试项目', account: 'b'.repeat(64), memory: 'unverified' }; },
  } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); repository.close(); });
  let delayPuts = false;
  const page = await browser.newPage(); page.setDefaultTimeout(12000);
  await page.route('**/api/memory-book/v1/runtime', route => { if (delayPuts && route.request().method() === 'PUT') setTimeout(() => void route.continue(), 1200); else void route.continue(); });
  await page.goto(server.url);
  await page.getByRole('link', { name: '设置', exact: true }).click();
  const section = page.getByRole('region', { name: '对话所属 ChatGPT 项目', exact: true });
  const input = section.getByLabel('已有项目链接', { exact: true });
  // the sidebar label wraps its <select>, so its accessible text includes the option names: scope it instead of exact-matching.
  const roleSelect = page.locator('.mb-sidebar').getByLabel('当前角色');
  const check = section.getByRole('button', { name: '检查项目链接', exact: true });
  await input.waitFor();
  // invalid URL: rejected in place, the draft input is kept, nothing is saved
  await input.fill('https://example.com/project');
  await check.click();
  await page.getByRole('alert').filter({ hasText: '仅接受 chatgpt.com' }).waitFor();
  assert.equal(await input.inputValue(), 'https://example.com/project');
  assert.equal(repository.loadConfig().chatgptProjects, undefined);
  assert.equal(checks, 0, '非法链接不得触达项目检查');
  // in-flight check locks the role switch; the result stays on the current role
  checkDelay = 1500;
  await input.fill('https://chatgpt.com/g/' + projectId + '/project');
  await check.click();
  for (let attempt = 0; attempt < 50 && !(await roleSelect.isDisabled()); attempt++) await page.waitForTimeout(50);
  assert.equal(await roleSelect.isDisabled(), true, '检查期间不得切换角色');
  await section.getByText(/待绑定：链接测试项目/).waitFor();
  assert.equal(await roleSelect.isDisabled(), false);
  assert.equal(checks, 1);
  await section.getByRole('button', { name: '保存项目绑定', exact: true }).click();
  await section.getByText('项目绑定已保存并回读。', { exact: true }).waitFor();
  const saved = repository.loadConfig().chatgptProjects[0];
  assert.equal(saved.projectId, projectId); assert.equal(saved.characterId, 'aika');
  // reload keeps the saved binding visible
  await page.reload();
  await section.getByText(/项目：链接测试项目/).waitFor();
  // a dirty draft in another setting blocks the project save and survives it
  await page.getByLabel('回复语言', { exact: true }).selectOption('ja-JP');
  checkDelay = 0;
  await input.fill('https://chatgpt.com/g/' + projectId + '/project');
  await check.click();
  await section.getByText(/待绑定：链接测试项目/).waitFor();
  await section.getByRole('button', { name: '保存项目绑定', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请先保存或放弃其他设置修改，再保存项目绑定。' }).waitFor();
  assert.equal(await page.getByLabel('回复语言', { exact: true }).inputValue(), 'ja-JP', '项目保存失败不得丢弃其他草稿');
  const afterBlocked = repository.loadConfig();
  assert.equal(afterBlocked.chatgptProjects.length, 1);
  assert.equal(afterBlocked.chatgptProjects[0].projectId, projectId);
  assert.equal(afterBlocked.replyLanguage, replyLanguageBefore);
  // discard restores the draft; a denied project keeps the old binding and reports why
  await page.getByRole('button', { name: '放弃更改', exact: true }).click();
  assert.equal(await page.getByLabel('回复语言', { exact: true }).inputValue(), String(replyLanguageBefore ?? 'zh-CN'));
  await input.fill('https://chatgpt.com/g/' + deniedId + '/project');
  await check.click();
  await page.getByRole('alert').filter({ hasText: '项目不可访问或未登录' }).waitFor();
  assert.equal(repository.loadConfig().chatgptProjects[0].projectId, projectId, '失败的检查不得改动旧绑定');
  assert.equal(await input.inputValue(), 'https://chatgpt.com/g/' + deniedId + '/project', '失败后输入保留');
  // an in-flight save locks the role switch too (pause the binding through the real save path)
  delayPuts = true;
  await section.getByRole('button', { name: '暂停项目绑定', exact: true }).click();
  for (let attempt = 0; attempt < 50 && !(await roleSelect.isDisabled()); attempt++) await page.waitForTimeout(50);
  assert.equal(await roleSelect.isDisabled(), true, '保存期间不得切换角色');
  await section.getByText('项目绑定已保存并回读。', { exact: true }).waitFor();
  assert.equal(repository.loadConfig().chatgptProjects[0].enabled, false);
  delayPuts = false;
  // switching roles starts the other role's section clean; role A's binding is untouched
  await roleSelect.selectOption('role-b');
  await section.getByText('当前角色：角色B', { exact: true }).waitFor();
  assert.equal(await section.getByText(/项目：链接测试项目/).count(), 0, '旧角色的检查/绑定结果不得落到新角色');
  assert.equal(await input.inputValue(), '', '切换角色后链接草稿清空');
  const afterSwitch = repository.loadConfig();
  assert.equal(afterSwitch.chatgptProjects.length, 1);
  assert.equal(afterSwitch.chatgptProjects[0].characterId, 'aika');
  // switching back shows role A's binding again
  await roleSelect.selectOption('aika');
  await section.getByText(/项目：链接测试项目/).waitFor();
  assert.equal(repository.loadConfig().chatgptProjects[0].enabled, false);
});

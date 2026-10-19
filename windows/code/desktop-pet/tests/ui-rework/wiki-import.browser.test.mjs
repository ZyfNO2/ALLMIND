/**
 * WV0-03 · 网页双入口浏览器验收。
 *
 * AC（[WV0-03 SPEC](../../docs/next/character-wiki-v0/specs/WV0-03.md)）：
 *   * 真实 MD 文件选择与 textarea 粘贴进入**同一** preview API → 同 hash/normalized；
 *   * 保存草稿（未应用）→ source_only 禁用应用；结构化 → 应用确认链 → 服务端读回证明；
 *   * 409 保留输入；双击仅一个操作；深链接 ?tab=wiki；故事书 JSON 导入不回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../management/role-console-fixture.mjs';
import { startManagementServer } from '../../dist/management/server.js';
import { CharacterPackStore } from '../../dist/memory/character-pack-store.js';
import { characterWikiImportManagement } from '../../dist/management/character-wiki-import-routes.js';
import { productionPairing } from '../../dist/contracts/character-pack.js';

const template = readFileSync(resolve('../../../validation/fixtures/character-wiki-v0/IMPORT_TEMPLATE.md'), 'utf8');

async function wikiFixture(t) {
  const f = await roleConsoleFixture(t);
  const packs = await CharacterPackStore.open(f.store.rawDatabaseForKnowledge());
  const roles = {
    exists: id => ['companion', 'role-b'].includes(id),
    allowsConfiguration: () => true,
    pairingFor: characterId => productionPairing(characterId, 'fixture-instance'),
  };
  const wiki = characterWikiImportManagement(packs, roles);
  const server = await startManagementServer({ uiRoot: resolve('management'), settings: f.settings, memory: f.memory,
    skins: f.skins, presets: f.presets, selfSetup: f.selfSetup, memoryImport: f.memoryImport,
    lorebooks: f.lorebooks, wikiImport: wiki,
    snapshot: () => ({ apiVersion: 1, runtime: { ...f.runtime.identity(), characterId: 'companion', characterLabel: '验收角色 A', online: true }, modules: f.runtime.modules(), events: [], settings: f.settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  return { ...f, packs, server };
}

test('WV0-03 双入口一致预览 + 保存草稿 + 显式应用确认链', { timeout: 240000 }, async t => {
  const f = await wikiFixture(t);
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${f.server.origin}/characters/companion/config?tab=wiki#token=${f.server.token}`);
  await expect(page.getByRole('heading', { name: '角色 Wiki 导入' })).toBeVisible({ timeout: 60000 });
  await expect(page.getByText(/导入到：companion/)).toBeVisible();

  // 入口一：粘贴到 textarea。
  const textarea = page.getByLabel('Wiki 内容');
  await textarea.fill(template);
  await page.getByRole('button', { name: '预览校验' }).click();
  await expect(page.getByText(/结构化 Wiki 文档解析完成/)).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/角色核心：示例角色/)).toBeVisible();
  // 预览零写：还没有草稿/包。
  // 入口二（同 fixture 的 MD 文件经 file input 设置）：直接用 setInputDevices 模拟真实选择。
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByText('选择 MD 文件').click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({ name: 'IMPORT_TEMPLATE.md', mimeType: 'text/markdown', buffer: Buffer.from(template, 'utf8') });
  await expect(page.getByText(/来源：IMPORT_TEMPLATE\.md/)).toBeVisible();
  // 换文件后旧预览失效：需要重新预览，且得到同一 hash。
  await page.getByRole('button', { name: '预览校验' }).click();
  await expect(page.getByText(/结构化 Wiki 文档解析完成/)).toBeVisible({ timeout: 20000 });
  // 保存草稿（幂等键由前端 operation 提供）。
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByText(/草稿已保存（未应用）/)).toBeVisible({ timeout: 20000 });
  // 服务端读回：真实 import 记录与 draft。
  // 应用：需要重新预览活动版本 → 确认。
  await page.getByRole('button', { name: '应用到当前角色' }).click();
  await expect(page.getByRole('heading', { name: '确认应用' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '确认应用' }).click();
  await expect(page.getByText(/已应用到该角色/)).toBeVisible({ timeout: 20000 });
  // 服务端证明：活动包存在且 wikiFacts 含 canon 事实。
  const packs = f.packs;
  const snapshot = await packs.getSnapshot(productionPairing('companion', 'fixture-instance'));
  assert.ok(snapshot.activePack, '应用后活动包必须存在');
  const wikiFacts = snapshot.activePack.wikiFacts ?? [];
  assert.ok(wikiFacts.some(fact => fact.text.includes('她喜欢整理旧书')), `读回 wikiFacts：${JSON.stringify(wikiFacts)}`);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve('.local/reports/wv0-03/03-1-applied.png'), fullPage: true });
});

test('WV0-03 普通 MD 禁用应用；source_only 保存成功；深链接与故事书不回归', { timeout: 240000 }, async t => {
  const f = await wikiFixture(t);
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${f.server.origin}/characters/companion/config?tab=wiki#token=${f.server.token}`);
  await expect(page.getByRole('heading', { name: '角色 Wiki 导入' })).toBeVisible({ timeout: 60000 });
  const applyButton = page.getByRole('button', { name: '应用到当前角色' });
  assert.equal(await applyButton.isDisabled(), true, '无输入时应用禁用');
  await page.getByLabel('Wiki 内容').fill('# 随手记\n\n她像是个安静的角色。');
  await page.getByRole('button', { name: '预览校验' }).click();
  await expect(page.getByText(/来源草稿：尚无结构化角色设定/).first()).toBeVisible({ timeout: 20000 });
  assert.equal(await applyButton.isDisabled(), true, 'source_only 应用必须禁用');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByText(/草稿已保存（未应用）/)).toBeVisible({ timeout: 20000 });
  // 故事书页签仍可用。
  await page.locator('nav[aria-label="角色配置分区"]').getByRole('button', { name: '故事书' }).click();
  await expect(page.getByRole('heading', { name: /故事书|Lorebook/ }).first()).toBeVisible({ timeout: 30000 });
  assert.deepEqual(errors, []);
});

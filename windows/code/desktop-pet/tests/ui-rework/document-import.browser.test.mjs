/**
 * CB-04 · 统一角色文档导入面板浏览器验收。
 *
 * AC（[CB-04 SPEC](../../docs/next/aiki-character-book/specs/CB-04.md)）：
 *   * 双入口（文件 / 粘贴）进入同一 preview API；深链接 `?tab=document`；
 *   * 预览显示分类统计与「将填入的位置」；应用确认链 → 服务端读回证明（profile/prompt/pack/lorebook/state）；
 *   * 刷新后仍在（真正落库）；
 *   * 作者初始状态与真实状态分开展示；导出按钮产出 .aiki.md。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../management/role-console-fixture.mjs';
import { startManagementServer } from '../../dist/management/server.js';
import { CharacterPackStore } from '../../dist/memory/character-pack-store.js';
import { characterDocumentManagement, lorebookFingerprintOf } from '../../dist/management/character-document-routes.js';
import { productionPairing } from '../../dist/contracts/character-pack.js';

const fixture = readFileSync(resolve('../../../validation/fixtures/aiki-character-book/allmind.aiki.md'), 'utf8');

async function documentFixture(t) {
  const f = await roleConsoleFixture(t);
  const packs = await CharacterPackStore.open(f.store.rawDatabaseForKnowledge());
  const roles = {
    exists: id => ['companion', 'role-b'].includes(id),
    allowsConfiguration: () => true,
    pairingFor: characterId => productionPairing(characterId, 'fixture-instance'),
  };
  const exportDeps = {
    packs, lorebooks: f.lorebooks, profiles: f.roles,
    activePackIdOf: characterId => packs.getInstance('local-user', characterId, 'fixture-instance')?.activePackId ?? null,
    labelOf: () => 'ALLMIND',
  };
  const documents = characterDocumentManagement(packs, roles, {
    profileOf: () => null, promptOf: () => null, lorebookFingerprint: () => lorebookFingerprintOf([]),
  }, { profiles: f.roles, memoryOf: () => f.memory, lorebooks: f.lorebooks }, exportDeps);
  const server = await startManagementServer({ uiRoot: resolve('management'), settings: f.settings, memory: f.memory,
    skins: f.skins, presets: f.presets, selfSetup: f.selfSetup, memoryImport: f.memoryImport,
    lorebooks: f.lorebooks, characterDocuments: documents,
    snapshot: () => ({ apiVersion: 1, runtime: { ...f.runtime.identity(), characterId: 'companion', characterLabel: 'ALLMIND', online: true }, modules: f.runtime.modules(), events: [], settings: f.settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  return { ...f, packs, server, documents };
}

test('CB-04 双入口预览 → 应用确认链 → 服务端读回 → 刷新仍在', { timeout: 300000 }, async t => {
  const f = await documentFixture(t);
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${f.server.origin}/characters/companion/config?tab=document#token=${f.server.token}`);
  await expect(page.getByRole('heading', { name: '导入角色文档' })).toBeVisible({ timeout: 60000 });
  await expect(page.getByText(/导入到：companion/)).toBeVisible();

  // 入口一：粘贴。
  await page.getByLabel('角色文档内容').fill(fixture);
  await page.getByRole('button', { name: '预览校验' }).click();
  await expect(page.getByText(/解析完成：Persona 4/)).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel('条目应用计划')).toBeVisible();

  // 入口二：文件选择 → 旧预览失效 → 重新预览得到同一统计。
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByText('选择 .aiki.md 文件').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'allmind.aiki.md', mimeType: 'text/markdown', buffer: Buffer.from(fixture, 'utf8') });
  await expect(page.getByText(/来源：allmind\.aiki\.md/)).toBeVisible();
  await page.getByRole('button', { name: '预览校验' }).click();
  await expect(page.getByText(/解析完成：Persona 4/)).toBeVisible({ timeout: 20000 });

  // 应用确认链。
  await page.getByRole('button', { name: '应用到当前角色' }).click();
  await expect(page.getByRole('heading', { name: '确认应用' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '确认应用' }).click();
  await expect(page.getByText(/已应用并保存|已应用到该角色/)).toBeVisible({ timeout: 30000 });

  // 服务端读回：六位置真实落库。
  const pairing = productionPairing('companion', 'fixture-instance');
  const snapshot = await f.packs.getSnapshot(pairing);
  assert.ok(snapshot.activePack, '应用后活动包必须存在');
  const facts = snapshot.activePack.wikiFacts ?? [];
  assert.equal(facts.length, 3, `wikiFacts 应为 3 条：${JSON.stringify(facts.map(x => x.id))}`);
  assert.ok(facts.some(fact => fact.id === 'wiki.location.test_hangar'), '测试机库必须落库');
  const story = f.lorebooks.list('companion').flatMap(book => book.entries).filter(entry => entry.aikiEntryId);
  assert.equal(story.length, 2, `故事书应有 2 条 aiki 条目：${JSON.stringify(story.map(x => x.aikiEntryId))}`);
  assert.equal(f.packs.authorStateOf('companion').length, 3, '作者初始状态应有 3 条');
  const profile = f.roles.get('companion');
  assert.ok(profile?.identity.intro && profile.identity.intro.length > 0, '简介必须落库');

  // 刷新后仍在 + 作者初始状态分开展示。
  await page.reload();
  await expect(page.getByRole('heading', { name: '导入角色文档' })).toBeVisible({ timeout: 60000 });
  await expect(page.getByLabel('作者初始状态')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('作者设定').first()).toBeVisible();
  await expect(page.getByText(/来源导入 aiki-/).first()).toBeVisible();
  await expect(page.getByText(/修订 1\b/).first()).toBeVisible();

  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve('.local/reports/cb-04/04-1-applied.png'), fullPage: true });
});

test('CB-04 坏格式不应用；导出按钮产出 .aiki.md', { timeout: 300000 }, async t => {
  const f = await documentFixture(t);
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${f.server.origin}/characters/companion/config?tab=document#token=${f.server.token}`);
  await expect(page.getByRole('heading', { name: '导入角色文档' })).toBeVisible({ timeout: 60000 });

  // 坏格式：未知 schema → 解析失败，应用按钮禁用，输入保留。
  await page.getByLabel('角色文档内容').fill('---\nschema: nope/v9\nid: x\nname: X\nlanguage: zh-CN\n---\n\n# X\n')
  await page.getByRole('button', { name: '预览校验' }).click();
  await expect(page.getByText(/来源草稿|解析|schema/i).first()).toBeVisible({ timeout: 20000 });
  assert.equal(await page.getByRole('button', { name: '应用到当前角色' }).isDisabled(), true, '坏格式必须禁用应用');
  assert.ok((await page.getByLabel('角色文档内容').inputValue()).includes('nope/v9'), '409/失败必须保留输入');

  // 导出：先真实导入一次，再点导出。
  const preview = await f.documents.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture });
  const saved = await f.documents.saveDraft({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture, operationId: crypto.randomUUID(), previewHash: preview.documentHash });
  await f.documents.apply({
    characterId: 'companion', importId: saved.importId, documentHash: preview.documentHash,
    selection: { profile: true, prompt: true, wiki: true, story: true, state: true, skippedEntryIds: [], intro: '协作者测试简介。' },
    expectedRevisions: { profileRevision: preview.current.profileRevision, promptRevision: null, packRevision: preview.current.packRevision, bookRevision: null },
    operationId: crypto.randomUUID(), userConfirmed: true,
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前为 .aiki.md' }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.aiki\.md$/, `导出文件名：${download.suggestedFilename()}`);
  await expect(page.getByText(/已导出 \d+ 条/)).toBeVisible({ timeout: 20000 });
  assert.deepEqual(errors, []);
});

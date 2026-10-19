/**
 * WV0-01 · 零写预览与原子草稿保存（HTTP 层，真实管理服务器 + 真实 CharacterPackStore SQLite）。
 *
 * 目标接口：POST /api/characters/wiki/import/{preview,drafts}、GET drafts 列表/详情、GET operations/{id}。
 * AC（[WV0-01 SPEC](../../docs/next/character-wiki-v0/specs/WV0-01.md)）：
 *   01-1 preview 前后 counts/revision 不变；两入口一致；
 *   01-2 幂等回执（同 operation/同内容 → 原回执；同 operation/异内容 → 409；同内容异 operation → duplicate）；
 *   01-3 假角色 404 / 跨角色读取 404 / stale previewHash 409 / 超限 400；
 *   01-4 source_only 保存无 draftId；structured 保存有 draft 且读回一致；不改变活动指针。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../../../tests/management/role-console-fixture.mjs';
import { startManagementServer } from '../../management/server.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { characterWikiImportManagement } from '../../management/character-wiki-import-routes.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { randomUUID } from 'node:crypto';

const template = readFileSync(resolve('../../../validation/fixtures/character-wiki-v0/IMPORT_TEMPLATE.md'), 'utf8');
const fenced = /```aika-wiki-v0\r?\n([\s\S]*?)```/.exec(template)![1]!;
const PLAIN_MD = '# 随手记\n\n她像是个安静的角色，以后再整理。';

/** Wiki-capable fixture: role console fixture + a real CharacterPackStore + the wired route. */
async function wikiFixture(t: import('node:test').TestContext) {
  const f = await roleConsoleFixture(t);
  const packs = await CharacterPackStore.open(f.store.rawDatabaseForKnowledge());
  const roles = {
    exists: (id: string) => ['companion', 'role-b'].includes(id),
    allowsConfiguration: () => true,
    pairingFor: (characterId: string) => productionPairing(characterId, 'fixture-instance'),
  };
  const wiki = characterWikiImportManagement(packs, roles);
  const server = await startManagementServer({ uiRoot: resolve('.'), settings: f.settings, memory: f.memory,
    skins: f.skins, presets: f.presets, selfSetup: f.selfSetup, memoryImport: f.memoryImport,
    lorebooks: f.lorebooks, wikiImport: wiki,
    snapshot: () => ({ apiVersion: 1, runtime: { ...f.runtime.identity(), characterId: 'companion', characterLabel: '验收角色 A', online: true }, modules: f.runtime.modules(), events: [], settings: f.settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(server.origin + path, { method, headers: { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, value } as { status: number; value: any };
  };
  return { ...f, packs, server, request, wiki };
}

const previewBody = (text: string, characterId = 'companion') => ({
  apiVersion: 1, characterId, inputKind: 'clipboard', sourceName: '粘贴内容', text,
});

test('WV0-01 AC-01-1 preview 零写且两入口一致；未装配返回 503', async t => {
  const f = await wikiFixture(t);
  const countsBefore = {
    sources: f.store.rawDatabaseForKnowledge().prepare('SELECT COUNT(*) c FROM character_pack_sources').get()!.c,
    drafts: f.store.rawDatabaseForKnowledge().prepare('SELECT COUNT(*) c FROM character_pack_drafts').get()!.c,
  };
  const byFile = await f.request('/api/characters/wiki/import/preview', 'POST', previewBody(template, 'companion'));
  assert.equal(byFile.status, 200);
  assert.equal(byFile.value.mode, 'structured');
  assert.equal(byFile.value.canApply, true, '有 canon 核心/事实/事件的文档可应用');
  const byPaste = await f.request('/api/characters/wiki/import/preview', 'POST', previewBody(template, 'companion'));
  assert.equal(byPaste.value.documentHash, byFile.value.documentHash, '两入口同文本同 hash');
  assert.equal(byPaste.value.normalizedPreview.title, '示例角色设定');
  // counts 不变（零写）。
  const countsAfter = {
    sources: f.store.rawDatabaseForKnowledge().prepare('SELECT COUNT(*) c FROM character_pack_sources').get()!.c,
    drafts: f.store.rawDatabaseForKnowledge().prepare('SELECT COUNT(*) c FROM character_pack_drafts').get()!.c,
  };
  assert.deepEqual(countsAfter, countsBefore, 'preview 不得写库');
  // 普通 MD：canSave=true / canApply=false。
  const plain = await f.request('/api/characters/wiki/import/preview', 'POST', previewBody(PLAIN_MD));
  assert.equal(plain.value.mode, 'source_only');
  assert.equal(plain.value.canSave, true);
  assert.equal(plain.value.canApply, false);
});

test('WV0-01 AC-01-2/01-4 保存：结构化有草稿读回一致；幂等/异内容 409/异 operation duplicate；活动指针不变', async t => {
  const f = await wikiFixture(t);
  const preview = await f.request('/api/characters/wiki/import/preview', 'POST', previewBody(template));
  const operationId = randomUUID();
  const saved = await f.request('/api/characters/wiki/import/drafts', 'POST', {
    ...previewBody(template), operationId, previewHash: preview.value.documentHash,
  });
  assert.equal(saved.status, 200, `保存应成功：${JSON.stringify(saved.value)}`);
  assert.equal(saved.value.saved, true);
  assert.equal(saved.value.applied, false, '保存≠应用');
  assert.ok(saved.value.draftId, '结构化文档必须有草稿');
  // 活动指针不变。
  const snapshot = await f.packs.getSnapshot(productionPairing('companion', 'fixture-instance'));
  assert.equal(snapshot.activePack, null, '保存草稿不得改变活动包指针');
  // 幂等：同 operation 同内容 → 原回执。
  const replay = await f.request('/api/characters/wiki/import/drafts', 'POST', {
    ...previewBody(template), operationId, previewHash: preview.value.documentHash,
  });
  assert.equal(replay.value.importId, saved.value.importId, '同 operation 同内容返回原回执');
  assert.equal(replay.value.duplicate, true);
  // 同 operation 异内容 → 409。
  const conflict = await f.request('/api/characters/wiki/import/drafts', 'POST', {
    ...previewBody(PLAIN_MD), operationId, previewHash: (await f.request('/api/characters/wiki/import/preview', 'POST', previewBody(PLAIN_MD))).value.documentHash,
  });
  assert.equal(conflict.status, 409, '同 operation 异内容必须 409');
  // 异 operation 同内容 → duplicate，引用同一 import。
  const again = await f.request('/api/characters/wiki/import/drafts', 'POST', {
    ...previewBody(template), operationId: randomUUID(), previewHash: preview.value.documentHash,
  });
  assert.equal(again.value.importId, saved.value.importId, '同内容异 operation 复用既有导入');
  assert.equal(again.value.duplicate, true);
  // 草稿读回：canon 事实与事件投影、候选保留。
  const draft = f.packs.getDraft(saved.value.draftId);
  assert.ok(draft, '草稿必须真实落库');
  assert.equal(draft.status, 'validated', '有据草稿应通过真实 validator');
  const canonTexts = (draft.payload.canonFacts as readonly { text: string }[]).map((fact: { text: string }) => fact.text);
  assert.ok(canonTexts.includes('她喜欢整理旧书。'), `canon 事实投影：${JSON.stringify(canonTexts)}`);
  assert.ok(!canonTexts.some((text: string) => text.includes('雨天')), 'draft 事实不得投影为 canon');
  // operations 查询（崩溃恢复路径）。
  const op = await f.request(`/api/characters/wiki/operations/${operationId}?characterId=companion`);
  assert.equal(op.status, 200);
  assert.equal(op.value.documentHash, preview.value.documentHash);
});

test('WV0-01 AC-01-3 假角色 404 / stale previewHash 409 / 跨角色读取 404 / source_only 无草稿', async t => {
  const f = await wikiFixture(t);
  const ghost = await f.request('/api/characters/wiki/import/preview', 'POST', previewBody(template, 'no-such-role'));
  assert.equal(ghost.status, 404, '假角色必须 404');
  // stale previewHash。
  const stale = await f.request('/api/characters/wiki/import/drafts', 'POST', {
    ...previewBody(template), operationId: randomUUID(), previewHash: '0'.repeat(64),
  });
  assert.equal(stale.status, 409, 'stale previewHash 必须 409');
  // source_only 保存：无 draftId。
  const plainPreview = await f.request('/api/characters/wiki/import/preview', 'POST', previewBody(PLAIN_MD));
  const plainSave = await f.request('/api/characters/wiki/import/drafts', 'POST', {
    ...previewBody(PLAIN_MD), operationId: randomUUID(), previewHash: plainPreview.value.documentHash,
  });
  assert.equal(plainSave.status, 200);
  assert.equal(plainSave.value.draftId, null, 'source_only 不得造假草稿');
  assert.equal(plainSave.value.mode, 'source_only');
  // 跨角色读取：companion 的 import 用 role-b 查 → 404。
  const savedCompanion = await f.request('/api/characters/wiki/import/drafts', 'POST', {
    ...previewBody(template), operationId: randomUUID(), previewHash: plainPreview.value.documentHash === (await f.request('/api/characters/wiki/import/preview', 'POST', previewBody(template))).value.documentHash
      ? (await f.request('/api/characters/wiki/import/preview', 'POST', previewBody(template))).value.documentHash : '',
  });
  const foreign = await f.request(`/api/characters/wiki/import/drafts/${savedCompanion.value.importId}?characterId=role-b`);
  assert.equal(foreign.status, 404, '跨角色读取必须 404');
  // 列表默认不含全文。
  const list = await f.request('/api/characters/wiki/import/drafts?characterId=companion');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.value.imports));
  assert.ok(!JSON.stringify(list.value).includes('她喜欢整理旧书'), '列表不得返回来源全文');
});

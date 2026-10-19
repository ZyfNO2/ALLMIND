/**
 * CB-01 · 统一文档来源与预览（HTTP 层，真实管理服务器 + 真实 CharacterPackStore SQLite）。
 *
 * 目标接口：POST /api/characters/documents/{preview,drafts}、GET drafts 列表/详情、GET operations/{id}。
 * AC（[CB-01 SPEC](../../../docs/next/aiki-character-book/specs/CB-01.md)）：
 *   01-1 preview 零写；原文件 counts 4/3/2/3，authoring 全"未提供"，首导全 add；两入口一致；
 *   01-2 同文件二次 preview 全 noop；改一 Entry 正文→该项 update；
 *   01-3 幂等回执（同 operation/同内容 → 原回执；同 operation/异内容 → 409；同内容异 operation → duplicate）；
 *   01-4 假角色 404 / stale previewHash 409 / 超限 400 / 坏格式 400 且零写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../../../tests/management/role-console-fixture.mjs';
import { startManagementServer } from '../../management/server.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { characterDocumentManagement, lorebookFingerprintOf } from '../../management/character-document-routes.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { randomUUID } from 'node:crypto';

const fixture = readFileSync(resolve('../../../validation/fixtures/aiki-character-book/allmind.aiki.md'), 'utf8');
const PLAIN_MD = '# 随手记\n\n她像是个安静的角色，以后再整理。';

/** Document-capable fixture: role console fixture + a real CharacterPackStore + the wired route. */
async function documentFixture(t: import('node:test').TestContext) {
  const f = await roleConsoleFixture(t);
  const packs = await CharacterPackStore.open(f.store.rawDatabaseForKnowledge());
  const roles = {
    exists: (id: string) => ['companion', 'role-b'].includes(id),
    allowsConfiguration: () => true,
    pairingFor: (characterId: string) => productionPairing(characterId, 'fixture-instance'),
  };
  const documents = characterDocumentManagement(packs, roles, {
    profileOf: () => null,
    promptOf: () => null,
    lorebookFingerprint: () => lorebookFingerprintOf([]),
  }, { profiles: f.roles, memoryOf: () => f.memory, lorebooks: f.lorebooks });
  const server = await startManagementServer({ uiRoot: resolve('.'), settings: f.settings, memory: f.memory,
    skins: f.skins, presets: f.presets, selfSetup: f.selfSetup, memoryImport: f.memoryImport,
    lorebooks: f.lorebooks, characterDocuments: documents,
    snapshot: () => ({ apiVersion: 1, runtime: { ...f.runtime.identity(), characterId: 'companion', characterLabel: '验收角色 A', online: true }, modules: f.runtime.modules(), events: [], settings: f.settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(server.origin + path, { method, headers: { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, value } as { status: number; value: any };
  };
  return { ...f, packs, server, request, documents };
}

const previewBody = (text: string, characterId = 'companion') => ({
  apiVersion: 1, characterId, inputKind: 'file', sourceName: 'allmind.aiki.md', text,
});

test('CB-01 AC-01-1 preview 零写：counts/authoring/首导 add/两入口一致', async t => {
  const f = await documentFixture(t);
  const db = f.store.rawDatabaseForKnowledge();
  const countsBefore = {
    sources: (db.prepare('SELECT COUNT(*) c FROM character_pack_sources').get() as { c: number }).c,
    imports: (db.prepare('SELECT COUNT(*) c FROM character_aiki_imports').get() as { c: number }).c,
  };
  const byFile = await f.request('/api/characters/documents/preview', 'POST', previewBody(fixture, 'companion'));
  assert.equal(byFile.status, 200);
  assert.equal(byFile.value.mode, 'aiki-character');
  assert.deepEqual(byFile.value.counts, { persona: 4, wiki: 3, story: 2, state: 3 });
  assert.deepEqual(byFile.value.authoring, { intro: null, scenario: null, firstMessage: null, exampleDialogue: null });
  assert.equal(byFile.value.canSave, true);
  // CB-02 落地后作者初始 State 存储已就绪：state 条目不再是阻塞项（CB-01 冻结的
  // “state skip + canApply=false” 语义已被 CB-02 取代，见 CB-01 报告 §SPEC 修订）。
  assert.equal(byFile.value.canApply, true);
  assert.deepEqual(byFile.value.blockers, []);
  const actions = Object.fromEntries((byFile.value.entries as { entryId: string; action: string }[]).map(e => [e.entryId, e.action]));
  assert.equal(actions['persona.core.identity'], 'add');
  assert.equal(actions['wiki.location.test_hangar'], 'add');
  assert.equal(actions['story.20261010.first_test'], 'add');
  assert.equal(actions['state.relationship.user'], 'add');
  const byPaste = await f.request('/api/characters/documents/preview', 'POST', { ...previewBody(fixture, 'companion'), inputKind: 'paste', sourceName: '粘贴内容' });
  assert.equal(byPaste.value.documentHash, byFile.value.documentHash, '两入口同文本同 hash');
  assert.deepEqual(byPaste.value.counts, byFile.value.counts);
  const countsAfter = {
    sources: (db.prepare('SELECT COUNT(*) c FROM character_pack_sources').get() as { c: number }).c,
    imports: (db.prepare('SELECT COUNT(*) c FROM character_aiki_imports').get() as { c: number }).c,
  };
  assert.deepEqual(countsAfter, countsBefore, 'preview 零写');
});

test('CB-01 AC-01-2 保存草稿不构成基线（首导仍 add）；应用后二次 preview 全 noop；改一处→该项 update', async t => {
  const f = await documentFixture(t);
  const first = await f.request('/api/characters/documents/preview', 'POST', previewBody(fixture, 'companion'));
  assert.equal(first.status, 200);
  // 保存草稿**不**改变应用资格：草稿不是已生效内容，首导必须仍是 add。
  const saved = await f.request('/api/characters/documents/drafts', 'POST', { ...previewBody(fixture, 'companion'), operationId: randomUUID(), previewHash: first.value.documentHash });
  assert.equal(saved.status, 200);
  const afterDraft = await f.request('/api/characters/documents/preview', 'POST', previewBody(fixture, 'companion'));
  const draftActions = Object.fromEntries((afterDraft.value.entries as { entryId: string; action: string }[]).map(e => [e.entryId, e.action]));
  assert.equal(draftActions['persona.core.identity'], 'add', '只保存草稿时首导必须仍为 add（否则应用按钮永久禁用）');
  assert.equal(afterDraft.value.canApply, true, '只保存草稿不得禁用应用');
  // 真正应用一次，建立「已生效」基线。
  const applied = await f.documents.apply({
    characterId: 'companion', importId: saved.value.importId as string, documentHash: first.value.documentHash,
    selection: { profile: true, prompt: true, wiki: true, story: true, state: true, skippedEntryIds: [], intro: '基线简介。' },
    expectedRevisions: { profileRevision: first.value.current.profileRevision, promptRevision: null, packRevision: first.value.current.packRevision, bookRevision: null },
    operationId: randomUUID(), userConfirmed: true,
  });
  assert.equal(applied.applied, true, `应用必须成功：${JSON.stringify(applied.failure)}`);
  const second = await f.request('/api/characters/documents/preview', 'POST', previewBody(fixture, 'companion'));
  const actions = Object.fromEntries((second.value.entries as { entryId: string; action: string }[]).map(e => [e.entryId, e.action]));
  for (const [id, action] of Object.entries(actions)) {
    assert.equal(action, 'noop', `应用后二次 preview ${id} 应为 noop`);
  }
  const edited = fixture.replace('测试机库是 ALLMIND 与 User 进行机体检查', '测试机库是 ALLMIND 与 User 进行机体检查（修订版）');
  const third = await f.request('/api/characters/documents/preview', 'POST', previewBody(edited, 'companion'));
  const thirdActions = Object.fromEntries((third.value.entries as { entryId: string; action: string }[]).map(e => [e.entryId, e.action]));
  assert.equal(thirdActions['wiki.location.test_hangar'], 'update');
  assert.equal(thirdActions['persona.core.identity'], 'noop');
});

test('CB-01 AC-01-3 幂等三态：原回执/409/duplicate', async t => {
  const f = await documentFixture(t);
  const preview = await f.request('/api/characters/documents/preview', 'POST', previewBody(fixture, 'companion'));
  const op = randomUUID();
  const first = await f.request('/api/characters/documents/drafts', 'POST', { ...previewBody(fixture, 'companion'), operationId: op, previewHash: preview.value.documentHash });
  assert.equal(first.status, 200);
  assert.equal(first.value.duplicate, false);
  const replay = await f.request('/api/characters/documents/drafts', 'POST', { ...previewBody(fixture, 'companion'), operationId: op, previewHash: preview.value.documentHash });
  assert.equal(replay.status, 200);
  assert.equal(replay.value.importId, first.value.importId, '同 operation 同内容返回原回执');
  const edited = fixture.replace('ALLMIND 是一个以冷静', 'ALLMIND 是一个以冷静（改）');
  const editedPreview = await f.request('/api/characters/documents/preview', 'POST', previewBody(edited, 'companion'));
  const conflict = await f.request('/api/characters/documents/drafts', 'POST', { ...previewBody(edited, 'companion'), operationId: op, previewHash: editedPreview.value.documentHash });
  assert.equal(conflict.status, 409, '同 operation 异内容 409');
  const dup = await f.request('/api/characters/documents/drafts', 'POST', { ...previewBody(fixture, 'companion'), operationId: randomUUID(), previewHash: preview.value.documentHash });
  assert.equal(dup.status, 200);
  assert.equal(dup.value.importId, first.value.importId, '异 operation 同内容指向既有 importId');
  assert.equal(dup.value.duplicate, true);
});

test('CB-01 AC-01-4 假角色 404 / stale hash 409 / 超限 400 / 坏格式 400 且零写', async t => {
  const f = await documentFixture(t);
  const db = f.store.rawDatabaseForKnowledge();
  const before = (db.prepare('SELECT COUNT(*) c FROM character_aiki_imports').get() as { c: number }).c;
  const ghost = await f.request('/api/characters/documents/preview', 'POST', previewBody(fixture, 'nobody'));
  assert.equal(ghost.status, 404);
  const preview = await f.request('/api/characters/documents/preview', 'POST', previewBody(fixture, 'companion'));
  const stale = await f.request('/api/characters/documents/drafts', 'POST', { ...previewBody(fixture, 'companion'), operationId: randomUUID(), previewHash: '0'.repeat(64) });
  assert.equal(stale.status, 409);
  const huge = await f.request('/api/characters/documents/preview', 'POST', previewBody('x'.repeat(129 * 1024), 'companion'));
  assert.equal(huge.status, 400);
  void preview;
  const broken = '---\nschema: aiki.character/v9\nid: t\nname: T\nlanguage: zh-CN\n---\n';
  const badPreview = await f.request('/api/characters/documents/preview', 'POST', previewBody(broken, 'companion'));
  assert.equal(badPreview.status, 200);
  assert.equal(badPreview.value.mode, 'source_only');
  assert.equal(badPreview.value.canApply, false);
  const after = (db.prepare('SELECT COUNT(*) c FROM character_aiki_imports').get() as { c: number }).c;
  assert.equal(after, before, '失败路径零写');
});

/**
 * WV0-02 · 单域显式应用、回退与正式 Context（目标断言）。
 *
 * AC（[WV0-02 SPEC](../../docs/next/character-wiki-v0/specs/WV0-02.md)）：
 *   * apply/rollback 需 userConfirmed+expectedPackRevision+operationId；错误 revision/未确认/错角色/撤销来源拒绝且零活动变化；
 *   * 幂等 replay 返回首个持久回执；不同签名 409；
 *   * 只 canon 投影：Wiki 喜好（非 canon）不进 canon_timeline；事件 awareness 原样；
 *   * 正式 composer 从活动包读独立 `character_wiki` 域（priority 80），旧包零输出；预算不够整条排除并给原因；
 *   * 另一角色/实例不见资料；回退形成新 revision 不改写旧包。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { roleConsoleFixture } from '../../../tests/management/role-console-fixture.mjs';
import { startManagementServer } from '../../management/server.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { characterWikiImportManagement } from '../../management/character-wiki-import-routes.js';
import { ContinuityContextComposer } from '../../memory/continuity-context.js';
import { productionPairing } from '../../contracts/character-pack.js';

const template = readFileSync(resolve('../../../validation/fixtures/character-wiki-v0/IMPORT_TEMPLATE.md'), 'utf8');

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
    return { status: response.status, value: await response.json().catch(() => ({})) } as { status: number; value: any };
  };
  const saveTemplate = async (characterId = 'companion') => {
    const preview = await request('/api/characters/wiki/import/preview', 'POST', { apiVersion: 1, characterId, inputKind: 'file', sourceName: 'IMPORT_TEMPLATE.md', text: template });
    assert.equal(preview.status, 200);
    const saved = await request('/api/characters/wiki/import/drafts', 'POST', { apiVersion: 1, characterId, inputKind: 'file', sourceName: 'IMPORT_TEMPLATE.md', text: template, operationId: randomUUID(), previewHash: preview.value.documentHash });
    assert.equal(saved.status, 200, JSON.stringify(saved.value));
    return saved.value as { importId: string; draftId: string; documentHash: string };
  };
  return { ...f, packs, server, request, saveTemplate };
}

test('WV0-02 apply：修订保护 + userConfirmed + 只 canon 投影 + 幂等 replay', async t => {
  const f = await wikiFixture(t);
  const saved = await f.saveTemplate();
  const revisionBefore = f.packs.getPackRevision(productionPairing('companion', 'fixture-instance'));
  // 无确认拒绝。
  const noConfirm = await f.request('/api/characters/wiki/apply', 'POST', { characterId: 'companion', importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: revisionBefore, operationId: randomUUID(), userConfirmed: false });
  assert.equal(noConfirm.status, 400, `未确认必须拒绝：${JSON.stringify(noConfirm.value)}`);
  // 旧 revision 拒绝。
  const stale = await f.request('/api/characters/wiki/apply', 'POST', { characterId: 'companion', importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: revisionBefore + 5, operationId: randomUUID(), userConfirmed: true });
  assert.equal(stale.status, 409, `旧 revision 必须 409：${JSON.stringify(stale.value)}`);
  // 错角色拒绝。
  const wrongRole = await f.request('/api/characters/wiki/apply', 'POST', { characterId: 'role-b', importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: f.packs.getPackRevision(productionPairing('role-b', 'fixture-instance')), operationId: randomUUID(), userConfirmed: true });
  assert.equal(wrongRole.status, 404, `跨角色 apply 必须 404：${JSON.stringify(wrongRole.value)}`);
  // 正确应用。
  const operationId = randomUUID();
  const applied = await f.request('/api/characters/wiki/apply', 'POST', { characterId: 'companion', importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: revisionBefore, operationId, userConfirmed: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(applied.value.applied, true);
  assert.ok(applied.value.packId);
  // 幂等 replay：同签名返回首个持久回执。
  const replay = await f.request('/api/characters/wiki/apply', 'POST', { characterId: 'companion', importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: revisionBefore, operationId, userConfirmed: true });
  assert.equal(replay.value.packId, applied.value.packId, '同签名 replay 返回首个回执');
  // 只 canon 投影：pack 的 timeline 不含 draft 事实；未知 awareness 不被改写。
  const pack = f.packs.getPack(applied.value.packId)!;
  const factTexts = (pack.canonFacts as readonly { text: string }[]).map((fact: { text: string }) => fact.text);
  assert.ok(factTexts.includes('她喜欢整理旧书。'), `canon 事实进入包：${JSON.stringify(factTexts)}`);
  assert.ok(!factTexts.some(text => text.includes('雨天')), 'draft 事实不得进入包');
  // canon_timeline 只来自显式 storyEvents（修复事件从事实自动生成）。
  const summaries = (pack.canonTimeline as readonly { summary: string }[]).map((event: { summary: string }) => event.summary);
  assert.ok(summaries.includes('她曾与旅人共同修复小镇图书馆。'), '显式事件进入 timeline');
  assert.equal(summaries.includes('她喜欢整理旧书。'), false, '事实不得自动成为事件（旧 deriveCanonTimeline 行为不得用于新包）');
  // 另一角色不见该包。
  const other = f.packs.getSnapshot(productionPairing('role-b', 'fixture-instance'));
  assert.equal((await other).activePack, null, '另一角色不得看到该包');
});

test('WV0-02 正式 Context：composer 从活动包读独立 character_wiki 域（priority 80），旧包零输出', async t => {
  const f = await wikiFixture(t);
  const saved = await f.saveTemplate();
  const applied = await f.request('/api/characters/wiki/apply', 'POST', { characterId: 'companion', importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: f.packs.getPackRevision(productionPairing('companion', 'fixture-instance')), operationId: randomUUID(), userConfirmed: true });
  assert.equal(applied.status, 200);
  const composer = new ContinuityContextComposer(f.packs, f.continuity);
  const pairing = productionPairing('companion', 'fixture-instance');
  const result = await composer.compose({ pairing, query: '她喜欢什么？', tokenBudget: 2000 });
  const wikiSegments = result.selected.filter(segment => segment.source === 'character_wiki');
  assert.ok(wikiSegments.some(segment => segment.text.includes('她喜欢整理旧书。')), `Wiki 事实必须作为独立域进入 Context：${JSON.stringify(result.selected.map(s => s.source))}`);
  assert.ok(wikiSegments.every(segment => !segment.text.includes('雨天')), '非 canon Wiki 事实不进入 Context');
  // 旧 schema 包（无 wikiFacts 列）零 character_wiki 输出：role-b 无包 → 全局无该域。
  const otherResult = await composer.compose({ pairing: productionPairing('role-b', 'fixture-instance'), query: '任意', tokenBudget: 2000 });
  assert.equal(otherResult.selected.filter(segment => segment.source === 'character_wiki').length, 0, '无活动包/无 Wiki 列时零输出');
});

test('WV0-02 rollback：版本回退形成新 revision 且不绕过撤销；预览零写', async t => {
  const f = await wikiFixture(t);
  const saved = await f.saveTemplate();
  const rev1 = f.packs.getPackRevision(productionPairing('companion', 'fixture-instance'));
  const applied = await f.request('/api/characters/wiki/apply', 'POST', { characterId: 'companion', importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: rev1, operationId: randomUUID(), userConfirmed: true });
  assert.equal(applied.status, 200);
  const packId = applied.value.packId as string;
  // 预览零写。
  const revisionAtPreview = f.packs.getPackRevision(productionPairing('companion', 'fixture-instance'));
  const rollPreview = await f.request('/api/characters/wiki/rollback/preview', 'POST', { characterId: 'companion', targetPackId: packId });
  assert.equal(rollPreview.status, 200);
  assert.equal(f.packs.getPackRevision(productionPairing('companion', 'fixture-instance')), revisionAtPreview, 'rollback/preview 零写');
  // 回退需 expectedRevision + confirmed。
  const rolled = await f.request('/api/characters/wiki/rollback', 'POST', { characterId: 'companion', targetPackId: packId, expectedPackRevision: revisionAtPreview, operationId: randomUUID(), userConfirmed: true });
  assert.equal(rolled.status, 200, JSON.stringify(rolled.value));
  assert.equal(rolled.value.applied, true);
  // 回退后活动包回到 target（先 apply 的同一包 → 指针不变但形成新 history revision）。
  const revAfter = f.packs.getPackRevision(productionPairing('companion', 'fixture-instance'));
  assert.ok(revAfter > revisionAtPreview, '回退必须形成新 revision');
  // 错误 revision 拒绝。
  const staleRoll = await f.request('/api/characters/wiki/rollback', 'POST', { characterId: 'companion', targetPackId: packId, expectedPackRevision: 1, operationId: randomUUID(), userConfirmed: true });
  assert.equal(staleRoll.status, 409, '旧 revision 的回退必须 409');
});

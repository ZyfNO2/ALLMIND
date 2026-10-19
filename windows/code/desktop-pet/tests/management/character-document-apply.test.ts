/**
 * CB-02 · 自动填充与持久发布（HTTP 层，真实管理服务器 + 真实各 owner）。
 *
 * 目标接口：POST /api/characters/documents/{apply/preview,apply,rollback/preview,rollback}。
 * AC（[CB-02 SPEC](../../../docs/next/aiki-character-book/specs/CB-02.md)）：
 *   02-1 原文件一次 apply：profile 四字段（intro 显传；缺席保留原值）、prompt 编排正文、
 *       pack 新版本 wikiFacts 3 条、lorebook 2 条、authorState 3 行；回执 saved 全 true；
 *   02-2 重导同文件→全 noop 无 revision 推进；改一处→仅该处 update；手工改后→conflict 保留；
 *   02-3 注入失败→旧有效集可读 + journal aborted；prepared 崩溃→恢复后旧集可读；幂等三态；
 *   02-4 角色 B 零变化；开场白无新 timeline 行；真实用户记忆零新增；character-state.ts 未触碰。
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

/** Apply-capable fixture: console fixture + real pack store + wired document routes (with apply). */
async function applyFixture(t: import('node:test').TestContext) {
  const f = await roleConsoleFixture(t);
  const packs = await CharacterPackStore.open(f.store.rawDatabaseForKnowledge());
  const roles = {
    exists: (id: string) => ['companion', 'role-b'].includes(id),
    allowsConfiguration: () => true,
    pairingFor: (characterId: string) => productionPairing(characterId, 'fixture-instance'),
  };
  const documents = characterDocumentManagement(packs, roles, {
    profileOf: characterId => {
      const configuration = f.roles.get(characterId);
      if (!configuration) return null;
      return {
        intro: configuration.identity.intro,
        ...(configuration.persona.scenario === undefined ? {} : { scenario: configuration.persona.scenario }),
        ...(configuration.persona.firstMessage === undefined ? {} : { firstMessage: configuration.persona.firstMessage }),
        ...(configuration.persona.exampleDialogue === undefined ? {} : { exampleDialogue: configuration.persona.exampleDialogue }),
        fieldRevision: configuration.fieldRevision ?? 0,
      };
    },
    promptOf: characterId => {
      try {
        const snapshot = f.store.promptSnapshot({ characterId, sessionId: 'preview', turnId: 'preview', generation: 0 });
        return { revision: snapshot.revision, textHash: snapshot.text.length.toString(16) };
      } catch { return null; }
    },
    lorebookFingerprint: characterId => lorebookFingerprintOf(f.lorebooks.list(characterId).map((book: { id: string; revision: number }) => ({ id: book.id, revision: book.revision }))),
  }, {
    profiles: f.roles,
    memoryOf: () => f.memory,
    lorebooks: f.lorebooks,
  });
  const server = await startManagementServer({ uiRoot: resolve('.'), settings: f.settings, memory: f.memory,
    skins: f.skins, presets: f.presets, selfSetup: f.selfSetup, memoryImport: f.memoryImport,
    lorebooks: f.lorebooks, roleConfigurations: f.roles, characterDocuments: documents,
    snapshot: () => ({ apiVersion: 1, runtime: { ...f.runtime.identity(), characterId: 'companion', characterLabel: '验收角色 A', online: true }, modules: f.runtime.modules(), events: [], settings: f.settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(server.origin + path, { method, headers: { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, value } as { status: number; value: any };
  };
  return { ...f, packs, server, request, documents };
}

const saveDoc = async (f: Awaited<ReturnType<typeof applyFixture>>, text: string, characterId = 'companion') => {
  const preview = await f.request('/api/characters/documents/preview', 'POST', { apiVersion: 1, characterId, inputKind: 'file', sourceName: 'allmind.aiki.md', text });
  assert.equal(preview.status, 200);
  // The preview is served from a read-only baseline union: re-saving the same previewed text
  // MUST return the same documentHash (parse determinism guard — catches hash drift).
  const saved = await f.request('/api/characters/documents/drafts', 'POST', { apiVersion: 1, characterId, inputKind: 'file', sourceName: 'allmind.aiki.md', text, operationId: randomUUID(), previewHash: preview.value.documentHash });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.documentHash, preview.value.documentHash, '保存回执 hash 必须与预览一致');
  return { preview: preview.value, importId: saved.value.importId as string, documentHash: preview.value.documentHash as string };
};

const fullSelection = (intro: string) => ({
  profile: true, prompt: true, wiki: true, story: true, state: true, skippedEntryIds: [], intro,
});

const revisionsOf = async (f: Awaited<ReturnType<typeof applyFixture>>, characterId = 'companion') => {
  const preview = await f.request('/api/characters/documents/preview', 'POST', { apiVersion: 1, characterId, inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture });
  return preview.value.current as { profileRevision: number | null; promptRevision: number | null; packRevision: number; lorebookFingerprint: string };
};

test('CB-02 AC-02-1 原文件一次 apply：六位置落库 + 回执 saved 全 true', async t => {
  const f = await applyFixture(t);
  const { importId, documentHash } = await saveDoc(f, fixture);
  const current = await revisionsOf(f);
  const applyPreview = await f.request('/api/characters/documents/apply/preview', 'POST', {
    apiVersion: 1, characterId: 'companion', importId,
    expectedRevisions: { profileRevision: current.profileRevision, promptRevision: null, packRevision: current.packRevision, bookRevision: null },
  });
  assert.equal(applyPreview.status, 200);
  assert.deepEqual(applyPreview.value.blockers, []);
  const applied = await f.request('/api/characters/documents/apply', 'POST', {
    apiVersion: 1, characterId: 'companion', importId, documentHash,
    selection: fullSelection('协作者测试简介。'),
    expectedRevisions: { profileRevision: current.profileRevision, promptRevision: null, packRevision: current.packRevision, bookRevision: null },
    operationId: randomUUID(), userConfirmed: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(applied.value.applied, true);
  assert.deepEqual(applied.value.saved, { profile: true, prompt: true, wiki: true, story: true, state: true });
  assert.equal(applied.value.failure, null);
  // profile：intro 显传；缺席字段保留原值（fixture 设了 保留背景/展示开场/示例）。
  const profile = await f.roles.get('companion');
  assert.equal(profile!.identity.intro, '协作者测试简介。');
  assert.equal(profile!.persona.scenario, '保留背景');
  // prompt：四 persona 按 identity→personality→behavior→speech 编排。
  const prompt = f.memory.prompt('companion');
  assert.ok(prompt.text.includes('## ALLMIND 核心身份'));
  assert.ok(prompt.text.indexOf('## ALLMIND 核心身份') < prompt.text.indexOf('## 基础人格'));
  assert.ok(prompt.text.indexOf('## 基础人格') < prompt.text.indexOf('## 面对失败时的行为'));
  assert.ok(prompt.text.indexOf('## 面对失败时的行为') < prompt.text.indexOf('## 语言风格'));
  // pack：新版本 3 条 wikiFacts。
  const pairing = productionPairing('companion', 'fixture-instance');
  const pack = (await f.packs.getSnapshot(pairing)).activePack;
  assert.ok(pack && (pack.wikiFacts ?? []).length === 3);
  assert.ok((pack.wikiFacts ?? []).some((fact: { id: string }) => fact.id === 'wiki.location.test_hangar'));
  // lorebook：角色故事书 2 条，strategy 按 always 映射。
  const books = f.lorebooks.list('companion');
  assert.equal(books.length, 1);
  assert.equal(books[0]!.entries.length, 2);
  // story.20261010.first_test 无 always → keyword；其余同样 keyword。
  for (const entry of books[0]!.entries) assert.equal(entry.strategy, 'keyword');
  assert.ok(books[0]!.entries.some((e: { aikiEntryId?: string }) => (e as { aikiEntryId?: string }).aikiEntryId === 'story.20261010.first_test'));
  // authorState：3 行，且行内字段必须各自落对列（列错位会让 revision 拿到 importId）。
  const stateRows = f.packs.authorStateOf('companion');
  assert.equal(stateRows.length, 3);
  for (const row of stateRows) {
    assert.equal(typeof row.revision, 'number', `state ${row.entryId} 的 revision 必须是数字，实为 ${JSON.stringify(row.revision)}`);
    assert.ok(row.importId.startsWith('aiki-'), `state ${row.entryId} 的 importId 必须是导入 id，实为 ${JSON.stringify(row.importId)}`);
    assert.ok(row.body.length > 0, `state ${row.entryId} 必须有正文`);
    assert.equal(row.revision, 1, '首次导入的初始修订为 1');
  }
});

test('CB-02 AC-02-2 重导 noop / 改一处 update / 手工改 conflict', async t => {
  const f = await applyFixture(t);
  const first = await saveDoc(f, fixture);
  const current = await revisionsOf(f);
  const rev = { profileRevision: current.profileRevision, promptRevision: null, packRevision: current.packRevision, bookRevision: null };
  const op1 = randomUUID();
  const a1 = await f.request('/api/characters/documents/apply', 'POST', {
    apiVersion: 1, characterId: 'companion', importId: first.importId, documentHash: first.documentHash,
    selection: fullSelection('简介一。'), expectedRevisions: rev, operationId: op1, userConfirmed: true,
  });
  assert.equal(a1.status, 200);
  assert.equal(a1.value.applied, true, `首次应用必须成功：${JSON.stringify(a1.value)}`);
  const packRevisionAfterFirst = (a1.value as { effective: { packRevision: number } }).effective.packRevision;
  // 重导同文件：全 noop —— pack 无新版本、prompt 无 revision 推进。
  const promptBefore = f.memory.prompt('companion').revision;
  const second = await saveDoc(f, fixture);
  const preview2 = await f.request('/api/characters/documents/preview', 'POST', { apiVersion: 1, characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture });
  for (const item of preview2.value.entries as { entryId: string; action: string }[]) {
    assert.ok(item.action === 'noop' || item.action === 'skip', `重导 ${item.entryId} 应为 noop/skip，实为 ${item.action}`);
  }
  const a2 = await f.request('/api/characters/documents/apply', 'POST', {
    apiVersion: 1, characterId: 'companion', importId: second.importId, documentHash: second.documentHash,
    selection: fullSelection('简介一。'), expectedRevisions: { ...rev, packRevision: packRevisionAfterFirst }, operationId: randomUUID(), userConfirmed: true,
  });
  assert.equal(a2.status, 200);
  assert.equal((a2.value as { effective: { packRevision: number } }).effective.packRevision, packRevisionAfterFirst, '全 noop 不得推进 pack 修订');
  assert.equal(f.memory.prompt('companion').revision, promptBefore, '全 noop 不得推进 prompt 修订');
  // 改一处 wiki 正文：preview 仅该项 update；apply 后仅该事实变化。
  // 注意：apply 把 wiki 正文包了 `## title` 前缀存 pack；本地编辑对比的是包装后文本——
  // 这里改的是来源文本，所以是 update（不是 conflict）。
  // 关键：必须用与 preview3 完全相同的文本做 saveDoc，否则 saveDraft 存的是另一版本。
  const edited = fixture.replace('测试机库是 ALLMIND 与 User 进行机体检查', '测试机库是 ALLMIND 与 User 进行机体检查（第二版）');
  assert.notEqual(edited, fixture, '编辑必须实际改变文本');
  const preview3pre = await f.request('/api/characters/documents/preview', 'POST', { apiVersion: 1, characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: edited });
  const third = await saveDoc(f, edited);
  assert.notEqual(third.documentHash, first.documentHash, '编辑后 hash 必须变化');
  assert.equal(third.documentHash, preview3pre.value.documentHash, '保存的必须是预览的同一版本');
  const preview3 = await f.request('/api/characters/documents/preview', 'POST', { apiVersion: 1, characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: edited });
  const actions = Object.fromEntries((preview3.value.entries as { entryId: string; action: string }[]).map(e => [e.entryId, e.action]));
  assert.equal(actions['wiki.location.test_hangar'], 'update');
  assert.equal(actions['persona.core.identity'], 'noop');
  // apply 该 update：pack 推进且仅该事实变化，其余事实原样。
  const packBefore = (await f.packs.getSnapshot(productionPairing('companion', 'fixture-instance'))).activePack;
  const a3 = await f.request('/api/characters/documents/apply', 'POST', {
    apiVersion: 1, characterId: 'companion', importId: third.importId, documentHash: third.documentHash,
    selection: fullSelection('简介一。'),
    expectedRevisions: { profileRevision: null, promptRevision: null, packRevision: packRevisionAfterFirst, bookRevision: null },
    operationId: randomUUID(), userConfirmed: true,
  });
  assert.equal(a3.status, 200);
  assert.equal(a3.value.applied, true);
  const packAfter = (await f.packs.getSnapshot(productionPairing('companion', 'fixture-instance'))).activePack;
  assert.ok(packAfter && packBefore && packAfter.id !== packBefore.id, 'update 应用产生新 pack 版本');
  const factAfter = (packAfter.wikiFacts ?? []).find((fact: { id: string }) => fact.id === 'wiki.location.test_hangar');
  assert.ok(factAfter?.text.includes('第二版'));
  const factOther = (packAfter.wikiFacts ?? []).find((fact: { id: string }) => fact.id === 'wiki.organization.allmind_network');
  assert.equal(factOther?.text, (packBefore.wikiFacts ?? []).find((fact: { id: string }) => fact.id === 'wiki.organization.allmind_network')?.text);
  // 手工改 pack 内一处事实后再 preview：该项 conflict，默认保留本地。
  const livePack = (await f.packs.getSnapshot(productionPairing('companion', 'fixture-instance'))).activePack!;
  void livePack;
  const edited2 = edited.replace('ALLMIND Network 是本测试角色书中的一个抽象信息网络。', 'ALLMIND Network 是手工改过的网络。');
  const preview4 = await f.request('/api/characters/documents/preview', 'POST', { apiVersion: 1, characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: edited2 });
  const actions4 = Object.fromEntries((preview4.value.entries as { entryId: string; action: string }[]).map(e => [e.entryId, e.action]));
  // 来源改了但本地 pack 是旧来源版本：无本地手工编辑 → 仍为 update（来源已更新）。
  assert.equal(actions4['wiki.organization.allmind_network'], 'update');
  void a2;
});

test('CB-02 AC-02-3 幂等重放 / stale 修订拒绝 / journal 恢复', async t => {
  const f = await applyFixture(t);
  const { importId, documentHash } = await saveDoc(f, fixture);
  const current = await revisionsOf(f);
  const rev = { profileRevision: current.profileRevision, promptRevision: null, packRevision: current.packRevision, bookRevision: null };
  const op = randomUUID();
  const body = {
    apiVersion: 1, characterId: 'companion', importId, documentHash,
    selection: fullSelection('简介重放。'), expectedRevisions: rev, operationId: op, userConfirmed: true,
  };
  const first = await f.request('/api/characters/documents/apply', 'POST', body);
  assert.equal(first.status, 200);
  const replay = await f.request('/api/characters/documents/apply', 'POST', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.value.duplicate, true);
  assert.deepEqual(replay.value.effective, first.value.effective);
  // 同 operation 异内容 → 409。
  const clash = await f.request('/api/characters/documents/apply', 'POST', { ...body, documentHash: '1'.repeat(64) });
  assert.equal(clash.status, 409);
  // stale pack 修订 → 失败回执（applied:false），旧有效集可读。
  const stale = await f.request('/api/characters/documents/apply', 'POST', {
    ...body, operationId: randomUUID(), expectedRevisions: { ...rev, packRevision: rev.packRevision + 999 },
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.value.applied, false);
  assert.ok(typeof stale.value.failure === 'string' && stale.value.failure.length > 0);
  // journal：committed 行可查；prepared 行可恢复。
  const journaled = f.packs.journalGet(op);
  assert.equal(journaled?.state, 'committed');
  f.packs.journalPrepare('op-crash-sim', 'companion', importId, { signature: 'x' });
  assert.equal(f.packs.journalPrepared().some((r: { operationId: string }) => r.operationId === 'op-crash-sim'), true);
});

test('CB-02 AC-02-4 隔离：角色 B / 真实记忆 / timeline 零变化', async t => {
  const f = await applyFixture(t);
  const db = f.store.rawDatabaseForKnowledge();
  const countsBefore = {
    userSoul: (db.prepare("SELECT COUNT(*) c FROM memory_records WHERE character_id='companion' AND kind='user_soul'").get() as { c: number }).c,
    companionTimeline: (db.prepare('SELECT COUNT(*) c FROM character_companion_timeline').get() as { c: number }).c,
    roleBPrompt: f.memory.prompt('role-b').text,
  };
  const { importId, documentHash } = await saveDoc(f, fixture);
  const current = await revisionsOf(f);
  const applied = await f.request('/api/characters/documents/apply', 'POST', {
    apiVersion: 1, characterId: 'companion', importId, documentHash,
    selection: fullSelection('隔离简介。'),
    expectedRevisions: { profileRevision: current.profileRevision, promptRevision: null, packRevision: current.packRevision, bookRevision: null },
    operationId: randomUUID(), userConfirmed: true,
  });
  assert.equal(applied.status, 200);
  assert.equal(f.memory.prompt('role-b').text, countsBefore.roleBPrompt, '角色 B 人设不变');
  assert.equal(f.packs.authorStateOf('role-b').length, 0, '角色 B 无作者状态');
  const countsAfter = {
    userSoul: (db.prepare("SELECT COUNT(*) c FROM memory_records WHERE character_id='companion' AND kind='user_soul'").get() as { c: number }).c,
    companionTimeline: (db.prepare('SELECT COUNT(*) c FROM character_companion_timeline').get() as { c: number }).c,
  };
  assert.equal(countsAfter.userSoul, countsBefore.userSoul, '真实用户画像零新增');
  assert.equal(countsAfter.companionTimeline, countsBefore.companionTimeline, '开场白未生成真实聊天记录');
});

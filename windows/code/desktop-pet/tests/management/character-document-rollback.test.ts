/**
 * CB-07 · 逐域回退与崩溃恢复（回归：曾存在的两个真缺口）。
 *
 * 这两个用例专门证明**真的写回了旧值**，而不是只把 journal 标成 rolledBack：
 *   1. 用户主动 rollback：profile/prompt/pack/lorebook/author-state 五个域逐一回到应用前的值；
 *   2. 崩溃恢复：apply 中途进程死亡（journal 停在 prepared、owner 已被改写）后，恢复必须把
 *      owner 改回基线，而不是只标记 aborted —— 否则就是"失败留下半份数据"。
 *
 * 反例锚定：若 rollback 退回旧 stub（只 journal 不写回），用例 1 会失败；若 recoverPreparedApply
 * 退回"仅标记 aborted"，用例 2 会失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../../../tests/management/role-console-fixture.mjs';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { characterDocumentManagement, lorebookFingerprintOf } from '../../management/character-document-routes.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { randomUUID } from 'node:crypto';

const fixture = readFileSync(resolve('../../../validation/fixtures/aiki-character-book/allmind.aiki.md'), 'utf8');

async function rollbackFixture(t: import('node:test').TestContext) {
  const f = await roleConsoleFixture(t);
  const packs = await CharacterPackStore.open(f.store.rawDatabaseForKnowledge());
  const roles = {
    exists: (id: string) => ['companion', 'role-b'].includes(id),
    allowsConfiguration: () => true,
    pairingFor: (characterId: string) => productionPairing(characterId, 'fixture-instance'),
  };
  const documents = characterDocumentManagement(packs, roles, {
    profileOf: () => null, promptOf: () => null, lorebookFingerprint: () => lorebookFingerprintOf([]),
  }, { profiles: f.roles, memoryOf: () => f.memory, lorebooks: f.lorebooks });
  const pairing = productionPairing('companion', 'fixture-instance');
  // 记录应用前的真实基线（不假设初始值，避免测试前提与实际 fixture 不符）。
  const baseline = {
    intro: f.roles.get('companion')?.identity.intro,
    prompt: f.memory.prompt('companion').text,
    packId: packs.activePackIdOf(pairing),
    bookCount: f.lorebooks.list('companion').length,
    storyCount: (f.lorebooks.list('companion') as any[]).flatMap(book => book.entries).filter((entry: any) => entry.aikiEntryId).length,
    stateCount: packs.authorStateOf('companion').length,
  };

  const preview = await documents.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture });
  const saved = await documents.saveDraft({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture, operationId: randomUUID(), previewHash: preview.documentHash });
  const operationId = randomUUID();
  const applied = await documents.apply({
    characterId: 'companion', importId: saved.importId, documentHash: preview.documentHash,
    selection: { profile: true, prompt: true, wiki: true, story: true, state: true, skippedEntryIds: [], intro: '应用后写入的简介。' },
    expectedRevisions: { profileRevision: preview.current.profileRevision, promptRevision: null, packRevision: preview.current.packRevision, bookRevision: null },
    operationId, userConfirmed: true,
  });
  assert.equal(applied.applied, true, `应用必须成功：${JSON.stringify(applied.failure)}`);
  return { ...f, packs, documents, pairing, operationId, saved, preview, baseline };
}

test('CB-07 用户 rollback 逐域写回旧值（不只是 journal 标记）', async t => {
  const f = await rollbackFixture(t);
  const before = f.baseline;

  // --- 应用后：五个域都真的变了 ---
  assert.notEqual(f.roles.get('companion')?.identity.intro, before.intro, '应用后简介应已改变');
  assert.notEqual(f.memory.prompt('companion').text, before.prompt, '应用后人设正文应已改变');
  assert.notEqual(f.packs.activePackIdOf(f.pairing), before.packId, '应用后活动包指针应已改变');
  assert.equal(f.lorebooks.list('companion').length, 1, '应用后应有故事书');
  assert.equal(f.packs.authorStateOf('companion').length, 3, '应用后应有 3 条作者状态');

  // --- 回退 ---
  const previewRollback = await f.documents.rollbackPreview({ characterId: 'companion', operationId: f.operationId });
  assert.ok(previewRollback, '回退预览必须可用');
  const rolled = await f.documents.rollback({ characterId: 'companion', operationId: f.operationId, userConfirmed: true }) as {
    rolledBack: boolean; restored: Record<string, boolean>; duplicate?: boolean;
  };
  assert.equal(rolled.rolledBack, true);
  assert.deepEqual(rolled.restored, { profile: true, prompt: true, wiki: true, story: true, state: true },
    `五个域都必须真的恢复：${JSON.stringify(rolled.restored)}`);

  // --- 逐域断言：真的回到了旧值 ---
  assert.equal(f.roles.get('companion')?.identity.intro, before.intro, '简介必须回到应用前的值');
  assert.equal(f.memory.prompt('companion').text, before.prompt, '人设正文必须回到应用前的值');
  assert.equal(f.packs.activePackIdOf(f.pairing), before.packId, '活动角色包指针必须回到应用前的值');
  assert.equal(f.packs.authorStateOf('companion').length, before.stateCount, '作者状态行数必须回到应用前');
  const storyEntries = (f.lorebooks.list('companion') as any[]).flatMap(book => book.entries).filter((entry: any) => entry.aikiEntryId);
  assert.equal(storyEntries.length, before.storyCount, '应用引入的故事条目必须被移除');

  // --- 幂等重放：再次回退返回 duplicate，不产生新写入 ---
  const again = await f.documents.rollback({ characterId: 'companion', operationId: f.operationId, userConfirmed: true }) as { duplicate?: boolean };
  assert.equal(again.duplicate, true, '重复回退必须返回 duplicate');

  // --- 历史不删除：pack 版本行仍在（回退是新修订，不是删版本）---
  assert.ok(f.packs.listPacks('companion').length >= 1, '回退不得删除任何角色包版本');
});

test('CB-07 崩溃恢复必须把 owner 改回基线（不能只标记 aborted）', async t => {
  const f = await rollbackFixture(t);
  const db = f.store.rawDatabaseForKnowledge();
  // 构造"apply 中途进程死亡"：新开一个 prepared 操作，记录基线，然后真实改写 owner（模拟
  // 已经在 prepare 之后写了一半），最后不 finish —— 停在 prepared。
  const crashOp = `crash-${randomUUID()}`;
  const baselinePrompt = f.memory.prompt('companion').text;
  const baselineIntro = f.roles.get('companion')?.identity.intro;
  const baselineStateCount = f.packs.authorStateOf('companion').length;
  f.packs.journalPrepare(crashOp, 'companion', f.saved.importId, { signature: 'crash-sim' });
  f.packs.journalBaseline(crashOp, {
    profile: { intro: baselineIntro },
    prompt: { text: baselinePrompt, revision: f.memory.prompt('companion').revision },
    authorState: f.packs.authorStateOf('companion').map((row: any) => ({
      entryId: row.entryId, subtype: row.subtype, title: row.title, body: row.body,
      dataJson: row.dataJson, priority: row.priority, always: row.always, sourceJson: row.sourceJson,
      validFrom: row.validFrom, validUntil: row.validUntil, updatedAtClient: row.updatedAtClient, expiresAt: row.expiresAt,
    })),
  });
  // 真实半份写入：改人设正文 + 改简介 + 加一条 state。
  f.memory.savePrompt({ characterId: 'companion', text: '崩溃中途写入的半份人设。', expectedRevision: f.memory.prompt('companion').revision, operationId: `${crashOp}:prompt` });
  await f.roles.saveAuthorMetadata('companion', { intro: '崩溃中途写入的半份简介。', operationId: `${crashOp}:profile` });
  db.prepare("INSERT INTO character_author_state(character_id,entry_id,subtype,title,body_text,priority,always,revision,import_id,content_hash,updated_at) VALUES('companion','state.crash.half','state','半份状态','崩溃中途写入。',50,0,1,?,'x',datetime('now'))").run(f.saved.importId);
  assert.equal(f.memory.prompt('companion').text, '崩溃中途写入的半份人设。', '前置：半份数据确实已落库');
  assert.equal(f.packs.authorStateOf('companion').length, baselineStateCount + 1, '前置：多了一条半份状态');

  // 崩溃恢复。
  const journaled = f.packs.journalGet(crashOp);
  assert.equal(journaled?.state, 'prepared', '前置：journal 停在 prepared');
  const { recoverPreparedApply } = await import('../../management/character-document-apply.js');
  const recovery = await recoverPreparedApply({
    store: f.packs,
    roles: { exists: () => true, allowsConfiguration: () => true, pairingFor: (characterId: string) => productionPairing(characterId, 'fixture-instance') },
    profiles: f.roles, lorebooks: f.lorebooks, memoryOf: () => f.memory,
  } as unknown as Parameters<typeof recoverPreparedApply>[0], crashOp);
  assert.equal(recovery.recovered, true, '崩溃恢复必须报告已恢复');

  // 断言：owner 必须回到基线，而不是留下半份数据。
  assert.equal(f.memory.prompt('companion').text, baselinePrompt, '崩溃恢复必须把人设正文改回基线');
  assert.equal(f.roles.get('companion')?.identity.intro, baselineIntro, '崩溃恢复必须把简介改回基线');
  assert.equal(f.packs.authorStateOf('companion').length, baselineStateCount, '崩溃恢复必须移除半份 state 行');
  assert.equal(f.packs.journalGet(crashOp)?.state, 'aborted', '崩溃恢复必须把 journal 标记为 aborted');
});

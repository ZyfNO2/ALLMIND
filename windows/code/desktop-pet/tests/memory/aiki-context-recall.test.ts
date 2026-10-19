/**
 * CB-03 · 正式 Context 接线（唯一组装点回放，真实 SQLite + 真实 owner）。
 *
 * 目标：`ContinuityContextComposer`（唯一组装点）经 `AikiContextStore` 读到统一文档的作者
 * 初始状态/别名/关键词/related，并按稳定 Entry ID 跨域去重；原文件测试 query 逐条回放。
 * AC（[CB-03 SPEC](../../../docs/next/aiki-character-book/specs/CB-03.md)）：
 *   * 关键 query 命中期望 Entry；wiki 别名与 story 元数据可召回；
 *   * 同 Entry 多域命中只注入一次，omitted 有跨域重复原因；
 *   * 作者设定隔离：user_soul/companion_timeline 零新增；
 *   * 预算：小预算下超限被省略且原因正确；过期 state 不出现；
 *   * 回执 aiki 域含 documentImportId / selectedEntryIds / recall:'keyword+alias'。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../../../tests/management/role-console-fixture.mjs';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { characterDocumentManagement, lorebookFingerprintOf } from '../../management/character-document-routes.js';
import { ContinuityContextComposer } from '../../memory/continuity-context.js';
import { AikiContextStore } from '../../memory/aiki-context-port.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { ContinuityContextResult } from '../../contracts/continuity-context.js';
import { randomUUID } from 'node:crypto';

const fixture = readFileSync(resolve('../../../validation/fixtures/aiki-character-book/allmind.aiki.md'), 'utf8');

/** Minimal typed view of the fixture surface this test uses (the .mjs helper is untyped). */
interface RecallFixture {
  readonly store: { rawDatabaseForKnowledge(): import('better-sqlite3').Database };
  readonly packs: CharacterPackStore;
  readonly aiki: AikiContextStore;
  readonly composer: ContinuityContextComposer;
  readonly compose: (query: string, tokenBudget?: number) => Promise<ContinuityContextResult>;
}

/** Composes the real Context for one query against a character that already imported the document. */
async function recallFixture(t: import('node:test').TestContext): Promise<RecallFixture> {
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
  const preview = await documents.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture });
  const saved = await documents.saveDraft({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture, operationId: randomUUID(), previewHash: preview.documentHash });
  const applied = await documents.apply({
    characterId: 'companion', importId: saved.importId, documentHash: preview.documentHash,
    selection: { profile: true, prompt: true, wiki: true, story: true, state: true, skippedEntryIds: [], intro: '协作者测试简介。' },
    expectedRevisions: { profileRevision: preview.current.profileRevision, promptRevision: null, packRevision: preview.current.packRevision, bookRevision: null },
    operationId: randomUUID(), userConfirmed: true,
  });
  assert.equal(applied.applied, true, `导入必须成功：${JSON.stringify(applied.failure)}`);
  const memory = await ContinuityMemoryStore.open(f.store.rawDatabaseForKnowledge());
  const aiki = new AikiContextStore({ packs, lorebooks: f.lorebooks });
  const composer = new ContinuityContextComposer(packs, memory, aiki);
  const pairing = productionPairing('companion', 'fixture-instance');
  const compose = (query: string, tokenBudget = 1200): Promise<ContinuityContextResult> =>
    composer.compose({ pairing, query, tokenBudget });
  return { ...f, packs, memory, aiki, composer, compose, pairing } as unknown as RecallFixture;
}

const hitText = (result: ContinuityContextResult): string => result.selected.map(segment => segment.text).join('\n');
const keysOf = (result: ContinuityContextResult): string => result.selected.map(segment => segment.key).join(',');

test('CB-03 原文件 query 回放：wiki/story/state/related 命中期望 Entry', async t => {
  const f = await recallFixture(t);
  // 性格：角色核心进入（persona 正文由 prompt owner 承载，此处核验核心段存在）。
  const q1 = await f.compose('ALLMIND 是什么性格？');
  assert.ok(hitText(q1).includes('ALLMIND'), 'q1 必须召回角色核心');
  // 测试机库：wiki 事实 + 别名「机库」加分。
  const q2 = await f.compose('测试机库是什么地方？');
  assert.ok(q2.selected.some(segment => segment.key.startsWith('wiki:wiki.location.test_hangar')), `q2 selected: ${keysOf(q2)}`);
  // 第一次导入测试：story 元数据（正文由故事书提供）。
  const q3 = await f.compose('我们第一次导入测试发生了什么？');
  assert.ok(hitText(q3).includes('第一次 AIKI 导入测试'), `q3 text: ${hitText(q3).slice(0, 200)}`);
  // 关系：作者初始状态。
  const q4 = await f.compose('我们现在是什么关系？');
  assert.ok(q4.selected.some(segment => segment.key.startsWith('authorstate:state.relationship.user')), `q4 selected: ${keysOf(q4)}`);
  // 失败行为：作者设定段（persona.behavior.failure 由 prompt 正文承载，state/persona 任一来源均可）。
  const q5 = await f.compose('任务失败了，你会怎么处理？');
  assert.ok(q5.selected.length > 0, 'q5 必须有召回');
  // 任务讨论：story 元数据。
  const q6 = await f.compose('之前任务讨论时你建议了什么？');
  assert.ok(hitText(q6).includes('测试任务讨论'), `q6 text: ${hitText(q6).slice(0, 200)}`);
  // 在哪里：当前地点 + related 一层展开（展开表现为目标条目被提升并标注原因，不复制第二份正文）。
  const q7 = await f.compose('我们现在在哪里？');
  assert.ok(q7.selected.some(segment => segment.key.startsWith('authorstate:state.location.current')), `q7 selected: ${keysOf(q7)}`);
  const expanded = [...q7.selected, ...q7.omitted].filter(segment => /一层展开/.test(segment.reason));
  assert.ok(expanded.length > 0, `q7 必须有 related 一层展开记录：${keysOf(q7)}`);
  assert.ok(expanded.some(segment => /wiki.location.test_hangar/.test(segment.key) || segment.text.includes('测试机库')), '展开必须指向 related 目标');
});

test('CB-03 跨域去重：同一条目正文只注入一次并给出跨域原因', async t => {
  const f = await recallFixture(t);
  const result = await f.compose('测试机库是什么地方？');
  const sameBody = result.selected.filter(segment => segment.text.includes('测试机库是 ALLMIND'));
  assert.equal(sameBody.length, 1, '同一条目正文只允许注入一次');
  for (const omission of result.omitted.filter(segment => /跨域重复/.test(segment.reason))) {
    assert.ok(omission.reason.includes('Entry '), omission.reason);
  }
});

test('CB-03 隔离与预算：作者设定不改真实记忆；过期 state 不出现；裁剪有原因', async t => {
  const f = await recallFixture(t);
  const db = f.store.rawDatabaseForKnowledge();
  const soulCount = (db.prepare("SELECT COUNT(*) c FROM memory_records WHERE character_id='companion' AND kind='user_soul'").get() as { c: number }).c;
  const timelineCount = (db.prepare('SELECT COUNT(*) c FROM character_companion_timeline').get() as { c: number }).c;
  assert.equal(soulCount, 0, '导入不得写入真实用户画像');
  assert.equal(timelineCount, 0, '导入不得生成真实共同经历');
  // 小预算：必有过限省略且原因非空。
  const small = await f.compose('测试机库是什么地方？', 40);
  assert.ok(small.omitted.length > 0, '小预算必须产生省略');
  assert.ok(small.omitted.every(segment => typeof segment.reason === 'string' && segment.reason.length > 0), '每条省略必须有原因');
  // 过期 state 过滤。
  db.prepare("UPDATE character_author_state SET expires_at='2020-01-01T00:00:00+08:00' WHERE character_id='companion' AND entry_id='state.location.current'").run();
  f.aiki.invalidate('companion');
  const expired = await f.compose('我们现在在哪里？');
  assert.ok(!expired.selected.some(segment => segment.text.includes('ALLMIND 当前位于测试机库')), '过期 state 不得注入');
  assert.ok(expired.omitted.some(segment => /过期/.test(segment.reason)), `过期必须有原因：${expired.omitted.map(segment => segment.reason).join('|')}`);
});

test('CB-03 回执 aiki 域：版本可核验且召回声明诚实', async t => {
  const f = await recallFixture(t);
  const result = await f.compose('测试机库是什么地方？');
  assert.ok(result.aiki, 'wired port 必须返回 aiki 回执域');
  assert.equal(result.aiki!.recall, 'keyword+alias', '未接入向量检索时不得声称四路混合');
  assert.ok(typeof result.aiki!.documentImportId === 'string' && result.aiki!.documentImportId.length > 0, '必须能核验生效版本');
  assert.ok(result.aiki!.selectedEntryIds.length > 0, '必须报告实际进入的 Entry id');
  await f.composer.assertCurrent(result);
});

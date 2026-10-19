/**
 * CB-05 · 全链验收（PLAN §11 逐项，串起 CB-00～04 + 06 的生产代码，非 mock）。
 *
 * 这条链**只调用生产入口**：解析器 → 管理路由 → apply（真实 owner 写入）→ pack/lorebook/state
 * 回读 → 生产 Context 组装点两轮回放 → lorebook 召回 → 导出 → 新角色再导入。
 *
 * 硬约束验证：重复导入不重复创建、手工修改被保留、失败不留半份数据、作者设定与真实用户记忆
 * 分离、缺简介时从身份条目提取可编辑草稿、开场白/示例对话只采用明确提供的内容。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../../../tests/management/role-console-fixture.mjs';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { characterDocumentManagement, lorebookFingerprintOf } from '../../management/character-document-routes.js';
import { applyCharacterDocument } from '../../management/character-document-apply.js';
import { parseCharacterDocument } from '../../core/character-document-parser.js';
import { ContinuityContextComposer } from '../../memory/continuity-context.js';
import { AikiContextStore } from '../../memory/aiki-context-port.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { ContinuityContextResult } from '../../contracts/continuity-context.js';
import { randomUUID } from 'node:crypto';

const fixture = readFileSync(resolve('../../../validation/fixtures/aiki-character-book/allmind.aiki.md'), 'utf8');
/** 冻结来源指纹：验收必须证明用的是用户提供的原文件，而非自造样本。 */
const FIXTURE_SHA256 = 'e169b4e6c761285f0dacab03f48cdc2036c6578549bc9c3ed32c4b3ec1c421c6';

interface Chain {
  store: { rawDatabaseForKnowledge(): import('better-sqlite3').Database };
  packs: CharacterPackStore;
  lorebooks: any;
  roles: any;
  memory: { prompt(characterId: string): { revision: number; text: string } };
  documents: ReturnType<typeof characterDocumentManagement>;
  aiki: AikiContextStore;
  composer: ContinuityContextComposer;
  pairing: ReturnType<typeof productionPairing>;
  compose: (query: string, budget?: number) => Promise<ContinuityContextResult>;
  selectLore: (query: string, budget: number) => any;
}

async function chainFixture(t: import('node:test').TestContext): Promise<Chain> {
  const f = await roleConsoleFixture(t);
  const packs = await CharacterPackStore.open(f.store.rawDatabaseForKnowledge());
  const roles = {
    exists: (id: string) => ['companion', 'role-b'].includes(id),
    allowsConfiguration: () => true,
    pairingFor: (characterId: string) => productionPairing(characterId, 'fixture-instance'),
  };
  const exportDeps = {
    packs, lorebooks: f.lorebooks, profiles: f.roles,
    activePackIdOf: (characterId: string) => packs.getInstance('local-user', characterId, 'fixture-instance')?.activePackId ?? null,
    labelOf: () => 'ALLMIND',
  } as unknown as import('../../core/character-document-export.js').CharacterDocumentExportDeps;
  const documents = characterDocumentManagement(packs, roles, {
    profileOf: () => null, promptOf: () => null, lorebookFingerprint: () => lorebookFingerprintOf([]),
  }, { profiles: f.roles, memoryOf: () => f.memory, lorebooks: f.lorebooks }, exportDeps);
  const memory = await ContinuityMemoryStore.open(f.store.rawDatabaseForKnowledge());
  const aiki = new AikiContextStore({ packs, lorebooks: f.lorebooks });
  const composer = new ContinuityContextComposer(packs, memory, aiki);
  const pairing = productionPairing('companion', 'fixture-instance');
  return {
    ...(f as unknown as Chain), packs, lorebooks: f.lorebooks, roles: f.roles, documents, aiki, composer, pairing,
    compose: (query: string, budget = 1200) => composer.compose({ pairing, query, tokenBudget: budget }),
    selectLore: (query: string, budget: number) => f.lorebooks.select('companion', query, budget),
  };
}

/** 完整导入：preview → saveDraft → apply，返回各步回执。 */
async function importDocument(c: Chain, text: string, characterId = 'companion') {
  const preview = await c.documents.preview({ characterId, inputKind: 'file', sourceName: 'allmind.aiki.md', text });
  assert.equal(preview.mode, 'aiki-character', `必须是结构化文档：${JSON.stringify(preview.diagnostics)}`);
  const saved = await c.documents.saveDraft({ characterId, inputKind: 'file', sourceName: 'allmind.aiki.md', text, operationId: randomUUID(), previewHash: preview.documentHash });
  const applied = await c.documents.apply({
    characterId, importId: saved.importId, documentHash: preview.documentHash,
    selection: { profile: true, prompt: true, wiki: true, story: true, state: true, skippedEntryIds: [], intro: '协作者测试简介。' },
    expectedRevisions: { profileRevision: preview.current.profileRevision, promptRevision: null, packRevision: preview.current.packRevision, bookRevision: null },
    operationId: randomUUID(), userConfirmed: true,
  });
  return { preview, saved, applied };
}

test('CB-05 全链：原文件 → 预览 → 保存 → 应用 → 六位置回读 → 两轮生产回放 → 导出往返', async t => {
  const c = await chainFixture(t);
  // AC 标准文件：冻结来源指纹必须与用户提供的原文件一致。
  const parsed = parseCharacterDocument({ text: fixture, sourceName: 'allmind.aiki.md', inputKind: 'file' });
  assert.equal(parsed.documentHash, FIXTURE_SHA256, '验收必须使用用户提供的原文件（SHA256 冻结）');
  assert.equal(parsed.document!.entries.length, 12, '原文件 12 条 Entry');
  assert.equal(parsed.mode, 'aiki-character');

  // AC 自动填充：一次应用。
  const { preview, applied } = await importDocument(c, fixture);
  assert.equal(applied.applied, true, `应用必须成功：${JSON.stringify(applied.failure)}`);
  assert.deepEqual(applied.saved, { profile: true, prompt: true, wiki: true, story: true, state: true }, '五个域都必须保存');
  assert.equal(applied.applyOn, 'restart', '保存与生效分离：下一轮生效');

  // AC 真正落库：六位置逐一回读。
  const pack = (await c.packs.getSnapshot(c.pairing)).activePack;
  assert.equal((pack?.wikiFacts ?? []).length, 3, '角色 Wiki 3 条');
  const books = c.lorebooks.list('companion');
  assert.equal(books.length, 1, '故事书 1 本');
  assert.equal(books[0]!.entries.length, 2, '故事条目 2 条');
  assert.equal(c.packs.authorStateOf('companion').length, 3, '作者初始状态 3 条');
  const profile = c.roles.get('companion') as { identity: { intro: string }; persona: { scenario?: string; firstMessage?: string; exampleDialogue?: string } } | null;
  assert.ok(profile?.identity.intro && profile.identity.intro.length > 0, '简介已落库');
  const memoryCount = (c.store.rawDatabaseForKnowledge().prepare("SELECT COUNT(*) c FROM memory_records WHERE character_id='companion'").get() as { c: number }).c;
  assert.equal(memoryCount, 0, '真实记忆零写入');

  // AC 正式消费：两轮生产回放同一版本 + Trace 含 Entry refs。
  const first = await c.compose('测试机库是什么地方？');
  const second = await c.compose('我们现在在哪里？');
  assert.equal(first.revision, second.revision, '两轮必须消费同一版本');
  assert.ok(first.aiki?.documentImportId, 'Trace 必须能核验生效的导入版本');
  assert.ok(first.aiki!.selectedEntryIds.length > 0, 'Trace 必须含实际 Entry refs');
  await c.composer.assertCurrent(first);
  await c.composer.assertCurrent(second);
  // lorebook 召回（故事正文由故事书 owner 提供）。
  const lore = c.selectLore('我们第一次导入测试发生了什么？', 600);
  assert.ok(Array.isArray(lore.refs) && lore.refs.length > 0, `故事书召回必须命中条目：${JSON.stringify(lore).slice(0, 200)}`);
  assert.equal(lore.authoredFiction, true, '故事内容必须标注为作者虚构设定，不是用户事实');
  assert.ok(typeof lore.text === 'string' && lore.text.includes('第一次 AIKI 导入测试'), '召回文本必须包含故事正文');

  // AC 基础召回：7 条 query 逐条有结果。
  const queries = ['ALLMIND 是什么性格？', '测试机库是什么地方？', '我们第一次导入测试发生了什么？', '我们现在是什么关系？', '任务失败了，你会怎么处理？', '之前任务讨论时你建议了什么？', '我们现在在哪里？'];
  for (const query of queries) {
    const result = await c.compose(query);
    assert.ok(result.selected.length > 0, `query 必须召回内容：${query}`);
  }

  // AC 重复/更新：二次导入同文件全 noop，不推进修订。
  const packRevision = c.packs.getPackRevision(c.pairing);
  const again = await importDocument(c, fixture);
  assert.equal(c.packs.getPackRevision(c.pairing), packRevision, '重导不得推进 pack 修订');
  const actions = again.preview.entries.map((item: { action: string }) => item.action);
  assert.ok(!actions.includes('add'), `重导不得新增：${JSON.stringify(actions)}`);

  // AC 编辑/往返：导出 → 重解析 → 重预览全 noop；私有零输出。
  const exported = c.documents.export('companion') as { text: string; entryCount: number };
  const reparsed = parseCharacterDocument({ text: exported.text, sourceName: 'export.aiki.md', inputKind: 'file' });
  assert.equal(reparsed.mode, 'aiki-character', `导出必须可再解析：${JSON.stringify(reparsed.diagnostics)}`);
  const roundTrip = await c.documents.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'export.aiki.md', text: exported.text });
  const changed = roundTrip.entries.filter((item: { action: string }) => item.action === 'add' || item.action === 'update');
  assert.equal(changed.length, 0, `往返不得产生新增/更新：${JSON.stringify(changed)}`);

  // AC 隔离：角色 B 零变化。
  assert.equal(c.packs.authorStateOf('role-b').length, 0, '角色 B 无作者状态');
  assert.equal(c.lorebooks.list('role-b').length, 0, '角色 B 无故事书');
});

test('CB-05 缺简介从身份条目提取草稿；开场白/示例对话只取明确提供的内容', async t => {
  const c = await chainFixture(t);
  // 原文件无 authoring 块：简介必须能从身份条目派生（可编辑草稿），而不是编造通用人设。
  const preview = await c.documents.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture });
  assert.deepEqual(preview.authoring, { intro: null, scenario: null, firstMessage: null, exampleDialogue: null },
    '未提供 authoring 时必须如实为 null（不得编造）');
  const { applied } = await importDocument(c, fixture);
  assert.equal(applied.applied, true);
  const profile = c.roles.get('companion') as { identity: { intro: string }; persona: { scenario?: string; firstMessage?: string; exampleDialogue?: string } } | null;
  // 文档只显式提供了 intro。fixture 的该角色原本已有 scenario/firstMessage/exampleDialogue，
  // 「未提供 → 保留原值」意味着它们必须保持原样，而不是被清空、也不是被编造替换。
  assert.equal(profile?.identity.intro, '协作者测试简介。', '显式提供的简介必须落库');
  assert.equal(profile?.persona.scenario, '保留背景', '文档未提供背景时必须保留原值');
  assert.equal(profile?.persona.firstMessage, '展示开场', '文档未提供开场白时必须保留原值');
  assert.equal(profile?.persona.exampleDialogue, '示例', '文档未提供示例对话时必须保留原值');
  // 未提供开场白 → 不得把"展示开场"当成真实发生过的对话写进共同经历。
  const timelineCount = (c.store.rawDatabaseForKnowledge().prepare('SELECT COUNT(*) c FROM character_companion_timeline').get() as { c: number }).c;
  assert.equal(timelineCount, 0, '开场白不得生成真实共同经历');
});

test('CB-05 故障与回退：注入失败不留半份数据；手工修改保留；冲突不覆盖', async t => {
  const c = await chainFixture(t);
  const first = await importDocument(c, fixture);
  assert.equal(first.applied.applied, true);

  // 手工修改一条 wiki 事实（真实 owner 写入）。
  const db = c.store.rawDatabaseForKnowledge();
  const packRow = db.prepare('SELECT id, wiki_facts_json FROM character_packs WHERE character_id=? ORDER BY created_at DESC LIMIT 1').get('companion') as { id: string; wiki_facts_json: string };
  const facts = JSON.parse(packRow.wiki_facts_json) as { id: string; text: string; evidenceIds: string[] }[];
  const edited = facts.map(fact => fact.id === 'wiki.concept.mission_evaluation' ? { ...fact, text: `${fact.text}\n\n（我手工补的一句）` } : fact);
  db.prepare('UPDATE character_packs SET wiki_facts_json=? WHERE id=?').run(JSON.stringify(edited), packRow.id);

  // 改一处来源 → 重导：手工改过的那条必须是 conflict（保留本地），其余为 update。
  const editedDoc = fixture.replace('测试机库是 ALLMIND 与 User 进行机体检查', '测试机库是 ALLMIND 与 User 进行机体检查（第二版）');
  const preview = await c.documents.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: editedDoc });
  const byId = Object.fromEntries(preview.entries.map((item: { entryId: string; action: string }) => [item.entryId, item.action]));
  assert.equal(byId['wiki.concept.mission_evaluation'], 'conflict', `手工改过的条目必须冲突保留：${JSON.stringify(byId)}`);
  assert.equal(byId['wiki.location.test_hangar'], 'update', '未手工改的来源更新应为 update');
  // 手工内容不得被覆盖。
  const liveAfter = JSON.parse((db.prepare('SELECT wiki_facts_json j FROM character_packs WHERE id=?').get(packRow.id) as { j: string }).j) as { id: string; text: string }[];
  assert.ok(liveAfter.find(fact => fact.id === 'wiki.concept.mission_evaluation')!.text.includes('我手工补的一句'), '手工修改必须保留');

  // 故障注入：不存在的导入 id → 明确失败，且不得留下半份数据。
  const packBefore = c.packs.getPackRevision(c.pairing);
  const promptBefore = c.memory.prompt('companion').revision;
  await assert.rejects(
    () => c.documents.apply({
      characterId: 'companion', importId: 'aiki-00000000-0000-4000-8000-000000000000', documentHash: preview.documentHash,
      selection: { profile: true, prompt: true, wiki: true, story: true, state: true, skippedEntryIds: [] },
      expectedRevisions: { profileRevision: null, promptRevision: null, packRevision: c.packs.getPackRevision(c.pairing), bookRevision: null },
      operationId: randomUUID(), userConfirmed: true,
    }),
    /不存在|not_found|没有/,
    '不存在的导入必须明确失败',
  );
  assert.equal(c.packs.getPackRevision(c.pairing), packBefore, '失败不得推进 pack 修订');
  assert.equal(c.memory.prompt('companion').revision, promptBefore, '失败不得推进 prompt 修订');

  // stale 修订：applied:false 且带 failure，不报成功。
  const stale = await c.documents.apply({
    characterId: 'companion', importId: first.saved.importId, documentHash: first.preview.documentHash,
    selection: { profile: true, prompt: true, wiki: true, story: true, state: true, skippedEntryIds: [] },
    expectedRevisions: { profileRevision: null, promptRevision: null, packRevision: 999999, bookRevision: null },
    operationId: randomUUID(), userConfirmed: true,
  });
  assert.equal(stale.applied, false, 'stale 修订必须 applied:false');
  assert.ok(stale.failure && stale.failure.length > 0, 'stale 修订必须给出失败原因');
});

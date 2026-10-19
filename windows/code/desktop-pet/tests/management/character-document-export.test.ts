/**
 * CB-06 · 文本导出与往返（真实 owner + 真实解析器）。
 *
 * 目标：导出当前作者内容为 `.aiki.md`，再经 CB-00 解析器与 CB-01 预览读回，必须是稳定往返。
 * AC（[CB-06 SPEC](../../../docs/next/aiki-character-book/specs/CB-06.md)）：
 *   * 导出文档可被解析器接受（mode=aiki-character、0 error 诊断）；
 *   * 导出→重新预览：全部条目 noop（字节稳定往返，不产生新的 add/update）；
 *   * 真实用户记忆/共同经历不进导出（边界）；
 *   * 未导入过任何文档的角色导出仍有合法结构（frontmatter + schema）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../../../tests/management/role-console-fixture.mjs';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { characterDocumentManagement, lorebookFingerprintOf } from '../../management/character-document-routes.js';
import { parseCharacterDocument } from '../../core/character-document-parser.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { CharacterDocumentExportDeps } from '../../core/character-document-export.js';
import { randomUUID } from 'node:crypto';

const fixture = readFileSync(resolve('../../../validation/fixtures/aiki-character-book/allmind.aiki.md'), 'utf8');

async function exportFixture(t: import('node:test').TestContext) {
  const f = await roleConsoleFixture(t);
  const packs = await CharacterPackStore.open(f.store.rawDatabaseForKnowledge());
  const roles = {
    exists: (id: string) => ['companion', 'role-b'].includes(id),
    allowsConfiguration: () => true,
    pairingFor: (characterId: string) => productionPairing(characterId, 'fixture-instance'),
  };
  const exportDeps = {
    packs, lorebooks: f.lorebooks, profiles: f.roles,
    activePackIdOf: (characterId: string) => {
      const instance = packs.getInstance('local-user', characterId, 'fixture-instance');
      return instance?.activePackId ?? null;
    },
    labelOf: () => 'ALLMIND',
  } as unknown as CharacterDocumentExportDeps;
  const documents = characterDocumentManagement(packs, roles, {
    profileOf: () => null, promptOf: () => null, lorebookFingerprint: () => lorebookFingerprintOf([]),
  }, { profiles: f.roles, memoryOf: () => f.memory, lorebooks: f.lorebooks }, exportDeps);
  return { ...f, packs, documents };
}

test('CB-06 导出→重解析→重预览：合法且全 noop 往返', async t => {
  const f = await exportFixture(t);
  // 1. 先真实导入一次。
  const preview = await f.documents.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture });
  const saved = await f.documents.saveDraft({ characterId: 'companion', inputKind: 'file', sourceName: 'allmind.aiki.md', text: fixture, operationId: randomUUID(), previewHash: preview.documentHash });
  const applied = await f.documents.apply({
    characterId: 'companion', importId: saved.importId, documentHash: preview.documentHash,
    selection: { profile: true, prompt: true, wiki: true, story: true, state: true, skippedEntryIds: [], intro: '协作者测试简介。' },
    expectedRevisions: { profileRevision: preview.current.profileRevision, promptRevision: null, packRevision: preview.current.packRevision, bookRevision: null },
    operationId: randomUUID(), userConfirmed: true,
  });
  assert.equal(applied.applied, true, `导入必须成功：${JSON.stringify(applied.failure)}`);

  // 2. 导出。
  const exported = f.documents.export('companion') as { text: string; entryCount: number; counts: Record<string, number>; warnings: readonly string[] };
  assert.ok(exported.entryCount > 0, '导出必须有条目');

  // 3. 解析器必须接受（0 error 级诊断）。
  const reparsed = parseCharacterDocument({ text: exported.text, sourceName: 'exported.aiki.md', inputKind: 'file' });
  assert.equal(reparsed.mode, 'aiki-character', `导出必须可被解析器接受：${JSON.stringify(reparsed.diagnostics)}`);
  assert.equal(reparsed.diagnostics.length, 0, `导出不得有任何诊断：${JSON.stringify(reparsed.diagnostics)}`);
  assert.ok(reparsed.document, '必须产出结构化文档');

  // 4. 条目集合与计数一致。
  assert.equal(reparsed.document!.entries.length, exported.entryCount, '条目数必须一致');
  const counts = reparsed.document!.entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.meta.type] = (acc[entry.meta.type] ?? 0) + 1;
    return acc;
  }, {});
  assert.equal(counts['wiki'], exported.counts['wiki'], 'wiki 计数一致');
  assert.equal(counts['story'], exported.counts['story'], 'story 计数一致');
  assert.equal(counts['state'], exported.counts['state'], 'state 计数一致');

  // 5. 往返核心：重新预览导出文本 → 全部 noop（无 add/update）。
  const roundTrip = await f.documents.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'exported.aiki.md', text: exported.text });
  const actions: { id: string; action: string }[] = roundTrip.entries.map((entry: { entryId: string; action: string }) => ({ id: entry.entryId, action: entry.action }));
  const changed = actions.filter((item: { id: string; action: string }) => item.action === 'add' || item.action === 'update');
  assert.equal(changed.length, 0, `往返不得产生新增/更新，实为：${JSON.stringify(changed)}`);
});

test('CB-06 边界：真实记忆与共同经历不进导出；未导入角色导出仍合法', async t => {
  const f = await exportFixture(t);
  // 写入一条真实用户记忆（真实 owner 的表结构，非作者设定）。
  const db = f.store.rawDatabaseForKnowledge();
  db.prepare("INSERT INTO memory_records (character_id,id,kind,state,version,text,sources_json,created_at,created_ms,transcript_bytes) VALUES ('companion','mem-secret','memory','active',1,'用户真实偏好：喜欢在深夜工作。','[]',datetime('now'),0,0)").run();
  const exported = f.documents.export('companion') as { text: string; warnings: readonly string[] };
  assert.ok(!exported.text.includes('喜欢在深夜工作'), '真实用户记忆绝不出现在作者导出中');
  assert.ok(!exported.text.includes('memory_records'), '不得泄漏内部表名');
  // 未导入过任何文档的角色（role-b）：产出合法 frontmatter 结构 + 诚实告警。
  // 注意：零条目文档按 CB-00 规则被解析器判为 empty_document（不允许空文档冒充可应用草稿），
  // 因此这里断言的是「结构合法且如实报告空文档」，不是「可应用」。
  const bare = f.documents.export('role-b') as { text: string; entryCount: number; warnings: readonly string[] };
  assert.ok(bare.text.startsWith('---\n'), '必须有 frontmatter');
  assert.ok(bare.text.includes('schema: aiki.character/v0.1'), '必须声明冻结 schema');
  assert.equal(bare.entryCount, 0, '未导入角色没有作者条目');
  assert.ok(bare.warnings.length > 0, '未导入角色必须给出诚实告警');
  const bareParsed = parseCharacterDocument({ text: bare.text, sourceName: 'bare.aiki.md', inputKind: 'file' });
  assert.equal(bareParsed.mode, 'source_only', '空文档不得冒充可应用草稿');
  assert.ok(bareParsed.diagnostics.some(diagnostic => diagnostic.code === 'empty_document'), '空文档必须被如实诊断');
});

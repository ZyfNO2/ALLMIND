/**
 * CB-00 · 统一角色文档格式冻结与解析器（目标断言，RED 先行）。
 *
 * 被测目标接口：`core/character-document-parser.ts` 的
 * `parseCharacterDocument({text,sourceName,inputKind})` →
 * `{mode:'aiki-character'|'source_only',schemaVersion,documentHash,document,diagnostics,blockedEntryIds,trailingNotes}`。
 * 格式冻结见 [CB-00 SPEC](../../../docs/next/aiki-character-book/specs/CB-00.md)：
 *   * YAML frontmatter（schema/id/name/language 必填）+ `:::entry` 三段定界 + 尾部测试说明隔离；
 *   * documentHash 为提交文本 UTF-8 SHA256；file/paste 两入口一致；
 *   * 坏格式拒绝整档（code/line/entryId 定位），绝不降级 source_only；
 *   * 悬空 related/source.ref 只拦条目（blockedEntryIds），不拦整档；
 *   * 原文件断言：12 Entry（persona 4 / wiki 3 / story 2 / state 3），authoring 全缺席；
 *   * 解析零网络/零模型/零持久写入（纯函数签名保证）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCharacterDocument } from '../../core/character-document-parser.js';

// 原文件位于仓库根 docs；编译产物在 dist/tests/core 运行 → 三级上级到包根再进 docs。
const fixturePath = resolve('../../../validation/fixtures/aiki-character-book/allmind.aiki.md');
const fixture = readFileSync(fixturePath, 'utf8');

test('CB-00 原文件：12 Entry 分类计数与关键字段', () => {
  const parsed = parseCharacterDocument({ text: fixture, sourceName: 'allmind.aiki.md', inputKind: 'file' });
  assert.equal(parsed.mode, 'aiki-character');
  assert.equal(parsed.schemaVersion, 'aiki.character/v0.1');
  assert.ok(parsed.document, `原文件必须解析成功：${JSON.stringify(parsed.diagnostics)}`);
  const entries = parsed.document.entries;
  assert.equal(entries.length, 12);
  const byType = (t: string) => entries.filter(e => e.meta.type === t).map(e => e.meta.id);
  assert.deepEqual(byType('persona'), ['persona.core.identity', 'persona.personality.general', 'persona.speech.general', 'persona.behavior.failure']);
  assert.deepEqual(byType('wiki'), ['wiki.organization.allmind_network', 'wiki.location.test_hangar', 'wiki.concept.mission_evaluation']);
  assert.deepEqual(byType('story'), ['story.20261010.first_test', 'story.20261010.mission_discussion']);
  assert.deepEqual(byType('state'), ['state.relationship.user', 'state.location.current', 'state.goal.current']);
  assert.equal(parsed.blockedEntryIds.length, 0);
});

test('CB-00 原文件：frontmatter 与 authoring 缺席', () => {
  const parsed = parseCharacterDocument({ text: fixture, sourceName: 'allmind.aiki.md', inputKind: 'file' });
  const fm = parsed.document!.frontmatter;
  assert.equal(fm.id, 'allmind');
  assert.equal(fm.name, 'ALLMIND');
  assert.equal(fm.language, 'zh-CN');
  assert.deepEqual([...fm.aliases], ['Allmind', 'アールマインド']);
  assert.ok(fm.tags.includes('test'));
  assert.equal(fm.authoring.intro, undefined);
  assert.equal(fm.authoring.scenario, undefined);
  assert.equal(fm.authoring.firstMessage, undefined);
  assert.equal(fm.authoring.exampleDialogue, undefined);
});

test('CB-00 原文件：正文逐字一致与元数据', () => {
  const parsed = parseCharacterDocument({ text: fixture, sourceName: 'allmind.aiki.md', inputKind: 'file' });
  const byId = new Map(parsed.document!.entries.map(e => [e.meta.id, e]));
  const identity = byId.get('persona.core.identity')!;
  assert.ok(identity.body.includes('ALLMIND 是一个以冷静、理性和系统化方式行动的人工智能。'));
  assert.equal(identity.meta.priority, 100);
  assert.equal(identity.meta.always, true);
  assert.equal(identity.meta.canon?.level, 'author_defined');
  const story = byId.get('story.20261010.first_test')!;
  assert.equal(story.meta.time?.start, '2026-10-10T20:00:00+08:00');
  assert.deepEqual([...story.meta.related], ['state.relationship.user', 'wiki.location.test_hangar']);
  assert.ok(story.meta.characters.includes('user'));
  const rel = byId.get('state.relationship.user')!;
  assert.equal(rel.meta.source?.type, 'story');
  assert.equal(rel.meta.source?.ref, 'story.20261010.first_test');
  assert.equal(rel.meta.updatedAt, '2026-10-10T20:00:00+08:00');
  assert.ok(rel.body.includes('status: collaborator'));
});

test('CB-00 原文件：尾部测试说明隔离 + 两入口一致', () => {
  const parsed = parseCharacterDocument({ text: fixture, sourceName: 'allmind.aiki.md', inputKind: 'file' });
  assert.ok(parsed.trailingNotes?.includes('预期解析结果'), '尾部说明必须保留');
  assert.ok(parsed.trailingNotes?.includes('Persona Entry：4'));
  for (const entry of parsed.document!.entries) {
    assert.ok(!entry.body.includes('预期解析结果'), '测试说明不得进入 Entry 正文');
  }
  const asPaste = parseCharacterDocument({ text: fixture, sourceName: '粘贴内容', inputKind: 'paste' });
  assert.equal(asPaste.documentHash, parsed.documentHash);
  assert.deepEqual(asPaste.document, parsed.document);
  assert.deepEqual(asPaste.diagnostics, parsed.diagnostics);
  const expected = createHash('sha256').update(fixture, 'utf8').digest('hex');
  assert.equal(parsed.documentHash, expected);
});

test('CB-00 普通 MD 无 frontmatter 是 source_only', () => {
  const parsed = parseCharacterDocument({ text: '# 随手记\n\n她像是个安静的角色。', sourceName: 'notes.md', inputKind: 'file' });
  assert.equal(parsed.mode, 'source_only');
  assert.equal(parsed.document, undefined);
  assert.equal(parsed.documentHash.length, 64);
});

test('CB-00 拒绝：坏 schema / 重复 id / 未知 type / 缺失定界 / 嵌套 entry', () => {
  const head = '---\nschema: aiki.character/v0.1\nid: t\nname: T\nlanguage: zh-CN\n---\n';
  const entry = (id: string, type: string, extra = '', body = '正文。') =>
    `:::entry\nid: ${id}\ntype: ${type}\n${extra}:::\n${body}\n:::\n`;
  const bad = (text: string) => parseCharacterDocument({ text, sourceName: 'x.aiki.md', inputKind: 'file' });
  // 有 frontmatter 但坏格式：绝不降级 source_only。
  const badSchema = bad('---\nschema: aiki.character/v9\nid: t\nname: T\nlanguage: zh-CN\n---\n');
  assert.equal(badSchema.mode, 'source_only');
  assert.equal(badSchema.document, undefined);
  assert.ok(badSchema.diagnostics.some(d => d.code === 'unknown_schema'));
  const dup = bad(head + entry('a.x', 'persona') + entry('a.x', 'wiki'));
  assert.equal(dup.document, undefined);
  assert.ok(dup.diagnostics.some(d => d.code === 'duplicate_entry_id' && d.entryId === 'a.x'));
  const badType = bad(head + entry('a.x', 'memory'));
  assert.ok(badType.diagnostics.some(d => d.code === 'bad_enum' && d.field === 'type'));
  const unterminated = bad(head + ':::entry\nid: a.x\ntype: persona\n:::\n正文没有结束。\n');
  assert.ok(unterminated.diagnostics.some(d => d.code === 'unterminated_entry'));
  const nested = bad(head + ':::entry\nid: a.x\ntype: persona\n:::\n:::entry\nid: a.y\ntype: wiki\n:::\n:::\n');
  assert.ok(nested.diagnostics.some(d => d.code === 'nested_entry'));
});

test('CB-00 拒绝：重复 YAML key / 未知字段 / 非法时间 / NUL / 超限 / fence 内假 entry', () => {
  const head = '---\nschema: aiki.character/v0.1\nid: t\nname: T\nlanguage: zh-CN\n---\n';
  const bad = (text: string) => parseCharacterDocument({ text, sourceName: 'x.aiki.md', inputKind: 'file' });
  const dupKey = bad(head + ':::entry\nid: a.x\nid: a.y\ntype: persona\n:::\n正文。\n:::\n');
  assert.ok(dupKey.diagnostics.some(d => d.code === 'duplicate_yaml_key'));
  const unknown = bad(head + ':::entry\nid: a.x\ntype: persona\nhacker: 1\n:::\n正文。\n:::\n');
  assert.ok(unknown.diagnostics.some(d => d.code === 'unknown_field' && d.field === 'hacker'));
  const badTime = bad(head + ':::entry\nid: s.a\ntype: story\ntime:\n  start: 不是时间\n:::\n正文。\n:::\n');
  assert.ok(badTime.diagnostics.some(d => d.code === 'bad_time'));
  assert.ok(bad('').diagnostics.some(d => d.code === 'empty_document'));
  assert.ok(bad('---\n').diagnostics.length > 0);
  assert.ok(bad(head + ':::entry\nid: a.x\ntype: persona\n:::\n正文\0混入。\n:::\n').diagnostics.some(d => d.code === 'nul_byte'));
  const huge = bad('x'.repeat(129 * 1024));
  assert.ok(huge.diagnostics.some(d => d.code === 'over_limit'));
  // fence 内的假 entry 不得识别：只有一个真 Entry。
  const fenced = bad(head + ':::entry\nid: a.x\ntype: persona\n:::\n```text\n:::entry\nid: fake\ntype: wiki\n:::\n```\n:::\n');
  assert.equal(fenced.document?.entries.length, 1);
});

test('CB-00 悬空 related 只拦条目不拦整档', () => {
  const text = '---\nschema: aiki.character/v0.1\nid: t\nname: T\nlanguage: zh-CN\n---\n' +
    ':::entry\nid: a.x\ntype: wiki\nrelated:\n  - a.missing\n:::\n正文甲。\n:::\n' +
    ':::entry\nid: a.y\ntype: persona\n:::\n正文乙。\n:::\n';
  const parsed = parseCharacterDocument({ text, sourceName: 'x.aiki.md', inputKind: 'file' });
  assert.equal(parsed.mode, 'aiki-character');
  assert.ok(parsed.document, '整档仍有效');
  assert.deepEqual([...parsed.blockedEntryIds], ['a.x']);
  assert.ok(parsed.diagnostics.some(d => d.code === 'related_not_found' && d.entryId === 'a.x'));
});

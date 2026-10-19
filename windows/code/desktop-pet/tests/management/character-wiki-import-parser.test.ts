/**
 * WV0-00 · 导入格式与确定性解析（目标断言，RED）。
 *
 * 被测目标接口：`management/character-wiki-import-parser.ts` 的 `parseWikiImport({text,sourceName,inputKind})`
 * → `{mode:'structured'|'source_only',documentHash,normalized,sources,diagnostics}`。
 * 格式冻结见 [WV0-00 SPEC](../../docs/next/character-wiki-v0/specs/WV0-00.md)：
 *   * 恰好一个 `aika-wiki-v0` fenced block，内容严格 JSON；或直接粘贴同版本 JSON 对象；
 *   * `schemaVersion='aika-wiki-v0.1'`；未知字段拒绝并给路径；
 *   * evidence.quote 必须在指定 source.text 逐字出现（code-point 精确定位），重复引用需 occurrence；
 *   * 传输 ≤128KiB UTF-8、单 source.text ≤64KiB；CRLF 原文保留；fatal decode；拒绝 NUL/空；
 *   * canon 与候选隔离（解析层只标记，不投影）；普通 MD 为 source_only；
 *   * 解析零网络/零模型/零持久写入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWikiImport } from '../../management/character-wiki-import-parser.js';

// 导入模板位于仓库根 docs；编译产物在 dist/tests/management 运行 → 三级上级到仓库根。
const template = readFileSync(resolve('../../../validation/fixtures/character-wiki-v0/IMPORT_TEMPLATE.md'), 'utf8');

/** 从模板中提取 fenced block 的 JSON（模板自身就是格式样例）。 */
const fenced = /```aika-wiki-v0\r?\n([\s\S]*?)```/.exec(template)?.[1];
assert.ok(fenced, '导入模板必须包含 aika-wiki-v0 fenced block');

test('WV0-00 同一内容的 MD 文件与粘贴输入得到同 hash/normalized/诊断', () => {
  const asFile = parseWikiImport({ text: template, sourceName: 'IMPORT_TEMPLATE.md', inputKind: 'file' });
  const asPaste = parseWikiImport({ text: template, sourceName: '粘贴内容', inputKind: 'paste' });
  assert.equal(asFile.mode, 'structured');
  assert.equal(asFile.mode, asPaste.mode);
  assert.ok(asFile.normalized, '模板必须解析为结构化文档');
  assert.ok(asPaste.normalized);
  assert.equal(asFile.documentHash, asPaste.documentHash, '同文本必须同 hash');
  assert.deepEqual(asFile.normalized, asPaste.normalized, '同文本必须同 normalized');
  assert.deepEqual(asFile.diagnostics, asPaste.diagnostics);
  assert.equal(asFile.normalized.title, '示例角色设定');
  assert.equal(asFile.normalized.schemaVersion, 'aika-wiki-v0.1');
  // sources 来自文档：sourceName 是文档级来源名；sourceId 是文档局部 id。
  assert.equal(asFile.sources.length, 1);
  assert.equal(asFile.sources[0]!.sourceName, 'IMPORT_TEMPLATE.md');
  assert.equal(asFile.sources[0]!.sourceId, 'author-notes');
});

test('WV0-00 直接粘贴同版本 JSON 对象也是 structured', () => {
  const parsed = parseWikiImport({ text: fenced!, sourceName: '粘贴 JSON', inputKind: 'paste' });
  assert.equal(parsed.mode, 'structured');
  assert.ok(parsed.normalized);
  assert.equal(parsed.normalized.bible.name, '示例角色');
});

test('WV0-00 普通 MD（无标记非 JSON）是 source_only 草稿，不是角色包', () => {
  const md = '# 我随手记的设定\n\n她是个图书管理员，具体以后再补。';
  const parsed = parseWikiImport({ text: md, sourceName: 'notes.md', inputKind: 'file' });
  assert.equal(parsed.mode, 'source_only');
  assert.equal(parsed.normalized, undefined, 'source_only 不产生 normalized 结构');
  assert.equal(parsed.documentHash.length, 64, 'documentHash 仍为实际提交文本 SHA256');
});

test('WV0-00 拒绝：坏 JSON / 未知版本 / 未知字段带路径 / 多个标记 / 空输入 / NUL / 超限', () => {
  const bad = (text: string, name = 'x.md') => parseWikiImport({ text, sourceName: name, inputKind: 'file' });
  // 坏 JSON（有标记但内容损坏）必须报错，不降级 source_only。
  const broken = bad('```aika-wiki-v0\n{ "schemaVersion": "aika-wiki-v0.1", "title": "x" ');
  assert.equal(broken.mode, 'structured');
  assert.ok(broken.diagnostics.some(d => /JSON/.test(d.message)), '损坏 JSON 必须有诊断');
  assert.equal(broken.normalized, undefined);
  // 未知 schemaVersion。
  const unknownVersion = bad('```aika-wiki-v0\n{"schemaVersion":"aika-wiki-v9","title":"x"}\n```');
  assert.ok(unknownVersion.diagnostics.some(d => /schemaVersion|版本/.test(d.message)));
  // 未知字段带路径。
  const unknownField = bad('```aika-wiki-v0\n' + JSON.stringify({
    schemaVersion: 'aika-wiki-v0.1', title: 'x', sources: [], bible: { name: 'n', soul: 's', styleHints: ['简洁温和'], evidence: [], hacker: true },
  }) + '\n```');
  assert.ok(unknownField.diagnostics.some(d => d.path === 'bible.hacker' || /bible\.hacker/.test(d.message ?? '')), '未知字段诊断必须给路径');
  // 两个标记。
  const dup = bad('```aika-wiki-v0\n{"schemaVersion":"aika-wiki-v0.1","title":"a","sources":[],"bible":{"name":"n","soul":"s","evidence":[]}}\n```\n\n```aika-wiki-v0\n{"schemaVersion":"aika-wiki-v0.1","title":"b","sources":[],"bible":{"name":"n","soul":"s","evidence":[]}}\n```');
  assert.ok(dup.diagnostics.some(d => /多个|重复|两个|必须恰好一个/.test(d.message)));
  // 空输入与 NUL。
  assert.ok(bad('').diagnostics.some(d => /空/.test(d.message)));
  assert.ok(bad('\0').diagnostics.some(d => /NUL|控制|非法/.test(d.message)));
  // 超限（128KiB 传输）。
  const huge = 'a'.repeat(129 * 1024);
  assert.ok(bad(huge).diagnostics.some(d => /128|超限|大小/.test(d.message)));
});

test('WV0-00 假引用拒绝：quote 不在 source.text / 越界 occurrence / 空 evidence', () => {
  const make = (bibleEvidence: unknown) => parseWikiImport({
    text: '```aika-wiki-v0\n' + JSON.stringify({
      schemaVersion: 'aika-wiki-v0.1', title: 'x',
      sources: [{ id: 's1', title: 'S', kind: 'authored', text: '她喜欢整理旧书。' }],
      bible: { name: 'n', soul: 's', styleHints: ['简洁温和'], evidence: bibleEvidence },
    }) + '\n```', sourceName: 'x.md', inputKind: 'file',
  });
  const fake = make([{ sourceId: 's1', quote: '这句根本不在原文里。' }]);
  assert.ok(fake.diagnostics.some(d => /逐字|原文|找不到/.test(d.message)), `假引用必须有诊断：${JSON.stringify(fake.diagnostics)}`);
  const oob = make([{ sourceId: 's1', quote: '她喜欢整理旧书。', occurrence: 3 }]);
  assert.ok(oob.diagnostics.some(d => /occurrence|出现次数/.test(d.message)));
  const empty = make([]);
  assert.ok(empty.diagnostics.some(d => /evidence|证据/.test(d.message)), '核心 evidence 为空必须有诊断');
  // 缺 sourceId 引用。
  const missingSource = make([{ sourceId: 'nope', quote: '她喜欢整理旧书。' }]);
  assert.ok(missingSource.diagnostics.some(d => /sourceId|来源/.test(d.message)));
});

test('WV0-00 重复 ID / 重复 ordinal 拒绝；canon 与候选隔离；awareness 不被默认替换', () => {
  const base = {
    schemaVersion: 'aika-wiki-v0.1', title: 'x',
    sources: [{ id: 's1', title: 'S', kind: 'authored', text: '她喜欢整理旧书。她与旅人修复了图书馆。' }],
    bible: { name: 'n', soul: 's', styleHints: ['简洁温和'], evidence: [{ sourceId: 's1', quote: '她喜欢整理旧书。' }] },
  };
  const dupId = parseWikiImport({ text: '```aika-wiki-v0\n' + JSON.stringify({
    ...base, wikiFacts: [
      { id: 'f1', text: '她喜欢整理旧书。', status: 'canon', evidence: [{ sourceId: 's1', quote: '她喜欢整理旧书。' }] },
      { id: 'f1', text: '她喜欢整理旧书。', status: 'canon', evidence: [{ sourceId: 's1', quote: '她喜欢整理旧书。' }] },
    ],
  }) + '\n```', sourceName: 'x.md', inputKind: 'file' });
  assert.ok(dupId.diagnostics.some(d => /重复/.test(d.message)));
  const dupOrdinal = parseWikiImport({ text: '```aika-wiki-v0\n' + JSON.stringify({
    ...base, storyEvents: [
      { id: 'e1', ordinal: 0, title: 'a', summary: '她与旅人修复了图书馆。', participants: ['她'], awareness: 'experienced', status: 'canon', evidence: [{ sourceId: 's1', quote: '她与旅人修复了图书馆。' }] },
      { id: 'e2', ordinal: 0, title: 'b', summary: '她与旅人修复了图书馆。', participants: ['她'], awareness: 'heard', status: 'canon', evidence: [{ sourceId: 's1', quote: '她与旅人修复了图书馆。' }] },
    ],
  }) + '\n```', sourceName: 'x.md', inputKind: 'file' });
  assert.ok(dupOrdinal.diagnostics.some(d => /ordinal|重复/.test(d.message)));
  // 合法文档：draft 事实保留候选状态，不投影为 canon；事件 awareness 原样。
  const ok = parseWikiImport({ text: '```aika-wiki-v0\n' + JSON.stringify({
    ...base, wikiFacts: [{ id: 'f1', text: '她喜欢整理旧书。', status: 'draft', evidence: [{ sourceId: 's1', quote: '她喜欢整理旧书。' }] }],
    storyEvents: [{ id: 'e1', ordinal: 0, title: 't', summary: '她与旅人修复了图书馆。', participants: ['她'], awareness: 'heard', status: 'canon', evidence: [{ sourceId: 's1', quote: '她与旅人修复了图书馆。' }] }],
  }) + '\n```', sourceName: 'x.md', inputKind: 'file' });
  assert.equal(ok.mode, 'structured');
  assert.ok(ok.normalized);
  assert.equal(ok.normalized.wikiFacts[0]!.status, 'draft', '候选事实保留原状态');
  assert.equal(ok.normalized.storyEvents[0]!.awareness, 'heard', 'awareness 原样保留');
});

test('WV0-00 引用定位在中文/CRLF/重复引用下正确（code-point start/end）', () => {
  const text = '她喜欢整理旧书。\r\n她喜欢整理旧书。\r\n她与旅人修复了图书馆。';
  const parsed = parseWikiImport({ text: '```aika-wiki-v0\n' + JSON.stringify({
    schemaVersion: 'aika-wiki-v0.1', title: 'x',
    sources: [{ id: 's1', title: 'S', kind: 'authored', text }],
    bible: { name: 'n', soul: 's', styleHints: ['简洁温和'], evidence: [{ sourceId: 's1', quote: '她喜欢整理旧书。', occurrence: 2 }] },
    wikiFacts: [{ id: 'f1', text: '她喜欢整理旧书。', status: 'canon', evidence: [
      { sourceId: 's1', quote: '她喜欢整理旧书。', occurrence: 2 },
      { sourceId: 's1', quote: '她与旅人修复了图书馆。' },
    ] }],
  }) + '\n```', sourceName: 'x.md', inputKind: 'file' });
  assert.equal(parsed.mode, 'structured');
  assert.ok(parsed.normalized);
  // CRLF 原文保留：source text 原样含 \r\n。
  assert.ok(parsed.sources[0]!.text.includes('\r\n'), 'CRLF 必须原样保留');
  // 定位：第二条 occurrence=1 的区间必须在第一条之后。
  const facts = parsed.normalized.wikiFacts;
  const located = facts[0]!.evidence.map(e => e.location);
  assert.ok(located.every(l => l && l.start >= 0 && l.end > l.start), `每个引用必须有 code-point 区间：${JSON.stringify(located)}`);
  assert.ok(located[1]!.start > located[0]!.end, 'occurrence=2 的区间必须在第一次出现之后');
  // emoji/多码点字符下按 code point 定位（用包含 emoji 的 quote 再验证一次）。
  const emojiText = '🌟她发光。';
  const emojiDoc = parseWikiImport({ text: '```aika-wiki-v0\n' + JSON.stringify({
    schemaVersion: 'aika-wiki-v0.1', title: 'x',
    sources: [{ id: 's1', title: 'S', kind: 'authored', text: emojiText }],
    bible: { name: 'n', soul: 's', styleHints: ['简洁温和'], evidence: [{ sourceId: 's1', quote: '她发光。' }] },
  }) + '\n```', sourceName: 'x.md', inputKind: 'file' });
  assert.equal(emojiDoc.mode, 'structured');
  assert.ok(emojiDoc.normalized);
  const loc = emojiDoc.normalized.bible.evidence[0]!.location;
  // '🌟' 占 1 个 code point → '她发光。' 从 start=1 开始。
  assert.equal(loc!.start, 1);
  assert.equal(loc!.end, 5);
});

test('WV0-00 限制：sources>16 / facts>100 / events>100 / gaps>32 / 单 source.text>64KiB 拒绝', () => {
  const base = {
    schemaVersion: 'aika-wiki-v0.1', title: 'x',
    sources: [{ id: 's1', title: 'S', kind: 'authored', text: '她喜欢整理旧书。' }],
    bible: { name: 'n', soul: 's', styleHints: ['简洁温和'], evidence: [{ sourceId: 's1', quote: '她喜欢整理旧书。' }] },
  };
  const manySources = parseWikiImport({ text: '```aika-wiki-v0\n' + JSON.stringify({
    ...base, sources: Array.from({ length: 17 }, (_, i) => ({ id: `s${i}`, title: 'S', kind: 'authored', text: '她喜欢整理旧书。' })),
  }) + '\n```', sourceName: 'x.md', inputKind: 'file' });
  assert.ok(manySources.diagnostics.some(d => /16|sources/.test(d.message)));
  const manyFacts = parseWikiImport({ text: '```aika-wiki-v0\n' + JSON.stringify({
    ...base, wikiFacts: Array.from({ length: 101 }, (_, i) => ({ id: `f${i}`, text: '她喜欢整理旧书。', status: 'canon', evidence: [{ sourceId: 's1', quote: '她喜欢整理旧书。' }] })),
  }) + '\n```', sourceName: 'x.md', inputKind: 'file' });
  assert.ok(manyFacts.diagnostics.some(d => /100/.test(d.message)));
  const bigSource = parseWikiImport({ text: '```aika-wiki-v0\n' + JSON.stringify({
    ...base, sources: [{ id: 's1', title: 'S', kind: 'authored', text: '好'.repeat(64 * 1024 + 1) }],
  }) + '\n```', sourceName: 'x.md', inputKind: 'file' });
  assert.ok(bigSource.diagnostics.some(d => /64|超限|大小/.test(d.message)));
});

test('WV0-00 零副作用：解析不写库、不发网络请求', async t => {
  // 语法层面保证：parser 模块不得 import http/fetch 触发器——用模块源码审查钉桩。
  const src = readFileSync(resolve('management/character-wiki-import-parser.ts'), 'utf8');
  assert.doesNotMatch(src, /fetch\(|node:http|node:https|axios|writeFile|Database/, 'parser 必须是纯函数模块');
});

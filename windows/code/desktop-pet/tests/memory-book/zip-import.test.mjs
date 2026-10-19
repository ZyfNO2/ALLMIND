import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { BookRuntime } from '../../dist/app/book-runtime.js';
import { BookCredentials } from '../../dist/management/book-credentials.js';
import { startBookServer } from '../../dist/management/book-server.js';
// 合成交付说明：历史上该用例读取 aika-fgo-lab 工程导出的真实 Artoria 交付 ZIP（本机绝对路径，
// 属不可公开的第三方/私有资源）。公开树内改为下方可重复生成的合成交付，覆盖同一生产路径：
// manifest SHA-256 完整性 + 推荐知识视角、唯一正式 Book JSON、optional/ RP 附加资料排除、
// Wiki 来源与可回查事实条目。真实资源导入体验仍属外部/人工验收项，不在自动门槛内。
const sha256 = value => createHash('sha256').update(value).digest('hex');
const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'web-chat' };
function fixture(t) {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const repository = new FileBookRepository(mkdtempSync(join(root, 'zip-import-')));
  t.after(() => repository.close());
  return { repository, runtime: new BookRuntime(repository, { async complete() { throw Error('ZIP import must not call a model'); } }) };
}
// Small stored ZIP fixture generator, including CRC32 and central directory, for invalid-input tests.
function zip(files, compressed = false) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of files) {
    const body = Buffer.from(value), filename = Buffer.from(name), payload = compressed ? deflateRawSync(body) : body; let crc = 0xffffffff;
    for (const b of body) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt16LE(compressed ? 8 : 0, 8); l.writeUInt32LE(crc, 14); l.writeUInt32LE(payload.length, 18); l.writeUInt32LE(body.length, 22); l.writeUInt16LE(filename.length, 26);
    local.push(l, filename, payload);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(compressed ? 8 : 0, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(payload.length, 20); c.writeUInt32LE(body.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, filename); offset += l.length + filename.length + payload.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
// --- synthetic delivery (replaces the private Artoria ZIP; fully generated, no model, no private data) ---
const entry = (id, title, body, type, trigger, extra = {}) => ({
  id, title, body, type, origin: 'authored', enabled: true, pinned: false, revision: 0, importance: 50,
  pairingId: null, aliases: [], tags: ['synthetic'], entities: [], locations: [], related: [], sourceRefs: [],
  timeStart: null, timeEnd: null, validFrom: null, validUntil: null, importedHash: null,
  trigger: { strategy: trigger, operator: 'and', keys: [], secondaryKeys: [], priority: 50, stickyTurns: 0, cooldownTurns: 0 }, ...extra
});
const sourceText = '合成验收来源。\n阿伦喜欢红茶。\n';
const sourceText2 = '第二合成来源：世界设定资料。\n';
const factQuote = '阿伦喜欢红茶。', factStart = sourceText.indexOf(factQuote);
const bookJson = JSON.stringify({
  schemaVersion: 'memory-book/v1',
  name: 'synthetic-delivery',
  entries: [
    entry('e-persona-core', '合成人格核心', '温和诚实，不编造共同经历。', 'persona', 'always', { importance: 80, trigger: { strategy: 'always', operator: 'and', keys: [], secondaryKeys: [], priority: 80, stickyTurns: 0, cooldownTurns: 0 } }),
    entry('e-persona-voice', '合成语气', '简洁、直接、不夸张。', 'persona', 'always'),
    entry('e-wiki-identity', '阿伦的身份', '阿伦是合成验收角色。', 'wiki', 'keyword', { trigger: { strategy: 'keyword', operator: 'and', keys: ['身份'], secondaryKeys: [], priority: 50, stickyTurns: 0, cooldownTurns: 0 }, entities: ['阿伦'] }),
    entry('e-wiki-fact-drink', '阿伦的饮品偏好', '阿伦喜欢红茶。', 'wiki', 'keyword', {
      trigger: { strategy: 'keyword', operator: 'and', keys: ['红茶'], secondaryKeys: [], priority: 60, stickyTurns: 0, cooldownTurns: 0 }, entities: ['阿伦'], related: ['e-wiki-identity'], importance: 60,
      knowledge: { worldId: 'sample-world', branch: 'main', chapter: 1, awareness: 'unknown' },
      fact: { sourceId: 'src-synthetic-01', sourceHash: sha256(sourceText), key: sha256('阿伦\0饮品'), subject: '阿伦', predicate: '饮品', value: '红茶', quote: factQuote, start: factStart, end: factStart + factQuote.length, status: 'source_asserted' }
    }),
    entry('e-story-first-meeting', '第一次见面', '第一次见面是在合成机库。', 'story', 'keyword', { trigger: { strategy: 'keyword', operator: 'and', keys: ['第一次见面'], secondaryKeys: [], priority: 50, stickyTurns: 0, cooldownTurns: 0 } }),
    entry('e-lore-world', '世界设定', '合成世界仅用于导入验收。', 'lore', 'search', { knowledge: { worldId: 'sample-world', branch: 'main', chapter: 0, awareness: 'heard' } })
  ],
  wikiSources: [
    { id: 'src-synthetic-01', title: '合成验收来源一', uri: null, pairingId: null, enabled: true, hash: sha256(sourceText), revision: 1, forgottenKeys: [], snapshots: [{ text: sourceText, capturedAt: '2026-10-17T00:00:00.000Z', hash: sha256(sourceText) }] },
    { id: 'src-synthetic-02', title: '合成验收来源二', uri: 'https://example.com/synthetic', pairingId: null, enabled: true, hash: sha256(sourceText2), revision: 1, forgottenKeys: [], snapshots: [{ text: sourceText2, capturedAt: '2026-10-17T00:00:00.000Z', hash: sha256(sourceText2) }] }
  ]
});
const rpNotes = '可选 RP 扩展资料；正式导入必须跳过 optional/ 目录。';
const manifestJson = JSON.stringify({
  schema: 'aiki-delivery/v1',
  files: [
    { file: 'synthetic-delivery.book.json', bytes: Buffer.byteLength(bookJson), sha256: sha256(bookJson) },
    { file: 'optional/rp-notes.md', bytes: Buffer.byteLength(rpNotes), sha256: sha256(rpNotes) }
  ],
  knowledgeView: { worldId: 'sample-world', branch: 'main', cutoff: 10 }
});
const delivery = zip([
  ['synthetic-delivery.book.json', bookJson],
  ['optional/rp-notes.md', rpNotes],
  ['manifest.json', manifestJson]
]);
test('delivery ZIP uses production import, skips optional RP, roundtrips and retains hand edits', async t => {
  const { runtime, repository } = fixture(t), bytes = delivery;
  const p = await runtime.imports.previewZip(scope, bytes, 'synthetic.zip');
  assert.equal(p.entries.length, 6); assert.equal(p.wikiSources.length, 2); assert.deepEqual(p.diagnostics, []);
  assert.equal(p.archive.bookFile, 'synthetic-delivery.book.json'); assert.ok(p.archive.excludedFiles.some(f => f.startsWith('optional/')));
  assert.deepEqual(p.archive.knowledgeView, { worldId: 'sample-world', branch: 'main', cutoff: 10 });
  assert.equal(repository.snapshot(scope).entries.length, 0, 'Preview never writes');
  assert.equal(repository.loadConfig().characters[0].knowledgeView, undefined, 'Do not silently apply recommended role settings');
  runtime.imports.apply(scope, p.id, 'zip-first');
  const repeat = await runtime.imports.previewZip(scope, bytes, 'synthetic.zip'); assert.ok(repeat.changes.every(c => c.action === 'noop'));
  const back = runtime.imports.preview(scope, runtime.imports.export(scope).text, 'export.json'); assert.ok(back.changes.every(c => c.action === 'noop'));
  const current = repository.snapshot(scope), edited = { ...current.entries[0], body: '用户手动修改，必须保留' };
  repository.commit(scope, { upsert: [edited] }, current.revision, 'manual-edit');
  const conflict = await runtime.imports.previewZip(scope, bytes, 'synthetic.zip'); assert.equal(conflict.changes.find(c => c.id === edited.id).action, 'conflict');
  runtime.imports.apply(scope, conflict.id, 'zip-after-edit'); assert.equal(repository.snapshot(scope).entries.find(e => e.id === edited.id).body, edited.body);
});
test('ZIP rejects unsafe paths, duplicates, ambiguity, invalid manifests and size violations without writes', async t => {
  const { runtime, repository } = fixture(t);
  const book = JSON.stringify({ schemaVersion: 'memory-book/v1', name: 'single', entries: [] });
  const invalid = [Buffer.from('not ZIP'), zip([['../book.json', book]]), zip([['book.json', book], ['book.json', book]]), zip([['a.json', book], ['b.json', book]]), zip([['book.json', book], ['manifest.json', JSON.stringify({ schema: 'aiki-delivery/v1', files: [{ file: 'book.json', bytes: Buffer.byteLength(book), sha256: '0'.repeat(64) }] })]]), zip([['book.json', 'x'.repeat(1024 * 1024 + 1)]]), delivery.subarray(0, 100)];
  invalid.push(zip([['book.json', 'x'.repeat(1024 * 1024 + 1)]], true));
  invalid.push(zip(Array.from({ length: 9 }, (_, i) => [i + '.txt', 'x'.repeat(1024 * 1024)]), true));
  invalid.push(zip(Array.from({ length: 65 }, (_, i) => [i + '.txt', 'x'])));
  const encrypted = zip([['book.json', book]]); encrypted.writeUInt16LE(1, encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8); invalid.push(encrypted);
  const symlink = zip([['book.json', book]]); symlink.writeUInt32LE(0xa0000000, symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 38); invalid.push(symlink);
  for (const bytes of invalid) await assert.rejects(runtime.imports.previewZip(scope, bytes, 'bad.zip'), { code: 'invalid_input' });
  const valid = await runtime.imports.previewZip(scope, zip([['folder/book.json', book]]), 'single.zip'); assert.equal(valid.name, 'single');
  const markdown = readFileSync(resolve('../../../validation/fixtures/aiki-character-book/allmind.aiki.md'));
  const legacy = await runtime.imports.previewZip(scope, zip([['folder/allmind.aiki.md', markdown]]), 'legacy.zip');
  assert.equal(legacy.entries.length, 12); assert.deepEqual(legacy.diagnostics, []);
  assert.equal(repository.snapshot(scope).revision, 0);
});
test('built UI uploads ZIP through authenticated production HTTP preview and apply', { timeout: 60000 }, async t => {
  const { runtime, repository } = fixture(t);
  const server = await startBookServer({ runtime, credentials: new BookCredentials(resolve('.local/memory-book-tests/zip-credentials')), uiRoot: resolve('management') });
  const url = new URL(server.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
  const post = (data, auth = true) => fetch(url.origin + '/api/memory-book/v1/imports/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ ...scope, sourceName: 'a.zip', ...data }) });
  assert.equal((await post({ zipBase64: '!!' })).status, 400);
  assert.equal((await post({ zipBase64: 'YWJj', text: '{}' })).status, 400);
  assert.equal((await post({ zipBase64: delivery.toString('base64') }, false)).status, 401);
  const browser = await chromium.launch({ headless: true }); t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage(); page.setDefaultTimeout(10000); await page.goto(server.url);
  await page.getByRole('link', { name: '我们的回忆', exact: true }).click(); await page.getByRole('button',{name:'04 · 编纂与高级工具'}).click();await page.getByText('高级工具与来源', { exact: true }).click(); await page.getByText('导入 / 导出', { exact: true }).click();
  // The page now also hosts the organization upload input (accept=".md,.markdown,.html,.htm,.txt"),
  // so the historical bare input[type=file] locator is ambiguous; scope to the ZIP import input.
  const input = page.locator('input[type=file][accept=".md,.markdown,.json,.zip"]'); assert.match(await input.getAttribute('accept'), /\.zip/);
  await input.setInputFiles({ name: 'synthetic-delivery.zip', mimeType: 'application/zip', buffer: delivery });
  await page.getByRole('button', { name: '预览导入', exact: true }).click();
  await page.getByText(/ZIP 正式资料：synthetic-delivery\.book\.json/).waitFor();
  await page.getByRole('button', { name: '应用到当前角色', exact: true }).click();
  await page.getByText('已导入，冲突条目保留手动修改。', { exact: true }).waitFor();
  assert.equal(repository.snapshot(scope).entries.length, 6); assert.equal(repository.snapshot(scope).wikiSources.length, 2);
});

/**
 * CB-08 · 旧库升级回归（真实故障复现）。
 *
 * 背景：用户在**已存在**的数据库上导入时，apply 报
 * `invalid_request: 角色文档 Wiki 应用未完成，已完整回滚。`
 *
 * 根因：`character_wiki_operations.domain` 的 CHECK 约束在旧库里只允许
 * `('wiki-apply','wiki-rollback')`。CB-02 把 `'aiki-apply'` 加进了
 * `CREATE TABLE IF NOT EXISTS` —— 但该语句对**已存在的表不生效**，所以真实升级库仍会拒绝
 * 写入 aiki 回执，导致每次 apply 都在事务末尾抛错并整体回滚。
 *
 * 本用例先造一个"旧库"（旧 CHECK + 旧列），再用生产 `CharacterPackStore.open` 打开，
 * 断言迁移把约束放宽且 aiki apply 全链成功。这正是此前所有测试都没覆盖的路径：
 * 之前每个用例都用**全新**数据库，`CREATE TABLE` 自然带上新 CHECK。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { LorebookStore } from '../../memory/lorebook-store.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { randomUUID } from 'node:crypto';

/** A database shaped like the pre-CB-02 release: narrow domain CHECK, no baseline column. */
function legacyDatabase() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'aiki-legacy-')), 'legacy.sqlite'));
  db.exec(`
    CREATE TABLE character_wiki_operations (
      character_id TEXT NOT NULL,
      domain TEXT NOT NULL CHECK(domain IN ('wiki-apply', 'wiki-rollback')),
      operation_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(character_id, domain, operation_id)
    );
    CREATE TABLE character_document_journal (
      operation_id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      import_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','committed','aborted')),
      progress_json TEXT NOT NULL DEFAULT '{}',
      receipt_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

test('CB-08 旧库升级：domain CHECK 被放宽，aiki apply 可写入回执', async t => {
  const db = legacyDatabase();
  t.after(() => db.close());
  const ddlOf = () => (db.prepare("SELECT sql FROM sqlite_master WHERE name='character_wiki_operations'").get() as { sql: string }).sql;
  assert.ok(!ddlOf().includes('aiki-apply'), '前置：旧库 CHECK 不含 aiki-apply');

  // 生产入口打开 → 必须完成迁移。
  const packs = await CharacterPackStore.open(db);
  assert.ok(ddlOf().includes('aiki-apply'), '迁移必须把 aiki-apply 加入 domain CHECK');
  const journalCols = (db.pragma('table_info(character_document_journal)') as { name: string }[]).map(c => c.name);
  assert.ok(journalCols.includes('baseline_json'), '迁移必须为 journal 补上 baseline_json');

  // 旧行必须保留（迁移是重建表，不是丢弃）。
  db.prepare("INSERT INTO character_wiki_operations(character_id,domain,operation_id,signature,receipt_json,created_at) VALUES('companion','wiki-apply','old-op','sig','{}',datetime('now'))").run();
  const kept = db.prepare("SELECT COUNT(*) c FROM character_wiki_operations WHERE operation_id='old-op'").get() as { c: number };
  assert.equal(kept.c, 1, '旧回执行必须保留');

  // aiki 回执必须能写入（旧 CHECK 会在此抛错 → 整个 apply 回滚）。
  const pairing = productionPairing('companion', 'fixture-instance');
  db.prepare("INSERT INTO character_pack_sources(id,character_id,source_name,content_hash,body,byte_length,created_at) VALUES('src-1','companion','x.aiki.md','h','body',4,datetime('now'))").run();
  db.prepare(`INSERT INTO character_aiki_imports(id,character_id,operation_id,mode,input_kind,source_name,document_hash,document_source_id,normalized_json,diagnostics_json,created_at)
              VALUES('aiki-test','companion','op-draft','aiki-character','file','x.aiki.md','hash1','src-1','{"entries":[]}','[]',datetime('now'))`).run();
  const outcome = packs.applyAikiWikiFacts({
    pairing, importId: 'aiki-test',
    facts: [{ id: 'wiki.a', text: '## A\n\n正文。' }],
    expectedPackRevision: packs.getPackRevision(pairing),
    operationId: randomUUID(),
  });
  assert.ok(outcome.packId, 'aiki apply 必须成功');
  assert.equal(outcome.inserted, 1, '事实必须写入');
  const receipt = db.prepare("SELECT domain FROM character_wiki_operations WHERE domain='aiki-apply'").get() as { domain: string } | undefined;
  assert.equal(receipt?.domain, 'aiki-apply', 'aiki 回执必须真的落库（这正是旧库会失败的写点）');
});

test('CB-08 迁移幂等：已迁移的库重复打开不报错、不丢数据', async t => {
  const db = legacyDatabase();
  t.after(() => db.close());
  await CharacterPackStore.open(db);
  db.prepare("INSERT INTO character_wiki_operations(character_id,domain,operation_id,signature,receipt_json,created_at) VALUES('companion','aiki-apply','keep-me','sig','{}',datetime('now'))").run();
  // 再次打开（迁移条件已不满足 → 必须跳过而不是重复重建）。
  await CharacterPackStore.open(db);
  const row = db.prepare("SELECT COUNT(*) c FROM character_wiki_operations WHERE operation_id='keep-me'").get() as { c: number };
  assert.equal(row.c, 1, '二次打开不得丢失 aiki 回执');
});

test('CB-08 作者状态列错位回归：revision 必须是数字、importId 必须是导入 id', async t => {
  const db = legacyDatabase();
  t.after(() => db.close());
  const packs = await CharacterPackStore.open(db);
  db.prepare("INSERT INTO character_pack_sources(id,character_id,source_name,content_hash,body,byte_length,created_at) VALUES('src-2','companion','y.aiki.md','h','body',4,datetime('now'))").run();
  packs.upsertAuthorState({
    characterId: 'companion', importId: 'aiki-xyz',
    entries: [{ entryId: 'state.a', subtype: 'location', title: '当前地点', body: '测试机库', priority: 50, always: false, contentHash: 'ch1' }],
  });
  const rows = packs.authorStateOf('companion');
  assert.equal(rows.length, 1);
  assert.equal(typeof rows[0]!.revision, 'number', `revision 必须是数字，实为 ${JSON.stringify(rows[0]!.revision)}`);
  assert.equal(rows[0]!.importId, 'aiki-xyz', 'importId 必须是导入 id');
  assert.equal(rows[0]!.revision, 1, '首次写入的修订为 1');
});

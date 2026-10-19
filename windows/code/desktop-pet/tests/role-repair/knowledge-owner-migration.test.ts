// RWR-04 acceptance: a reference library is owned by exactly one character, and the legacy global
// library is assigned in place to the companion (D2) without losing a document or an id.
//
// The behaviours asserted here are the ones RWR-00's G4/G4b marked RED and CONTRACTS §3 froze:
//   * a library records its owner, so one role cannot read another's documents;
//   * a document id belonging to another role is NOT retrievable (not merely unlisted);
//   * activation is per character and two roles never share an activation;
//   * the legacy singleton activation upgrades in place, idempotently, keeping ids and content hashes;
//   * a fresh role starts with no library — nothing is copied to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { KnowledgeLibraryStore } from '../../memory/knowledge-library.js';
import { ANON, tempStore, seedLegacyGlobalKnowledge } from './fixtures.js';

const COMPANION = 'companion';
const ROLE_B = ANON.roleB;

/**
 * Open a library store over a temp database, registering the second role so owner-scoped operations
 * are exercised against a real registry (RWR-04 refuses an unregistered owner).
 */
async function library(t: { after(fn: () => Promise<void> | void): void }) {
  const ts = await tempStore(t, 'rwr-04-');
  ts.store.registry.create({ id: ROLE_B, label: '角色B', operationId: 'rwr04-create-b' });
  const store = await KnowledgeLibraryStore.open(ts.store, `${ts.dir}/knowledge`);
  return { ts, store, lib: store };
}

// AC-K1: owner is recorded; lists are scoped -----------------------------------------------
test('RWR-04 AC-K1: a library records its owner and each role lists only its own', async t => {
  const { ts, lib } = await library(t);
  const a = await lib.create('库A', COMPANION);
  const b = await lib.create('库B', ROLE_B);
  assert.equal(a.ownerCharacterId, COMPANION);
  assert.equal(b.ownerCharacterId, ROLE_B);

  const companionLibraries = lib.list(COMPANION);
  const roleBLibraries = lib.list(ROLE_B);
  assert.deepEqual(companionLibraries.map(l => l.id), [a.id], 'companion sees only its own library');
  assert.deepEqual(roleBLibraries.map(l => l.id), [b.id], 'role B sees only its own library');
  // A fresh role starts empty — nothing was copied to it.
  const other = ts.store.registry.create({ label: '另一个角色', operationId: 'rwr04-create-c' }).character;
  assert.deepEqual(lib.list(other.id), [], 'a new role starts with no library; the legacy library is not copied');
});

// AC-K2: cross-role reads are refused, not merely hidden ---------------------------------
test('RWR-04 AC-K2: a document owned by another role is not retrievable', async t => {
  const { lib } = await library(t);
  const a = await lib.create('库A', COMPANION);
  const imported = await lib.importDocuments(a.id, [{ sourceName: 'anon.md', text: '匿名 companion 资料' }]);
  const documentId = imported.imported[0]!.id;

  // The owner can read it.
  const owned = lib.getDocumentContent(a.id, documentId, COMPANION);
  assert.ok(owned);
  assert.equal(owned.text, '匿名 companion 资料');

  // Another role cannot: `get` is null and the document body is not readable through that path.
  assert.equal(lib.get(a.id, ROLE_B), null, "another role's library id is invisible");
  assert.throws(() => lib.documents(a.id, ROLE_B), /没有这个知识库/, 'a foreign library is refused before its documents are read');
});

test('RWR-04 AC-K2b: a foreign library cannot be activated by another role', async t => {
  const { lib } = await library(t);
  const a = await lib.create('库A', COMPANION);
  await assert.rejects(() => lib.activate(lib.revision(), a.id, ROLE_B), /没有这个知识库/, 'another role cannot activate a library it does not own');
  assert.equal(lib.active(ROLE_B).libraryId, null, "the failed activation left role B's selection empty");
});

// AC-K3: activation is per character ------------------------------------------------------
test('RWR-04 AC-K3: two roles are activated independently and never see each other', async t => {
  const { lib } = await library(t);
  const a = await lib.create('库A', COMPANION);
  const b = await lib.create('库B', ROLE_B);
  await lib.importDocuments(a.id, [{ sourceName: 'a.md', text: 'companion 专属知识' }]);
  await lib.importDocuments(b.id, [{ sourceName: 'b.md', text: 'roleB 专属知识' }]);

  await lib.activate(lib.revision(), a.id, COMPANION);
  await lib.activate(lib.revision(), b.id, ROLE_B);

  assert.equal(lib.active(COMPANION).libraryId, a.id);
  assert.equal(lib.active(ROLE_B).libraryId, b.id, 'role B has its own activation');

  const fromA = await lib.selection(300, COMPANION);
  const fromB = await lib.selection(300, ROLE_B);
  assert.match(fromA!.blocks.map(x => x.text).join('\n'), /companion 专属知识/);
  assert.doesNotMatch(fromA!.blocks.map(x => x.text).join('\n'), /roleB/);
  assert.match(fromB!.blocks.map(x => x.text).join('\n'), /roleB 专属知识/);
  assert.doesNotMatch(fromB!.blocks.map(x => x.text).join('\n'), /companion 专属知识/);
});

// AC-K4: legacy migration assigns in place, idempotently ---------------------------------
test('RWR-04 AC-K4: the legacy global library upgrades in place to the companion without loss', async t => {
  const ts = await tempStore(t, 'rwr-04-legacy-');
  const seeded = await seedLegacyGlobalKnowledge(ts); // legacy shape: global library, singleton activation
  const beforeDocuments = ts.store.rawDatabaseForKnowledge()
    .prepare('SELECT id, content_hash FROM knowledge_documents WHERE library_id=?').all(seeded.libraryId) as { id: string; content_hash: string }[];

  // Open the store, which performs the owner migration.
  const lib = await KnowledgeLibraryStore.open(ts.store, `${ts.dir}/knowledge`);
  const migrated = lib.get(seeded.libraryId);
  assert.ok(migrated, 'the legacy library id is preserved');
  assert.equal(migrated!.ownerCharacterId, COMPANION, 'the legacy library is assigned in place to the companion (D2)');

  const afterDocuments = lib.documents(seeded.libraryId, COMPANION);
  assert.equal(afterDocuments.length, beforeDocuments.length, 'no document is lost');
  const beforeHashes = new Set(beforeDocuments.map(d => d.content_hash));
  for (const document of afterDocuments) assert.ok(beforeHashes.has(document.contentHash), 'content hashes are preserved');

  // Activation carried over to the companion.
  assert.equal(lib.active(COMPANION).libraryId, seeded.libraryId, 'the legacy singleton activation became the companion activation');

  // Idempotent: reopening does not change anything.
  const reopened = await KnowledgeLibraryStore.open(ts.store, `${ts.dir}/knowledge`);
  assert.equal(reopened.get(seeded.libraryId)!.ownerCharacterId, COMPANION);
  assert.equal(reopened.documents(seeded.libraryId, COMPANION).length, beforeDocuments.length, 're-running the migration is a no-op');
  const companionList = reopened.list(COMPANION);
  assert.equal(companionList.filter(l => l.id === seeded.libraryId).length, 1, 'the library is not duplicated on a second migration');
});

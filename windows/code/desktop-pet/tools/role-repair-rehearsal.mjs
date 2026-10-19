// RWR-00: build an ANONYMOUS rehearsal copy of a legacy installation.
//
// The real `.local` database holds the user's private content, so migration work (RWR-03/04/06) is
// rehearsed here instead: this script copies the *shape* of a pre-migration install into a temp
// directory using only invented strings, then records counts/hashes so a migration can be proven
// lossless without ever printing user text.
//
// It never writes to `.local`, never starts a backend, and never calls a provider.
//
//   node tools/role-repair-rehearsal.mjs --out <dir>          build the copy
//   node tools/role-repair-rehearsal.mjs --out <dir> --verify re-open and report counts/hashes
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../dist/memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../dist/companion/invitations.js';
import { KnowledgeLibraryStore } from '../dist/memory/knowledge-library.js';
import { ContinuityMemoryStore } from '../dist/memory/continuity-memory-store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const out = option('out');
if (!out) { console.error('usage: node tools/role-repair-rehearsal.mjs --out <dir> [--verify]'); process.exit(2); }
const directory = resolve(out);
const filename = join(directory, 'companion.sqlite');
const hash = value => createHash('sha256').update(value).digest('hex');

const ANON = {
  library: '匿名旧资料库',
  doc: 'anon-legacy.md',
  body: '# 匿名旧文档\n\n迁移演练用的匿名正文，不含真实个人资料。\n',
  fact: '匿名用户事实：测试用匿名偏好。',
  forget: '匿名待遗忘事实：这条在演练中会被遗忘。',
  persona: '匿名旧人设正文。',
};

/** Inventory without exposing text: counts + content hashes only. */
async function inventory(store) {
  const db = store.rawDatabaseForKnowledge();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  const counts = {};
  for (const table of ['knowledge_libraries', 'knowledge_documents', 'knowledge_state', 'memory_records', 'characters',
    'continuity_facts', 'continuity_tombstones', 'continuity_pair_state']) {
    if (!tables.includes(table)) { counts[table] = null; continue; }
    counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  }
  const knowledge = db.prepare('SELECT id, name FROM knowledge_libraries ORDER BY id').all();
  const documents = db.prepare('SELECT id, library_id, source_name, content_hash FROM knowledge_documents ORDER BY id').all();
  return {
    tables,
    counts,
    knowledgeLibraries: knowledge.map(row => ({ id: row.id, nameHash: hash(row.name) })),
    documents: documents.map(row => ({ id: row.id, libraryId: row.library_id, sourceHash: hash(row.source_name), contentHash: row.content_hash })),
  };
}

async function build() {
  await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, 'knowledge'), { recursive: true });
  const store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  try {
    // 1. Legacy global knowledge: one library, singleton activation, no owner column.
    const library = await KnowledgeLibraryStore.open(store, join(directory, 'knowledge'));
    const created = await library.create(ANON.library);
    await library.importDocuments(created.id, [{ sourceName: ANON.doc, text: ANON.body }]);
    await library.activate(library.revision(), created.id);

    // 2. Legacy continuity facts for the canonical pairing, plus one to be forgotten.
    const continuity = await ContinuityMemoryStore.open(store);
    const pairing = { userId: 'anon-user-a', characterId: 'companion', characterInstanceId: 'anon-instance-a' };
    continuity.record({ pairing, operationId: 'anon-op-1', layer: 'user_wiki', kind: 'fact', text: ANON.fact, sourceIds: [], origin: 'user', status: 'active' });
    const doomed = continuity.record({ pairing, operationId: 'anon-op-2', layer: 'user_wiki', kind: 'fact', text: ANON.forget, sourceIds: [], origin: 'user', status: 'active' });
    continuity.forget({ pairing, operationId: 'anon-op-3', targetId: doomed.fact.id, expectedVersion: doomed.fact.version, reason: 'anon rehearsal forget' });

    // 3. Legacy prompt/persona in the memory owner (characters.prompt is the authority).
    const promptScope = { characterId: 'companion', sessionId: 'rehearsal', turnId: 'rehearsal', generation: 0 };
    store.setPrompt(promptScope, ANON.persona);

    // 4. Two instances of the SAME character, to prove instance-level isolation later.
    const second = { userId: 'anon-user-a', characterId: 'companion', characterInstanceId: 'anon-instance-b' };
    continuity.record({ pairing: second, operationId: 'anon-op-4', layer: 'user_wiki', kind: 'fact', text: '匿名第二实例事实。', sourceIds: [], origin: 'user', status: 'active' });

    const before = await inventory(store);
    await writeFile(join(directory, 'inventory.json'), JSON.stringify({ builtAt: new Date().toISOString(), before }, null, 2) + '\n');
    console.log(JSON.stringify({ out: directory, filename, counts: before.counts, libraries: before.knowledgeLibraries.length, documents: before.documents.length }, null, 2));
  } finally { store.close(); }
}

async function verify() {
  const store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  try {
    const after = await inventory(store);
    const recorded = JSON.parse(await readFile(join(directory, 'inventory.json'), 'utf8')).before;
    const drift = Object.keys(recorded.counts).filter(key => recorded.counts[key] !== after.counts[key]);
    console.log(JSON.stringify({
      counts: after.counts,
      drift,
      libraryIdsStable: JSON.stringify(recorded.knowledgeLibraries) === JSON.stringify(after.knowledgeLibraries),
      documentHashesStable: JSON.stringify(recorded.documents) === JSON.stringify(after.documents),
      lostDocuments: recorded.documents.length - after.documents.length,
    }, null, 2));
    process.exitCode = drift.length || recorded.documents.length !== after.documents.length ? 1 : 0;
  } finally { store.close(); }
}

if (args.includes('--verify')) await verify(); else await build();

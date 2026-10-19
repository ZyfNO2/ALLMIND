// RWR-02 acceptance: multi-role admission, the persisted registry, and the pairing/selection lifecycle.
//
// Scope: the registry + the real HTTP management surface, driven through production code paths
// (`SqliteMemoryStore`, `CharacterRegistry`, `startManagementServer`). It never calls a provider, opens a
// device, or touches the real `.local` database.
//
// The behaviours asserted here are the ones RWR-00 G2 marked RED and CONTRACTS §1 froze:
//   * existence comes from the persisted registry, not from a syntax regex or a product constant;
//   * an unknown id is refused and is NEVER created as a side effect of a read;
//   * creation is an explicit transaction and an operationId replay returns the same character;
//   * the SAVED selection does not move the EFFECTIVE role until a restart;
//   * two characters never share records, and two instances of one character never share a pairing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from '../management/helpers.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { CharacterPresetStore } from '../../management/character-preset-store.js';
import { ManagementError } from '../../contracts/management.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CharacterRegistry } from '../../memory/character-registry.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { COMPANION_SCHEMA_VERSION } from '../../memory/database-identity.js';
import { ANON, tempStore } from './fixtures.js';

/** Open a real store over a temp SQLite file; the registry comes from it, never from a constant. */
async function registryStore(t: { after(fn: () => Promise<void> | void): void }) {
  const ts = await tempStore(t, 'rwr-02-');
  return { store: ts.store, registry: ts.store.registry, ts };
}

// AC-1: existence is persisted, not syntactic ------------------------------------------------------
test('RWR-02 AC1: admission is a persisted fact; a syntactically valid id is not admitted', async t => {
  const { registry } = await registryStore(t);

  assert.equal(registry.exists('companion'), true, 'the shipped companion is registered at open');
  // These all pass `isCharacterId`'s regex, and each must still be refused.
  for (const id of ['never-registered-role', 'role-b', 'another-role']) {
    assert.equal(registry.exists(id), false, `${id} passes the syntax regex but was never created`);
  }
  assert.equal(registry.exists('Not A Valid Id'), false);
  assert.equal(registry.exists(''), false);
  assert.equal(registry.exists(null), false);
  assert.equal(registry.exists(42), false);
});

test('RWR-02 AC1b: requiring an unknown character is not_found and creates nothing', async t => {
  const { registry, store } = await registryStore(t);
  const before = registry.list().length;

  assert.throws(() => registry.require('never-registered-role'), (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === 'not_found');

  assert.equal(registry.list().length, before, 'a failed read must not register anything');
  const rows = store.rawDatabaseForKnowledge().prepare('SELECT count(*) AS n FROM character_registry').get() as { n: number };
  assert.equal(rows.n, before, 'no registry row may be created by a read');
});

test('RWR-02 AC1c: the preset store no longer fabricates a default for an unknown role', async t => {
  const f = await fixture(t);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
  const store = await CharacterPresetStore.open({
    filePath: join(f.c.projectRoot, 'character-presets.json'),
    memory: { characters: () => [], prompt: () => ({ revision: 1, text: ANON.personaA }), savePrompt: () => ({ revision: 2, text: '' }) } as never,
    settings, base: f.c,
  });

  await assert.rejects(() => store.getPreset('never-registered-role'), (error: unknown) =>
    error instanceof ManagementError && error.code === 'not_found');
  // The fabricated preset used to carry an invented credential; nothing like it may exist now.
  assert.equal(store['presets'].has('never-registered-role'), false, 'no synthetic preset entry may be created');
});

// AC-2: creation is an explicit, idempotent transaction --------------------------------------------
test('RWR-02 AC2: creation assigns an id, persists the descriptor, and replays by operationId', async t => {
  const { registry } = await registryStore(t);

  const first = registry.create({ label: '研究伙伴', intro: '一起整理资料。', operationId: 'create-1' });
  assert.equal(first.created, true);
  assert.equal(first.character.schemaVersion, 2);
  assert.equal(first.character.label, '研究伙伴');
  assert.equal(first.character.intro, '一起整理资料。');
  assert.equal(first.character.revision, 1);
  assert.ok(first.character.createdAt && first.character.updatedAt);
  assert.equal(registry.exists(first.character.id), true);

  // The same operationId must return the SAME character, not create a second one.
  const replay = registry.create({ label: '研究伙伴', intro: '一起整理资料。', operationId: 'create-1' });
  assert.equal(replay.created, false, 'a replay must not create a second character');
  assert.equal(replay.character.id, first.character.id);
  assert.equal(registry.list().filter(entry => entry.id === first.character.id).length, 1);

  // The same operationId with DIFFERENT content is a conflict, not a silent overwrite.
  assert.throws(() => registry.create({ label: '不同名称', operationId: 'create-1' }), (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === 'operation_id_payload_mismatch');
});

test('RWR-02 AC2b: two characters with the same label get distinct ids and never collide', async t => {
  const { registry } = await registryStore(t);

  const a = registry.create({ label: '日常搭子', operationId: 'dup-a' }).character;
  const b = registry.create({ label: '日常搭子', operationId: 'dup-b' }).character;
  assert.notEqual(a.id, b.id, 'a duplicate label must not reuse or overwrite an id');
  assert.equal(registry.list().filter(entry => entry.label === '日常搭子').length, 2);
});

test('RWR-02 AC2c: a proposed id is honoured once and refused on reuse', async t => {
  const { registry } = await registryStore(t);
  const created = registry.create({ id: 'role-b', label: '角色B', operationId: 'explicit-1' });
  assert.equal(created.character.id, 'role-b');
  assert.throws(() => registry.create({ id: 'role-b', label: '另一个B', operationId: 'explicit-2' }), (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === 'version_conflict');
});

test('RWR-02 AC2d: invalid creation input is refused before any row is written', async t => {
  const { registry } = await registryStore(t);
  const before = registry.list().length;
  assert.throws(() => registry.create({ label: '   ', operationId: 'blank' }), /角色名称无效/);
  assert.throws(() => registry.create({ label: 'x'.repeat(200), operationId: 'long' }), /角色名称无效/);
  assert.throws(() => registry.create({ label: 'ok', operationId: '' }), /操作编号无效/);
  assert.throws(() => registry.create({ label: 'ok', id: 'Not Valid', operationId: 'badid' }), /角色标识无效/);
  assert.equal(registry.list().length, before, 'no refused creation may leave a row behind');
});

// AC-3: the saved/effective split is a restart boundary --------------------------------------------
test('RWR-02 AC3: selection changes the SAVED role only; the effective role moves on restart', async t => {
  const { registry } = await registryStore(t);
  const other = registry.create({ label: '研究伙伴', operationId: 'sel-create' }).character;

  const initial = registry.selection();
  assert.equal(initial.savedCharacterId, 'companion');
  assert.equal(initial.effectiveCharacterId, 'companion');
  assert.equal(initial.applyOn, 'restart');

  const saved = registry.setSelection({ characterId: other.id, expectedRevision: 0, operationId: 'sel-1' });
  assert.equal(saved.savedCharacterId, other.id, 'the saved selection moves immediately');
  assert.equal(saved.effectiveCharacterId, 'companion', 'the RUNNING role must not move before a restart');
  assert.equal(saved.selectionRevision, 1);
  assert.equal(saved.effectiveSelectionRevision, 0, 'the effective cursor stays behind until restart');

  // A restart is the only transition that moves the running role.
  const applied = registry.applySelectionOnStart();
  assert.equal(applied.effectiveCharacterId, other.id);
  assert.equal(applied.effectiveSelectionRevision, applied.selectionRevision);
});

test('RWR-02 AC3b: a stale selection revision is a conflict and keeps the current selection', async t => {
  const { registry } = await registryStore(t);
  const other = registry.create({ label: '研究伙伴', operationId: 'sel2-create' }).character;
  registry.setSelection({ characterId: other.id, expectedRevision: 0, operationId: 'sel2-1' });

  assert.throws(() => registry.setSelection({ characterId: 'companion', expectedRevision: 0, operationId: 'sel2-2' }), (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === 'version_conflict');
  assert.equal(registry.selection().savedCharacterId, other.id, 'a refused switch must not move the selection');

  // Selecting an unregistered role is not_found, not a silent default.
  assert.throws(() => registry.setSelection({ characterId: 'never-registered-role', expectedRevision: 1, operationId: 'sel2-3' }), (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === 'not_found');
});

// AC-4: scope isolation ----------------------------------------------------------------------------
test('RWR-02 AC4: two characters never share records, and neither reads the other', async t => {
  const { store, registry } = await registryStore(t);
  const other = registry.create({ label: '研究伙伴', operationId: 'iso-create' }).character;
  const scope = (id: string): { characterId: string; sessionId: string; turnId: string; generation: number } =>
    ({ characterId: id, sessionId: 's', turnId: 't', generation: 1 });

  store.append(scope('companion'), [{ characterId: 'companion', id: 'raw-a', role: 'user', text: '匿名A的对话', createdAt: '2026-10-05T00:00:00.000Z' }]);
  store.append(scope(other.id), [{ characterId: other.id, id: 'raw-b', role: 'user', text: '匿名B的对话', createdAt: '2026-10-05T00:00:00.000Z' }]);

  assert.equal(store.inspect(scope('companion'), 'raw-a')!.text, '匿名A的对话');
  assert.equal(store.inspect(scope(other.id), 'raw-b')!.text, '匿名B的对话');
  assert.equal(store.inspect(scope('companion'), 'raw-b'), null, 'B content must not be visible under A');
  assert.equal(store.inspect(scope(other.id), 'raw-a'), null, 'A content must not be visible under B');
  assert.equal(store.search(scope('companion'), '匿名B的对话', 10).length, 0, 'A search must not find B content');
});

test('RWR-02 AC4b: the two roles keep independent prompt revisions', async t => {
  const { store, registry } = await registryStore(t);
  const other = registry.create({ label: '研究伙伴', operationId: 'prompt-create' }).character;
  const scope = (id: string) => ({ characterId: id, sessionId: 's', turnId: 't', generation: 1 });

  store.setPrompt(scope('companion'), '匿名A的设定正文');
  store.setPrompt(scope(other.id), '匿名B的设定正文');
  assert.equal(store.prompt(scope('companion')), '匿名A的设定正文');
  assert.equal(store.prompt(scope(other.id)), '匿名B的设定正文');
  assert.notEqual(store.revision(scope('companion')), undefined);
});

// AC-5: the real HTTP surface ------------------------------------------------------------------------
test('RWR-02 AC5: the registry HTTP surface lists, creates and selects through the real server', async t => {
  const { store } = await registryStore(t);
  const f = await fixture(t);
  const memory = {
    registry: store.registry,
    characters: () => store.registry.list().map(entry => ({ id: entry.id, label: entry.label, revision: entry.revision })),
    list: async () => ({ characterId: 'companion', revision: 1, total: 0, offset: 0, limit: 10, records: [] }),
    edit: async () => ({ status: 'applied', record: {} }),
    prompt: () => ({ characterId: 'companion', revision: 1, text: '' }),
    savePrompt: () => ({ characterId: 'companion', revision: 2, text: '' }),
    context: async () => ({ characterId: 'companion', revision: 1, query: '', prompt: '', recent: [], summaries: [], memories: [], inputTokenBudget: 8192 }),
  };
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
  const { startManagementServer } = await import('../../management/server.js');
  const server = await startManagementServer({
    mode: 'runtime', uiRoot: join(f.c.projectRoot, 'ui'), memory: memory as never, settings,
    snapshot: () => ({ apiVersion: 1, runtime: { online: true }, characters: [] }) as never,
  });
  t.after(() => server.close());
  const base = server.url.split('#')[0];
  const call = (path: string, init: RequestInit = {}) => fetch(new URL(path, base), {
    ...init,
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', Origin: server.origin, ...(init.headers ?? {}) },
  });

  const list = await call('api/characters');
  assert.equal(list.status, 200);
  const view = await list.json() as { apiVersion: number; characters: { id: string }[]; selection: { savedCharacterId: string; effectiveCharacterId: string } };
  assert.equal(view.apiVersion, 2, 'the versioned envelope is required for multi-role clients');
  assert.deepEqual(view.characters.map(c => c.id), ['companion']);
  assert.equal(view.selection.savedCharacterId, 'companion');
  // CONTRACTS §1: the descriptor envelope must not carry user-authored bodies.
  assert.equal(JSON.stringify(view).includes('prompt'), false, 'the registry view must not leak prompt bodies');

  const created = await call('api/characters', { method: 'POST', body: JSON.stringify({ label: '研究伙伴', intro: '一起整理资料。', operationId: 'http-create-1' }) });
  assert.equal(created.status, 200);
  const createdBody = await created.json() as { created: boolean; character: { id: string; label: string } };
  assert.equal(createdBody.created, true);
  assert.equal(createdBody.character.label, '研究伙伴');

  const replay = await call('api/characters', { method: 'POST', body: JSON.stringify({ label: '研究伙伴', intro: '一起整理资料。', operationId: 'http-create-1' }) });
  const replayBody = await replay.json() as { created: boolean; character: { id: string } };
  assert.equal(replayBody.created, false, 'an HTTP replay must not create a second character');
  assert.equal(replayBody.character.id, createdBody.character.id);

  const selection = await call('api/characters/selection', { method: 'PUT', body: JSON.stringify({ characterId: createdBody.character.id, expectedRevision: 0, operationId: 'http-sel-1' }) });
  assert.equal(selection.status, 200);
  const selectionBody = await selection.json() as { savedCharacterId: string; effectiveCharacterId: string };
  assert.equal(selectionBody.savedCharacterId, createdBody.character.id);
  assert.equal(selectionBody.effectiveCharacterId, 'companion', 'HTTP selection must not move the running role');

  const unknown = await call('api/characters/selection', { method: 'PUT', body: JSON.stringify({ characterId: 'never-registered-role', expectedRevision: 1, operationId: 'http-sel-2' }) });
  assert.equal(unknown.status, 404, 'an unknown role must be 404, never a fabricated success');
  const unknownBody = await unknown.json() as { error: { code: string } };
  assert.equal(unknownBody.error.code, 'not_found');
});

test('RWR-02 AC5b: the preset route refuses an unknown character instead of synthesizing one', async t => {
  const { store } = await registryStore(t);
  const f = await fixture(t);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
  const presets = await CharacterPresetStore.open({
    filePath: join(f.c.projectRoot, 'character-presets.json'),
    memory: { characters: () => [], prompt: () => ({ revision: 1, text: ANON.personaA }), savePrompt: () => ({ revision: 2, text: '' }) } as never,
    settings, base: f.c,
  });
  const { startManagementServer } = await import('../../management/server.js');
  const server = await startManagementServer({
    mode: 'runtime', uiRoot: join(f.c.projectRoot, 'ui'), settings, presets,
    memory: {
      registry: store.registry,
      characters: () => [], list: async () => ({ characterId: 'companion', revision: 1, total: 0, offset: 0, limit: 10, records: [] }),
      edit: async () => ({ status: 'applied', record: {} }), prompt: () => ({ characterId: 'companion', revision: 1, text: '' }),
      savePrompt: () => ({ characterId: 'companion', revision: 2, text: '' }),
      context: async () => ({ characterId: 'companion', revision: 1, query: '', prompt: '', recent: [], summaries: [], memories: [], inputTokenBudget: 8192 }),
    } as never,
    snapshot: () => ({ apiVersion: 1, runtime: { online: true }, characters: [] }) as never,
  });
  t.after(() => server.close());
  const base = server.url.split('#')[0];
  const response = await fetch(new URL('api/characters/preset?characterId=never-registered-role', base), {
    headers: { Authorization: `Bearer ${server.token}`, Origin: server.origin },
  });
  assert.equal(response.status, 404, 'an unknown character preset read must be 404');
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, 'not_found');
});

// AC-6: restart persistence ------------------------------------------------------------------------
test('RWR-02 AC6: the registry and the selection survive a close/reopen', async t => {
  const ts = await tempStore(t, 'rwr-02-restart-');
  const first = ts.store;
  const other = first.registry.create({ label: '研究伙伴', intro: '一起整理资料。', operationId: 'persist-create' }).character;
  first.registry.setSelection({ characterId: other.id, expectedRevision: 0, operationId: 'persist-sel' });
  first.close();

  const reopened = new SqliteMemoryStore({ filename: ts.filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  ts.track(reopened);
  assert.equal(reopened.registry.exists(other.id), true, 'a created character must survive a restart');
  assert.equal(reopened.registry.require(other.id).intro, '一起整理资料。');
  const selection = reopened.registry.selection();
  assert.equal(selection.savedCharacterId, other.id);
  assert.equal(selection.effectiveCharacterId, other.id, 'a restart applies the saved selection');
  assert.equal(selection.effectiveSelectionRevision, selection.selectionRevision);
});

// AC-7: schema migration -----------------------------------------------------------------------------
test('RWR-02 AC7: a legacy single-role database upgrades without losing a row or the persona', async t => {
  const ts = await tempStore(t, 'rwr-02-migrate-');
  const store = ts.store;
  const scope = { characterId: 'companion', sessionId: 's', turnId: 't', generation: 1 };
  store.append(scope, [{ characterId: 'companion', id: 'raw', role: 'user', text: '匿名迁移前对话', createdAt: '2026-10-05T00:00:00.000Z' }]);
  store.setPrompt(scope, '匿名迁移前人设');
  const revision = store.revision(scope);
  store.close();

  // Rewind the file to the PRE-RWR-02 shape: schema version 4 and the single-role CHECK constraint.
  // Foreign keys are suspended for the rebuild because `memory_records` references `characters`; the
  // production migration does exactly the same thing for the same reason.
  const db = new Database(ts.filename);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TABLE character_registry; DROP TABLE character_registry_operations; DROP TABLE role_selection;
    CREATE TABLE characters_legacy(character_id TEXT PRIMARY KEY CHECK(character_id = 'companion'),
      revision INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, prompt TEXT NOT NULL);
    INSERT INTO characters_legacy SELECT character_id,revision,epoch,prompt FROM characters;
    DROP TABLE characters; ALTER TABLE characters_legacy RENAME TO characters;
  `);
  db.pragma('user_version = 4');
  db.close();

  const migrated = new SqliteMemoryStore({ filename: ts.filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  ts.track(migrated);
  assert.equal(migrated.prompt(scope), '匿名迁移前人设', 'the user persona must survive the migration');
  assert.equal(migrated.revision(scope), revision, 'the memory revision must not be reset by the migration');
  assert.equal(migrated.inspect(scope, 'raw')!.text, '匿名迁移前对话', 'existing records must survive');
  assert.equal(migrated.registry.exists('companion'), true, 'companion is registered by the migration');
  assert.equal(migrated.registry.selection().effectiveCharacterId, 'companion');
  migrated.close();

  const after = new Database(ts.filename, { readonly: true });
  // Track it with the fixture: its cleanup closes every handle BEFORE removing the directory, which is
  // what avoids the Windows "EBUSY ...-wal" race that a plain per-test hook can hit.
  ts.track(after as never);
  assert.equal(after.pragma('user_version', { simple: true }), COMPANION_SCHEMA_VERSION);
  const sql = (after.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }).sql;
  assert.equal(/CHECK\s*\(\s*character_id\s*=\s*'companion'\s*\)/i.test(sql), false, 'the single-role CHECK must be gone');
});

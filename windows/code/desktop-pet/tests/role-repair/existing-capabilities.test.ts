// RWR-01 acceptance: the companion capabilities are wired to their real owners, and a save reports
// success only when the work actually happened.
//
// Scope of this file: the store/service layer plus the management HTTP surface, driven through the
// production code paths (`CharacterPresetStore`, `startManagementServer`). It does not call a
// provider, open a device, or touch the real `.local` database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../management/helpers.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { CharacterPresetStore } from '../../management/character-preset-store.js';
import { ManagementError } from '../../contracts/management.js';
import { ANON } from './fixtures.js';

/** Memory port whose prompt write is the real authority and whose failures are injectable. */
function memoryPort(options: { failSavePrompt?: boolean; revision?: number; text?: string } = {}) {
  const state = { revision: options.revision ?? 1, text: options.text ?? ANON.personaA };
  const savePrompt = (input: { text: string; expectedRevision: number }) => {
    if (options.failSavePrompt) throw new Error('anon: prompt owner rejected the write');
    if (input.expectedRevision !== state.revision) throw new ManagementError('version_conflict', '人设已被更新，请刷新后再保存。');
    state.text = input.text; state.revision += 1;
    return { characterId: ANON.roleA, revision: state.revision, text: state.text };
  };
  const port = {
    characters: () => [{ id: ANON.roleA, label: '青梅竹马', revision: state.revision }],
    prompt: (characterId: string) => ({ characterId, revision: state.revision, text: state.text }),
    savePrompt,
    list: async () => ({ total: 0, offset: 0, limit: 10, records: [] }),
    edit: async () => ({ record: {} }),
    context: async () => ({ prompt: '', recent: [], summaries: [], memories: [], inputTokenBudget: 8192 }),
    forget: async () => ({ forgotten: true, id: 'id-1' }),
  };
  return { state, savePrompt, port: port as never };
}

/** Skin registry whose activation is injectable and revision-checked, like the real store. */
function skinPort(options: { failActivate?: boolean } = {}) {
  const state = { revision: 1, activeSkinId: 'anon-skin' };
  return {
    state,
    port: {
      state: () => ({ revision: state.revision, activeSkinId: state.activeSkinId, skins: [] }),
      active: () => ({ skinId: state.activeSkinId, label: 'anon', origin: 'builtin', modelEntry: 'pet.model3.json' }),
      list: () => [],
      activate: async (expectedRevision: number, skinId: string) => {
        if (options.failActivate) throw new Error('anon: skin registry rejected the switch');
        if (expectedRevision !== state.revision) throw new ManagementError('version_conflict', '模型包登记已更新，请刷新后重试。');
        state.revision += 1; state.activeSkinId = skinId;
        return { revision: state.revision, activeSkinId: skinId, skins: [] };
      },
      import: async () => ({ revision: state.revision, activeSkinId: state.activeSkinId, skins: [] }),
      remove: async () => ({ revision: state.revision, activeSkinId: state.activeSkinId, skins: [] }),
      routes: () => new Map(),
    } as never,
  };
}

async function openStore(f: Awaited<ReturnType<typeof fixture>>, memory: ReturnType<typeof memoryPort>, skins: ReturnType<typeof skinPort>, filePath?: string) {
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
  const store = await CharacterPresetStore.open({
    filePath: filePath ?? join(f.c.projectRoot, 'character-presets.json'),
    memory: memory.port, settings, skins: skins.port, base: f.c,
  });
  return { store, settings };
}

// AC-1 ---------------------------------------------------------------------------------------------
test('RWR-01 AC1: a real persona save goes through the prompt owner and returns its revision', async t => {
  const f = await fixture(t);
  const memory = memoryPort();
  const { store } = await openStore(f, memory, skinPort());

  const receipt = await store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, persona: { text: '匿名新正文' } });

  assert.equal(receipt.applyStatus, 'applied');
  assert.equal(receipt.applied.persona, true);
  assert.equal(memory.state.text, '匿名新正文', 'the prompt owner must hold the new text');
  assert.equal(receipt.persona.text, '匿名新正文');
  assert.equal(receipt.persona.revision, memory.state.revision, 'the receipt must project the OWNER revision, not a locally guessed one');
});

test('RWR-01 AC1b: a persona save whose owner rejects must fail and leave nothing changed', async t => {
  const f = await fixture(t);
  const memory = memoryPort({ failSavePrompt: true });
  const { store } = await openStore(f, memory, skinPort());

  await assert.rejects(
    () => store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, persona: { text: '匿名新正文' } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'unavailable',
  );
  assert.equal(memory.state.text, ANON.personaA, 'a rejected persona write must not change the authority');
  const after = await store.getPreset(ANON.roleA);
  assert.equal(after.revision, 1, 'revision must not advance when the save failed');
});

// AC-2 ---------------------------------------------------------------------------------------------
test('RWR-01 AC2: appearance applies through the skin registry and reports the applied resource', async t => {
  const f = await fixture(t);
  const skins = skinPort();
  const { store } = await openStore(f, memoryPort(), skins);

  const receipt = await store.savePreset({
    characterId: ANON.roleA, expectedRevision: 1,
    appearance: { type: 'live2d', resourceId: 'anon-skin-2' },
  });

  assert.equal(receipt.applied.appearance, true);
  assert.equal(skins.state.activeSkinId, 'anon-skin-2', 'the skin registry must be the applied authority');
  assert.equal(receipt.appearance.resourceId, 'anon-skin-2');
});

test('RWR-01 AC2b: a rejected skin switch must fail rather than report success', async t => {
  const f = await fixture(t);
  const skins = skinPort({ failActivate: true });
  const { store } = await openStore(f, memoryPort(), skins);

  await assert.rejects(
    () => store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, appearance: { type: 'live2d', resourceId: 'anon-skin-9' } }),
    (error: unknown) => error instanceof ManagementError,
  );
  assert.equal(skins.state.activeSkinId, 'anon-skin', 'the registry must be unchanged after a failed switch');
  assert.equal((await store.getPreset(ANON.roleA)).revision, 1);
});

test('RWR-01 AC2c: a missing skin registry is unavailable, never a silent no-op', async t => {
  const f = await fixture(t);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
  const store = await CharacterPresetStore.open({
    filePath: join(f.c.projectRoot, 'character-presets.json'),
    memory: memoryPort().port, settings, base: f.c, // no skins
  });

  await assert.rejects(
    () => store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, appearance: { type: 'live2d', resourceId: 'anon-skin-3' } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'unavailable',
  );
});

// AC-3 ---------------------------------------------------------------------------------------------
test('RWR-01 AC3: a disk write failure never advances the in-memory revision', async t => {
  const f = await fixture(t);
  const blocker = join(f.c.projectRoot, 'blocker');
  await writeFile(blocker, 'not a directory');
  const { store } = await openStore(f, memoryPort(), skinPort(), join(blocker, 'character-presets.json'));

  await assert.rejects(
    () => store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, appearance: { type: 'live2d', resourceId: 'anon-skin-4' } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'unavailable',
  );
  assert.equal((await store.getPreset(ANON.roleA)).revision, 1, 'a failed commit must not move the revision');
});

test('RWR-01 AC3b: a successful save is durable across a reopen', async t => {
  const f = await fixture(t);
  const filePath = join(f.c.projectRoot, 'character-presets.json');
  const memory = memoryPort();
  const skins = skinPort();
  const { store } = await openStore(f, memory, skins, filePath);
  await store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, persona: { text: '匿名持久化正文' }, appearance: { type: 'live2d', resourceId: 'anon-skin-5' } });

  const reopened = await openStore(f, memory, skins, filePath);
  const persisted = await reopened.store.getPreset(ANON.roleA);
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.persona.text, '匿名持久化正文');
  assert.equal(persisted.appearance.resourceId, 'anon-skin-5');

  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(onDisk[ANON.roleA].persona.text, '匿名持久化正文', 'the commit point is the file, not the memory map');
});

// AC-4 ---------------------------------------------------------------------------------------------
test('RWR-01 AC4: a stale revision is a version_conflict that preserves the caller draft', async t => {
  const f = await fixture(t);
  const { store } = await openStore(f, memoryPort(), skinPort());
  await store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, persona: { text: '第一次' } });

  await assert.rejects(
    () => store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, persona: { text: '第二次（过期草稿）' } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict',
  );
  const current = await store.getPreset(ANON.roleA);
  assert.equal(current.revision, 2, 'the winning revision must be readable so the UI can reload and merge');
});

// AC-5 ---------------------------------------------------------------------------------------------
test('RWR-01 AC5: the preset save route returns the receipt through the real HTTP surface', async t => {
  const f = await fixture(t);
  const memory = memoryPort();
  const skins = skinPort();
  const { store, settings } = await openStore(f, memory, skins);

  // Drive the production route handler rather than a re-implementation of it.
  const { startManagementServer } = await import('../../management/server.js');
  // RWR-02: every HTTP entry point admits through the PERSISTED registry, so the fake port has to
  // provide one. `companion` is the registered role here; anything else is refused with `not_found`.
  const registryPort = {
    list: () => [{ schemaVersion: 2 as const, id: ANON.roleA, label: '青梅竹马', intro: '', revision: 1, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }],
    get: (id: unknown) => (id === ANON.roleA
      ? { schemaVersion: 2 as const, id: ANON.roleA, label: '青梅竹马', intro: '', revision: 1, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }
      : null),
    create: () => { throw new Error('not used in this test'); },
    selection: () => ({ savedCharacterId: ANON.roleA, effectiveCharacterId: ANON.roleA, selectionRevision: 0, effectiveSelectionRevision: 0, applyOn: 'restart' as const }),
    setSelection: () => { throw new Error('not used in this test'); },
  };
  const memoryPortForServer = {
    registry: registryPort,
    characters: () => [{ id: ANON.roleA, label: '青梅竹马', revision: memory.state.revision }],
    list: async () => ({ characterId: ANON.roleA, revision: 1, total: 0, offset: 0, limit: 10, records: [] }),
    edit: async () => ({ status: 'applied', record: {} }),
    prompt: (characterId: string) => ({ characterId, revision: memory.state.revision, text: memory.state.text }),
    savePrompt: memory.savePrompt as never,
    context: async () => ({ characterId: ANON.roleA, revision: 1, query: '', prompt: '', recent: [], summaries: [], memories: [], inputTokenBudget: 8192 }),
  };
  const server = await startManagementServer({
    mode: 'runtime', uiRoot: join(f.c.projectRoot, 'ui'), memory: memoryPortForServer as never,
    settings, presets: store, skins: skins.port,
    snapshot: () => ({ apiVersion: 1, runtime: { online: true }, characters: [] }) as never,
  });
  t.after(() => server.close());

  const response = await fetch(new URL('api/characters/preset', server.url.split('#')[0]), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', Origin: server.origin },
    body: JSON.stringify({ characterId: ANON.roleA, expectedRevision: 1, persona: { text: '匿名HTTP正文' } }),
  });
  assert.equal(response.status, 200);
  const receipt = await response.json() as { applyStatus: string; applied: { persona: boolean }; persona: { text: string } };
  assert.equal(receipt.applyStatus, 'applied');
  assert.equal(receipt.applied.persona, true);
  assert.equal(receipt.persona.text, '匿名HTTP正文');
});

test('RWR-01 AC5b: a failing side effect surfaces as a non-2xx HTTP status, not a success body', async t => {
  const f = await fixture(t);
  const memory = memoryPort({ failSavePrompt: true });
  const skins = skinPort();
  const { store, settings } = await openStore(f, memory, skins);
  const { startManagementServer } = await import('../../management/server.js');
  // RWR-02: the registry is the admission authority; this fake registers `companion` only.
  const registryForFail = {
    list: () => [{ schemaVersion: 2 as const, id: ANON.roleA, label: '青梅竹马', intro: '', revision: 1, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }],
    get: (id: unknown) => (id === ANON.roleA
      ? { schemaVersion: 2 as const, id: ANON.roleA, label: '青梅竹马', intro: '', revision: 1, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }
      : null),
    create: () => { throw new Error('not used in this test'); },
    selection: () => ({ savedCharacterId: ANON.roleA, effectiveCharacterId: ANON.roleA, selectionRevision: 0, effectiveSelectionRevision: 0, applyOn: 'restart' as const }),
    setSelection: () => { throw new Error('not used in this test'); },
  };
  const server = await startManagementServer({
    mode: 'runtime', uiRoot: join(f.c.projectRoot, 'ui'),
    memory: {
      registry: registryForFail,
      characters: () => [], list: async () => ({ characterId: ANON.roleA, revision: 1, total: 0, offset: 0, limit: 10, records: [] }),
      edit: async () => ({ status: 'applied', record: {} }), prompt: () => ({ characterId: ANON.roleA, revision: 1, text: '' }),
      savePrompt: memory.savePrompt as never,
      context: async () => ({ characterId: ANON.roleA, revision: 1, query: '', prompt: '', recent: [], summaries: [], memories: [], inputTokenBudget: 8192 }),
    } as never,
    settings, presets: store, skins: skins.port,
    snapshot: () => ({ apiVersion: 1, runtime: { online: true }, characters: [] }) as never,
  });
  t.after(() => server.close());

  const response = await fetch(new URL('api/characters/preset', server.url.split('#')[0]), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', Origin: server.origin },
    body: JSON.stringify({ characterId: ANON.roleA, expectedRevision: 1, persona: { text: '匿名HTTP正文' } }),
  });
  assert.notEqual(response.status, 200, 'a failed save must not answer 200');
  const body = await response.json() as { error?: { code?: string } };
  assert.ok(body.error?.code, 'the failure must carry a machine-readable code');
});

// AC-6: records / continuity details -----------------------------------------------------------------
test('RWR-01 AC6: records paginate and continuity snapshot returns real bodies for the canonical pairing', async t => {
  const f = await fixture(t);
  const { tempStore } = await import('./fixtures.js');
  const ts = await tempStore(t);
  const { ContinuityMemoryStore } = await import('../../memory/continuity-memory-store.js');
  const { continuityManagement, continuityRoute } = await import('../../management/continuity-routes.js');

  const continuity = await ContinuityMemoryStore.open(ts.store);
  const port = continuityManagement(continuity);
  const pairing = { userId: ANON.userA, characterId: ANON.roleA, characterInstanceId: ANON.instanceA };
  const recorded = await continuityRoute('POST', port, '/api/continuity/record', async () => ({
    pairing, operationId: 'rwr01-op-1', layer: 'user_wiki', kind: 'fact', text: ANON.forgottenFact, origin: 'user', status: 'active',
  })) as { fact: { id: string; version: number } };
  assert.ok(recorded.fact.id);

  const snapshot = await continuityRoute('POST', port, '/api/continuity/snapshot', async () => ({ pairing, includeCandidates: true })) as { wiki: readonly { id: string; text: string }[] };
  const found = snapshot.wiki.find(fact => fact.id === recorded.fact.id);
  assert.ok(found, 'the snapshot must return the real body, not an empty list');
  assert.equal(found.text, ANON.forgottenFact);

  // A different instance of the same character must not see it.
  const otherInstance = await continuityRoute('POST', port, '/api/continuity/snapshot', async () => ({
    pairing: { ...pairing, characterInstanceId: ANON.instanceB }, includeCandidates: true,
  })) as { wiki: readonly unknown[] };
  assert.equal(otherInstance.wiki.length, 0, 'pairing isolation is per instance, not per character');
});

test('RWR-01 AC6b: forgetting removes the body from the next context, not just from the list', async t => {
  const { tempStore } = await import('./fixtures.js');
  const ts = await tempStore(t);
  const { ContinuityMemoryStore } = await import('../../memory/continuity-memory-store.js');
  const { continuityManagement, continuityRoute } = await import('../../management/continuity-routes.js');

  const continuity = await ContinuityMemoryStore.open(ts.store);
  const port = continuityManagement(continuity);
  const pairing = { userId: ANON.userA, characterId: ANON.roleA, characterInstanceId: ANON.instanceA };
  const recorded = await continuityRoute('POST', port, '/api/continuity/record', async () => ({
    pairing, operationId: 'rwr01-op-2', layer: 'user_wiki', kind: 'fact', text: ANON.forgottenFact, origin: 'user', status: 'active',
  })) as { fact: { id: string; version: number } };

  await continuityRoute('POST', port, '/api/continuity/forget', async () => ({
    pairing, operationId: 'rwr01-op-3', targetId: recorded.fact.id, expectedVersion: recorded.fact.version, reason: 'anon: 用户要求遗忘',
  }));

  const after = await continuityRoute('POST', port, '/api/continuity/snapshot', async () => ({ pairing, includeCandidates: true })) as { wiki: readonly { id: string }[] };
  assert.equal(after.wiki.length, 0, 'a forgotten fact must not survive into the next context');
});

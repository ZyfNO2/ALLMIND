// RWR-00 RED baseline: six minimal tests that FAIL against the current tree.
//
// Each one asserts the behaviour a later sub-SPEC must deliver, so the failure is the evidence that
// the gap is real rather than inferred from reading code. RWR-01..06 turn these GREEN.
//
//   G1 保存副作用失败仍报成功        -> RWR-01
//   G2 未知角色自动生成预设          -> RWR-02
//   G3 预设模型不被 runtime 消费      -> RWR-03
//   G4 知识跨角色误读                -> RWR-04
//   G5 本地来源未注册                -> RWR-05
//   G6 故事书不进入实际 Context      -> RWR-06
//
// Nothing here writes to the real `.local` database or calls a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../management/helpers.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { CharacterPresetStore } from '../../management/character-preset-store.js';
import { availableAdapters, defaultManagedSettings } from '../../management/settings.js';
import { toRoleConfigurationV2 } from '../../management/role-configuration.js';
import { KnowledgeLibraryStore } from '../../memory/knowledge-library.js';
import { ANON, RWR_LIMITS, tempStore, seedLegacyGlobalKnowledge } from './fixtures.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Minimal memory port: only the two calls CharacterPresetStore actually makes are meaningful. */
function memoryPort(overrides: Record<string, unknown> = {}) {
  return {
    characters: () => [{ id: ANON.roleA, label: '青梅竹马', revision: 1 }],
    prompt: (characterId: string) => ({ characterId, revision: 1, text: ANON.personaA }),
    savePrompt: (input: { text: string }) => ({ characterId: ANON.roleA, revision: 2, text: input.text }),
    list: async () => ({ total: 0, offset: 0, limit: 10, records: [] }),
    edit: async () => ({ record: {} }),
    context: async () => ({ prompt: '', recent: [], summaries: [], memories: [], inputTokenBudget: 8192 }),
    forget: async () => ({ forgotten: true, id: 'id-1' }),
    ...overrides,
  } as never;
}

function skinPort() {
  let activeSkin = 'anon-skin';
  return {
    state: () => ({ revision: 1, activeSkinId: activeSkin, skins: [] }),
    active: () => ({ skinId: activeSkin }),
    activate: async (_revision: number, skinId: string) => { activeSkin = skinId; return { revision: 2, activeSkinId: skinId, skins: [] }; },
  } as never;
}

// G1 ---------------------------------------------------------------------------------------------
test('RWR-00 G1: preset save must not report success when a side effect or the disk write fails', async t => {
  const f = await fixture(t);
  const failingMemory = memoryPort({ savePrompt: () => { throw new Error('anon: prompt owner rejected the write'); } });
  const store = await CharacterPresetStore.open({
    filePath: join(f.c.projectRoot, 'character-presets.json'),
    memory: failingMemory, settings: await ManagementSettingsStore.open(join(f.c.projectRoot, 's.json'), f.c),
    skins: skinPort(), base: f.c,
  });

  await assert.rejects(
    () => store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, persona: { text: '匿名新正文' } }),
    'a persona save whose prompt-owner write failed must surface the failure, not resolve successfully',
  );
});

test('RWR-00 G1b: an unwritable preset file must not leave the in-memory map advanced', async t => {
  const f = await fixture(t);
  // A regular file where a directory is expected makes mkdir/writeFile fail with ENOTDIR.
  const blocker = join(f.c.projectRoot, 'blocker');
  await (await import('node:fs/promises')).writeFile(blocker, 'not a directory');
  const store = await CharacterPresetStore.open({
    filePath: join(blocker, 'character-presets.json'),
    memory: memoryPort(), settings: await ManagementSettingsStore.open(join(f.c.projectRoot, 's.json'), f.c),
    skins: skinPort(), base: f.c,
  });

  const before = await store.getPreset(ANON.roleA);
  await assert.rejects(
    () => store.savePreset({ characterId: ANON.roleA, expectedRevision: before.revision, appearance: { type: 'live2d', resourceId: 'anon-skin-2' } }),
    'a preset whose disk write failed must not report success',
  );
  const after = await store.getPreset(ANON.roleA);
  assert.equal(after.revision, before.revision, 'revision must not advance when persistence failed');
});

// G2 ---------------------------------------------------------------------------------------------
test('RWR-00 G2: reading an unregistered character must not fabricate a preset', async t => {
  const f = await fixture(t);
  const store = await CharacterPresetStore.open({
    filePath: join(f.c.projectRoot, 'character-presets.json'),
    memory: memoryPort(), settings: await ManagementSettingsStore.open(join(f.c.projectRoot, 's.json'), f.c),
    skins: skinPort(), base: f.c,
  });

  await assert.rejects(
    () => store.getPreset('never-registered-role'),
    'an unknown character id must fail (not_found), not silently receive a synthetic default preset',
  );
});

// G3 ---------------------------------------------------------------------------------------------
test('RWR-00 G3: a saved role binding must be the configuration the runtime actually consumes', async t => {
  const f = await fixture(t);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
  const store = await CharacterPresetStore.open({
    filePath: join(f.c.projectRoot, 'character-presets.json'),
    memory: memoryPort(), settings, skins: skinPort(), base: f.c,
  });

  await store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, bindings: { dialogue: { model: 'anon-role-dialogue-model' } } });

  // RWR-03: the runtime consumes the role configuration through the single effective-role resolver
  // (CONTRACTS §2). Reading the raw global projection would assert the very shadow-record gap this
  // test exists to rule out, so the assertion is made through the real consumption path. The asserted
  // property is unchanged: the binding written through the preset surface must be what the runtime
  // actually uses.
  const preset = await store.getPreset(ANON.roleA);
  const saved = toRoleConfigurationV2(preset, f.c, settings.effective);
  assert.equal(saved.bindings.dialogue.mode, 'own', 'a saved concrete model must become an explicit own binding, not be dropped');
  assert.equal(saved.bindings.dialogue.modelProfileId, 'anon-role-dialogue-model');
  assert.ok(saved.bindings.dialogue.credentialRef, 'the binding keeps its credential reference');
});

// G4 ---------------------------------------------------------------------------------------------
test('RWR-00 G4: a reference library must carry an owner so roles cannot read each other', async t => {
  const f = await tempStore(t);
  const library = await KnowledgeLibraryStore.open(f.store, join(f.dir, 'knowledge'));
  const created = await library.create(ANON.libraryTitle);

  assert.ok(
    'ownerCharacterId' in created,
    'CONTRACTS §3: a reference library must record its owning character; today the schema has no owner column at all',
  );
});

test('RWR-00 G4b: the legacy global activation must be upgradeable without losing documents', async t => {
  const f = await tempStore(t);
  const seeded = await seedLegacyGlobalKnowledge(f);
  const reopened = await KnowledgeLibraryStore.open(f.store, join(f.dir, 'knowledge'));

  assert.equal(reopened.active().libraryId, seeded.libraryId, 'legacy singleton activation must still resolve before migration');
  assert.ok(reopened.documents(seeded.libraryId).length >= 1, 'legacy documents must survive the fixture round-trip');
  assert.ok(
    'ownerCharacterId' in reopened.list()[0]!,
    'after RWR-04 the migrated library must be owned by a character; the pre-migration shape has no such field',
  );
});

// G5 ---------------------------------------------------------------------------------------------
test('RWR-00 G5: the local SAPI/Sherpa sources must appear in the management catalog', async t => {
  const f = await fixture(t);
  const adapters = availableAdapters(f.c);
  const ids = adapters.map(a => a.id).join(',');
  assert.ok(/sapi/i.test(ids), `no SAPI (local TTS) source is registered; catalog ids: ${ids}`);
  assert.ok(/sherpa/i.test(ids), `no Sherpa (local STT) source is registered; catalog ids: ${ids}`);
});

test('RWR-00 G5b: the registered limits must be the frozen ones', () => {
  assert.equal(RWR_LIMITS.lorebook.contextTokensPerTurn, 2048);
  assert.equal(RWR_LIMITS.lorebook.booksPerCharacter, 16);
  assert.equal(RWR_LIMITS.localCapabilityProbeMs, 10_000);
});

// G6 ---------------------------------------------------------------------------------------------
test('RWR-00 G6: a Lorebook must exist and be consumed by the real Context assembly', async t => {
  const missing = ['contracts/lorebook.ts', 'memory/lorebook-store.ts', 'management/lorebook-routes.ts']
    .filter(rel => !existsSync(resolve(projectRoot, rel)));
  assert.deepEqual(missing, [], `RWR-06 must add these modules; missing: ${missing.join(', ')}`);
});

test('RWR-00 G6b: the single Context assembly point must reference Lorebook', async t => {
  const pipeline = readFileSync(resolve(projectRoot, 'core/dialogue-pipeline.ts'), 'utf8');
  assert.ok(/lorebook/i.test(pipeline), 'the production Context assembly must consume Lorebook entries, not a parallel prompt path');
});

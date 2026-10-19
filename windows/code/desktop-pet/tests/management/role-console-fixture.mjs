import { join, resolve } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { fixture } from '../../dist/tests/management/helpers.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../dist/memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../dist/companion/invitations.js';
import { SqliteManagementMemoryPort } from '../../dist/memory/management-port.js';
import { ManagementSettingsStore } from '../../dist/management/settings-store.js';
import { ManagementRuntime } from '../../dist/management/runtime.js';
import { RoleConfigurationStore } from '../../dist/management/role-configuration.js';
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js';
import { SkinStore } from '../../dist/management/skin-store.js';
import { LorebookStore } from '../../dist/memory/lorebook-store.js';
import { KnowledgeLibraryStore } from '../../dist/memory/knowledge-library.js';
import { knowledgeManagement } from '../../dist/management/knowledge-routes.js';
import { continuityManagement } from '../../dist/management/continuity-routes.js';
import { CharacterPackStore } from '../../dist/memory/character-pack-store.js';
import { ContinuityMemoryStore } from '../../dist/memory/continuity-memory-store.js';
import { UnifiedTimelineService } from '../../dist/memory/unified-timeline.js';
import { createSelfSetup } from '../../dist/management/self-setup.js';
import { credentialRegistry } from '../../dist/management/credentials.js';
import { availableAdapters } from '../../dist/management/settings.js';
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js';
import { startManagementServer } from '../../dist/management/server.js';
import { SqliteMemoryImportManagement } from '../../dist/memory/import-management.js';

export async function roleConsoleFixture(t, options = {}) {
  const cleanup = [], owner = t;
  t = { after: action => cleanup.push(action) };
  owner.after(async () => { for (const action of cleanup.reverse()) await action(); });
  const f = await fixture(t), root = resolve('.');
  f.c.models.asr = { ...f.c.models.dialogue, model: 'fixture-asr', endpoint: 'https://example.invalid/v1/audio/transcriptions', audioMicrosPerSecond: 10 };
  await mkdir(join(f.c.projectRoot, '.local/data'), { recursive: true });
  const store = new SqliteMemoryStore({ filename: f.c.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  t.after(() => store.close());
  for (const id of ['companion','role-b']) if (!store.registry.exists(id)) store.registry.create({ id, label: id === 'companion' ? '验收角色 A' : '验收角色 B', operationId: `fixture-create-${id}` });
  const lifecycle = { store, assertContextCurrent() {}, async context(scope) { return { scope, characterPrompt: '', recent: [], summaries: [], memories: [], notes: [] }; } };
  const memory = new SqliteManagementMemoryPort(store, lifecycle);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c); t.after(() => settings.close());
  const roles = await RoleConfigurationStore.open({ file: join(f.c.projectRoot, 'roles.json') });
  for (const id of ['companion','role-b']) {
    await roles.save({ schemaVersion: 2, characterId: id, revision: 0, savedRevision: 0, effectiveRevision: 0, applyOn: 'restart',
      identity: { intro: `简介-${id}` }, persona: { text: '', revision: 0, scenario: '保留背景', firstMessage: '展示开场', exampleDialogue: '示例' },
      appearance: { type: 'live2d', resourceId: 'local-model' }, bindings: { dialogue: { mode: 'inherit-default' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } } });
    store.setPrompt({ characterId: id, sessionId: 'fixture', turnId: 'persona', generation: 0 }, `完整人设-${id}`);
  }
  const skins = await SkinStore.open(join(f.c.projectRoot, 'skins.json'), join(f.c.projectRoot, 'packs'), join(root,'desktop'));
  const presets = await CharacterPresetStore.open({ memory, settings, skins, base: f.c, roleConfigurations: roles });
  const credentials = credentialRegistry(f.c), runtime = new ManagementRuntime(f.c.sourceRevision);
  // Keys in this unique installation directory are anonymous; never touch another installation.
  t.after(async () => { if (credentials.managed.directory.includes(f.c.projectRoot)) throw Error('unexpected secret directory'); await rm(credentials.managed.directory, { recursive: true, force: true }); });
  const selfSetup = createSelfSetup({ base: f.c, settings, instanceId: runtime.identity().instanceId, mode: 'runtime', credentials: credentials.managed });
  const knowledgeStore = await KnowledgeLibraryStore.open(store, join(f.c.projectRoot, 'knowledge'));
  const timeline = new UnifiedTimelineService(store.rawDatabaseForKnowledge(), await CharacterPackStore.open(store.rawDatabaseForKnowledge()));
  const continuity = await ContinuityMemoryStore.open(store.rawDatabaseForKnowledge());
  const importProcessor={hold:false,calls:[]};
  const memoryImport = new SqliteMemoryImportManagement({ filename: join(f.c.projectRoot,'imports.sqlite'), codexHome: join(f.c.projectRoot,'codex'), instanceId: runtime.identity().instanceId, store,
    configuration: { model:'anonymous-fixture-memory',endpointHost:'fixture.invalid',batchMessages:1,maxInputBytes:65536,maxOutputTokens:64,concurrency:1,timeoutMs:5000,budgetMode:'unlimited',limitMicros:null,inputMicrosPerToken:1,outputMicrosPerToken:1,currency:'CNY',textExportFormat:'jsonl-v1' },
    processor: { async plan(input,signal) { importProcessor.calls.push(input.scope);if(importProcessor.hold)await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return { scope:input.scope,request:'none',changes:[],suppressSources:[],retainSources:[],clarification:null,reason:'fixture no changes' }; } } });
  t.after(() => memoryImport.close());
  // Exported so a test that starts its OWN server (e.g. the LUI-02 config browser test) reuses this
  // exact instance instead of opening a second handle on the same SQLite file.
  const lorebooks = LorebookStore.open(store);
  const server = await startManagementServer({ uiRoot: join(root,'management'), settings, memory, roleConfigurations: roles, skins, presets, selfSetup, memoryImport,
    // DUX-03: a test may inject a (stub) Playground turn port; absent leaves the section unavailable.
    ...(options.playground ? { playground: options.playground } : {}),
    lorebooks, knowledge: knowledgeManagement(knowledgeStore), continuity: continuityManagement(continuity),
    presentationAssets: await presentationAssetRoutes(resolve(root,'../..')),
    unifiedTimeline: query => timeline.queryTimeline({ ...query, pairing: query.pairing || { userId: 'local-user', characterId: 'companion', characterInstanceId: 'companion-default' } }),
    snapshot: () => ({ apiVersion: 1, runtime: { ...runtime.identity(), characterId: 'companion', characterLabel: '验收角色 A', online: true }, modules: runtime.modules(), events: [], settings: settings.snapshot(),
      adapters: availableAdapters(f.c), credentials: credentials.list(), characters: memory.characters() }) });
  t.after(() => server.close());
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(server.origin + path, { method, headers: { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); if (!response.ok) throw Object.assign(Error(value.error?.message), { status: response.status, code: value.error?.code }); return value;
  };
  return { ...f, root, store, memory, settings, roles, skins, credentials, server, request, knowledgeStore, timeline, continuity, memoryImport, importProcessor, lorebooks, selfSetup };
}

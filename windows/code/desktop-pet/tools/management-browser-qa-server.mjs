// RWR-07 browser QA (worker `browser-qa`): start the REAL management server against an ISOLATED
// anonymous temp store on a WORKER-OWNED port, so browser automation never touches:
//   * windows/.local/data/companion.sqlite   (the real user database)
//   * .local/anon-mgmt/anon-companion.sqlite (the shared anon server owned by another teammate)
//   * any user process (this script never kills anything; the caller stops only this pid)
//
// Why a copy of tools/management-anon-server.mjs instead of reusing it:
//   the upstream script hardcodes its temp directory (`.local/anon-mgmt`) AND shares one SQLite file
//   across every launch. RWR-07 browser automation needs `app.mjs`'s precondition to hold:
//     snap.runtime.characterId === 'companion' && characters.length === 1 && characters[0].id === 'companion'
//   The shared anon DB currently carries TWO roles ('companion' + 'c'), which makes the console throw
//   「当前服务与单角色版本不匹配」. Rather than mutate a database another worker owns, this instance
//   builds its own registry from scratch in its own directory on its own port.
//
// Seeding: exactly one role, id `companion`, plus a persona body and one lorebook-free start, so the
// 故事书 panel's「新建故事书」transaction is genuinely exercised from an empty list.
//
// Usage:
//   node tools/management-browser-qa-server.mjs [--port 10159]
//
// It prints one JSON line { origin, token, url, sessionFile, db, dir, pid } and writes the same to
// <dir>/session.json. Content is invented/anonymous only; nothing is copied from any user database.

import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { restrictPrivatePathSync } from '../dist/core/platform-files.js';
import { startManagementServer } from '../dist/management/server.js';
import { ManagementSettingsStore } from '../dist/management/settings-store.js';
import { ManagementRuntime } from '../dist/management/runtime.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../dist/memory/sqlite-store.js';
import { SqliteManagementMemoryPort } from '../dist/memory/management-port.js';
import { LorebookStore } from '../dist/memory/lorebook-store.js';
import { confirmedInvitationPolicy } from '../dist/companion/invitations.js';
import { RuntimeTraceStore } from '../dist/core/trace-store.js';
import { readTraceContentFromHistory } from '../dist/memory/trace-history-content.js';
import { CharacterPresetStore } from '../dist/management/character-preset-store.js';
import { RoleConfigurationStore } from '../dist/management/role-configuration.js';
import { createSelfSetup } from '../dist/management/self-setup.js';
import { credentialRegistry } from '../dist/management/credentials.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const port = Number(option('port') ?? process.env.PET_MGMT_PORT ?? 10159);

const dir = resolve(root, '.local', 'browser-qa-mgmt');
mkdirSync(join(dir, 'packs'), { recursive: true });
const dbPath = join(dir, 'browser-qa-companion.sqlite');

// Fresh store each launch so repeated runs do not inherit a previous run's rows.
for (const suffix of ['', '-wal', '-shm']) { try { await rm(dbPath + suffix, { force: true }); } catch { /* ignore */ } }

const base = {
  version: 1, product: 'companion-v1', phaseId: 'local-browser-qa', purpose: 'user-trial',
  projectRoot: dir, sourceRevision: 'b'.repeat(40),
  runtimeFiles: {}, database: dbPath, budgetFile: join(dir, 'budget.json'), budgetBatchId: 'browser-qa-batch',
  limitMicros: 20000000, phaseLimitMicros: 20000000, maxCalls: 200,
  operationLimits: { admission: 40, dialogue: 40, memory_turn: 40, summary: 20, perception: 20, tts: 40 },
  memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
  models: {},
};

const runtime = new ManagementRuntime(base.sourceRevision);
const store = new SqliteMemoryStore({ filename: dbPath, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });

// EXACTLY one role named `companion`: the shipped console renders only under this shape (app.mjs:411).
const ROLE_ID = 'companion';
let seeded = false;
try {
  if (!store.registry.list().some(entry => entry.id === ROLE_ID)) {
    const created = store.registry.create({
      id: ROLE_ID, label: '浏览器验收角色',
      intro: '浏览器自动化验收用的匿名角色简介，不含任何真实个人资料。',
      operationId: 'browser-qa-create-1',
    });
    seeded = Boolean(created?.character?.id) || store.registry.list().some(entry => entry.id === ROLE_ID);
  }
  store.setPrompt({ characterId: ROLE_ID, sessionId: 'browser-qa', turnId: 'browser-qa', generation: 0 },
    '浏览器验收角色的匿名人设正文：用于验证「保存人设正文」写通提示词权威。');
} catch (error) { console.error('browser-qa seed warning:', error?.message ?? error); }

const lifecycle = {
  store,
  assertContextCurrent: () => {},
  context: async (scope, query) => {
    const records = store.queryRecords(scope, { kind: 'memory', query: query || '', offset: 0, limit: 10, state: 'active' });
    const transcripts = store.queryRecords(scope, { kind: 'transcript', query: '', offset: 0, limit: 10, state: 'active' });
    return {
      scope, characterPrompt: '', recent: transcripts.records.map(r => ({ id: r.id, text: r.text, role: r.message?.role || 'user', createdAt: r.createdAt })),
      summaries: [], memories: records.records.map(r => ({ id: r.id, text: r.text, version: r.version })),
      perception: null, inputTokenBudget: 8192,
    };
  },
};
const memoryPort = new SqliteManagementMemoryPort(store, lifecycle);
const settings = await ManagementSettingsStore.open(join(dir, 'management-settings.json'), base);
const presets = await CharacterPresetStore.open({ filePath: join(dir, 'character-presets.json'), memory: memoryPort, settings, base });
const roleConfigurations = await RoleConfigurationStore.open({ file: join(dir, 'role-configurations.json') });
// The author-metadata surface (`PUT /api/characters/profile`) refuses to write when the role has NO saved
// v2 configuration document: `saveAuthorMetadata` starts from `this.get(characterId)` and throws otherwise.
// Production never hits that because the composition root seeds the running role before the console can
// save (dist/app/trial-backend.js: loadEffectiveRoleConfiguration -> store.save). Seed the same v2 document
// here, otherwise「保存作者资料」fails with 400 and the panel is untestable.
if (!roleConfigurations.get(ROLE_ID)) {
  await roleConfigurations.save({
    schemaVersion: 2, characterId: ROLE_ID, revision: 0, savedRevision: 0, effectiveRevision: 0, applyOn: 'restart',
    identity: { intro: '浏览器验收用的匿名角色简介，不含任何真实个人资料。' },
    persona: { text: '', revision: 0 },
    appearance: { type: 'live2d', resourceId: '' },
    bindings: { dialogue: { inherit: true }, asr: { inherit: true }, tts: { inherit: true } },
  });
}
const traces = RuntimeTraceStore.open(dbPath);

let selfSetup;
try { selfSetup = createSelfSetup({ base, settings, instanceId: runtime.identity().instanceId, mode: 'runtime', credentials: credentialRegistry(base) }); }
catch (error) { console.error('selfSetup optional:', error?.message ?? error); }

const token = randomBytes(32).toString('hex');
const instance = await startManagementServer({
  mode: 'runtime',
  uiRoot: resolve(root, 'management'),
  settings,
  memory: memoryPort,
  presets,
  roleConfigurations,
  ...(selfSetup ? { selfSetup } : {}),
  traces,
  traceContent: trace => readTraceContentFromHistory(store, trace),
  // The Lorebook panel is only exercisable when the store is actually mounted. The production wiring
  // (dist/app/trial-backend.js) passes `LorebookStore.open(store)`; the shared anon infra script omits it,
  // which is why the 故事书 panel correctly reports 「本机未装配故事书功能」 there. Mount it here so the
  // 新建故事书 transaction is tested against the real route + owner checks.
  lorebooks: LorebookStore.open(store),
  token,
  ...(Number.isSafeInteger(port) && port > 0 ? { port } : {}),
  snapshot: () => ({
    apiVersion: 1, runtime: runtime.identity(), modules: runtime.modules(), events: runtime.recentEvents(),
    adapters: [], credentials: [], characters: memoryPort.characters(), settings: settings.snapshot(),
  }),
});

const sessionFile = join(dir, 'session.json');
const descriptor = {
  version: 1, origin: instance.origin, token, url: `${instance.origin}/#token=${token}`,
  pid: process.pid, dir, db: dbPath, seeded, roleId: ROLE_ID,
};
writeFileSync(sessionFile, JSON.stringify(descriptor, null, 2) + '\n', 'utf8');
try { restrictPrivatePathSync(sessionFile); } catch { /* not required for a scratch dir */ }

console.log(JSON.stringify(descriptor, null, 2));

let closing = false;
const shutdown = async () => {
  if (closing) return; closing = true;
  await instance.close();
  try { store.close(); } catch { /* already closed */ }
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
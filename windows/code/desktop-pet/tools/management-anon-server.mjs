// RWR-07 infra (A1): start the REAL management HTTP server against an ANONYMOUS temporary store.
//
// Boundary guarantees (this is the whole point of the script):
//   * NEVER touches windows/.local/data/companion.sqlite. The SQLite file it opens is created inside a
//     temp directory (default: <repo>/.local/anon-mgmt/, gitignored) and seeded with invented strings
//     only (the same ANON vocabulary as tests/role-repair/fixtures.ts).
//   * NEVER runs refresh:runtime, never rebuilds dist/, never kills a process.
//   * The bearer token is random per launch and printed to stdout; it is also written to
//     <tempdir>/management-session.json, which is gitignored.
//
// Optional: `--db <path>` COPY-PASTES an existing SQLite file into the temp dir and opens the COPY
// (the source path is only read, never opened for write). Use this only when a realistic shape is
// required and the copy itself is acceptable; the default seed path carries no user content at all.
//
// Usage:
//   node tools/management-anon-server.mjs [--port 10158] [--db <sqlite>] [--seed anon]
//
// It prints one JSON line: { origin, token, url, sessionFile, db }. Stop with Ctrl+C (SIGINT closes
// the server and drains the settings store).

import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
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
import { confirmedInvitationPolicy } from '../dist/companion/invitations.js';
import { RuntimeTraceStore } from '../dist/core/trace-store.js';
import { readTraceContentFromHistory } from '../dist/memory/trace-history-content.js';
import { CharacterPresetStore } from '../dist/management/character-preset-store.js';
import { RoleConfigurationStore } from '../dist/management/role-configuration.js';
import { createSelfSetup } from '../dist/management/self-setup.js';
import { credentialRegistry } from '../dist/management/credentials.js';

/** Anonymous stand-ins. Never real personal data (mirrors tests/role-repair/fixtures.ts ANON). */
const ANON = Object.freeze({
  role: 'anon-role-a',
  label: '匿名角色A',
  intro: '这是测试用的匿名角色简介，不含任何真实个人资料。',
  persona: '匿名角色A的设定正文。',
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const port = Number(option('port') ?? process.env.PET_MGMT_PORT ?? 10158);
const sourceDb = option('db');
// RWR-07: the shipped console (the React SPA under management/character-app) renders only when the
// snapshot shows EXACTLY one
// registered role, `companion`. Seeding extra anonymous roles is therefore opt-in (`--seed anon`) and
// off by default, so the default launch is the one that renders a usable UI.
const seedAnon = args.includes('--seed') && (option('seed') ?? 'anon') === 'anon';

const tempDir = resolve(root, '.local', 'anon-mgmt');
mkdirSync(join(tempDir, 'packs'), { recursive: true });
const dbPath = join(tempDir, 'anon-companion.sqlite');

// Fresh seed each launch: remove the previous copy so no state leaks between runs.
for (const suffix of ['', '-wal', '-shm']) { try { await rm(dbPath + suffix, { force: true }); } catch { /* ignore */ } }
if (sourceDb) {
  if (!existsSync(sourceDb)) { console.error(`source db not found: ${sourceDb}`); process.exit(2); }
  copyFileSync(sourceDb, dbPath);
}

const base = {
  version: 1, product: 'companion-v1', phaseId: 'local-anon-infra', purpose: 'user-trial',
  projectRoot: tempDir, sourceRevision: 'a'.repeat(40),
  runtimeFiles: {}, database: dbPath, budgetFile: join(tempDir, 'budget.json'), budgetBatchId: 'anon-infra-batch',
  limitMicros: 20000000, phaseLimitMicros: 20000000, maxCalls: 200,
  operationLimits: { admission: 40, dialogue: 40, memory_turn: 40, summary: 20, perception: 20, tts: 40 },
  memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
  models: {},
};

const runtime = new ManagementRuntime(base.sourceRevision);
const store = new SqliteMemoryStore({ filename: dbPath, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });

// Anonymous seed: one registered role + its persona body, so the role surface is exercisable without
// any real content. A `--db` copy already has its own registry, so seeding is skipped there.
let seeded = false;
try {
  if (seedAnon && !sourceDb && !store.registry.list().some(entry => entry.id === ANON.role)) {
    const created = store.registry.create({ label: ANON.label, intro: ANON.intro, operationId: 'anon-infra-create-1' });
    seeded = Boolean(created?.character?.id);
  }
  if (seedAnon && !sourceDb && seeded) {
    const scope = { characterId: ANON.role, sessionId: 'anon-infra', turnId: 'anon-infra', generation: 0 };
    try { store.setPrompt(scope, ANON.persona); } catch { /* persona body is optional for infra */ }
  }
} catch (error) { console.error('anon seed skipped:', error?.message ?? error); }

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
const settings = await ManagementSettingsStore.open(join(tempDir, 'management-settings.json'), base);
const presets = await CharacterPresetStore.open({ filePath: join(tempDir, 'character-presets.json'), memory: memoryPort, settings, base });
const roleConfigurations = await RoleConfigurationStore.open({ file: join(tempDir, 'role-configurations.json') });
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
  token,
  ...(Number.isSafeInteger(port) && port > 0 ? { port } : {}),
  snapshot: () => ({
    apiVersion: 1, runtime: runtime.identity(), modules: runtime.modules(), events: runtime.recentEvents(),
    adapters: [], credentials: [], characters: memoryPort.characters(), settings: settings.snapshot(),
  }),
});

const sessionFile = join(tempDir, 'management-session.json');
const descriptor = {
  version: 1, url: `${instance.origin}/#token=${token}`, pid: process.pid,
  instanceId: runtime.identity().instanceId, mode: 'runtime', sourceRevision: runtime.identity().sourceRevision,
};
const { writeFileSync } = await import('node:fs');
writeFileSync(sessionFile, JSON.stringify(descriptor, null, 2) + '\n', 'utf8');
restrictPrivatePathSync(sessionFile);

console.log(JSON.stringify({ origin: instance.origin, token, url: `${instance.origin}/#token=${token}`, sessionFile, db: dbPath, copiedFrom: sourceDb ?? null, seeded, pid: process.pid }, null, 2));

let closing = false;
const shutdown = async () => {
  if (closing) return; closing = true;
  await instance.close();
  try { store.close(); } catch { /* already closed */ }
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

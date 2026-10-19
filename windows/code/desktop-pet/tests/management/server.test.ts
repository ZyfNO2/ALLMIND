import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { fixture } from './helpers.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';

test('local HTTP authorization, host, origin and routing reject foreign access before business calls', async t => {
  // LUI-07: `uiRoot` is the directory CONTAINING `character-app/`; the shell is served only when
  // `uiRoot/character-app/index.html` exists. Writing the shell at `uiRoot/index.html` no longer
  // serves anything (unknown static paths are 404), so the fixture mirrors the shipped layout.
  const f = await fixture(t), uiRoot = join(f.c.projectRoot, 'ui'); await mkdir(join(uiRoot, 'character-app'), { recursive: true }); await writeFile(join(uiRoot, 'character-app', 'index.html'), '<h1>controlled HTTP fixture</h1>');
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c), runtime = new ManagementRuntime(f.c.sourceRevision);
  let businessCalls = 0;
  // RWR-02: every `characterId` reaches storage only through the persisted registry, so this synthetic
  // port registers `companion` only. `other` is unregistered and must be refused before business code.
  const descriptor = { schemaVersion: 2 as const, id: 'companion', label: 'companion', intro: '', revision: 1, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' };
  const memory: ManagementMemoryPort = {
    registry: {
      list: () => [descriptor], listAll: () => [descriptor], get: (id: unknown) => (id === 'companion' ? descriptor : null),
      create: () => { throw new Error('not used'); },
      selection: () => ({ savedCharacterId: 'companion', effectiveCharacterId: 'companion', selectionRevision: 0, effectiveSelectionRevision: 0, applyOn: 'restart' as const }),
      setSelection: () => { throw new Error('not used'); },
    },
    characters: () => [], list(query) { businessCalls++; return { ...query, revision: 0, records: [], total: 0 }; },
    edit() { throw new Error('PRIVATE provider key or user data'); }, context() { throw new Error(); },
    prompt() { throw new Error(); }, savePrompt() { throw new Error(); },
  };
  const server = await startManagementServer({ uiRoot, settings, memory, snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(),
    modules: runtime.modules(), events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };
  assert.equal((await fetch(server.origin + '/')).status, 200);
  assert.equal((await fetch(server.origin + '/api/snapshot')).status, 401);
  assert.equal((await fetch(server.origin + '/api/snapshot', { headers: { ...headers, Origin: 'https://foreign.invalid' } })).status, 403);
  const badHost = await new Promise<number>(resolve => { const req = request(server.origin + '/api/snapshot', { headers: { ...headers, Host: 'foreign.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.end(); });
  assert.equal(badHost, 403);
  assert.equal((await fetch(server.origin + '/api/records?characterId=companion&kind=memory', { headers })).status, 200);
  assert.equal(businessCalls, 1);
  // RWR-02: an unregistered character is `not_found` (404) and is refused BEFORE the business call.
  assert.equal((await fetch(server.origin + '/api/records?characterId=other&kind=memory', { headers })).status, 404);
  assert.equal(businessCalls, 1);
  assert.equal((await fetch(server.origin + '/config.json', { headers })).status, 404);
  const snapshot = await fetch(server.origin + '/api/snapshot', { headers });
  assert.equal(snapshot.headers.get('cache-control'), 'no-store'); assert.match(snapshot.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const state = await snapshot.json() as { modules: { id: string; status: string; detail: string }[] };
  assert.equal(state.modules.find(x => x.id === 'dialogue')?.status, 'unknown');
  const invitations = state.modules.find(x => x.id === 'invitations');
  assert.equal(invitations?.status, 'unavailable');
  assert.match(invitations?.detail ?? '', /当前组合根尚未装配持久候选生产、桌面忙闲\/DND 仲裁与邀请展示/);
  const missingOrigin = { Authorization: headers.Authorization, 'Content-Type': 'application/json' };
  assert.equal((await fetch(server.origin + '/api/settings', { method: 'PUT', headers: missingOrigin, body: JSON.stringify({ expectedRevision: 0, settings: settings.snapshot().saved }) })).status, 403);
  const changed = settings.snapshot().saved; changed.context.maxMemories = 5;
  const save = () => fetch(server.origin + '/api/settings', { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, settings: changed }) });
  assert.equal((await save()).status, 200); assert.equal((await save()).status, 409);
  const failed = await fetch(server.origin + '/api/records/edit', { method: 'POST', headers,
    body: JSON.stringify({ characterId: 'companion', id: 'a', expectedVersion: 1, operationId: 'edit1', text: 'new', reason: 'correction' }) });
  assert.equal(failed.status, 500); assert.equal((await failed.text()).includes('PRIVATE'), false);
});

test('runtime observations report actual attempts, cancellation, latency and no private error payload', async () => {
  const runtime = new ManagementRuntime('a'.repeat(40)), controller = new AbortController();
  let release!: () => void; const pending = new Promise<void>(r => { release = r; });
  const run = runtime.observeCall('tts', 'sweetheart', sent => { sent(); return pending; }, controller.signal);
  assert.equal(runtime.modules().find(m => m.id === 'tts')?.activeJobs, 1);
  release(); await run;
  assert.equal(runtime.modules().find(m => m.id === 'tts')?.activeJobs, 0);
  await assert.rejects(runtime.observeCall('tts', 'sweetheart', async sent => { sent(); throw new Error('PRIVATE key'); }, controller.signal));
  assert.equal(runtime.modules().find(m => m.id === 'tts')?.status, 'error');
  assert.equal(JSON.stringify(runtime.recentEvents()).includes('PRIVATE'), false);
});

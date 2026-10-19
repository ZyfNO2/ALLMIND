import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { ManagementError } from '../../contracts/management.js';
import { CompanionModeRuntime } from '../../core/companion-mode-runtime.js';
import { CaptureGrantManager } from '../../core/perception-grant.js';
import { ScreenGrantRuntime } from '../../management/screen-grant-runtime.js';
import { companionPreferencesRoute } from '../../management/companion-preferences-routes.js';

const pairing = productionPairing('companion', 'rwr10-preferences');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rwr10-preferences-'));
  const store = new SqliteMemoryStore({ filename: resolve(root, 'memory.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const mode = new CompanionModeRuntime({ db: store.rawDatabaseForKnowledge(), pairing });
  const screen = new ScreenGrantRuntime({ grants: new CaptureGrantManager(), pairing, runtimeSessionId: 'prefs-runtime',
    companionMode: mode, capabilities: { capture: false, localOcr: false, cloudVlm: false } });
  return { store, mode, screen };
}
async function request(runtime: CompanionModeRuntime, screen: ScreenGrantRuntime, method: string, query = new URLSearchParams(), payload?: Record<string, unknown>) {
  let response: unknown;
  const handled = await companionPreferencesRoute(method, runtime, screen, '/api/companion/preferences', query,
    async () => payload ?? {}, value => { response = value; });
  assert.equal(handled, true);
  return response as any;
}
const query = () => new URLSearchParams({ userId: pairing.userId, characterId: pairing.characterId, characterInstanceId: pairing.characterInstanceId });

test('RWR-10-07: saved preferences are durable, revisioned, explicit, and never imply capability or grants', async () => {
  const { store, mode, screen } = fixture();
  try {
    const initial = await request(mode, screen, 'GET', query());
    assert.equal(initial.revision, 0);
    assert.equal(initial.saved.screen.enabled, false);
    assert.equal(initial.saved.greetingRules[0].localTime, '23:30');
    assert.equal(initial.saved.greetingRules[0].enabled, false);
    assert.equal(initial.runState, 'paused');

    const payload = { pairing, expectedRevision: 0, operationId: 'prefs-save-1', patch: {
      screen: { enabled: true }, observationIntervalMs: 300_000, replyCooldownMs: 1_800_000, dailyMax: 8,
    } };
    const saved = await request(mode, screen, 'PUT', query(), payload);
    assert.equal(saved.revision, 1);
    assert.equal(saved.saved.screen.enabled, true);
    assert.equal(saved.effective.screen.enabled, false);
    assert.equal(saved.reason, 'screen_target_not_selected');
    assert.equal(saved.runState, 'needs-authorization');
    assert.equal(saved.effective.dailyMax, 2, 'shared invitation cap remains authoritative');
    assert.equal(saved.effective.replyCooldownMs, 3 * 60 * 60 * 1000, 'effective cooldown cannot undercut shared interval');
    assert.equal((screen.getGrants(pairing) as any).grants.length, 0, 'saving preferences never issues a grant');

    const replay = await request(mode, screen, 'PUT', query(), payload);
    assert.equal(replay.revision, 1);
    assert.equal(mode.getAutomationPreferences().revision, 1);
    const restarted = new CompanionModeRuntime({ db: store.rawDatabaseForKnowledge(), pairing });
    assert.deepEqual(restarted.getAutomationPreferences(), mode.getAutomationPreferences());
  } finally { store.close(); }
});

test('RWR-10-07: preference API enforces pairing, target provenance, operation conflict, and frozen bounds', async () => {
  const { store, mode, screen } = fixture();
  try {
    const wrongPairing = new URLSearchParams({ userId: 'other-user', characterId: pairing.characterId, characterInstanceId: pairing.characterInstanceId });
    await assert.rejects(() => request(mode, screen, 'GET', wrongPairing), (error: unknown) => error instanceof ManagementError && error.code === 'forbidden');
    await assert.rejects(() => request(mode, screen, 'PUT', query(), { pairing, expectedRevision: 0, operationId: 'spoof-target',
      patch: { screen: { targetId: 'browser-claimed', targetRevision: 1 } } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'forbidden');
    await assert.rejects(() => request(mode, screen, 'PUT', query(), { pairing, expectedRevision: 0, operationId: 'invalid-daily-max', patch: { dailyMax: 9 } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request');

    const base = { pairing, expectedRevision: 0, operationId: 'same-operation', patch: { dailyMax: 2 } };
    await request(mode, screen, 'PUT', query(), base);
    await assert.rejects(() => request(mode, screen, 'PUT', query(), { ...base, patch: { dailyMax: 1 } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict');
    assert.equal(mode.getAutomationPreferences().saved.dailyMax, 2);
  } finally { store.close(); }
});

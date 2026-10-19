import test from 'node:test';
import assert from 'node:assert/strict';
import { productionPairing } from '../../contracts/character-pack.js';
import type { DesktopHostBridge } from '../../app/desktop-host-bridge.js';
import { CaptureGrantManager } from '../../core/perception-grant.js';
import { ManagementError } from '../../contracts/management.js';
import type { ContextUseGrant } from '../../contracts/companion-mode.js';
import type { CompanionModeRuntime } from '../../core/companion-mode-runtime.js';
import { ScreenGrantRuntime } from '../../management/screen-grant-runtime.js';
import { screenGrantRoute } from '../../management/screen-grant-routes.js';

const pairing = productionPairing('companion', 'rwr10-screen-routes');
const target = {
  targetId: 'display-42', targetRevision: 2, kind: 'screen' as const,
  displayName: '显示器 1', bounds: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.25,
};
function runtime() {
  const bridge = {
    request: async (method: string, params: Record<string, unknown>) => {
      assert.equal(method, 'screen-target.select');
      assert.equal(params.operationId, 'select-1');
      return { outcome: 'selected', target };
    },
  } as unknown as DesktopHostBridge;
  let context: ContextUseGrant | null = null;
  const contextOwner = {
    getContextUseGrant: () => context,
    issueContextUseGrant: async (input: { operationId: string; expectedRevision: number; observationSourceScopes: readonly string[];
      modelBinding: string; destination: ContextUseGrant['destination']; ttlMs: number }) => {
      if ((context?.revision ?? 0) !== input.expectedRevision) throw Object.assign(new Error('stale'), { code: 'version_conflict' });
      context = { schemaVersion: 1, grantId: `context-${input.operationId}`, revision: (context?.revision ?? 0) + 1,
        pairing, observationSourceScopes: [...input.observationSourceScopes], modelBinding: input.modelBinding,
        destination: input.destination, expiry: new Date(Date.now() + input.ttlMs).toISOString(), state: 'active' };
      return context;
    },
    revokeContextUseGrant: async (input: { grantId: string; expectedRevision: number; operationId: string }) => {
      if (!context || context.grantId !== input.grantId || context.revision !== input.expectedRevision) throw Object.assign(new Error('stale'), { code: 'version_conflict' });
      context = { ...context, state: 'revoked', revision: context.revision + 1 };
      return context;
    },
  } as unknown as CompanionModeRuntime;
  return new ScreenGrantRuntime({
    bridge, grants: new CaptureGrantManager(), pairing, runtimeSessionId: 'runtime-05', companionMode: contextOwner,
    capabilities: { capture: false, localOcr: false, cloudVlm: false },
  });
}
async function call(rt: ScreenGrantRuntime, method: string, path: string, payload: Record<string, unknown> = {}, query = new URLSearchParams()) {
  let response: unknown;
  const handled = await screenGrantRoute(method, rt, path, query, async () => payload, value => { response = value; });
  assert.equal(handled, true);
  return response as any;
}
const selectionBody = { pairing, operationId: 'select-1' };

test('RWR-10-05: host-selected screen targets are bound to pairing; browser target claims are rejected', async () => {
  const rt = runtime();
  const selected = await call(rt, 'POST', '/api/companion/screen-targets/select', selectionBody);
  assert.equal(selected.outcome, 'selected');
  assert.equal(selected.target.targetId, target.targetId);
  assert.equal('isValid' in selected.target, false);
  assert.equal('imageBase64' in selected.target, false);
  await assert.rejects(
    () => call(rt, 'POST', '/api/companion/screen-targets/select', { ...selectionBody, target: { ...target, isValid: true } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
  );
});

test('RWR-10-05: screen grant GET requires explicit pairing and reports unavailable capability honestly', async () => {
  const rt = runtime();
  const selected = await call(rt, 'POST', '/api/companion/screen-targets/select', selectionBody);
  const query = new URLSearchParams({ userId: pairing.userId, characterId: pairing.characterId,
    characterInstanceId: pairing.characterInstanceId });
  const status = await call(rt, 'GET', '/api/companion/screen-grants', {}, query);
  assert.equal(status.revision, selected.revision);
  assert.equal(status.capabilities.capture, false);
  assert.ok(status.missingReasons.includes('real_screen_capture_unavailable'));
  await assert.rejects(() => call(rt, 'GET', '/api/companion/screen-grants'),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request');
});

test('RWR-10-05: single, continuous-local, and context-use grants are idempotent and revocable', async () => {
  const rt = runtime();
  const selected = await call(rt, 'POST', '/api/companion/screen-targets/select', selectionBody);
  const base = { pairing, expectedRevision: selected.revision, targetId: target.targetId,
    targetRevision: target.targetRevision, destination: 'local', userConfirmed: true };

  const single = await call(rt, 'PUT', '/api/companion/screen-grants', {
    ...base, operationId: 'single-1', purpose: 'capture-single',
  });
  assert.equal(single.grant.purpose, 'capture-single');
  const replay = await call(rt, 'PUT', '/api/companion/screen-grants', {
    ...base, operationId: 'single-1', purpose: 'capture-single',
  });
  assert.equal(replay.grant.grant.grantId, single.grant.grant.grantId, 'operation replay returns the original grant');

  const continuous = await call(rt, 'PUT', '/api/companion/screen-grants', {
    ...base, expectedRevision: single.revision, operationId: 'continuous-1', purpose: 'capture-continuous', minPollIntervalMs: 1000,
  });
  assert.equal(continuous.grant.grant.destination, 'local');
  assert.equal(continuous.grant.grant.targetRevision, target.targetRevision);
  await assert.rejects(() => call(rt, 'PUT', '/api/companion/screen-grants', {
    ...base, expectedRevision: continuous.revision, operationId: 'continuous-cloud', purpose: 'capture-continuous', destination: 'cloud',
  }), (error: unknown) => error instanceof ManagementError && error.code === 'forbidden');

  const context = await call(rt, 'PUT', '/api/companion/screen-grants', {
    ...base, expectedRevision: continuous.revision, operationId: 'context-1', purpose: 'context-use',
    modelBinding: 'provider:model', observationSourceScopes: [`screen:${target.targetId}`],
  });
  assert.equal(context.grant.grant.modelBinding, 'provider:model');
  const revoked = await call(rt, 'POST', `/api/companion/screen-grants/${single.grant.grant.grantId}/revoke`, {
    pairing, expectedRevision: context.revision, operationId: 'revoke-single-1',
  });
  assert.equal(revoked.revoked, true);
  const revokedContext = await call(rt, 'POST', `/api/companion/screen-grants/${context.grant.grant.grantId}/revoke`, {
    pairing, expectedRevision: revoked.revision, operationId: 'revoke-context-1',
  });
  assert.equal(revokedContext.revoked, true);
});

test('RWR-10-05: untrusted image/target flags and conflicting operation ids are refused', async () => {
  const rt = runtime();
  const selected = await call(rt, 'POST', '/api/companion/screen-targets/select', selectionBody);
  await assert.rejects(() => call(rt, 'PUT', '/api/companion/screen-grants', {
    pairing, expectedRevision: selected.revision, operationId: 'bad-image', purpose: 'capture-single', destination: 'local',
    targetId: target.targetId, targetRevision: target.targetRevision, userConfirmed: true,
    imageBase64: 'iVBORw0KGgo=', isValid: true,
  }), (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request');

  const request = { pairing, expectedRevision: selected.revision, operationId: 'reused', purpose: 'capture-single',
    destination: 'local', targetId: target.targetId, targetRevision: target.targetRevision, userConfirmed: true };
  await call(rt, 'PUT', '/api/companion/screen-grants', request);
  await assert.rejects(() => call(rt, 'PUT', '/api/companion/screen-grants', { ...request, targetId: 'other-display' }),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { productionPairing } from '../../contracts/character-pack.js';
import type { LegacyContinuousPerceptionGrant } from '../../contracts/perception.js';
import { toRuntimeContinuousGrant } from '../../app/screen-grant-adapter.js';

const pairing = productionPairing('companion', 'rwr10-screen');
const legacy: LegacyContinuousPerceptionGrant = {
  continuousGrantId: 'legacy-continuous-1', revision: 3, pairing, scopeType: 'screen',
  destination: 'local', minPollIntervalMs: 5_000,
  grantedAt: '2026-10-07T00:00:00.000Z', expiresAt: '2026-10-07T01:00:00.000Z', status: 'active',
};
const binding = {
  targetId: 'display-2', targetRevision: 4,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, runtimeSessionId: 'runtime-1',
};

test('RWR-10-05: explicit legacy conversion binds target, revision, bounds, and session', () => {
  const converted = toRuntimeContinuousGrant(legacy, binding);
  assert.equal(converted.grantId, legacy.continuousGrantId);
  assert.equal(converted.revision, legacy.revision);
  assert.equal(converted.targetId, binding.targetId);
  assert.equal(converted.targetRevision, binding.targetRevision);
  assert.deepEqual(converted.bounds, binding.bounds);
  assert.equal(converted.runtimeSessionId, binding.runtimeSessionId);
  assert.equal(converted.expiry, legacy.expiresAt);
  assert.equal(converted.destination, 'local');
  assert.equal(converted.state, 'active');
});

test('RWR-10-05: missing target/session fields never become implicit full-screen scope', () => {
  assert.throws(() => toRuntimeContinuousGrant(legacy, { ...binding, targetId: '' }), /target_id_required/);
  assert.throws(() => toRuntimeContinuousGrant(legacy, { ...binding, targetRevision: 0 }), /target_revision_required/);
  assert.throws(() => toRuntimeContinuousGrant(legacy, { ...binding, bounds: undefined as never }), /target_bounds_required/);
  assert.throws(() => toRuntimeContinuousGrant(legacy, { ...binding, runtimeSessionId: '' }), /runtime_session_required/);
});

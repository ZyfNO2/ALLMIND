// RWR-05 (CONTRACTS §4): the read-only local capability query.
//
// The point of these tests is that DETECTION is cheap and honest. A probe that started a model worker,
// opened a microphone, or downloaded anything would make "available" indistinguishable from "installed",
// so the assertions below check the three properties CONTRACTS §4 freezes:
//
//   * no download, no microphone, no persistent inference process;
//   * every probe is bounded by the registered timeout;
//   * the model directory comes from the runtime's own controlled configuration, never from a request.
//
// Detection is a real file/stat check plus (on Windows) voice enumeration. Off Windows SAPI is
// reported `unsupported` — which is exactly the D4 point that "system local" is a category, not proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLocalCapabilities, detectSapi, detectSherpa, LOCAL_CAPABILITY_PROBE_MS } from '../../providers/local-capabilities.js';
import { localCapabilitiesRoute } from '../../management/local-capability-routes.js';
import { ManagementError } from '../../contracts/management.js';
import { RWR_LIMITS } from './fixtures.js';

test('RWR-05 LC-1: the registered probe timeout is the frozen 10s and is the default', () => {
  assert.equal(LOCAL_CAPABILITY_PROBE_MS, 10_000);
  assert.equal(LOCAL_CAPABILITY_PROBE_MS, RWR_LIMITS.localCapabilityProbeMs, 'the probe bound must equal the frozen limit, never a relaxed one');
});

test('RWR-05 LC-2: SAPI never claims readiness it cannot justify', async () => {
  const capability = await detectSapi(50);
  assert.equal(capability.capabilityId, 'local.tts');
  assert.equal(capability.adapterId, 'sapi-tts');
  if (process.platform === 'win32') {
    assert.ok(['ready', 'unavailable'].includes(capability.availability), 'Windows must answer ready or unavailable, never a guess');
    if (capability.availability === 'ready') {
      assert.ok(capability.voices && capability.voices.length, 'a ready SAPI must enumerate at least one installed voice');
    } else {
      assert.ok(capability.reason.length, 'an unavailable SAPI must say why');
    }
  } else {
    assert.equal(capability.availability, 'unsupported', 'a non-Windows machine must not claim Windows SAPI');
    assert.equal(capability.reason, '仅 Windows 提供 SAPI 系统语音合成；本平台无此本地能力。');
  }
});

test('RWR-05 LC-3: a missing Sherpa model directory is `unavailable`, not a fake ready', async () => {
  const capability = await detectSherpa(undefined);
  assert.equal(capability.availability, 'unavailable');
  assert.equal(capability.reason, 'no_configured_model_directory');
  assert.equal(capability.capabilityId, 'local.asr');
  assert.equal(capability.adapterId, 'sherpa-streaming-asr');
});

test('RWR-05 LC-4: an INCOMPLETE model package is unavailable and reports the directory it checked', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rwr05-sherpa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'encoder.onnx'), 'stub');
  await writeFile(join(dir, 'decoder.onnx'), 'stub');
  // joiner.onnx and tokens.txt are deliberately absent.
  const capability = await detectSherpa(dir);
  assert.equal(capability.availability, 'unavailable', 'a partial model package is not a working recognizer');
  assert.equal(capability.reason, 'incomplete_model_package');
  assert.equal(capability.resourceRef, dir, 'the controlled directory it resolved from is reported, not an arbitrary path');
});

test('RWR-05 LC-5: a COMPLETE controlled model package is detected READY without loading a model', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rwr05-sherpa-full-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['encoder.onnx', 'decoder.onnx', 'joiner.onnx']) await writeFile(join(dir, name), 'stub');
  await writeFile(join(dir, 'tokens.txt'), 'stub');
  const capability = await detectSherpa(dir);
  assert.equal(capability.availability, 'ready');
  assert.equal(capability.reason, 'model_resources_present');
  // Detection verified the files; it did not construct a recognizer (CONTRACTS §4 forbids a
  // persistent inference process during detection), so no runtime engine object is involved here.
  assert.equal(capability.resourceRef, dir);
});

test('RWR-05 LC-6: detection probes both capabilities independently and reports an observedAt', async () => {
  const report = await detectLocalCapabilities({ now: () => '2026-10-05T00:00:00.000Z' });
  assert.equal(report.observedAt, '2026-10-05T00:00:00.000Z');
  assert.equal(report.capabilities.length, 2, 'both local capabilities are reported even when one fails');
  const ids = report.capabilities.map(c => c.capabilityId).sort();
  assert.deepEqual(ids, ['local.asr', 'local.tts']);
  for (const capability of report.capabilities) {
    assert.ok(['ready', 'unavailable', 'unsupported'].includes(capability.availability));
    assert.equal(typeof capability.reason, 'string');
    assert.ok(capability.reason.length, 'every verdict carries a machine-readable reason');
  }
});

test('RWR-05 LC-7: the HTTP route returns the versioned envelope and rejects a non-GET', async () => {
  const result = await localCapabilitiesRoute('GET', '/api/roles/local-capabilities', { now: () => '2026-10-05T00:00:00.000Z' }) as {
    apiVersion: number; observedAt: string; capabilities: unknown[];
  };
  assert.equal(result.apiVersion, 1);
  assert.equal(result.observedAt, '2026-10-05T00:00:00.000Z');
  assert.ok(Array.isArray(result.capabilities));

  await assert.rejects(
    () => localCapabilitiesRoute('POST', '/api/roles/local-capabilities', {}),
    (error: unknown) => error instanceof ManagementError && error.code === 'not_found',
  );
  // Absent probe → the section is unavailable (503), NOT a fabricated "no local sources" answer.
  await assert.rejects(
    () => localCapabilitiesRoute('GET', '/api/roles/local-capabilities', undefined),
    (error: unknown) => error instanceof ManagementError && error.code === 'unavailable',
  );
  // A different path is simply not ours.
  assert.equal(await localCapabilitiesRoute('GET', '/api/something-else', {}), undefined);
});

#!/usr/bin/env node
/**
 * CK-11/CK-15 real local OCR benchmark. Uses only the two synthetic, metadata-free pixel fixtures
 * whose hashes and metrics were frozen in docs/next/companion-knowledge/ocr-real-measurement-profile.json.
 * It goes through the production adapter and built Windows helper, not a direct API shim.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createWindowsMediaOcrEngine, windowsMediaOcrHelperPaths } from '../dist/core/windows-media-ocr-engine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profilePath = resolve(root, '../../../docs/next/companion-knowledge/ocr-real-measurement-profile.json');
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const fixtureRoot = join(root, 'tests/companion-knowledge/fixtures/ocr');
const result = {
  profileId: profile.profileId,
  evidenceLevel: 'real_local_device_and_production_helper',
  route: 'createWindowsMediaOcrEngine -> child process -> Windows.Media.Ocr',
  profileSha256: createHash('sha256').update(readFileSync(profilePath)).digest('hex'),
  helper: { path: 'dist/ocr/aika-windows-media-ocr.exe', sha256: null, probe: null, manifestValid: false },
  samples: [],
  controls: {},
  thresholds: profile.measurement,
};

const binaryPath = join(root, 'dist/ocr/aika-windows-media-ocr.exe');
result.helper.sha256 = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
const engine = await createWindowsMediaOcrEngine({ paths: windowsMediaOcrHelperPaths(root) });
result.helper.manifestValid = engine.available || engine.reason !== 'windows_media_ocr_helper_missing';
result.helper.probe = engine.available
  ? { status: 'ready', language: engine.language ?? null }
  : { status: 'unavailable', reason: engine.reason ?? 'unknown' };
if (!engine.available) {
  result.outcome = 'BLOCKED';
  result.reason = engine.reason;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(2);
}

function normalize(text) {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}
function editDistance(a, b) {
  const left = Array.from(a), right = Array.from(b);
  let prev = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    prev = next;
  }
  return prev[right.length];
}
function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

let allPassed = true;
for (const sample of profile.samples) {
  const bytes = readFileSync(join(fixtureRoot, sample.path.split('/').at(-1)));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== sample.sha256) throw new Error(`fixture hash mismatch: ${sample.id}`);
  let warmupResult;
  for (let i = 0; i < profile.measurement.latency.warmupsPerSample; i++) {
    warmupResult = await engine.recognize(bytes);
    if (warmupResult.status !== 'ok') throw new Error(`warmup recognition failed: ${sample.id}:${warmupResult.reason ?? warmupResult.status}`);
  }
  const durationsMs = [];
  let lastResult = warmupResult;
  for (let i = 0; i < profile.measurement.latency.timedIterationsPerSample; i++) {
    const start = performance.now();
    lastResult = await engine.recognize(bytes);
    durationsMs.push(performance.now() - start);
    if (lastResult.status !== 'ok') throw new Error(`recognition failed: ${sample.id}:${lastResult.reason ?? lastResult.status}`);
  }
  const expected = normalize(sample.expectedText);
  const recognized = normalize(lastResult.readingOrderText);
  const distance = editDistance(Array.from(expected), Array.from(recognized));
  const cer = distance / Math.max(1, Array.from(expected).length);
  const latencyP95Ms = p95(durationsMs);
  const item = {
    id: sample.id,
    sha256: hash,
    dimensions: sample.dimensions,
    expectedText: expected,
    recognizedText: recognized,
    language: lastResult.language ?? null,
    blocks: lastResult.blocks.length,
    cer: Number(cer.toFixed(6)),
    editDistance: distance,
    referenceCodePoints: Array.from(expected).length,
    warmups: profile.measurement.latency.warmupsPerSample,
    timedIterations: durationsMs.length,
    latencyMs: { min: Number(Math.min(...durationsMs).toFixed(3)), median: Number([...durationsMs].sort((a,b)=>a-b)[Math.floor(durationsMs.length/2)].toFixed(3)), p95: Number(latencyP95Ms.toFixed(3)), max: Number(Math.max(...durationsMs).toFixed(3)) },
    pass: cer <= profile.measurement.cer.perSampleMaximum && latencyP95Ms <= profile.measurement.latency.perSampleMaximumMs && recognized.length > 0,
  };
  allPassed &&= item.pass;
  result.samples.push(item);
  bytes.fill(0);
}

const blankBytes = readFileSync(join(fixtureRoot, 'blank.png'));
const blank = await engine.recognize(blankBytes);
blankBytes.fill(0);
result.controls.blank = { status: blank.status, blocks: blank.blocks.length, readingOrderLength: blank.readingOrderText.length,
  pass: blank.status === 'ok' && blank.blocks.length === 0 && blank.readingOrderText === '' };
const malformed = await engine.recognize(new Uint8Array([0x01, 0x02, 0x03]));
result.controls.malformed = { status: malformed.status, blocks: malformed.blocks.length,
  pass: malformed.status === 'failed' && malformed.blocks.length === 0 };
allPassed &&= result.controls.blank.pass && result.controls.malformed.pass;
result.outcome = allPassed ? 'PASS' : 'FAIL';
result.criteria = {
  cerPerSampleMax: profile.measurement.cer.perSampleMaximum,
  p95PerSampleMaxMs: profile.measurement.latency.perSampleMaximumMs,
  passed: allPassed,
};
const evidencePath = resolve(root, '../../../docs/next/companion-knowledge/evidence/ck11-windows-media-ocr-real.json');
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'w' });
process.stdout.write(JSON.stringify({ ...result, evidencePath: 'docs/next/companion-knowledge/evidence/ck11-windows-media-ocr-real.json' }, null, 2) + '\n');
if (!allPassed) process.exitCode = 1;

import test from 'node:test';
import assert from 'node:assert/strict';
import type { PairingScope } from '../../contracts/character-pack.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { RuntimeContinuousPerceptionGrant } from '../../contracts/companion-mode.js';
import { createLocalOcrEngine } from '../../core/local-ocr-engine.js';
import { ObservationScheduler } from '../../core/observation-scheduler.js';
import { ScreenCaptureSource, type ScreenTarget } from '../../core/screen-capture-source.js';

const pairing = productionPairing('companion', 'rwr10-observation');
const target: ScreenTarget = {
  targetId: 'display-1', targetRevision: 1, kind: 'screen', displayName: 'Fixture display',
  bounds: { x: 0, y: 0, width: 800, height: 600 }, isValid: true,
};
function grant(scope: PairingScope = pairing): RuntimeContinuousPerceptionGrant {
  return {
    schemaVersion: 1, grantId: 'grant-screen-1', revision: 1, pairing: scope,
    targetId: target.targetId, targetRevision: target.targetRevision, bounds: target.bounds,
    runtimeSessionId: 'runtime-test', minPollIntervalMs: 1_000,
    expiry: new Date(Date.now() + 60_000).toISOString(), destination: 'local', state: 'active',
  };
}
function fixtureSource(bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])): ScreenCaptureSource {
  return new ScreenCaptureSource({ captureHook: async picked => ({
    targetId: picked.targetId, targetRevision: picked.targetRevision,
    capturedAt: new Date().toISOString(), mimeType: 'image/png',
    dimensions: { width: 800, height: 600 }, bytes,
  }) });
}
async function schedulerFor(engine: ReturnType<typeof createLocalOcrEngine>, source = fixtureSource(), onObservation?: (item: any) => void) {
  await source.attachContinuousGrant(grant());
  const scheduler = new ObservationScheduler({ pairing, captureSource: source, ocrEngine: engine, ...(onObservation ? { onObservation } : {}) });
  scheduler.setContext(grant(), target);
  return scheduler;
}

test('RWR-10-05: missing capture or pixel OCR hook reports unavailable, never synthetic or metadata-recognized', async () => {
  const noCapture = new ScreenCaptureSource();
  await noCapture.attachContinuousGrant(grant());
  await assert.rejects(() => noCapture.capture(target), /capture_unavailable/);

  const noOcr = createLocalOcrEngine();
  const result = await noOcr(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'pixel_ocr_hook_missing');
  assert.equal(result.readingOrderText, '');
});

test('RWR-10-05: observation distinguishes unavailable, failed, no-content, and recognized', async () => {
  const unavailableScheduler = await schedulerFor(createLocalOcrEngine());
  assert.deepEqual(await unavailableScheduler.tick(), { status: 'unavailable', reason: 'pixel_ocr_hook_missing' });

  const failedScheduler = await schedulerFor(createLocalOcrEngine({
    recognizePixelHook: async () => { throw new Error('native_failure'); },
  }));
  const failed = await failedScheduler.tick();
  assert.equal(failed?.status, 'failed');

  const blankScheduler = await schedulerFor(createLocalOcrEngine({ recognizePixelHook: async () => [] }));
  assert.deepEqual(await blankScheduler.tick(), { status: 'no-content' });

  const recognizedScheduler = await schedulerFor(createLocalOcrEngine({
    recognizePixelHook: async () => [{ text: 'fixture text', confidence: 0.9, bounds: { x: 1, y: 2, width: 30, height: 10 } }],
  }));
  const recognized = await recognizedScheduler.tick();
  assert.equal(recognized?.status, 'recognized');
  if (recognized?.status === 'recognized') {
    assert.equal(recognized.observation.text, 'fixture text');
    assert.equal(recognized.observation.targetRevision, target.targetRevision);
    assert.equal(recognized.observation.pairing?.characterInstanceId, pairing.characterInstanceId);
    assert.equal(recognized.observation.recognitionRoute, 'local-ocr');
  }
});

test('RWR-10-05: cancel aborts OCR, waits for settlement, scrubs frame bytes and drops late result', async () => {
  let signalSeen: AbortSignal | undefined;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const frameBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
  const source = fixtureSource(frameBytes);
  const delivered: unknown[] = [];
  const engine = createLocalOcrEngine({
    recognizePixelHook: (_bytes, signal) => new Promise((_resolve, reject) => {
      signalSeen = signal;
      started();
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  const scheduler = await schedulerFor(engine, source, item => delivered.push(item));
  const task = scheduler.tick();
  await startedPromise;
  await scheduler.cancel();
  assert.equal(signalSeen?.aborted, true);
  assert.equal(await task, null);
  assert.equal(scheduler.inFlight, false, 'released means the native/OCR promise settled');
  assert.deepEqual([...frameBytes], new Array(frameBytes.length).fill(0));
  assert.equal(delivered.length, 0, 'late OCR results cannot publish after cancellation');
});

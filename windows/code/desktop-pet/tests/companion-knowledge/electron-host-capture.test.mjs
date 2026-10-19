import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenTargetCapture, dispatchScreenTargetCaptureRequest } from '../../desktop/electron/screen-capture.mjs';

const display = {
  id: 42,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1.25,
};
const targetId = 'display-42';
const revision = 3;
const fingerprint = JSON.stringify([0, 0, 1920, 1080, 1.25]);
const request = (patch = {}) => ({
  operationId: 'capture-op-1', targetId, targetRevision: revision,
  targetKind: 'screen', maxBytes: 1_500_000, mimeType: 'image/png', ...patch,
});
function makeHost({ displays = [display], sources, targets = new Map([[targetId, { fingerprint, revision }]]), now } = {}) {
  const calls = [];
  const screen = { getAllDisplays: () => displays };
  const desktopCapturer = {
    async getSources(options) {
      calls.push(options);
      return sources ?? [{ display_id: '42', thumbnail: {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1350 }),
        toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
      } }];
    },
  };
  return { capture: createScreenTargetCapture({ screen, desktopCapturer, targets, now: now ?? (() => '2026-10-08T00:00:00.000Z') }), calls };
}

test('production host request dispatcher routes screen-target.capture and correlates the reply', async () => {
  const { capture } = makeHost();
  const replies = [];
  const request = { channel: 'host_request', requestId: 'req-1', method: 'screen-target.capture', params: requestParams() };
  const handled = dispatchScreenTargetCaptureRequest(request, {
    captureScreenTarget: capture,
    hostReply: (requestId, result) => replies.push({ channel: 'host_reply', requestId, ok: true, result }),
    hostRefuse: (requestId, code, message) => replies.push({ channel: 'host_reply', requestId, ok: false, error: { code, message } }),
  });
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].requestId, 'req-1');
  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].result.targetId, targetId);
  assert.equal(dispatchScreenTargetCaptureRequest({ method: 'preferences.get' }, {}), false);
});

test('production host request dispatcher returns a correlated refusal for an invalid target', async () => {
  const { capture } = makeHost();
  const replies = [];
  dispatchScreenTargetCaptureRequest({
    channel: 'host_request', requestId: 'req-invalid', method: 'screen-target.capture',
    params: requestParams({ targetId: 'display-unissued' }),
  }, {
    captureScreenTarget: capture,
    hostReply: (requestId, result) => replies.push({ requestId, ok: true, result }),
    hostRefuse: (requestId, code, message) => replies.push({ requestId, ok: false, code, message }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].requestId, 'req-invalid');
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].code, 'invalid_request');
});

function requestParams(overrides = {}) {
  return { operationId: 'dispatch-op', targetId, targetRevision: revision, targetKind: 'screen', maxBytes: 1_500_000, mimeType: 'image/png', ...overrides };
}

test('host capture resolves the host-issued display and returns exact PNG identity/dimensions', async () => {
  const { capture, calls } = makeHost();
  const result = await capture(request());
  assert.equal(result.outcome, 'captured');
  assert.equal(result.targetId, targetId);
  assert.equal(result.targetRevision, revision);
  assert.equal(result.capturedAt, '2026-10-08T00:00:00.000Z');
  assert.deepEqual(result.dimensions, { width: 2400, height: 1350 });
  assert.equal(result.mimeType, 'image/png');
  assert.equal(Buffer.from(result.bytesBase64, 'base64').subarray(0, 4).toString('hex'), '89504e47');
  assert.deepEqual(calls[0].thumbnailSize, { width: 2400, height: 1350 });
});

test('host refuses unknown, stale, removed, and geometry-changed targets before pixel access', async () => {
  const unknown = makeHost();
  await assert.rejects(unknown.capture(request({ targetId: 'display-999' })), e => e.code === 'invalid_request');
  assert.equal(unknown.calls.length, 0);

  const stale = makeHost();
  await assert.rejects(stale.capture(request({ targetRevision: 2 })), e => e.code === 'stale_revision');
  assert.equal(stale.calls.length, 0);

  const removed = makeHost({ displays: [] });
  await assert.rejects(removed.capture(request()), e => e.code === 'unavailable');
  assert.equal(removed.calls.length, 0);

  const changed = makeHost({ displays: [{ ...display, scaleFactor: 1.5 }] });
  await assert.rejects(changed.capture(request()), e => e.code === 'stale_revision');
  assert.equal(changed.calls.length, 0);
});

test('host refuses to substitute a different display source', async () => {
  const { capture, calls } = makeHost({ sources: [{ display_id: 'other-display', thumbnail: {
    isEmpty: () => false, getSize: () => ({ width: 2400, height: 1350 }), toPNG: () => Buffer.from('png'),
  } }] });
  await assert.rejects(capture(request()), e => e.code === 'unavailable');
  assert.equal(calls.length, 1);
});

test('host refuses window/region and BMP rather than silently changing the selected route', async () => {
  const { capture, calls } = makeHost();
  await assert.rejects(capture(request({ targetKind: 'window' })), e => e.code === 'unsupported');
  await assert.rejects(capture(request({ targetKind: 'region' })), e => e.code === 'unsupported');
  await assert.rejects(capture(request({ mimeType: 'image/bmp' })), e => e.code === 'unsupported');
  assert.equal(calls.length, 0);
});

test('host refuses an oversized frame and scrubs its byte buffer; no resize makes it look compliant', async () => {
  const oversized = Buffer.alloc(1_500_001, 0x41);
  const { capture, calls } = makeHost({ sources: [{ display_id: '42', thumbnail: {
    isEmpty: () => false,
    getSize: () => ({ width: 2400, height: 1350 }),
    toPNG: () => oversized,
  } }] });
  await assert.rejects(capture(request()), e => e.code === 'unavailable' && /1500001/.test(e.message));
  assert.equal(calls.length, 1);
  assert.equal(oversized.every(byte => byte === 0), true, 'oversized capture bytes are scrubbed before returning');
});

test('host rejects malformed requests before resolving a source', async () => {
  const { capture, calls } = makeHost();
  for (const bad of [
    request({ operationId: '' }),
    request({ targetRevision: 0 }),
    request({ maxBytes: 0 }),
    request({ maxBytes: 20 * 1024 * 1024 + 1 }),
    request({ targetKind: 'desktop' }),
  ]) await assert.rejects(capture(bad), e => e.code === 'invalid_request');
  assert.equal(calls.length, 0);
});

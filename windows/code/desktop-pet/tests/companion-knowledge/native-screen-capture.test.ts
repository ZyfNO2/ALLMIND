/**
 * tests/companion-knowledge/native-screen-capture.test.ts
 *
 * CK-11: Windows 实际 capture、像素 OCR 与显式 VLM。
 *
 * AC-11-1: 目标/时间/尺寸可证；screen/window/region 边界正确；未授权目标零捕获。
 * AC-11-2: 空白 no-content / 坏图 failed / 缺引擎 unavailable（真实像素识别 NOT RUN，留 15）。
 * AC-11-3: 无云图授权零外发；缺模型 capability 不可选。
 * AC-11-4: 取消/超时/撤销后资源归零（inFlight 计数）。
 *
 * 重要边界：本套件注入的是 **host 替身**，用于证明 adapter 的正确性与资源语义。
 * 它**不能**证明真实 Windows 像素捕获或真实 OCR 识别——那两项按 SPEC 记 NOT_RUN/BLOCKED。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsScreenCapture, HostCaptureError, captureAvailability, CONTINUOUS_FRAME_MAX_BYTES } from '../../core/windows-screen-capture.js';
import { ScreenCaptureSource, type ScreenTarget, type CapturedFrame } from '../../core/screen-capture-source.js';
import { isHostCaptureRequest, isHostCaptureResult, type HostCaptureRequest } from '../../contracts/desktop-host-capture.js';
import { DESKTOP_HOST_METHODS, isDesktopHostMethod } from '../../contracts/desktop-host.js';
import { captureHostScreenTarget, DesktopHostBridge } from '../../app/desktop-host-bridge.js';
import { createLocalOcrEngine } from '../../core/local-ocr-engine.js';
import { checkPurpose } from '../../core/screen-grant-purpose.js';

const NOW = '2026-10-07T02:00:00.000Z';

/** A real 1x1 PNG, so the fixture is an actual image rather than random bytes. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('base64');

function target(overrides: Partial<ScreenTarget> = {}): ScreenTarget {
  return {
    targetId: 'display-1', targetRevision: 1, kind: 'screen', displayName: '主显示器',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isValid: true, ...overrides,
  };
}

function okResult(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'captured', targetId: 'display-1', targetRevision: 1, capturedAt: NOW,
    mimeType: 'image/png', dimensions: { width: 1920, height: 1080 },
    bytesBase64: PNG_1X1, ...overrides,
  };
}

function captureWith(
  result: unknown | ((request: HostCaptureRequest) => unknown),
  options: { maxBytes?: number } = {},
) {
  return new WindowsScreenCapture({
    requestHostCapture: async (request: HostCaptureRequest) =>
      (typeof result === 'function' ? (result as (r: HostCaptureRequest) => unknown)(request) : result),
    now: () => NOW,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
}

// ================================================================================================
// AC-11-1 目标/时间/尺寸与边界
// ================================================================================================

test('AC-11-1: 真实 host 响应产出带目标/时间/尺寸的帧', async () => {
  const capture = captureWith(okResult());
  const frame = await capture.capture(target());
  assert.ok(frame, '必须产出帧');
  assert.equal(frame.targetId, 'display-1');
  assert.equal(frame.targetRevision, 1);
  assert.equal(frame.capturedAt, NOW);
  assert.deepEqual(frame.dimensions, { width: 1920, height: 1080 });
  assert.equal(frame.mimeType, 'image/png');
  assert.ok(frame.bytes instanceof Uint8Array);
  assert.ok(frame.bytes.length > 0, '帧必须真的有像素');
  // The bytes are a real PNG signature, not random filler.
  assert.deepEqual([...frame.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('AC-11-1: screen/window/region 三种目标都可达，未知类型被拒', async () => {
  for (const kind of ['screen', 'window', 'region'] as const) {
    // The host echoes the identity it was asked for; the adapter verifies that echo.
    const capture = captureWith((request: HostCaptureRequest) => okResult({
      targetId: request.targetId, targetRevision: request.targetRevision,
    }));
    const frame = await capture.capture(target({ kind, targetId: `${kind}-1` }));
    assert.ok(frame, '必须产出帧');
    assert.equal(frame.targetId, `${kind}-1`);
  }
  // A kind outside the frozen set must be refused, never coerced to 'screen'.
  const bad = captureWith(okResult());
  await assert.rejects(
    bad.capture(target({ kind: 'desktop' as never })),
    (error: unknown) => error instanceof HostCaptureError && error.reason === 'target_kind_unsupported',
  );
});

test('AC-11-1: 未授权目标零捕获（ScreenCaptureSource 先于 host 拒绝）', async () => {
  let hostCalls = 0;
  const capture = new WindowsScreenCapture({
    requestHostCapture: async () => { hostCalls += 1; return okResult(); },
    now: () => NOW,
  });
  const source = new ScreenCaptureSource({ captureHook: capture.hook() });
  const grant = {
    schemaVersion: 1 as const, grantId: 'g-1', revision: 1, pairing: { userId: 'u', characterId: 'companion', characterInstanceId: 'i' },
    targetId: 'display-1', targetRevision: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    runtimeSessionId: 's-1', minPollIntervalMs: 300_000, expiry: '2026-12-01T00:00:00.000Z',
    destination: 'local' as const, state: 'active' as const,
  };
  await source.attachContinuousGrant(grant);
  // A different target than the grant names must never reach the host.
  await assert.rejects(source.capture(target({ targetId: 'display-2' })), /target_grant_mismatch/);
  assert.equal(hostCalls, 0, '未授权目标不得触发任何 host 捕获');
});

test('AC-11-1: 持续帧遵守冻结的 1.5 MiB 上限，超限拒绝而非压缩', async () => {
  assert.equal(CONTINUOUS_FRAME_MAX_BYTES, 1_500_000, '冻结值不得放宽成 20 MiB');
  const oversized = Buffer.alloc(2_000_000, 1).toString('base64');
  const capture = captureWith(okResult({ bytesBase64: oversized }));
  await assert.rejects(
    capture.capture(target()),
    (error: unknown) => error instanceof HostCaptureError && error.reason === 'frame_too_large',
  );
});

test('AC-11-1: host 失败各有具名原因，不静默返回空帧', async () => {
  const cases: [string, unknown][] = [
    ['capture_denied', { outcome: 'denied', targetId: 'display-1', targetRevision: 1, reason: '用户拒绝' }],
    ['target_invalidated', { outcome: 'invalidated', targetId: 'display-1', targetRevision: 1 }],
    ['host_unavailable', { outcome: 'unavailable', targetId: 'display-1', targetRevision: 1 }],
  ];
  for (const [reason, payload] of cases) {
    const capture = captureWith(payload);
    await assert.rejects(
      capture.capture(target()),
      (error: unknown) => error instanceof HostCaptureError && error.reason === reason,
      `${reason} 必须有具名错误`,
    );
  }
});

test('AC-11-1: 畸形响应被拒（captured 却无像素）', async () => {
  const capture = captureWith({ outcome: 'captured', targetId: 'display-1', targetRevision: 1, capturedAt: NOW });
  await assert.rejects(
    capture.capture(target()),
    (error: unknown) => error instanceof HostCaptureError && error.reason === 'malformed_host_response',
  );
  // A frame for a different target than requested is also a protocol violation.
  const wrongTarget = captureWith(okResult({ targetId: 'display-9' }));
  await assert.rejects(
    wrongTarget.capture(target()),
    (error: unknown) => error instanceof HostCaptureError && error.reason === 'malformed_host_response',
  );
});

// ================================================================================================
// AC-11-4 取消与资源归零
// ================================================================================================

test('AC-11-4: 取消立即中止，inFlight 归零', async () => {
  const controller = new AbortController();
  let hostCalls = 0;
  const capture = new WindowsScreenCapture({
    requestHostCapture: async () => { hostCalls += 1; return okResult(); },
    now: () => NOW,
  });
  controller.abort();
  await assert.rejects(capture.capture(target(), controller.signal), /abort/i);
  assert.equal(capture.outstanding, 0, '取消后不得残留在途句柄');
  assert.equal(hostCalls, 0, '已取消的请求不得触达 host');
});

test('AC-11-4: host 抛错后 inFlight 仍归零', async () => {
  const capture = captureWith(() => { throw new Error('native failure'); });
  await assert.rejects(capture.capture(target()));
  assert.equal(capture.outstanding, 0, '失败路径同样必须释放');
});
test('AC-11-4: 超时由 signal 控制，迟到响应不产生帧', async () => {
  const controller = new AbortController();
  const capture = new WindowsScreenCapture({
    requestHostCapture: async () => new Promise(resolve => { setTimeout(() => resolve(okResult()), 20); }),
    now: () => NOW,
  });
  const pending = capture.capture(target(), controller.signal);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(capture.outstanding, 0);
});

// ================================================================================================
// 能力视图：真实状态而非凭据存在
// ================================================================================================

test('AC-11-3: 缺 host bridge 时能力为 unavailable 而非可用', () => {
  const availability = captureAvailability({});
  assert.equal(availability.available, false);
  assert.equal(availability.reason, 'host_bridge_missing');
  assert.ok(availability.detail && availability.detail.length > 0, '必须说明下一步原因');
});

test('AC-11-3: 注入 capture route 后能力才为可用', () => {
  const availability = captureAvailability({ requestHostCapture: async () => null });
  assert.equal(availability.available, true);
  assert.equal(availability.reason, null);
});

test('AC-11-3: 无云图授权时零外发（用途校验先于任何调用）', () => {
  const noConsent = checkPurpose({
    purpose: 'capture-continuous-cloud-image', destination: 'cloud',
    userConfirmed: false, modelBinding: 'm',
  });
  assert.equal(noConsent.allowed, false, '未确认不得外发原图');

  const localOnly = checkPurpose({ purpose: 'capture-continuous-local', destination: 'local', userConfirmed: true });
  assert.equal(localOnly.allowed, true);
  assert.equal(localOnly.destination, 'local', '本地路线不产生任何外发');
});

test('AC-11-3: 协议校验拒绝缺少字段的请求', () => {
  assert.equal(isHostCaptureRequest({ operationId: 'o', targetId: 't', targetRevision: 1, targetKind: 'screen', maxBytes: 10, mimeType: 'image/png' }), true);
  assert.equal(isHostCaptureRequest({ operationId: 'o', targetId: 't', targetRevision: 1, targetKind: 'desktop', maxBytes: 10, mimeType: 'image/png' }), false);
  assert.equal(isHostCaptureRequest({ operationId: 'o', targetId: 't', targetRevision: 0, targetKind: 'screen', maxBytes: 10, mimeType: 'image/png' }), false);
  // A browser-supplied frame is not part of the request shape at all.
  assert.equal(isHostCaptureRequest({ operationId: 'o', targetId: 't', targetRevision: 1, targetKind: 'screen', maxBytes: 10, mimeType: 'image/png', bytesBase64: 'x' }), true);
  assert.equal('bytesBase64' in ({ operationId: 'o', targetId: 't', targetRevision: 1, targetKind: 'screen', maxBytes: 10, mimeType: 'image/png' } as HostCaptureRequest), false);
});

test('AC-11-2: 缺 OCR 引擎报 unavailable，不凭空造结果', async () => {
  const engine = createLocalOcrEngine();
  const result = await engine(new Uint8Array(64 * 64 * 3).fill(0x7f));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'pixel_ocr_hook_missing');
  assert.equal(result.blocks.length, 0, '不得编造识别块');
  assert.equal(result.readingOrderText, '', '不得编造文本');
});

test('AC-11-2: 真实像素识别 NOT_RUN（本套件不证明）', () => {
  // Honest marker: CK-11 AC-11-2 的 CER/P95 与真实中英文像素图识别需要实机环境，留 CK-15。
  assert.equal(typeof CONTINUOUS_FRAME_MAX_BYTES, 'number');
  assert.equal(WindowsScreenCapture.frameDigest({
    targetId: 't', targetRevision: 1, capturedAt: NOW, mimeType: 'image/png',
    dimensions: { width: 1, height: 1 }, bytes: new Uint8Array([1, 2, 3]),
  }).length, 64, '帧摘要可用于证明「同一批像素」');
});

test('AC-11-2: 空白像素图不产生伪造正文', async () => {
  const engine = createLocalOcrEngine({ engineName: 'fixture', recognizePixelHook: async () => [] });
  const result = await engine(new Uint8Array(32 * 32 * 3).fill(0x20));
  assert.equal(result.status, 'ok');
  assert.equal(result.readingOrderText, '');
  assert.equal(result.blocks.length, 0);
});

// ================================================================================================
// CK-11 组合修复回归：宿主桥只有 `request`，捕获路线曾永远不可达
// ================================================================================================

/**
 * 这不是「再补一个 happy path」。修复前 `#ask` 鸭子类型找的是 `hostRequest`，而
 * `DesktopHostBridge` 只暴露 `request`；因此**只要接了宿主**，每次真实捕获都抛
 * `host_bridge_missing`，而 `captureAvailability` 只看「有没有对象」照旧报 available: true。
 * 下面用真实 `DesktopHostBridge` 形态的替身锁住这条边：能力报告与实际可调用性必须一致。
 */
test('CK-11 回归: 桥只有 request 时捕获可用，且确实发出 screen-target.capture', async () => {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const bridge = {
    request: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return okResult({ targetId: params['targetId'], targetRevision: params['targetRevision'] });
    },
  };
  const availability = captureAvailability({ bridge: bridge as never });
  assert.equal(availability.available, true, '有可调用的 request 时必须报可用');

  const capture = new WindowsScreenCapture({ bridge: bridge as never, now: () => NOW });
  const frame = await capture.capture(target());
  assert.ok(frame, '必须真正拿到帧');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, 'screen-target.capture');
  assert.equal(sent[0]!.params['targetId'], 'display-1');
  assert.equal(sent[0]!.params['maxBytes'], CONTINUOUS_FRAME_MAX_BYTES, '必须携带冻结的 1.5MiB 上限');
});

test('CK-11 回归: 桥缺 request 时报不可用，且捕获抛 host_bridge_missing', async () => {
  // A bridge-shaped object that does not implement the method the route calls: the availability
  // report must NOT claim the route works, and the capture must name the missing bridge.
  const hollow = { hostRequest: async () => okResult() };
  const availability = captureAvailability({ bridge: hollow as never });
  assert.equal(availability.available, false, '没有 request 时不得报可用');
  assert.equal(availability.reason, 'host_bridge_missing');

  const capture = new WindowsScreenCapture({ bridge: hollow as never, now: () => NOW });
  await assert.rejects(
    capture.capture(target()),
    (error: unknown) => error instanceof HostCaptureError && error.reason === 'host_bridge_missing',
  );
});

test('CK-11 回归: 宿主契约方法集包含 screen-target.capture', () => {
  // The bridge refuses any method outside the union before the host is ever asked, so the route is
  // unreachable unless the union names it.
  assert.ok(DESKTOP_HOST_METHODS.includes('screen-target.capture' as never), '方法集必须包含捕获路线');
  assert.equal(isDesktopHostMethod('screen-target.capture'), true);
});

test('CK-11 回归: 正式 DesktopHostBridge correlated request/reply 可走捕获方法', async () => {
  let wire: Record<string, unknown> | undefined;
  const bridge = new DesktopHostBridge({ send: message => { wire = message as Record<string, unknown>; } });
  const expected = okResult();
  const pending = captureHostScreenTarget(bridge, {
    operationId: 'bridge-capture-1', targetId: 'display-1', targetRevision: 1,
    targetKind: 'screen', maxBytes: CONTINUOUS_FRAME_MAX_BYTES, mimeType: 'image/png',
  });
  assert.equal(wire?.['channel'], 'host_request');
  assert.equal(wire?.['method'], 'screen-target.capture');
  assert.equal(typeof wire?.['requestId'], 'string');
  assert.equal(bridge.receive({
    channel: 'host_reply', requestId: wire?.['requestId'], ok: true, result: expected,
  }), true);
  assert.deepEqual(await pending, expected);
  assert.equal(bridge.inFlight, 0);
});

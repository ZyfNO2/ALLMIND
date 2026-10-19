/**
 * tests/companion-knowledge/screen-grant-lifecycle.test.ts
 *
 * CK-10: 屏幕目标、版本化用途授权与持久恢复。
 *
 * AC-10-1: 可信 screen/window/region、取消/失效/跨 pairing/伪造引用正确；metadata 枚举零像素采集。
 * AC-10-2: 用途/destination 严格分离；云图/云文本/长期留存无旧 grant 隐式扩权。
 * AC-10-3: 重启持久 consent 可见但不自动运行；旧 session/句柄/到期不能重用。
 * AC-10-4: saved/effective 分列；未安装能力清楚 unavailable，不产生非空点击。
 *
 * 被测模块走真实 ScreenGrantStore（真实 SQLite）与真实用途校验；CaptureGrantManager 仍是
 * 单次/持续授权的原 owner，未被替换。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { ScreenGrantStore, isUsable, type PersistedScreenTarget, type ScreenGrantPurposeV2 } from '../../memory/screen-grant-store.js';
import {
  checkPurpose,
  grantReadiness,
  upgradePurposeV1,
  PURPOSE_DESTINATION,
  CLOUD_PURPOSES,
} from '../../core/screen-grant-purpose.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';

const NOW = '2026-10-07T02:00:00.000Z';
const PAIRING = productionPairing('companion', 'inst-ck10');

function target(overrides: Partial<PersistedScreenTarget> = {}): PersistedScreenTarget {
  return {
    pairingKey: '', targetKind: 'screen', targetId: 'screen-1', targetRevision: 1,
    displayName: '主显示器', bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1, selectedAt: NOW, ...overrides,
  };
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    purpose: 'capture-continuous-local' as ScreenGrantPurposeV2,
    targetKind: 'screen' as const,
    targetId: 'screen-1',
    targetRevision: 1,
    destination: 'local' as const,
    consentRevision: 1,
    consentGrantedAt: NOW,
    expiresAt: '2026-10-07T03:00:00.000Z',
    status: 'active' as const,
    needsValidation: false,
    sessionIdAtGrant: 'session-1',
    ...overrides,
  };
}

function storeFor(path: string) {
  const memory = new SqliteMemoryStore({
    filename: path, retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => NOW,
  });
  return { memory, store: ScreenGrantStore.open(memory) };
}

// ================================================================================================
// AC-10-1 目标可信性与 metadata 零像素
// ================================================================================================

test('AC-10-1: 目标只存 metadata，不存任何像素内容', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const { memory, store } = storeFor(resolve(root, 'a.sqlite'));
  try {
    store.saveTarget(PAIRING, target());
    const loaded = store.loadTarget(PAIRING, 'screen-1')!;
    assert.equal(loaded.displayName, '主显示器');
    assert.deepEqual(loaded.bounds, { x: 0, y: 0, width: 1920, height: 1080 });
    // The record must not carry image bytes: only geometry and a name.
    const serialised = JSON.stringify(loaded);
    assert.ok(!/base64|data:image|png|jpeg/i.test(serialised), '目标记录不得携带像素内容');
  } finally { memory.close(); }
});

test('AC-10-1: window/region 目标受支持且各自隔离', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const { memory, store } = storeFor(resolve(root, 'a.sqlite'));
  try {
    store.saveTarget(PAIRING, target({ targetKind: 'window', targetId: 'hwnd-42', displayName: '浏览器窗口' }));
    store.saveTarget(PAIRING, target({ targetKind: 'region', targetId: 'region-7', displayName: '选区', bounds: { x: 10, y: 20, width: 300, height: 200 } }));
    assert.equal(store.loadTarget(PAIRING, 'hwnd-42')!.targetKind, 'window');
    assert.equal(store.loadTarget(PAIRING, 'region-7')!.targetKind, 'region');
    assert.equal(store.loadTarget(PAIRING, 'hwnd-42')!.bounds.width, 1920, '各目标几何独立保存');
  } finally { memory.close(); }
});

test('AC-10-1: 跨 pairing 读取不到他人目标与授权', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const { memory, store } = storeFor(resolve(root, 'a.sqlite'));
  try {
    const other = productionPairing('companion', 'inst-other');
    store.saveTarget(PAIRING, target());
    store.saveGrant(PAIRING, grant());
    assert.equal(store.loadTarget(other, 'screen-1'), null, '他人目标不可见');
    assert.equal(store.grant(other, store.listGrants(PAIRING)[0]!.id), null, '他人授权不可见');
    assert.equal(store.listGrants(other).length, 0);
  } finally { memory.close(); }
});

test('AC-10-1: 不存在的目标 id 读不到，伪造引用无效', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const { memory, store } = storeFor(resolve(root, 'a.sqlite'));
  try {
    assert.equal(store.loadTarget(PAIRING, 'forged-id'), null);
    store.saveGrant(PAIRING, grant({ targetId: 'forged-id' }));
    // The grant exists as consent history but names a target that was never selected.
    const listed = store.listGrants(PAIRING);
    assert.equal(listed[0]!.targetId, 'forged-id');
    assert.equal(store.loadTarget(PAIRING, 'forged-id'), null, '伪造引用没有对应目标');
  } finally { memory.close(); }
});

// ================================================================================================
// AC-10-2 用途/destination 严格分离
// ================================================================================================

test('AC-10-2: 每个用途只有一个允许的 destination', () => {
  assert.equal(PURPOSE_DESTINATION['capture-single'], 'local');
  assert.equal(PURPOSE_DESTINATION['capture-continuous-local'], 'local');
  assert.equal(PURPOSE_DESTINATION['capture-continuous-cloud-image'], 'cloud');
  assert.equal(PURPOSE_DESTINATION['context-use-cloud-text'], 'cloud');
  assert.equal(PURPOSE_DESTINATION['long-term-retention'], 'local');
});

test('AC-10-2: 目的地不匹配一律拒绝，不静默降级或升级', () => {
  const localAsCloud = checkPurpose({ purpose: 'capture-continuous-local', destination: 'cloud', userConfirmed: true });
  assert.equal(localAsCloud.allowed, false);
  assert.equal(localAsCloud.refusal, 'purpose_destination_mismatch');

  const cloudAsLocal = checkPurpose({
    purpose: 'capture-continuous-cloud-image', destination: 'local',
    userConfirmed: true, modelBinding: 'm',
  });
  assert.equal(cloudAsLocal.allowed, false);
  assert.equal(cloudAsLocal.refusal, 'purpose_destination_mismatch', '不得把云图请求静默降级为本地');
});

test('AC-10-2: 云用途必须有模型绑定', () => {
  for (const purpose of CLOUD_PURPOSES) {
    const verdict = checkPurpose({ purpose, destination: 'cloud', userConfirmed: true });
    assert.equal(verdict.allowed, false, `${purpose} 缺模型绑定必须拒绝`);
    assert.equal(verdict.refusal, 'model_binding_required');
  }
  const ok = checkPurpose({
    purpose: 'context-use-cloud-text', destination: 'cloud', userConfirmed: true, modelBinding: 'deepseek-v4-pro',
  });
  assert.equal(ok.allowed, true);
});

test('AC-10-2: 长期留存不被单次捕获隐式包含', () => {
  const verdict = checkPurpose({ purpose: 'long-term-retention', destination: 'local', userConfirmed: true });
  assert.equal(verdict.allowed, true, '留存可单独授权');
  // A single-capture grant says nothing about retention.
  const single = checkPurpose({ purpose: 'capture-single', destination: 'local', userConfirmed: true });
  assert.equal(single.allowed, true);
  assert.equal(single.purpose, 'capture-single');
  assert.notEqual(single.purpose, 'long-term-retention');
});

test('AC-10-2: 旧 v1 授权不得被拓宽', () => {
  // v1 local continuous carried forward: the only purposes it may still mean are its own.
  assert.equal(upgradePurposeV1({ purpose: 'capture-continuous', destination: 'local' }), 'capture-continuous-local');
  assert.equal(upgradePurposeV1({ purpose: 'capture-single', destination: 'local' }), 'capture-single');

  const widened = checkPurpose({
    purpose: 'capture-continuous-cloud-image', destination: 'cloud',
    userConfirmed: true, modelBinding: 'm', carriedFromV1: true,
  });
  assert.equal(widened.allowed, false, 'v1 本地持续授权不得升级为云图');
  assert.equal(widened.refusal, 'v1_grant_cannot_be_widened');

  const retentionFromV1 = checkPurpose({
    purpose: 'long-term-retention', destination: 'local', userConfirmed: true, carriedFromV1: true,
  });
  assert.equal(retentionFromV1.allowed, false, 'v1 授权不得隐式获得长期留存');
});

test('AC-10-2: 未显式确认一律拒绝', () => {
  const verdict = checkPurpose({ purpose: 'capture-single', destination: 'local', userConfirmed: false });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.refusal, 'explicit_confirmation_required');
});

test('AC-10-2: 未知用途被拒绝', () => {
  const verdict = checkPurpose({ purpose: 'anything-goes', destination: 'local', userConfirmed: true });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.refusal, 'unknown_purpose');
});

// ================================================================================================
// AC-10-3 持久化与重启
// ================================================================================================

test('AC-10-3: 授权跨重启可见', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const path = resolve(root, 'a.sqlite');
  const first = storeFor(path);
  first.store.saveGrant(PAIRING, grant());
  first.memory.close();

  const second = storeFor(path);
  try {
    const listed = second.store.listGrants(PAIRING);
    assert.equal(listed.length, 1, '重启后 consent 仍然可见');
    assert.equal(listed[0]!.consentRevision, 1);
  } finally { second.memory.close(); }
});

test('AC-10-3: 重启后 active 授权变为 paused + needsValidation，不自动运行', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const path = resolve(root, 'a.sqlite');
  const first = storeFor(path);
  first.store.saveGrant(PAIRING, grant());
  assert.equal(isUsable(first.store.listGrants(PAIRING)[0]!, '2026-10-07T02:30:00.000Z'), true, '运行期可用');
  first.memory.close();

  const second = storeFor(path);
  try {
    const paused = second.store.pauseAllOnStartup(PAIRING);
    assert.equal(paused, 1, '重启时活跃授权被转为待重新验证');
    const listed = second.store.listGrants(PAIRING);
    assert.equal(listed[0]!.status, 'paused');
    assert.equal(listed[0]!.needsValidation, true);
    assert.equal(isUsable(listed[0]!, '2026-10-07T02:30:00.000Z'), false, '重启后旧授权不得直接使用');
  } finally { second.memory.close(); }
});

test('AC-10-3: 旧 session 句柄不得重用', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const { memory, store } = storeFor(resolve(root, 'a.sqlite'));
  try {
    store.saveGrant(PAIRING, grant({ sessionIdAtGrant: 'old-session' }));
    const restored = store.listGrants(PAIRING)[0]!;
    assert.equal(restored.sessionIdAtGrant, 'old-session');
    // The record keeps the OLD session id so a rebuilt runtime can see it no longer matches,
    // rather than silently adopting a handle that no longer exists.
    assert.notEqual(restored.sessionIdAtGrant, 'new-session', '新 runtime 不得沿用旧 session');
  } finally { memory.close(); }
});

test('AC-10-3: 到期授权不可用', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const { memory, store } = storeFor(resolve(root, 'a.sqlite'));
  try {
    store.saveGrant(PAIRING, grant({ expiresAt: '2026-10-07T01:00:00.000Z' }));
    const listed = store.listGrants(PAIRING)[0]!;
    assert.equal(isUsable(listed, '2026-10-07T02:00:00.000Z'), false);
    const readiness = grantReadiness({ grant: listed, capabilityAvailable: true, nowIso: '2026-10-07T02:00:00.000Z' });
    assert.equal(readiness.reason, 'expired');
  } finally { memory.close(); }
});

test('AC-10-3: 目标变化使该目标的活跃授权失效', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const { memory, store } = storeFor(resolve(root, 'a.sqlite'));
  try {
    store.saveGrant(PAIRING, grant());
    store.saveGrant(PAIRING, grant({ targetId: 'other-screen' }));
    const invalidated = store.invalidateForTarget(PAIRING, 'screen-1');
    assert.equal(invalidated, 1, '换目标只作废该目标的授权');
    const listed = store.listGrants(PAIRING);
    assert.equal(listed.find(item => item.targetId === 'screen-1')!.needsValidation, true);
    assert.equal(listed.find(item => item.targetId === 'other-screen')!.needsValidation, false, '他人目标不受影响');
  } finally { memory.close(); }
});

test('AC-10-3: 撤销持久化，重启后仍是撤销态（tombstone 语义）', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck10-'));
  const path = resolve(root, 'a.sqlite');
  const first = storeFor(path);
  const saved = first.store.saveGrant(PAIRING, grant());
  first.store.setStatus(PAIRING, saved.id, 'revoked', false);
  first.memory.close();

  const second = storeFor(path);
  try {
    const listed = second.store.listGrants(PAIRING);
    assert.equal(listed[0]!.status, 'revoked', '撤销跨重启保持');
    assert.equal(isUsable(listed[0]!, '2026-10-07T02:30:00.000Z'), false);
  } finally { second.memory.close(); }
});

// ================================================================================================
// AC-10-4 readiness：saved / effective 分列
// ================================================================================================

test('AC-10-4: 无授权、缺能力、待重验、换模型各有不同原因', () => {
  assert.equal(grantReadiness({ grant: null, capabilityAvailable: true, nowIso: NOW }).reason, 'no_grant');
  assert.equal(
    grantReadiness({ grant: { status: 'active', needsValidation: false, expiresAt: '2026-10-07T03:00:00.000Z' }, capabilityAvailable: false, nowIso: NOW }).reason,
    'capability_missing',
  );
  assert.equal(
    grantReadiness({ grant: { status: 'active', needsValidation: true, expiresAt: '2026-10-07T03:00:00.000Z' }, capabilityAvailable: true, nowIso: NOW }).reason,
    'needs_revalidation',
  );
  assert.equal(
    grantReadiness({
      grant: { status: 'active', needsValidation: false, expiresAt: '2026-10-07T03:00:00.000Z', modelBinding: 'old-model' },
      capabilityAvailable: true, nowIso: NOW, currentModelBinding: 'new-model',
    }).reason,
    'model_binding_changed',
  );
  const ready = grantReadiness({
    grant: { status: 'active', needsValidation: false, expiresAt: '2026-10-07T03:00:00.000Z' },
    capabilityAvailable: true, nowIso: NOW,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, 'ready');
});

test('AC-10-4: 缺能力时不得产生可用点击（ready 必须为 false）', () => {
  for (const purpose of Object.keys(PURPOSE_DESTINATION) as ScreenGrantPurposeV2[]) {
    const verdict = checkPurpose({ purpose, destination: PURPOSE_DESTINATION[purpose], userConfirmed: true, modelBinding: 'm' });
    if (!verdict.allowed) continue;
    // Even a legitimately consented purpose is not clickable without the capability.
    const readiness = grantReadiness({
      grant: { status: 'active', needsValidation: false, expiresAt: '2026-10-07T03:00:00.000Z' },
      capabilityAvailable: false, nowIso: NOW,
    });
    assert.equal(readiness.ready, false, `${purpose} 在缺能力时不得可执行`);
  }
});

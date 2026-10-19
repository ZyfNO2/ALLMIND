/**
 * tests/companion-knowledge/greeting-takeover-persistence.test.ts
 *
 * CK-14: durable takeover state.
 *
 * The property that matters: the handshake state must survive a restart, because a crash between
 * "old timer stopped" and "new path ready" would otherwise restart in `legacy-active` and then
 * speak twice once the new path also became live — the exact double-timer failure the handshake
 * exists to prevent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { GreetingTakeoverStore } from '../../memory/greeting-takeover-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';

const PAIRING = productionPairing('companion', 'inst-takeover');
const NOW = '2026-10-07T02:00:00.000Z';

function openAt(path: string, pairing: PairingScope = PAIRING) {
  const memory = new SqliteMemoryStore({
    filename: path, retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => NOW,
  });
  return { memory, store: GreetingTakeoverStore.open(memory, () => NOW), pairing };
}

test('CK-14 持久化：新配对默认 legacy-active，不默认 ready', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-takeover-'));
  const h = openAt(resolve(root, 'a.sqlite'));
  try {
    const state = h.store.read(h.pairing);
    assert.equal(state.phase, 'legacy-active', '新安装必须先走旧机制');
    assert.equal(state.migrationVersion, 0);
    assert.equal(state.migratedEnabled, true, '旧开关默认开启语义保留');
  } finally { h.memory.close(); }
});

test('CK-14 持久化：握手推进跨重启保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-takeover-'));
  const path = resolve(root, 'a.sqlite');

  const first = openAt(path);
  first.store.write(first.pairing, {
    phase: 'legacy-stopped', migrationVersion: 1, migratedEnabled: true, migratedLastShownAt: null,
  });
  first.memory.close();

  const second = openAt(path);
  try {
    const state = second.store.read(second.pairing);
    assert.equal(state.phase, 'legacy-stopped', '中间阶段必须跨重启保留');
    assert.equal(state.migrationVersion, 1);

    second.store.write(second.pairing, {
      phase: 'ready', migrationVersion: 2, migratedEnabled: false, migratedLastShownAt: 1_700_000_000_000,
    });
  } finally { second.memory.close(); }

  const third = openAt(path);
  try {
    const state = third.store.read(third.pairing);
    assert.equal(state.phase, 'ready');
    assert.equal(state.migrationVersion, 2);
    assert.equal(state.migratedEnabled, false, '用户原本关闭的状态必须保留');
    assert.equal(state.migratedLastShownAt, 1_700_000_000_000, '原最后展示时间保留');
  } finally { third.memory.close(); }
});

test('CK-14 持久化：握手不得回退（防双发）', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-takeover-'));
  const h = openAt(resolve(root, 'a.sqlite'));
  try {
    h.store.write(h.pairing, {
      phase: 'ready', migrationVersion: 2, migratedEnabled: true, migratedLastShownAt: null,
    });
    // A stale caller that still thinks the legacy timer runs must not demote the pairing: that
    // would re-open the window in which both greeters speak.
    const refused = h.store.write(h.pairing, {
      phase: 'legacy-active', migrationVersion: 1, migratedEnabled: true, migratedLastShownAt: null,
    });
    assert.equal(refused.phase, 'ready', '握手不得回退到 legacy-active');
    assert.equal(refused.migrationVersion, 2, '不得回退迁移版本');
    assert.equal(h.store.read(h.pairing).phase, 'ready');
  } finally { h.memory.close(); }
});

test('CK-14 持久化：失败阶段记录原因且可跨重启诊断', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-takeover-'));
  const path = resolve(root, 'a.sqlite');
  const first = openAt(path);
  first.store.write(first.pairing, {
    phase: 'failed', migrationVersion: 1, migratedEnabled: true, migratedLastShownAt: null,
    reason: 'host_unreachable',
  });
  first.memory.close();

  const second = openAt(path);
  try {
    const state = second.store.read(second.pairing);
    assert.equal(state.phase, 'failed');
    assert.equal(state.reason, 'host_unreachable', '失败原因必须跨重启可诊断');
  } finally { second.memory.close(); }
});

test('CK-14 持久化：失败后可从 legacy-active 重新推进', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-takeover-'));
  const h = openAt(resolve(root, 'a.sqlite'));
  try {
    h.store.write(h.pairing, {
      phase: 'failed', migrationVersion: 1, migratedEnabled: true, migratedLastShownAt: null, reason: 'boom',
    });
    // Recovery retries from the legacy position, then advances normally.
    const restarted = h.store.write(h.pairing, {
      phase: 'legacy-active', migrationVersion: 1, migratedEnabled: true, migratedLastShownAt: null,
    });
    assert.equal(restarted.phase, 'legacy-active', '失败态可回到 legacy 重试');
    const advanced = h.store.write(h.pairing, {
      phase: 'legacy-stopped', migrationVersion: 1, migratedEnabled: true, migratedLastShownAt: null,
    });
    assert.equal(advanced.phase, 'legacy-stopped');
  } finally { h.memory.close(); }
});

test('CK-14 持久化：崩溃恢复保持一个说话者', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-takeover-'));
  const path = resolve(root, 'a.sqlite');
  const first = openAt(path);
  first.store.write(first.pairing, {
    phase: 'ready', migrationVersion: 2, migratedEnabled: true, migratedLastShownAt: null,
  });
  first.memory.close();

  // A `ready` pairing whose runtime died before confirming stays ready: the legacy timer is
  // already stopped, so demoting would leave nobody speaking.
  const second = openAt(path);
  try {
    const recovered = second.store.recoverAfterCrash(second.pairing);
    assert.equal(recovered.phase, 'ready', 'ready 不得因崩溃回退（否则无人出句）');
  } finally { second.memory.close(); }
});

test('CK-14 持久化：跨配对互不影响', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-takeover-'));
  const h = openAt(resolve(root, 'a.sqlite'));
  try {
    const other = productionPairing('companion', 'inst-other');
    h.store.write(h.pairing, { phase: 'ready', migrationVersion: 2, migratedEnabled: true, migratedLastShownAt: null });
    const otherState = h.store.read(other);
    assert.equal(otherState.phase, 'legacy-active', '另一实例不受本实例迁移影响');
    assert.equal(otherState.migrationVersion, 0);
  } finally { h.memory.close(); }
});
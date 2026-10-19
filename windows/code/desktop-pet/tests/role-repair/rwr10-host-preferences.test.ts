import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyHostPatch, defaultHostPreferences, hostCapabilities, HostOperationLedger, parseHostPreferences,
  serializeHostPreferences, toHostPreferencesPayload,
} from '../../desktop/electron/host-preferences.js';
import {
  DESKTOP_HOST_API_VERSION, DISPLAY_MAX_WIDTH, DISPLAY_MIN_WIDTH, VALID_HOTKEY_PATTERN, isValidHotkey,
  operationSignature,
} from '../../contracts/desktop-host.js';

/**
 * RWR-10-01 AC-01-3: an old prefs file (written before this round) must be readable, and its first write
 * must upgrade it to a revision without losing the user's existing values or any unknown field.
 */
test('RWR-10-01: a legacy prefs file without revision reads as 0 and keeps every user value', () => {
  // The exact shape produced by the pre-RWR-10 host (desktop/electron/main.mjs before this round).
  const legacy = { mode: 'half', width: 480, hotkey: 'KeyV', localGreeting: false,
    localGreetingLastShownAt: 1_700_000_000_000, anchor: { x: 10, y: 20 } };
  const parsed = parseHostPreferences(legacy);
  assert.equal(parsed.state.revision, 0, 'a missing revision is the documented legacy case');
  assert.equal(parsed.state.mode, 'half');
  assert.equal(parsed.state.width, 480);
  assert.equal(parsed.state.hotkey, 'KeyV');
  assert.equal(parsed.state.localGreeting, false);
  assert.equal(parsed.state.localGreetingLastShownAt, 1_700_000_000_000);
  // `anchor` is owned by the layout path, so it is neither adopted here nor reported as unknown.
  assert.deepEqual(parsed.unknown, {});

  const outcome = applyHostPatch(parsed.state, 0, { replySound: false });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.next.revision, 1, 'the first successful write upgrades the file');
  assert.equal(outcome.next.mode, 'half', 'the upgrade preserves the stored mode');
  assert.equal(outcome.next.hotkey, 'KeyV', 'the upgrade preserves the stored hotkey');
  assert.deepEqual(outcome.applied, ['replySound']);
});

/**
 * AC-01-3: a field written by a NEWER host must survive a write from this one. Dropping it would silently
 * destroy a setting the user cannot see here.
 */
test('RWR-10-01: unknown fields survive a write and the file round-trips', () => {
  const parsed = parseHostPreferences({ revision: 4, hotkey: null, futureFeature: { enabled: true }, mode: 'full' });
  assert.deepEqual(parsed.unknown, { futureFeature: { enabled: true } });
  const outcome = applyHostPatch(parsed.state, 4, { replySound: true });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const raw = serializeHostPreferences({ state: outcome.next, unknown: parsed.unknown }, { x: 1, y: 2 });
  const reparsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(reparsed.futureFeature, { enabled: true }, 'an unknown field is written back verbatim');
  assert.equal(reparsed.revision, 5);
  assert.equal(reparsed.hotkey, null, 'an explicit null hotkey is preserved, not turned into undefined');
});

test('RWR-10-01: a corrupt or non-object prefs file falls back to defaults instead of throwing', () => {
  for (const value of [null, undefined, 'not json', 42, [1, 2, 3]]) {
    const parsed = parseHostPreferences(value);
    assert.equal(parsed.state.revision, 0);
    assert.equal(parsed.state.mode, 'full');
    assert.equal(parsed.state.hotkey, null);
  }
  // A present but unusable revision is repaired on the next write rather than rejecting the file.
  const bad = parseHostPreferences({ revision: -3, width: 'wide', hotkey: 'NotAKey' });
  assert.equal(bad.state.revision, 0);
  assert.equal(bad.state.width, 360);
  assert.equal(bad.state.hotkey, null);
});

/** AC-01-1: stale revision and unsupported keys must be refused, never silently applied. */
test('RWR-10-01: stale revision, unknown keys and bad values are refused with a reason', () => {
  const current = { ...defaultHostPreferences(), revision: 7 };
  const stale = applyHostPatch(current, 6, { hotkey: 'KeyB' });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.code, 'stale_revision');

  const unknownKey = applyHostPatch(current, 7, { secretPath: 'C:/x' });
  assert.equal(unknownKey.ok, false);
  if (unknownKey.ok) return;
  assert.equal(unknownKey.code, 'invalid_request');

  const badKey = applyHostPatch(current, 7, { hotkey: 'Key!' });
  assert.equal(badKey.ok, false);
  const badMode = applyHostPatch(current, 7, { mode: 'three-quarter' });
  assert.equal(badMode.ok, false);
  const badWidth = applyHostPatch(current, 7, { preferredWidth: Number.NaN });
  assert.equal(badWidth.ok, false);
  const empty = applyHostPatch(current, 7, {});
  assert.equal(empty.ok, false);
  // A refused patch never advances the revision.
  assert.equal(current.revision, 7);
});

/** AC-01-1: display width is clamped to the frozen range, and an out-of-range request is not rejected. */
test('RWR-10-01: display width is clamped to the frozen 220..720 range', () => {
  const current = defaultHostPreferences();
  const tooBig = applyHostPatch(current, 0, { preferredWidth: 5000 });
  assert.equal(tooBig.ok, true);
  if (!tooBig.ok) return;
  assert.equal(tooBig.next.width, DISPLAY_MAX_WIDTH);
  const tooSmall = applyHostPatch(current, 0, { preferredWidth: 10 });
  assert.equal(tooSmall.ok, true);
  if (!tooSmall.ok) return;
  assert.equal(tooSmall.next.width, DISPLAY_MIN_WIDTH);
});

/**
 * AC-01-1: replay is resolved BEFORE the revision check. A retry after a lost response must return the
 * original receipt, not a spurious conflict against the write it already performed.
 */
test('RWR-10-01: the operation ledger replays a receipt and refuses a conflicting payload', () => {
  const ledger = new HostOperationLedger<{ revision: number }>(4);
  const payload = { expectedRevision: 0, patch: { replySound: false } };
  assert.equal(ledger.lookup('op-1', payload), null, 'a first attempt is not a replay');
  ledger.record('op-1', payload, { revision: 1 });
  assert.deepEqual(ledger.lookup('op-1', payload), { revision: 1 });
  // Key order must not change the signature, or a legitimate retry would look like a conflict.
  assert.deepEqual(ledger.lookup('op-1', { patch: { replySound: false }, expectedRevision: 0 }), { revision: 1 });
  assert.throws(() => ledger.lookup('op-1', { expectedRevision: 0, patch: { replySound: true } }),
    /操作编号已用于另一组设置/, 'the same operationId with a different payload is a conflict');
});

test('RWR-10-01: the operation ledger is bounded so a long session cannot grow it without limit', () => {
  const ledger = new HostOperationLedger<number>(3);
  for (let i = 0; i < 10; i++) ledger.record(`op-${i}`, { i }, i);
  assert.equal(ledger.size, 3);
  assert.equal(ledger.lookup('op-0', { i: 0 }), null, 'the oldest entry is evicted first');
  assert.equal(ledger.lookup('op-9', { i: 9 }), 9, 'the newest entry is retained');
});

/**
 * AC-01-2: the press-to-talk key is delivered by renderer key events, so the host must report
 * `window-only`. Claiming a system-global hotkey would be a lie the console would then repeat.
 */
test('RWR-10-01: the host reports the real hotkey registration level and real capabilities', () => {
  const caps = hostCapabilities({ windowAvailable: true, canPersist: true, filePicker: false });
  assert.equal(caps.hotkey, 'window-only');
  assert.equal(caps.display, true);
  assert.equal(caps.preferences, true);
  // RWR-10-04 adds the chooser; until then the host must not advertise it.
  assert.equal(caps.filePicker, false);
  const offline = hostCapabilities({ windowAvailable: false, canPersist: false, filePicker: false });
  assert.equal(offline.display, false);
  assert.equal(offline.preferences, false);
});

/** AC-01-1: the wire payload separates the user's intent from the screen-constrained result. */
test('RWR-10-01: the preferences payload separates preferredWidth from the fitted size', () => {
  const state = { ...defaultHostPreferences(), revision: 3, hotkey: 'Space', replySound: false };
  const display = { mode: 'half' as const, preferredWidth: 700, modelWidth: 420, modelHeight: 397, drawerHeight: 300 };
  const payload = toHostPreferencesPayload(state, display, hostCapabilities({ windowAvailable: true, canPersist: true, filePicker: false }));
  assert.equal(payload.apiVersion, DESKTOP_HOST_API_VERSION);
  assert.equal(payload.revision, 3);
  assert.equal(payload.hotkey, 'Space');
  assert.equal(payload.replySound, false);
  assert.equal(payload.display.preferredWidth, 700, 'the user intent is reported unchanged');
  assert.equal(payload.display.modelWidth, 420, 'the fitted width is a separate field');
  assert.equal(payload.display.mode, 'half');
});

/**
 * The host module is loaded directly by Electron (type-stripping), so it must stay import-free. Its
 * duplicated constants are checked here against the contract copy so they cannot drift apart.
 */
test('RWR-10-01: host constants match the contract and the host module has no relative imports', () => {
  const source = readFileSync(resolve(process.cwd(), 'desktop/electron/host-preferences.ts'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m,
    'a relative import would break either Electron type-stripping (.js) or the tsc build (.ts)');
  assert.equal(DESKTOP_HOST_API_VERSION, 1);
  // The frozen single hotkey set: host module, contract, renderer and Electron main must agree.
  const electronMain = readFileSync(resolve(process.cwd(), 'desktop/electron/main.mjs'), 'utf8');
  const electronPattern = /const validHotkey = code => code === null \|\| (\/\^.*?\/)\.test\(code\);/s.exec(electronMain);
  assert.ok(electronPattern, 'the Electron host still declares validHotkey');
  assert.equal(electronPattern[1], VALID_HOTKEY_PATTERN.toString(),
    'the Electron whitelist, the contract whitelist and the renderer whitelist must be the same pattern');
  const renderer = readFileSync(resolve(process.cwd(), 'desktop/press-to-talk.ts'), 'utf8');
  assert.ok(renderer.includes(VALID_HOTKEY_PATTERN.source), 'the renderer shares the same whitelist');
  assert.equal(isValidHotkey('KeyA'), true);
  assert.equal(isValidHotkey('Key!'), false);
  assert.equal(isValidHotkey(null), false);
});

test('RWR-10-01: the operation signature is stable across key order and distinguishes payloads', () => {
  assert.equal(operationSignature({ a: 1, b: 2 }), operationSignature({ b: 2, a: 1 }));
  assert.notEqual(operationSignature({ a: 1 }), operationSignature({ a: 2 }));
  assert.equal(operationSignature({ nested: { x: [1, 2] } }), operationSignature({ nested: { x: [1, 2] } }));
});

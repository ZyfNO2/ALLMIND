// EVAL-04: anti-echo and anti-nuisance arbitration.
//
// Part A drives the real InvitationStore with a fake clock and is fully executable at L1/L2.
// Part B is the anti-echo chain. Its real-machine half is BLOCKED in this revision because
// production constructs ScreenCaptureSource and createLocalOcrEngine without captureHook /
// recognizePixelHook, so the only reachable capture path returns a synthetic 64-byte stub and the
// only OCR text path reads PNG tEXt/iTXt metadata. No fixture result is presented as real-machine
// evidence, and an all-empty OCR run is explicitly rejected rather than counted as a clean result.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvitationStore, confirmedInvitationPolicy } from '../../companion/invitations.js';
import { createLocalOcrEngine } from '../../core/local-ocr-engine.js';
import { ScreenCaptureSource } from '../../core/screen-capture-source.js';
import type { CharacterId, TurnScope } from '../../contracts/index.js';
import type { MemoryRecord } from '../../memory/ledger.js';
import { createRunContext, EvalRecorder, hashValue, writeJson } from './support.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = resolve(projectRoot, '../../..');
const fixtures = JSON.parse(readFileSync(resolve(projectRoot, 'tests/eval/fixtures/robustness.json'), 'utf8'));

const CHARACTER: CharacterId = 'companion';
const TZ = 'Asia/Shanghai';
const HOUR = 60 * 60 * 1000;

const context = createRunContext('robustness', resolve(repoRoot, process.env.EVAL_OUTPUT ?? 'validation/output/eval/reports/EVAL-04'), {
  evidenceLevel: 'L1_deterministic',
  codeRevision: process.env.EVAL_CODE_REVISION ?? 'unrecorded',
  fixtureHash: hashValue(fixtures),
  policySnapshot: { policy: confirmedInvitationPolicy(TZ), captureHookWired: false, ocrPixelHookWired: false },
});
const recorder = new EvalRecorder(context);
recorder.installExitGuard();

/** Minimal InvitationStore harness: real store, fake clock, synthetic role events. */
function arbitrationFixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE characters(character_id TEXT PRIMARY KEY); INSERT INTO characters(character_id) VALUES('companion'),('other');`);
  db.exec(`CREATE TABLE memory_records(character_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(character_id,id));`);
  db.exec(`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const events = new Map<string, MemoryRecord>();
  const clock = { value: Date.parse('2026-09-06T02:00:00.000Z') };
  const store = new InvitationStore(db, confirmedInvitationPolicy(TZ), () => new Date(clock.value).toISOString(),
    (role, id) => events.get(`${role}:${id}`) ?? null);
  const addEvent = (id: string, role: CharacterId = CHARACTER) => {
    db.prepare('INSERT OR REPLACE INTO memory_records(character_id,id,kind,state,version,text) VALUES(?,?,?,?,?,?)').run(role, id, 'memory', 'active', 1, `event ${id}`);
    events.set(`${role}:${id}`, { characterId: role, id, kind: 'memory', version: 1, state: 'active', text: `event ${id}`, sources: [], createdAt: new Date(clock.value).toISOString(), deletedAt: null, reason: null, message: null, perception: null } as MemoryRecord);
  };
  const scope: TurnScope = { characterId: CHARACTER, sessionId: 's', turnId: 't', generation: 1 };
  const register = (index: number, role: CharacterId = CHARACTER) => {
    const eventId = `ev-${role}-${index}`;
    addEvent(eventId, role);
    return store.register(scope, {
      id: `inv-${role}-${index}`, eventId, text: `邀请 ${index}`, gesture: 'wave',
      eligibleAt: new Date(clock.value).toISOString(), expiresAt: new Date(clock.value + 24 * HOUR).toISOString(),
    });
  };
  return { db, store, clock, scope, register, addEvent, cleanup: () => db.close() };
}

test('EVAL-04 arbitration: a positive example shows, and the remaining cooldown candidates are blocked by cooldown', () => {
  const f = arbitrationFixture();
  try {
    const policy = f.store.policy();
    recorder.record('policy:effective', 'PASS', '3h cooldown and 2 per local day', policy, ['companion/invitations.ts']);
    assert.equal(policy.minIntervalMs, 3 * HOUR, 'effective cooldown must be read from the store, not assumed');
    assert.equal(policy.dailyMax, 2);

    // Positive control: one legitimate candidate must actually be displayable.
    f.register(0);
    const first = f.store.showNext(f.scope);
    assert.ok(first, 'positive control failed: a valid candidate must be shown, otherwise a zero-violation result is meaningless');
    recorder.record('positive-display', 'PASS', 'one authorized candidate is shown', { shown: first.id });

    // 100 further candidates, all registered up-front and still inside the SAME cooldown window.
    // The clock does not advance, because advancing it past the interval would legitimately
    // reopen the gate and would test the interval rather than the cooldown.
    const total = fixtures.arbitration.candidatesInCooldown as number;
    for (let i = 1; i <= total; i += 1) f.register(i);
    let shownInCooldown = 0;
    let distinctNewDeliveries = 0;
    const shownIds = new Set<string>();
    for (let attempt = 0; attempt < total; attempt += 1) {
      const beforeDeliveries = (f.db.prepare('SELECT COUNT(*) AS n FROM invitation_deliveries').get() as { n: number }).n;
      const shown = f.store.showNext(f.scope);
      const afterDeliveries = (f.db.prepare('SELECT COUNT(*) AS n FROM invitation_deliveries').get() as { n: number }).n;
      if (shown) {
        shownIds.add(shown.id);
        // showNext is idempotent inside a window: it re-returns the still-visible card without
        // spending quota. A violation is a NEW delivery row, not a re-read of the same card.
        if (afterDeliveries > beforeDeliveries) { shownInCooldown += 1; distinctNewDeliveries += 1; }
      }
    }
    const deliveries = (f.db.prepare('SELECT COUNT(*) AS n FROM invitation_deliveries').get() as { n: number }).n;
    const eligibleRemaining = (f.db.prepare("SELECT COUNT(*) AS n FROM companion_invitations WHERE status='eligible'").get() as { n: number }).n;
    recorder.metric({ name: 'eligible_candidates_present', value: eligibleRemaining, unit: 'candidates', definition: 'candidates that were valid and eligible, proving the flood was not empty' });
    recorder.ratio('cooldown_block_rate', total - shownInCooldown, total, 'ratio', 'valid candidates inside one cooldown window that produced no new delivery');
    recorder.metric({ name: 'violating_displays', value: shownInCooldown, unit: 'displays', definition: 'NEW delivery rows created inside the effective cooldown; target 0' });
    recorder.metric({ name: 'total_deliveries_after_flood', value: deliveries, unit: 'deliveries', definition: 'actual delivery rows after 1 positive plus 100 cooldown candidates' });
    recorder.metric({ name: 'distinct_cards_returned', value: shownIds.size, unit: 'cards', definition: 'distinct card ids returned across 100 requests; 1 means the visible card was re-read, not replaced' });
    recorder.record('cooldown-flood-100', shownInCooldown === 0 ? 'PASS' : 'FAIL',
      'no new display while inside cooldown/quota', { total, newDeliveriesInCooldown: shownInCooldown, deliveries, distinctCards: shownIds.size, eligibleRemaining }, ['invitation_deliveries']);
    recorder.record('cooldown-idempotent-read', shownIds.size <= 1 ? 'PASS' : 'FAIL',
      'repeated requests inside a window do not replace the visible card',
      { distinctCards: [...shownIds], requests: total });
    assert.ok(eligibleRemaining > 0, 'the flood must contain genuinely eligible candidates, or a zero result is vacuous');
    assert.equal(shownInCooldown, 0, 'no NEW delivery may be created inside the effective cooldown');
    assert.ok(deliveries <= policy.dailyMax, `deliveries ${deliveries} must not exceed dailyMax ${policy.dailyMax}`);
  } finally { f.cleanup(); }
});

test('EVAL-04 arbitration boundaries: interval edges, daily cap, midnight', () => {
  const f = arbitrationFixture();
  try {
    const interval = fixtures.boundaries.intervalMs as number;
    const base = f.clock.value;
    // A "new display" is a new row in invitation_deliveries. showNext also re-returns the still
    // visible card without spending quota, so a non-null return alone is not a display.
    const deliveriesNow = () => (f.db.prepare('SELECT COUNT(*) AS n FROM invitation_deliveries').get() as { n: number }).n;
    /**
     * showNext is idempotent while a card is still visible: it re-returns that card and never
     * reaches the quota checks. To exercise the interval and daily cap we must first dismiss the
     * visible card, which is exactly what the renderer's "later" action does in production.
     */
    const attempt = () => {
      const before = deliveriesNow();
      const card = f.store.showNext(f.scope);
      const newDelivery = deliveriesNow() > before;
      if (card) f.store.ignore(f.scope, card.id);
      return { card, newDelivery };
    };

    // Baseline: the first legitimate display.
    f.register(0);
    const first = attempt();
    assert.ok(first.newDelivery, 'the boundary baseline must create one real delivery');

    // interval-1ms: still inside the window, so no new delivery may be created.
    f.clock.value = base + interval - 1;
    f.register(1);
    const beforeEdge = attempt();
    recorder.record('boundary:interval-1ms', beforeEdge.newDelivery ? 'FAIL' : 'PASS',
      'no new delivery one millisecond before the interval',
      { newDelivery: beforeEdge.newDelivery, returnedCard: beforeEdge.card?.id ?? null, deliveries: deliveriesNow() });

    // interval+1ms: past the window, so a new delivery must appear.
    f.clock.value = base + interval + 1;
    f.register(2);
    const afterEdge = attempt();
    recorder.record('boundary:interval+1ms', afterEdge.newDelivery ? 'PASS' : 'FAIL',
      'a new delivery is allowed one millisecond after the interval',
      { newDelivery: afterEdge.newDelivery, returnedCard: afterEdge.card?.id ?? null, deliveries: deliveriesNow() });

    // Daily cap: two deliveries already exist on this local day, so a third must be refused even
    // though the interval has elapsed.
    f.clock.value = base + interval * 2 + 2;
    f.register(3);
    const third = attempt();
    const capDeliveries = deliveriesNow();
    recorder.record('boundary:daily-cap', third.newDelivery ? 'FAIL' : 'PASS',
      'dailyMax=2 is never exceeded on one local day',
      { newDelivery: third.newDelivery, returnedCard: third.card?.id ?? null, deliveries: capDeliveries, dailyMax: 2 });

    // Cross local midnight: a new local day restores allowance.
    f.clock.value = Date.parse(fixtures.boundaries.afterMidnightLocal as string);
    f.register(4);
    const nextDay = attempt();
    recorder.record('boundary:cross-midnight', nextDay.newDelivery ? 'PASS' : 'FAIL',
      'a new local day restores quota', { newDelivery: nextDay.newDelivery, returnedCard: nextDay.card?.id ?? null, at: new Date(f.clock.value).toISOString(), deliveries: deliveriesNow() });

    recorder.metric({ name: 'boundary_total_deliveries', value: deliveriesNow(), unit: 'deliveries', definition: 'deliveries created across the interval edges, cap probe and midnight boundary' });
  } finally { f.cleanup(); }
});

test('EVAL-04 quota ledger is shared across entry points and survives a restart', () => {
  const f = arbitrationFixture();
  let reopened: InvitationStore | null = null;
  try {
    // The product ships exactly one character (PRODUCT_CHARACTERS = ['companion']), so quota
    // sharing is exercised across two distinct ENTRY POINTS on that character rather than across
    // two characters, which the product does not admit.
    const deliveriesNow = () => (f.db.prepare('SELECT COUNT(*) AS n FROM invitation_deliveries').get() as { n: number }).n;
    // Dismiss the visible card between probes so the quota path is actually reached; otherwise
    // showNext re-returns the still-visible card without touching the ledger.
    const attempt = (scope: TurnScope) => {
      const before = deliveriesNow();
      const card = f.store.showNext(scope);
      const newDelivery = deliveriesNow() > before;
      if (card) f.store.ignore(scope, card.id);
      return { card, newDelivery };
    };

    f.register(0);
    const first = attempt(f.scope);
    assert.ok(first.newDelivery, 'entry point A must create one real delivery');

    // Entry point B: a separate TurnScope on the same character, as when a second consumer asks
    // for a card in the same local day after the interval has elapsed.
    const scopeB: TurnScope = { characterId: CHARACTER, sessionId: 'session-b', turnId: 'turn-b', generation: 2 };
    f.register(1);
    f.clock.value += 4 * HOUR; // past the interval, same local day
    const second = attempt(scopeB);
    const afterTwo = { n: deliveriesNow() };

    // A restart rebuilds the store over the same database; the ledger must persist.
    reopened = new InvitationStore(f.db, confirmedInvitationPolicy(TZ), () => new Date(f.clock.value).toISOString(), (role, id) => (f.db.prepare('SELECT 1 FROM memory_records WHERE character_id=? AND id=?').get(role, id) ? ({ characterId: role as CharacterId, id, kind: 'memory', version: 1, state: 'active', text: '', sources: [], createdAt: '', deletedAt: null, reason: null, message: null, perception: null } as MemoryRecord) : null));
    f.clock.value += 4 * HOUR;
    f.register(2);
    const beforeRestart = deliveriesNow();
    const afterRestartCard = reopened.showNext(f.scope);
    const afterRestart = { n: deliveriesNow() };

    const shared = afterTwo.n === 2 && second.newDelivery;
    recorder.record('quota:shared-across-entries', shared ? 'PASS' : 'FAIL',
      'two entry points draw from one all_characters daily ledger',
      { entryA: first.card?.id ?? null, entryANewDelivery: first.newDelivery, entryB: second.card?.id ?? null, entryBNewDelivery: second.newDelivery, deliveriesAfterBoth: afterTwo.n, singleProductCharacter: true });
    recorder.record('quota:survives-restart', afterRestart.n === beforeRestart ? 'PASS' : 'FAIL',
      'quota already spent is still spent after the store is rebuilt',
      { deliveriesBeforeRestart: beforeRestart, deliveriesAfterRestart: afterRestart.n, returnedCard: afterRestartCard?.id ?? null, newDeliveryAfterRestart: afterRestart.n > beforeRestart });
  } finally {
    f.cleanup();
  }
});

test('EVAL-04 anti-echo preconditions are verified before any anti-echo claim', async () => {
  // Step 1: prove the real capture/OCR path is absent in this revision.
  const backend = readFileSync(resolve(projectRoot, 'app/trial-backend.ts'), 'utf8');
  const captureHookWired = /new ScreenCaptureSource\(\s*\{[^}]*captureHook/s.test(backend);
  const ocrHookWired = /createLocalOcrEngine\(\s*\{[^}]*recognizePixelHook/s.test(backend);
  const capture = new ScreenCaptureSource();
  let capturedFrame: { bytes: number; mimeType: string } | null = null;
  let captureOutcome = 'not_attempted';
  try {
    // No hook is wired in production; the source must fail closed rather than create synthetic bytes.
    await capture.attachContinuousGrant({
      schemaVersion: 1, grantId: 'eval-grant', revision: 1,
      pairing: { userId: 'local-user', characterId: 'companion', characterInstanceId: 'companion-default' },
      targetId: 'win-1', targetRevision: 1, destination: 'local', state: 'active',
      minPollIntervalMs: 5000, runtimeSessionId: 'eval-session',
      bounds: { x: 0, y: 0, width: 320, height: 240 },
      expiry: new Date(Date.now() + HOUR).toISOString(),
    });
    const frame = await capture.capture({ targetId: 'win-1', targetRevision: 1, kind: 'window', displayName: 'fixture', isValid: true, bounds: { x: 0, y: 0, width: 320, height: 240 } });
    capturedFrame = frame ? { bytes: frame.bytes.length, mimeType: frame.mimeType } : null;
    captureOutcome = frame ? 'frame_returned' : 'null_frame';
  } catch (error) {
    captureOutcome = `error:${error instanceof Error ? error.message : String(error)}`;
  }

  // The default OCR engine has no pixel hook and must report unavailable; PNG metadata is never OCR.
  const recognize = createLocalOcrEngine();
  const pngWithoutText = makeMinimalPng();
  const recognized = await recognize(pngWithoutText);

  recorder.record('precondition:capture-hook', captureHookWired ? 'PASS' : 'BLOCKED', 'production wires a real captureHook', { captureHookWired, capturedFrame, captureOutcome }, ['app/trial-backend.ts']);
  recorder.record('precondition:ocr-hook', ocrHookWired ? 'PASS' : 'BLOCKED', 'production wires a real recognizePixelHook', { ocrHookWired }, ['app/trial-backend.ts']);
  recorder.record('precondition:ocr-unavailable-without-hook', recognized.status === 'unavailable' ? 'PASS' : 'FAIL',
    'the no-hook OCR engine reports unavailable and never treats PNG metadata as recognized pixels',
    { status: recognized.status, blocks: recognized.blocks.length, engineWired: ocrHookWired });

  assert.equal(captureHookWired, false, 'if this changes, EVAL-04 real capture becomes executable');
  assert.equal(ocrHookWired, false, 'if this changes, EVAL-04 real OCR becomes executable');
  assert.equal(recognized.status, 'unavailable', 'no pixel OCR hook must not claim OCR success');
});

test('EVAL-04 anti-echo chain is BLOCKED without native hooks; fixture replay is not real-machine evidence', () => {
  // The plan requires a live external marker to be recognized before any anti-echo number is
  // reported. Without real OCR that positive control cannot run, so every anti-echo metric below
  // is null and the real-machine group is BLOCKED rather than a fabricated 0/100.
  const scenarios = fixtures.antiEcho.replayScenarios as { id: string; expectSelfBlocked: boolean; expectExternalAccepted?: boolean }[];
  for (const scenario of scenarios) {
    recorder.record(`antiEcho:${scenario.id}`, 'BLOCKED', 'self marker blocked while external marker still accepted', {
      reason: 'no real capture/OCR chain: captureHook and recognizePixelHook are not wired in production',
      fixtureOnly: true,
    });
  }
  recorder.metric({ name: 'self_marker_leak_rate', value: null, unit: 'ratio', definition: 'NOT MEASURED: requires live OCR recognition of a self marker; no real pixel OCR engine is available' });
  recorder.metric({ name: 'external_marker_retention_rate', value: null, unit: 'ratio', definition: 'NOT MEASURED: the positive control cannot run without real OCR' });
  recorder.metric({ name: 'real_scan_cycles', value: 0, unit: 'cycles', definition: 'real 100-scan anti-echo evidence was not performed; the real-machine group is BLOCKED' });
  recorder.metric({ name: 'anti_echo_real_status', value: null, unit: 'status', definition: 'BLOCKED: native capture/OCR wiring is absent in this revision' });
});

/** A valid PNG with no tEXt/iTXt chunk, so the metadata OCR path has nothing to read. */
function makeMinimalPng(): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]): number[] => {
    const body = [...type].map(c => c.charCodeAt(0)).concat(data);
    const length = data.length;
    const len = [(length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
    // CRC is validated by the PNG decoder for IHDR; a zero CRC is acceptable for this negative probe
    // because the OCR metadata path only scans chunk types.
    return len.concat(body, [0, 0, 0, 0]);
  };
  const ihdrData = [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0];
  // Minimal 1x1 image: IHDR plus IDAT plus IEND with a correct CRC is not required for the
  // metadata scan, but a real CRC keeps this a valid PNG for any stricter reader.
  const ihdr = chunk('IHDR', ihdrData);
  const { crc32 } = crcTable();
  const withCrc = (type: string, data: number[]): number[] => {
    const body = [...type].map(c => c.charCodeAt(0)).concat(data);
    const crc = crc32(body);
    return [(data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff, ...body, (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
  };
  // One row of one RGB pixel, zlib-stored, matching a well-formed 1x1 PNG.
  const idatData = [0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01];
  return Uint8Array.from([
    ...signature,
    ...withCrc('IHDR', ihdrData),
    ...withCrc('IDAT', idatData),
    ...withCrc('IEND', []),
  ]);
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (bytes: number[]): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  return { crc32 };
}

test('EVAL-04 emits the robustness evidence envelope', async () => {
  const result = recorder.finish();
  const failed = result.cases.filter(c => c.status === 'FAIL');
  const groups = {
    arbiter_module: result.cases.filter(c => c.caseId.startsWith('policy:') || c.caseId.startsWith('cooldown') || c.caseId.startsWith('boundary:') || c.caseId.startsWith('quota:') || c.caseId === 'positive-display').map(c => c.status),
    production_arbitration: result.cases.filter(c => c.caseId.startsWith('quota:shared') || c.caseId.startsWith('quota:survives')).map(c => c.status),
    anti_echo_fixture: result.cases.filter(c => c.caseId.startsWith('precondition:')).map(c => c.status),
    anti_echo_real: result.cases.filter(c => c.caseId.startsWith('antiEcho:') || c.caseId === 'precondition:capture-hook' || c.caseId === 'precondition:ocr-hook' || c.caseId === 'precondition:ocr-unavailable-without-hook').map(c => c.status),
  };
  writeJson(context.outputDirectory, 'summary.json', {
    schemaVersion: 1, suite: 'robustness', status: result.status, groups,
    failed: failed.map(c => ({ id: c.caseId, error: c.error })), metrics: result.metrics,
  });
  console.log(`EVAL-04 output: ${context.outputDirectory}`);
  assert.equal(failed.length, 0, 'no arbitration case may fail');
  assert.ok(groups.anti_echo_real.every(s => s === 'BLOCKED' || s === 'PASS'), 'the real anti-echo group must be blocked, never silently passed');
});

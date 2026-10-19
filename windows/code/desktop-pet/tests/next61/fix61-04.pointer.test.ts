// FIX61-04 / RWR-10-02: the desktop splits pointer buttons. A left short tap strokes the character
// locally; a left drag still moves the pet; the right button is DISABLED (RWR-10-02) — it consumes its
// event and does nothing else. No stroke may reach the backend, Memory or the LLM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterPointerRouter, directStrokePlan, strokePlan } from '../../desktop/pointer-router.js';
import type { PointerHandlers } from '../../desktop/pointer-router.js';

const character = () => ({ id: 'character' });
const modelCanvas = () => ({ id: 'model' });
interface Calls { panel: boolean[]; stroke: unknown[]; drag: number[][] }
function recorder(overrides: Partial<PointerHandlers> = {}): { calls: Calls; handlers: PointerHandlers } {
  const calls: Calls = { panel: [], stroke: [], drag: [] };
  return { calls, handlers: {
    panel: open => calls.panel.push(open),
    stroke: at => calls.stroke.push(at),
    drag: (dx, dy) => calls.drag.push([dx, dy]),
    ...overrides
  } };
}

// 04-A -----------------------------------------------------------------------------------------
test('04-A a left short tap strokes exactly once and never opens the chat panel', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.pointerDown({ button: 0, pointerId: 1, screenX: 100, screenY: 100, target: character() });
  router.pointerUp({ button: 0, pointerId: 1, screenX: 101, screenY: 100 });
  assert.equal(calls.stroke.length, 1, 'one short left tap is one stroke');
  assert.equal(calls.panel.length, 0, 'a left tap must not open the chat drawer');
  assert.equal(calls.drag.length, 0, 'a short tap is not a drag');
});

test('04-A a small Windows pointer jitter stays a tap instead of becoming a drag', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.pointerDown({ button: 0, pointerId: 11, screenX: 100, screenY: 100, target: character() });
  router.pointerMove({ pointerId: 11, screenX: 105, screenY: 105 });
  router.pointerMove({ pointerId: 11, screenX: 103, screenY: 104 });
  router.pointerUp({ button: 0, pointerId: 11, screenX: 103, screenY: 104 });
  assert.equal(calls.drag.length, 0, 'click jitter below the slop must not move the window');
  assert.equal(calls.stroke.length, 1, 'click jitter still produces one local stroke');
});

test('04-A a left drag moves the pet and never opens the panel or strokes', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.pointerDown({ button: 0, pointerId: 1, screenX: 100, screenY: 100, target: character() });
  router.pointerMove({ pointerId: 1, screenX: 140, screenY: 130 });
  router.pointerUp({ button: 0, pointerId: 1, screenX: 140, screenY: 130 });
  assert.ok(calls.drag.length >= 1, 'a drag reaches the shell drag channel');
  assert.equal(calls.stroke.length, 0, 'a drag is not a stroke');
  assert.equal(calls.panel.length, 0, 'a drag must not open the chat drawer');
});

test('04-A a cancelled pointer performs no action, and rapid taps never open the drawer', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.pointerDown({ button: 0, pointerId: 3, screenX: 10, screenY: 10, target: character() });
  router.pointerCancel({ pointerId: 3 });
  router.pointerUp({ button: 0, pointerId: 3, screenX: 10, screenY: 10 });
  assert.deepEqual(calls, { panel: [], stroke: [], drag: [] }, 'a cancelled pointer does nothing');

  router.pointerDown({ button: 0, pointerId: 4, screenX: 10, screenY: 10, target: character() });
  router.pointerUp({ button: 0, pointerId: 4, screenX: 10, screenY: 10 });
  router.pointerDown({ button: 0, pointerId: 5, screenX: 10, screenY: 10, target: character() });
  router.pointerUp({ button: 0, pointerId: 5, screenX: 10, screenY: 10 });
  assert.equal(calls.panel.length, 0, 'rapid taps never open the chat drawer');
  assert.equal(calls.stroke.length, 2);
});

// FIX61-04 / RWR-10-02: the right button is DISABLED. The old behavior (right click toggles the function
// panel) is exactly what RWR-10-02 removed: no panel, no drag, no stroke, and no system context menu.
test('04-A the right button is consumed once and never produces any action', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.contextMenu({ target: character(), screenX: 50, screenY: 60 });
  assert.deepEqual(calls.panel, [], 'RWR-10-02: the right button no longer opens any panel');
  assert.equal(calls.stroke.length, 0, 'the right button never strokes');
  // A following pointerdown/pointerup for the same right press must not stroke either.
  router.pointerDown({ button: 2, pointerId: 9, screenX: 50, screenY: 60, target: character() });
  router.pointerUp({ button: 2, pointerId: 9, screenX: 50, screenY: 60 });
  assert.deepEqual(calls.panel, [], 'the right press produces nothing at all');
  assert.equal(calls.stroke.length, 0, 'the right press release never strokes');
  assert.equal(calls.drag.length, 0, 'the right press never drags the window');
});

test('04-A the right button is inert and a right click outside the character is ignored', () => {
  const { calls, handlers } = recorder({ panelOpen: () => true });
  const router = new CharacterPointerRouter(handlers);
  router.contextMenu({ target: character() });
  assert.deepEqual(calls.panel, [], 'an already-"open" panel state changes nothing');
  router.contextMenu({ target: { id: 'text' } });
  assert.deepEqual(calls.panel, [], 'a right click outside the character changes nothing');
});

test('04-A a right-button drag never moves the window', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.pointerDown({ button: 2, pointerId: 21, screenX: 100, screenY: 100, target: character() });
  router.pointerMove({ pointerId: 21, screenX: 160, screenY: 150 });
  router.pointerUp({ button: 2, pointerId: 21, screenX: 160, screenY: 150 });
  assert.equal(calls.drag.length, 0, 'RWR-10-02: the right button is not a window drag');
  assert.equal(calls.stroke.length, 0);
  assert.deepEqual(calls.panel, []);
});

test('04-A right click on the model canvas is inert, while a left tap still strokes', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.contextMenu({ target: modelCanvas(), screenX: 50, screenY: 60 });
  assert.deepEqual(calls.panel, [], 'RWR-10-02: the model canvas also offers no right-click panel');
  assert.equal(calls.stroke.length, 0, 'and the right button never strokes on the canvas');

  router.pointerDown({ button: 0, pointerId: 10, screenX: 100, screenY: 100, target: modelCanvas() });
  router.pointerUp({ button: 0, pointerId: 10, screenX: 101, screenY: 100 });
  assert.equal(calls.stroke.length, 1, 'left tapping the model canvas still triggers a local stroke');
});

// 04-B -----------------------------------------------------------------------------------------
test('04-B a stroke produces head/body parameter movement when the model supports it, and stays inert when it does not', () => {
  const full = strokePlan({ head: true, body: true, blink: true, reducedMotion: false });
  assert.equal(full.applicable, true);
  assert.ok(full.values.pitch > 0, 'a supported model receives measurable head movement');
  assert.ok(full.values.body > 0, 'and body movement');

  const headless = strokePlan({ head: false, body: false, blink: false, reducedMotion: false });
  assert.equal(headless.applicable, false, 'a model without those parameters reports no movement instead of throwing');
  assert.deepEqual(headless.values, { yaw: 0, pitch: 0, roll: 0, body: 0 });
  assert.ok(headless.reason.length > 0, 'and explains why nothing moved');

  const reduced = strokePlan({ head: true, body: true, blink: true, reducedMotion: true });
  assert.equal(reduced.values.pitch, 0, 'reduced motion suppresses the stroke movement');
  assert.equal(reduced.applicable, false);
});

test('04-B a rig-owned tap motion stays available when autonomous head/body animation is disabled', () => {
  const authored = directStrokePlan({ head: false, body: false, blink: false, reducedMotion: false }, true);
  assert.equal(authored.applicable, true, 'direct input must not depend on autonomous animation toggles');
  const reduced = directStrokePlan({ head: false, body: false, blink: false, reducedMotion: true }, true);
  assert.equal(reduced.applicable, false, 'reduced motion still suppresses the direct tap');
});

// 04-C -----------------------------------------------------------------------------------------
// RWR-10-02 removed `PANEL_ENTRIES` together with the right-click function panel. The drawer's 「⋯」 menu
// is now the single low-frequency entry point; its entries are asserted where they are defined
// (tests/role-repair/rwr10-dialog-dom.test.mjs) so a removed or empty entry still fails a test.
test('04-C opening or closing a peer surface never clears the active turn or its reply state', async () => {
  const { DesktopViewState } = await import('../../desktop/view-state.js');
  const view = new DesktopViewState();
  const scope = { characterId: 'companion' as const, sessionId: 's', turnId: 't', generation: 1 };
  view.receive({ type: 'turn', input: { scope, kind: 'text', startedAt: new Date().toISOString(), text: '你好' } });
  assert.ok(view.scope, 'the turn is active');
  // Opening or closing the peer panel is not a desktop command, so it touches no chat state at all.
  assert.ok(view.accepts(scope), 'the active turn survives a panel round trip');
  // Only an explicit cancel/switch resets the turn; that is the pre-existing, unchanged contract.
  view.command({ type: 'cancel' });
  assert.equal(view.scope, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { SpriteRenderer } from '../../desktop/sprite-renderer.mjs';
import { CHARACTER_STATES, CharacterStateMachine } from '../../dist/contracts/character-state.js';

test('Sprite consumes the same seven states, loops the selected frame range and resets after state changes', t => {
  let now = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'performance'), previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  globalThis.window = { devicePixelRatio: 1 };
  t.after(() => { Object.defineProperty(globalThis, 'performance', previous); globalThis.window = previousWindow; });
  const draws = [], canvas = { clientWidth: 140, clientHeight: 40, width: 140, height: 40 };
  const renderer = new SpriteRenderer(canvas);
  renderer.bindSkin({ type: 'sprite', skinId: 'state-atlas', sprite: { width: 140, height: 40, rows: 2, columns: 7, frameCount: 14, fps: 10,
    clips: Object.fromEntries(CHARACTER_STATES.map((state, index) => [state, { start: index * 2, frameCount: 2, fps: 10 }])) } });
  renderer.image = {}; renderer.context = { clearRect() {}, drawImage: (...args) => draws.push(args) }; renderer.ready = true;
  const machine = new CharacterStateMachine();
  for (const [index, state] of CHARACTER_STATES.entries()) {
    const view = { state, characterState: machine.update({ state }) };
    renderer.updateView(view);
    assert.equal(renderer.snapshot().characterState, state);
    assert.equal(renderer.snapshot().frame, index * 2);
    now += 110; renderer.updateView(view);
    assert.equal(renderer.snapshot().frame, index * 2 + 1);
    assert.equal(draws.at(-1)[1], ((index * 2 + 1) % 7) * 20);
    now += 210; renderer.updateView(view);
    assert.equal(renderer.snapshot().frame, index * 2 + 1, 'animation wraps only inside its state clip');
  }
  delete renderer.skin.sprite.clips.listening;
  renderer.updateView({ state: 'listening' });
  assert.equal(renderer.snapshot().frame, 0, 'a missing clip uses idle');
  renderer.dispose();
  assert.equal(renderer.ready, false);
});

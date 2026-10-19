import test from 'node:test';
import assert from 'node:assert/strict';
import { companionBubblePosition } from '../../desktop/companion-layout.mjs';

test('companion bubble chooses head-side space and clamps inside narrow or edge viewports', () => {
  const bubble = { width: 280, height: 100 };
  for (const [viewport, character, side] of [
    [{ width: 1000, height: 800 }, { left: 600, right: 900, top: 150, bottom: 650, width: 300, height: 500 }, 'left'],
    [{ width: 1000, height: 800 }, { left: 10, right: 310, top: 150, bottom: 650, width: 300, height: 500 }, 'right'],
    [{ width: 310, height: 370 }, { left: 5, right: 305, top: 0, bottom: 340, width: 300, height: 340 }, 'below'],
    [{ width: 310, height: 370 }, { left: 5, right: 305, top: -100, bottom: 240, width: 300, height: 340 }, 'below'],
  ]) {
    const result = companionBubblePosition(viewport, character, bubble);
    assert.equal(result.side, side); assert.ok(result.left >= 8); assert.ok(result.top >= 8);
    assert.ok(result.left + bubble.width <= viewport.width - 8); assert.ok(result.top + bubble.height <= viewport.height - 8);
  }
});

/** Viewport coordinates. The host already fits its window to the current monitor's work area. */
export function companionBubblePosition(viewport, character, bubble) {
  const margin = 8, gap = 12;
  const clamp = (value, size, limit) => Math.max(margin, Math.min(value, limit - size - margin));
  const head = character.top + character.height * .22;
  const choices = [
    { left: character.left - bubble.width - gap, top: head, side: 'left' },
    { left: character.right + gap, top: head, side: 'right' },
    { left: character.left + (character.width - bubble.width) / 2, top: character.top - bubble.height - gap, side: 'above' },
  ];
  const fits = choices.find(p => p.left >= margin && p.top >= margin && p.left + bubble.width <= viewport.width - margin && p.top + bubble.height <= viewport.height - margin);
  // A collapsed pet window may have no side space. Use its lower reserved area instead of the face.
  const chosen = fits ?? { left: character.left + (character.width - bubble.width) / 2, top: character.bottom - bubble.height + 24, side: 'below' };
  return { left: clamp(chosen.left, bubble.width, viewport.width), top: clamp(chosen.top, bubble.height, viewport.height), side: chosen.side };
}

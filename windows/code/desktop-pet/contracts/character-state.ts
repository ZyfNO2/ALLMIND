export const CHARACTER_STATES = ['idle', 'listening', 'thinking', 'speaking', 'working', 'happy', 'sleeping'] as const;
export type CharacterState = typeof CHARACTER_STATES[number];
export function resolveCharacterState(view: { state?: string; expression?: { emotion?: string } }, interactionState = view.state, working = false): CharacterState {
  if (interactionState === 'listening' || interactionState === 'thinking' || interactionState === 'speaking') return interactionState;
  if (interactionState === 'sleeping') return 'sleeping';
  if (working || interactionState === 'working') return 'working';
  if (interactionState === 'happy' || view.expression?.emotion === 'happy') return 'happy';
  return 'idle';
}
/** The shell owns one state; render adapters consume it and never start a dialogue turn. */
export class CharacterStateMachine {
  state: CharacterState = 'idle';
  update(view: { state?: string; expression?: { emotion?: string } }, interactionState = view.state, working = false): CharacterState {
    return this.state = resolveCharacterState(view, interactionState, working);
  }
}

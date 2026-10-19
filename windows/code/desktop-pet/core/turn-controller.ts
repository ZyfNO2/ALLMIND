import { COMPANION_ID, isCharacterId } from '../contracts/character.js';
import { randomUUID } from 'node:crypto';
import type { CharacterId, ExpressionIntent, InputKind, PetPresentation, PlaybackEvent, TurnInput, TurnScope } from '../contracts/index.js';

export function sameScope(a: TurnScope, b: TurnScope): boolean {
  return a.characterId === b.characterId && a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
}
export class TurnController {
  private generation = 0;
  private sessionId = randomUUID();
  // RWR-02 (D1): one DeskPet process runs exactly ONE active character. The registry owns creation and
  // records the restart-scoped selection (`savedCharacterId`/`effectiveCharacterId`); the turn layer
  // never reads the registry itself. So the RUNNING role enters here once, at composition time, and
  // stays fixed for the lifetime of this controller:
  //
  //   * omitted (default COMPANION_ID) = today's behavior for every existing caller, including the
  //     production composition roots on a fresh (single-role) registry;
  //   * a composition root that boots with a registry whose `effectiveCharacterId` differs passes it
  //     in — the ONLY supported way a second role ever runs a turn, and only after a restart.
  //
  // Binding at construction (not a setter, not per-submit) is what keeps "browsing a character can
  // never retag an in-flight turn" true. TypeScript's `readonly` is compile-time only, so the field is
  // installed with defineProperty(writable:false, configurable:false): switching means a NEW controller
  // on the next start, and a stale `accepts()` can never validate across roles.
  private readonly characterId!: CharacterId;
  constructor(characterId?: CharacterId) {
    let bound: CharacterId;
    if (characterId === undefined) bound = COMPANION_ID;
    else {
      if (!isCharacterId(characterId)) throw new Error('Invalid characterId for TurnController');
      bound = characterId;
    }
    Object.defineProperty(this, 'characterId', { value: bound, writable: false, configurable: false, enumerable: true });
  }
  private active: {input: TurnInput; controller: AbortController} | null = null;
  private presentation: PetPresentation | null = null;
  private playbackStarted = false;
  identity(): { characterId: CharacterId; sessionId: string } { return { characterId: this.characterId, sessionId: this.sessionId }; }
  get currentGeneration(): number { return this.generation; }
  begin(kind: InputKind, text?: string): {input: TurnInput; signal: AbortSignal} {
    this.cancel();
    const scope = Object.freeze({characterId: this.characterId, sessionId: this.sessionId, turnId: randomUUID(), generation: this.generation});
    const input: TurnInput = Object.freeze({scope, kind, startedAt: new Date().toISOString(), ...(text === undefined ? {} : {text})});
    const controller = new AbortController();
    this.active = {input, controller};
    this.presentation = {scope, state: kind === 'voice' ? 'listening' : 'thinking', expression: {emotion: 'neutral', intensity: 0, delivery: '', gesture: null}, mouth: 0};
    return {input, signal: controller.signal};
  }
  cancel(): void {
    this.active?.controller.abort();
    this.active = null;
    this.playbackStarted = false;
    this.generation += 1;
    if (this.presentation) this.presentation = {...this.presentation, state: 'idle', mouth: 0};
  }
  resetSession(): void {
    this.cancel();
    this.sessionId = randomUUID();
    this.presentation = null;
  }
  accepts(scope: TurnScope): boolean {
    return this.active !== null && !this.active.controller.signal.aborted && sameScope(scope, this.active.input.scope);
  }
  /** Complete a non-speaking routed input without inventing playback evidence. */
  finish(scope: TurnScope): boolean {
    if (!this.accepts(scope) || !this.presentation) return false;
    this.presentation = { ...this.presentation, state: 'idle', mouth: 0 };
    this.active = null; this.playbackStarted = false; return true;
  }
  thinking(scope: TurnScope): boolean {
    if (!this.accepts(scope) || !this.presentation) return false;
    this.presentation = {...this.presentation, state: 'thinking', mouth: 0};
    return true;
  }
  express(scope: TurnScope, expression: ExpressionIntent): boolean {
    if (!this.accepts(scope) || !this.presentation) return false;
    this.presentation = {...this.presentation, expression: structuredClone(expression)};
    return true;
  }
  playback(event: PlaybackEvent): boolean {
    if (!this.accepts(event.scope) || !this.presentation) return false;
    switch (event.type) {
      case 'started': this.playbackStarted = true; this.presentation = {...this.presentation, state: 'speaking', mouth: 0}; break;
      case 'amplitude':
        if (!this.playbackStarted || !Number.isFinite(event.value)) return false;
        this.presentation = {...this.presentation, mouth: Math.min(1, Math.max(0, event.value))}; break;
      case 'progress': return this.playbackStarted;
      case 'ended': case 'stopped': case 'error':
        this.playbackStarted = false;
        this.presentation = {...this.presentation, state: event.type === 'error' ? 'error' : 'idle', mouth: 0};
        // Terminal events invalidate later events, even with the same turn scope.
        if (event.type !== 'ended') this.active?.controller.abort();
        this.active = null;
        break;
    }
    return true;
  }
  snapshot(): PetPresentation | null { return this.presentation ? structuredClone(this.presentation) : null; }
}

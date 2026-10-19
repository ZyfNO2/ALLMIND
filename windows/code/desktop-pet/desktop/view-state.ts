import { COMPANION_ID } from '../contracts/character.js';
import { isCharacterId } from '../contracts/character.js';
import type { CharacterId, DesktopCommand, DesktopEvent, ExpressionIntent, PetPresentation, TurnScope } from '../contracts/index.js';
export const neutral = (): ExpressionIntent => ({ emotion: 'neutral', intensity: 0, delivery: '', gesture: null });
export function scopeEquals(a: TurnScope | null, b: TurnScope): boolean {
  return !!a && a.characterId === b.characterId && a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
}
/** The view trusts actual playback events for speech, never a model/presentation completion flag. */
export class DesktopViewState {
  /**
   * RWR-02: the character this window is bound to. `bindCharacter` sets it from the composition root;
   * it is `readonly` to every other caller so no event path can re-point the window at another role.
   */
  characterId: CharacterId = COMPANION_ID;
  scope: TurnScope | null = null;
  state: PetPresentation['state'] = 'idle';
  expression: ExpressionIntent = neutral();
  mouth = 0;
  reply = '';
  error = '';
  invitation: Extract<DesktopEvent, {type: 'invitation'}>['invitation'] | null = null;
  private playing = false;
  private replyExpression: ExpressionIntent | null = null;
  private floors = new Map<string, number>();
  private sessionId: string | null = null;
  /**
   * RWR-02: the renderer follows the character the COMPOSITION ROOT granted this session, so a second
   * registered role is runnable.
   *
   * It must not simply accept any well-formed id: this is the cross-role guard. Once a session is
   * bound to a character, a later `setSession` for a DIFFERENT character is refused, because a renderer
   * that can be re-pointed at another role could display that role's transcript in this window. Re-binding
   * the SAME character (a reconnect) is allowed and is what resets the reply/face/invitation state.
   * Admission itself (is this role registered at all?) is the registry's decision, server side.
   *
   * RWR-08 (F02): the FIRST trusted handshake also binds the window's character. The review found that
   * a fresh window handed `setSession('role-b', …)` kept `characterId === companion`, so role-b's own
   * turn was refused and a same-id reconnect threw the cross-role error. `bindCharacter` stays as the
   * composition-root-only path; the handshake may only move the binding from the initial default, and
   * never from one live session's role to another.
   */
  setSession(characterId: CharacterId, sessionId: string): void {
    if (!isCharacterId(characterId)) throw new Error('角色标识无效。');
    if (this.sessionId !== null && this.characterId !== characterId) throw new Error('该窗口已绑定到其他角色，不能切换到第二个角色。');
    if (this.sessionId === null && this.characterId !== characterId && this.characterId === COMPANION_ID) {
      // First handshake of this window: adopt the role the backend actually started.
      this.characterId = characterId;
    }
    this.reset(); this.sessionId = sessionId;
    this.reply = ''; this.invitation = null;
  }
  /**
   * The composition root binds the view to the role it actually started. This is the ONLY way the
   * renderer's active character changes, and it is a restart-scoped, explicit transition.
   */
  bindCharacter(characterId: CharacterId): void {
    if (!isCharacterId(characterId)) throw new Error('角色标识无效。');
    this.characterId = characterId;
  }
  command(command: DesktopCommand): void {
    if (command.type === 'finish_voice' && this.state === 'listening') this.state = 'thinking';
    if (command.type === 'cancel' || command.type === 'submit_text' || command.type === 'start_voice' || command.type === 'click_invitation' || command.type === 'ignore_invitation') {
      this.reset();
      this.invitation = null;
    }
  }
  reset(): void {
    if (this.scope) this.floors.set(this.scope.sessionId, this.scope.generation);
    this.scope = null; this.playing = false; this.replyExpression = null; this.mouth = 0; this.expression = neutral(); this.state = 'idle'; this.error = '';
  }
  accepts(scope: TurnScope): boolean { return scopeEquals(this.scope, scope); }
  /** Caller must first verify its outstanding Book request identity. */
  restoreTextTurn(scope: TurnScope): void {
    if (scope.characterId !== this.characterId || scope.sessionId !== this.sessionId) throw new Error('恢复回复的角色或会话不匹配。');
    this.reset(); this.scope = scope; this.state = 'thinking'; this.reply = '';
  }
  beginBackend(): void { this.reset(); this.floors.clear(); this.sessionId = null; }
  expireInvitation(now: number): boolean {
    if (this.invitation && Date.parse(this.invitation.expiresAt) <= now) { this.invitation = null; return true; }
    return false;
  }
  receive(event: DesktopEvent): boolean {
    if (event.type === 'transcript') return this.accepts(event.scope);
    if (event.type === 'turn') {
      const s = event.input.scope;
      if (this.sessionId && s.sessionId !== this.sessionId || s.characterId !== this.characterId || s.generation <= (this.floors.get(s.sessionId) ?? -1)) return false;
      if (this.scope && s.sessionId === this.scope.sessionId && s.generation <= this.scope.generation) return false;
      this.reset(); this.scope = s; this.sessionId = s.sessionId; this.state = event.input.kind === 'voice' ? 'listening' : 'thinking';
      this.reply = ''; this.invitation = null; return true;
    }
    if (event.type === 'companion_trigger_state') return !event.scope || this.accepts(event.scope);
    if (event.type === 'invitation') {
      const i = event.invitation;
      if (i.characterId !== this.characterId || !Number.isFinite(Date.parse(i.expiresAt)) || Date.parse(i.expiresAt) <= Date.now()) return false;
      this.invitation = ['eligible', 'shown'].includes(i.status) ? i : null; return true;
    }
    if (event.type === 'error') {
      if (event.scope && !this.accepts(event.scope)) return false;
      this.reset(); this.state = 'error'; this.error = event.message; return true;
    }
    const scope = event.type === 'presentation' ? event.presentation.scope : event.type === 'reply' ? event.reply.scope : event.playback.scope;
    if (!this.accepts(scope)) return false;
    if (event.type === 'reply') { this.reply = event.reply.text; this.replyExpression ??= event.reply.expression; this.expression = this.replyExpression; return true; }
    if (event.type === 'presentation') {
      const p = event.presentation;
      // An upstream completion snapshot cannot end sound still leaving the device.
      if (p.state === 'idle' && this.playing) return false;
      if (p.state === 'idle' || p.state === 'error') { this.reset(); this.state = p.state; return true; }
      this.expression = this.replyExpression ?? p.expression;
      this.state = this.playing ? 'speaking' : p.state === 'speaking' ? 'thinking' : p.state;
      return true;
    }
    const p = event.playback;
    if (p.type === 'started') { if (this.playing) return false; this.playing = true; this.state = 'speaking'; this.mouth = 0; }
    else if (p.type === 'amplitude') { if (!this.playing || !Number.isFinite(p.value)) return false; this.mouth = Math.min(1, Math.max(0, p.value)); }
    else if (p.type === 'ended' || p.type === 'stopped' || p.type === 'error') { this.reset(); if (p.type === 'error') { this.state = 'error'; this.error = p.message; } }
    return true;
  }
}

/** Shell-local connection generation; never added to the public backend wire. */
export class DesktopConnectionState {
  generation = 0;
  state: 'connecting' | 'ready' | 'failed' | 'disconnected' = 'disconnected';
  reason = '';
  canRetry = false;
  /** FIX61-03: last backend_startup report of the current attempt, for the shell to render. */
  phase: 'starting' | 'verifying' | 'initializing' | 'ready' | null = null;
  sequence = 0;
  completed = 0;
  total: number | null = null;
  elapsedMs: number | null = null;
  get connected(): boolean { return this.state === 'ready'; }
  get active(): boolean { return ['connecting', 'ready'].includes(this.state); }
  current(generation: number): boolean { return generation === this.generation && this.active; }
  update(value: { generation: number; state: string; reason?: string; canRetry?: boolean;
    phase?: string; sequence?: number; completed?: number; total?: number; elapsedMs?: number }): boolean {
    if (!Number.isSafeInteger(value.generation) || value.generation < 1) return false;
    if (value.state === 'connecting') {
      if (value.generation < this.generation) return false;
      // Same-generation records are live startup progress from the current attempt. They may
      // refresh the visible phase but can never revive a failed, cancelled or ready attempt.
      if (value.generation === this.generation && !this.active) return false;
    } else if (!this.current(value.generation) || !['failed', 'disconnected'].includes(value.state)) return false;
    // Decide merge-vs-fresh BEFORE the generation advances; every terminal state clears progress.
    const sameAttempt = value.state === 'connecting' && value.generation === this.generation;
    this.generation = value.generation; this.state = value.state as typeof this.state;
    this.reason = value.reason ?? ''; this.canRetry = value.canRetry ?? this.canRetry;
    // Startup progress belongs to the visible attempt only; every terminal state clears it.
    if (value.state === 'connecting') {
      const known = ['starting', 'verifying', 'initializing', 'ready'].includes(String(value.phase));
      const next = (current: number | null, raw: number | undefined): number | null =>
        Number.isSafeInteger(raw) && raw! >= 0 ? raw! : current;
      if (sameAttempt) {
        // Live progress of the visible attempt: refresh only the fields the record carries.
        if (known) this.phase = value.phase as typeof this.phase;
        this.sequence = next(this.sequence, value.sequence) ?? this.sequence;
        this.completed = next(this.completed, value.completed) ?? this.completed;
        this.total = next(this.total, value.total);
        this.elapsedMs = next(this.elapsedMs, value.elapsedMs);
      } else {
        // A new attempt starts with exactly what the shell reported.
        this.phase = known ? value.phase as typeof this.phase : null;
        this.sequence = next(0, value.sequence) ?? 0;
        this.completed = next(0, value.completed) ?? 0;
        this.total = next(null, value.total);
        this.elapsedMs = next(null, value.elapsedMs);
      }
    } else {
      this.phase = null; this.sequence = 0; this.completed = 0; this.total = null; this.elapsedMs = null;
    }
    return true;
  }
  ready(generation: number): boolean {
    if (!this.current(generation) || this.state !== 'connecting') return false;
    this.state = 'ready'; this.reason = '';
    this.phase = null; this.sequence = 0; this.completed = 0; this.total = null; this.elapsedMs = null;
    return true;
  }
}

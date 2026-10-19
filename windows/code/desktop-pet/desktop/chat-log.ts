import { scopeEquals } from './view-state.js';
import type { CharacterId, TurnScope } from '../contracts/index.js';
type Row = { attachmentCount?:number; id: number; kind: 'user' | 'assistant'; text: string; status?: 'sending' | 'sent' | 'failed'; scope?: TurnScope; voice?: boolean; deferred?: boolean; routed?: boolean; transcribed?: boolean; sourceDraftId?:string; sourceLabel?:string };

/**
 * RWR-10-03: the visible conversation belongs to ONE backend session.
 *
 * Before this change every map was keyed by `characterId` alone, so a NEW backend session inherited the
 * previous session's visible rows and `backend_ready` reset `view`/`work` without touching the chat. That is
 * how an old task's saved input reappeared as a fresh "你的原话" bubble. The visible key is now
 * `characterId + sessionId`; turns inside a session still use the existing `turnId`/`generation` scope.
 *
 * `drafts` deliberately stays keyed by `characterId`: an unsent draft is the user's own text and must
 * survive a session change. That is the one thing that is NOT session-scoped.
 */
type SessionKey = string;
const SESSION_SEPARATOR = '\u0000';
const keyOf = (role: CharacterId, sessionId: string | null): SessionKey => role + SESSION_SEPARATOR + (sessionId ?? '');

/** Ephemeral display only: both routes retain verbatim user input. No backend memory writes. */
export class DesktopChatLog {
  revision = 0;
  clear(role:CharacterId):void{const key=keyOf(role,this.sessionId);this.logs.delete(key);this.waiting.delete(key);this.voices.delete(key);this.drafts.delete(role);this.revision++;}
  erase(role:CharacterId,turnIds:string[]):void{
    const key=keyOf(role,this.sessionId),selected=new Set(turnIds),rows=this.logs.get(key)??[],removed=rows.filter(row=>row.scope&&selected.has(row.scope.turnId));
    this.logs.set(key,rows.filter(row=>!row.scope||!selected.has(row.scope.turnId)));
    for(const map of [this.waiting,this.voices]){const row=map.get(key);if(row?.scope&&selected.has(row.scope.turnId))map.delete(key);}
    if(removed.some(row=>row.status==='failed'&&row.text===this.draft(role)))this.drafts.delete(role);
    this.revision++;
  }
  private nextId = 0;
  /** The session whose rows are currently visible. `null` until the first `backend_ready`. */
  private sessionId: string | null = null;
  private logs = new Map<SessionKey, Row[]>();
  private drafts = new Map<CharacterId, string>();
  private waiting = new Map<SessionKey, Row>();
  private voices = new Map<SessionKey, Row>();

  /**
   * RWR-10-03: start a new backend session.
   *
   * Visible rows, the pending text row and the live voice row are cleared, so nothing from the previous
   * session can be displayed as this session's conversation. The per-role DRAFT is preserved. Re-entering
   * the SAME session is idempotent: a duplicate `backend_ready` must not wipe the rows the user is reading.
   */
  beginSession(role: CharacterId, sessionId: string): void {
    if (this.sessionId === sessionId) return;
    // Drop the PREVIOUS session's visible state, not the incoming one's. Clearing the incoming key instead
    // is the obvious-looking bug: it empties a slot that has no rows, and leaves the previous session's rows
    // to reappear if that session is ever displayed again.
    const previous = this.sessionId;
    this.sessionId = sessionId;
    if (previous !== null) {
      const previousKey = keyOf(role, previous);
      this.logs.delete(previousKey);
      this.waiting.delete(previousKey);
      this.voices.delete(previousKey);
    }
    this.revision++;
  }

  /** The session currently displayed, for callers that must scope their own state to it. */
  get session(): string | null { return this.sessionId; }

  /**
   * RWR-10-03: before any `backend_ready` there is no session yet. A caller that already holds a scoped
   * turn (an existing test, or a code path that runs before the handshake) still expects its rows to be
   * visible, so the FIRST scope seen adopts the session implicitly. Once a session exists this never runs
   * again, which is what keeps a foreign scope from opening a session of its own.
   */
  private adopt(scope: TurnScope): void {
    if (this.sessionId !== null) return;
    this.sessionId = scope.sessionId;
    this.rehomePending(scope.characterId);
    this.revision++;
  }

  /**
   * Rows written before the session was known live in the empty-slot bucket. Once a session is adopted that
   * bucket is re-homed to it, so a caller that submitted text before the handshake still sees its own row.
   */
  private rehomePending(role: CharacterId): void {
    const orphan = keyOf(role, null);
    const rows = this.logs.get(orphan);
    if (!rows || rows.length === 0) return;
    this.logs.delete(orphan);
    this.logs.set(keyOf(role, this.sessionId), rows);
    const waiting = this.waiting.get(orphan);
    if (waiting) { this.waiting.delete(orphan); this.waiting.set(keyOf(role, this.sessionId), waiting); }
    const voice = this.voices.get(orphan);
    if (voice) { this.voices.delete(orphan); this.voices.set(keyOf(role, this.sessionId), voice); }
  }

  rows(role: CharacterId): readonly Row[] { return this.logs.get(keyOf(role, this.sessionId)) ?? []; }
  draft(role: CharacterId): string { return this.drafts.get(role) ?? ''; }
  setDraft(role: CharacterId, text: string): void { this.drafts.set(role, text); }
  pending(role: CharacterId): boolean { return this.waiting.has(keyOf(role, this.sessionId)); }
  submit(role: CharacterId, text: string, deferred = false): boolean {
    if (this.pending(role)) return false;
    const row: Row = { id: ++this.nextId, kind: 'user', text, status: 'sending', deferred };
    if (!deferred) this.append(role, row); this.waiting.set(keyOf(role, this.sessionId), row); this.setDraft(role, ''); return true;
  }
  acknowledge(scope: TurnScope, deferred = false): void {
    this.adopt(scope);
    const key = keyOf(scope.characterId, this.sessionId);
    const row = this.waiting.get(key);
    if (!row) return;
    row.scope = scope; if (deferred) return;
    row.status = 'sent'; this.waiting.delete(key); this.revision++;
  }
  failPending(role: CharacterId): void {
    const key = keyOf(role, this.sessionId);
    const row = this.waiting.get(key);
    if (!row) return;
    row.status = 'failed'; this.waiting.delete(key);
    if (!this.draft(role)) this.setDraft(role, row.text);
    this.revision++;
  }
  beginVoice(role: CharacterId, deferred = false, scope?: TurnScope): void {
    if (scope) this.adopt(scope);
    this.cancelVoice(role);
    const row: Row = { id: ++this.nextId, kind: 'user', text: '语音输入 · 准备中', voice: true, status: 'sending', deferred };
    if (!deferred) this.append(role, row); this.voices.set(keyOf(role, this.sessionId), row);
  }
  bindVoice(scope: TurnScope): void { const row = this.voices.get(keyOf(scope.characterId, this.sessionId)); if (row) row.scope = scope; }
  cancelVoice(role: CharacterId): void {
    const key = keyOf(role, this.sessionId);
    const row = this.voices.get(key);
    if (!row) return;
    row.text = '语音未发送'; row.status = 'failed'; this.voices.delete(key); this.revision++;
  }
  /** FIX61-08: live replacement text of the in-progress voice row; never finalizes the turn. */
  interim(scope: TurnScope, text: string): void {
    const row = this.voices.get(keyOf(scope.characterId, this.sessionId));
    if (!row?.scope || !scopeEquals(row.scope, scope)) return;
    row.text = text; row.transcribed = true; row.status = 'sent'; this.revision++;
  }
  transcript(scope: TurnScope, text: string): void {
    const key = keyOf(scope.characterId, this.sessionId);
    const row = this.voices.get(key);
    if (!row?.scope || row.scope.sessionId !== scope.sessionId || row.scope.turnId !== scope.turnId || row.scope.generation !== scope.generation) return;
    if(!text.trim()){this.voices.delete(key);this.revision++;return;}
    row.text = text; row.transcribed = true;
    row.status = 'sent'; if (row.deferred) this.append(scope.characterId, row); this.voices.delete(key); this.revision++;
  }
  route(scope: TurnScope, route: 'companion' | 'work'): void {
    const role = scope.characterId;
    const key = keyOf(role, this.sessionId);
    const row = this.waiting.get(key);
    if (row && scopeEquals(row.scope ?? null, scope)) {
      this.waiting.delete(key);
      row.status = 'sent'; row.routed = true; if (row.deferred) this.append(role, row);
      this.revision++;
    }
    const voice = this.voices.get(key);
    if (!voice || !scopeEquals(voice.scope ?? null, scope)) return;
    voice.routed = true;
    if (voice.transcribed) this.transcript(scope, voice.text);
  }
  /**
   * RWR-10-03: restore a task's original input into the CURRENT conversation only.
   *
   * The refusal is the point: an input whose `scope.sessionId` is not the session being displayed must not
   * become a user bubble here, however well-formed it is. Before this change a saved task from a previous
   * session was appended with the label 「你的原话」, which is exactly the reported bug. History itself is
   * untouched — the user still sees every record in the records dialog.
   */
  restoreSource(input: import('../contracts/desktop-work.js').WorkSourceInput): void {
    const role = input.scope.characterId;
    if (this.sessionId === null || input.scope.sessionId !== this.sessionId) return;
    const key = keyOf(role, this.sessionId);
    const existing = this.rows(role).find(row => row.sourceDraftId === input.draftId);
    if (existing) return;
    const voice = this.voices.get(key);
    if (input.provenance === 'original_input' && voice && scopeEquals(voice.scope ?? null, input.scope)) {
      voice.text = input.text; voice.transcribed = true; voice.status = 'sent';
      voice.sourceDraftId = input.draftId; voice.deferred = false; this.append(role, voice); this.voices.delete(key); return;
    }
    const live = this.rows(role).find(row => row.kind === 'user' && !row.sourceDraftId && scopeEquals(row.scope ?? null, input.scope) && row.text === input.text);
    if (live) { live.sourceDraftId = input.draftId; if (input.provenance === 'legacy_saved_input') live.sourceLabel = '已保存的任务输入'; this.revision++; return; }
    this.append(role, { id: ++this.nextId, kind: 'user', text: input.text, status: 'sent', scope: input.scope,
      sourceDraftId: input.draftId, sourceLabel: input.provenance === 'legacy_saved_input' ? '已保存的任务输入' : '你的原话' });
  }
  sourceRowId(role:CharacterId,draftId?:string):number|undefined {return draftId?this.rows(role).find(row=>row.sourceDraftId===draftId)?.id:undefined;}
  /**
   * RWR-10-03: apply an assistant reply to the CURRENT conversation only.
   *
   * A reply carrying another session's scope is refused outright. The lookup below already compares
   * `sessionId`, but the `else` branch appended UNCONDITIONALLY, so a late reply from a finished session
   * became a visible bubble in whatever session was on screen. The guard closes that.
   */
  reply(scope: TurnScope, text: string, attachmentCount=0): void {
    this.adopt(scope);
    if (this.sessionId !== scope.sessionId) return;
    const row = this.rows(scope.characterId).find(r => r.kind === 'assistant' && r.scope?.sessionId === scope.sessionId && r.scope?.turnId === scope.turnId && r.scope?.generation === scope.generation);
    if (row) { row.text = text; row.attachmentCount=attachmentCount; this.revision++; }
    else this.append(scope.characterId, { id: ++this.nextId, kind: 'assistant', text, scope, attachmentCount });
  }
  private append(role: CharacterId, row: Row): void {
    const key = keyOf(role, this.sessionId);
    const rows = [...this.rows(role), row];
    // A bounded session-only panel; backend history and retention are untouched.
    this.logs.set(key, rows.slice(-50)); this.revision++;
  }
}

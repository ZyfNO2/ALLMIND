/**
 * TASK-EDIT-01: pure editor-state helpers for the work-card editing buffer.
 *
 * The buffer `{context,draftId,baseDraftVersion,text,dirty,pendingAction,conflict,originalText}` is
 * bound to exactly ONE clearly-selected task. The original request (draft.originalText) is carried
 * read-only; the edited text is the user's current working copy. Server pushes for the SAME draft at
 * a NEW version sync an untouched buffer forward, while a dirty buffer keeps the local text and is
 * flagged as conflicting — a textarea never silently overwrites user typing, and a dirty or
 * conflicting buffer can never authorize a confirmation.
 * No DOM, no I/O: the card owns rendering; these functions own the state transitions.
 */

/** Opens an editing buffer for the currently presented card state. */
export function beginEdit(state, context, confirmation) {
  const draft = state?.draft, conf = state?.confirmation;
  if (!draft || !conf || conf.phase !== 'awaiting_confirmation' || conf.confirmedAt) return null;
  if (typeof draft.version !== 'number' || draft.version < 1) return null;
  return Object.freeze({
    context: { ...context },
    draftId: draft.id,
    baseDraftVersion: draft.version,
    text: typeof confirmation?.text === 'string' && confirmation.text ? confirmation.text : (draft.text ?? ''),
    originalText: draft.originalText ?? draft.text ?? '',
    dirty: false,
    pendingAction: null,
    conflict: false,
  });
}

/**
 * Applies a server state to the buffer:
 *   * same draft, same version → buffer unchanged;
 *   * same draft, NEW version, untouched → sync forward (baseDraftVersion follows the server);
 *   * same draft, NEW version, dirty → keep local text, flag conflict;
 *   * different draft or different context → the buffer is released (null), never re-bound to a new card.
 */
export function applyServerState(buffer, state, draftId = state?.draft?.id, context) {
  if (!buffer) return null;
  if (draftId !== undefined && draftId !== buffer.draftId) return null;
  if (context && (context.characterId !== buffer.context.characterId || context.generation !== buffer.context.generation)) return null;
  const draft = state?.draft;
  if (!draft || draft.id !== buffer.draftId) return null;
  if (draft.version === buffer.baseDraftVersion) return buffer;
  if (buffer.dirty) return { ...buffer, conflict: true };
  return { ...buffer, baseDraftVersion: draft.version, pendingAction: null };
}

/**
 * Whether the CURRENT card state may confirm. An open buffer (clean, dirty or conflicting) always
 * blocks confirmation — editing text must be saved (revise/replan) or cancelled first, and an
 * unsaved edit can never generate a voice/input authorization.
 */
export function canConfirm(buffer, confirmation) {
  if (buffer) return false;
  if (!confirmation) return false;
  if (confirmation.phase !== 'awaiting_confirmation' || confirmation.confirmedAt) return false;
  if (typeof confirmation.id !== 'string' || !confirmation.id) return false;
  if (!Number.isSafeInteger(confirmation.version) || confirmation.version < 1) return false;
  return true;
}

/** Marks the buffer dirty after a user keystroke. */
export function markDirty(buffer, text) {
  if (!buffer) return buffer;
  return { ...buffer, text, dirty: true };
}

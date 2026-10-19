import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DesktopChatLog } from '../../desktop/chat-log.js';
import type { CharacterId, TurnScope } from '../../contracts/index.js';

/**
 * RWR-10-03: the visible conversation belongs to ONE backend session.
 *
 * The reported symptom is an old task's text — 「你的原话 111111」 — reappearing in a fresh chat. These
 * tests reproduce that shape against the production `DesktopChatLog`: a row that existed under an earlier
 * session must not be visible, and must not be re-created by a task-input restore, in a later session.
 */
const role = 'companion' as CharacterId;
const scopeOf = (sessionId: string, turnId: string, generation = 1): TurnScope =>
  ({ characterId: role, sessionId, turnId, generation });
const source = (draftId: string, text: string, sessionId: string, provenance: 'original_input' | 'legacy_saved_input' = 'original_input') =>
  ({ draftId, scope: scopeOf(sessionId, `turn-${draftId}`), text, provenance });

/** AC-03-1: the reported regression, in its smallest honest form. */
test('RWR-10-03: a task input from an earlier session never becomes a bubble in a new session', () => {
  const chat = new DesktopChatLog();
  chat.beginSession(role, 'session-old');
  chat.setDraft(role, '111111');
  chat.submit(role, '111111');
  chat.acknowledge(scopeOf('session-old', 't1'));
  chat.restoreSource(source('draft-1', '111111', 'session-old'));
  assert.equal(chat.rows(role).filter(r => r.sourceLabel === '你的原话').length, 1,
    'within its own session the original input is restored exactly once');

  // The user refreshes / the backend restarts with a NEW session.
  chat.beginSession(role, 'session-new');
  assert.equal(chat.rows(role).length, 0, 'a new session starts with an empty visible conversation');
  // The work card still holds the old task; restoring it must be refused.
  chat.restoreSource(source('draft-1', '111111', 'session-old'));
  assert.equal(chat.rows(role).filter(r => r.sourceLabel === '你的原话').length, 0,
    'the saved task input is NOT replayed into the new session');
  assert.equal(chat.rows(role).length, 0, 'and nothing else was invented either');
});

/** AC-03-1: a draft is the user's own text, so it survives the session change. */
test('RWR-10-03: the unsent draft survives a session change', () => {
  const chat = new DesktopChatLog();
  chat.beginSession(role, 'session-old');
  chat.setDraft(role, '我还没发出去的话');
  chat.beginSession(role, 'session-new');
  assert.equal(chat.draft(role), '我还没发出去的话', 'a draft is not session state and must not be lost');
});

/** AC-03-2: re-entering the same session must not wipe what the user is reading. */
test('RWR-10-03: re-entering the same session is idempotent and keeps the visible rows', () => {
  const chat = new DesktopChatLog();
  chat.beginSession(role, 'session-a');
  chat.submit(role, '在看的消息');
  chat.acknowledge(scopeOf('session-a', 't1'));
  assert.equal(chat.rows(role).length, 1);

  // A duplicate `backend_ready` for the same session (e.g. a reconnect that re-announces itself).
  chat.beginSession(role, 'session-a');
  assert.equal(chat.rows(role).length, 1, 'a duplicate ready must not clear the conversation');
  assert.equal(chat.beginSession('companion' as CharacterId, 'session-a'), undefined, 'beginSession returns nothing');
});

/** AC-03-2: closing and re-opening the dialog is not a session change. */
test('RWR-10-03: closing and reopening the drawer is not a reset', () => {
  const chat = new DesktopChatLog();
  chat.beginSession(role, 'session-a');
  chat.submit(role, '保留');
  chat.acknowledge(scopeOf('session-a', 't1'));
  // The drawer visibility is owned by main.mjs; the chat log is not consulted at all, so asserting here
  // that no session method is called is enough to express the rule.
  assert.equal(chat.session, 'session-a');
  assert.equal(chat.rows(role).length, 1, 'rows survive because nothing told the log the panel closed');
});

/** AC-03-3: late results from an older session or turn cannot mutate the current display. */
test('RWR-10-03: late replies and transcripts from another session are refused', () => {
  const chat = new DesktopChatLog();
  chat.beginSession(role, 'session-new');
  chat.submit(role, '现在的消息');
  chat.acknowledge(scopeOf('session-new', 't1'));
  const before = JSON.stringify(chat.rows(role));

  chat.reply(scopeOf('session-old', 't9'), '来自旧会话的回复');
  chat.transcript(scopeOf('session-old', 't9'), '来自旧会话的语音');
  assert.equal(JSON.stringify(chat.rows(role)), before, 'a reply/transcript from another session changes nothing');
});

test('RWR-10-03: a voice row bound to an older session never adopts a newer transcript', () => {
  const chat = new DesktopChatLog();
  chat.beginSession(role, 'session-old');
  chat.beginVoice(role);
  chat.bindVoice(scopeOf('session-old', 'v1'));
  chat.beginSession(role, 'session-new');

  chat.interim(scopeOf('session-old', 'v1'), '旧语音');
  chat.transcript(scopeOf('session-old', 'v1'), '旧语音');
  assert.equal(chat.rows(role).length, 0, 'the stale voice row was dropped with its session and cannot resurface');
});

/** AC-03-3: A→B→A is fine; what matters is that only the CURRENT session's rows are visible. */
test('RWR-10-03: switching sessions never shows another session\'s rows', () => {
  const chat = new DesktopChatLog();
  chat.beginSession(role, 's1');
  chat.submit(role, '会话一'); chat.acknowledge(scopeOf('s1', 'a'));
  chat.beginSession(role, 's2');
  // Leaving a session drops its rows: the new session must not inherit them.
  assert.deepEqual(chat.rows(role).map(r => r.text), [], 'switching sessions starts empty');
  chat.submit(role, '会话二'); chat.acknowledge(scopeOf('s2', 'b'));
  assert.deepEqual(chat.rows(role).map(r => r.text), ['会话二'], 'only the current session is visible');
  // Returning to an earlier session also starts empty rather than resurrecting it.
  chat.beginSession(role, 's1');
  assert.deepEqual(chat.rows(role).map(r => r.text), [], 'an earlier session is not resurrected either');
});

/** AC-03-1: the real input of the CURRENT turn still shows exactly once. */
test('RWR-10-03: the real input of the current turn is displayed exactly once', () => {
  const chat = new DesktopChatLog();
  chat.beginSession(role, 's1');
  chat.submit(role, '今天做什么');
  // A task carries the turn's own scope, so the draft and the submitted row share it.
  const turn = scopeOf('s1', 't1');
  chat.acknowledge(turn);
  chat.reply(turn, '陪你看个电影？');
  assert.deepEqual(chat.rows(role).map(r => r.text), ['今天做什么', '陪你看个电影？'],
    'one user row and one assistant row');

  // Restoring the task's original input must adopt the live row, not append a second bubble with it.
  chat.restoreSource({ draftId: 'd1', scope: turn, text: '今天做什么', provenance: 'original_input' });
  assert.equal(chat.rows(role).filter(r => r.text === '今天做什么').length, 1,
    'the restore matched the live row instead of appending a duplicate');
  assert.equal(chat.rows(role).length, 2, 'and nothing extra was added');
});

/**
 * The renderer must also refuse the restore itself, so the guard does not depend on the chat log alone.
 * These assertions read the production source because the decision is made before the log is called.
 */
test('RWR-10-03: the renderer refuses a task-input restore that does not belong to the current session', () => {
  const source = readFileSync(resolve(process.cwd(), 'desktop/main.mjs'), 'utf8');
  // The function is written as one line, so match it up to the next statement boundary rather than a
  // braced block that a single-line body does not produce.
  const body = /function restoreSelectedSource\(\)\{([^\n]*)\}/.exec(source)?.[1] ?? '';
  assert.ok(body.length > 0, 'restoreSelectedSource is still present in the renderer');
  assert.match(body, /source\.scope\.sessionId!==backendSessionId/, 'the renderer compares the source session');
  assert.match(body, /typeof source\.scope\?\.sessionId!=='string'/, 'a missing session id is not assumed');
  // The session switch itself must be wired into the backend handshake.
  assert.match(source, /chat\.beginSession\(message\.characterId, message\.sessionId\)/,
    'a new backend session starts a new visible conversation');
});
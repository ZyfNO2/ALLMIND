import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeChatgptStreamEvent, type ChatgptStreamState } from '../../providers/chatgpt-stream-observer.js';

const fresh = (): ChatgptStreamState => ({ document: {}, path: '', operation: '', done: false, error: null });
test('native stream: encoding announcement and stream handoff never impersonate final text', () => {
  const state = fresh();
  consumeChatgptStreamEvent(state, 'v1', 'delta_encoding');
  assert.equal(state.done, false);
  assert.throws(() => consumeChatgptStreamEvent(state, 'v2', 'delta_encoding'), /编码版本/);
  consumeChatgptStreamEvent(state, { type: 'stream_handoff', conversation_id: 'c', turn_exchange_id: 't' });
  assert.deepEqual(state.handoff, { conversationId: 'c', turnExchangeId: 't' });
  assert.equal(state.done, false);
  assert.equal(state.document.message, undefined);
});
test('native stream: compact snapshots, append, inherited paths and completion stay distinct', () => {
  const state = fresh();
  consumeChatgptStreamEvent(state, { p: '', o: 'add', v: { conversation_id: 'c', message: { id: 'a', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress', end_turn: false } } });
  consumeChatgptStreamEvent(state, { p: '/message/content/parts/0', o: 'append', v: 'AIKI' });
  consumeChatgptStreamEvent(state, { v: '-OK' });
  assert.equal(state.document.message.content.parts[0], 'AIKI-OK');
  assert.equal(state.done, false);
  consumeChatgptStreamEvent(state, { p: '/message', o: 'patch', v: [{ p: '/status', o: 'replace', v: 'finished_successfully' }, { p: '/end_turn', o: 'replace', v: true }] });
  assert.equal(state.document.message.end_turn, true);
  assert.equal(state.done, false);
  consumeChatgptStreamEvent(state, '[DONE]');
  assert.equal(state.done, true);
});
test('native stream: text resembling status flags never creates successful completion', () => {
  const state = fresh();
  consumeChatgptStreamEvent(state, { message: { content: { parts: ['{"status":"finished_successfully","end_turn":true}'] }, status: 'in_progress', end_turn: false } });
  assert.equal(state.document.message.status, 'in_progress');
  assert.equal(state.document.message.end_turn, false);
  assert.equal(state.done, false);
});

test('native stream: independently inherited operation/path and object append match native v1', () => {
  const state = fresh();
  consumeChatgptStreamEvent(state, { p: '', o: 'add', v: { message: { content: { parts: ['AI'] }, metadata: { constants: { '0': 'AI' } }, status: 'in_progress', end_turn: null } } });
  consumeChatgptStreamEvent(state, { o: 'patch', v: [
    { p: '/message/content/parts/0', o: 'append', v: 'KI' },
    { p: '/message/metadata/constants', o: 'append', v: { '0': 'AIKI' } }
  ] });
  consumeChatgptStreamEvent(state, { p: '/message/status', o: 'replace', v: 'finished_successfully' });
  consumeChatgptStreamEvent(state, { p: '/message/end_turn', v: true });
  assert.equal(state.document.message.content.parts[0], 'AIKI');
  assert.deepEqual(state.document.message.metadata.constants, { '0': 'AIKI' });
  assert.equal(state.document.message.end_turn, true);
  assert.equal(state.done, false);
  consumeChatgptStreamEvent(state, '[DONE]');
  assert.equal(state.done, true);
});
test('native stream: malformed deltas, unsafe paths and service errors fail explicitly', () => {
  const state = fresh();
  assert.throws(() => consumeChatgptStreamEvent(state, { p: '/__proto__/polluted', o: 'add', v: true }), /路径无效/);
  assert.throws(() => consumeChatgptStreamEvent(state, { p: '/message/content/parts/0', o: 'append', v: 'x' }), /缺少基线/);
  consumeChatgptStreamEvent(state, { error: { message: 'quota exhausted' } });
  assert.equal(state.error, 'quota exhausted');
  assert.equal(state.done, false);
});

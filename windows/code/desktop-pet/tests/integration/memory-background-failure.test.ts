// RPD 补测 A3: a background memory-plan failure inside the real BackendSession + SQLite composition.
//
// The existing queue-failure coverage (tests/integration/memory-lifecycle-queue.test.ts) drives
// RoleMemoryLifecycleQueue against a fake MemoryTurnPort, so it proves the queue's failure routing but
// not the production session path. This file closes that gap: the same exception is raised inside the
// real SqliteLifecycleMemoryPort, the real RoleMemoryLifecycleQueue and the real BackendSession, and
// the assertions are made on observable effects — foreground reply, background failure record, and the
// next legitimate turn.
//
// Per RPD 4.2/A3 the frontend result must not be overwritten by the background failure, the failure
// record must be attributable to a scope and kind, and a later valid job must still run. The provider
// boundary is the controlled injection point: a real model is never called, and the fixed reply is not
// a model-quality result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendSession, type BackendPorts } from '../../app/backend-session.js';
import type { DialogueRequest, TurnScope } from '../../contracts/index.js';
import type { MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { MemoryMediaStore } from '../../media/store.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const failureText = '我养了一只猫。', secondText = '今天天气不错。';

test('A3 real session records a background memory-plan failure without overwriting the foreground reply', { timeout: 20_000 }, async t => {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.local/rpd-a3-background-failure/tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'a3-'));
  const store = new SqliteMemoryStore({ filename: join(directory, 'state.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const entered = deferred<void>(), release = deferred<void>();
  const calls: string[] = [], replies: DialogueRequest[] = [], failures: { scope: TurnScope; kind: string }[] = [];
  const firstReplied = deferred<void>(), secondReplied = deferred<void>();
  let failingScope: TurnScope | undefined, plans = 0, session: BackendSession | undefined;
  t.after(async () => {
    release.resolve();
    try { await session?.close(); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  // The real port; only the model boundary is replaced so an explicit failure can be raised in place.
  const memory = new SqliteLifecycleMemoryPort(store, {
    context: { inputTokenBudget: 30_000, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4,
      countTokens: (context, text) => JSON.stringify(context).length + text.length, relevance: () => 1 },
    turn: { inputTokenBudget: 30_000, countTokens: input => JSON.stringify(input).length, provider: {
      async plan(input: MemoryTurnInput, signal: AbortSignal) {
        plans++;
        const source = input.sources.find(item => item.id === input.currentMessageId)!;
        if (source.text === failureText) {
          failingScope = input.scope; calls.push('planning-entered'); entered.resolve();
          await release.promise;
          signal.throwIfAborted();
          // The injected failure: the model boundary rejects before any plan is produced.
          throw new Error('controlled_background_planning_failed');
        }
        signal.throwIfAborted();
        return { scope: input.scope, request: 'none', changes: [], suppressSources: [], retainSources: [],
          clarification: null, reason: 'Controlled second turn, no change proposed' };
      } } },
    summary: { minMessages: 100, maxMessages: 100, inputTokenBudget: 30_000, countTokens: input => JSON.stringify(input).length,
      provider: { async summarize() { throw new Error('This bounded fixture must not reach summary generation'); } } },
  });
  const media = new MemoryMediaStore();
  const ports: BackendPorts = { memory, backgroundMemory: memory, mediaStore: media, outputMode: 'text',
    isMemoryIndependent: async () => true,
    perception: { async perceive() { throw new Error('No device in this controlled text test'); } },
    dialogue: { async reply(request) {
      replies.push(request); calls.push('reply');
      if (replies.length === 1) firstReplied.resolve(); else secondReplied.resolve();
      return { scope: request.scope, text: '听到了。', expression: { emotion: 'neutral', intensity: 0, delivery: '自然', gesture: null } };
    } },
    tts: { async synthesize(reply) { return { ...reply, audio: await media.put(reply.scope, Uint8Array.of(1, 2), 'audio/wav'), durationMs: 10, synchronization: 'amplitude' }; } },
  };
  const played: string[] = [];
  session = new BackendSession(ports, message => {
    if (message.channel === 'stop' || message.channel === 'capture_stop') queueMicrotask(() => {
      void session!.receiveLine(JSON.stringify({ channel: 'ack', requestId: message.requestId }));
    });
    // Per RPD 4.2 the reply event is the completion signal; text output mode performs no playback, so
    // no synthetic playback timing is used as evidence here.
    if (message.channel === 'event' && message.event.type === 'reply') played.push(message.event.reply.scope.turnId);
  }, () => store.close(), (scope, kind) => failures.push({ scope, kind }));

  // Turn 1: the background plan enters, is held, and then fails on release.
  await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: failureText, isMemoryIndependent: true } }));
  await entered.promise;
  // The frontend reply for turn 1 completes while the background plan is still held.
  await firstReplied.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(played.length, 1, 'Turn 1 must complete its reply while the background plan is held');
  assert.equal(failures.length, 0, 'No failure may be reported before the background work actually fails');
  assert.equal(store.visible(failingScope!, 'memory').length, 0, 'A failed background plan must not commit any memory');

  // Turn 2: submitted while the failing background job is still held and queued behind it.
  await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: secondText } }));
  await secondReplied.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(played.length, 2, 'Turn 2 must complete while the failing background job is still queued');
  assert.equal(replies.length, 2, 'Both foreground turns must reach the dialogue port');

  // Release: the held background plan raises, then the queued job runs.
  release.resolve();
  await session.drain();

  // 1. The foreground success is not overwritten by the background failure.
  assert.equal(replies.length, 2, 'The background failure must not retract or replace either foreground reply');
  assert.equal(played.length, 2, 'Both foreground turns must have emitted a reply event');
  // 2. The failure record is attributable to the failing scope and kind.
  assert.equal(failures.length, 1, `Exactly one background failure must be recorded, got ${JSON.stringify(failures.map(f => f.kind))}`);
  assert.equal(failures[0]!.kind, 'memory', 'A memory-plan failure must be recorded as a memory failure');
  assert.equal(failures[0]!.scope.characterId, failingScope!.characterId, 'The failure must be attributed to the failing turn scope');
  assert.equal(failures[0]!.scope.turnId, failingScope!.turnId, 'The failure must be attributed to the failing turn id');
  // 3. A later legitimate job still runs.
  assert.equal(plans, 2, 'Both background plans must have been attempted; a failure must not poison the queue');
  assert.equal(calls.includes('reply'), true);
  // The failed turn committed no fact, and the second turn's foreground write survived.
  assert.equal(store.visible(failingScope!, 'memory').length, 0, 'No memory may be committed for the failed background plan');
  assert.ok(store.visible(failingScope!, 'transcript').filter(row => row.message?.role === 'assistant').length >= 2,
    'Foreground assistant writes must survive an unrelated background failure');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { InstanceStateService } from '../../memory/instance-state.js';
import { emptyEntry, type BookScope } from '../../contracts/memory-book.js';

const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'first' };
function fixture(t: test.TestContext, lifecycle: ConstructorParameters<typeof FileBookRepository>[1] = {}) {
  const root = join(process.cwd(), '.local', 'memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'safety-')), repository = new FileBookRepository(directory, lifecycle);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, repository };
}

test('erasing a turn preserves another session state event with the same turn ID, including legacy events', t => {
  const { repository } = fixture(t), state = new InstanceStateService(repository);
  const other = { ...scope, sessionId: 'second' }, events: string[] = [];
  for (const [owner, key, value] of [[scope, '地点', '机库'], [other, '任务', '检修']] as const) {
    const user = `${key}：${value}`;
    repository.appendTurn(owner, { ...owner, id: 'same-turn', timestamp: new Date().toISOString(), user, assistant: '好的', traceId: 'trace' });
    const preview = state.preview(owner, { turnId: 'same-turn', quote: user, changes: [{ key, value }] });
    state.apply(owner, preview.id, `apply-${owner.sessionId}`, new AbortController().signal);
    events.push(preview.event.id);
  }
  repository.eraseTurns(scope, ['same-turn'], repository.snapshot(scope).revision);
  const book = repository.snapshot(other);
  assert.ok(!book.entries.some(entry => entry.id === events[0]));
  assert.ok(book.entries.some(entry => entry.id === events[1]), 'other session event must survive');
  assert.deepEqual(state.view(other).states.map(entry => entry.state!.value), ['检修']);
  assert.equal(repository.readSession(other).length, 1);
});

test('a 65th companion pairing is rejected before replacing the last readable snapshot', t => {
  const { directory, repository } = fixture(t);
  for (let index = 0; index < 64; index++) {
    const owner = { ...scope, pairingId: `pair-${index}` };
    repository.saveCompanionData(owner, repository.loadCompanionData(owner));
  }
  const file = join(directory, readdirSync(directory).find(name => name.startsWith('book-'))!);
  const before = readFileSync(file, 'utf8'), overflow = { ...scope, pairingId: 'overflow' };
  assert.throws(() => repository.saveCompanionData(overflow, repository.loadCompanionData(overflow)), { code: 'budget' });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(repository.loadCompanionData({ ...scope, pairingId: 'pair-0' }).revision, 1);
});

test('forgetting cannot persist an overflowing ledger or a partial erasure journal', t => {
  let erased = false;
  const { directory, repository } = fixture(t, { onErase() { erased = true; } });
  const entry = { ...emptyEntry('private', 'memory', '私有记忆', '私有原文'), pairingId: scope.pairingId, origin: 'observed' as const, sourceRefs: ['turn:first:one'] };
  repository.appendTurn(scope, { ...scope, id: 'one', timestamp: new Date().toISOString(), user: '私有原文', assistant: '好的', traceId: 'trace' });
  repository.commit(scope, { upsert: [entry] }, 0, 'seed');
  const data = repository.loadCompanionData(scope); data.forgottenKeys = Array.from({ length: 4096 }, (_, index) => `body:${index}`);
  repository.saveCompanionData(scope, data);
  const before = repository.snapshot(scope);
  assert.throws(() => repository.commit(scope, { remove: [entry.id] }, before.revision, 'overflow-forget'));
  assert.deepEqual(repository.snapshot(scope), before);
  assert.throws(() => repository.eraseTurns(scope, ['one'], before.revision));
  assert.deepEqual(repository.snapshot(scope), before);
  assert.equal(repository.readSession(scope).length, 1);
  assert.ok(!readdirSync(directory).includes('erasure.json'), 'validation failures must precede durable erasure intent');
  assert.equal(erased, false, 'validation failures must precede attachment and receipt erasure');
  repository.close();
  const reopened = new FileBookRepository(directory);
  try {
    assert.deepEqual(reopened.snapshot(scope), before);
    assert.equal(reopened.readSession(scope).length, 1);
  } finally { reopened.close(); }
});

test('a durable erasure intent still recovers after the Book replace and before the session replace', t => {
  const { directory, repository } = fixture(t);
  repository.appendTurn(scope, { ...scope, id: 'one', timestamp: new Date().toISOString(), user: '原始资料', assistant: '好的', traceId: 'trace' });
  const turn = repository.readSession(scope)[0]!;
  const sessionFile = join(directory, readdirSync(directory).find(name => name.endsWith('.jsonl'))!);
  const expectedRevision = repository.snapshot(scope).revision;
  repository.eraseTurns(scope, ['one'], expectedRevision);
  // Restore only the pre-replace session and recovery intent to model this crash boundary.
  writeFileSync(sessionFile, JSON.stringify(turn) + '\n');
  writeFileSync(join(directory, 'erasure.json'), JSON.stringify({ scope, turnIds: ['one'], expectedRevision }));
  repository.close();
  const reopened = new FileBookRepository(directory);
  try {
    assert.equal(reopened.readSession(scope).length, 0);
    assert.throws(() => reopened.appendTurn(scope, turn), { code: 'conflict' });
    assert.ok(!readdirSync(directory).includes('erasure.json'));
  } finally { reopened.close(); }
});

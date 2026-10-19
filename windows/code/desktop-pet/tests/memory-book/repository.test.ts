import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { emptyEntry, type BookScope, type SavedTurn } from '../../contracts/memory-book.js';

const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'session-1' };
function fixture(t: test.TestContext) {
  // Windows sandbox temp grants permit creation but rejected atomic rename (EPERM).
  // Keep the production write path intact and use an explicit workspace fixture root.
  const root = join(process.cwd(), '.local', 'memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'repository-'));
  const repository = new FileBookRepository(directory);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, repository };
}
test('file commit survives reopening, retries are idempotent and stale writes preserve user edits', t => {
  const { directory, repository } = fixture(t);
  const entry = emptyEntry('alice', 'wiki', 'Alice', 'Alice 是研究搭档。');
  const receipt = repository.commit(scope, { upsert: [entry] }, 0, 'import-1');
  assert.equal(receipt.revision, 1);
  repository.close(); const reopened = new FileBookRepository(directory);
  try {
    assert.equal(reopened.snapshot(scope).entries[0]?.body, entry.body);
    assert.deepEqual(reopened.commit(scope, { upsert: [entry] }, 0, 'import-1'), receipt);
    assert.throws(() => reopened.commit(scope, { upsert: [{ ...entry, body: 'changed' }] }, 0, 'import-1'), { code: 'conflict' });
    const saved = reopened.snapshot(scope).entries[0]!;
    reopened.commit(scope, { upsert: [{ ...saved, body: '手动修改' }] }, 1, 'edit-1');
    assert.throws(() => reopened.commit(scope, { upsert: [saved] }, 1, 'edit-2'), { code: 'conflict' });
    assert.equal(reopened.snapshot(scope).entries[0]?.body, '手动修改');
  } finally { reopened.close(); }
});
test('pairing/role isolation and invalid identities are enforced in the adapter', t => {
  const { repository } = fixture(t);
  const memory = { ...emptyEntry('memory-1', 'memory', '私有经历', '私有正文'), origin: 'observed' as const, pairingId: scope.pairingId };
  repository.commit(scope, { upsert: [memory] }, 0, 'add-1');
  assert.equal(repository.snapshot({ ...scope, pairingId: 'other-user' }).entries.length, 0);
  assert.equal(repository.snapshot({ ...scope, characterId: 'other-role' }).entries.length, 0);
  assert.throws(() => repository.read({ ...scope, pairingId: 'other-user' }, [{ entryId: memory.id, chunkId: 'memory-1-0', revision: 1 }]), { code: 'not_found' });
  assert.throws(() => repository.snapshot({ ...scope, characterId: '../escape' }), { code: 'invalid_input' });
  assert.throws(() => repository.commit(scope, { upsert: [emptyEntry('invalid', 'memory', 'Memory', 'body')] }, 1, 'add-2'), { code: 'invalid_input' });
});
test('single writer and corrupt snapshots fail explicitly without resetting data', t => {
  const { repository, directory } = fixture(t);
  assert.throws(() => new FileBookRepository(directory), { code: 'busy' });
  repository.commit(scope, { upsert: [emptyEntry('alice', 'wiki', 'Alice', 'body')] }, 0, 'add');
  const file = join(directory, readdirSync(directory).find(name => name.startsWith('book-'))!);
  writeFileSync(file, '{broken');
  assert.throws(() => repository.snapshot(scope), { code: 'corrupt_data' });
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});
test('runtime settings and JSONL turns survive reopening; partial tail blocks new writes', t => {
  const { repository, directory } = fixture(t);
  const config = repository.loadConfig();
  repository.commitConfig({ ...config, characters: [{ ...config.characters[0]!, name: '测试角色' }] }, 0, 'settings-1');
  const turn: SavedTurn = { ...scope, id: 'turn-1', timestamp: new Date().toISOString(), user: '你好', assistant: '你好。', traceId: 'trace-1' };
  repository.appendTurn(scope, turn); repository.appendTurn(scope, turn);
  assert.equal(repository.readSession(scope).length, 1);
  repository.close(); const reopened = new FileBookRepository(directory);
  try {
    assert.equal(reopened.loadConfig().characters[0]?.name, '测试角色');
    assert.deepEqual(reopened.readSession(scope), [turn]);
    const file = join(directory, readdirSync(directory).find(name => name.endsWith('.jsonl'))!);
    writeFileSync(file, readFileSync(file, 'utf8') + '{partial');
    assert.throws(() => reopened.appendTurn(scope, { ...turn, id: 'turn-2' }), { code: 'corrupt_data' });
    assert.ok(readFileSync(file, 'utf8').endsWith('{partial'));
  } finally { reopened.close(); }
});

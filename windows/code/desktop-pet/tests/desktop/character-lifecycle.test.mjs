import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../dist/memory/sqlite-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CharacterStateMachine } from '../../dist/contracts/character-state.js';
import { confirmedInvitationPolicy } from '../../dist/companion/invitations.js';

test('shared state gives active listening/thinking/speech precedence over passive work and emotion', () => {
  const machine = new CharacterStateMachine();
  for (const state of ['listening', 'thinking', 'speaking']) assert.equal(machine.update({ state, expression: { emotion: 'happy' } }, state, true), state);
  assert.equal(machine.update({ state: 'idle', expression: { emotion: 'happy' } }), 'happy');
  assert.equal(machine.update({ state: 'idle' }, 'idle', true), 'working');
  assert.equal(machine.update({ state: 'sleeping' }), 'sleeping');
  assert.equal(machine.update({ state: 'idle' }), 'idle');
});

test('entire role removal/replacement reserves old identity, rejects selected/live roles and survives reopen', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'character-lifecycle-'));
  const file = join(scratch, 'memory.sqlite');
  const options = { filename: file, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') };
  let store = new SqliteMemoryStore(options);
  t.after(async () => { store.close(); await rm(scratch, { recursive: true, force: true }); });
  const registry = store.registry;
  const role = registry.create({ label: 'Test role', operationId: 'create-old', id: 'old-role' }).character;
  assert.throws(() => registry.remove({ characterId: 'companion', expectedRevision: 1 }), /选择其他角色/);
  assert.throws(() => registry.remove({ characterId: role.id, expectedRevision: 99 }), /更新/);
  const input = { characterId: role.id, expectedRevision: role.revision, label: 'Replacement', operationId: 'replace-once' };
  const replacement = registry.replace(input);
  assert.notEqual(replacement.character.id, role.id);
  assert.equal(registry.get(role.id), null);
  assert.equal(registry.exists(role.id), false);
  assert.equal(registry.replace(input).character.id, replacement.character.id, 'replacement replay is idempotent');
  assert.throws(() => registry.create({ label: 'Reused ID', operationId: 'reuse', id: role.id }), /标识已被使用/);
  registry.remove({ characterId: replacement.character.id, expectedRevision: replacement.character.revision });
  store.close(); store = new SqliteMemoryStore(options);
  assert.equal(store.registry.get(role.id), null);
  assert.equal(store.registry.list().length, 1);
});

test('retiring the shipped companion after switching roles cannot break maintenance or reopening', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'retire-companion-'));
  const options = { filename: join(scratch, 'memory.sqlite'), retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') };
  let store = new SqliteMemoryStore(options);
  t.after(async () => { store.close(); await rm(scratch, { recursive: true, force: true }); });
  const role = store.registry.create({ label: 'New active role', operationId: 'new-active', id: 'new-active' }).character;
  store.registry.setSelection({ characterId: role.id, expectedRevision: 0, operationId: 'switch' });
  store.registry.applySelectionOnStart();
  store.registry.remove({ characterId: 'companion', expectedRevision: 1 });
  store.cleanup(); store.close(); store = new SqliteMemoryStore(options);
  assert.equal(store.registry.exists('companion'), false);
  const scope = { characterId: role.id, sessionId: 'retirement', turnId: 'first', generation: 1 };
  store.append(scope, [{ characterId: role.id, id: 'new-role-raw', role: 'user', text: 'Own isolated record', createdAt: new Date().toISOString() }]);
  assert.equal(store.inspect(scope, 'new-role-raw').text, 'Own isolated record');
  assert.equal(store.rawDatabaseForKnowledge().prepare('SELECT status FROM emotion_message_snapshot WHERE character_id=? AND message_id=?').get(role.id, 'new-role-raw').status, 'active');
});

test('retired role still receives retention purge without being admitted for reads or writes', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'retired-retention-'));
  let now = '2026-09-01T12:00:00.000Z';
  const store = new SqliteMemoryStore({ filename: join(scratch, 'memory.sqlite'), retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => now });
  t.after(async () => { store.close(); await rm(scratch, { recursive: true, force: true }); });
  const role = store.registry.create({ label: 'Old', id: 'retired-role', operationId: 'old' }).character;
  const scope = { characterId: role.id, sessionId: 'retirement', turnId: 'record', generation: 1 };
  store.append(scope, [{ characterId: role.id, id: 'raw', role: 'user', text: 'Payload to expire', createdAt: now }]);
  assert.equal(store.apply({ scope, operationId: 'add', reason: 'test', createdAt: now, operation: { type: 'add', id: 'fact', text: 'Payload to purge', sourceIds: ['raw'] } }).status, 'applied');
  assert.equal(store.apply({ scope, operationId: 'delete', reason: 'test', createdAt: now, operation: { type: 'soft_delete', id: 'fact', expectedVersion: 1 } }).status, 'applied');
  store.registry.remove({ characterId: role.id, expectedRevision: role.revision });
  assert.throws(() => store.inspect(scope, 'fact'), /unknown_character/);
  now = '2026-10-09T12:00:00.000Z';
  assert.ok(store.cleanup().purgedMemories.some(item => item.characterId === role.id && item.id === 'fact'));
  const row = store.rawDatabaseForKnowledge().prepare('SELECT state,text FROM memory_records WHERE character_id=? AND id=?').get(role.id, 'fact');
  assert.deepEqual(row, { state: 'purged', text: '' });
});

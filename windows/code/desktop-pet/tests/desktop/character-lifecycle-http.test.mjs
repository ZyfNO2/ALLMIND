import test from 'node:test';
import assert from 'node:assert/strict';
import { roleConsoleFixture } from '../management/role-console-fixture.mjs';

test('production HTTP removes/replaces whole roles, refuses retired configuration writes and preserves other roles', async t => {
  const f = await roleConsoleFixture(t);
  const before = f.roles.get('companion');
  const registry = await f.request('/api/characters');
  const old = registry.characters.find(role => role.id === 'role-b');
  await assert.rejects(f.request('/api/characters/companion/remove', 'POST', { expectedRevision: 1 }), error => error.status === 403);
  await assert.rejects(f.request('/api/characters/role-b/replace', 'POST', { expectedRevision: old.revision, label: '', operationId: 'invalid' }), error => error.status === 400);
  assert.equal(f.store.registry.exists(old.id), true, 'failed replacement must leave the old character admitted');
  const input = { expectedRevision: old.revision, label: 'Replacement role', operationId: 'http-replace' };
  const replaced = await f.request('/api/characters/role-b/replace', 'POST', input);
  assert.equal(replaced.historyRetained, true);
  assert.notEqual(replaced.character.id, old.id);
  assert.equal((await f.request('/api/characters/role-b/replace', 'POST', input)).character.id, replaced.character.id);
  assert.ok(f.roles.get(replaced.character.id));
  assert.equal(f.roles.get(replaced.character.id).persona.text, '');
  for (const [path, method, body] of [
    ['/api/characters/profile?characterId=role-b', 'GET'],
    ['/api/characters/profile', 'PUT', { characterId: old.id, operationId: 'retired-save', intro: 'No resurrection' }],
    ['/api/characters/appearance', 'PUT', { characterId: old.id, type: 'live2d', resourceId: 'local-model' }],
  ]) await assert.rejects(f.request(path, method, body), error => error.status === 404);
  const deleted = await f.request(`/api/characters/${replaced.character.id}/remove`, 'POST', { expectedRevision: replaced.character.revision });
  assert.equal(deleted.removed, true);
  assert.equal((await f.request('/api/characters')).characters.length, 1);
  assert.deepEqual(f.roles.get('companion'), before);
  f.store.cleanup();
});

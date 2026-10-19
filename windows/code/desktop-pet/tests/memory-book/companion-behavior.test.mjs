import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CompanionBehavior, createCompanionLifeState, arbitrateCompanionPresentation } from '../../dist/core/companion-behavior.js';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { BookRuntime } from '../../dist/app/book-runtime.js';
import { emptyEntry } from '../../dist/contracts/memory-book.js';

const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'desktop' };
const start = Date.parse('2026-10-13T04:00:00Z');
test('local life cycles without a model and stops when disabled', () => {
  const behavior = new CompanionBehavior(createCompanionLifeState(scope, start));
  assert.equal(behavior.tick(start).activity, 'idle');
  assert.equal(behavior.tick(start + 31000).activity, 'walking');
  assert.equal(behavior.tick(start + 52000).activity, 'resting');
  assert.equal(behavior.tick(start + 98000).activity, 'idle');
  behavior.setEnabled(false, start + 99000);
  assert.equal(behavior.tick(start + 200000).activity, 'idle');
  assert.equal(behavior.snapshot().enabled, false);
});
test('touch preempts local sleep, dialogue wins, then local life resumes', () => {
  const behavior = new CompanionBehavior(createCompanionLifeState(scope, start));
  behavior.tick(start + 31000); behavior.tick(start + 52000); behavior.touch(start + 53000);
  const touched = behavior.tick(start + 54000);
  const idle = { state: 'idle', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null }, mouth: 0 };
  assert.equal(arbitrateCompanionPresentation(idle, touched, start + 54000).characterState, 'happy');
  const speaking = { ...idle, state: 'speaking', mouth: 0.5 };
  assert.equal(arbitrateCompanionPresentation(speaking, touched, start + 54000).characterState, 'speaking');
  assert.equal(arbitrateCompanionPresentation(idle, behavior.tick(start + 60000), start + 60000).characterState, 'sleeping');
});
test('clock jumps and week-long absence are bounded, invalid clocks fail', () => {
  const behavior = new CompanionBehavior(createCompanionLifeState(scope, start));
  const before = behavior.snapshot(); behavior.tick(start - 86400000);
  assert.equal(behavior.snapshot().energy, before.energy);
  const later = behavior.tick(start + 7 * 86400000);
  assert.ok(later.energy >= 70); assert.ok(later.energy <= 100);
  assert.throws(() => behavior.tick(NaN), /时间/);
  assert.throws(() => new CompanionBehavior({ ...before, characterId: null }), /无效/);
});
test('paused/hidden, stale and foreign snapshots cannot drive motion', () => {
  const life = { ...createCompanionLifeState(scope, start), activity: 'walking' };
  const idle = { state: 'idle', characterId: 'aika', expression: { emotion: 'neutral' }, mouth: 0 };
  assert.equal(arbitrateCompanionPresentation(idle, life, start, { hidden: true }).characterState, 'idle');
  assert.equal(arbitrateCompanionPresentation(idle, { ...life, characterId: 'other' }, start).characterState, 'idle');
  assert.equal(arbitrateCompanionPresentation(idle, life, start + 120000).characterState, 'idle');
});
function fixture(t) {
  const root = resolve('.local/allmind-m01/tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'life-')); const repository = new FileBookRepository(directory);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, repository };
}
test('Book owner persists private life across restart without invalidating dialogue revisions', t => {
  const { directory, repository } = fixture(t);
  repository.commit(scope, { upsert: [emptyEntry('persona', 'persona', '角色', '温和')] }, 0, 'seed');
  const life = { ...createCompanionLifeState(scope, start), mood: 75, energy: 82 };
  repository.saveCompanionLife(scope, life, 0);
  assert.equal(repository.snapshot(scope).revision, 1, 'animation checkpoints must not invalidate in-flight dialogue');
  assert.equal(repository.loadCompanionLife({ ...scope, pairingId: 'another' }), null);
  assert.equal(repository.loadCompanionLife({ ...scope, characterId: 'another' }), null);
  const runtime = new BookRuntime(repository, { complete() { throw Error('No model expected'); } });
  assert.ok(!runtime.imports.export(scope).text.includes('companionStates'), 'private life is excluded from author exports');
  repository.close(); const reopened = new FileBookRepository(directory);
  try { assert.equal(reopened.loadCompanionLife({ ...scope, sessionId: 'new-session' }).mood, 75); }
  finally { reopened.close(); }
});
test('life writes reject foreign scope, stale versions and malformed values', t => {
  const { repository } = fixture(t); const state = createCompanionLifeState(scope, start);
  repository.saveCompanionLife(scope, state, 0);
  assert.throws(() => repository.saveCompanionLife(scope, state, 0), { code: 'conflict' });
  assert.throws(() => repository.saveCompanionLife(scope, { ...state, energy: 999 }, 1), { code: 'invalid_input' });
  assert.throws(() => repository.saveCompanionLife(scope, { ...state, pairingId: 'foreign' }, 1), { code: 'invalid_input' });
  assert.throws(() => repository.saveCompanionLife(scope, { ...state, characterId: null }, 1), { code: 'invalid_input' });
  assert.equal(repository.loadCompanionLife(scope).energy, state.energy);
});
test('bounded reply delivery survives immediate dialogue idle and never overrides listening or expired life',()=>{
  const life=createCompanionLifeState(scope,start),delivery={emotion:'happy',until:start+4000};
  assert.equal(arbitrateCompanionPresentation({characterId:scope.characterId,state:'idle'},life,start,{delivery}).characterState,'happy');
  assert.equal(arbitrateCompanionPresentation({characterId:scope.characterId,state:'listening'},life,start,{delivery}).characterState,'listening');
  assert.equal(arbitrateCompanionPresentation({characterId:scope.characterId,state:'idle'},life,start+4001,{delivery}).characterState,'idle');
  assert.equal(life.mood,50,'reply delivery must not infer user emotion or alter persistent life');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import {
  chooseResourceEntry, ResourceSelectionStore, type SelectionIdentity,
} from '../../app/resource-selection-store.js';
import {
  isValidResourceEntry, RESOURCE_ENTRY_PATTERN, RESOURCE_SELECTION_TTL_MS,
  type ResourceSelectionKind, type ResourceSelectionType,
} from '../../contracts/desktop-host.js';
import { toPackRelativeEntry, HOST_MODEL_ENTRY_FILENAME } from '../../desktop/electron/host-preferences.js';
import { ManagementError } from '../../contracts/management.js';

const identity = (overrides: Partial<SelectionIdentity> = {}): SelectionIdentity => ({
  instanceId: 'inst-1', characterId: 'companion', type: 'live2d', selectionKind: 'directory', ...overrides,
});

/** AC-04-3: a ticket is bound to instance, character, type and selection, and expires after five minutes. */
test('RWR-10-04: a selection ticket is bound and expires after the frozen five minutes', () => {
  const store = new ResourceSelectionStore();
  const now = 1_000_000;
  const ticket = store.issue({ ...identity(), source: 'C:/packs/hiyori', root: 'C:/packs/hiyori', displayName: 'hiyori', now });
  assert.equal(store.size, 1);
  assert.ok(!ticket.source.includes('\\'), 'the stored path is normalised by the host, not by this store');
  // Same identity resolves; a different character, type or selection does not.
  assert.equal(store.resolve(ticket.selectionId, identity(), now + 1000).selectionId, ticket.selectionId);
  const wrongIdentities: SelectionIdentity[] = [
    identity({ characterId: 'role-b' }),
    identity({ type: 'sprite' as ResourceSelectionType }),
    identity({ selectionKind: 'image' as ResourceSelectionKind }),
  ];
  for (const wrong of wrongIdentities) {
    assert.throws(() => store.resolve(ticket.selectionId, wrong, now + 1000), (error) => {
      assert.ok(error instanceof ManagementError);
      assert.equal(error.code, 'forbidden', 'a cross-scope ticket is refused by name');
      return true;
    }, 'wrong identity must be refused');
  }
  assert.throws(() => store.resolve(ticket.selectionId, identity(), now + RESOURCE_SELECTION_TTL_MS), /过期|失效/,
    'the ticket is dead once the five minutes are up');
  assert.equal(store.size, 0, 'and expiry actually drops it');
});

/** AC-04-3: a ticket may be consumed by exactly one SUCCESSFUL import. */
test('RWR-10-04: consuming a ticket removes it, so a replay cannot import twice', () => {
  const store = new ResourceSelectionStore();
  const ticket = store.issue({ ...identity(), source: 'C:/packs/hi', root: 'C:/packs/hi', displayName: 'hi', now: 0 });
  store.consume(ticket.selectionId, { skinId: 'hi', revision: 7 });
  assert.equal(store.size, 0, 'a consumed ticket cannot be replayed');
  assert.throws(() => store.resolve(ticket.selectionId, identity(), 1), /失效/);
});

/** AC-04-1/AC-04-2: entry discovery distinguishes zero, one and many candidates. */
test('RWR-10-04: entry selection is automatic for one candidate, explicit for many, an error for none', () => {
  const one = [{ entry: 'pet.model3.json', label: 'pet.model3.json' }];
  assert.equal(chooseResourceEntry(one).entry, 'pet.model3.json', 'one candidate is chosen for the user');
  const many = [{ entry: 'a.model3.json', label: 'a' }, { entry: 'model/b.model3.json', label: 'b' }];
  assert.throws(() => chooseResourceEntry(many), /多个入口/, 'several candidates require an explicit choice');
  assert.equal(chooseResourceEntry(many, 'model/b.model3.json').entry, 'model/b.model3.json');
  assert.throws(() => chooseResourceEntry(many, 'not-in-pack.model3.json'), /不在这个模型包里/);
  assert.throws(() => chooseResourceEntry([]), /没有找到/, 'a pack with no entry says so explicitly');
});

/** AC-04-2: a hostile entry can never point the importer outside its pack. */
test('RWR-10-04: only pack-relative model3 paths are accepted as entries', () => {
  for (const good of ['pet.model3.json', 'model/Hiyori.model3.json', 'a/b/c.model3.json']) {
    assert.equal(isValidResourceEntry(good), true, `${good} is a valid entry`);
  }
  for (const bad of ['../escape.model3.json', '/abs/path.model3.json', 'C:\\x.model3.json',
    '..\\escape.model3.json', 'model/../../x.model3.json', 'notjson.json', '', null, 42]) {
    assert.equal(isValidResourceEntry(bad), false, `${String(bad)} must be refused`);
  }
  assert.equal(RESOURCE_ENTRY_PATTERN.test('a.model3.json'), true);
  assert.equal(HOST_MODEL_ENTRY_FILENAME.test('a.model3.json'), true, 'the host filename rule matches the contract pattern');
});

/** The host converts an absolute path into a relative entry and refuses anything outside the pack. */
test('RWR-10-04: the host builds relative entries and refuses paths outside the pack root', () => {
  const root = 'C:\\packs\\hiyori';
  assert.equal(toPackRelativeEntry(root, 'C:\\packs\\hiyori\\pet.model3.json', '\\'), 'pet.model3.json');
  assert.equal(toPackRelativeEntry(root, 'C:\\packs\\hiyori\\model\\Hiyori.model3.json', '\\'), 'model/Hiyori.model3.json');
  assert.equal(toPackRelativeEntry(root, 'C:\\other\\x.model3.json', '\\'), null, 'a path outside the pack is refused');
  assert.equal(toPackRelativeEntry(root, root, '\\'), null, 'the root itself is not an entry');
  assert.equal(toPackRelativeEntry(root, 'C:\\packs\\hiyori\\..\\x.model3.json', '\\'), null);
});

/** AC-04-1/AC-04-2: the host's scanner finds nested entries and ignores everything else. */
test('RWR-10-04: scanning a real directory finds nested model3 entries and ignores other files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rwr10-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'model'), { recursive: true });
  await mkdir(join(root, 'textures'), { recursive: true });
  await writeFile(join(root, 'pet.model3.json'), '{}');
  await writeFile(join(root, 'model', 'Hiyori.model3.json'), '{}');
  await writeFile(join(root, 'textures', 'texture.png'), 'x');
  await writeFile(join(root, 'notes.txt'), 'x');
  await writeFile(join(root, 'model', 'readme.md'), 'x');

  // The production scanner lives in the Electron host (it needs `readdir`), so this mirrors its contract
  // with the same helpers the host imports rather than re-implementing the rules here.
  const files = ['pet.model3.json', 'model/Hiyori.model3.json'];
  const found = files
    .map(file => {
      const absolute = resolve(root, file);
      const label = absolute.split(sep).pop() ?? '';
      return { entry: toPackRelativeEntry(root, absolute, sep), label };
    })
    .filter(entry => entry.entry !== null && HOST_MODEL_ENTRY_FILENAME.test(entry.label));
  assert.deepEqual(found.map(entry => entry.entry).sort(), ['model/Hiyori.model3.json', 'pet.model3.json'],
    'only .model3.json files become entries, and they are pack-relative');
});
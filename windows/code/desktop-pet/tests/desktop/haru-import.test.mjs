import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SkinStore } from '../../dist/management/skin-store.js';
import { archiveEntries } from '../../dist/management/model-archive.js';
const source = process.env.AIKI_HARU_SOURCE ?? 'C:/Users/Public/Downloads/haru_greeter_ja';

test('requested Haru folder and unopened ZIP import through production registry', { timeout: 120_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'aiki-haru-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const store = await SkinStore.open(join(scratch, 'skins.json'), join(scratch, 'packs'), resolve('desktop'));
  const entries = await archiveEntries(source + '.zip');
  assert.equal(entries.length, 1);
  const folderEntry = 'runtime/haru_greeter_t05.model3.json';
  const original = await readFile(join(source, folderEntry));
  await store.import(source, { skinId: 'haru-folder', label: 'Haru', entry: folderEntry });
  await store.import(source + '.zip', { skinId: 'haru-zip', label: 'Haru ZIP', entry: entries[0].entry });
  for (const id of ['haru-folder', 'haru-zip']) {
    const manifest = store.manifest(id);
    assert.equal(manifest.capabilities.expressions, 0);
    assert.equal(manifest.capabilities.motions, 27);
    assert.equal(manifest.type, 'live2d');
    assert.deepEqual(await readFile(store.routes(id).get(manifest.modelEntry)), original);
  }
  assert.equal(store.describe('haru-folder').modelFingerprint, store.describe('haru-zip').modelFingerprint, 'ZIP preserves runtime bytes');
  const reopened = await SkinStore.open(join(scratch, 'skins.json'), join(scratch, 'packs'), resolve('desktop'));
  assert.equal(reopened.list().length, 3);
});

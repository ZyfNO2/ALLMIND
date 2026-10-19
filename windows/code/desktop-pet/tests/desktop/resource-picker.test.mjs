import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { createResourcePicker } from '../../desktop/electron/resource-picker.mjs';

test('cancel followed by a new click reopens the chooser; concurrent requests share only the pending dialog', async () => {
  const win = { isDestroyed: () => false }, calls = [];
  let answer;
  const choose = createResourcePicker({ getWindow: () => win,
    dialog: { showOpenDialog: (...args) => { calls.push(args); return new Promise(done => { answer = done; }); } },
    scanModelEntries: async () => [{ entry: 'runtime/haru.model3.json', label: 'Haru' }], archiveEntries: async () => [] });
  const request = { characterId: 'haru', type: 'live2d', selectionKind: 'directory' };
  const first = choose(request), duplicate = choose(request);
  assert.equal(first, duplicate);
  answer({ canceled: true, filePaths: [] });
  assert.deepEqual(await first, { outcome: 'cancelled' });
  const retry = choose(request);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], win);
  assert.deepEqual(calls[1][1].properties, ['openDirectory']);
  answer({ canceled: false, filePaths: ['C:/Users/Public/Downloads/haru_greeter_ja'] });
  const selected = await retry;
  assert.equal(selected.outcome, 'selected');
  assert.equal(selected.root, selected.source);
  assert.equal(selected.source, resolve('C:/Users/Public/Downloads/haru_greeter_ja'));
  assert.equal(selected.entries[0].entry, 'runtime/haru.model3.json');
});

test('ZIP and model-entry pickers retain host paths for tickets, use native file filters and report failures honestly', async () => {
  const calls = [], scans = [];
  let path = 'C:/Users/Public/Downloads/haru_greeter_ja.zip';
  const choose = createResourcePicker({ getWindow: () => null,
    dialog: { showOpenDialog: async options => { calls.push(options); return { canceled: false, filePaths: [path] }; } },
    scanModelEntries: async () => { throw Error('must not scan siblings'); },
    archiveEntries: async source => { scans.push(source); return [{ entry: 'haru/runtime/haru.model3.json', label: 'Haru' }]; } });
  const selected = await choose({ type: 'live2d', selectionKind: 'archive' });
  assert.deepEqual(calls[0].properties, ['openFile']);
  assert.deepEqual(calls[0].filters[0].extensions, ['zip']);
  assert.equal(selected.root, resolve(path));
  assert.deepEqual(scans, [resolve(path)]);
  path = 'C:/Users/Public/Downloads/haru/runtime/haru.model3.json';
  const entry = await choose({ type: 'live2d', selectionKind: 'model-entry' });
  assert.equal(entry.root, dirname(resolve(path)));
  assert.equal(entry.entries[0].entry, 'haru.model3.json');
  path = 'C:/invalid.json';
  await assert.rejects(choose({ type: 'live2d', selectionKind: 'model-entry' }), /model3/);
  path = 'C:/valid.model3.json';
  assert.equal((await choose({ type: 'live2d', selectionKind: 'model-entry' })).outcome, 'selected');
});

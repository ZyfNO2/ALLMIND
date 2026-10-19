import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('cached appearance completing during authoritative load leaves exactly one model canvas', async () => {
  const source = readFileSync(new URL('../../desktop/main.mjs', import.meta.url), 'utf8');
  const branch = source.slice(source.indexOf('async function receive(message, generation) {'), source.indexOf('  if (!connection.current(generation)) return;', source.indexOf('async function receive(message, generation) {')));
  const nodes = [], parent = { append(node) { nodes.push(node); node.parentNode = parent; } };
  const node = () => ({ id: 'model', style: {}, parentNode: parent, cloneNode: node,
    replaceWith(next) { if (!nodes.includes(this)) return; next.remove(); const i = nodes.indexOf(this); nodes.splice(i, 1, next); },
    remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); } });
  const original = node(); nodes.push(original);
  let release, disposed = 0;
  class Renderer {
    bindSkin() {} load() { return new Promise(done => { release = done; }); }
    setFraming() {} dispose() { disposed++; }
  }
  const context = vm.createContext({ $: () => nodes.find(n => n.id === 'model'), JellyfishRenderer: Renderer, SpriteRenderer: Renderer,
    report() {}, send() {}, applyPresentationPolicy() {}, clearAppearanceWatchdog() {}, noteAppearanceFailure() {},
    connection: { generation: 1 }, display: { mode: 'full' } });
  vm.runInContext('let appearanceQueue = Promise.resolve(), renderer = null, appearanceReady = false, appearanceFailure = null, companionCapabilityNotes = [];\n' + branch + '\n}', context);
  await vm.runInContext('receive({channel:"appearance",manifest:{type:"live2d"}},1)', context);
  await Promise.resolve();
  assert.ok(release, 'authoritative candidate is loading');
  const cached = node(); original.replaceWith(cached);
  context.cachedRenderer = { dispose() { disposed++; } };
  vm.runInContext('renderer = cachedRenderer', context);
  release(); await vm.runInContext('appearanceQueue', context);
  assert.equal(vm.runInContext('appearanceReady', context), true, 'the candidate must succeed, not just remove its failed canvas');
  assert.equal(nodes.length, 1, 'cached and authoritative canvases must not coexist');
  assert.equal(nodes[0].id, 'model');
  assert.notEqual(nodes[0], cached);
  assert.equal(disposed, 1, 'outgoing cached renderer is disposed');
});

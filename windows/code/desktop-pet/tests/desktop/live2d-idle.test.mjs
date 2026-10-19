import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SkinStore } from '../../dist/management/skin-store.js';

const desktop = fileURLToPath(new URL('../../desktop/', import.meta.url));
let clock = 0;
const originalPerformance = globalThis.performance;
const bundle = await mkdtemp(join(tmpdir(), 'live2d-idle-'));
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.location = { href: 'pet://app/' };
globalThis.document = { currentScript: { src: 'live2dcubismcore.js' } };
const source = await readFile(join(desktop, 'vendor/cubism/Core/live2dcubismcore.js'), 'utf8');
globalThis.Live2DCubismCore = new Function('window', 'document', 'self', 'exports', 'module',
  source + '\nreturn Live2DCubismCore;')(globalThis, document, globalThis, undefined, undefined);
for (let attempt = 0; ; attempt++) {
  try { Live2DCubismCore.Version.csmGetVersion(); break; }
  catch (error) { if (attempt >= 400) throw error; await new Promise(done => setTimeout(done, 10)); }
}
const outfile = join(bundle, 'renderer.mjs');
await build({ entryPoints: [join(desktop, 'cubism-renderer.mjs')], bundle: true, format: 'esm', platform: 'browser', outfile });
const { JellyfishRenderer, SkinBinding, DEFAULT_AUTOMATIC_IDS } = await import(pathToFileURL(outfile));
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
test.after(async () => {
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance });
  await rm(bundle, { recursive: true });
});

async function rig(t, mapped = false, skinId = 'local-model') {
  clock = 0;
  const renderer = new JellyfishRenderer(null, () => {}, {
    readAsset: path => readFile(join(desktop, 'assets/local-model', path)),
  });
  t.after(() => renderer.dispose());
  const manifest = await renderer.builtInManifest();
  const catalog = manifest.catalogSnapshot();
  catalog.modelId = skinId;
  if (mapped) catalog.items = DEFAULT_AUTOMATIC_IDS.map(id => ({ id, label: id, category: 'idle',
    source: 'procedural', availability: 'automatic', defaultEnabled: true, previewable: true }));
  renderer.bindSkin(new SkinBinding({ ...manifest, skinId, catalog }));
  await renderer.loadRig(renderer.options.readAsset);
  renderer.ready = true;
  renderer.last = clock;
  // Real Cubism Core, motions and physics; only the GPU draw is excluded here.
  renderer.draw = () => {};
  return renderer;
}
const view = { state: 'idle', mouth: 0, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
function frames(renderer, seconds, state = view) {
  const samples = [];
  for (let frame = 0; frame < seconds * 30; frame++) {
    clock += 1000 / 30;
    renderer.updateView(state);
    if (frame % 15 === 0) samples.push(renderer.snapshot());
  }
  assert.ok([...renderer._model.getModel().parameters.values].every(Number.isFinite), 'all rig parameters stay finite');
  return samples;
}
function moving(samples) {
  return new Set(samples.map(sample => sample.body.toFixed(4))).size > 2;
}

test('unmapped Hiyori keeps moving after delayed empty policy and speech ends', async t => {
  const renderer = await rig(t);
  assert.ok(moving(frames(renderer, 120)));
  assert.equal(renderer.setAutomaticPolicy({ modelId: 'local-model', revision: 0, enabledIds: [] }), true);
  assert.equal(renderer.setAutomaticPolicy({ modelId: 'local-model', revision: 0, enabledIds: [] }), true, 'policy replay stays idempotent');
  frames(renderer, 10, { ...view, state: 'speaking', mouth: .5 });
  renderer.reset();
  assert.ok(moving(frames(renderer, 12)), 'empty preset policy must not freeze basic idle after playback');
  assert.equal(renderer.snapshot().mouth, 0, 'mouth closes when playback ends');
});

test('mapped basic animation switches still honor explicit disable and re-enable', async t => {
  const renderer = await rig(t, true);
  renderer.setAutomaticPolicy({ modelId: 'local-model', revision: 1, enabledIds: [] });
  assert.equal(renderer.setAutomaticPolicy({ modelId: 'outgoing-skin', revision: 99, enabledIds: DEFAULT_AUTOMATIC_IDS }), false);
  assert.equal(moving(frames(renderer, 12)), false, 'explicit off stays off');
  renderer.setAutomaticPolicy({ modelId: 'local-model', revision: 2, enabledIds: DEFAULT_AUTOMATIC_IDS });
  assert.ok(moving(frames(renderer, 12)), 'explicit on resumes motion');
});

test('policy for an outgoing skin cannot freeze a new rig', async t => {
  const renderer = await rig(t, false, 'imported-hiyori');
  assert.equal(renderer.setAutomaticPolicy({ modelId: 'local-model', revision: 0, enabledIds: [] }), false);
  assert.ok(moving(frames(renderer, 12)), 'foreign policy is rejected without changing the current skin');
});

test('real idle survives 30 minutes of loops and repeated playback/reset/stroke', async t => {
  const renderer = await rig(t);
  renderer.setAutomaticPolicy({ modelId: 'local-model', revision: 0, enabledIds: [] });
  for (let minute = 0; minute < 30; minute++) {
    frames(renderer, 5, { ...view, state: 'speaking', mouth: .5 });
    renderer.reset();
    renderer.stroke();
    assert.ok(moving(frames(renderer, 55)), `idle still moves at minute ${minute + 1}`);
    assert.equal(renderer.snapshot().mouth, 0);
  }
});

test('Haru real rig consumes every shared character state without expressions or named Idle group', async t => {
  clock = 0;
  const source = process.env.AIKI_HARU_SOURCE ?? 'C:/Users/Public/Downloads/haru_greeter_ja';
  const scratch = await mkdtemp(join(tmpdir(), 'haru-states-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const store = await SkinStore.open(join(scratch, 'skins.json'), join(scratch, 'packs'), desktop);
  await store.import(source, { skinId: 'haru-states', entry: 'runtime/haru_greeter_t05.model3.json' });
  const renderer = new JellyfishRenderer(null);
  t.after(() => renderer.dispose());
  renderer.bindSkin(store.manifest('haru-states'));
  await renderer.loadRig(path => readFile(store.routes('haru-states').get(path)));
  renderer.ready = true; renderer.last = clock; renderer.draw = () => {};
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'working', 'happy', 'sleeping', 'listening', 'idle']) {
    frames(renderer, 3, { ...view, state, characterState: state, mouth: .5 });
    assert.equal(renderer.snapshot().characterState, state);
    assert.equal(renderer.snapshot().mouth > 0, state === 'speaking');
    if (state === 'sleeping') assert.ok(renderer.get('ParamEyeLOpen') < .1);
    if (state === 'happy') assert.ok(renderer.get('ParamMouthForm') > .5);
  }
});

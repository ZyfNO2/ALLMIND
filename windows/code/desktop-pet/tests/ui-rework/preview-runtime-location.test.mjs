// LUI-05: the shared Cubism/Sprite preview runtime must live OUTSIDE the retired console directory.
//
// Why this test exists: `management/ui/` is the legacy management console that LUI-07 deletes. The
// preview bundle used to be compiled into it (`management/ui/presentation-preview.js`), and the React
// resource dialog loaded it from the same-origin URL `/presentation-preview.js`. Deleting the legacy
// directory would therefore have silently broken Live2D/Sprite preview in the NEW UI — a retirement
// that removes a capability the replacement still needs.
//
// The assertions below pin the two halves of the fix: the artifact is produced at its new path and is
// NOT produced at the old one, and the production HTTP surface serves it from the fixed new route while
// refusing the old one. They intentionally do not re-test pixel rendering — that is
// `tests/management/presentation-preview-ui.test.mjs`, which drives the real renderer through a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js';

const NEW_ARTIFACT = resolve('management/preview-runtime/presentation-preview.js');
const OLD_ARTIFACT = resolve('management/ui/presentation-preview.js');
const NEW_ROUTE = '/preview-runtime/presentation-preview.js';
const OLD_ROUTE = '/presentation-preview.js';

test('shared preview runtime is built outside the retired console directory and only there', () => {
  assert.ok(existsSync(NEW_ARTIFACT), 'the shared preview bundle must be built at management/preview-runtime/presentation-preview.js');
  assert.equal(existsSync(OLD_ARTIFACT), false, 'the shared preview bundle must no longer be produced inside the retired management/ui directory');
  // The bundle is a real esbuild product with the two factory exports the consumers import.
  const source = readFileSync(NEW_ARTIFACT, 'utf8');
  assert.match(source, /createSkinPreview/, 'the shared factory createSkinPreview must still be exported');
  assert.match(source, /createPresentationPreview/, 'the shared factory createPresentationPreview must still be exported');
});

test('the fixed route maps the new artifact and never the old console path', async () => {
  const routes = await presentationAssetRoutes(resolve('../..'));
  assert.equal(routes.get(NEW_ROUTE), NEW_ARTIFACT, 'the new fixed route must resolve to the shared artifact');
  assert.equal(routes.has(OLD_ROUTE), false, 'the retired console path must not be a served route');
  // Core and shaders keep their own fixed same-origin routes; moving the bundle must not disturb them.
  assert.ok(routes.get('/presentation-runtime/core.js'), 'the Cubism core route must survive the move');
  assert.ok([...routes.keys()].some(key => key.startsWith('/presentation-shaders/')), 'the shader routes must survive the move');
});

test('no production or test source still loads the retired preview URL', () => {
  // CUX-01: the preview engine moved out of the import dialog into the shared preview service, which is
  // now the only in-app consumer. The guarantee travels with it: load the NEW route, never the old one.
  const consumers = [
    'management/character-ui/src/services/skin-preview.ts',
    'tests/management/presentation-preview-scenario.mjs',
  ];
  for (const file of consumers) {
    const source = readFileSync(resolve(file), 'utf8');
    assert.doesNotMatch(source, /['"]\/presentation-preview\.js['"]/, `${file} must load the shared runtime from ${NEW_ROUTE}, not the retired ${OLD_ROUTE}`);
    assert.match(source, new RegExp(NEW_ROUTE.replace(/[/.]/g, '\\$&')), `${file} must reference the new fixed route`);
  }
});

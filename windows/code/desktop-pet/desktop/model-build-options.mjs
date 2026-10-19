import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Keep a private rig's mapping alongside its ignored assets, leaving the shared default editable.
export const modelPlugins = [{ name: 'local-model-parameters', setup(build) {
  const path = fileURLToPath(new URL('./assets/local-model/parameter-map.json', import.meta.url));
  if (existsSync(path)) build.onResolve({ filter: /^\.\/config\/parameter-map\.json$/ }, () => ({ path }));
  const framework=fileURLToPath(new URL('./vendor/cubism/Framework/src/live2dcubismframework.ts',import.meta.url)),core=fileURLToPath(new URL('./vendor/cubism/Core/live2dcubismcore.min.js',import.meta.url));
  if(!existsSync(framework)||!existsSync(core)){
    process.stderr.write('ALLMIND build: Cubism SDK absent; static portraits are enabled. Live2D requires the authorized SDK and a rebuild.\n');
    build.onResolve({filter:/^\.\/cubism-renderer\.mjs$/},()=>({path:fileURLToPath(new URL('./cubism-unavailable.mjs',import.meta.url))}));
  }
  if(!existsSync(fileURLToPath(new URL('./assets/local-model/presets.json',import.meta.url))))build.onResolve({filter:/^\.\/assets\/local-model\/presets\.json$/},()=>({path:fileURLToPath(new URL('../config/presets.example.json',import.meta.url))}));
} }];

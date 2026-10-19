import {build} from 'esbuild';
import {modelPlugins} from './model-build-options.mjs';
import {fileURLToPath} from 'node:url';
// LUI-05: the bundle is a SHARED runtime (the React resource dialog and the presentation tool both
// import it), not part of the legacy console. It used to be emitted into `management/ui/`, which meant
// retiring that directory would have deleted a module the new UI still loads. The single served URL is
// `/preview-runtime/presentation-preview.js` (see management/server.ts and presentationAssetRoutes).
const entry=fileURLToPath(new URL('./presentation-preview.mjs',import.meta.url));
await build({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',target:['safari17','chrome130'],outfile:fileURLToPath(new URL('../management/preview-runtime/presentation-preview.js',import.meta.url)),legalComments:'eof',plugins:modelPlugins});

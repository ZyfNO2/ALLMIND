import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import vm from 'node:vm';
import {SkinStore} from '../../dist/management/skin-store.js';
import {presentationAssetRoutes} from '../../dist/management/presentation-assets.js';

test('clean source without a private default model loads the bundled static ALLMIND logo',async t=>{
 mkdirSync('.local/w02-review',{recursive:true});const root=resolve(mkdtempSync('.local/w02-review/release-')),desktop=join(root,'desktop');mkdirSync(join(desktop,'assets/allmind'),{recursive:true});
 t.after(()=>rmSync(root,{recursive:true,force:true}));copyFileSync('desktop/assets/allmind/icon-256.png',join(desktop,'assets/allmind/icon-256.png'));
 const store=await SkinStore.open(join(root,'skins.json'),join(root,'packs'),desktop),manifest=store.manifest(store.state().activeSkinId);
 assert.equal(manifest.type,'sprite');assert.equal(manifest.sprite.width,256);assert.equal(manifest.sprite.frameCount,1);assert.equal(manifest.catalog.items.some(row=>row.defaultEnabled),false);assert.ok(store.routes(manifest.skinId).has('icon-256.png'));
 const routes=await presentationAssetRoutes(root);assert.equal(routes.size,1);assert.ok(routes.has('/preview-runtime/presentation-preview.js'));
 mkdirSync(join(desktop,'assets/local-model'));await assert.rejects(SkinStore.open(join(root,'broken.json'),join(root,'packs'),desktop),/内建形象无法载入/,'an existing corrupt private model must not silently switch to the logo');
});

test('an SDK-free build explicitly supports sprite-only mode and refuses Live2D construction',async t=>{
 mkdirSync('.local/w02-review',{recursive:true});const root=resolve(mkdtempSync('.local/w02-review/static-build-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const file of ['model-build-options.mjs','cubism-unavailable.mjs'])copyFileSync('desktop/'+file,join(root,file));
 const {modelPlugins}=await import(pathToFileURL(join(root,'model-build-options.mjs')).href);
 const result=await build({stdin:{contents:"import {JellyfishRenderer} from './cubism-renderer.mjs'; export const create=()=>new JellyfishRenderer();",resolveDir:root},bundle:true,write:false,format:'cjs',platform:'browser',plugins:modelPlugins});
 const context={module:{exports:{}}};vm.runInNewContext(result.outputFiles[0].text,context);assert.throws(()=>context.module.exports.create(),/未安装 Cubism SDK/);
});

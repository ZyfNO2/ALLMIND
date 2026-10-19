import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {SkinStore} from '../../dist/management/skin-store.js';

test('explicit role contribution survives real sprite import, publication and registry reopen',{timeout:45000},async()=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const root=resolve(mkdtempSync('.local/ui-v4/tests/import-declaration-'));
  const image=resolve('tests/companion-knowledge/fixtures/ocr/blank.png'),hash=createHash('sha256').update(readFileSync(image)).digest('hex');
  const declaration={schemaVersion:'local-pet/v1',skinId:'explicit-role',assetFingerprint:hash,bindings:{feeding:{kind:'sprite',targetId:'happy'}}};
  let store=await SkinStore.open(join(root,'registry.json'),join(root,'packs'),resolve('desktop'));
  await store.import(image,{type:'sprite',skinId:'explicit-role',sprite:{clips:{happy:{start:0,frameCount:1}}},localInteractions:declaration});
  assert.deepEqual(store.manifest('explicit-role').localInteractions,declaration);
  assert.deepEqual(JSON.parse(store.routes('explicit-role').get('pet.skin.json').body).localInteractions,declaration);
  store=await SkinStore.open(join(root,'registry.json'),join(root,'packs'),resolve('desktop'));
  assert.deepEqual(store.manifest('explicit-role').localInteractions,declaration);
  await store.import(image,{type:'sprite',skinId:'generic-role',sprite:{clips:{happy:{start:0,frameCount:1}}}});
  assert.equal(store.manifest('generic-role').localInteractions,undefined);
  await assert.rejects(store.import(image,{type:'sprite',skinId:'invalid-role',localInteractions:{...declaration,skinId:'invalid-role',assetFingerprint:'f'.repeat(64)}}));
  assert.ok(!store.list().some(row=>row.skinId==='invalid-role'));
});

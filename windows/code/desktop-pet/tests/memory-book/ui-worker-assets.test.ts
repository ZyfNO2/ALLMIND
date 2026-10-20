import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {characterUiAsset} from '../../management/character-ui-static.js';
test('built graph Worker chunks are served as JavaScript without exposing arbitrary project files',t=>{
 const root=mkdtempSync(join(tmpdir(),'allmind-worker-assets-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'character-app','assets'),{recursive:true});writeFileSync(join(root,'character-app','index.html'),'test');writeFileSync(join(root,'character-app','assets','graph.worker-hash.js'),'self.postMessage({ok:true})');writeFileSync(join(root,'character-app','assets','private.txt'),'private');
 assert.equal(characterUiAsset(root,'/assets/graph.worker-hash.js')?.mime,'text/javascript; charset=utf-8');
 writeFileSync(join(root,'character-app','assets','Saira-hash.ttf'),'font-fixture');
 assert.equal(characterUiAsset(root,'/assets/Saira-hash.ttf')?.mime,'font/ttf');
 assert.equal(characterUiAsset(root,'/assets/../Saira-hash.ttf'),null);
 assert.equal(characterUiAsset(root,'/assets/private.txt'),null);assert.equal(characterUiAsset(root,'/assets/../../private.js'),null);assert.equal(characterUiAsset(root,'/src/main.tsx'),null);
});

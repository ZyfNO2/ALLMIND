import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {interactionBindings,saveInteractionSettings} from '../../core/book-interactions.js';
import {startPetAction,advancePetAction} from '../../core/local-pet-action.js';
import type {SkinManifest} from '../../contracts/skin.js';

const scope={characterId:'aika',pairingId:'local-user',sessionId:'desktop'};
const manifest={type:'sprite',skinId:'declared',assetFingerprint:'a'.repeat(64),sprite:{clips:{happy:{start:0,frameCount:2}}},catalog:{items:[]}} as unknown as SkinManifest;
function fixture(t:test.TestContext){mkdirSync('.local/ui-v4/tests',{recursive:true});const repo=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/declaration-'));t.after(()=>repo.close());return repo;}

test('a generic happy resource and old user mapping cannot invent a feeding interaction',t=>{
  const repo=fixture(t),data=repo.loadCompanionData(scope);
  data.interactionSettings={revision:1,skinId:manifest.skinId,assetFingerprint:manifest.assetFingerprint,bindings:{touch:null,feed:'clip:happy',gift:null}};
  repo.saveCompanionData(scope,data);
  assert.equal(interactionBindings(repo,scope,manifest).bindings.feed,null);
  assert.throws(()=>saveInteractionSettings(repo,scope,manifest,{...data.interactionSettings!,bindings:{touch:null,feed:null,gift:'clip:happy'}},1),{code:'invalid_input'});
});

test('only the specifically declared role interaction may be mapped and resource changes invalidate it',t=>{
  const repo=fixture(t);
  const declared:SkinManifest={...manifest,localInteractions:{schemaVersion:'local-pet/v1',skinId:manifest.skinId,assetFingerprint:manifest.assetFingerprint,bindings:{feeding:{kind:'sprite',targetId:'happy'}}}};
  const settings={skinId:manifest.skinId,assetFingerprint:manifest.assetFingerprint,bindings:{touch:null,feed:'clip:happy',gift:null}};
  saveInteractionSettings(repo,scope,declared,settings,0);
  assert.equal(interactionBindings(repo,scope,declared).bindings.feed,'clip:happy');
  assert.equal(interactionBindings(repo,scope,declared).bindings.gift,null);
  assert.throws(()=>saveInteractionSettings(repo,scope,declared,{...settings,bindings:{...settings.bindings,gift:'clip:happy'}},1),{code:'invalid_input'});
  assert.throws(()=>interactionBindings(repo,scope,{...declared,assetFingerprint:'b'.repeat(64)}));
});

test('missing animation cannot finish as a successful action',()=>{
  const missing=startPetAction(null,'feeding','missing',100,'missing');
  const result=advancePetAction(missing,4000,false);
  assert.equal(result.completed,null);
  assert.equal(result.cancelled?.id,'missing');
});

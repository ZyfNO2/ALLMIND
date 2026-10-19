import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetAction, advancePetAction } from '../../core/local-pet-action.js';
import { CompanionBehavior, arbitrateCompanionPresentation, createCompanionLifeState } from '../../core/companion-behavior.js';
import { CharacterPointerRouter } from '../../desktop/pointer-router.js';
import {surfaceAt,dockPosition,movePet,reachableWindow} from '../../desktop/electron/pet-geometry.js';
import {resolveLocalPetSlot,type LocalPetInteractionPack} from '../../contracts/local-pet.js';
import type {SkinManifest} from '../../contracts/skin.js';

test('actions coalesce, missing animation cancels and interruption never completes', () => {
  const action=startPetAction(null,'petting','a',100,'missing');
  const extended=startPetAction(action,'petting','b',200,'missing');
  assert.equal(extended.id,'a');
  assert.equal(advancePetAction(extended,500,false).completed,null);
  assert.equal(advancePetAction(extended,500,true).cancelled?.id,'a');
  assert.equal(advancePetAction(extended,3000,false).completed,null);
  assert.equal(advancePetAction(extended,3000,false).cancelled?.presentation,'missing');
  assert.equal(advancePetAction(extended,50,false).cancelled?.id,'a');
});
test('one arbiter preserves dialogue and quiet priority over local actions', () => {
  const life=createCompanionLifeState({characterId:'a',pairingId:'p'},100);
  const action=startPetAction(null,'playing','a',100,'missing');
  assert.equal(arbitrateCompanionPresentation({state:'idle'},life,200,{action}).localActivity,'playing');
  assert.equal(arbitrateCompanionPresentation({state:'thinking'},life,200,{action}).characterState,'thinking');
  life.quiet=true;
  assert.notEqual(arbitrateCompanionPresentation({state:'idle'},life,200,{action}).localActivity,'playing');
});
test('head hold strokes continuously; quick movement drags; cancellation never completes', () => {
  const calls:string[]=[];
  const router=new CharacterPointerRouter({panel:()=>{},stroke:()=>calls.push('tap'),drag:()=>calls.push('drag'),gesture:(kind,phase)=>calls.push(`${kind}:${phase}`)});
  router.pointerDown({pointerId:1,screenX:0,screenY:0,timeStamp:100,region:'head'});
  router.pointerMove({pointerId:1,screenX:2,screenY:0,timeStamp:450});
  router.pointerMove({pointerId:1,screenX:20,screenY:0,timeStamp:500});
  router.pointerUp({pointerId:1,timeStamp:550});
  assert.deepEqual(calls,['petting:start','petting:update','petting:complete']);
  calls.length=0;
  router.pointerDown({pointerId:2,screenX:0,timeStamp:100,region:'head'});
  router.pointerMove({pointerId:2,screenX:20,timeStamp:150});
  router.pointerCancel({pointerId:2});
  assert.deepEqual(calls,['dragging:start','drag','dragging:cancel']);
});
test('docking follows negative-coordinate surfaces, rejects occlusion and limits jump reach',()=>{
  const windows=[{id:'a',pid:1,x:-800,y:300,width:600,height:400}];
  assert.equal(surfaceAt(windows,-500,310)?.id,'a');
  assert.deepEqual(dockPosition(windows,{id:'a',ratio:.5},200),{x:-500,y:100});
  assert.equal(dockPosition([{id:'front',pid:2,x:-600,y:100,width:400,height:400},...windows],{id:'a',ratio:.5},200),null);
  assert.equal(dockPosition([],{id:'a',ratio:.5},200),null);
  assert.equal(reachableWindow(windows,{x:-500,y:1000},null),null);
  assert.deepEqual(movePet({x:0,y:0},{x:100,y:0},1000),{x:10,y:0});
});
test('local summaries deduplicate independently of rewards, persist and clear',()=>{
  const life=new CompanionBehavior(createCompanionLifeState({characterId:'a',pairingId:'p'},100));
  assert.throws(()=>life.completeLocalAction('missing','petting',100,'missing'));
  assert.equal(life.completeLocalAction('a','petting',100,'played'),true);
  assert.equal(life.completeLocalAction('a','petting',100,'played'),false);
  assert.equal(life.completeLocalAction('b','petting',101,'played'),true);
  const restored=new CompanionBehavior(life.snapshot());
  assert.equal(restored.snapshot().localHistory?.length,2);
  assert.throws(()=>restored.completeLocalAction('c','playing',102,'failed'));
  restored.clearLocalHistory();assert.deepEqual(restored.snapshot().localHistory,[]);
});
test('role interaction contract defaults to placeholders and refuses stale or nonexistent resources',()=>{
  const manifest={type:'sprite',skinId:'test',assetFingerprint:'a'.repeat(64),sprite:{clips:{happy:{start:0,frameCount:1}}}} as SkinManifest;
  const pack:LocalPetInteractionPack={schemaVersion:'local-pet/v1',skinId:manifest.skinId,assetFingerprint:manifest.assetFingerprint,bindings:{feeding:{kind:'sprite',targetId:'happy'},playing:null}};
  assert.equal(resolveLocalPetSlot(null,manifest,'feeding').availability,'placeholder');
  assert.equal(resolveLocalPetSlot(pack,manifest,'feeding').availability,'available');
  assert.equal(resolveLocalPetSlot(pack,manifest,'playing').availability,'placeholder');
  assert.throws(()=>resolveLocalPetSlot({...pack,assetFingerprint:'b'.repeat(64)},manifest,'feeding'));
  assert.throws(()=>resolveLocalPetSlot({...pack,bindings:{feeding:{kind:'sprite',targetId:'missing'}}},manifest,'feeding'));
  const pending=startPetAction(null,'feeding','load',100,'loading');
  assert.equal(advancePetAction(pending,3000,false).completed,null);
  const coalesced=startPetAction(pending,'feeding','other',200,'missing');assert.equal(coalesced.presentation,'loading');
});

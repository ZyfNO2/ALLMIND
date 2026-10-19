import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {CompanionBehavior,createCompanionLifeState,validateCompanionLife,arbitrateCompanionPresentation} from '../../core/companion-behavior.js';
import {interactionChoices,interactionBindings,saveInteractionSettings} from '../../core/book-interactions.js';
import type {SkinManifest} from '../../contracts/skin.js';
const scope={characterId:'aika',pairingId:'local-user',sessionId:'desktop'},start=Date.parse('2026-10-15T01:00:00Z');
const genericManifest:SkinManifest={type:'sprite',schemaVersion:1,skinId:'test',label:'合成资源声明',modelEntry:'atlas.png',modelFingerprint:'a'.repeat(64),assetFingerprint:'b'.repeat(64),parameters:{headYaw:'yaw',headPitch:'pitch',headRoll:'roll',mouthForm:'mouth'},catalog:{schemaVersion:1,modelId:'test',modelFingerprint:'a'.repeat(64),items:[]},capabilities:{textures:1,expressions:0,motions:0,presets:'generated-disabled',automaticPresets:0,mocVersion:0},revision:1,sprite:{rows:1,columns:2,frameCount:2,fps:8,width:100,height:50,clips:{happy:{start:0,frameCount:2,fps:8}}}};
const manifest:SkinManifest={...genericManifest,localInteractions:{schemaVersion:'local-pet/v1',skinId:genericManifest.skinId,assetFingerprint:genericManifest.assetFingerprint,bindings:{petting:{kind:'sprite',targetId:'happy'},feeding:{kind:'sprite',targetId:'happy'}}}};
function fixture(t:test.TestContext){mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/interactions-'));t.after(()=>{repository.close();rmSync(repository.directory,{recursive:true,force:true})});return repository}

test('interaction feedback has persistent cooldown and 24h cap, with no offline or undo refund',()=>{
 const life=new CompanionBehavior(createCompanionLifeState(scope,start));let now=start;
 for(let i=0;i<12;i++){const result=life.interact(i%2?'feed':'gift','interaction.'+i,now);assert.equal(result.applied,true);assert.ok(result.state.mood>=50&&result.state.mood<=100);now+=31000}
 assert.equal(life.interact('touch','too-many',now).applied,false);assert.equal(life.snapshot().interactions!.length,12);
 life.undoInteraction('interaction.11',now);assert.equal(life.interactionAllowance(now).allowed,false);
 const restored=new CompanionBehavior(life.snapshot());assert.equal(restored.interactionAllowance(now).allowed,false);assert.equal(restored.interactionAllowance(start-1).allowed,false);
 assert.equal(restored.interact('touch','later',start+86400001).applied,true);assert.ok(restored.snapshot().interactions!.length<=12);
});
test('rapid pointer taps and id retries do not add feedback; undo removes precisely the decayed contribution',()=>{
 const life=new CompanionBehavior(createCompanionLifeState(scope,start));life.interact('touch','first',start);
 for(let i=1;i<50;i++)life.touch(start+i*10);assert.equal(life.snapshot().interactions!.length,1);assert.equal(life.interact('touch','first',start+1000).applied,false);assert.throws(()=>life.interact('gift','first',start+2000));
 life.interact('gift','second',start+31000);life.tick(start+45000,true);life.undoInteraction('first',start+50000);life.undoInteraction('second',start+51000);assert.ok(Math.abs(life.snapshot().mood-50)<1e-8);assert.equal(life.snapshot().energy>0,true);
 life.undoInteraction('second',start+52000);assert.ok(Math.abs(life.snapshot().mood-50)<1e-8);assert.equal(life.snapshot().interactions!.length,2);assert.equal(life.interact('gift','second',start+60000).applied,false);
 const dialogue=arbitrateCompanionPresentation({state:'thinking',characterId:'aika'},life.snapshot(),start+52000);assert.equal(dialogue.characterState,'thinking');
});
test('short-term interaction contribution ages across suspend/restart while absence never debits trust or base mood',()=>{
 const life=new CompanionBehavior(createCompanionLifeState(scope,start));life.interact('gift','before-suspend',start);const restored=new CompanionBehavior(life.snapshot());
 restored.tick(start+7*86400000,true);assert.ok(Math.abs(restored.snapshot().mood-50)<1e-8);assert.equal(restored.snapshot().interactions![0]!.delta,0);assert.equal(restored.interactionAllowance(start+7*86400000).allowed,true);
});
test('only declared resources are choices, unavailable and outfit controls cannot be mapped',()=>{
 assert.deepEqual(interactionChoices(manifest).map(row=>row.id),['clip:happy']);assert.deepEqual(interactionChoices({...manifest,sprite:{...manifest.sprite!,clips:{}}}),[]);
 const item={id:'wave',label:'挥手',category:'pose' as const,source:'model-motion' as const,availability:'manual' as const,defaultEnabled:false,previewable:true,motionGroup:'Tap',motionIndex:0};
 const live={...manifest,type:'live2d' as const,catalog:{...manifest.catalog,items:[item,{...item,id:'outfit',category:'appearance' as const},{...item,id:'missing',availability:'unavailable' as const},{...item,id:'procedural',source:'procedural' as const}]}};
 assert.deepEqual(interactionChoices(live).map(row=>row.id),['preset:wave']);
});
test('resource-bound mappings persist privately with revisions and reject stale resources or missing targets',t=>{
 const repository=fixture(t),settings={skinId:manifest.skinId,assetFingerprint:manifest.assetFingerprint,bindings:{touch:'clip:happy',feed:'clip:happy',gift:null}};
 const saved=saveInteractionSettings(repository,scope,manifest,settings,0);assert.equal(saved.interactionSettings!.revision,1);assert.deepEqual(saveInteractionSettings(repository,scope,manifest,settings,0),saved);
 assert.equal(interactionBindings(repository,scope,manifest).bindings.feed,'clip:happy');assert.equal(interactionBindings(repository,{...scope,pairingId:'other'},manifest).settings,null);
 assert.equal(interactionBindings(repository,scope,{...genericManifest,assetFingerprint:'c'.repeat(64)}).matched,false);assert.equal(interactionBindings(repository,scope,{...genericManifest,assetFingerprint:'c'.repeat(64)}).bindings.feed,null);
 assert.throws(()=>saveInteractionSettings(repository,scope,manifest,{...settings,bindings:{...settings.bindings,feed:null}},0),{code:'conflict'});
 assert.throws(()=>saveInteractionSettings(repository,scope,manifest,{...settings,bindings:{...settings.bindings,feed:'clip:missing'}},1),{code:'invalid_input'});
 assert.throws(()=>saveInteractionSettings(repository,scope,{...genericManifest,assetFingerprint:'c'.repeat(64)},settings,1),{code:'conflict'});assert.equal(repository.snapshot(scope).entries.length,0);
});
test('Book life owner persists actual feedback and undo without altering other instances or authored facts',t=>{
 const repository=fixture(t),life=new CompanionBehavior(createCompanionLifeState(scope,start));life.interact('feed','feed-one',start);const state=life.snapshot();life.saved(repository.saveCompanionLife(scope,state,state.revision));
 const recovered=new CompanionBehavior(repository.loadCompanionLife(scope)!);assert.equal(recovered.snapshot().interactions![0]!.kind,'feed');assert.equal(repository.loadCompanionLife({...scope,pairingId:'other'}),null);recovered.undoInteraction('feed-one',start+1000);const undone=recovered.snapshot();repository.saveCompanionLife(scope,undone,undone.revision);assert.ok(Math.abs(repository.loadCompanionLife(scope)!.mood-50)<1e-8);assert.equal(repository.snapshot(scope).entries.length,0);
 assert.throws(()=>validateCompanionLife({...undone,interactions:[{id:'bad',kind:'touch',at:start,delta:NaN,undone:false}]}));
});

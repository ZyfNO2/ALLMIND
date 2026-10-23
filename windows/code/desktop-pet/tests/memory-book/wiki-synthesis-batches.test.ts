import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {WikiSynthesisService} from '../../memory/wiki-synthesis.js';
import {emptyEntry} from '../../contracts/memory-book.js';
import type {SynthesisTask,SynthesisResult} from '../../contracts/wiki-synthesis.js';
import {mergeSynthesisBatches,synthesisBatches} from '../../memory/wiki-synthesis-batches.js';

const scope={characterId:'aika',pairingId:'local-user',sessionId:'batch-test'};
function answer(task:SynthesisTask):SynthesisResult{
  return {schemaVersion:'allmind-wiki/v1',inputHash:task.inputHash,pages:[{id:'topic',title:'测试主题 '+task.materials[0]!.id,domain:'external',pageType:'topic',paragraphs:[{text:'合成资料综合',evidence:task.materials.map(row=>({entryId:row.id,quote:row.body}))}]}],relations:[],coverage:task.materials.map(row=>({entryId:row.id,pageIds:['topic'],reason:''}))};
}
test('same-title cross-batch topics merge exact evidence, coverage and relations without inventing links',()=>{
 const task:SynthesisTask={protocol:'allmind-wiki-task/v1',inputHash:'a'.repeat(64),scope,view:null,existingPages:[],materials:[
  {id:'a',title:'A',body:'A explicitly supports topic and detail.',type:'wiki',domain:'external',knowledge:null,sourceIds:[]},
  {id:'b',title:'B',body:'B explicitly supports topic and detail.',type:'wiki',domain:'external',knowledge:null,sourceIds:[]},
 ]};
 const batches=synthesisBatches(task,1024),parts=batches.map(batch=>{
  const ref={entryId:batch.materials[0]!.id,quote:batch.materials[0]!.body};
  const result:SynthesisResult={schemaVersion:'allmind-wiki/v1',inputHash:batch.inputHash,pages:[
   {id:'topic',title:'共同主题',domain:'external',pageType:'topic',paragraphs:[{text:'共同主题的综合。',evidence:[ref]}]},
   {id:'detail',title:'相关细节',domain:'external',pageType:'topic',paragraphs:[{text:'资料明确包含的细节。',evidence:[ref]}]},
  ],relations:[{from:'topic',to:'detail',label:'包含细节',evidence:[ref]}],coverage:[{entryId:ref.entryId,pageIds:['topic','detail'],reason:''}]};
  return {task:batch,result};
 });
 const merged=mergeSynthesisBatches(task,parts);assert.equal(merged.pages.length,2);assert.equal(merged.relations.length,1);
 assert.deepEqual(new Set(merged.pages[0]!.paragraphs.flatMap(p=>p.evidence.map(r=>r.entryId))),new Set(['a','b']));
 assert.equal(merged.relations[0]!.evidence.length,2);assert.equal(merged.coverage.length,2);
 for(const row of merged.coverage)assert.deepEqual(new Set(row.pageIds),new Set(merged.pages.map(p=>p.id)));
 const conflicting=structuredClone(parts);conflicting[0]!.result.pages[0]!.pageType='entity';conflicting[1]!.result.pages[0]!.pageType='event';assert.throws(()=>mergeSynthesisBatches(task,conflicting),/页面类型冲突/);
 const typed=structuredClone(parts);for(const part of typed)part.result.pages[0]!.pageType='entity';assert.equal(mergeSynthesisBatches(task,typed).pages[0]!.pageType,'entity');
 const changed=structuredClone(parts);changed[1]!.result.pages[0]!.paragraphs[0]!.evidence[0]!.quote='invented';assert.throws(()=>mergeSynthesisBatches(task,changed),/逐字回查/);
});
for(const failure of [false,true])test('bounded synthesis '+(failure?'rejects a failed later batch without partial commit':'validates all batches and commits only after review'),async t=>{
  const repository=new FileBookRepository(mkdtempSync(join(tmpdir(),'wiki-batches-')));t.after(()=>repository.close());
  const config=repository.loadConfig();repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:1/v1',model:'fixture',credentialId:'fixture',inputTokens:64000,outputTokens:16384}},config.revision,'configure');
  repository.commit(scope,{upsert:Array.from({length:19},(_,index)=>emptyEntry('item-'+index,'wiki','合成资料'+index,'合成事实'+index))},0,'seed');
  let calls=0;
  const service=new WikiSynthesisService(repository,{async complete(_binding,messages){calls++;const task=JSON.parse(messages[1]!.content) as SynthesisTask;assert.ok(task.materials.length<=16);assert.match(messages[0]!.content,/完整 JSON Schema/);assert.equal(repository.snapshot(scope).entries.length,19);if(failure&&calls===2)throw Error('fixture output limit');return JSON.stringify(answer(task));}},()=>{},()=>false);
  const revision=repository.snapshot(scope).revision,job=service.prepare(scope,revision,'prepare');
  if(failure){await assert.rejects(service.run(scope,job.id,new AbortController().signal,60000,true),/fixture output limit/);assert.equal(service.get(scope,job.id).status,'failed');assert.equal(service.get(scope,job.id).result,null);assert.equal(repository.snapshot(scope).revision,revision);assert.equal(service.get(scope,job.id).batchProgress?.completed,1);await assert.rejects(service.run(scope,job.id,new AbortController().signal,60000,true),/不会自动重发/);assert.equal(calls,2);return;}
  const result=await service.run(scope,job.id,new AbortController().signal,60000,true);assert.equal(calls,2);assert.equal(result.status,'review');assert.equal(result.batchProgress?.completed,2);assert.equal(result.result?.coverage.length,19);assert.equal(repository.snapshot(scope).revision,revision);assert.equal(new Set(result.result!.pages.map(row=>row.id)).size,2);
  service.apply(scope,job.id,revision,'apply',true);assert.equal(repository.snapshot(scope).entries.filter(row=>row.synthesis).length,2);
});

test('checkpoint continuation survives restart, preserves validated batches and requires explicit failed-batch retry',async t=>{
 const repository=new FileBookRepository(mkdtempSync(join(tmpdir(),'wiki-checkpoint-')));t.after(()=>repository.close());
 const config=repository.loadConfig();repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:1/v1',model:'fixture',credentialId:'fixture',inputTokens:64000,outputTokens:1024}},0,'checkpoint-config');
 repository.commit(scope,{upsert:[emptyEntry('a','wiki','A','第一批事实'),emptyEntry('b','wiki','B','第二批事实'),emptyEntry('c','wiki','C','第三批事实')]},0,'checkpoint-input');
 const calls:string[]=[];let fail=true;
 const model={async complete(_binding:unknown,messages:{content:string}[]){const task=JSON.parse(messages[1]!.content) as SynthesisTask;calls.push(task.materials[0]!.id);if(task.materials[0]!.id==='b'&&fail)throw Error('synthetic lost response');return JSON.stringify(answer(task));}};
 let service=new WikiSynthesisService(repository,model,()=>{},()=>false);const job=service.prepare(scope,1,'checkpoint-prepare');
 await assert.rejects(service.run(scope,job.id,new AbortController().signal,60000,true),/lost response/);
 assert.deepEqual(calls,['a','b']);assert.equal(service.get(scope,job.id).checkpoints?.[0]?.result?.pages.length,1);
 service=new WikiSynthesisService(repository,model,()=>{},()=>false);
 await assert.rejects(service.continue(scope,job.id,new AbortController().signal,60000,true,false),/未确认完成/);assert.deepEqual(calls,['a','b']);
 fail=false;const result=await service.continue(scope,job.id,new AbortController().signal,60000,true,true);
 assert.deepEqual(calls,['a','b','b','c']);assert.equal(result.result?.coverage.length,3);assert.equal(result.status,'review');assert.equal(result.checkpoints?.[1]?.attempts[0]?.error,'synthetic lost response');assert.equal(repository.snapshot(scope).revision,1);
});
test('explicit failed-batch correction sends the untouched rejected draft and validation error without resending successful batches',async t=>{
 const repository=new FileBookRepository(mkdtempSync(join(tmpdir(),'wiki-correction-')));t.after(()=>repository.close());const config=repository.loadConfig();repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:1/v1',model:'fixture',credentialId:'fixture',inputTokens:64000,outputTokens:1024}},0,'correction-config');repository.commit(scope,{upsert:[emptyEntry('a','wiki','A','真实原句A'),emptyEntry('b','wiki','B','真实原句B')]},0,'correction-source');
 const calls:string[]=[],rejected:string[]=[];const service=new WikiSynthesisService(repository,{async complete(_binding,messages){const task=JSON.parse(messages[1]!.content) as SynthesisTask,id=task.materials[0]!.id;calls.push(id);const result=answer(task);if(id==='b'&&calls.length===2){result.pages[0]!.paragraphs[0]!.evidence[0]!.quote='伪造引文';const raw=JSON.stringify(result);rejected.push(raw);return raw;}if(id==='b'){assert.equal(messages.length,3);const feedback=JSON.parse(messages[2]!.content);assert.equal(feedback.rejectedDraft,rejected[0]);assert.match(feedback.firstValidationError,/逐字回查/);assert.equal(task.materials[0]!.body,'真实原句B');}return JSON.stringify(result);}},()=>{},()=>false);
 const job=service.prepare(scope,1,'prepare-correction');await assert.rejects(service.run(scope,job.id,new AbortController().signal,60000,true),/逐字回查/);const result=await service.continue(scope,job.id,new AbortController().signal,60000,true,true);assert.deepEqual(calls,['a','b','b']);assert.equal(result.status,'review');assert.equal(result.checkpoints![1]!.attempts[0]!.response,rejected[0]);assert.notEqual(result.checkpoints![1]!.attempts[0]!.messageHash,result.checkpoints![1]!.attempts[1]!.messageHash);assert.equal(repository.snapshot(scope).revision,1);
});

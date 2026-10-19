import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {WikiSynthesisService} from '../../memory/wiki-synthesis.js';
import {emptyEntry} from '../../contracts/memory-book.js';
import type {SynthesisTask,SynthesisResult} from '../../contracts/wiki-synthesis.js';

const scope={characterId:'aika',pairingId:'local-user',sessionId:'batch-test'};
function answer(task:SynthesisTask):SynthesisResult{
  return {schemaVersion:'allmind-wiki/v1',inputHash:task.inputHash,pages:[{id:'topic',title:'测试主题 '+task.materials[0]!.id,domain:'external',paragraphs:[{text:'合成资料综合',evidence:task.materials.map(row=>({entryId:row.id,quote:row.body}))}]}],relations:[],coverage:task.materials.map(row=>({entryId:row.id,pageIds:['topic'],reason:''}))};
}
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

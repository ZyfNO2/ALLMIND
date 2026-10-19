import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../contracts/book-companion.js';
import {FactWikiService} from '../../memory/fact-wiki.js';

test('paused automatic memory persists pending work across restart and resumes exactly once',async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/pause-'));t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'queue'},config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},config.revision,'seed');
  const runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.automaticMemory!.setPaused(scope,true);await runtime.chat(scope,'饮品：乌龙茶',new AbortController().signal);await runtime.automaticMemory!.flush();
  assert.equal(repository.loadCompanionData(scope).jobs[0]!.status,'pending');assert.equal(repository.snapshot(scope).entries.length,0);
  repository.close();const reopened=new FileBookRepository(repository.directory);t.after(()=>reopened.close());const next=new BookRuntime(reopened,{async complete(){throw Error('declaration extraction must not call a model')}});
  next.automaticMemory!.recover(scope);await next.automaticMemory!.flush();assert.equal(reopened.snapshot(scope).entries.length,0);
  await next.automaticMemory!.setPaused(scope,false);await next.automaticMemory!.flush();assert.equal(reopened.loadCompanionData(scope).jobs[0]!.status,'done');assert.equal(reopened.snapshot(scope).entries.length,1);
  await next.automaticMemory!.setPaused(scope,false);await next.automaticMemory!.flush();assert.equal(reopened.loadCompanionData(scope).jobs[0]!.attempts,1);
});

test('pause cancels an in-flight extraction, rejects its late result, and restarts its pending job only after resume',async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/pause-flight-'));t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'queue'},config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},wikiModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true,extraction:'model',cloudMemoryConsent:true}},config.revision,'seed');
  let started!:()=>void;const running=new Promise<void>(resolve=>started=resolve);let calls=0;
  const runtime=new BookRuntime(repository,{async complete(_binding,_messages,signal,options){if(options?.purpose!=='wiki')return '好的';calls++;if(calls===1){started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}return JSON.stringify({claims:[{subject:'用户',predicate:'饮品',value:'乌龙茶',quote:'饮品：乌龙茶'}]});}});
  await runtime.chat(scope,'饮品：乌龙茶',new AbortController().signal);await running;await runtime.automaticMemory!.setPaused(scope,true);
  assert.equal(repository.snapshot(scope).entries.length,0);assert.equal(repository.loadCompanionData(scope).jobs[0]!.status,'pending');
  await runtime.automaticMemory!.setPaused(scope,false);await runtime.automaticMemory!.flush();assert.equal(calls,2);assert.equal(repository.snapshot(scope).entries.length,1);
});

test('pause also stops Wiki compilation and blocks review application until resumed',async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/pause-wiki-'));t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'queue'},wiki=new FactWikiService(repository),preview=wiki.preview(scope,{sourceId:'source',title:'用户',text:'称呼：小林',private:true});wiki.apply(scope,preview.id,'facts');
  const config=repository.loadConfig();repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},config.revision,'seed');
  let started!:()=>void;const running=new Promise<void>(resolve=>started=resolve);let calls=0;
  const runtime=new BookRuntime(repository,{async complete(_binding,messages,signal){calls++;if(calls===1){started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}const input=JSON.parse(messages[1]!.content);return JSON.stringify({pages:input.pages.map((page:any)=>({pageId:page.pageId,paragraphs:[{text:'用户称呼为小林。',entryIds:page.facts.map((fact:any)=>fact.id)}]}))});}}),maintenance=runtime.wikiMaintenance!;
  const job=maintenance.queue(scope,[repository.snapshot(scope).wikiPages![0]!.id],'queue');
  const generation=maintenance.run(scope,job.id,new AbortController().signal),rejected=assert.rejects(generation,/暂停/);await running;await maintenance.pause(scope);await rejected;
  assert.equal(maintenance.list(scope)[0]!.status,'pending');assert.equal(repository.snapshot(scope).wikiPages![0]!.compilation,undefined);
  await assert.rejects(maintenance.run(scope,job.id,new AbortController().signal),/暂停/);assert.equal(calls,1);
  await runtime.automaticMemory!.setPaused(scope,false);const reviewed=await maintenance.run(scope,job.id,new AbortController().signal);assert.equal(reviewed.status,'review');
  await maintenance.pause(scope);assert.throws(()=>maintenance.apply(scope,job.id,repository.snapshot(scope).revision,'apply'),/暂停/);
});

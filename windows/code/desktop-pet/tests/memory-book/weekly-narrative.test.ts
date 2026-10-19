import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../contracts/book-companion.js';
import type {BookModelPort} from '../../providers/book-model.js';
import {weeklyReview} from '../../memory/weekly-review.js';
const scope={characterId:'aika',pairingId:'local-user',sessionId:'week-review'};
function fixture(t:test.TestContext,model:BookModelPort){
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/week-narrative-'));
  t.after(()=>{repository.close();rmSync(repository.directory,{recursive:true,force:true})});const config=repository.loadConfig();
  repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:1/v1',model:'explicit-wiki',credentialId:'none',inputTokens:16384,outputTokens:2048},companion:{...DEFAULT_COMPANION_SETTINGS,cloudMemoryConsent:true}},config.revision,'config');
  const runtime=new BookRuntime(repository,model),preview=runtime.wiki.preview(scope,{sourceId:'week-source',title:'用户',text:'爱好：园艺',private:true});runtime.wiki.apply(scope,preview.id,'source');
  const input=()=>({confirmed:true,expectedRevision:repository.snapshot(scope).revision});return {repository,runtime,input};
}
test('manual weekly narrative sends only previewed effective excerpts to selected Wiki model and never writes a memory/turn',async t=>{
  let calls=0;const {repository,runtime,input}=fixture(t,{async complete(binding,messages,_signal,options){calls++;assert.equal(binding.model,'explicit-wiki');assert.equal(options?.purpose,'wiki');assert.equal(options?.json,true);const source=JSON.parse(messages.at(-1)!.content);assert.equal(source.memories.length,1);assert.equal(source.memories[0].value,'园艺');assert.equal(source.turns,undefined);assert.doesNotMatch(JSON.stringify(messages),/不应外发的聊天原文/);return JSON.stringify({items:[{text:'你分享了对园艺的兴趣。',entryIds:[source.memories[0].entryId]}]})}});
  repository.appendTurn(scope,{...scope,id:'chat',timestamp:new Date().toISOString(),user:'不应外发的聊天原文',assistant:'回复',traceId:'unused'});
  const before=repository.snapshot(scope),result=await runtime.narrateWeek(scope,input(),new AbortController().signal);
  assert.equal(calls,1);assert.equal(result.items.length,1);assert.equal(result.review.turns,1);assert.equal(result.model,'explicit-wiki');assert.deepEqual(repository.snapshot(scope),before);assert.equal(repository.readSession(scope).length,1);
});
test('weekly narrative empty, consent and stale revision gates stop before provider',async t=>{
  let calls=0;const {repository,runtime,input}=fixture(t,{async complete(){calls++;throw Error('must not send')}});
  await assert.rejects(runtime.narrateWeek(scope,{...input(),confirmed:false},new AbortController().signal),{code:'invalid_input'});
  await assert.rejects(runtime.narrateWeek(scope,{...input(),expectedRevision:0},new AbortController().signal),{code:'conflict'});
  const config=repository.loadConfig();repository.commitConfig({...config,companion:{...config.companion!,cloudMemoryConsent:false}},config.revision,'revoke-consent');
  await assert.rejects(runtime.narrateWeek(scope,input(),new AbortController().signal),{code:'unavailable'});
  runtime.wiki.revoke(scope,'week-source',input().expectedRevision,'revoke');const result=await runtime.narrateWeek(scope,input(),new AbortController().signal);assert.deepEqual(result.items,[]);assert.equal(result.model,null);assert.equal(calls,0);
});
test('weekly narrative refuses unknown references and malformed output without fallback or persistence',async t=>{
  for(const reply of ['not JSON',JSON.stringify({items:[{text:'猜测的经历',entryIds:['foreign-source']}]}),JSON.stringify({items:[{text:'无引文',entryIds:[]}]}),JSON.stringify({items:[],extra:'ignored'})]){
    const {repository,runtime,input}=fixture(t,{async complete(){return reply}}),before=repository.snapshot(scope);
    await assert.rejects(runtime.narrateWeek(scope,input(),new AbortController().signal),{code:'invalid_input'});assert.deepEqual(repository.snapshot(scope),before);assert.equal(repository.readSession(scope).length,0);
  }
});
test('revocation while narrative is generating cancels the late result and releases operation ownership',async t=>{
  let release!:(text:string)=>void,start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve});
  const {runtime,input,repository}=fixture(t,{complete(){start();return new Promise(resolve=>{release=resolve})}}),id=weeklyReview(repository,scope).memories[0]!.entryId;
  const pending=runtime.narrateWeek(scope,input(),new AbortController().signal);await started;
  runtime.wiki.revoke(scope,'week-source',input().expectedRevision,'revoke-mid-flight');runtime.invalidate(scope.characterId);release(JSON.stringify({items:[{text:'旧内容不得交付',entryIds:[id]}]}));await assert.rejects(pending,{code:'conflict'});assert.equal(runtime.isConversing(scope.characterId),false);
});
test('new saved chat invalidates narrative statistics even when the Book revision did not change',async t=>{
  let release!:(text:string)=>void;const {runtime,input,repository}=fixture(t,{complete(){return new Promise(resolve=>{release=resolve})}}),revision=input().expectedRevision,id=weeklyReview(repository,scope).memories[0]!.entryId;
  const pending=runtime.narrateWeek(scope,input(),new AbortController().signal);
  repository.appendTurn({...scope,sessionId:'other'},{...scope,sessionId:'other',id:'new',timestamp:new Date().toISOString(),user:'新聊天',assistant:'已收到',traceId:'none'});assert.equal(repository.snapshot(scope).revision,revision);
  release(JSON.stringify({items:[{text:'你分享了园艺。',entryIds:[id]}]}));await assert.rejects(pending,{code:'conflict'});
});

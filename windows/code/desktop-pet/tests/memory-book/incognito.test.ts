import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {DEFAULT_CHATGPT_WEB_SOURCE} from '../../contracts/memory-book.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../contracts/book-companion.js';
import {ChatgptWebModel} from '../../providers/chatgpt-web-model.js';

function fixture(t:test.TestContext){mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/private-'));t.after(()=>repository.close());const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},config.revision,'seed');return repository;}
const scope={characterId:'aika',pairingId:'local-user',sessionId:'private-chat'};
test('incognito replies and recent context remain volatile, replay once, and never reach Book, jobs, disk or public traces',async t=>{
  const repository=fixture(t);let calls=0,prompt='';const runtime=new BookRuntime(repository,{async complete(_binding,messages){calls++;prompt=JSON.stringify(messages);return 'private-answer-secret'}});
  const first=await runtime.chat(scope,'饮品：private-user-secret',new AbortController().signal,{turnId:'one',incognito:true});
  await runtime.chat(scope,'饮品：private-user-secret',new AbortController().signal,{turnId:'one',incognito:true});assert.equal(calls,1);
  await runtime.chat(scope,'继续',new AbortController().signal,{turnId:'two',incognito:true});assert.match(prompt,/private-user-secret/);
  assert.equal(repository.readSession(scope).length,0);assert.equal(repository.listSessions(scope.characterId,scope.pairingId).length,0);assert.equal(repository.snapshot(scope).entries.length,0);assert.equal(repository.loadCompanionData(scope).jobs.length,0);
  assert.throws(()=>runtime.trace(scope,first.turn.traceId),/不存在|过期/);
  assert.throws(()=>repository.appendTurn(scope,first.turn),/无痕/);
  for(const name of readdirSync(repository.directory).filter(name=>/\.jsonl?$/.test(name)))assert.ok(!readFileSync(join(repository.directory,name),'utf8').includes('private-user-secret'));
  await assert.rejects(runtime.chat(scope,'普通发送',new AbortController().signal),/无痕/);
  runtime.clearIncognito(scope);assert.equal(runtime.incognitoHistory(scope).length,0);await runtime.chat({...scope,sessionId:'ordinary'},'普通发送',new AbortController().signal);assert.ok(!prompt.includes('private-user-secret'));
});

test('privacy is frozen for an in-flight turn and clearing its session prevents a late result from repopulating memory',async t=>{
  const repository=fixture(t);let release!:(reply:string)=>void,started!:()=>void;const running=new Promise<void>(resolve=>started=resolve);
  const runtime=new BookRuntime(repository,{async complete(){started();return new Promise<string>(resolve=>release=resolve)}});
  const pending=runtime.chat(scope,'private-cancel-secret',new AbortController().signal,{incognito:true}),rejected=assert.rejects(pending);await running;
  runtime.clearIncognito(scope);release('private-late-answer');await rejected;assert.equal(runtime.incognitoHistory(scope).length,0);assert.equal(repository.readSession(scope).length,0);assert.equal(repository.loadCompanionData(scope).jobs.length,0);
});
test('incognito refuses regular web history and project routes before any model call',async t=>{
  const repository=fixture(t),config=repository.loadConfig();repository.commitConfig({...config,mainModel:{kind:'chatgpt-web',baseUrl:'chatgpt-web',model:'GPT-6',credentialId:'none',inputTokens:8192,outputTokens:1024},chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,authorizedPurposes:['reply'],conversationMode:'regular'}},config.revision,'web');
  const runtime=new BookRuntime(repository,{async complete(){throw Error('must reject before sending')}});await assert.rejects(runtime.chat(scope,'private-no-send',new AbortController().signal,{incognito:true}),/非临时|项目/);assert.equal(repository.readSession(scope).length,0);
});

test('web adapter independently rejects regular incognito and confirms a temporary request on the allowed source',async()=>{
  let regular=true,calls=0,temporary=false;
  const model=new ChatgptWebModel({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,conversationMode:regular?'regular':'temporary'}),bridge:{async ask(input){calls++;temporary=!!input.temporary;return {kind:'completed',text:'好的',conversationId:null,durationMs:1}}}}),binding={kind:'chatgpt-web' as const,baseUrl:'chatgpt-web',model:'GPT-6',credentialId:'none',inputTokens:8192,outputTokens:1024};
  await assert.rejects(model.complete(binding,[{role:'user',content:'private-web-secret'}],new AbortController().signal,{incognito:true}),/无痕/);assert.equal(calls,0);
  regular=false;await model.complete(binding,[{role:'user',content:'private-web-secret'}],new AbortController().signal,{incognito:true});assert.equal(calls,1);assert.equal(temporary,true);
});

test('private model errors cannot expose content through public errors or repopulate durable state',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){throw Error('provider echoed private-error-secret')}});
  await assert.rejects(runtime.chat(scope,'private-error-secret',new AbortController().signal,{incognito:true}),error=>error instanceof Error&&!error.message.includes('private-error-secret')&&error.message.includes('无痕'));
  assert.equal(repository.readSession(scope).length,0);assert.equal(repository.loadCompanionData(scope).jobs.length,0);
});

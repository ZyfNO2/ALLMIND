import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {BookError,emptyEntry,type ChatMessage} from '../../contracts/memory-book.js';
import {dialogueRoute} from '../../core/book-dialogue.js';
import {bookDiagnostics} from '../../management/book-diagnostics.js';
import {BookCredentials} from '../../management/book-credentials.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../contracts/book-companion.js';
const scope={characterId:'aika',pairingId:'local-user',sessionId:'routing'};
function fixture(t:test.TestContext){const base=resolve('.local/dialogue-routing');mkdirSync(base,{recursive:true});const repository=new FileBookRepository(mkdtempSync(join(base,'run-')));t.after(()=>repository.close());const config=repository.loadConfig(),binding={baseUrl:'http://127.0.0.1:1/v1',model:'smart-model',credentialId:'local-no-auth',inputTokens:16000,outputTokens:2000};repository.commitConfig({...config,mainModel:binding,dialogueRouting:{defaultMode:'auto',profiles:{quick:{model:{...binding,model:'light-model'},inputTokens:5000,outputTokens:512},rp:{model:{...binding,model:'rp-model'}}}}},0,'route-config');const secret=emptyEntry('private','memory','真实记忆','PRIVATE_REAL_MEMORY');secret.pairingId='local-user';secret.trigger.strategy='always';const story=emptyEntry('fiction','story','故事','FICTIONAL_DRAGON_WORLD');story.trigger.strategy='always';repository.commit(scope,{upsert:[emptyEntry('persona','persona','人格','CORE_PERSONA'),secret,story]},0,'seed');return repository;}
test('Auto routes exact greeting and explicit RP; manual override freezes model, memory domain and actual local usage without config mutation',async t=>{
 const repository=fixture(t),before=JSON.stringify(repository.loadConfig()),seen:{model:string;messages:ChatMessage[];budget:number}[]=[];
 const runtime=new BookRuntime(repository,{async complete(binding,messages){seen.push({model:binding.model,messages,budget:binding.outputTokens});return 'controlled '+binding.model;}});
 const smart=await runtime.chat(scope,'SMART_HISTORY_PRIVATE',new AbortController().signal,{turnId:'smart'});assert.equal(smart.turn.dialogue!.mode,'smart');assert.match(JSON.stringify(seen[0]),/PRIVATE_REAL_MEMORY/);
 const rp=await runtime.chat(scope,'/rp RP_HISTORY_SECRET',new AbortController().signal,{turnId:'rp'});assert.equal(rp.turn.dialogue!.memoryDomain,'fiction');assert.equal(seen[1]!.model,'rp-model');assert.match(JSON.stringify(seen[1]),/FICTIONAL_DRAGON_WORLD/);assert.ok(!JSON.stringify(seen[1]).includes('PRIVATE_REAL_MEMORY'));assert.ok(!JSON.stringify(seen[1]).includes('SMART_HISTORY_PRIVATE'));
 const quick=await runtime.chat(scope,'你好',new AbortController().signal,{turnId:'quick'});assert.equal(quick.turn.dialogue!.mode,'quick');assert.equal(seen[2]!.model,'light-model');assert.equal(seen[2]!.budget,512);assert.ok(quick.turn.dialogue!.inputTokensEstimated<=quick.turn.dialogue!.inputBudget);assert.equal(quick.turn.dialogue!.usageSource,'local-estimate');assert.equal(quick.turn.dialogue!.monetaryCost,null);assert.match(JSON.stringify(seen[2]),/CORE_PERSONA/);for(const secret of ['PRIVATE_REAL_MEMORY','FICTIONAL_DRAGON_WORLD','SMART_HISTORY_PRIVATE','RP_HISTORY_SECRET'])assert.ok(!JSON.stringify(seen[2]).includes(secret));
 const overridden=await runtime.chat(scope,'hello',new AbortController().signal,{turnId:'override',dialogueMode:'smart'});assert.equal(overridden.turn.dialogue!.mode,'smart');assert.ok(!JSON.stringify(seen[3]).includes('RP_HISTORY_SECRET'));assert.equal(JSON.stringify(repository.loadConfig()),before);
 await assert.rejects(runtime.chat(scope,'hello',new AbortController().signal,{turnId:'override',dialogueMode:'quick'}),/场景模式/);assert.equal(seen.length,4);assert.equal((await runtime.chat(scope,'hello',new AbortController().signal,{turnId:'override',dialogueMode:'smart'})).replayed,true);assert.equal(seen.length,4);
 const directory=repository.directory;repository.close();const reopened=new FileBookRepository(directory);try{assert.equal(reopened.readSession(scope)[1]!.dialogue!.memoryDomain,'fiction');assert.equal(reopened.readSession(scope)[2]!.dialogue!.model,'light-model');}finally{reopened.close();}
});
test('different scenes run concurrently in separate sessions and a provider failure never invokes an alternate model',async t=>{
 const repository=fixture(t);let start!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>start=resolve),wait=new Promise<void>(resolve=>release=resolve),seen:string[]=[];
 const runtime=new BookRuntime(repository,{async complete(binding,messages){seen.push(binding.model);const body=JSON.stringify(messages);if(binding.model==='rp-model'){assert.ok(!body.includes('PRIVATE_REAL_MEMORY'));start();await wait;}else assert.ok(!body.includes('FICTIONAL_DRAGON_WORLD'));return 'fixture';}});
 const first=runtime.chat({...scope,sessionId:'one'},'/rp 开始故事',new AbortController().signal,{turnId:'one'});await started;const second=await runtime.chat({...scope,sessionId:'two'},'你好',new AbortController().signal,{turnId:'two'});assert.equal(second.turn.dialogue!.mode,'quick');release();await first;assert.deepEqual(seen,['rp-model','light-model']);
 let calls=0;const failing=new BookRuntime(repository,{async complete(binding){calls++;assert.equal(binding.model,'light-model');throw new BookError('unavailable','controlled 429');}});await assert.rejects(failing.chat({...scope,sessionId:'failure'},'你好',new AbortController().signal,{turnId:'no-fallback'}),/429/);assert.equal(calls,1);assert.equal(repository.readSession({...scope,sessionId:'failure'}).length,0);
});
test('route configuration rejects unknown fields, nonexistent presets and invalid budgets before model calls; diagnostic exports remain content-free',async t=>{
 const repository=fixture(t),config=repository.loadConfig();assert.throws(()=>repository.commitConfig({...config,dialogueRouting:{defaultMode:'quick',profiles:{quick:{inputTokens:256,outputTokens:512}}}},config.revision,'invalid'),/窗口/);
 assert.throws(()=>repository.commitConfig({...config,dialogueRouting:{defaultMode:'rp',profiles:{rp:{presetId:'missing'}}}},config.revision,'missing'),/预设/);
 assert.equal(dialogueRoute(config,scope,'please be quick').decision.mode,'smart');assert.equal(dialogueRoute(config,scope,'/rp hi').decision.mode,'rp');assert.equal(dialogueRoute(config,scope,'hello','smart').decision.mode,'smart');
 const report=await bookDiagnostics({runtime:new BookRuntime(repository,{async complete(){throw Error('must not call');}}),credentials:new BookCredentials(join(repository.directory,'credentials')),probeModels:false,signal:new AbortController().signal});assert.equal(report.modelSubmissions,0);assert.ok(report.checks.some(row=>row.id==='model.scene.quick'&&row.status==='NOT_RUN'));
 for(const secret of ['PRIVATE_REAL_MEMORY','FICTIONAL_DRAGON_WORLD','127.0.0.1','smart-model',repository.directory,'fixture-key'])assert.ok(!JSON.stringify(report).includes(secret));
});

test('RP cannot enqueue real automatic memory and explicit remembered RP remains fictional after changing scenes',async t=>{
 const repository=fixture(t),config=repository.loadConfig();repository.commitConfig({...config,companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},config.revision,'automatic');let calls=0;
 const runtime=new BookRuntime(repository,{async complete(){calls++;return '故事中的回应';}}),reply=await runtime.chat(scope,'姓名：虚构旅者',new AbortController().signal,{turnId:'rp-real-guard',dialogueMode:'rp'});await runtime.automaticMemory!.flush();assert.equal(repository.loadCompanionData(scope).jobs.length,0);assert.equal(calls,1);
 const book=repository.snapshot(scope);runtime.rememberTurn(scope,reply.turn.id,book.revision,'remember-roleplay');const remembered=repository.snapshot(scope).entries.find(row=>row.sourceRefs.some(ref=>ref.endsWith('.rp-real-guard')))!;assert.equal(remembered.type,'story');assert.equal(remembered.organization!.domain,'rp');
 const recall=await runtime.inspect(scope,'虚构旅者',new AbortController().signal,'smart');assert.ok(!JSON.stringify(recall.messages).includes('姓名：虚构旅者'));assert.equal(calls,1);
});

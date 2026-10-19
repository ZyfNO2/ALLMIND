import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { WikiSynthesisService } from '../../memory/wiki-synthesis.js';
import { validateSynthesisResult } from '../../memory/wiki-synthesis-protocol.js';
import { FactWikiService, wikiExclusions } from '../../memory/fact-wiki.js';
import { BookRecallEngine } from '../../memory/book-recall.js';
import { LocalBookIndex } from '../../memory/local-book-index.js';
import { BookRuntime } from '../../app/book-runtime.js';
import { startBookServer } from '../../management/book-server.js';
import { BookCredentials } from '../../management/book-credentials.js';
import { BookHttpModel, type BookModelPort } from '../../providers/book-model.js';
import { ChatgptBackgroundBridge, isHighThinkingLabel } from '../../providers/chatgpt-background-bridge.js';
import { ChatgptWebModel } from '../../providers/chatgpt-web-model.js';
import { emptyEntry, DEFAULT_CHATGPT_WEB_SOURCE, type BookScope, type ModelBinding } from '../../contracts/memory-book.js';
import type { SynthesisTask, SynthesisResult } from '../../contracts/wiki-synthesis.js';
import { DEFAULT_COMPANION_SETTINGS } from '../../contracts/book-companion.js';

const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'synthesis' };
const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const signal = () => new AbortController().signal;
const binding: ModelBinding = { baseUrl:'http://127.0.0.1:9999/v1', model:'fixture-not-live', credentialId:'fixture', inputTokens:64000, outputTokens:8000 };
function fixture(t: test.TestContext) {
  const repository = new FileBookRepository(mkdtempSync(join(tmpdir(), 'allmind-wiki-synthesis-'))); t.after(()=>repository.close());
  const config=repository.loadConfig();
  repository.commitConfig({...config,wikiModel:binding,companion:{...DEFAULT_COMPANION_SETTINGS,...config.companion,cloudMemoryConsent:true},characters:config.characters.map(role=>({...role,knowledgeView:{worldId:'ac6',branch:'main',cutoff:5}}))},config.revision,'config');
  const a=emptyEntry('material-a','wiki','ALLMIND原作','ALLMIND为佣兵提供支援，并邀请621参与整合。');
  const b=emptyEntry('material-b','story','621的选择','621接受ALLMIND的邀请。');
  const c=emptyEntry('simulation-c','memory','模拟记录','模拟陪伴：约定专注25分钟，并非真人历史。');
  for(const row of [a,b]){row.knowledge={worldId:'ac6',branch:'main',chapter:5,awareness:'heard'};row.sourceRefs=['source-canon'];}
  c.pairingId=scope.pairingId;c.tags=['simulation','not-user-history'];c.organization={domain:'rp',evidenceStatus:'source_asserted'};c.sourceRefs=['synthetic'];
  const text=a.body+'\n'+b.body;
  repository.commit(scope,{upsert:[a,b,c],wikiSources:[{id:'source-canon',title:'合成原作资料',uri:null,pairingId:null,enabled:true,revision:1,hash:sha(text),forgottenKeys:[],snapshots:[{text,hash:sha(text),capturedAt:'2026-10-19T00:00:00.000Z'}]}]},0,'seed');
  return repository;
}
function response(task: SynthesisTask): SynthesisResult {
  const evidence=(id:string)=>[{entryId:id,quote:task.materials.find(row=>row.id===id)!.body}];
  return {schemaVersion:'allmind-wiki/v1',inputHash:task.inputHash,pages:[
    {id:'allmind',title:'支援身份与整合邀请',domain:'canon',paragraphs:[{text:'综合测试专用词：ALLMIND以佣兵支援身份邀请621参与整合。',evidence:evidence('material-a')}]},
    {id:'raven',title:'621参与整合',domain:'canon',paragraphs:[{text:'621接受了来自ALLMIND的邀请。',evidence:evidence('material-b')}]},
    {id:'simulated-focus',title:'模拟专注约定',domain:'simulated',paragraphs:[{text:'测试包模拟过25分钟专注约定，不是真人历史。',evidence:evidence('simulation-c')}]},
  ],relations:[{from:'allmind',to:'raven',label:'邀请参与整合',evidence:[...evidence('material-a'),...evidence('material-b')]}],coverage:task.materials.map(row=>({entryId:row.id,pageIds:[row.id==='material-a'?'allmind':row.id==='material-b'?'raven':'simulated-focus'],reason:''}))};
}
function model(calls: SynthesisTask[]=[]): BookModelPort {return {async complete(_binding,messages,_signal,options){assert.equal(options?.purpose,'wiki');assert.match(messages[0]!.content,/完整 JSON Schema/);assert.doesNotMatch(messages[0]!.content,/https:\/\/(?:github|gist)/);const task=JSON.parse(messages[1]!.content);calls.push(task);return JSON.stringify(response(task));}};}
function prepared(repository: FileBookRepository, port = model()) {
  const service=new WikiSynthesisService(repository,port,()=>{},()=>false),revision=repository.snapshot(scope).revision;
  return {service,job:service.prepare(scope,revision,'prepare')};
}

test('task package includes immutable input, full rules, schema, executable self-check and stable operation',t=>{
  const repository=fixture(t),{service,job}=prepared(repository),bundle=service.package(scope,job.id),task=JSON.parse(bundle.files['materials.json']!) as SynthesisTask;
  assert.equal(task.materials.length,3);assert.equal(task.materials.find(row=>row.id==='simulation-c')!.domain,'simulated');
  assert.match(bundle.files['validate.py']!,/quote/);assert.match(bundle.files['PROMPT.md']!,/完整 JSON Schema/);
  assert.equal(service.prepare(scope,job.expectedRevision,'prepare').id,job.id);
  assert.equal(repository.snapshot(scope).revision,job.expectedRevision);
  const manifest=JSON.parse(bundle.files['manifest.json']!);
  for(const row of manifest.files){assert.equal(sha(bundle.files[row.name]!),row.sha256);assert.equal(Buffer.byteLength(bundle.files[row.name]!),row.bytes);}
});

test('strict output validation rejects false quotes, wrong domains, invented links, fake coverage and extra fields',t=>{
  const repository=fixture(t),{service,job}=prepared(repository),task=JSON.parse(service.package(scope,job.id).files['materials.json']!) as SynthesisTask;
  validateSynthesisResult(response(task),task);
  const changes: ((value:SynthesisResult)=>void)[]=[
    r=>{r.pages[0]!.paragraphs[0]!.evidence[0]!.quote='不存在的证据'},
    r=>{r.pages[0]!.domain='real'},r=>{r.relations[0]!.to='invented'},
    r=>{r.relations[0]!.evidence=r.relations[0]!.evidence.slice(0,1)},
    r=>{r.coverage.pop()},r=>{r.coverage[0]!.pageIds=['raven']},
    r=>{(r as any).links=[]},r=>{r.inputHash='0'.repeat(64)},
  ];
  for(const change of changes){const value=response(task);change(value);assert.throws(()=>validateSynthesisResult(value,task),{code:'invalid_input'});}
});

test('review is read-only; explicit atomic apply exposes semantic graph, recall and survives restart',async t=>{
  let repository=fixture(t);const calls:SynthesisTask[]=[],{service,job}=prepared(repository,model(calls));
  const before=repository.snapshot(scope),review=await service.run(scope,job.id,signal(),600000,true);assert.equal(review.status,'review');assert.deepEqual(repository.snapshot(scope),before);
  await service.run(scope,job.id,signal(),600000,true);assert.equal(calls.length,1);
  assert.throws(()=>service.apply(scope,job.id,before.revision,'apply',false),{code:'invalid_input'});
  const receipt=service.apply(scope,job.id,before.revision,'apply',true);assert.deepEqual(service.apply(scope,job.id,before.revision,'apply',true),receipt);
  for(const original of before.entries)assert.deepEqual(repository.snapshot(scope).entries.find(row=>row.id===original.id),original);
  const graph=new FactWikiService(repository).graph(scope,{worldId:'ac6',branch:'main',cutoff:5});assert.equal(graph.edges.filter(edge=>edge.kind==='semantic').length,1);assert.ok(graph.edges.some(edge=>edge.kind==='source'));
  const config=repository.loadConfig();
  const recalled=await new BookRecallEngine(repository,new LocalBookIndex()).run({scope,currentMessage:'综合测试专用词 整合邀请',recentMessages:[],config:config.recall,view:config.characters[0]!.knowledgeView!,signal:signal()});
  assert.ok(recalled.selected.some(row=>row.entry.synthesis));assert.ok(!recalled.selected.some(row=>row.entry.synthesis?.domain==='simulated'));
  const directory=repository.directory;repository.close();repository=new FileBookRepository(directory);t.after(()=>repository.close());
  const restarted=new WikiSynthesisService(repository,model(),()=>{},()=>false);assert.equal(restarted.list(scope)[0]!.status,'applied');
  assert.equal(new FactWikiService(repository).graph(scope,config.characters[0]!.knowledgeView).edges.filter(edge=>edge.kind==='semantic').length,1);
});

test('invalid response is failed with diagnostics, never committed or automatically retried',async t=>{
  const repository=fixture(t);let calls=0;
  const {service,job}=prepared(repository,{async complete(){calls++;return '{"pages":[]}';}});
  await assert.rejects(service.run(scope,job.id,signal(),600000,true),{code:'invalid_input'});assert.equal(service.list(scope)[0]!.status,'failed');assert.ok(service.list(scope)[0]!.validationError);
  await assert.rejects(service.run(scope,job.id,signal(),600000,true),{code:'conflict'});assert.equal(calls,1);assert.equal(repository.snapshot(scope).entries.length,3);
});

test('manual synthesis requires per-task send consent and blocks competing chat before any model call',async t=>{
  const repository=fixture(t);let calls=0,finish!:(value:string)=>void,task!:SynthesisTask;
  const runtime=new BookRuntime(repository,{complete(_binding,messages){calls++;task=JSON.parse(messages[1]!.content);return new Promise(resolve=>{finish=resolve})}});
  const job=runtime.synthesis.prepare(scope,repository.snapshot(scope).revision,'consent-prepare');
  await assert.rejects(runtime.synthesis.run(scope,job.id,signal()),{code:'invalid_input'});assert.equal(calls,0);
  const running=runtime.synthesis.run(scope,job.id,signal(),600000,true);
  await assert.rejects(runtime.chat(scope,'你好',signal()),{code:'busy'});assert.equal(calls,1);
  runtime.synthesis.cancel(scope,job.id);finish(JSON.stringify(response(task)));await assert.rejects(running);
});

test('changed input, config, owner and unconfirmed knowledge view fail before send/apply',async t=>{
  const repository=fixture(t),{service,job}=prepared(repository);
  assert.throws(()=>service.get({...scope,pairingId:'someone-else'},job.id),{code:'not_found'});
  const entry=repository.snapshot(scope).entries[0]!;repository.commit(scope,{upsert:[{...entry,body:entry.body+' 修订'}]},job.expectedRevision,'change');
  await assert.rejects(service.run(scope,job.id,signal(),600000,true),{code:'conflict'});
  const config=repository.loadConfig(),characters=config.characters.map(role=>{const result={...role};delete result.knowledgeView;return result});
  repository.commitConfig({...config,characters},config.revision,'clear-view');
  assert.throws(()=>service.prepare(scope,repository.snapshot(scope).revision,'no-view'),/知情|章节/);
});

test('explicit resume revalidates the original web receipt without a second submission',async t=>{
  const repository=fixture(t),config=repository.loadConfig();
  repository.commitConfig({...config,wikiModel:{kind:'chatgpt-web',baseUrl:'chatgpt-web',model:'current',credentialId:'none',inputTokens:64000,outputTokens:8000},chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded',authorizedPurposes:['wiki']}},config.revision,'web-config');
  let submits=0,reads=0,task!:SynthesisTask;
  const port:BookModelPort={async complete(_binding,messages,_signal,options){submits++;task=JSON.parse(messages[1]!.content);options?.onPrepared?.({requestId:'original-request',thinking:{level:2,label:'High'}});throw Error('Simulated client disconnect after submission');},async resume(_binding,id){assert.equal(id,'original-request');reads++;return JSON.stringify(response(task));}};
  const {service,job}=prepared(repository,port);await assert.rejects(service.run(scope,job.id,signal(),600000,true));
  await assert.rejects(service.resume(scope,job.id,signal(),false),{code:'invalid_input'});
  const result=await service.resume(scope,job.id,signal(),true);assert.equal(result.status,'review');assert.equal(submits,1);assert.equal(reads,1);assert.equal(repository.snapshot(scope).entries.length,3);
  await service.resume(scope,job.id,signal(),true);assert.equal(reads,1);
});

test('late completion after cancel is discarded, and a running job after restart never resends',async t=>{
  const repository=fixture(t);let finish!:(value:string)=>void;let task!:SynthesisTask;
  const {service,job}=prepared(repository,{complete(_binding,messages){task=JSON.parse(messages[1]!.content);return new Promise(resolve=>{finish=resolve})}});
  const running=service.run(scope,job.id,signal(),600000,true);service.cancel(scope,job.id);finish(JSON.stringify(response(task)));await assert.rejects(running);assert.equal(service.list(scope)[0]!.status,'cancelled');assert.equal(service.list(scope)[0]!.result,null);
  const second=service.prepare(scope,job.expectedRevision,'restart');
  const next=service.run(scope,second.id,signal(),600000,true);const restarted=new WikiSynthesisService(repository,model(),()=>{},()=>false);
  assert.equal(restarted.get(scope,second.id).status,'failed');await assert.rejects(restarted.run(scope,second.id,signal(),600000,true),{code:'conflict'});
  service.cancel(scope,second.id);finish(JSON.stringify(response(task)));await assert.rejects(next);
});

test('manual edits are preserved; changed or removed original evidence cannot remain usable',async t=>{
  const repository=fixture(t),{service,job}=prepared(repository);await service.run(scope,job.id,signal(),600000,true);service.apply(scope,job.id,job.expectedRevision,'apply',true);
  let book=repository.snapshot(scope);const generated=book.entries.find(row=>row.synthesis?.pageId==='allmind')!;
  repository.commit(scope,{upsert:[{...generated,body:'用户手改，不能覆盖'}]},book.revision,'manual');
  const second=service.prepare(scope,repository.snapshot(scope).revision,'second');await service.run(scope,second.id,signal(),600000,true);
  assert.throws(()=>service.apply(scope,second.id,second.expectedRevision,'overwrite',true),/手改/);
  book=repository.snapshot(scope);const original=book.entries.find(row=>row.id==='material-a')!;repository.commit(scope,{upsert:[{...original,body:'来源已改写'}]},book.revision,'revise');
  book=repository.snapshot(scope);assert.ok(wikiExclusions(book.entries,book.wikiSources!,scope,{worldId:'ac6',branch:'main',cutoff:5}).some(row=>row.entryId===generated.id&&row.reason==='stale_synthesis'));
  repository.commit(scope,{remove:['material-a']},book.revision,'erase');service.prune(scope.characterId);
  assert.equal(repository.snapshot(scope).entries.some(row=>row.id===generated.id),false);assert.equal(service.list(scope)[0]!.result,null);
});

test('HTTP flow enforces auth, same owner, preparation, run, review and explicit apply',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,model());
  const server=await startBookServer({runtime,uiRoot:'management',credentials:new BookCredentials(join(repository.directory,'credentials'))});t.after(()=>server.close());
  const prefix=new URL(server.url).origin+'/api/memory-book/v1/wiki/synthesis';
  assert.equal((await fetch(prefix)).status,401);
  async function post(route:string,data:object){const response=await fetch(prefix+route,{method:'POST',headers:{Authorization:'Bearer '+server.token,'Content-Type':'application/json'},body:JSON.stringify({...scope,...data})});return {status:response.status,data:await response.json()};}
  const prepared=await post('/prepare',{expectedRevision:repository.snapshot(scope).revision,operationId:'http-prepare'});assert.equal(prepared.status,200);const job=prepared.data.job;
  assert.equal((await post('/package',{jobId:job.id})).status,200);
  assert.equal((await post('/run',{jobId:job.id,pairingId:'other'})).status,404);
  assert.equal((await post('/run',{jobId:job.id,confirmedSend:true})).data.job.status,'review');
  assert.equal((await post('/apply',{jobId:job.id,expectedRevision:job.expectedRevision,operationId:'http-apply'})).status,400);
  assert.equal((await post('/apply',{jobId:job.id,expectedRevision:job.expectedRevision,operationId:'http-apply',confirmed:true})).status,200);
});

test('API reasoning effort is sent only when explicitly configured; no fallback or retry',async()=>{
  const requests:any[]=[];
  const http=new BookHttpModel(async()=>'',async(_url,options)=>{requests.push(JSON.parse(String(options?.body)));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}]}),{status:200});});
  await http.complete(binding,[{role:'user',content:'fixture'}],signal());await http.complete({...binding,reasoningEffort:'high'},[{role:'user',content:'fixture'}],signal());
  assert.equal(Object.hasOwn(requests[0],'reasoning_effort'),false);assert.equal(requests[1].reasoning_effort,'high');assert.equal(requests.length,2);
});

test('web submission verifies unique High and task upload before its only submit, rejects unavailable High',async()=>{
  for(const label of ['High','6 高，第 3 项，共 3 项。','GPT-6 High, item 3 of 3'])assert.equal(isHighThinkingLabel(label),true);
  for(const label of ['Medium','6 中，第 2 项，共 3 项。','极高','Highest','高兴'])assert.equal(isHighThinkingLabel(label),false);
  for(const supported of [true,false]){
    const actions:string[]=[],archive=Buffer.from('synthetic task archive');let proof:any;let writes='';
    const bridge=new ChatgptBackgroundBridge({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded'}),intervalMs:0,pollMs:1,pageHost:{async login(){},async navigate(){},async execute(action,input:any){
      actions.push(action);
      if(action==='probe')return{ready:true,temporary:true,hasTurns:false};if(action==='prepare')return{ready:true,temporary:true};if(action==='model')return{model:'current'};
      if(action==='thinking')return input.level===undefined?{options:supported?[{level:1,label:'Medium'},{level:2,label:'High'}]:[{level:1,label:'Medium'}]}:{level:input.level,label:'High'};
      if(action==='upload-image')return input.done?{attached:true,bytes:archive.length,name:'ALLMIND-Wiki-Task.zip'}:{staged:true};
      if(action==='write'){writes+=input.text;return{written:true};}if(action==='submit')return{submitted:true};if(action==='read')return{state:'completed',text:'{"ok":true}',conversationId:'fixture'};return{ok:true};
    }}});
    const result=await bridge.ask({requestId:'high-'+supported,prompt:'fixture',temporary:true,timeoutMs:1000,requiredThinking:'high',taskArchive:{bytes:archive,sha256:sha(archive)},onPrepared:receipt=>{proof=receipt}});
    assert.equal(result.kind,supported?'completed':'failed');assert.equal(actions.filter(action=>action==='submit').length,supported?1:0);
    if(supported){assert.equal(proof.thinking.label,'High');assert.equal(proof.taskArchiveSha256,sha(archive));assert.ok(actions.indexOf('upload-image')<actions.indexOf('submit'));assert.equal(writes,'fixture');}
  }
});

test('web model carries Wiki budget, High requirement and archive through the selected adapter',async()=>{
  let call:any;
  const web=new ChatgptWebModel({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE}),bridge:{async ask(options){call=options;return{kind:'completed',text:'{}',conversationId:'fixture',durationMs:1}}}});
  await web.complete({kind:'chatgpt-web',baseUrl:'chatgpt-web',model:'current',credentialId:'none',inputTokens:64000,outputTokens:8000},[{role:'system',content:'full rules'},{role:'user',content:'materials'}],signal(),{purpose:'wiki',json:true,requiredThinking:'high',budgetMs:600000,taskArchive:{bytes:Buffer.from('zip'),sha256:sha('zip')}});
  assert.equal(call.requiredThinking,'high');assert.equal(call.timeoutMs,600000);assert.equal(call.taskArchive.sha256,sha('zip'));assert.match(call.context,/full rules/);assert.equal(call.recoverableCompletion,true);
});

test('recoverable Wiki completion survives bridge restart and explicit forget removes its private text',async()=>{
  const receiptPath=join(mkdtempSync(join(tmpdir(),'allmind-wiki-receipt-')),'receipt.json');let submits=0;
  const config=()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded' as const});
  const pageHost={async login(){},async navigate(){},async execute(action:string){if(action==='probe')return{ready:true,temporary:true,hasTurns:false};if(action==='prepare')return{ready:true,temporary:true};if(action==='model')return{model:'current'};if(action==='submit'){submits++;return{submitted:true}};if(action==='read')return{state:'completed',text:'{"privateWiki":"fixture"}',conversationId:'fixture'};return{ok:true}}};
  const bridge=new ChatgptBackgroundBridge({config,receiptPath,pageHost,intervalMs:0,pollMs:1});
  assert.equal((await bridge.ask({requestId:'wiki-retain',prompt:'fixture',temporary:true,timeoutMs:1000,recoverableCompletion:true})).kind,'completed');
  const restarted=new ChatgptBackgroundBridge({config,receiptPath,pageHost,intervalMs:0,pollMs:1});
  const result=await restarted.resume('wiki-retain',1000);assert.equal(result.kind,'completed');assert.equal(submits,1);
  restarted.forgetCompleted(['wiki-retain']);assert.doesNotMatch(readFileSync(receiptPath,'utf8'),/privateWiki/);await assert.rejects(restarted.resume('wiki-retain',1000),{code:'not_found'});
});

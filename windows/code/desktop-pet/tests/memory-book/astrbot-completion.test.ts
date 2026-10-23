import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {BookCredentials} from '../../management/book-credentials.js';
import {startBookServer} from '../../management/book-server.js';
import {PROFILES} from '../../app/product-profile.js';
import {AstrbotConnector} from '../../app/astrbot-connector.js';
import {attachAstrbotChat} from '../../app/astrbot-chat.js';
import {compileExternalPrompt} from '../../app/external-prompt.js';
import {previewPublication} from '../../memory/channel-publication.js';
import {saveCapabilityBinding,handleAllmindCapability} from '../../management/allmind-capabilities.js';
import {emptyEntry} from '../../contracts/memory-book.js';
import {BookTools} from '../../management/book-tools.js';
import {handleGptText} from '../../providers/gpt-text-endpoint.js';

test('text endpoint accepts ordered text parts and rejects any mixed or unsupported part before the bridge',async()=>{
  let calls=0;const endpoint={token:'fixture',port:{async complete(messages:{role:string;content:string}[]){calls++;assert.equal(messages[0]?.content,'first\nsecond');return {text:'ok',requestId:'fixture'};}}},signal=new AbortController().signal;
  const run=(content:unknown)=>handleGptText('/gpt-text/v1/chat/completions','POST',{messages:[{role:'user',content}]},endpoint,signal);
  assert.equal((await run([{type:'text',text:'first'},{type:'text',text:'second'}]))?.status,200);assert.equal(calls,1);
  for(const content of [[],[{type:'text',text:'first'},{type:'image_url',image_url:{url:'https://example.invalid/image'}}],[{type:'audio',text:'first'}],[{type:'text',text:'first',unknown:'metadata'}],[{type:'text',text:3}]])assert.equal((await run(content))?.status,400);
  assert.equal(calls,1);
});

test('scene selects an explicit AstrBot config and cannot replay the same request under another scene',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-scene-'));let calls=0;
  try{
    const connector=new AstrbotConnector(directory,{execution:'astrbot',baseUrl:'http://127.0.0.1:1',credentialId:'fixture',configId:'default',instanceId:'scene',modeConfigIds:{rp:'rp-config'}},'fixture',async(_url,init)=>{calls++;assert.equal(JSON.parse(String(init?.body)).config_id,'rp-config');return new Response('data: {"type":"complete","data":"story"}\n\n',{headers:{'content-type':'text/event-stream'}});});
    const input={requestId:'scene-1',characterId:'role',sessionId:'session',text:'hello',mode:'rp' as const,signal:new AbortController().signal};
    assert.equal((await connector.chat(input)).text,'story');await assert.rejects(connector.chat({...input,mode:'quick'}),/编号/);assert.equal(calls,1);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('credential rotation and revocation apply without restarting the AstrBot connector',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-credential-'));
  const credentials=new BookCredentials(join(directory,'credentials'));credentials.save('bot','first');
  const seen:string[]=[];
  const connector=new AstrbotConnector(directory,{execution:'astrbot',baseUrl:'http://127.0.0.1:1',credentialId:'bot',configId:null,instanceId:'credential'},()=>credentials.get('bot'),async(_url,init)=>{
    seen.push(new Headers(init?.headers).get('Authorization')!);
    return new Response('data: {"type":"complete","data":"ok"}\n\n',{headers:{'content-type':'text/event-stream'}});
  });
  const input={requestId:'one',text:'hello',characterId:'role',sessionId:'session',signal:new AbortController().signal};
  try{
    assert.equal((await connector.chat(input)).state,'completed');credentials.save('bot','second');
    assert.equal((await connector.chat({...input,requestId:'two'})).state,'completed');credentials.revoke('bot');
    assert.notEqual((await connector.chat({...input,requestId:'three'})).state,'completed');
    assert.deepEqual(seen,['Bearer first','Bearer second']);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('revoking a GPT text key rejects new requests before calling the bridge',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-text-revoke-')),repo=new FileBookRepository(directory),credentials=new BookCredentials(join(directory,'credentials'));
  const runtime=new BookRuntime(repo,{async complete(){throw Error('local model must not run');}},{screenEnabled:false});
  credentials.save('text','first');let calls=0;
  const server=await startBookServer({runtime,credentials,uiRoot:resolve('management'),profile:PROFILES['desktop-astrbot'],gptText:{token:()=>credentials.get('text'),port:{async complete(){calls++;return {text:'ok',requestId:'fixture'};}}}});
  t.after(async()=>{await server.close();repo.close();rmSync(directory,{recursive:true,force:true});});
  const post=(key:string,extra:Record<string,unknown>={})=>fetch(new URL(server.url).origin+'/api/memory-book/v1/gpt-text/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:'allmind-gpt-text',messages:[{role:'user',content:'hello'}],...extra})});
  for(const extra of [{tools:[{}]},{tool_choice:'auto'},{tools:[],tool_choice:'none'}])assert.equal((await post('first',extra)).status,400);
  assert.equal(calls,0);assert.equal((await post('first')).status,200);
  credentials.save('text','second');assert.equal((await post('first')).status,401);assert.equal((await post('second')).status,200);
  credentials.revoke('text');assert.equal((await post('second')).status,503);assert.equal(calls,2);
});

test('invalidating a character cancels an external turn and cannot save a late response',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-invalidate-')),repo=new FileBookRepository(directory);
  const runtime=new BookRuntime(repo,{async complete(){throw Error('local model must not run');}},{screenEnabled:false});
  const scope=runtime.scope(repo.loadConfig().currentCharacterId,'external');
  let started!:()=>void,finish!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),released=new Promise<void>(resolve=>finish=resolve);
  const connector=new AstrbotConnector(directory,{execution:'astrbot',baseUrl:'http://127.0.0.1:1',credentialId:'bot',configId:null,instanceId:'invalidate'},'fixture',async()=>{
    started();await released;return new Response('data: {"type":"complete","data":"late"}\n\n',{headers:{'content-type':'text/event-stream'}});
  });attachAstrbotChat(runtime,connector);
  try{
    const pending=runtime.chat(scope,'hello',new AbortController().signal,{turnId:'pending'});
    const rejected=assert.rejects(pending);await ready;assert.equal(runtime.isConversing(scope.characterId),true);
    runtime.invalidate(scope.characterId);finish();await rejected;
    assert.equal(repo.readSession(scope).length,0);assert.equal(runtime.isConversing(scope.characterId),false);
    assert.equal(runtime.turnStatus(scope,'pending').state,'unknown');
    await assert.rejects(runtime.chat(scope,'hello',new AbortController().signal,{turnId:'pending'}));
    assert.equal(repo.readSession(scope).length,0);
  }finally{finish();repo.close();rmSync(directory,{recursive:true,force:true});}
});

test('RP external mirror stays fiction when explicitly remembered and rejects scene-changing replay',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-rp-mirror-')),repo=new FileBookRepository(directory);
  const runtime=new BookRuntime(repo,{async complete(){throw Error('local model must not run');}},{screenEnabled:false}),scope=runtime.scope(repo.loadConfig().currentCharacterId,'rp');
  const connector=new AstrbotConnector(directory,{execution:'astrbot',baseUrl:'http://127.0.0.1:1',credentialId:'bot',configId:null,instanceId:'rp'},'fixture',async()=>new Response('data: {"type":"complete","data":"fiction"}\n\n',{headers:{'content-type':'text/event-stream'}}));attachAstrbotChat(runtime,connector);
  try{
    await runtime.chat(scope,'a story',new AbortController().signal,{turnId:'rp-turn',dialogueMode:'rp'});
    await assert.rejects(runtime.chat(scope,'a story',new AbortController().signal,{turnId:'rp-turn',dialogueMode:'smart'}),/场景/);
    runtime.rememberTurn(scope,'rp-turn',repo.snapshot(scope).revision,'remember-rp');
    const entry=repo.snapshot(scope).entries.find(row=>row.type==='story');assert.ok(entry);assert.equal(entry.organization?.domain,'rp');
  }finally{repo.close();rmSync(directory,{recursive:true,force:true});}
});

test('IM lost acknowledgement stays unknown, changed replay is rejected and no second send occurs',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-im-'));let sends=0;
  try{
    const connector=new AstrbotConnector(directory,{execution:'astrbot',baseUrl:'http://127.0.0.1:1',credentialId:'fixture',configId:null,instanceId:'im'},'fixture',async()=>{sends++;throw Error('lost receipt');});
    const input={requestId:'send-1',umo:'qq:FriendMessage:123',text:'approved text',signal:new AbortController().signal};
    assert.equal((await connector.send(input)).state,'unknown');assert.equal((await connector.send(input)).state,'unknown');assert.equal(sends,1);
    await assert.rejects(connector.send({...input,text:'changed'}),/编号/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('bound task adapter prepares without execution, rejects public actors and exposes no commit route',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-task-')),repo=new FileBookRepository(directory);
  const runtime=new BookRuntime(repo,{async complete(){throw Error('unexpected');}},{screenEnabled:false}),characterId=repo.loadConfig().currentCharacterId;
  const tools=new BookTools(join(directory,'tools')),identity={platform:'webchat',conversationKey:'private',senderKey:'owner'},scope={characterId,pairingId:'local-user',sessionId:'tasks'};
  try{
    const script=join(directory,'fixture.mjs');writeFileSync(script,"process.exit(7)\n");
    await tools.configure({id:'fixture-acp',label:'Controlled ACP',protocol:'acp',command:process.execPath,args:[script],cwd:directory,permission:'confirm',policies:{}},0,true);
    saveCapabilityBinding(directory,{...identity,...scope,audience:'private',publicationEntryIds:[]});
    const signal=new AbortController().signal;
    const prepared=await handleAllmindCapability(runtime,'/astrbot/task/prepare','POST',{...identity,profileId:'fixture-acp',instruction:'read fixture'},signal,tools) as {id:string};
    assert.ok(prepared.id);assert.equal(tools.view(scope).jobs.length,1);
    const status=await handleAllmindCapability(runtime,'/astrbot/task/status','POST',{...identity,id:prepared.id},signal,tools) as {job:{state:string}};
    assert.equal(status.job.state,'prepared');
    await assert.rejects(handleAllmindCapability(runtime,'/astrbot/task/commit','POST',{...identity,id:prepared.id},signal,tools),/未知/);
    await assert.rejects(handleAllmindCapability(runtime,'/astrbot/task/status','POST',{...identity,senderKey:'stranger',id:prepared.id},signal,tools),/绑定/);
  }finally{await tools.close();repo.close();rmSync(directory,{recursive:true,force:true});}
});

test('HTTP chat uses one AstrBot executor, mirrors history, rejects changed replay and engine mixing',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-external-'));
  const repo=new FileBookRepository(directory);let local=0,remote=0;
  const runtime=new BookRuntime(repo,{async complete(){local++;throw Error('unexpected local generation');}},{screenEnabled:false});
  const characterId=repo.loadConfig().currentCharacterId;
  const connector=new AstrbotConnector(directory,{execution:'astrbot',baseUrl:'http://127.0.0.1:1',credentialId:'fixture',configId:null,instanceId:'test'},'fixture',async (_url,init)=>{
    remote++;const body=JSON.parse(String(init?.body));assert.equal(body.message,'hello');assert.equal(Object.hasOwn(body,'history'),false);
    return new Response('data: {"type":"plain","data":"partial"}\n\ndata: {"type":"complete","data":"final answer"}\n\n',{headers:{'content-type':'text/event-stream'}});
  });
  attachAstrbotChat(runtime,connector);
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management'),profile:PROFILES['desktop-astrbot']});
  t.after(async()=>{await server.close();repo.close();rmSync(directory,{recursive:true,force:true});});
  const post=(body:unknown)=>fetch(new URL(server.url).origin+'/api/memory-book/v1/chat',{method:'POST',headers:{Authorization:'Bearer '+server.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const body={characterId,sessionId:'new-external',turnId:'turn-external',text:'hello'};
  const first=await post(body);assert.equal(first.status,200);const reply=await first.json();assert.equal(reply.turn.assistant,'final answer');
  assert.equal((await post(body)).status,200);assert.equal(remote,1);assert.equal(local,0);
  assert.equal((await post({...body,text:'different'})).status,409);
  assert.equal((await post({...body,turnId:'private',incognito:true})).status,409);
  assert.equal(repo.readSession({...runtime.scope(characterId,'new-external')}).length,1);
  delete runtime.externalExecutor;
  await assert.rejects(runtime.chat(runtime.scope(characterId,'new-external'),'hello',new AbortController().signal),/AstrBot/);
  assert.equal(local,0);
});

test('external Preset preserves depth-zero tail, original tools and one current message',()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-preset-')),repo=new FileBookRepository(directory);
  try{
    const config=repo.loadConfig(),characterId=config.currentCharacterId;
    config.mainModel={model:'fixture',baseUrl:'http://127.0.0.1:1',credentialId:'local-no-auth',inputTokens:16000,outputTokens:1000};
    const document={prompts:[{identifier:'main',role:'system' as const,content:'Speak as {{char}}'},{identifier:'worldInfoBefore',marker:true},{identifier:'chatHistory',marker:true},{identifier:'tail',role:'system' as const,content:'LAST',injection_position:1,injection_depth:0}],prompt_order:[{character_id:100001,order:['main','worldInfoBefore','chatHistory','tail'].map(identifier=>({identifier,enabled:true}))}]};
    config.promptPresets=[{id:'preset-p',name:'preset',revision:1,original:JSON.stringify(document),document,orderBlock:100001}];config.characters[0]!.promptPresetId='preset-p';
    const tools=[{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'f',arguments:'{}'}}]},{role:'tool',tool_call_id:'call-1',content:'{{char}} must stay data'}];
    const compiled=compileExternalPrompt(config,{characterId,pairingId:'local-user',sessionId:'x'},'CURRENT',tools,[{entryId:'w',type:'wiki',text:'MEMORY'}]);
    assert.equal(compiled.preset.status,'assembled');assert.ok('messages' in compiled);
    const messages=compiled.messages!;assert.equal(messages.filter(row=>row.content==='CURRENT').length,1);assert.equal(messages.at(-1)?.content,'LAST');
    assert.deepEqual(messages.filter(row=>row.role==='tool'||'tool_calls' in row),tools);
  }finally{repo.close();rmSync(directory,{recursive:true,force:true});}
});

test('public snapshot revokes on source edits; record requires a preparation token and bound RP domain',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-public-')),repo=new FileBookRepository(directory);
  const runtime=new BookRuntime(repo,{async complete(){throw Error('no model');}},{screenEnabled:false}),characterId=repo.loadConfig().currentCharacterId,scope=runtime.scope(characterId,'desktop');
  try{
    repo.commit(scope,{upsert:[emptyEntry('w','wiki','public','PUBLIC')]},0,'seed');
    const publication=previewPublication(repo,{id:'pub',revision:1,scope,entryIds:['w'],sourceIds:[],name:'Public',intro:'Public intro',presetId:null});
    const identity={platform:'qq',conversationKey:'group',senderKey:'user'};
    saveCapabilityBinding(directory,{...identity,characterId,pairingId:'local-user',sessionId:'group',audience:'public',publicationEntryIds:['w'],publication,mode:'rp'});
    const eventKey='b'.repeat(64),signal=new AbortController().signal;
    const prepared=await handleAllmindCapability(runtime,'/astrbot/prepare','POST',{...identity,eventKey,message:'public'},signal) as {recordToken:string};
    await assert.rejects(handleAllmindCapability(runtime,'/astrbot/record','POST',{eventKey,recordToken:'wrong',answer:'x',generation:'completed',delivery:'unknown'},signal),/回执/);
    const recorded=await handleAllmindCapability(runtime,'/astrbot/record','POST',{eventKey,recordToken:prepared.recordToken,domain:'reality',answer:'rp story',generation:'completed',delivery:'unknown'},signal) as {record:{domain:string}};
    assert.equal(recorded.record.domain,'fiction');
    const snapshot=repo.snapshot(scope),entry=snapshot.entries.find(row=>row.id==='w')!;
    repo.commit(scope,{upsert:[{...entry,body:'PRIVATE CHANGE'}]},snapshot.revision,'edit');
    await assert.rejects(handleAllmindCapability(runtime,'/astrbot/prepare','POST',{...identity,eventKey:'c'.repeat(64),message:'public'},signal),/修改|撤销/);
  }finally{repo.close();rmSync(directory,{recursive:true,force:true});}
});

test('voice module installs, disables, reenables and uninstalls without changing Wiki data',()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-module-')),source=join(directory,'voice'),modules=join(directory,'modules'),data=join(directory,'book');
  mkdirSync(data);writeFileSync(join(data,'sentinel.txt'),'KEEP');
  const cli=resolve('tools/allmind-modules.mjs');
  const run=(args:string[])=>{const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};
  try{
    const packed=JSON.parse(run(['pack','--id','voice','--output',source]));
    run(['install','--id','voice','--module-root',modules,'--source',source,'--expected-manifest',packed.manifestSha256]);
    const probe=()=>spawnSync(process.execPath,['--input-type=module','-e',"const {installedModules}=await import('./dist/app/module-runtime.js'); console.log(JSON.stringify(installedModules()))"],{env:{...process.env,ALLMIND_MODULE_ROOT:modules},encoding:'utf8'});
    const state=()=>{const result=spawnSync(process.execPath,['--input-type=module','-e',"const {resolveProductProfile}=await import('./dist/app/product-profile.js'); console.log(JSON.stringify(resolveProductProfile().moduleStates.voice))"],{env:{...process.env,ALLMIND_MODULE_ROOT:modules,ALLMIND_PROFILE:'desktop-lite'},encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
    let checked=probe();assert.equal(checked.status,0,checked.stderr);assert.ok(JSON.parse(checked.stdout).voice);
    assert.deepEqual(state(),{installed:true,enabled:true});
    run(['disable','--id','voice','--module-root',modules]);assert.equal(JSON.parse(probe().stdout).voice,undefined);
    assert.deepEqual(state(),{installed:true,enabled:false});
    run(['enable','--id','voice','--module-root',modules]);assert.ok(JSON.parse(probe().stdout).voice);
    run(['uninstall','--id','voice','--module-root',modules]);assert.equal(JSON.parse(probe().stdout).voice,undefined);assert.equal(readFileSync(join(data,'sentinel.txt'),'utf8'),'KEEP');
    assert.deepEqual(state(),{installed:false,enabled:false});
  }finally{rmSync(directory,{recursive:true,force:true});}
});

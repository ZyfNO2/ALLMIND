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

test('scene selects an explicit AstrBot config and cannot replay the same request under another scene',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-scene-'));let calls=0;
  try{
    const connector=new AstrbotConnector(directory,{execution:'astrbot',baseUrl:'http://127.0.0.1:1',credentialId:'fixture',configId:'default',instanceId:'scene',modeConfigIds:{rp:'rp-config'}},'fixture',async(_url,init)=>{calls++;assert.equal(JSON.parse(String(init?.body)).config_id,'rp-config');return new Response('data: {"type":"complete","data":"story"}\n\n',{headers:{'content-type':'text/event-stream'}});});
    const input={requestId:'scene-1',characterId:'role',sessionId:'session',text:'hello',mode:'rp' as const,signal:new AbortController().signal};
    assert.equal((await connector.chat(input)).text,'story');await assert.rejects(connector.chat({...input,mode:'quick'}),/编号/);assert.equal(calls,1);
  }finally{rmSync(directory,{recursive:true,force:true});}
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
    let checked=probe();assert.equal(checked.status,0,checked.stderr);assert.ok(JSON.parse(checked.stdout).voice);
    run(['disable','--id','voice','--module-root',modules]);assert.equal(JSON.parse(probe().stdout).voice,undefined);
    run(['enable','--id','voice','--module-root',modules]);assert.ok(JSON.parse(probe().stdout).voice);
    run(['uninstall','--id','voice','--module-root',modules]);assert.equal(JSON.parse(probe().stdout).voice,undefined);assert.equal(readFileSync(join(data,'sentinel.txt'),'utf8'),'KEEP');
  }finally{rmSync(directory,{recursive:true,force:true});}
});

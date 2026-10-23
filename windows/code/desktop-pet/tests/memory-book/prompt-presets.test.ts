import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compilePreset,presetBudget,type PresetContext} from '../../app/prompt-compiler.js';
import {parsePreset,presetCompatibility,exportPreset} from '../../memory/prompt-preset.js';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {BookHttpModel} from '../../providers/book-model.js';
import {ChatgptWebModel} from '../../providers/chatgpt-web-model.js';
import {DEFAULT_CHATGPT_WEB_SOURCE,emptyEntry,type ChatMessage} from '../../contracts/memory-book.js';
import type {StoredPromptPreset,PresetPrompt} from '../../contracts/prompt-preset.js';
import {FactWikiService} from '../../memory/fact-wiki.js';

function preset(extra:PresetPrompt[]=[]):StoredPromptPreset{
  const document={prompts:[{identifier:'main',role:'system' as const,content:'Act as {{char}} for {{user}}.'},{identifier:'charDescription',marker:true},{identifier:'worldInfoBefore',marker:true},{identifier:'allmindMemory',marker:true},{identifier:'allmindMaterials',marker:true},{identifier:'chatHistory',marker:true},...extra],prompt_order:[{character_id:100001,order:['main','charDescription','worldInfoBefore','allmindMemory','allmindMaterials','chatHistory',...extra.map(row=>row.identifier)].map(identifier=>({identifier,enabled:true}))}],temperature:.7,top_p:.9,openai_max_tokens:512};
  return {id:'preset-test',name:'合成预设',revision:1,original:JSON.stringify(document),document,orderBlock:100001};
}
function context(record=preset()):PresetContext{return {preset:record,char:'ALLMIND',user:'测试用户',intro:'',binding:{baseUrl:'http://127.0.0.1:1',model:'fixture',credentialId:'local-no-auth',inputTokens:16000,outputTokens:1000}};}
function compile(record=preset(),budget=10000,history:ChatMessage[]=[]){return compilePreset(context(record),{current:'C',history,segments:[],policy:'',budget});}

test('Depth boundaries include the current user once and mixed roles follow pinned source ordering',()=>{
  for(const depth of [0,1,2,99]){
    const result=compile(preset([{identifier:'inject',role:'system',content:'I',injection_position:1,injection_depth:depth}]),10000,[{role:'user',content:'A'},{role:'assistant',content:'B'}]);
    const contents=result.messages.map(row=>row.content).slice(1);
    assert.deepEqual(contents,depth===0?['A','B','C','I']:depth===1?['A','B','I','C']:depth===2?['A','I','B','C']:['I','A','B','C']);
    assert.equal(result.messages.filter(row=>row.content==='C').length,1);
  }
  const result=compile(preset(['system','user','assistant'].map(role=>({identifier:role,role:role as ChatMessage['role'],content:role,injection_position:1,injection_depth:0,injection_order:100}))));
  assert.deepEqual(result.messages.slice(-3).map(row=>row.role),['assistant','user','system']);
});
test('Order groups are stable, originals survive edits, exports exclude connection credentials',()=>{
  const record=preset([{identifier:'later',content:'L',injection_position:1,injection_depth:1,injection_order:200},{identifier:'early',content:'E',injection_position:1,injection_depth:1,injection_order:5}]);
  assert.deepEqual(compile(record).messages.slice(-3).map(row=>row.content),['E','L','C']);
  const original=record.original;record.document.prompts[0]!.content='edited';assert.equal(record.original,original);
  record.document.proxy_password='private';record.document.custom_url='https://private.invalid';assert.ok(!exportPreset(record.document).includes('private'));
});
test('Unsupported active macros/markers fail; disabled extension data does not execute; values are not re-expanded',()=>{
  const record=preset([{identifier:'bad',content:'{{setvar::x::1}}'}]);
  assert.throws(()=>compile(record),/不支持宏/);
  record.document.prompt_order[0]!.order.at(-1)!.enabled=false;assert.equal(presetCompatibility(record).errors.length,0);assert.ok(presetCompatibility(record).warnings.some(row=>row.includes('setvar')));
  record.document.prompts.push({identifier:'unknown',marker:true});record.document.prompt_order[0]!.order.push({identifier:'unknown',enabled:true});assert.throws(()=>compile(record),/未知 Marker/);
  const clean=preset(),ctx=context(clean);ctx.char='{{setvar::x::1}}';const result=compilePreset(ctx,{current:'{{char}}',history:[],segments:[{id:'data',slot:'worldInfoBefore',content:'literal {{unknown}}'}],policy:'',budget:10000});
  assert.ok(result.messages.some(row=>row.content.includes('literal {{unknown}}')));assert.equal(result.messages.at(-1)!.content,'{{char}}');
});
test('Duplicate identifiers, dangling order, bad depth and unknown order blocks fail before transport',()=>{
  const record=preset();record.document.prompts.push(record.document.prompts[0]!);assert.throws(()=>parsePreset(JSON.stringify(record.document)),/重复/);
  const dangling=preset();dangling.document.prompt_order[0]!.order.push({identifier:'missing',enabled:true});assert.throws(()=>compile(dangling),/未知/);
  assert.throws(()=>compile(preset([{identifier:'bad',content:'bad',injection_depth:-1}])),/无效/);
  const block=preset();block.orderBlock=123;assert.throws(()=>compile(block),/order block/);
});

test('date and time macros share a zoned instant without rewriting source or expanding user data',()=>{
  const record=preset([{identifier:'clock',role:'system',content:'{{date}} {{time}} / {{date}}'}]);
  const ctx={...context(record),now:new Date('2026-10-20T18:30:00Z'),timezone:'Asia/Singapore'};
  const original=record.original;
  const result=compilePreset(ctx,{current:'literal {{date}}',history:[],segments:[],policy:'',budget:10000});
  assert.equal(presetCompatibility(record).errors.length,0);
  assert.ok(result.messages.some(row=>row.content==='2026-10-21 02:30 / 2026-10-21'));
  assert.equal(result.messages[result.compilation.currentMessageIndex]!.content,'literal {{date}}');
  assert.equal(record.original,original);assert.equal(record.document.prompts.at(-1)!.content,'{{date}} {{time}} / {{date}}');
  assert.throws(()=>compilePreset({...ctx,timezone:'invalid/timezone'},{current:'x',history:[],segments:[],policy:'',budget:10000}),/time zone/i);
});
test('Budget removes old complete turns, recalculates Depth, protects preset and selected materials',()=>{
  const record=preset([{identifier:'depth',content:'D',injection_position:1,injection_depth:1}]);
  const result=compile(record,150,[{role:'user',content:'X'.repeat(500)},{role:'assistant',content:'old answer'}]);
  assert.deepEqual(result.messages.slice(-2).map(row=>row.content),['D','C']);assert.ok(result.compilation.omissions.some(row=>row.id==='history'));
  const ctx=context(preset());assert.throws(()=>compilePreset(ctx,{current:'C',history:[],segments:[{id:'material',slot:'allmindMaterials',content:'M'.repeat(500)}],policy:'',budget:150}),/未发送/);
  ctx.preset.document.prompts[0]!.content='P'.repeat(600);assert.throws(()=>compilePreset(ctx,{current:'C',history:[],segments:[],policy:'',budget:150}),/未截断预设/);
  ctx.preset.document.openai_max_tokens=16001;assert.throws(()=>presetBudget(ctx),/输出预留/);
});
test('Production runtime compiles persona/recall and HTTP receives exact messages and preset parameters',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-preset-')),repo=new FileBookRepository(directory);t.after(()=>{repo.close();rmSync(directory,{recursive:true,force:true});});
  const record=preset([{identifier:'post',role:'system',content:'POST',injection_position:1,injection_depth:0}]);
  const config=repo.loadConfig();repo.commitConfig({...config,promptPresets:[record],characters:config.characters.map(role=>({...role,promptPresetId:record.id,userName:'Z'})),mainModel:context(record).binding},0,'config');
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'compile'};const persona=emptyEntry('core','persona','角色','ROLE_BODY');repo.commit(scope,{upsert:[persona]},0,'persona');
  const requests:Record<string,unknown>[]=[];
  const model=new BookHttpModel(async()=>'',async(_url,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'合成回复'}}]}),{status:200});});
  const runtime=new BookRuntime(repo,model),signal=new AbortController().signal;
  const preview=await runtime.inspect(scope,'hello',signal);assert.equal(requests.length,0);assert.equal(preview.compilation!.status,'assembled');
  const result=await runtime.chat(scope,'hello',signal,{turnId:'turn-one'});
  assert.equal(requests.length,1);assert.deepEqual(requests[0]!.messages,result.context!.messages);assert.equal(requests[0]!.temperature,.7);assert.equal(requests[0]!.max_tokens,512);assert.equal(result.context!.messages.at(-1)!.content,'POST');
  assert.ok(result.context!.messages.some(row=>row.content.includes('ROLE_BODY')));assert.equal(result.context!.compilation!.status,'consumed');
  assert.ok(!result.context!.messages.some(row=>row.content.includes('【默认聊天表达】')),'explicit presets own their style');
  await runtime.chat(scope,'hello',signal,{turnId:'turn-one'});assert.equal(requests.length,1,'same turn reads back without resubmitting');
});
test('Web transport serializes all roles after the user, without treating post-history instructions as the question',async()=>{
  const record=preset([{identifier:'post',role:'assistant',content:'AFTER',injection_position:1,injection_depth:0}]);const compiled=compile(record);let ask:any;
  const model=new ChatgptWebModel({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE}),bridge:{async ask(input:any){ask=input;return {kind:'completed' as const,text:'合成回复',conversationId:null,durationMs:1};}}});
  await model.complete({...context(record).binding,kind:'chatgpt-web'},compiled.messages,new AbortController().signal,{purpose:'reply',promptCompilation:compiled.compilation,requiredThinking:'high'});
  assert.ok(ask.prompt.indexOf('[用户]\nC')<ask.prompt.indexOf('[角色]\nAFTER'));assert.equal(ask.context,undefined);assert.equal(ask.requiredThinking,'high');
});

test('runtime passes more than six saved turns to the preset compiler within the configured window',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-preset-history-')),repo=new FileBookRepository(directory);t.after(()=>{repo.close();rmSync(directory,{recursive:true,force:true});});
  const record=preset(),config=repo.loadConfig();repo.commitConfig({...config,promptPresets:[record],characters:config.characters.map(role=>({...role,promptPresetId:record.id})),mainModel:context(record).binding},config.revision,'history-config');
  const scope={characterId:config.currentCharacterId,pairingId:'local-user',sessionId:'long-history'};
  for(let index=0;index<12;index++)repo.appendTurn(scope,{...scope,id:'past-'+index,traceId:'trace-'+index,timestamp:new Date().toISOString(),user:'PAST_USER_'+index,assistant:'PAST_ASSISTANT_'+index});
  let calls=0;const runtime=new BookRuntime(repo,{async complete(_binding,messages){calls++;for(let index=0;index<12;index++){
    assert.equal(messages.filter(message=>message.role==='user'&&message.content==='PAST_USER_'+index).length,1);
    assert.equal(messages.filter(message=>message.role==='assistant'&&message.content==='PAST_ASSISTANT_'+index).length,1);
  }return 'history response';}});
  const result=await runtime.chat(scope,'CURRENT',new AbortController().signal,{turnId:'long-history-reply'});
  assert.equal(calls,1);assert.equal(result.context!.compilation!.omissions.filter(row=>row.id==='history').length,0);assert.equal(repo.readSession(scope).length,13);
});

test('private preset chat retains its seventh and eighth preceding turns without persisting them',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-private-preset-history-')),repo=new FileBookRepository(directory);t.after(()=>{repo.close();rmSync(directory,{recursive:true,force:true});});
  const record=preset(),config=repo.loadConfig();repo.commitConfig({...config,promptPresets:[record],characters:config.characters.map(role=>({...role,promptPresetId:record.id})),mainModel:context(record).binding},config.revision,'private-history-config');
  const scope={characterId:config.currentCharacterId,pairingId:'local-user',sessionId:'private-history'};let calls=0,last:ChatMessage[]=[];
  const runtime=new BookRuntime(repo,{async complete(_binding,messages){last=messages;calls++;return 'PRIVATE_ASSISTANT_'+(calls-1);}});
  for(let index=0;index<9;index++)await runtime.chat(scope,'PRIVATE_USER_'+index,new AbortController().signal,{turnId:'private-'+index,incognito:true});
  for(let index=0;index<8;index++){
    assert.equal(last.filter(message=>message.role==='user'&&message.content==='PRIVATE_USER_'+index).length,1);
    assert.equal(last.filter(message=>message.role==='assistant'&&message.content==='PRIVATE_ASSISTANT_'+index).length,1);
  }
  assert.equal(calls,9);assert.equal(repo.readSession(scope).length,0);assert.equal(runtime.incognitoHistory(scope).length,9);
  runtime.clearIncognito(scope);assert.equal(runtime.incognitoHistory(scope).length,0);
});

test('saved history still drops only complete old turns when the effective preset window is exhausted',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-preset-history-budget-')),repo=new FileBookRepository(directory);t.after(()=>{repo.close();rmSync(directory,{recursive:true,force:true});});
  const record=preset();record.document.openai_max_context=5000;const config=repo.loadConfig();repo.commitConfig({...config,promptPresets:[record],characters:config.characters.map(role=>({...role,promptPresetId:record.id})),mainModel:context(record).binding},config.revision,'budget-config');
  const scope={characterId:config.currentCharacterId,pairingId:'local-user',sessionId:'budget-history'};
  for(let index=0;index<12;index++)repo.appendTurn(scope,{...scope,id:'past-'+index,traceId:'trace-'+index,timestamp:new Date().toISOString(),user:'USER_'+index+' '+'.'.repeat(200),assistant:'ASSISTANT_'+index+' '+'.'.repeat(200)});
  const runtime=new BookRuntime(repo,{async complete(){return 'unused';}}),built=await runtime.inspect(scope,'CURRENT',new AbortController().signal);
  const history=built.messages.filter(message=>message.role==='user'||message.role==='assistant').slice(0,-1);
  assert.ok(built.compilation!.omissions.some(row=>row.reason==='oldest_complete_turn_budget'));assert.ok(built.usedTokens<=built.compilation!.inputBudget);assert.ok(history.length>0&&history.length<24);assert.equal(history.length%2,0);
  for(let index=0;index<history.length;index+=2){assert.equal(history[index]!.role,'user');assert.equal(history[index+1]!.role,'assistant');assert.equal(/USER_(\d+)/.exec(history[index]!.content)![1],/ASSISTANT_(\d+)/.exec(history[index+1]!.content)![1]);}
  assert.ok(history.at(-1)!.content.startsWith('ASSISTANT_11 '));assert.equal(built.messages.at(-1)!.content,'CURRENT');
});
test('preset slots without a data source report an explicit diagnostic and are never filled with unusable data',()=>{
  const record=preset([{identifier:'scenario',marker:true},{identifier:'personaDescription',marker:true},{identifier:'extra',content:'S={{scenario}} P={{persona}} N={{personality}}',injection_position:1,injection_depth:0}]);
  const result=compile(record);
  for(const slot of ['scenario','personaDescription','charPersonality'])assert.ok(result.compilation.warnings.some(row=>row.startsWith(slot+'：当前实例没有该槽的数据来源')),slot+' 空槽必须有明确诊断');
  assert.equal(result.messages.filter(row=>row.content==='S= P= N=').length,1,'空槽按空内容编译，不编造内容');
});
test('Graph uses authored related, deduplicates reciprocal edges, and management never changes recall boundaries',t=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-edges-')),repo=new FileBookRepository(directory);t.after(()=>{repo.close();rmSync(directory,{recursive:true,force:true});});
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'edges'},wiki=new FactWikiService(repo);
  const a=emptyEntry('a','wiki','A','A'),b=emptyEntry('b','wiki','B','B');a.related=['b'];b.related=['a'];a.knowledge={worldId:'world',branch:'main',chapter:5,awareness:'heard'};b.knowledge={...a.knowledge};
  repo.commit(scope,{upsert:[a,b]},0,'entries');assert.equal(wiki.graph(scope,undefined,true).nodes.length,0);
  const graph=wiki.graph(scope,undefined,true,undefined,{range:'management'});assert.equal(graph.nodes.length,2);assert.equal(graph.edges.filter(edge=>edge.kind==='related').length,1);
  assert.equal(wiki.graph(scope,undefined,true).nodes.length,0);assert.equal(wiki.graph({...scope,pairingId:'other'},undefined,true).nodes.length,0);
});

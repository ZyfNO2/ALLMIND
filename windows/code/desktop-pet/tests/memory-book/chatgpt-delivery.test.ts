import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHATGPT_WEB_SOURCE, type ChatgptWebSourceConfig } from '../../contracts/memory-book.js';
import { ChatgptWebModel } from '../../providers/chatgpt-web-model.js';
import { ChatgptBackgroundBridge } from '../../providers/chatgpt-background-bridge.js';

test('formal reply and Wiki default to regular; explicit temporary and connection tests remain independent', async()=>{
  let config:ChatgptWebSourceConfig={...DEFAULT_CHATGPT_WEB_SOURCE};
  const inputs:any[]=[];
  const model=new ChatgptWebModel({config:()=>config,bridge:{ask:async(input:any)=>{inputs.push(input);return {kind:'completed',text:'OK',conversationId:null,durationMs:1};}} as any});
  const binding={kind:'chatgpt-web' as const,baseUrl:'chatgpt-web',model:'GPT-6',credentialId:'none',inputTokens:8192,outputTokens:1024};
  const call=(purpose:'reply'|'wiki'|'test')=>model.complete(binding,[{role:'user',content:'测试'}],new AbortController().signal,{purpose});
  await call('reply');await call('wiki');assert.deepEqual(inputs.map(i=>i.temporary),[false,false]);
  config={...config,conversationMode:'temporary'};await call('reply');await call('wiki');await call('test');
  assert.deepEqual(inputs.slice(2).map(i=>i.temporary),[true,true,true]);
  delete config.conversationMode;await call('reply');assert.equal(inputs.at(-1).temporary,false);
});

test('idle warmup submits nothing, serializes with ask and prepares the next owned blank page',async()=>{
  let mode=false,turns=true,readyDelay=0;const calls:string[]=[];
  const bridge=new ChatgptBackgroundBridge({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE}),intervalMs:0,pollMs:1,prewarm:true,pageHost:{
    async navigate(temporary){calls.push('navigate');mode=temporary;turns=false;readyDelay=1;},async login(){throw Error('not called');},
    async execute(action,input){calls.push(action);if(action==='probe')return {ready:readyDelay--<=0,signedIn:true,temporary:mode,hasTurns:turns,generating:false};
      if(action==='prepare')return {ready:true,temporary:mode};if(action==='model')return {model:input.model};
      if(action==='submit'){turns=true;return {submitted:true};}if(action==='read')return {state:'completed',text:'OK'};return {ok:true};}
  }});
  await bridge.warmup('GPT-6');assert.equal(calls.filter(c=>c==='submit').length,0);assert.equal(mode,false);
  const first=await bridge.ask({requestId:'first',prompt:'q',model:'GPT-6',temporary:true,timeoutMs:1000});assert.equal(first.kind,'completed');
  await bridge.warmup();assert.equal(turns,false);assert.equal(calls.filter(c=>c==='submit').length,1);
  const second=await bridge.ask({requestId:'second',prompt:'q2',model:'GPT-6',temporary:true,timeoutMs:1000});assert.equal(second.kind,'completed');
  await bridge.warmup();assert.equal(calls.filter(c=>c==='submit').length,2);
});

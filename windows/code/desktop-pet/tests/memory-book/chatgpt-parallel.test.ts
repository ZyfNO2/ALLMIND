import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ChatgptParallelBridge } from '../../providers/chatgpt-parallel-bridge.js';
import { ChatgptWebModel } from '../../providers/chatgpt-web-model.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../contracts/memory-book.js';

test('embedded lanes isolate uncertain sends, preserve them across restart and never replay them', async () => {
  mkdirSync('.local/memory-book-tests', { recursive: true });
  const receiptPath = join(mkdtempSync('.local/memory-book-tests/parallel-'), 'receipts.json');
  let hold = true;
  const submissions: {lane:number;id:string}[] = [];
  const options = { config: () => ({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded' as const}), receiptPath, intervalMs:0,pollMs:1,
    pageHostForLane: (lane:number) => ({ async login(){},async navigate(){},async execute(action:string,input:{id?:string}) {
      if(action==='probe')return {ready:true,temporary:true,hasTurns:false};
      if(action==='prepare')return {ready:true,temporary:true};
      if(action==='model')return {model:'current'};
      if(action==='submit'){submissions.push({lane,id:input.id!});return {submitted:true};}
      if(action==='read')return lane===0&&hold?{state:'pending'}:{state:'completed',text:'reply:'+input.id,conversationId:'conversation-'+lane,messageId:'message-'+lane};
      return {ok:true};
    }}) };
  const first = new ChatgptParallelBridge(options);
  const stuck = await first.ask({requestId:'uncertain',prompt:'first',temporary:true,timeoutMs:15});
  assert.equal(stuck.kind,'failed');assert.equal(first.currentRequest()?.requestId,'uncertain');
  const restarted = new ChatgptParallelBridge(options);
  const next=await restarted.ask({requestId:'independent',prompt:'second',temporary:true,timeoutMs:1000});
  assert.equal(next.kind,'completed');assert.deepEqual(submissions,[{lane:0,id:'uncertain'},{lane:1,id:'independent'}]);
  assert.equal(restarted.currentRequest()?.requestId,'uncertain','new conversation must not erase old receipt');
  assert.equal((await restarted.ask({requestId:'uncertain',prompt:'first',temporary:true,timeoutMs:10})).kind,'failed');
  assert.equal(submissions.length,2,'unknown send must never be submitted again');
  hold=false;
  const old=await restarted.resume('uncertain',1000);assert.equal(old.kind,'completed');
  if(old.kind==='completed')assert.equal(old.text,'reply:uncertain');
  assert.equal(submissions.length,2);assert.equal(restarted.currentRequest(),null);
});

test('rich concurrent model replies retain each request, conversation, text and artifact identity', async () => {
  const finish = new Map<string,(value:any)=>void>();
  const released:string[]=[];
  const bridge={ask(input:any){return new Promise<any>(resolve=>finish.set(input.requestId,resolve));},releaseRequest(id:string){released.push(id);}};
  const artifacts={async readArtifact():Promise<Uint8Array>{throw Error('File reads are outside this identity test');},capabilities(){return {outputFiles:'available' as const,inputImages:'available' as const,outputImages:'unknown' as const};},async listArtifacts(id:string){return {messageId:'message-'+id,artifacts:[{handleId:'file-'+id,nameHint:id+'.txt'}],discovery:'complete' as const};}};
  let serial=0;
  const model=new ChatgptWebModel({bridge,artifacts,config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,authorizedPurposes:['reply']}),requestId:()=>`request-${++serial}`});
  const binding={kind:'chatgpt-web' as const,baseUrl:'chatgpt-web',credentialId:'none',model:'current',inputTokens:8192,outputTokens:1024};
  const a=model.completeRich(binding,[{role:'user',content:'A'}],new AbortController().signal);
  const b=model.completeRich(binding,[{role:'user',content:'B'}],new AbortController().signal);
  assert.equal(finish.size,2,'second conversation must reach its independent bridge call');
  finish.get('request-2')!({kind:'completed',text:'answer B',conversationId:'conversation-B',messageId:'message-B',durationMs:1});
  const rb=await b;
  finish.get('request-1')!({kind:'completed',text:'answer A',conversationId:'conversation-A',messageId:'message-A',durationMs:1});
  const ra=await a;
  assert.deepEqual([ra.requestId,ra.text,ra.conversationId,ra.messageId],['request-1','answer A','conversation-A','message-A']);
  assert.deepEqual([rb.requestId,rb.text,rb.conversationId,rb.messageId],['request-2','answer B','conversation-B','message-B']);
  assert.equal(ra.artifacts[0]?.handleId,'file-request-1');assert.equal(rb.artifacts[0]?.handleId,'file-request-2');
  assert.deepEqual(released,['request-2','request-1']);
});

test('four embedded generations overlap on separate pages; a fifth is refused before submit', async () => {
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const submits:number[]=[];
  const bridge=new ChatgptParallelBridge({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded'}),intervalMs:0,pollMs:1,pageHostForLane:lane=>({async login(){},async navigate(){},async execute(action:string,input:{id?:string}){
    if(action==='probe')return {ready:true,temporary:true,hasTurns:false};
    if(action==='prepare')return {ready:true,temporary:true};
    if(action==='model')return {model:'current'};
    if(action==='submit'){submits.push(lane);return {submitted:true};}
    if(action==='read'){await gate;return {state:'completed',text:'reply:'+input.id,conversationId:'conversation-'+lane,messageId:'message-'+lane};}
    return {ok:true};
  }})});
  const jobs=[0,1,2,3].map(i=>bridge.ask({requestId:'parallel-'+i,prompt:'synthetic '+i,temporary:true,timeoutMs:5000}));
  try {
    for(let i=0;i<100&&submits.length<4;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.deepEqual([...submits].sort(),[0,1,2,3],'all four submit before any result completes');
    const fifth=await bridge.ask({requestId:'overflow',prompt:'not sent',temporary:true,timeoutMs:100});
    assert.equal(fifth.kind,'failed');if(fifth.kind==='failed')assert.equal(fifth.submitted,'no');assert.equal(submits.length,4);
  } finally {release();}
  const results=await Promise.all(jobs);assert.ok(results.every(row=>row.kind==='completed'));
  assert.deepEqual(results.map(row=>row.kind==='completed'?row.text:null),[0,1,2,3].map(i=>'reply:parallel-'+i));
  assert.equal(bridge.currentRequest(),null);
});

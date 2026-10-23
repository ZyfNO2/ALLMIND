import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {normalizeQqEvent,OneBotQqListener} from '../../providers/onebot-qq.js';
import type {QqIncomingMessage} from '../../contracts/book-channel.js';

const policy={connectorId:'qq-test',selfId:'10001',privateIds:['20001'],groupIds:['30001']};
function event(extra:Record<string,unknown>={}){return {post_type:'message',message_type:'private',sub_type:'friend',self_id:10001,user_id:20001,message_id:-123,message:[{type:'text',data:{text:'hello'}}],sender:{nickname:'fixture'},...extra};}
const wait=async(check:()=>boolean)=>{const until=Date.now()+3000;while(!check()){if(Date.now()>until)throw Error('Expected fixture state did not arrive');await new Promise(r=>setTimeout(r,5));}};

test('OneBot normalization enforces friend/group allowlists, real at segments, account and no self echoes',()=>{
  const message=normalizeQqEvent(event(),policy)!;assert.equal(message.text,'hello');assert.equal(message.messageId,'-123');assert.equal(message.targetId,'20001');
  for(const change of [{post_type:'message_sent'},{user_id:10001},{user_id:20002},{sub_type:'group'}])assert.equal(normalizeQqEvent(event(change),policy),null);
  const unsupported=normalizeQqEvent(event({message:[{type:'image',data:{file:'local-private-file'}}]}),policy)!;assert.equal(unsupported.hasUnsupportedMedia,true);assert.match(unsupported.text,/未读取/);assert.ok(!JSON.stringify(unsupported).includes('local-private-file'));
  const group={message_type:'group',sub_type:'normal',group_id:30001};
  for(const message of [[{type:'text',data:{text:'@10001 hello'}}],[{type:'at',data:{qq:'all'}},{type:'text',data:{text:'hello'}}],[{type:'at',data:{qq:'10002'}},{type:'text',data:{text:'hello'}}]])assert.equal(normalizeQqEvent(event({...group,message}),policy),null);
  const triggered=normalizeQqEvent(event({...group,message:[{type:'at',data:{qq:'10001'}},{type:'text',data:{text:'hello'}},{type:'image',data:{file:'unread'}}]}),policy)!;
  assert.equal(triggered.kind,'group');assert.equal(triggered.hasUnsupportedMedia,true);assert.ok(!JSON.stringify(triggered).includes('unread'));
  assert.notEqual(triggered.eventKey,message.eventKey);assert.throws(()=>normalizeQqEvent(event({self_id:10002}),policy));assert.throws(()=>normalizeQqEvent(event({message_id:Number.MAX_SAFE_INTEGER+1}),policy));
  assert.throws(()=>normalizeQqEvent(event({message:'[CQ:at,qq=10001] hi'}),policy));assert.throws(()=>normalizeQqEvent(event({message:[{type:'text',data:{text:'x'.repeat(16001)}}]}),policy));
});

async function fixture(t:test.TestContext,timeout=15000){
  const messages:QqIncomingMessage[]=[],errors:Error[]=[],actions:Record<string,any>[]=[];
  let allowed={privateIds:[...policy.privateIds],groupIds:[...policy.groupIds]},sendMode:'ok'|'silent'|'fail'='ok';
  const listener=new OneBotQqListener({connectorId:policy.connectorId,selfId:policy.selfId,token:'T'.repeat(48),port:0,allowed:()=>allowed,onMessage:async message=>{messages.push(message);},onError:error=>{errors.push(error);},actionTimeoutMs:timeout});
  assert.deepEqual(listener.status(),{listening:false,connected:false,ready:false});
  const {url}=await listener.start();let socket:WebSocket|undefined;
  t.after(async()=>{socket?.terminate();await listener.close();});
  async function connect(headers:Record<string,string>={}){
    const ws=new WebSocket(url,{headers:{Authorization:'Bearer '+'T'.repeat(48),'X-Self-ID':'10001','X-Client-Role':'Universal',...headers}});socket=ws;
    ws.on('message',data=>{const action=JSON.parse(data.toString());actions.push(action);if(action.action==='get_login_info')ws.send(JSON.stringify({status:'ok',retcode:0,echo:action.echo,data:{user_id:10001}}));else if(action.action==='get_status')ws.send(JSON.stringify({status:'ok',retcode:0,echo:action.echo,data:{online:true,good:true}}));else if(sendMode==='ok')ws.send(JSON.stringify({status:'ok',retcode:0,echo:action.echo,data:{message_id:901}}));else if(sendMode==='fail')ws.send(JSON.stringify({status:'failed',retcode:100,echo:action.echo,wording:'PRIVATE_UPSTREAM_TEXT'}));});
    await once(ws,'open');await wait(()=>listener.status().ready);return ws;
  }
  return {listener,url,messages,errors,actions,connect,setAllowed:(next:typeof allowed)=>{allowed=next;},setMode:(next:typeof sendMode)=>{sendMode=next;}};
}

test('real loopback reverse WS verifies account, routes text, safely emits literal CQ text and refuses revoked target',async t=>{
  const f=await fixture(t),ws=await f.connect();assert.equal(f.actions.filter(x=>x.action==='get_login_info').length,1);
  ws.send(JSON.stringify(event()));await wait(()=>f.messages.length===1);const message=f.messages[0]!;
  const result=await f.listener.send(message,'[CQ:at,qq=all] literal');assert.equal(result.messageId,'901');
  const action=f.actions.find(x=>x.action==='send_private_msg')!;assert.deepEqual(action.params.message,[{type:'text',data:{text:'[CQ:at,qq=all] literal'}}]);assert.equal(action.params.user_id,'20001');
  f.setAllowed({privateIds:[],groupIds:[]});await assert.rejects(f.listener.send(message,'revoked'),/撤销/);assert.equal(f.actions.filter(x=>x.action==='send_private_msg').length,1);
  await f.listener.close();assert.equal(f.listener.status().listening,false);
});

test('reverse WS rejects wrong token, browser Origin, wrong account, wrong role and query credentials before upgrade',async t=>{
  const f=await fixture(t);
  for(const headers of [{Authorization:'Bearer wrong'},{Origin:'http://localhost'},{'X-Self-ID':'10002'},{'X-Client-Role':'Event'}]){
    const ws=new WebSocket(f.url,{headers:{Authorization:'Bearer '+'T'.repeat(48),'X-Self-ID':'10001','X-Client-Role':'Universal',...headers}});
    await assert.rejects(once(ws,'open'),/403/);assert.equal(f.listener.status().ready,false);
  }
  const ws=new WebSocket(f.url+'?access_token='+ 'T'.repeat(48),{headers:{'X-Self-ID':'10001','X-Client-Role':'Universal'}});await assert.rejects(once(ws,'open'),/403/);assert.equal(f.messages.length,0);
});

test('sent action with lost receipt becomes unknown and never resends; wrong echo cannot complete it',async t=>{
  const f=await fixture(t,150),ws=await f.connect();f.setMode('silent');const message=normalizeQqEvent(event(),policy)!;
  const pending=f.listener.send(message,'once');const rejected=assert.rejects(pending,/未知/);await wait(()=>f.actions.some(x=>x.action==='send_private_msg'));
  ws.send(JSON.stringify({status:'ok',retcode:0,echo:'not-the-request',data:{message_id:5}}));await rejected;
  assert.equal(f.actions.filter(x=>x.action==='send_private_msg').length,1);
});

test('disconnect makes outstanding send unknown and reconnect does not replay it',async t=>{
  const f=await fixture(t),ws=await f.connect();f.setMode('silent');const pending=f.listener.send(normalizeQqEvent(event(),policy)!,'once');const rejected=assert.rejects(pending,/未知/);
  await wait(()=>f.actions.some(x=>x.action==='send_private_msg'));ws.terminate();await rejected;await wait(()=>!f.listener.status().connected);await f.connect();assert.equal(f.actions.filter(x=>x.action==='send_private_msg').length,1);
});

test('malformed events and account changes close connection; failed action does not expose upstream body',async t=>{
  const f=await fixture(t),ws=await f.connect();f.setMode('fail');await assert.rejects(f.listener.send(normalizeQqEvent(event(),policy)!,'test'),error=>error instanceof Error&&!error.message.includes('PRIVATE_UPSTREAM_TEXT')&&error.message.includes('retcode=100'));
  ws.send(JSON.stringify(event({self_id:10002})));await wait(()=>!f.listener.status().connected);assert.equal(f.messages.length,0);assert.ok(f.errors.some(error=>error.message.includes('账号')));
  const next=await f.connect();next.send('{invalid');await wait(()=>!f.listener.status().connected);assert.ok(f.errors.some(error=>error.message.includes('解析')));
});

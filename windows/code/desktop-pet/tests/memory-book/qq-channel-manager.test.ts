import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookCredentials} from '../../management/book-credentials.js';
import {QqChannelManager} from '../../app/qq-channel-manager.js';
import {emptyEntry} from '../../contracts/memory-book.js';

const wait=async(check:()=>boolean)=>{const until=Date.now()+5000;while(!check()){if(Date.now()>until)throw Error('Fixture state did not arrive');await new Promise(resolve=>setTimeout(resolve,10));}};
async function port(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const result=address.port;await new Promise<void>(resolve=>server.close(()=>resolve()));return result;}
function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'allmind-qq-manager-')),source=new FileBookRepository(join(root,'book')),credentials=new BookCredentials(join(root,'credentials'));
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'desktop'};source.commit(scope,{upsert:[emptyEntry('public','persona','Public','PUBLIC_ROLE'),emptyEntry('secret','wiki','Secret','DESKTOP_SECRET')]},0,'seed');
  let calls=0;const options={directory:join(root,'qq'),source,credentials,model:()=>({async complete(_binding:unknown,messages:unknown){calls++;assert.ok(!JSON.stringify(messages).includes('DESKTOP_SECRET'));return 'synthetic reply';}})};
  let manager=new QqChannelManager(options);t.after(async()=>{await manager.close();source.close();rmSync(root,{recursive:true,force:true});});
  const selection={id:'public-role',revision:1,scope,entryIds:['public'],sourceIds:[],name:'Public',intro:'Public intro',presetId:null};
  return {root,source,credentials,scope,selection,get manager(){return manager;},get calls(){return calls;},async reopen(){await manager.close();manager=new QqChannelManager(options);}};
}

test('clean manager is inert; missing opt-in/configuration rejects start and credentials never appear in view',async t=>{
  const f=fixture(t),view=f.manager.view();assert.equal(view.config.enabled,false);assert.equal(view.status.listening,false);assert.equal(f.calls,0);
  await assert.rejects(f.manager.start(0));assert.equal(f.manager.view().status.listening,false);
  const preview=f.manager.preview(f.selection);f.manager.publish(f.selection,preview.hash,true);
  await f.manager.configure({...view.config,selfId:'10001',privateIds:['20001'],publicationId:'public-role',port:await port(),model:{model:'fixture',baseUrl:'http://127.0.0.1:1',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},0,'T'.repeat(48));
  assert.ok(!JSON.stringify(f.manager.view()).includes('T'.repeat(48)));assert.ok(!readFileSync(join(f.root,'qq','settings.json'),'utf8').includes('T'.repeat(48)));
  assert.equal(f.manager.view().status.listening,false);await f.reopen();await f.manager.restore();assert.equal(f.manager.view().status.listening,false);assert.equal(f.calls,0);
});

test('configured NapCat with wrong logged-in account cannot start model routing or open OneBot port',async t=>{
  const f=fixture(t),preview=f.manager.preview(f.selection);f.manager.publish(f.selection,preview.hash,true);
  const configured=await f.manager.configure({...f.manager.view().config,selfId:'10001',privateIds:['20001'],publicationId:'public-role',port:await port(),model:{model:'fixture',baseUrl:'http://127.0.0.1:1',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},0,'T'.repeat(48));
  t.mock.method(f.manager.napcat,'view',async()=>({revision:1,installDirectory:'fixture',webuiPort:6099,configured:true,reachable:true,online:true,accountId:'10002',nickname:'Other',accountMatches:false,phase:'ready',error:'登录账号与机器人 QQ 号不一致，不能启用回复。'}));
  await assert.rejects(f.manager.start(configured.config.revision),/不一致/);assert.equal(f.manager.view().status.listening,false);assert.equal(f.manager.view().config.enabled,false);assert.equal(f.calls,0);
});

test('starting QQ excludes settings changes and a second start before asynchronous account checks',async t=>{
  const f=fixture(t),preview=f.manager.preview(f.selection);f.manager.publish(f.selection,preview.hash,true);
  const configured=await f.manager.configure({...f.manager.view().config,selfId:'10001',privateIds:['20001'],publicationId:'public-role',port:await port(),model:{model:'fixture',baseUrl:'http://127.0.0.1:1',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},0,'T'.repeat(48));
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  t.mock.method(f.manager.napcat,'view',async()=>{await gate;return {configured:false};});
  const starting=f.manager.start(configured.config.revision);
  const saving=f.manager.configure({...configured.config,privateIds:['20002']},configured.config.revision);
  const competingStart=f.manager.start(configured.config.revision);
  // Attach handlers immediately, and release even when an exclusion assertion fails.
  const checks=Promise.all([assert.rejects(saving,/尚未结束/),assert.rejects(competingStart,/尚未结束/)]);
  try{await checks;}finally{release();await Promise.allSettled([starting,saving,competingStart]);}
  const view=f.manager.view();assert.equal(view.status.listening,true);assert.deepEqual(view.config.privateIds,['20001']);assert.equal(view.config.revision,configured.config.revision+1);
});

test('controlled NapCat roundtrip uses actual WS + manager + Runtime + disk ledger; restart duplicate and emergency stop',async t=>{
  const f=fixture(t),preview=f.manager.preview(f.selection);f.manager.publish(f.selection,preview.hash,true);const listenPort=await port();
  let view=await f.manager.configure({...f.manager.view().config,selfId:'10001',privateIds:['20001'],groupIds:['30001'],publicationId:'public-role',port:listenPort,model:{model:'fixture',baseUrl:'http://127.0.0.1:1',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},0,'T'.repeat(48));
  await f.manager.start(view.config.revision);let sends=0;
  async function connect(){
    const ws=new WebSocket(`ws://127.0.0.1:${listenPort}/onebot/v11/ws`,{headers:{Authorization:'Bearer '+'T'.repeat(48),'X-Self-ID':'10001','X-Client-Role':'Universal'}});t.after(()=>ws.terminate());
    ws.on('message',data=>{const action=JSON.parse(data.toString());if(action.action.startsWith('send_'))sends++;ws.send(JSON.stringify({status:'ok',retcode:0,echo:action.echo,data:action.action==='get_login_info'?{user_id:10001}:action.action==='get_status'?{online:true,good:true}:{message_id:900+sends}}));});
    await once(ws,'open');await wait(()=>f.manager.view().status.ready);return ws;
  }
  let ws=await connect();const event={post_type:'message',message_type:'private',sub_type:'friend',self_id:10001,user_id:20001,message_id:1,message:[{type:'text',data:{text:'synthetic'}}]};
  ws.send(JSON.stringify({...event,user_id:20002}));ws.send(JSON.stringify({...event,message_type:'group',group_id:30001,sub_type:'normal',message:[{type:'text',data:{text:'@10001 fake mention'}}]}));
  await new Promise(resolve=>setTimeout(resolve,70));assert.equal(f.calls,0);
  ws.send(JSON.stringify(event));await wait(()=>f.manager.view().deliveries[0]?.state==='sent');assert.equal(f.calls,1);assert.equal(sends,1);
  const oldSession=f.manager.view().deliveries[0]!.scope.sessionId;
  f.manager.newTopic('private','20001',f.manager.view().config.revision);
  const nextEvent={...event,message_id:2,message:[{type:'text',data:{text:'new topic'}}]};ws.send(JSON.stringify(nextEvent));await wait(()=>f.manager.view().deliveries[1]?.state==='sent');assert.notEqual(f.manager.view().deliveries[1]!.scope.sessionId,oldSession);assert.equal(f.calls,2);
  await f.reopen();await f.manager.restore();ws=await connect();ws.send(JSON.stringify(nextEvent));await new Promise(resolve=>setTimeout(resolve,70));assert.equal(f.calls,2);assert.equal(sends,2);
  view=f.manager.view();await f.manager.stop(view.config.revision);assert.equal(f.manager.view().status.listening,false);assert.equal(f.manager.view().config.enabled,false);
  await f.reopen();await f.manager.restore();assert.equal(f.manager.view().status.listening,false);assert.equal(f.calls,2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {createServer as createTcpServer} from 'node:net';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookCredentials} from '../../management/book-credentials.js';
import {BookHttpModel} from '../../providers/book-model.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {QqChannelManager} from '../../app/qq-channel-manager.js';
import {emptyEntry} from '../../contracts/memory-book.js';

const desktopScope={characterId:'aika',pairingId:'local-user',sessionId:'desktop-http'};
const token='Q'.repeat(48);
async function wait(check:()=>boolean,label:string){
  const until=Date.now()+7000;
  while(!check()){
    if(Date.now()>until)throw Error('Timed out: '+label);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
async function unusedPort(){
  const server=createTcpServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;
}
type Payload={model:string;messages:{role:string;content:unknown}[]};
type Action={action:string;params:Record<string,unknown>;echo:string};
async function fixture(t:test.TestContext){
  const parent=resolve('.local/qq-http-acceptance');mkdirSync(parent,{recursive:true});
  const directory=mkdtempSync(join(parent,'run-')),source=new FileBookRepository(join(directory,'book'));
  const credentials=new BookCredentials(join(directory,'credentials')),calls:Payload[]=[],sent:Action[]=[],aborted:string[]=[];
  const holds=new Map<string,()=>void>();
  const http=createServer(async(request,response)=>{
    try{
      assert.equal(request.url,'/v1/chat/completions');
      let raw='';for await(const chunk of request)raw+=chunk;
      const payload=JSON.parse(raw) as Payload;assert.ok(['qq-http-fixture','desktop-http-fixture'].includes(payload.model));
      const prompt=JSON.stringify(payload.messages);calls.push(payload);
      if(payload.model==='qq-http-fixture')assert.ok(!prompt.includes('DESKTOP_PRIVATE_MATERIAL'));
      const marker=['HOLD_A','HOLD_STOP'].find(value=>prompt.includes(value));
      if(marker){
        response.on('close',()=>{if(!response.writableEnded)aborted.push(marker);});
        await new Promise<void>(resolve=>holds.set(marker,resolve));
      }
      if(!response.destroyed){response.setHeader('content-type','application/json');response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'controlled HTTP reply'}}]}));}
    }catch(error){response.statusCode=500;response.end(error instanceof Error?error.message:'controlled HTTP test failed');}
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const address=http.address();assert.ok(address&&typeof address!=='string');
  const binding={baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'qq-http-fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024};
  const config=source.loadConfig();source.commitConfig({...config,mainModel:{...binding,model:'desktop-http-fixture'}},config.revision,'desktop-model');
  source.commit(desktopScope,{upsert:[emptyEntry('public','persona','公开角色','PUBLIC_ROLE'),emptyEntry('private','wiki','桌面未公开资料','DESKTOP_PRIVATE_MATERIAL')]},0,'seed');
  const options={source,credentials,directory:join(directory,'qq'),model:()=>new BookHttpModel(id=>credentials.get(id))};
  let manager=new QqChannelManager(options);const sockets:WebSocket[]=[];
  t.after(async()=>{
    for(const release of holds.values())release();
    await manager.close();for(const socket of sockets)socket.terminate();source.close();
    http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));
  });
  const selection={id:'public-role',revision:1,scope:desktopScope,entryIds:['public'],sourceIds:[],name:'公开角色',intro:'仅公开内容',presetId:null};
  const preview=manager.preview(selection);manager.publish(selection,preview.hash,true);
  const port=await unusedPort();
  await manager.configure({...manager.view().config,selfId:'10001',privateIds:['20001'],groupIds:['30001'],publicationId:'public-role',port,model:binding},0,token);
  await manager.start(manager.view().config.revision);
  async function connect(){
    const socket=new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`,{headers:{Authorization:'Bearer '+token,'X-Self-ID':'10001','X-Client-Role':'Universal'}});sockets.push(socket);
    socket.on('message',raw=>{
      const action=JSON.parse(raw.toString()) as Action;
      if(action.action.startsWith('send_'))sent.push(action);
      const data=action.action==='get_login_info'?{user_id:10001}:action.action==='get_status'?{online:true,good:true}:{message_id:900+sent.length};
      socket.send(JSON.stringify({status:'ok',retcode:0,echo:action.echo,data}));
    });
    await once(socket,'open');await wait(()=>manager.view().status.ready,'verified account ready');return socket;
  }
  return {source,calls,sent,holds,aborted,connect,get manager(){return manager;},async restart(){await manager.close();manager=new QqChannelManager(options);await manager.restore();}};
}
function event(id:number,text:string,sender=20001,group:number|null=30001,mention=true){
  return {post_type:'message',self_id:10001,user_id:sender,message_id:id,message_type:group===null?'private':'group',sub_type:group===null?'friend':'normal',...(group===null?{}:{group_id:group}),sender:{nickname:'controlled member'},message:[...(group!==null&&mention?[{type:'at',data:{qq:'10001'}}]:[]),{type:'text',data:{text}}]};
}

test('OneBot → Manager → Runtime → HTTP model → delivery isolates members, private/desktop scopes, denies non-whitelist and survives reconnect/restart without duplicate calls',{timeout:30000},async t=>{
  const f=await fixture(t);let socket=await f.connect();
  socket.send(JSON.stringify(event(1,'not an actual mention',20001,30001,false)));
  socket.send(JSON.stringify(event(2,'not an authorized group',20001,30002)));
  socket.send(JSON.stringify(event(3,'not an authorized friend',20002,null)));
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
  const first=event(101,'GROUP_MEMBER_A_SECRET');socket.send(JSON.stringify(first));
  await wait(()=>f.sent.length===1,'first member delivery');
  socket.send(JSON.stringify(event(102,'GROUP_MEMBER_B_SECRET',20002)));
  await wait(()=>f.sent.length===2,'second member delivery');
  assert.ok(!JSON.stringify(f.calls[1]).includes('GROUP_MEMBER_A_SECRET'));
  socket.send(JSON.stringify(event(103,'PRIVATE_CONVERSATION_SECRET',20001,null)));
  await wait(()=>f.sent.length===3,'same sender private delivery');
  assert.ok(!JSON.stringify(f.calls[2]).includes('GROUP_MEMBER_A_SECRET'));
  socket.send(JSON.stringify(event(104,'FOLLOWUP_A')));await wait(()=>f.sent.length===4,'same member continuation');
  assert.ok(JSON.stringify(f.calls[3]).includes('GROUP_MEMBER_A_SECRET'));
  assert.ok(!JSON.stringify(f.calls[3]).includes('GROUP_MEMBER_B_SECRET'));
  assert.ok(!JSON.stringify(f.calls[3]).includes('PRIVATE_CONVERSATION_SECRET'));
  assert.deepEqual(f.sent.map(row=>row.action),['send_group_msg','send_group_msg','send_private_msg','send_group_msg']);
  await wait(()=>f.manager.view().deliveries.every(row=>row.state==='sent'),'all platform receipts persisted');
  const desktop=new BookRuntime(f.source,new BookHttpModel(async()=>''));
  const reply=await desktop.chat(desktopScope,'请复述桌面未公开资料',new AbortController().signal,{turnId:'desktop-once'});
  assert.equal(reply.turn.assistant,'controlled HTTP reply');assert.equal(f.calls[4]!.model,'desktop-http-fixture');
  assert.ok(JSON.stringify(f.calls[4]).includes('DESKTOP_PRIVATE_MATERIAL'));
  assert.ok(!JSON.stringify(f.calls[4]).includes('GROUP_MEMBER_A_SECRET'));
  socket.close();await once(socket,'close');socket=await f.connect();socket.send(JSON.stringify(first));
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(f.calls.length,5);assert.equal(f.sent.length,4);
  await f.restart();socket=await f.connect();socket.send(JSON.stringify(first));
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(f.calls.length,5);assert.equal(f.sent.length,4);
  assert.equal(f.source.readSession(desktopScope).length,1);
});

test('group new-topic and emergency stop cancel actual pending HTTP work, preserve other-member replies, and never deliver late output',{timeout:30000},async t=>{
  const f=await fixture(t),socket=await f.connect();socket.send(JSON.stringify(event(201,'HOLD_A')));
  await wait(()=>f.holds.has('HOLD_A'),'first HTTP generation pending');
  socket.send(JSON.stringify(event(202,'OTHER_MEMBER_NORMAL',20002)));
  await wait(()=>f.manager.view().deliveries.some(row=>row.state==='sent'),'other member completed independently');
  const prior=f.manager.view().deliveries.find(row=>row.event.text==='HOLD_A')!;assert.equal(prior.state,'generating');
  f.manager.newTopic('group','30001',f.manager.view().config.revision);
  await wait(()=>f.aborted.includes('HOLD_A'),'old HTTP request aborted');
  await wait(()=>f.manager.view().deliveries.find(row=>row.turnId===prior.turnId)?.state==='cancelled','old generation cancelled durably');
  f.holds.get('HOLD_A')!();assert.equal(f.sent.length,1);
  socket.send(JSON.stringify(event(203,'AFTER_RESET')));await wait(()=>f.sent.length===2,'fresh group topic reply');
  assert.ok(!JSON.stringify(f.calls[2]).includes('HOLD_A'));assert.ok(!JSON.stringify(f.calls[2]).includes('OTHER_MEMBER_NORMAL'));
  socket.send(JSON.stringify(event(204,'HOLD_STOP')));await wait(()=>f.holds.has('HOLD_STOP'),'second HTTP generation pending');
  await f.manager.stop(f.manager.view().config.revision);
  await wait(()=>f.aborted.includes('HOLD_STOP'),'emergency stop aborts HTTP request');
  f.holds.get('HOLD_STOP')!();assert.equal(f.manager.view().status.listening,false);assert.equal(f.manager.view().config.enabled,false);
  const calls=f.calls.length;await f.restart();assert.equal(f.manager.view().status.listening,false);assert.equal(f.calls.length,calls);assert.equal(f.sent.length,2);
  assert.equal(f.source.readSession(desktopScope).length,0);
});

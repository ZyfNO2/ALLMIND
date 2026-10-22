import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {emptyEntry,type ChatMessage} from '../../contracts/memory-book.js';
import {QqChannelService} from '../../app/qq-channel-service.js';
import {normalizeQqEvent} from '../../providers/onebot-qq.js';
import type {PublicationSelection} from '../../memory/channel-publication.js';

const scope={characterId:'aika',pairingId:'local-user',sessionId:'desktop'};
const selection:PublicationSelection={id:'public-role',revision:1,scope,entryIds:['public'],sourceIds:[],name:'公开角色',intro:'公开简介',presetId:null};
function incoming(id:number,target='20001'){
  return normalizeQqEvent({post_type:'message',self_id:10001,user_id:target,message_id:id,message_type:'private',sub_type:'friend',message:[{type:'text',data:{text:'你好 '+target}}]},{connectorId:'qq-test',selfId:'10001',privateIds:['20001','20002'],groupIds:[]})!;
}
function fixture(t:test.TestContext,complete:(messages:ChatMessage[])=>Promise<string>=async()=> 'synthetic reply',send:()=>Promise<{messageId:string}>=async()=>({messageId:'123'})){
  const root=mkdtempSync(join(tmpdir(),'allmind-qq-service-')),source=new FileBookRepository(join(root,'desktop'));
  source.commit(scope,{upsert:[emptyEntry('public','persona','公开身份','PUBLIC_ROLE'),emptyEntry('private','wiki','私人资料','DESKTOP_SECRET')]},0,'seed');
  let active=true,calls=0,sends=0;
  const options={source,directory:join(root,'qq'),route:()=>active?{publicationId:'public-role',epoch:'initial'}:null,modelConfig:()=>({...source.loadConfig(),mainModel:{baseUrl:'http://127.0.0.1:1',model:'fixture',credentialId:'no-auth',inputTokens:8192,outputTokens:1024}}),model:()=>({async complete(_binding:unknown,messages:ChatMessage[]){calls++;assert.ok(!JSON.stringify(messages).includes('DESKTOP_SECRET'));return complete(messages);}}),async send(){sends++;return send();}};
  let service=new QqChannelService(options);
  const preview=service.preview(selection);service.publish(selection,preview.hash,true);
  t.after(async()=>{await service.close();source.close();rmSync(root,{recursive:true,force:true});});
  return {source,get service(){return service;},get calls(){return calls;},get sends(){return sends;},disable(){active=false;},async restart(){await service.close();service=new QqChannelService(options);return service;}};
}

test('service requires exact publication confirmation and durable duplicate delivery survives restart',async t=>{
  const f=fixture(t);assert.throws(()=>f.service.publish(selection,'a'.repeat(64),true),/确认/);assert.throws(()=>f.service.publish(selection,f.service.preview(selection).hash,false),/确认/);
  const event=incoming(1);assert.equal((await f.service.receive(event))!.state,'sent');assert.equal(f.calls,1);assert.equal(f.sends,1);
  await f.restart();await f.service.resumeQueued();assert.equal((await f.service.receive(event))!.state,'sent');assert.equal(f.calls,1);assert.equal(f.sends,1);
  assert.equal(f.source.listSessions('aika','local-user').length,0);
});

test('lost receipt freezes unknown across restart and duplicate input does not regenerate or resend',async t=>{
  const f=fixture(t,undefined,async()=>{throw new Error('synthetic lost acknowledgement');});const event=incoming(2);
  await assert.rejects(f.service.receive(event),/lost acknowledgement/);assert.equal(f.service.ledger.get(event.eventKey)!.state,'unknown');
  await f.restart();await f.service.resumeQueued();assert.equal((await f.service.receive(event))!.state,'unknown');assert.equal(f.calls,1);assert.equal(f.sends,1);
});

test('two recipients have independent production Runtime histories',async t=>{
  const seen:ChatMessage[][]=[];const f=fixture(t,async messages=>{seen.push(messages);return 'fixture';});
  await f.service.receive(incoming(10,'20001'));await f.service.receive(incoming(11,'20002'));await f.service.receive(incoming(12,'20001'));
  assert.ok(!JSON.stringify(seen[1]).includes('你好 20001'));assert.ok(!JSON.stringify(seen[2]).includes('你好 20002'));
  assert.equal(f.calls,3);assert.equal(f.sends,3);
});

test('same recipient serializes generation while revocation prevents completed model output from sending',async t=>{
  let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(resolve=>{started=resolve;});
  const f=fixture(t,async()=>{started();await new Promise<void>(resolve=>{release=resolve;});return 'late output';});
  const event=incoming(20),first=f.service.receive(event);await waiting;const duplicate=await f.service.receive(event);assert.equal(duplicate!.state,'generating');assert.equal(f.calls,1);
  f.disable();release();await assert.rejects(first,/暂停|撤销/);assert.equal(f.service.ledger.get(event.eventKey)!.state,'cancelled');assert.equal(f.sends,0);
});

test('changed or revoked source refuses future intake without creating a delivery',async t=>{
  const f=fixture(t),before=f.source.snapshot(scope),entry=before.entries.find(row=>row.id==='public')!;
  f.source.commit(scope,{upsert:[{...entry,body:'changed public role'}]},before.revision,'change');
  await assert.rejects(f.service.receive(incoming(30)));assert.equal(f.service.ledger.list().length,0);assert.equal(f.calls,0);
});

test('explicit review retries only the unknown output segment without a second model call',async t=>{
  let sends=0;const f=fixture(t,async()=> 'x'.repeat(1501),async()=>{sends++;if(sends===2)throw Error('second segment lost');return {messageId:String(100+sends)};});const event=incoming(40);
  await assert.rejects(f.service.receive(event),/second segment lost/);let row=f.service.ledger.get(event.eventKey)!;
  assert.equal(row.parts[0]!.state,'sent');assert.equal(row.parts[1]!.state,'unknown');
  await assert.rejects(f.service.review(event.eventKey,1,'retry',null,false),/核对/);assert.equal(sends,2);
  row=await f.service.review(event.eventKey,1,'retry',null,true);assert.equal(row.state,'sent');assert.equal(f.calls,1);assert.equal(sends,3);assert.equal(row.parts[0]!.messageId,'101');
  await f.restart();await f.service.resumeQueued();assert.equal(f.calls,1);assert.equal(sends,3);
});

test('per-recipient durable minute limit rejects excess before model and survives restart',async t=>{
  const f=fixture(t);for(let id=100;id<106;id++)await f.service.receive(incoming(id));assert.equal(f.calls,6);
  await assert.rejects(f.service.receive(incoming(106)),/限频/);assert.equal(f.calls,6);await f.restart();await assert.rejects(f.service.receive(incoming(106)),/限频/);assert.equal(f.calls,6);
  assert.equal((await f.service.receive(incoming(100)))!.state,'sent');assert.equal(f.calls,6);
});

test('different events in the same conversation never run model generation concurrently',async t=>{
  let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(resolve=>{started=resolve;});let count=0;
  const f=fixture(t,async()=>{count++;if(count===1){started();await new Promise<void>(resolve=>{release=resolve;});}return 'fixture';});
  const first=f.service.receive(incoming(200));await waiting;const second=f.service.receive(incoming(201));await new Promise(resolve=>setTimeout(resolve,30));assert.equal(count,1);release();await Promise.all([first,second]);assert.equal(count,2);
});

test('unsupported image-only and mixed QQ media produce an explicit local receipt without model inference or silent dropping',async t=>{
 const f=fixture(t);const event=normalizeQqEvent({post_type:'message',self_id:10001,user_id:20001,message_id:401,message_type:'private',sub_type:'friend',message:[{type:'image',data:{file:'never-open-private-file'}}]},{connectorId:'qq-test',selfId:'10001',privateIds:['20001'],groupIds:[]})!;
 assert.ok(event);const row=await f.service.receive(event);assert.equal(row!.state,'sent');assert.match(row!.parts[0]!.text,/尚不支持/);assert.equal(f.calls,0);assert.equal(f.sends,1);assert.ok(!JSON.stringify(row).includes('never-open-private-file'));await f.service.receive(event);assert.equal(f.sends,1);
});


test('QQ routes original greeting and explicit RP before untrusted wrapping, keeping RP history out of subsequent public Smart chat',async t=>{
 const seen:ChatMessage[][]=[],f=fixture(t,async messages=>{seen.push(messages);return 'controlled reply'});
 await f.service.receive({...incoming(81),text:'你好'});await f.service.receive({...incoming(82),text:'/rp RP_CHANNEL_SECRET'});await f.service.receive({...incoming(83),text:'请回答一个普通问题'});
 assert.equal(f.calls,3);assert.ok(JSON.stringify(seen[1]).includes('RP_CHANNEL_SECRET'));assert.ok(!JSON.stringify(seen[2]).includes('RP_CHANNEL_SECRET'));assert.ok(!JSON.stringify(seen).includes('DESKTOP_SECRET'));assert.equal(f.source.readSession(scope).length,0);
});

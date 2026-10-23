import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {BookCredentials} from '../../management/book-credentials.js';
import {startBookServer} from '../../management/book-server.js';
import {BookProactiveScheduler,zonedTime} from '../../core/book-proactive.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../contracts/book-companion.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BookInteractionPresence} from '../../core/book-interaction-presence.js';
const scope={characterId:'aika',pairingId:'local-user',sessionId:'web'},id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const flags={viewId:id,sequence:1,typing:true,recording:false,speaking:false,busy:false};
test('interaction leases merge independent pages and roles, expire without persisting text',()=>{
 const presence=new BookInteractionPresence();presence.update(scope,flags,1000);assert.equal(presence.read('aika',1001).typing,true);assert.equal(presence.read('other',1001).typing,false);
 presence.update({...scope,sessionId:'another'},{...flags,viewId:other,typing:false,recording:true},1000);
 presence.update(scope,{...flags,sequence:2,typing:false},1002);assert.equal(presence.read('aika',1003).typing,false);assert.equal(presence.read('aika',1003).recording,true);assert.equal(presence.read('aika',21000).recording,false);
});
test('late or repeated active updates cannot revive a released browser lease',()=>{
 const presence=new BookInteractionPresence();presence.update(scope,flags,1000);presence.update(scope,{...flags,sequence:3,typing:false},1001);
 assert.equal(presence.update(scope,{...flags,sequence:2},1002).accepted,false);assert.equal(presence.update(scope,{...flags,sequence:3},1003).accepted,false);assert.equal(presence.read('aika',1004).typing,false);
});
test('presence refuses typed text, malformed flags and an unbounded set of page IDs',()=>{
 const presence=new BookInteractionPresence();assert.throws(()=>presence.update(scope,{...flags,text:'must not be sent'} as any));assert.throws(()=>presence.update(scope,{...flags,sequence:NaN}));assert.throws(()=>presence.update(scope,{...flags,recording:'yes'} as any));
 for(let i=0;i<128;i++)presence.update(scope,{...flags,viewId:i.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111'},1000);assert.throws(()=>presence.update(scope,{...flags,viewId:other},1001),/上限/);presence.update(scope,{...flags,viewId:other},61001);assert.equal(presence.read('aika',61002).typing,true);
});

test('real management route suppresses scheduling and cancels an in-flight proactive reply without late dispatch',{timeout:15000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'presence-scheduler-')),repository=new FileBookRepository(directory),config=repository.loadConfig();
 repository.commitConfig({...config,companion:{...DEFAULT_COMPANION_SETTINGS,proactive:true,quietStart:0,quietEnd:0}},config.revision,'enable');
 const runtime=new BookRuntime(repository,{async complete(){throw Error('No model call through chat')}});let now=zonedTime('2026-10-21',8,55,'Asia/Singapore'),calls=0,displays=0,release!:()=>void;
 const scheduler=new BookProactiveScheduler(repository,async()=>{calls++;await new Promise<void>(resolve=>release=resolve);return '迟到的问候'},()=>displays++,()=>now);scheduler.takeover(scope,null);now=zonedTime('2026-10-21',9,1,'Asia/Singapore');
 const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management'),onInteractionPresence:()=>scheduler.cancel()});t.after(async()=>{release?.();scheduler.cancel();await server.close();repository.close();rmSync(directory,{recursive:true,force:true})});
 const endpoint=new URL(server.url).origin+'/api/memory-book/v1/interaction-presence';
 const post=(input:unknown,headers:Record<string,string>={Authorization:'Bearer '+server.token})=>fetch(endpoint,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({...scope,...input as object})});
 assert.equal((await post(flags,{})).status,401);assert.equal((await post({...flags,text:'should not be accepted'})).status,400);
 const present=()=>{const f=runtime.interactionPresence.read();return {hidden:false,dnd:false,quiet:false,typing:f.typing,recording:f.recording,busy:f.busy||f.speaking}};
 assert.equal((await post(flags)).status,200);await scheduler.tick(scope,present());assert.equal(calls,0);
 await post({...flags,sequence:2,typing:false});const pending=scheduler.tick(scope,present());for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);
 const cancelled=assert.rejects(pending,{code:'conflict'});await post({...flags,sequence:3,typing:false,recording:true});release();await cancelled;assert.equal(displays,0);assert.equal(repository.loadCompanionData(scope).deliveries[0]?.status,'cancelled');
});

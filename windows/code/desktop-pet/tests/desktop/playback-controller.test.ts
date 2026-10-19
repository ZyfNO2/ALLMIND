import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopPlaybackController } from '../../desktop/playback-controller.js';
import type { PlaybackDriver, PlaybackSample, PlaybackSession } from '../../media/playback.js';
import type { PlaybackEvent, TtsResult, TurnScope } from '../../contracts/index.js';
const scope:TurnScope={characterId:'companion',sessionId:'s',turnId:'t',generation:1};
const tts:TtsResult={scope,audio:{id:'a',uri:'probe://a',mimeType:'audio/wav',temporary:true},expression:{emotion:'happy',intensity:1,delivery:'',gesture:'heart'},durationMs:null,synchronization:'amplitude'};
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
function fixture(delayedOpen=false){
 const done=deferred<void>(), opening=deferred<PlaybackSession>();let signal:AbortSignal|undefined,emit:(e:PlaybackSample)=>void=()=>{};let opens=0,stops=0;
 const session:PlaybackSession={done:done.promise,stop:()=>{stops++;done.resolve();}};
 const driver:PlaybackDriver={open:async(_bytes,_id,callback,s)=>{opens++;emit=callback;signal=s;return delayedOpen?opening.promise:session;}};
 const events:PlaybackEvent[]=[];const controller=new DesktopPlaybackController(driver,()=>true,(_id,e)=>events.push(e));
 return {controller,events,done,opening,session,get opens(){return opens;},get stops(){return stops;},get aborted(){return signal?.aborted;},emit:(e:PlaybackSample)=>emit(e)};
}
const sample=(type:'ended'|'stopped')=>({type,at:new Date().toISOString()});
test('duplicated play packet opens a single device session and has one terminal event',async()=>{
 const f=fixture();const bytes=new Uint8Array([1,2]);const p=f.controller.play('req',tts,bytes);
 await f.controller.play('req',tts,new Uint8Array([3,4]));assert.equal(f.opens,1);
 f.emit({type:'started',audioId:'a',at:''});f.emit(sample('ended'));f.emit(sample('ended'));f.done.resolve();await p;
 assert.equal(f.events.filter(e=>['ended','stopped','error'].includes(e.type)).length,1);
 assert.deepEqual([...bytes],[0,0]);assert.equal(f.controller.busy,false);
});
test('cancel during device opening aborts immediately and closes a late session without reviving output',async()=>{
 const f=fixture(true);const bytes=new Uint8Array([1]);const p=f.controller.play('req',tts,bytes);
 f.controller.stop();assert.equal(f.aborted,true);assert.equal(f.controller.busy,false);
 f.emit({type:'started',audioId:'late',at:''});f.opening.resolve(f.session);await p;
 assert.deepEqual(f.events.map(e=>e.type),['stopped']);assert.ok(f.stops>0);assert.equal(bytes[0],0);
});
test('late terminal and amplitude after stop cannot leak into a newer session',async()=>{
 const f=fixture();const p=f.controller.play('req',tts,new Uint8Array([1]));await Promise.resolve();
 f.controller.stop();f.emit({type:'amplitude',value:1,at:''});f.emit(sample('ended'));await p;
 assert.deepEqual(f.events.map(e=>e.type),['stopped']);
});
test('a stop for another role/session/turn never stops this output',async()=>{
 const f=fixture();const p=f.controller.play('req',tts,new Uint8Array([1]));await Promise.resolve();
 for(const other of [{...scope,characterId:'sweetheart' as const},{...scope,sessionId:'old'},{...scope,turnId:'old'},{...scope,generation:0}])f.controller.stop(other);
 assert.equal(f.controller.busy,true);assert.equal(f.stops,0);
 f.controller.stop(scope);await p;assert.deepEqual(f.events.map(e=>e.type),['stopped']);
});
test('a resolved device promise without actual output completion is an error, never ended',async()=>{
 const f=fixture();const p=f.controller.play('req',tts,new Uint8Array([1]));f.done.resolve();await p;
 assert.deepEqual(f.events.map(e=>e.type),['error']);
});
test('stale audio never reaches the device and its bridge copy is wiped',async()=>{
 let opens=0;const controller=new DesktopPlaybackController({open:async()=>{opens++;throw Error('should not open');}},()=>false,()=>{});
 const bytes=new Uint8Array([1]);await assert.rejects(controller.play('req',tts,bytes),/失效/);assert.equal(opens,0);assert.equal(bytes[0],0);
});
/**
 * RWR-10-01: the reply-sound switch suppresses the DEVICE without breaking the turn. A muted reply must
 * still produce exactly one terminal event, or the backend's `play` request would never resolve.
 */
test('RWR-10-01: with reply sound off no device session opens and the turn still terminates once',async()=>{
 const f=fixture();f.controller.setOutputEnabled(false);
 const bytes=new Uint8Array([9,9]);const p=f.controller.play('req',tts,bytes);await p;
 assert.equal(f.opens,0,'a muted reply must not open the audio device');
 assert.deepEqual(f.events.map(e=>e.type),['stopped'],'exactly one terminal event, so the play request resolves');
 assert.equal(f.controller.busy,false);assert.equal(f.controller.soundEnabled,false);
 assert.deepEqual([...bytes],[0,0],'the audio copy is still wiped when muted');
});
test('RWR-10-01: turning sound off mid-reply stops the current output',async()=>{
 const f=fixture();const p=f.controller.play('req',tts,new Uint8Array([1]));await Promise.resolve();
 assert.equal(f.controller.busy,true);
 f.controller.setOutputEnabled(false);
 assert.equal(f.controller.busy,false);assert.ok(f.stops>0);
 await p;assert.deepEqual(f.events.map(e=>e.type),['stopped']);
});
test('RWR-10-01: turning sound back on restores real playback',async()=>{
 const f=fixture();f.controller.setOutputEnabled(false);await f.controller.play('req',tts,new Uint8Array([1]));
 f.controller.setOutputEnabled(true);
 const p=f.controller.play('req2',tts,new Uint8Array([2]));await Promise.resolve();
 assert.equal(f.opens,1,'a re-enabled switch plays through the real device again');
 f.emit({type:'started',audioId:'a',at:''});f.emit(sample('ended'));f.done.resolve();await p;
 assert.deepEqual(f.events.map(e=>e.type),['stopped','started','ended']);
});

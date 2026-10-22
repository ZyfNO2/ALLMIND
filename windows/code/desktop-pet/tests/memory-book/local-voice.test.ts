import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookVoiceService} from '../../management/book-voice.js';
import type {BookSpeechEngine} from '../../providers/windows-book-speech.js';
import {DEFAULT_BOOK_VOICE,validateBookVoice} from '../../contracts/book-voice.js';
import {startBookServer} from '../../management/book-server.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {BookCredentials} from '../../management/book-credentials.js';
import {resolve} from 'node:path';
import {pcm16Wav} from '../../media/wav.js';

const scope={characterId:'aika',pairingId:'local-user',sessionId:'voice'},signal=()=>new AbortController().signal;
function fixture(t:test.TestContext){
 const directory=mkdtempSync(join(tmpdir(),'book-voice-')),repo=new FileBookRepository(directory);t.after(()=>{repo.close();rmSync(directory,{recursive:true,force:true})});
 let calls=0;const engine:BookSpeechEngine={async capabilities(){return {available:true,voices:[{name:'test',culture:'zh-CN'}],recognizers:[{id:'zh',culture:'zh-CN'}]}},async synthesize(){calls++;return {bytes:pcm16Wav(new Float32Array(1600),16000),durationMs:100}},async recognize(){calls++;return {text:'识别结果',segments:[{text:'识别结果',confidence:0.8}]}}};
 function settings(override={}){const config=repo.loadConfig();repo.commitConfig({...config,characters:config.characters.map(row=>({...row,voice:{...DEFAULT_BOOK_VOICE,enabled:true,...override}}))},config.revision,'voice-'+config.revision)}
 return {repo,engine,settings,service:new BookVoiceService(repo,engine),calls:()=>calls};
}
const audio=()=>Buffer.from(pcm16Wav(new Float32Array(1600),16000)).toString('base64');
test('voice is opt-in; recognized text and audio never create history or alter book',async t=>{
 const f=fixture(t);await assert.rejects(f.service.recognize(scope,audio(),signal()),/启用并保存/);assert.equal(f.calls(),0);f.settings();
 const before=f.repo.snapshot(scope),config=f.repo.loadConfig();assert.equal((await f.service.recognize(scope,audio(),signal())).text,'识别结果');
 assert.ok((await f.service.synthesize(scope,'你好',signal())).audioBase64);assert.equal(f.calls(),2);assert.deepEqual(f.repo.snapshot(scope),before);assert.deepEqual(f.repo.loadConfig(),config);
});

test('transcript receipts bind exact scoped spans, reject edited/foreign text and are cleared on cancellation',async t=>{
 const f=fixture(t);f.settings();const result=await f.service.recognize(scope,audio(),signal());assert.match(result.receipt.id,/^transcript-/);
 const receipt=f.service.verifyTranscript(scope,result.receipt.id,'已有草稿\n识别结果',5);assert.equal(receipt.start,5);assert.equal(receipt.end,9);assert.equal(receipt.sha256,result.receipt.sha256);
 assert.throws(()=>f.service.verifyTranscript({...scope,sessionId:'other'},result.receipt.id,'识别结果',0),/其他会话/);
 assert.throws(()=>f.service.verifyTranscript(scope,result.receipt.id,'修改过的转写',0),/已修改/);f.service.cancel(scope);assert.throws(()=>f.service.verifyTranscript(scope,result.receipt.id,'识别结果',0),/过期/);
});
test('invalid/oversized input and missing installed components fail explicitly',async t=>{
 const f=fixture(t);f.settings();for(const value of ['', 'abcd==','a'.repeat(2000001),Buffer.from('bad WAV').toString('base64')])await assert.rejects(f.service.recognize(scope,value,signal()));
 await assert.rejects(f.service.recognize(scope,Buffer.from(pcm16Wav(new Float32Array(480001),16000)).toString('base64'),signal()),/最长 30/);
 await assert.rejects(f.service.synthesize(scope,'a'.repeat(2001),signal()),/2000/);assert.equal(f.calls(),0);
 f.settings({language:'xx-XX'});await assert.rejects(f.service.recognize(scope,audio(),signal()),/未安装/);
 f.settings({voiceName:'not-installed'});await assert.rejects(f.service.synthesize(scope,'你好',signal()),/不会自动换/);assert.equal(f.calls(),0);
});
test('empty recognition is an error and audio buffers are cleared',async t=>{
 const f=fixture(t);f.settings();let buffer:Uint8Array|undefined;f.engine.recognize=async bytes=>{buffer=bytes;return {text:'',segments:[]}};
 await assert.rejects(f.service.recognize(scope,audio(),signal()),/没有识别/);assert.ok(buffer?.every(value=>value===0));
});
test('scope cancellation rejects late speech; new operation waits for native cleanup',async t=>{
 const f=fixture(t);f.settings();let release!:()=>void;f.engine.recognize=async()=>{await new Promise<void>(resolve=>release=resolve);return {text:'late',segments:[]}};
 const pending=f.service.recognize(scope,audio(),signal());await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(f.service.synthesize(scope,'another',signal()),/正在处理/);f.service.cancel(scope);release();await assert.rejects(pending,/取消或超时/);
 f.engine.recognize=async()=>({text:'new',segments:[]});assert.equal((await f.service.recognize(scope,audio(),signal())).text,'new');
});
test('changed voice settings invalidate outstanding results',async t=>{
 const f=fixture(t);f.settings();let release!:()=>void;f.engine.recognize=async()=>{await new Promise<void>(resolve=>release=resolve);return {text:'late',segments:[]}};
 const pending=f.service.recognize(scope,audio(),signal());await new Promise(resolve=>setImmediate(resolve));f.settings({autoRead:true});release();await assert.rejects(pending,/设置已变化/);
});
test('voice config refuses script-shaped and extra fields',()=>{
 assert.throws(()=>validateBookVoice({...DEFAULT_BOOK_VOICE,enabled:'yes'} as any));assert.throws(()=>validateBookVoice({...DEFAULT_BOOK_VOICE,execute:'anything'} as any));assert.throws(()=>validateBookVoice({...DEFAULT_BOOK_VOICE,language:'zh-CN;run'}));
});

test('voice HTTP retains auth/origin validation, saves opt-in settings and does not invoke a model',async t=>{
 const f=fixture(t);f.settings();const directory=mkdtempSync(join(tmpdir(),'voice-http-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const runtime=new BookRuntime(f.repo,{async complete(){throw Error('Speech must not invoke LLM')}}),server=await startBookServer({runtime,credentials:new BookCredentials(directory),uiRoot:resolve('management'),voice:f.service});t.after(()=>server.close());
 const url=new URL(server.url),token=new URLSearchParams(url.hash.slice(1)).get('token')!,base=url.origin+'/api/memory-book/v1';
 const request=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await fetch(base+'/voice/capabilities')).status,401);
 assert.equal((await request('/voice/recognize',{...scope,audioBase64:audio()},{Origin:'https://untrusted.example'})).status,403);assert.equal(f.calls(),0);
 const response=await request('/voice/recognize',{...scope,audioBase64:audio()});assert.equal(response.status,200);assert.equal((await response.json() as {text:string}).text,'识别结果');
 assert.equal(f.repo.readSession(scope).length,0);assert.equal((await request('/voice/recognize',{...scope,audioBase64:'bad'})).status,400);
});

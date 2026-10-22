import {spawn} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
// Run only against a fresh, explicitly selected data directory; no user instance is stopped.
const option=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error('Required: --package <portable directory> --data <unused data directory> --report <result.json>');return resolve(process.argv[i+1]);};
const root=option('--package'),data=option('--data'),report=option('--report');
if(existsSync(data))throw Error('Use an unused isolated data directory. No files were removed.');
const {pipeRequest}=await import(pathToFileURL(join(root,'desktop/wpf/pipe.mjs')).href);
const args=['desktop/wpf/main.mjs','--data',data];
const inventory=JSON.parse(readFileSync(join(root,'package-manifest.json'),'utf8'));
for(const file of inventory.files){const path=resolve(root,file.path);if(!path.startsWith(root+'\\')&&!path.startsWith(root+'/'))throw Error('Invalid inventory path');assert.equal(lstatSync(path).isSymbolicLink(),false);assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),file.sha256,file.path);}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child,checks=0;
let releaseReply,replyRequests=0,notifyIncoming;
const incoming=new Promise(r=>notifyIncoming=r);
const fixture=createServer(async(req,res)=>{
 if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
 for await(const chunk of req){}replyRequests++;notifyIncoming();await new Promise(r=>releaseReply=r);
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Synthetic reply survives a hidden pet.'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
});
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const descriptor=()=>read(data+'/host/controller.json');
async function command(method,params={}){const d=descriptor();return pipeRequest(d.endpoint,d.token,method,params);}
async function wait(predicate,label){const deadline=Date.now()+30000;let last;while(Date.now()<deadline){try{last=await command('state');if(predicate(last)){checks++;return last;}}catch(error){last={error:error.message};}await delay(100);}throw Error(label+' timed out: '+JSON.stringify(last));}
async function start(){child=spawn(join(root,'runtime/node.exe'),args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});return wait(s=>s.backend==='ready'&&s.visibility&&s.appearanceSkinId,'ready and actual portrait acknowledgement');}
async function stop(){if(!child||child.exitCode!==null)return;const exited=once(child,'exit');await command('exit');const [code]=await Promise.race([exited,delay(20000).then(()=>{throw Error('owned controller did not exit');})]);assert.equal(code,0);checks++;assert.equal(existsSync(data+'/host/controller.json'),false);assert.equal(existsSync(data+'/book/writer.lock'),false);checks+=2;}
const facts=[];
try{
 // A handshake alone missed Windows GUI stdin EOF. Exercise requests too.
 const {startBrowserHost}=await import(pathToFileURL(join(root,'desktop/wpf/browser-channel.mjs')).href);
 const helper=await startBrowserHost({executable:join(root,'node_modules/electron/dist/electron.exe'),script:join(root,'desktop/wpf/browser-host.mjs'),data:join(data,'browser-smoke')});
 try{await assert.rejects(helper.request('probe-invalid-1',{action:'invalid'}),/未知/);await delay(500);assert.equal(helper.closed,false);await assert.rejects(helper.request('probe-invalid-2',{action:'invalid'}),/未知/);checks+=3;}finally{await helper.close();assert.equal(helper.closed,true);checks++;}
 facts.push('Packaged GUI Electron accepted repeated authenticated named-pipe requests with stdin ignored, then shut down on channel close. No login/model request in this fixture suite.');
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
 assert.equal(existsSync(data+'/host/controller.json'),false,'Use an unused isolated directory');
 let state=await start();assert.equal(state.characterId,'gpt-niang');assert.equal(state.appearanceSkinId,'starter-gpt-niang');assert.equal(resolve(descriptor().nodePath),join(root,'runtime/node.exe'));checks+=3;assert.equal(state.visibility.mode,'smart');assert.equal(state.visibility.manualHidden,false);checks+=2;
 const session=read(data+'/book/management-session.json');const backendPid=session.pid,origin=state.managementOrigin;
 const token=new URLSearchParams(new URL(session.url).hash.slice(1)).get('token');
 async function api(path,method='GET',body){const response=await fetch(origin+'/api/memory-book/v1'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
 const preview=await fetch(origin+'/preview-runtime/presentation-preview.js');assert.equal(preview.status,200);assert.ok((await preview.text()).length>100);checks+=2;
 const loaded=await api('/runtime');let config=loaded.config;assert.equal(config.mainModel,null);checks++;
 const voiceCapabilities=await api('/voice/capabilities'),screenCapabilities=await api('/screen/capabilities');assert.equal(typeof voiceCapabilities.available,'boolean');assert.equal(typeof screenCapabilities.available,'boolean');checks+=2;
 const voice=voiceCapabilities.voices?.find(row=>voiceCapabilities.recognizers?.some(recognizer=>recognizer.culture===row.culture));
 if(voiceCapabilities.available&&voice){
  config={...config,characters:config.characters.map(role=>role.id===state.characterId?{...role,voice:{enabled:true,language:voice.culture,voiceName:voice.name,autoRead:false}}:role)};
  config=(await api('/runtime','PUT',{config,expectedRevision:config.revision,operationId:'portable-local-voice'})).config;
  const scope={characterId:state.characterId,sessionId:'portable-local-media'},spoken=await api('/voice/synthesize','POST',{...scope,text:voice.culture==='zh-CN'?'你好，今天的天气很好。我们一起完成测试。':'Hello, the weather is nice today. Let us finish the test.'});
  assert.ok(spoken.audioBase64);assert.ok(spoken.durationMs>0);checks+=2;
  const recognized=await api('/voice/recognize','POST',{...scope,audioBase64:spoken.audioBase64});assert.ok(recognized.text.trim());checks++;
  facts.push('Packaged Windows speech helper synthesized and recognized a synthetic file-stream phrase; no microphone or speaker was opened.');
 }else facts.push('Local speech exercise NOT_RUN: matching installed voice/recognizer unavailable; capability endpoint returned explicitly.');
 if(screenCapabilities.available){
  const image=readFileSync(fileURLToPath(new URL('../tests/companion-knowledge/fixtures/ocr/english.png',import.meta.url)));
  const capture=await api('/screen/recognize','POST',{characterId:state.characterId,sessionId:'portable-local-media',imageBase64:image.toString('base64'),mime:'image/png',sourceName:'Synthetic portable image; no real screen',sourceKind:'window',confirmed:true});
  assert.match(capture.text,/Meet.*10.*30.*42/);assert.match(capture.id,/^screen-/);checks+=2;
  await api('/screen/observations/'+capture.id+'?'+new URLSearchParams({characterId:state.characterId,sessionId:'portable-local-media'}),'DELETE',{});checks++;
  facts.push('Packaged WinRT OCR helper recognized synthetic English image pixels through its authenticated endpoint; observation explicitly cleared, no real screen capture.');
 }else facts.push('Local OCR exercise NOT_RUN: Windows OCR unavailable; no fixture substituted for native recognition.');
 assert.equal(replyRequests,0);checks++;const localMediaHistory=await api('/chat/history?characterId='+state.characterId+'&sessionId=portable-local-media');assert.equal(localMediaHistory.turns.length,0);checks++;
 config.mainModel={baseUrl:'http://127.0.0.1:'+fixture.address().port+'/v1',model:'synthetic-fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:512};
 await api('/runtime','PUT',{config,expectedRevision:config.revision,operationId:'floating-fixture-binding'});
 const chat=api('/chat','POST',{characterId:state.characterId,sessionId:'floating-fixture',text:'Synthetic request; reply after hide.',turnId:'floating-fixture-turn'});
 await Promise.race([incoming,delay(20000).then(()=>{throw Error('Fixture never received model request');})]);checks++;
 const accepted=await command('visible',{visible:false});assert.equal(accepted.accepted,true);assert.equal(accepted.requestedVisible,false);checks+=2;
 state=await wait(s=>s.hidden&&s.visibility.manualHidden&&!s.visibility.visible,'manual hide');
 assert.equal(state.backend,'ready');assert.equal(state.managementOrigin,origin);process.kill(backendPid,0);checks+=3;
 assert.equal(read(data+'/book/management-session.json').pid,backendPid);checks++;
 const prefs=read(data+'/host/visibility.json');assert.equal(prefs.manualHidden,true);checks++;
 releaseReply();releaseReply=null;const reply=await chat;assert.equal(reply.turn.assistant,'Synthetic reply survives a hidden pet.');checks++;
 const history=await api('/chat/history?characterId='+state.characterId+'&sessionId=floating-fixture');assert.equal(history.turns.at(-1).assistant,'Synthetic reply survives a hidden pet.');checks++;
 const quickTurn='portable-quick-chat-turn';const quick=await command('quick-chat',{characterId:state.characterId,sessionId:state.sessionId,turnId:quickTurn,text:'Synthetic desktop composer input.'});assert.equal(quick.accepted,true);checks++;
 for(let i=0;replyRequests<2&&i<200;i++)await delay(25);assert.equal(replyRequests,2);assert.ok(releaseReply);releaseReply();releaseReply=null;
 let desktopHistory;for(let i=0;i<100;i++){desktopHistory=await api('/chat/history?characterId='+state.characterId+'&sessionId='+state.sessionId);if(desktopHistory.turns.some(turn=>turn.id===quickTurn))break;await delay(50);}assert.equal(desktopHistory.turns.find(turn=>turn.id===quickTurn)?.assistant,'Synthetic reply survives a hidden pet.');checks+=2;
 await assert.rejects(command('quick-chat',{characterId:'different-role',sessionId:state.sessionId,turnId:'wrong-scope',text:'not sent'}),/范围/);checks++;
 const before=state.visibility.revision;await delay(1300);state=await command('state');assert.equal(state.visibility.manualHidden,true);assert.ok(state.visibility.revision>=before);checks+=2;
 facts.push('Manual hide persists while the original backend stays alive; no UI event injection.');
 await stop();state=await start();assert.equal(state.hidden,true);assert.equal(state.visibility.manualHidden,true);checks+=2;
 const restarted=await fetch(state.managementOrigin+'/api/memory-book/v1/chat/history?characterId=gpt-niang&sessionId=floating-fixture',{headers:{authorization:'Bearer '+new URLSearchParams(new URL(read(data+'/book/management-session.json').url).hash.slice(1)).get('token')}});assert.equal(restarted.status,200);assert.equal((await restarted.json()).turns.at(-1).assistant,'Synthetic reply survives a hidden pet.');checks+=2;
 const ownerPid=descriptor().pid;
 const duplicate=spawn('wscript.exe',[join(root,'Start-ALLMIND.vbs'),data],{cwd:root,windowsHide:true,stdio:'ignore'});const [duplicateCode]=await once(duplicate,'exit');assert.equal(duplicateCode,0);checks++;
 state=await wait(s=>!s.hidden&&!s.visibility.manualHidden,'explicit duplicate-launch reveal');assert.equal(descriptor().pid,ownerPid);checks++;
 assert.equal(replyRequests,2);checks++;facts.push('Desktop quick-chat command persisted its reply in the desktop session; wrong-role submission was rejected; restart did not resend it.');facts.push('A real local HTTP fixture request completed and persisted while hidden; restart/reveal did not resend it.');
 facts.push('Full process restart preserves manual hide; an explicit duplicate launch restores the same controller.');
 const malformed={...state.visibility,revision:0};await assert.rejects(command('presence',{visibility:malformed}),/状态/);checks++;
 await stop();
 const result={status:'PASS',checks,inventoryFiles:inventory.files.length,facts,nativeInput:'NOT_RUN (user will test)',realFullscreen:'NOT_RUN',lockSleep:'NOT_RUN'};
 writeFileSync(report,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{
 if(releaseReply)releaseReply();fixture.closeAllConnections();if(fixture.listening)await new Promise(r=>fixture.close(r));
 if(child&&child.exitCode===null){try{await stop();}catch{child.kill();}}
}

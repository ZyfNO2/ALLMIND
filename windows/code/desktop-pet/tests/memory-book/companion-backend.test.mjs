import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../dist/contracts/memory-book.js';
import { DEFAULT_COMPANION_SETTINGS } from '../../dist/contracts/book-companion.js';

test('default Book backend chat -> automatic event -> proactive -> renderer ack, without fake user history', {timeout:60000},async t=>{
  mkdirSync('.local/allmind-m23/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m23/tests/backend-')),requests=[];
  const provider=createServer(async(request,response)=>{let raw='';for await(const part of request)raw+=part;const data=JSON.parse(raw);requests.push(data);
    const reply=data.model==='extract-fixture'?JSON.stringify({claims:[{subject:'用户',predicate:'面试安排',value:'2026-10-14 下午三点',quote:'2026-10-14 下午三点面试'}]}):requests.filter(r=>r.model==='reply-fixture').length===1?'记住了。':'面试快开始了，准备得怎么样？';
    response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:reply}}]}));});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>{provider.closeAllConnections();provider.close();});
  const repository=new FileBookRepository(directory),config=repository.loadConfig();const binding={baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,credentialId:'local-no-auth',inputTokens:16384,outputTokens:1024};
  repository.commitConfig({...config,mainModel:{...binding,model:'reply-fixture'},wikiModel:{...binding,model:'extract-fixture'},chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded'},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true,extraction:'model',cloudMemoryConsent:true,proactive:true}},0,'fixture');repository.close();
  const wrapper=join(directory,'runner.mjs'),module=pathToFileURL(resolve('dist/app/book-backend.js')).href;
  // Fake clock only; production composition, repository, Builder, model adapter, scheduling and stdio are real.
  writeFileSync(wrapper,`import {runBookBackend} from ${JSON.stringify(module)}; const base=Date.now(); await runBookBackend(${JSON.stringify(directory)},{clock:()=>Date.parse('2026-10-14T14:40:00+08:00')+(Date.now()-base)});`);
  const child=spawn(process.execPath,[wrapper],{cwd:process.cwd(),windowsHide:true,env:{...process.env,AIKI_BOOK_PORT:'0'},stdio:['pipe','pipe','pipe']}),messages=[];let stderr='',buffer='';
  child.stdout.on('data',part=>{buffer+=part;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{messages.push(JSON.parse(line));}catch(error){stderr+=String(error);}}});child.stderr.on('data',part=>stderr+=part);
  const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
  const wait=async predicate=>{const deadline=Date.now()+45000;while(Date.now()<deadline){const result=messages.find(predicate);if(result)return result;if(child.exitCode!==null)throw Error(`Backend exit ${child.exitCode}: ${stderr}`);await new Promise(resolve=>setTimeout(resolve,50));}throw Error(`Backend deadline: ${stderr}`)};
  t.after(async()=>{child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve()},3000).unref()});rmSync(directory,{recursive:true,force:true});});
  await wait(message=>message.channel==='backend_ready');await wait(message=>message.channel==='companion_takeover'&&message.phase==='prepare');send({channel:'companion_takeover',characterId:'aika',stopped:true,lastShownAt:null});await wait(message=>message.channel==='companion_takeover'&&message.phase==='ready');
  send({channel:'command',command:{type:'submit_text',text:'2026-10-14 下午三点面试',clientRequestId:'interview-turn'}});await wait(message=>message.channel==='event'&&message.event.type==='reply');
  send({channel:'book_turn_status',characterId:'aika',sessionId:'desktop',clientRequestId:'interview-turn'});
  const receipt=await wait(message=>message.channel==='book_turn_state'&&message.state==='completed');
  assert.equal(receipt.text,'记住了。');assert.equal(receipt.scope.turnId,'interview-turn');
  assert.equal(requests.filter(r=>r.model==='reply-fixture').length,1,'result recovery never calls the provider again');
  let management;for(let i=0;i<100;i++){try{management=JSON.parse((await import('node:fs')).readFileSync(join(directory,'management-session.json'),'utf8'));break}catch{await new Promise(r=>setTimeout(r,20));}}
  const url=new URL(management.url),headers={Authorization:`Bearer ${new URLSearchParams(url.hash.slice(1)).get('token')}`};const call=route=>new Promise((resolve,reject)=>{const request=get(url.origin+'/api/memory-book/v1'+route,{headers},response=>{let text='';response.on('data',part=>text+=part);response.on('error',reject);response.on('end',()=>{try{assert.equal(response.statusCode,200);resolve(JSON.parse(text))}catch(error){reject(error)}})});request.on('error',reject);request.setTimeout(10000,()=>request.destroy(Error('Management HTTP timed out')));});
  for(let i=0;i<100;i++){const data=await call('/companion?sessionId=desktop');if(data.jobs[0]?.status==='done')break;await new Promise(r=>setTimeout(r,50));}
  const ledger=await call('/companion?sessionId=desktop');assert.equal(ledger.jobs[0].status,'done');assert.equal(ledger.events[0].precision,'minute');
  send({channel:'companion_presence',hidden:false,dnd:false});const offer=await wait(message=>message.channel==='companion_offer');assert.equal(offer.delivery,undefined,'queued offers never contain raw text');
  send({channel:'companion_claim',characterId:'foreign',sessionId:'desktop',id:offer.id});
  send({channel:'companion_claim',characterId:'aika',sessionId:'desktop',id:offer.id});
  const message=await wait(message=>message.channel==='companion_message');assert.equal(message.delivery.status,'dispatched');assert.equal(message.delivery.basisRefs.length,1);
  send({channel:'companion_ack',characterId:'aika',id:message.delivery.id});await new Promise(r=>setTimeout(r,100));assert.equal((await call('/companion?sessionId=desktop')).deliveries[0].status,'committed');assert.equal((await call('/chat/history?sessionId=desktop')).turns.length,1);
  assert.ok(requests.at(-1).messages.some(message=>message.content.includes('不是用户消息')));assert.equal(requests.filter(r=>r.model==='reply-fixture').length,2);assert.ok(!requests.some(request=>request.messages.some(message=>message.role==='user'&&message.content==='面试快开始了，准备得怎么样？')));
  const lifeBefore=messages.filter(message=>message.channel==='companion_state').at(-1).state;
  send({channel:'companion_action',characterId:'aika',pairingId:'local-user',action:'set_focus',enabled:true});
  const focus=await wait(message=>message.channel==='companion_state'&&message.focus===true);
  assert.equal((await call('/companion?sessionId=desktop')).focus,true);assert.equal(focus.state.enabled,lifeBefore.enabled);
  assert.ok(focus.state.nextActivityAt>0,'explicit focus does not stop local life');
  send({channel:'companion_action',characterId:'aika',pairingId:'local-user',action:'set_focus',enabled:false});
  await wait(message=>message.channel==='companion_state'&&message.sequence>focus.sequence&&message.focus===false);
  assert.equal((await call('/companion?sessionId=desktop')).focus,false);
});

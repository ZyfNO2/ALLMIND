import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../dist/contracts/book-companion.js';

test('production desktop backend routes private turns through volatile Runtime and releases them before ordinary chat',{timeout:60000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/private-backend-')),calls=[];
  const provider=createServer(async(request,response)=>{let raw='';for await(const part of request)raw+=part;calls.push(JSON.parse(raw));response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'private-backend-answer'}}]}))});await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>{provider.closeAllConnections();provider.close()});
  const repository=new FileBookRepository(directory),config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},config.revision,'seed');repository.close();
  const wrapper=join(directory,'backend.mjs');writeFileSync(wrapper,`import {runBookBackend} from ${JSON.stringify(pathToFileURL(resolve('dist/app/book-backend.js')).href)};await runBookBackend(${JSON.stringify(directory)});`);
  const child=spawn(process.execPath,[wrapper],{cwd:process.cwd(),windowsHide:true,env:{...process.env,AIKI_BOOK_PORT:'0'},stdio:['pipe','pipe','pipe']}),messages=[];let buffer='',stderr='';child.stdout.on('data',part=>{buffer+=part;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);messages.push(JSON.parse(line));}});child.stderr.on('data',part=>stderr+=part);
  const stop=async()=>{child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve()},3000).unref()})};t.after(stop);
  const send=message=>child.stdin.write(JSON.stringify(message)+'\n'),wait=async predicate=>{const deadline=Date.now()+20000;while(Date.now()<deadline){const result=messages.find(predicate);if(result)return result;if(child.exitCode!==null)throw Error('backend exit '+stderr);await new Promise(resolve=>setTimeout(resolve,20))}throw Error('backend wait '+stderr+' states='+JSON.stringify(messages.filter(row=>['book_turn_state','event'].includes(row.channel)).map(row=>({channel:row.channel,state:row.state,id:row.clientRequestId,event:row.event?.type,message:row.event?.message}))))};
  await wait(message=>message.channel==='backend_ready');send({channel:'book_privacy',characterId:'aika',sessionId:'desktop',incognito:true});await wait(message=>message.channel==='book_privacy'&&message.incognito===true);
  for(const [id,text] of [['private-one','饮品：private-backend-secret'],['private-two','继续这个话题']]){send({channel:'command',command:{type:'submit_text',text,clientRequestId:id}});await wait(message=>message.channel==='event'&&message.event.type==='reply'&&message.event.reply.scope.turnId===id);}
  assert.match(JSON.stringify(calls[1].messages),/private-backend-secret/);
  for(const name of readdirSync(directory).filter(name=>/\.jsonl?$/.test(name)))assert.ok(!readFileSync(join(directory,name),'utf8').includes('private-backend-secret'));assert.ok(!stderr.includes('private-backend-secret'));
  send({channel:'book_privacy',characterId:'aika',sessionId:'desktop',incognito:false});await wait(message=>message.channel==='book_privacy'&&message.incognito===false);
  send({channel:'command',command:{type:'submit_text',text:'饮品：普通白茶',clientRequestId:'ordinary'}});await wait(message=>message.channel==='event'&&message.event.type==='reply'&&message.event.reply.scope.turnId==='ordinary');assert.ok(!JSON.stringify(calls[2].messages).includes('private-backend-secret'));
  const management=JSON.parse(readFileSync(join(directory,'management-session.json'),'utf8')),url=new URL(management.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
  const call=async(route,data)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+route,{method:data?'POST':'GET',headers,...(data?{body:JSON.stringify(data)}:{})}),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result};
  const book=await call('/book?characterId=aika&sessionId=desktop');await call('/memory/erase',{characterId:'aika',sessionId:'desktop',turnIds:['ordinary'],expectedRevision:book.revision,eraseRaw:true});
  const after=messages.length;send({channel:'book_turn_status',characterId:'aika',sessionId:'desktop',clientRequestId:'ordinary'});const erased=await wait(message=>messages.indexOf(message)>=after&&message.channel==='book_turn_state'&&message.clientRequestId==='ordinary');assert.equal(erased.state,'failed','raw erase must scrub native recovery receipts');assert.equal(erased.text,undefined);
  assert.ok(messages.some(message=>message.channel==='book_erased'&&message.characterId==='aika'&&message.sessionId==='desktop'&&message.turnIds.includes('ordinary')),'successful raw erase notifies the actual desktop consumer');
  send({channel:'command',command:{type:'submit_text',text:'目标：普通收尾',clientRequestId:'new-ordinary'}});await wait(message=>message.channel==='event'&&message.event.type==='reply'&&message.event.reply.scope.turnId==='new-ordinary');assert.ok(!JSON.stringify(calls[3].messages).includes('普通白茶'));
  await stop();assert.equal(child.exitCode,0);const reopened=new FileBookRepository(directory);t.after(()=>reopened.close());assert.equal(reopened.readSession({characterId:'aika',pairingId:'local-user',sessionId:'desktop'}).length,1);
});

import { mkdirSync,mkdtempSync,readFileSync,copyFileSync,existsSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { FileBookRepository } from '../dist/memory/file-book-repository.js';
import { emptyEntry } from '../dist/contracts/memory-book.js';
import { DEFAULT_COMPANION_SETTINGS } from '../dist/contracts/book-companion.js';
const production=resolve('../../.local/memory-book'),docs=resolve('../../../docs/next/allmind-companion-v2');mkdirSync('.local/allmind-m23/real',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m23/real/flow-'));
const original=JSON.parse(readFileSync(join(production,'runtime.json'),'utf8')).data;
for(const file of ['chatgpt-bridge-key','chatgpt-bridge-key.client'])if(existsSync(join(production,file)))copyFileSync(join(production,file),join(directory,file));
const repository=new FileBookRepository(directory),config=repository.loadConfig();repository.commitConfig({...config,mainModel:original.mainModel,wikiModel:original.wikiModel,chatgptWeb:original.chatgptWeb,
  companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true,extraction:'model',cloudMemoryConsent:true,proactive:true}},0,'real-flow-source');repository.commit({characterId:'aika',pairingId:'local-user',sessionId:'desktop'},{upsert:[emptyEntry('fixture-persona','persona','合成角色','说话温和简洁，诚实承认未知；未经依据不猜测面试结果。')]},0,'fixture-persona');repository.close();
const wrapper=join(directory,'runner.mjs');writeFileSync(wrapper,`import {runBookBackend} from ${JSON.stringify(pathToFileURL(resolve('dist/app/book-backend.js')).href)};const start=Date.now();await runBookBackend(${JSON.stringify(directory)},{clock:()=>Date.parse('2026-10-14T14:40:00+08:00')+(Date.now()-start)});`);
const child=spawn(process.execPath,[wrapper],{windowsHide:true,env:{...process.env,AIKI_BOOK_DATA:directory,AIKI_BOOK_WEB_ONLY:'0',AIKI_BOOK_PORT:'0'},stdio:['pipe','pipe','pipe']}),messages=[];let buffer='',stderr='';
child.stdout.on('data',part=>{buffer+=part;let end;while((end=buffer.indexOf('\n'))>=0){messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});child.stderr.on('data',part=>stderr+=part);
const report={status:'IN_PROGRESS',model:original.mainModel?.model,source:original.mainModel?.kind,clock:'frozen event clock only',productionUserDataChanged:false,scope:{characterId:'aika',pairingId:'local-user',sessionId:'desktop'},syntheticUserMessage:'我的面试安排是2026-10-14 下午三点，时区是Asia/Singapore。请记住。',displayAck:'fixture transport; actual renderer separately browser-tested',results:{}};
const save=()=>{mkdirSync(join(docs,'evidence'),{recursive:true});writeFileSync(join(docs,'evidence/m3-real-default-flow.json'),JSON.stringify(report,null,2));};
const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
async function wait(predicate,timeout=300000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const message=messages.find(predicate);if(message)return message;if(child.exitCode!==null)throw Error(`Backend exit: ${stderr}`);await new Promise(r=>setTimeout(r,100));}throw Error(`Real flow deadline: ${stderr}`);}
try{
  await wait(message=>message.channel==='backend_ready',30000);const session=JSON.parse(readFileSync(join(directory,'management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:`Bearer ${new URLSearchParams(url.hash.slice(1)).get('token')}`};
  const call=async route=>{const response=await fetch(url.origin+'/api/memory-book/v1'+route,{headers});if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();};
  send({channel:'command',command:{type:'submit_text',text:report.syntheticUserMessage,clientRequestId:'real-interview'}});
  const first=await wait(message=>message.channel==='event'&&['reply','error'].includes(message.event.type));if(first.event.type==='error')throw Error(first.event.message);report.results.dialogue=first.event.reply.text;save();console.log('Real default Book dialogue completed.');
  const deadline=Date.now()+300000;let ledger;while(Date.now()<deadline){ledger=await call('/companion?sessionId=desktop');if(ledger.jobs[0]&&['done','failed','cancelled','review'].includes(ledger.jobs[0].status))break;await new Promise(r=>setTimeout(r,500));}
  report.results.memoryJob=ledger.jobs[0];report.results.events=ledger.events;save();if(ledger.jobs[0]?.status!=='done'||!ledger.events.some(e=>e.precision==='minute'))throw Error(`Automatic real extraction incomplete: ${ledger.jobs[0]?.error??ledger.jobs[0]?.status}`);console.log('Real automatic memory and time-evidenced event committed.');
  send({channel:'companion_takeover',characterId:'aika',stopped:true,lastShownAt:null});send({channel:'companion_presence',hidden:false,dnd:false});
  const offer=await wait(message=>message.channel==='companion_offer'||message.channel==='companion_error');if(offer.channel!=='companion_offer')throw Error(offer.message);send({channel:'companion_claim',characterId:'aika',sessionId:'desktop',id:offer.id});
  const delivery=await wait(message=>message.channel==='companion_message'||message.channel==='companion_error');if(delivery.channel!=='companion_message')throw Error(delivery.message);report.results.proactive=delivery.delivery;save();
  send({channel:'companion_ack',characterId:'aika',id:delivery.delivery.id});await new Promise(r=>setTimeout(r,200));report.results.ledger=await call('/companion?sessionId=desktop');report.results.savedTurns=(await call('/chat/history?sessionId=desktop')).turns.length;
  if(report.results.savedTurns!==1||report.results.ledger.deliveries[0]?.status!=='committed')throw Error('Real flow committed unexpected dialogue/ack count');report.status='COMPLETED_REQUIRES_REVIEW';save();console.log('Real default proactive generation and fixture ack committed; no fabricated user turn.');
}catch(error){report.status='FAILED';report.error=error instanceof Error?error.message:String(error);report.stderr=stderr;save();console.error(report.error);process.exitCode=1;}finally{child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve()},5000).unref()});}

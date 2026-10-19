import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {BookRuntime} from '../dist/app/book-runtime.js';
import {DEFAULT_COMPANION_SETTINGS} from '../dist/contracts/book-companion.js';
const root=resolve('../../../docs/next/allmind-companion-v2/evidence'),path=join(root,process.env.AIKI_RESULT_EVIDENCE??'event-result-consumer-real.json');mkdirSync(root,{recursive:true});mkdirSync('.local/allmind-m4/tests',{recursive:true});
const repository=new FileBookRepository(mkdtempSync('.local/allmind-m4/tests/result-real-')),scope={characterId:'aika',pairingId:'local-user',sessionId:'seed'};
const report={status:'IN_PROGRESS',consumer:'isolated production Book/Builder -> authorized regular models/test; not native formal chat acceptance',productionFactsWritten:false,rows:[],startedAt:new Date().toISOString()},save=()=>writeFileSync(path,JSON.stringify(report,null,2));
try{
  save();const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9',model:'fixture-only-seeding',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},config.revision,'seed');
  const runtime=new BookRuntime(repository,{async complete(){return '收到用户原文。'}});
  await runtime.chat(scope,'A公司面试已经结束，结果还没出来',new AbortController().signal);await runtime.automaticMemory.flush();
  const event=repository.loadCompanionData(scope).events[0];if(event?.resultStatus!=='unknown')throw Error('Production event must preserve an unknown result');
  const session=JSON.parse(readFileSync(resolve('../../.local/memory-book/management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
  const request=async(route,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+route,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(170000)}),data=await response.json();if(!response.ok)throw Error(data.error?.message??'HTTP '+response.status);return data};
  const current=(await request('/runtime')).config;if(current.mainModel?.kind!=='chatgpt-web'||current.chatgptWeb?.temporaryChatTests!==false)throw Error('Expected the authorized regular web model; will not switch sources');
  report.model=current.mainModel.model;report.transport=current.chatgptWeb.transport;save();
  for(const query of ['我刚才那场 A 公司面试的结果怎么样？','你已经知道我通过面试了吗？请依据记忆回答。']){
    const context=await runtime.inspect({...scope,sessionId:'result-'+randomUUID()},query,new AbortController().signal);if(!context.messages.some(message=>message.content.includes('结果还没出来')))throw Error('Production Builder did not retain unknown result evidence');
    const row={query,selected:context.consumed,eventResult:event.resultStatus,reply:null};report.rows.push(row);save();
    const response=await request('/models/test',{binding:current.mainModel,debugSessionId:'event-result-'+randomUUID(),prompt:'你在进行一段合成验收，不把此处例子当作账号用户的真人资料。请只按下列有来源上下文用中文简短回答最后问题，不能把事件结束或计划时间当作通过依据。\n'+context.messages.map(message=>`[${message.role}] ${message.content}`).join('\n')});
    if(!response.ok)throw Error(response.error?.message??'Real model test failed');row.reply=response.reply;row.durationMs=response.durationMs;save();
  }
  report.status='AWAITING_SEMANTIC_REVIEW';save();process.stdout.write(JSON.stringify({status:report.status,rows:report.rows,path})+'\n');
}catch(error){report.status='FAILED';report.error=error instanceof Error?error.message:String(error);save();process.stderr.write(report.error+'\n');process.exitCode=1;}finally{repository.close();}

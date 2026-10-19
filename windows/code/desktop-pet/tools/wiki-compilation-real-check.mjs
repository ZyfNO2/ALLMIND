import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {FactWikiService} from '../dist/memory/fact-wiki.js';
import {WikiMaintenance} from '../dist/memory/wiki-maintenance.js';
const live=resolve('../../.local/memory-book'),session=JSON.parse(readFileSync(join(live,'management-session.json'),'utf8')),url=new URL(session.url);
if(url.hostname!=='127.0.0.1')throw Error('Expected authenticated local runtime');
const headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
const request=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(330000)});const result=await response.json();if(!response.ok)throw Error(result.error?.message??'HTTP '+response.status);return result};
const evidence=resolve('../../../docs/next/allmind-companion-v2/evidence/wiki-real-synthesis.json');mkdirSync(resolve('.local/allmind-m4/tests'),{recursive:true});
const repository=new FileBookRepository(mkdtempSync(resolve('.local/allmind-m4/tests/real-wiki-'))),scope={characterId:'aika',pairingId:'local-user',sessionId:'synthetic-wiki'};
const report={status:'IN_PROGRESS',kind:'Real model via authenticated model-test endpoint; isolated Book; not production wiki transport acceptance',productionFactsWritten:false,debugSessionId:'wiki-synthesis-'+randomUUID(),startedAt:new Date().toISOString()};
const save=()=>{mkdirSync(resolve('../../../docs/next/allmind-companion-v2/evidence'),{recursive:true});writeFileSync(evidence,JSON.stringify(report,null,2))};
try{
  save();const {config}=await request('/runtime');if(config.chatgptWeb?.temporaryChatTests!==false)throw Error('Debug must remain non-temporary');
  const binding=config.wikiModel??config.fastModel;if(!binding)throw Error('No authorized organizer binding');
  const local=repository.loadConfig();repository.commitConfig({...local,wikiModel:{...binding,kind:'http',baseUrl:'http://127.0.0.1:9999/v1',credentialId:'fixture'}},local.revision,'isolated-config');
  const wiki=new FactWikiService(repository);
  for(const [id,text] of [['synthetic-a','称呼：验收人物小岚'],['synthetic-b','昵称：验收人物小岚']]){const preview=wiki.preview(scope,{sourceId:id,title:'用户',text,private:true});wiki.apply(scope,preview.id,id)}
  const page=repository.snapshot(scope).wikiPages.find(page=>page.kind==='profile');if(!page||page.sourceIds.length!==2)throw Error('Synthetic multi-source page missing');
  const service=new WikiMaintenance(repository,{async complete(_binding,messages,signal){signal.throwIfAborted();const prompt='以下全部是合成验收数据，不是用户个人资料。\n'+messages.map(row=>row.content).join('\n');if(prompt.length>2000)throw Error('Prompt exceeds model-test bound');const result=await request('/models/test',{binding,prompt,debugSessionId:report.debugSessionId});report.modelResult=result;save();if(!result.ok)throw Error(result.error?.message??'Real synthesis failed');return result.reply.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')}},()=>{});
  const job=service.queue(scope,[page.id],'real-queue'),review=await service.run(scope,job.id,new AbortController().signal);report.review=review;save();
  // Real prose still requires human review; never automatically approve model text.
  report.status='GENERATED_REQUIRES_REVIEW';report.sourceCount=page.sourceIds.length;report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,sourceCount:report.sourceCount,durationMs:report.modelResult.durationMs,evidence}));
}catch(error){report.status='FAIL';report.error=String(error);save();console.error(report.error);process.exitCode=1}finally{repository.close()}

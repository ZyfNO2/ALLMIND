import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {FactWikiService} from '../dist/memory/fact-wiki.js';
import {BookRuntime} from '../dist/app/book-runtime.js';
import {EXPERIENCE_TIME_INSTRUCTION} from '../dist/memory/book-recall.js';
const root=resolve('../../../docs/next/allmind-companion-v2'),evidence=join(root,'evidence/experience-consumer-real.json');mkdirSync('.local/allmind-m4/tests',{recursive:true});
const repository=new FileBookRepository(mkdtempSync(resolve('.local/allmind-m4/tests/experience-real-'))),scope={characterId:'aika',pairingId:'local-user',sessionId:'seed'};
const report={status:'IN_PROGRESS',productionFactsWritten:false,consumer:'Production Inspector selected compiled important page -> real model-test answers; not native formal chat acceptance',results:[],startedAt:new Date().toISOString()},save=()=>writeFileSync(evidence,JSON.stringify(report,null,2));
try{
  save();const wiki=new FactWikiService(repository);
  for(let index=0;index<11;index++){
    const preview=wiki.preview(scope,{sourceId:'experience-'+index,title:'用户',text:index===0?'共同经历0：我和你一起整理最初的琥珀相册':`共同经历${index}：我和你一起整理第${index}次项目`,private:true});
    for(const snapshot of preview.source.snapshots)snapshot.capturedAt=new Date(Date.UTC(2025,0,index+1)).toISOString();
    repository.commit(scope,{upsert:preview.facts,wikiSources:[preview.source]},preview.expectedRevision,'experience-'+index);
    if(index===0){const book=repository.snapshot(scope),entry=book.entries[0];repository.commit(scope,{upsert:[{...entry,importance:80}]},book.revision,'explicit-importance')}
  }
  const important=repository.snapshot(scope).wikiPages.find(page=>page.layer==='important'),recent=repository.snapshot(scope).wikiPages.find(page=>page.layer==='recent');
  if(!important||recent.body.includes('琥珀相册'))throw Error('Important experience must be outside recent layer');
  const runtime=new BookRuntime(repository,{async complete(){throw Error('Inspection must not call a model')}});
  const session=JSON.parse(readFileSync(resolve('../../.local/memory-book/management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
  const request=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(170000)}),result=await response.json();if(!response.ok)throw Error(result.error?.message??'HTTP '+response.status);return result};
  const {config}=await request('/runtime');if(config.chatgptWeb?.temporaryChatTests!==false||config.mainModel?.kind!=='chatgpt-web')throw Error('Expected authorized regular web model');
  for(const query of ['我们一起做过的重要事情，最早那次还能想起来吗？','新会话问一下：当初那本琥珀相册，我们一起做了什么？']){
    const context=await runtime.inspect({...scope,sessionId:'new-'+randomUUID()},query,new AbortController().signal);
    if(!context.compiledPagesUsed?.some(page=>page.id===important.id))throw Error('Formal Builder did not select important layer');
    const row={query,selected:context.consumed,compiledPagesUsed:context.compiledPagesUsed,contextMessages:context.messages,debugSessionId:'experience-'+randomUUID()};report.results.push(row);save();
    const pages=context.compiledPagesUsed.filter(page=>page.id===important.id).map(page=>repository.snapshot(scope).wikiPages.find(stored=>stored.id===page.id).body);
    const prompt='仅依据下面正式检索选中的合成经历回答，不是用户个人资料。用一句自然中文回答。\n'+EXPERIENCE_TIME_INSTRUCTION+'\n'+pages.join('\n')+'\n问题：'+query;if(prompt.length>2000)throw Error('Evidence exceeds model-test bound');
    row.modelResult=await request('/models/test',{binding:config.mainModel,prompt,debugSessionId:row.debugSessionId});save();if(!row.modelResult.ok)throw Error(row.modelResult.error?.message??'Real model failed');
    row.answerMatched=/琥珀相册/.test(row.modelResult.reply)&&/整理/.test(row.modelResult.reply);save();if(!row.answerMatched)throw Error('Real answer omitted the sourced shared experience');
    row.unsupportedOrderClaim=/(?:最早|最先|第一次).*(?:是|整理|做过)/.test(row.modelResult.reply)&&!/无法确定|不能确定|不确定|没有.*(?:时间|顺序)|未提供|不.*确认/.test(row.modelResult.reply);save();if(row.unsupportedOrderClaim)throw Error('Real answer asserted an unsupported occurrence order');
    console.log(JSON.stringify({query,durationMs:row.modelResult.durationMs,reply:row.modelResult.reply}));
  }
  report.status='COMPLETED_REQUIRES_SEMANTIC_REVIEW';report.finishedAt=new Date().toISOString();save();
}catch(error){report.status='FAILED';report.error=error instanceof Error?error.stack:String(error);save();console.error(report.error);process.exitCode=1}finally{repository.close()}

import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const evidence='../../../docs/next/chatgpt-integration/wiki-handoff/evidence/w02/review-20261016',previous=JSON.parse(readFileSync(evidence+'/real-wiki.json','utf8')),scope=previous.scope;
if(previous.phase!=='completed'||!previous.recalled)throw Error('真实整理与召回未完成。');
const url=new URL(JSON.parse(readFileSync('../../.local/memory-book/management-session.json','utf8')).url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'},query='?'+new URLSearchParams(scope),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report={scope,phase:'preparing',startedAt:new Date().toISOString()},save=()=>writeFileSync(evidence+'/real-wiki-compile.json',JSON.stringify(report,null,2)+'\n');
const api=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),signal:AbortSignal.timeout(310000)}),value=await response.json();if(!response.ok)throw Error(path.split('?')[0]+' HTTP '+response.status+' '+JSON.stringify(value));return value;};
try{
 report.configHashBefore=hash((await api('/runtime')).config);const before=await api('/book'+query),pages=(before.wikiPages??[]).filter(page=>page.pairingId===scope.pairingId).slice(0,4);if(!pages.length)throw Error('没有合成主题页。');
 const queued=await api('/wiki/compilation/queue',{...scope,pageIds:pages.map(row=>row.id),operationId:'w02-real-compilation-'+Date.now().toString(36)});report.jobId=queued.job.id;report.phase='generating';save();
 const review=await api('/wiki/compilation/run',{...scope,jobId:queued.job.id});report.review=review.job;report.phase=review.job.status;save();if(review.job.status!=='review')throw Error('未生成可审核正文。');
 const current=await api('/book'+query);report.applied=await api('/wiki/compilation/apply',{...scope,jobId:queued.job.id,confirmed:true,expectedRevision:current.revision,operationId:'w02-real-compile-apply-'+Date.now().toString(36)});
 const after=await api('/book'+query);report.pages=after.wikiPages?.filter(page=>pages.some(old=>old.id===page.id));report.recall=await api('/recall/test',{...scope,query:'合成角色 QA 红茶 蓝色茶杯'});
 report.configHashAfter=hash((await api('/runtime')).config);report.configUnchanged=report.configHashBefore===report.configHashAfter;report.formalEntriesUnchanged=hash((await api('/book?'+new URLSearchParams(previous.formalScope))).entries)===previous.formalEntriesBefore;
 report.phase='completed';report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({compiledPages:report.pages?.filter(page=>page.compilation?.jobId===report.jobId).length,configUnchanged:report.configUnchanged,formalEntriesUnchanged:report.formalEntriesUnchanged,evidence}));
 if(!report.pages?.some(page=>page.compilation?.jobId===report.jobId)||!report.configUnchanged||!report.formalEntriesUnchanged)process.exitCode=1;
}catch(error){report.phase='failed';report.error=String(error);save();console.error(String(error));process.exitCode=1;}

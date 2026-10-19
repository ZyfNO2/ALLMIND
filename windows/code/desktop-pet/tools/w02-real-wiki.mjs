// Real product Wiki organizer. Synthetic data is isolated in a separate pairing, never local-user.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const evidence='../../../docs/next/chatgpt-integration/wiki-handoff/evidence/w02/review-20261016',url=new URL(JSON.parse(readFileSync('../../.local/memory-book/management-session.json','utf8')).url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const report={startedAt:new Date().toISOString(),kind:'real normal product Wiki organizer, synthetic isolated pairing',phase:'preparing'},save=()=>writeFileSync(evidence+'/real-wiki.json',JSON.stringify(report,null,2)+'\n');
const api=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),signal:AbortSignal.timeout(310000)}),value=await response.json();if(!response.ok)throw Error(path.split('?')[0]+' HTTP '+response.status+' '+JSON.stringify(value));return value;};
try{
 const {config}=await api('/runtime');report.configHashBefore=hash(config);report.formalScope={characterId:config.currentCharacterId,pairingId:'local-user',sessionId:'web-chat'};
 const formalBefore=await api('/book?'+new URLSearchParams(report.formalScope));report.formalEntriesBefore=hash(formalBefore.entries);
 if(config.wikiModel?.kind!=='chatgpt-web'||!config.companion?.cloudMemoryConsent||!config.chatgptWeb?.authorizedPurposes.includes('wiki'))throw Error('当前设置没有授权真实 Wiki 网页整理。');
 const tag=Date.now().toString(36);report.scope={characterId:config.currentCharacterId,pairingId:'w02-synthetic-'+tag,sessionId:'w02-wiki-'+tag};const query='?'+new URLSearchParams(report.scope);
 report.materials=[];
 for(const [index,text]of ['# 合成角色 QA\n合成角色 QA 喜欢红茶。\n','早期资料重述：合成角色 QA 喜欢红茶。\n合成角色 QA 收藏蓝色茶杯。\n'].entries()){
  const response=await fetch(url.origin+'/api/memory-book/v1/resources/upload'+query+'&name=version-'+(index+1)+'.md&operationId=wiki-upload-'+index,{method:'POST',headers:{Authorization:headers.Authorization,'Content-Type':'text/markdown'},body:text}),record=await response.json();if(!response.ok)throw Error('资料上传失败。');report.materials.push({resourceId:record.id,sha256:record.sha256,resourceRevision:record.revision});
 }
 const book=await api('/book'+query);report.expectedRevision=book.revision;report.phase='submitting';save();
 const preview=await api('/wiki/organization/preview',{...report.scope,operationId:'wiki-preview-'+tag,expectedBookRevision:book.revision,domain:'external',materials:report.materials});report.preview=preview;report.phase=preview.phase;save();
 if(!preview.complete||!preview.candidates.length)throw Error('整理没有完整候选。');
 const decisions=preview.candidates.map(row=>({candidateId:row.id,accept:!row.blocked&&row.action!=='unknown',...(row.action==='conflict'?{resolution:'keep_existing'}:{})}));
 const applied=await api('/wiki/organization/apply',{...report.scope,previewId:preview.id,operationId:'wiki-apply-'+tag,expectedRevision:preview.expectedBookRevision,decisions});
 report.applied={receipt:applied.receipt,appliedEntryIds:applied.appliedEntryIds,entries:applied.book.entries.filter(row=>applied.appliedEntryIds.includes(row.id)),pages:applied.book.wikiPages?.filter(page=>page.pairingId===report.scope.pairingId)};
 report.recall=await api('/recall/test',{...report.scope,query:'合成角色 QA 红茶 蓝色茶杯'});
 report.recalled=report.recall.consumed?.some(row=>applied.appliedEntryIds.includes(row.entryId));
 report.configHashAfter=hash((await api('/runtime')).config);report.configUnchanged=report.configHashBefore===report.configHashAfter;
 report.formalEntriesAfter=hash((await api('/book?'+new URLSearchParams(report.formalScope))).entries);report.formalEntriesUnchanged=report.formalEntriesBefore===report.formalEntriesAfter;
 report.phase='completed';report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({evidence,applied:report.applied.appliedEntryIds.length,recalled:report.recalled,configUnchanged:report.configUnchanged,formalEntriesUnchanged:report.formalEntriesUnchanged}));if(!report.recalled||!report.configUnchanged||!report.formalEntriesUnchanged)process.exitCode=1;
}catch(error){report.phase='failed';report.error=String(error);save();console.error(String(error));process.exitCode=1;}

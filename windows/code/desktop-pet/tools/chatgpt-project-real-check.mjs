import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const session=JSON.parse(readFileSync(resolve('../../.local/memory-book/management-session.json'),'utf8')),url=new URL(session.url);
const headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'},base=url.origin+'/api/memory-book/v1';
const evidence=resolve('../../../docs/next/chatgpt-integration/evidence/project-routing-real.json');
const report={status:'IN_PROGRESS',startedAt:new Date().toISOString(),debugSessionId:'project-check-'+randomUUID(),turns:[],productionFactsChanged:false};
const save=()=>writeFileSync(evidence,JSON.stringify(report,null,2));
const request=async(path,body)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(170000)});const result=await response.json();if(!response.ok)throw Error(result.error?.message??'HTTP '+response.status);return result;};
try{
  save();const {config}=await request('/runtime');
  if(config.chatgptWeb?.temporaryChatTests!==false||config.chatgptWeb?.transport!=='embedded'||config.mainModel?.kind!=='chatgpt-web')throw Error('Real check requires the authorized regular embedded source');
  report.characterId=config.currentCharacterId;report.projectId=config.chatgptProjects?.find(row=>row.enabled&&row.characterId===config.currentCharacterId)?.projectId;report.model=config.mainModel.model;report.thinkingLevel=config.chatgptWeb.thinkingLevel;
  if(!report.projectId)throw Error('Explicit project binding missing');
  const marker='AIKI_PROJECT_'+randomUUID().replaceAll('-','').slice(0,12);
  for(const [index,prompt] of [`这是 AIKI 连接调试，不是用户个人事实。请仅回复此测试标记：${marker}`,`这是同一调试线程的第二轮。请只回复上一轮给出的 AIKI_PROJECT_ 开头的测试标记。`].entries()){
    const result=await request('/models/test',{binding:config.mainModel,prompt,debugSessionId:report.debugSessionId});report.turns.push({index:index+1,...result});save();
    if(!result.ok)throw Error(result.error?.message??'Real model test failed');
    if(!result.reply.includes(marker))throw Error('Real thread continuation did not return the test marker');
  }
  const thread=await request('/chatgpt-web/projects/thread?'+new URLSearchParams({characterId:config.currentCharacterId,sessionId:'debug-'+report.debugSessionId}));
  if(!thread.thread?.conversationId)throw Error('Verified project thread missing');report.thread=thread.thread;report.status='PASS';report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(report));
}catch(error){report.status='FAIL';report.error=String(error);report.finishedAt=new Date().toISOString();save();console.error(JSON.stringify(report));process.exitCode=1;}

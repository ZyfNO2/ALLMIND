import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
const directory=resolve(process.argv[2]??'../../.local/memory-book'),docs=resolve('../../../docs/next/allmind-companion-v2');
const connection=JSON.parse(readFileSync(join(directory,'management-session.json'),'utf8')),url=new URL(connection.url),token=new URLSearchParams(url.hash.slice(1)).get('token');
const config=JSON.parse(readFileSync(join(directory,'runtime.json'),'utf8')).data,fixture=JSON.parse(readFileSync(join(docs,'fixtures/recall-queries.json'),'utf8'));
const facts=fixture.facts.filter(f=>f.enabled!==false&&f.scope===`${fixture.scope.characterId}/${fixture.scope.pairingId}`);
const report={kind:'real existing selected provider; synthetic data only',model:config.mainModel?.model,source:config.mainModel?.kind,productionHistoryWritten:false,fixtureChanged:false,batches:[],status:'IN_PROGRESS'};
const save=()=>{mkdirSync(join(docs,'evidence'),{recursive:true});writeFileSync(join(docs,'evidence/m2-real-model.json'),JSON.stringify(report,null,2));};
try{
  for(let offset=0;offset<fixture.queries.length;offset+=10){
    const samples=fixture.queries.slice(offset,offset+10);
    const prompt='你是温和、简洁、不装作全知的桌面角色。仅依据以下合成有效记忆回答；不知道就明确说不知道。作者设定不是现实经历。每题一句短答。只返回 JSON {"answers":[{"id":"Qxx","answer":"短答"}]}。\n记忆：'+facts.map(f=>f.text).join('\n')+'\n问题：'+samples.map(q=>`${q.id} ${q.query}`).join('\n');
    if(prompt.length>2000)throw Error('Real test prompt exceeded authenticated endpoint limit');
    const response=await fetch(url.origin+'/api/memory-book/v1/models/test',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({binding:config.mainModel,prompt}),signal:AbortSignal.timeout(155000)});
    const result=await response.json();report.batches.push({ids:samples.map(s=>s.id),result});save();
    if(!response.ok||!result.ok)throw Error(result.error?.message??`Provider HTTP ${response.status}`);
    const raw=result.reply.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');const answers=JSON.parse(raw).answers;
    if(!Array.isArray(answers)||answers.length!==samples.length||samples.some(s=>!answers.some(a=>a.id===s.id&&typeof a.answer==='string')))throw Error('Real provider response missing frozen samples');
    report.batches.at(-1).answers=answers;save();console.log(JSON.stringify({batch:offset/10+1,model:report.model,ids:samples.map(s=>s.id),durationMs:result.durationMs}));
  }
  report.status='COMPLETED_REQUIRES_REVIEW';save();
}catch(error){report.status='FAILED';report.error=error instanceof Error?error.message:String(error);save();console.error(report.error);process.exitCode=1;}

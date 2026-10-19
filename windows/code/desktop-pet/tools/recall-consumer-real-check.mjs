import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {BookRuntime} from '../dist/app/book-runtime.js';
import {emptyEntry} from '../dist/contracts/memory-book.js';

const docs=resolve('../../../docs/next/allmind-companion-v2'),raw=readFileSync(join(docs,'fixtures/recall-heldout-v2.json'),'utf8'),fixture=JSON.parse(raw);
const facts=JSON.parse(readFileSync(join(docs,'fixtures',fixture.factFixture),'utf8')).facts;
mkdirSync('.local/allmind-m4/tests',{recursive:true});
const repository=new FileBookRepository(mkdtempSync(resolve('.local/allmind-m4/tests/consumer-real-')));
const reportName=process.argv[2]??'recall-consumer-real-v2.json';
if(!/^recall-consumer-real-v2(?:-after)?\.json$/.test(reportName))throw Error('Report path must remain within evidence');
const evidence=join(docs,'evidence',reportName);
const report={status:'IN_PROGRESS',fixtureSha256:createHash('sha256').update(raw).digest('hex'),fixtureChanged:false,productionFactsWritten:false,consumer:'Production BookRuntime.inspect -> consumed refs; real answer through authenticated models/test, not formal chat acceptance',results:[],startedAt:new Date().toISOString()};
const save=()=>writeFileSync(evidence,JSON.stringify(report,null,2));
try{
  save();const scope={...fixture.scope,sessionId:'seed'},config=repository.loadConfig();
  repository.commitConfig({...config,characters:[{id:scope.characterId,name:'合成验收角色',intro:'',appearancePath:null}],currentCharacterId:scope.characterId,recall:{...config.recall,mode:'deep'}},0,'seed-config');
  for(const fact of facts){const [characterId,pairingId]=(fact.scope??`${scope.characterId}/${scope.pairingId}`).split('/'),owner={characterId,pairingId,sessionId:'seed'};
    const entry={...emptyEntry(fact.id,fact.type??'memory',fact.text,fact.text),pairingId:fact.origin==='authored'?null:pairingId,origin:fact.origin??'observed',enabled:fact.enabled!==false,sourceRefs:['synthetic-fixture']};
    repository.commit(owner,{upsert:[entry]},repository.snapshot(owner).revision,'seed-'+fact.id);
  }
  const runtime=new BookRuntime(repository,{async complete(){throw Error('Recall inspection must remain local')}});
  let found=0,total=0,injected=0;
  for(const sample of fixture.queries){const context=await runtime.inspect({...scope,sessionId:sample.newSession?'fresh-session':scope.sessionId},sample.query,new AbortController().signal),selected=[...new Set(context.consumed.map(ref=>ref.entryId))];
    const missing=sample.expectedIds.filter(id=>!selected.includes(id)),forbidden=selected.filter(id=>(sample.forbiddenIds??[]).includes(id)||sample.mustAnswerUnknown);
    found+=sample.expectedIds.length-missing.length;total+=sample.expectedIds.length;injected+=forbidden.length;
    const selectedFacts=repository.snapshot(scope).entries.filter(entry=>selected.includes(entry.id));
    report.results.push({id:sample.id,query:sample.query,selected,missing,forbidden,contextMessages:context.messages,prompt:'以下是合成验收，不是用户个人资料。仅依据本题检索证据回答，一句中文；没有证据就明确不知道，不猜测结果。\n证据：'+selectedFacts.map(entry=>entry.body).join('\n')+'\n问题：'+sample.query});
  }
  report.recall={found,total,ratio:found/total,forbiddenInjections:injected,pass:found/total>=fixture.evaluation.positiveEvidenceRecallMinimum&&injected===0};save();
  const session=JSON.parse(readFileSync(resolve('../../.local/memory-book/management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
  const request=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(170000)}),result=await response.json();if(!response.ok)throw Error(result.error?.message??'HTTP '+response.status);return result};
  const {config:live}=await request('/runtime');if(live.chatgptWeb?.temporaryChatTests!==false||live.mainModel?.kind!=='chatgpt-web')throw Error('Expected authorized non-temporary web source');
  report.model=live.mainModel.model;
  for(const [index,row] of report.results.entries()){
    if(row.prompt.length>2000)throw Error('Selected evidence exceeds endpoint bound');
    row.debugSessionId='recall-v2-'+randomUUID();save();
    row.modelResult=await request('/models/test',{binding:live.mainModel,prompt:row.prompt,debugSessionId:row.debugSessionId});save();
    if(!row.modelResult.ok)throw Error(row.modelResult.error?.message??'Real model failed');
    row.answerPatternMatched=new RegExp(fixture.queries[index].answerPattern).test(row.modelResult.reply);save();
    console.log(JSON.stringify({id:row.id,missing:row.missing,forbidden:row.forbidden,answerPatternMatched:row.answerPatternMatched,durationMs:row.modelResult.durationMs}));
  }
  report.status='COMPLETED_REQUIRES_SEMANTIC_REVIEW';report.finishedAt=new Date().toISOString();save();
  if(!report.recall.pass||report.results.some(row=>!row.answerPatternMatched))process.exitCode=1;
}catch(error){report.status='FAILED';report.error=error instanceof Error?error.stack:String(error);save();console.error(report.error);process.exitCode=1}finally{repository.close()}

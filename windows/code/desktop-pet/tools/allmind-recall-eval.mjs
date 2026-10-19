import { readFileSync,mkdirSync,mkdtempSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { FileBookRepository } from '../dist/memory/file-book-repository.js';
import { BookRuntime } from '../dist/app/book-runtime.js';
import { emptyEntry } from '../dist/contracts/memory-book.js';
import { createHash } from 'node:crypto';
const fixtureName=process.argv[2]??'recall-queries.json',reportName=process.argv[3]??'m2-recall-deterministic.json';
if(!/^[a-z0-9-]+\.json$/.test(fixtureName)||!/^[a-z0-9-]+\.json$/.test(reportName))throw Error('Evaluation filenames must stay within fixtures/evidence.');
const docs=resolve('../../../docs/next/allmind-companion-v2'),fixtureRaw=readFileSync(join(docs,'fixtures',fixtureName),'utf8'),fixture=JSON.parse(fixtureRaw);
if(fixture.factFixture){if(!/^[a-z0-9-]+\.json$/.test(fixture.factFixture))throw Error('Invalid fact fixture path');fixture.facts=JSON.parse(readFileSync(join(docs,'fixtures',fixture.factFixture),'utf8')).facts;}
mkdirSync('.local/allmind-m23/evaluation',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/allmind-m23/evaluation/recall-'));
const scope={...fixture.scope,sessionId:'frozen-evaluation'},config=repository.loadConfig();
try{
  repository.commitConfig({...config,currentCharacterId:scope.characterId,characters:[{id:scope.characterId,name:'评价角色',intro:'',appearancePath:null}],recall:{...config.recall,mode:'deep'}},0,'eval-config');
  for(const fact of fixture.facts){
    const [characterId,pairingId]=(fact.scope??`${scope.characterId}/${scope.pairingId}`).split('/');
    const owner={characterId,pairingId,sessionId:'seed'},entry=emptyEntry(fact.id,fact.type??'memory',fact.text,fact.text);entry.pairingId=fact.origin==='authored'?null:pairingId;entry.origin=fact.origin??'observed';entry.enabled=fact.enabled!==false;entry.sourceRefs=['synthetic-fixture'];
    repository.commit(owner,{upsert:[entry]},repository.snapshot(owner).revision,`seed-${fact.id}`);
  }
  const runtime=new BookRuntime(repository,{async complete(){throw Error('Deterministic evaluation must make zero LLM calls');}}),results=[];let found=0,total=0,injected=0;
  for(const sample of fixture.queries){
    const context=await runtime.inspect({...scope,sessionId:sample.newSession?'fresh-evaluation':scope.sessionId},sample.query,new AbortController().signal);
    const selected=[...new Set(context.consumed.map(ref=>ref.entryId))],missing=sample.expectedIds.filter(id=>!selected.includes(id));
    const forbidden=selected.filter(id=>(sample.forbiddenIds??[]).includes(id)||sample.mustAnswerUnknown&&sample.expectedIds.length===0);
    found+=sample.expectedIds.length-missing.length;total+=sample.expectedIds.length;injected+=forbidden.length;
    results.push({id:sample.id,query:sample.query,selected,expected:sample.expectedIds,missing,forbidden});
  }
  const report={fixture:`fixtures/${fixtureName}`,fixtureSha256:createHash('sha256').update(fixtureRaw).digest('hex'),fixtureChanged:false,model:'NONE',consumer:'BookRuntime.inspect -> BookContextBuilder.consumed',recall:found/total,found,total,forbiddenInjections:injected,pass:found/total>=fixture.evaluation.positiveEvidenceRecallMinimum&&injected===0,results};
  mkdirSync(join(docs,'evidence'),{recursive:true});writeFileSync(join(docs,'evidence',reportName),JSON.stringify(report,null,2));console.log(JSON.stringify({recall:report.recall,found,total,injected,pass:report.pass,failures:results.filter(row=>row.missing.length||row.forbidden.length).map(row=>({id:row.id,missing:row.missing,forbidden:row.forbidden}))}));if(!report.pass)process.exitCode=1;
}finally{repository.close();}

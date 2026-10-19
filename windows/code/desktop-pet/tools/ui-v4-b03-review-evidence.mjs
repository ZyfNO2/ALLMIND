// Offline review only: correlate Worker samples with saved synthetic turns, without model calls.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {countReplyChars} from '../dist/core/reply-length.js';
import {validateReplyStyleDecision} from '../dist/contracts/reply-length.js';

const data=resolve(process.env.AIKI_BOOK_DATA??'../../.local/memory-book');
const input=resolve(process.env.B03_SAMPLES??'../../../docs/next/ui-rework/evidence/b03-real-samples-mv9r09tm/samples.json');
const out=resolve(process.env.B03_REVIEW_EVIDENCE??'../../../docs/next/ui-rework/evidence/b03-review-20261016');
const sha=value=>createHash('sha256').update(value).digest('hex');
const evidence=JSON.parse(readFileSync(input,'utf8'));
assert.equal(evidence.samples.length,15);
const ids=new Set(evidence.samples.map(row=>row.sessionHash)),turns=new Map();
for(const name of readdirSync(data).filter(name=>/^session-.*\.jsonl$/u.test(name))){
  for(const line of readFileSync(join(data,name),'utf8').split('\n').filter(Boolean)){
    const turn=JSON.parse(line);
    if(!turn.sessionId?.startsWith('b03-style-'))continue;
    const id=sha(turn.sessionId).slice(0,16);
    if(ids.has(id)){assert.ok(!turns.has(id),'expected one sample turn per session');turns.set(id,turn);}
  }
}
const samples=evidence.samples.map(sample=>{
  const turn=turns.get(sample.sessionHash);assert.ok(turn,`missing persisted sample: ${sample.label}`);
  assert.equal(turn.user,sample.query);assert.equal(turn.assistant,sample.reply);
  validateReplyStyleDecision(turn.replyStyleDecision);
  for(const key of ['selectedStyle','source','intent','targetChars','effectiveRange','constrained','requestConflict'])assert.deepEqual(turn.replyStyleDecision[key],sample[key],sample.label+': '+key);
  const actual=countReplyChars(turn.assistant);assert.equal(actual,sample.localCount);
  if(turn.replyLength)assert.equal(actual,turn.replyLength.actualChars);
  return {label:sample.label,persistedTurnMatches:true,actualChars:actual,serverMeasurementAvailable:!!turn.replyLength};
});
const pairs=['explanation','technical','comparison'].map(label=>{
  const short=samples.find(row=>row.label===label+'-short').actualChars;
  const detailed=samples.find(row=>row.label===label+'-detailed').actualChars;
  return {label,short,detailed,ratio:detailed/short,pass:detailed>=short*1.5};
});
assert.ok(pairs.filter(row=>row.pass).length>=2);
const runtime=readFileSync(join(data,'runtime.json'));
const config=JSON.parse(runtime).data;
const role=config.characters.find(row=>row.id===evidence.characterId);
assert.ok(role);
const report={status:'PASS',checkedAt:new Date().toISOString(),source:'offline Worker sample / persisted synthetic turn audit; zero new cloud calls',samples,pairs,
  measurementNote:'Only bounded samples carry server replyLength results; null is unavailable, not an independently confirmed measurement.',
  runtime:{sha256:sha(runtime),revision:config.revision,roleBindingEnabled:!!config.chatgptProjects?.some(row=>row.enabled&&row.characterId===role.id&&row.pairingId==='local-user'),writerLock:existsSync(join(data,'writer.lock'))}};
mkdirSync(out,{recursive:true});writeFileSync(join(out,'real-samples-audit.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,persistedSamples:samples.length,measuredSamples:samples.filter(row=>row.serverMeasurementAvailable).length,pairs,runtime:report.runtime}));

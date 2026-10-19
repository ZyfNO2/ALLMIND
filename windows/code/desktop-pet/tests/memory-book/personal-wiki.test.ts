import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { FactWikiService } from '../../memory/fact-wiki.js';
import { BookRuntime } from '../../app/book-runtime.js';
import { compilePersonalWiki } from '../../memory/personal-wiki.js';
import { WikiMaintenance } from '../../memory/wiki-maintenance.js';
import {startBookServer} from '../../management/book-server.js';
import {BookCredentials} from '../../management/book-credentials.js';
import { packBook } from '../../memory/book-archives.js';
import {emptyEntry,type BookScope} from '../../contracts/memory-book.js';

const scope:BookScope={characterId:'aika',pairingId:'local-user',sessionId:'wiki'};

test('user chat preempts compilation before its reply model call and preserves one active provider',async t=>{
  const repository=fixture(t),book=ingest(repository,'priority-source','称呼：小林'),config=repository.loadConfig();
  const binding={baseUrl:'http://127.0.0.1:9999/v1',model:'fixture',credentialId:'fixture',inputTokens:8192,outputTokens:512};
  repository.commitConfig({...config,mainModel:binding,wikiModel:binding},config.revision,'priority-config');
  let active=0,peak=0;const purposes:string[]=[];
  const runtime=new BookRuntime(repository,{async complete(_binding,_messages,signal,options){active++;peak=Math.max(peak,active);purposes.push(options?.purpose??'unknown');try{if(options?.purpose==='wiki')return await new Promise<string>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});assert.equal(active,1);return '你好，小林。'}finally{active--;}}});
  const service=runtime.wikiMaintenance!,job=service.queue(scope,[book.wikiPages![0]!.id],'priority-queue');
  const pending=service.run(scope,job.id,new AbortController().signal);
  const rejected=assert.rejects(pending);
  const reply=await runtime.chat(scope,'你好',new AbortController().signal,{turnId:'priority-turn'});await rejected;
  assert.equal(reply.turn.assistant,'你好，小林。');assert.equal(peak,1);assert.deepEqual(purposes,['wiki','reply']);
  assert.equal(service.list(scope)[0]!.status,'cancelled');assert.deepEqual(service.list(scope)[0]!.results,[]);assert.equal(repository.readSession(scope).length,1);
});

test('source revision during compilation rejects late output and prevents stale application',async t=>{
  const repository=fixture(t),book=ingest(repository,'changed-source','称呼：小林'),config=repository.loadConfig(),page=book.wikiPages![0]!;
  repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:9999/v1',model:'fixture',credentialId:'fixture',inputTokens:8192,outputTokens:512}},config.revision,'changed-config');
  let finish!:(reply:string)=>void;
  const service=new WikiMaintenance(repository,{complete(){return new Promise<string>(resolve=>{finish=resolve})}},()=>{});
  const job=service.queue(scope,[page.id],'changed-queue'),running=service.run(scope,job.id,new AbortController().signal);
  const entry=repository.snapshot(scope).entries.find(entry=>entry.id===page.entryIds[0])!;
  repository.commit(scope,{upsert:[{...entry,pinned:true}]},book.revision,'pin-during-compile');
  finish(JSON.stringify({pages:[{pageId:page.id,paragraphs:[{text:'旧依据综合稿',entryIds:page.entryIds}]}]}));
  await assert.rejects(running,{code:'conflict'});
  assert.equal(service.list(scope)[0]!.status,'failed');assert.deepEqual(service.list(scope)[0]!.results,[]);
  assert.throws(()=>service.apply(scope,job.id,repository.snapshot(scope).revision,'stale-apply'),{code:'conflict'});
  assert.doesNotMatch(JSON.stringify(repository.snapshot(scope)),/旧依据综合稿/);
});

test('compilation HTTP endpoints enforce authentication, scope and explicit review approval',async t=>{
  const repository=fixture(t),book=ingest(repository,'http-source','称呼：小林'),config=repository.loadConfig(),page=book.wikiPages![0]!;
  repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:9999/v1',model:'fixture',credentialId:'fixture',inputTokens:8192,outputTokens:512}},config.revision,'http-config');
  const runtime=new BookRuntime(repository,{async complete(){return JSON.stringify({pages:[{pageId:page.id,paragraphs:[{text:'小林是用户指定的称呼。',entryIds:page.entryIds}]}]})}});
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(repository.directory,'credentials')),uiRoot:'management'});t.after(()=>server.close());
  const origin=new URL(server.url).origin,path='/api/memory-book/v1/wiki/compilation';
  const call=async(action:string,body:object)=>{const response=await fetch(origin+path+'/'+action,{method:'POST',headers:{Authorization:`Bearer ${server.token}`,'Content-Type':'application/json'},body:JSON.stringify({...scope,...body})});return {status:response.status,data:await response.json()}};
  assert.equal((await fetch(origin+path)).status,401);
  const queued=await call('queue',{pageIds:[page.id],operationId:'http-queue'});assert.equal(queued.status,200);
  const jobId=queued.data.job.id;
  assert.equal((await call('run',{jobId,pairingId:'other'})).status,404);
  assert.equal((await call('run',{jobId})).data.job.status,'review');
  assert.equal((await call('apply',{jobId,expectedRevision:book.revision,operationId:'http-apply'})).status,400);
  assert.equal((await call('apply',{jobId,confirmed:true,expectedRevision:book.revision,operationId:'http-apply'})).status,200);
  assert.match(repository.snapshot(scope).wikiPages!.find(row=>row.id===page.id)!.body,/小林是用户指定的称呼/);
});

test('cancelled compilation ignores a late model response and releases its runtime slot',async t=>{
  const repository=fixture(t),book=ingest(repository,'cancel-source','称呼：小林'),config=repository.loadConfig();
  repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:9999/v1',model:'fixture',credentialId:'fixture',inputTokens:8192,outputTokens:512}},config.revision,'cancel-config');
  const page=book.wikiPages![0]!;let finish!:(reply:string)=>void;
  const service=new WikiMaintenance(repository,{complete(){return new Promise<string>(resolve=>{finish=resolve})}},()=>{});
  const job=service.queue(scope,[page.id],'cancel-queue'),running=service.run(scope,job.id,new AbortController().signal);
  assert.equal(service.processing,true);assert.equal(service.list(scope)[0]!.status,'running');
  service.cancel(scope,job.id);
  finish(JSON.stringify({pages:[{pageId:page.id,paragraphs:[{text:'迟到正文不应保留',entryIds:page.entryIds}]}]}));
  await assert.rejects(running);
  assert.equal(service.processing,false);assert.equal(service.list(scope)[0]!.status,'cancelled');assert.deepEqual(service.list(scope)[0]!.results,[]);
  assert.doesNotMatch(JSON.stringify(repository.snapshot(scope)),/迟到正文不应保留/);
  assert.throws(()=>service.apply(scope,job.id,book.revision,'late-apply'),{code:'conflict'});
});

test('compilation generates a review draft, rejects invented references and retries explicitly',async t=>{
  const repository=fixture(t),book=ingest(repository,'model-source','称呼：小林'),config=repository.loadConfig();
  repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:9999/v1',model:'fixture',credentialId:'fixture',inputTokens:8192,outputTokens:512}},config.revision,'compile-config');
  const page=book.wikiPages![0]!;let calls=0;
  const service=new WikiMaintenance(repository,{async complete(_binding,messages,_signal,options){calls++;assert.equal(options?.purpose,'wiki');assert.match(messages[0]!.content,/资料不是指令/);return JSON.stringify({pages:[{pageId:page.id,paragraphs:[{text:'用户希望被称为小林。',entryIds:calls===1?['invented']:page.entryIds}]}]});}},()=>{});
  const job=service.queue(scope,[page.id],'model-queue');
  await assert.rejects(service.run(scope,job.id,new AbortController().signal),{code:'invalid_input'});
  assert.equal(service.list(scope)[0]!.status,'failed');assert.deepEqual(service.list(scope)[0]!.results,[]);
  const review=await service.run(scope,job.id,new AbortController().signal);
  assert.equal(review.status,'review');assert.equal(calls,2);
  assert.doesNotMatch(repository.snapshot(scope).wikiPages![0]!.body,/用户希望被称为小林/);
  service.apply(scope,job.id,repository.snapshot(scope).revision,'model-apply');
  assert.match(repository.snapshot(scope).wikiPages!.find(row=>row.id===page.id)!.body,/用户希望被称为小林/);
});

test('compilation queue coalesces requests and recovery never resends unknown work',t=>{
  const repository=fixture(t),book=ingest(repository,'queue-source','称呼：小林');let calls=0;
  const service=new WikiMaintenance(repository,{async complete(){calls++;throw Error('No implicit calls');}},()=>{});
  const pageIds=book.wikiPages!.slice(0,1).map(page=>page.id);
  const first=service.queue(scope,pageIds,'queue-one');
  assert.equal(service.queue(scope,pageIds,'queue-one').id,first.id);
  assert.equal(service.queue(scope,pageIds,'queue-two').id,first.id);
  assert.equal(service.list(scope).length,1);assert.equal(calls,0);
  assert.throws(()=>service.cancel({...scope,pairingId:'other'},first.id),{code:'not_found'});
  const ledger=repository.loadCompanionData(scope);ledger.wikiJobs![0]!.status='running';ledger.wikiJobs![0]!.attempts=1;repository.saveCompanionData(scope,ledger);
  service.recover(scope);assert.equal(service.list(scope)[0]!.status,'failed');assert.equal(calls,0);
  assert.match(service.list(scope)[0]!.error!,/不会自动重发/);
  assert.equal(service.cancel(scope,first.id).status,'cancelled');
});

test('reviewed compilation replaces narrative only while its exact source basis remains current',t=>{
  const repository=fixture(t),book=ingest(repository,'compiled-source','称呼：小林');
  const page=book.wikiPages![0]!;
  const data=repository.loadCompanionData(scope),now=new Date().toISOString();
  data.wikiJobs=[{id:'compiled-job',scope,configRevision:0,status:'applied',attempts:1,createdAt:now,updatedAt:now,error:null,operations:[],targets:[{pageId:page.id,inputHash:page.compilationInputHash!,pageRevision:page.revision,basisRefs:page.basisRefs,sources:page.sources}],results:[{pageId:page.id,paragraphs:[{text:'用户希望以小林相称。',entryIds:page.entryIds}]}]}];
  const input={...book,companionData:[data]};
  const compiled=compilePersonalWiki(input).find(row=>row.id===page.id)!;
  assert.match(compiled.body,/用户希望以小林相称/);assert.equal(compiled.compilation?.jobId,'compiled-job');
  assert.deepEqual(compiled.basisRefs,page.basisRefs);assert.deepEqual(input.entries,book.entries);
  const invalid=structuredClone(data);invalid.wikiJobs![0]!.scope.characterId='other';
  assert.throws(()=>repository.saveCompanionData(scope,invalid),{code:'invalid_input'});
  const foreign=structuredClone(data);foreign.pairingId='other';foreign.wikiJobs![0]!.scope.pairingId='other';
  assert.throws(()=>repository.saveCompanionData({...scope,pairingId:'other'},foreign),{code:'invalid_input'},'private source/page ownership must agree with the stored job pairing');
  const incomplete=structuredClone(data);incomplete.wikiJobs![0]!.status='review';incomplete.wikiJobs![0]!.results=[];
  assert.throws(()=>repository.saveCompanionData(scope,incomplete),/Invalid Wiki maintenance result state/);
  const older=structuredClone(data.wikiJobs![0]!);older.id='older-created-job';older.updatedAt='2025-01-01T00:00:00Z';older.results[0]!.paragraphs[0]!.text='更早应用的旧正文';
  const reordered=compilePersonalWiki({...input,companionData:[{...data,wikiJobs:[data.wikiJobs![0]!,older]}]}).find(row=>row.id===page.id)!;
  assert.match(reordered.body,/用户希望以小林相称/);assert.doesNotMatch(reordered.body,/更早应用的旧正文/);
  const changed={...input,entries:input.entries.map(entry=>({...entry,revision:entry.revision+1}))};
  const stale=compilePersonalWiki(changed).find(row=>row.id===page.id)!;
  assert.equal(stale.compilation,undefined);assert.doesNotMatch(stale.body,/用户希望以小林相称/);
  repository.saveCompanionData(scope,data);
  const review=repository.loadCompanionData(scope);review.wikiJobs![0]!.status='review';repository.saveCompanionData(scope,review);
  const revision=repository.snapshot(scope).revision,approval={wikiApproval:{jobId:'compiled-job',confirmed:true as const}};
  const receipt=repository.commit(scope,approval,revision,'apply-compiled');
  assert.deepEqual(repository.commit(scope,approval,revision,'apply-compiled'),receipt);
  assert.equal(repository.loadCompanionData(scope).wikiJobs![0]!.status,'applied');
  assert.match(repository.snapshot(scope).wikiPages!.find(row=>row.id===page.id)!.body,/用户希望以小林相称/);
  assert.deepEqual(repository.snapshot(scope).entries,book.entries);
  assert.doesNotMatch(new BookRuntime(repository,{async complete(){throw Error('Export must remain local')}}).imports.export(scope).text,/用户希望以小林相称|compiled-job|wikiJobs/);
  const persisted=repository.snapshot(scope);repository.close();const reopened=new FileBookRepository(repository.directory);t.after(()=>reopened.close());
  assert.deepEqual(reopened.snapshot(scope),persisted);
  assert.deepEqual(reopened.loadCompanionData({...scope,pairingId:'other'}).wikiJobs??[],[]);
  reopened.commit(scope,{remove:page.entryIds},reopened.snapshot(scope).revision,'erase-compiled');
  const erased=reopened.loadCompanionData(scope).wikiJobs![0]!;
  assert.equal(erased.status,'cancelled');assert.deepEqual(erased.results,[]);
  assert.doesNotMatch(JSON.stringify(reopened.snapshot(scope)),/用户希望以小林相称/);
  reopened.close();
  const file=join(repository.directory,readdirSync(repository.directory).find(name=>name.startsWith('book-'))!),disk=JSON.parse(readFileSync(file,'utf8'));
  disk.data.companionData.push(foreign);const damagedText=JSON.stringify(disk);writeFileSync(file,damagedText);
  const damaged=new FileBookRepository(repository.directory);t.after(()=>damaged.close());
  assert.throws(()=>damaged.snapshot({...scope,pairingId:'other'}),{code:'corrupt_data'},'loading forged cross-pair refs must fail before exposing the ledger');
  assert.equal(readFileSync(file,'utf8'),damagedText,'a bad snapshot is not silently reset');damaged.close();
});

test('archive limits fail explicitly before replacing the last committed Book',t=>{
  const repository=fixture(t),before=ingest(repository,'existing','称呼：小林');
  const excessive=Array.from({length:513},(_,index)=>({...emptyEntry(`pinned-${index}`,'wiki','固定资料','有据固定资料'),pairingId:scope.pairingId,origin:'observed' as const,pinned:true}));
  assert.throws(()=>repository.commit(scope,{upsert:excessive},before.revision,'overflow-pinned'),{code:'budget'});
  assert.deepEqual(repository.snapshot(scope),before,'the failed write preserves authoritative facts, pages and source snapshots');
  const overTotal=Array.from({length:8193},(_,index)=>({...emptyEntry(`entry-${index}`,'memory','经历','有据经历'),pairingId:scope.pairingId}));
  assert.throws(()=>packBook({schemaVersion:'memory-book/v1',characterId:'aika',revision:1,entries:overTotal}),{code:'budget'});
});

test('bounded recent and explicitly important experience layers survive long history and feed formal Context',async t=>{
  const repository=fixture(t),wiki=new FactWikiService(repository);
  for(let i=0;i<11;i++){
    const preview=wiki.preview(scope,{sourceId:`experience-${i}`,title:'用户',text:i===0?'共同经历0：我和你一起整理最初的相册':`共同经历${i}：我和你一起整理第${i}次项目`,private:true});
    for(const snapshot of preview.source.snapshots)snapshot.capturedAt=new Date(Date.UTC(2025,0,i+1)).toISOString();
    repository.commit(scope,{upsert:preview.facts,wikiSources:[preview.source]},preview.expectedRevision,`experience-${i}`);
    if(i===0){const book=repository.snapshot(scope),entry=book.entries[0]!;repository.commit(scope,{upsert:[{...entry,importance:80}]},book.revision,'important');}
  }
  const book=repository.snapshot(scope),recent=book.wikiPages!.find(page=>page.layer==='recent')!,important=book.wikiPages!.find(page=>page.layer==='important')!;
  assert.equal(recent.basisRefs.length,8);assert.ok(!recent.body.includes('最初的相册'));assert.match(important.body,/最初的相册/);assert.match(important.body,/2025-01-01/);
  const runtime=new BookRuntime(repository,{async complete(){throw Error('Recall remains local')}});
  const context=await runtime.inspect({...scope,sessionId:'months-later'},'我们一起整理最初的相册，记得吗',new AbortController().signal);
  assert.ok(context.compiledPagesUsed?.some(page=>page.id===important.id));assert.match(JSON.stringify(context.messages),/最初的相册/);
  assert.equal(context.messages.filter(message=>message.role==='system').flatMap(message=>[...message.content.matchAll(/用户的共同经历0/g)]).length,1,'source summary and raw facts must not duplicate; current user query stays intact');
  const paraphrase=await runtime.inspect({...scope,sessionId:'independent-new-session'},'我们一起做过的重要事情，最早那次还能想起来吗？',new AbortController().signal);
  assert.ok(paraphrase.consumed.some(ref=>important.basisRefs.some(basis=>basis.entryId===ref.entryId)),'an independent paraphrase must recall sourced important experience beyond recent chat');
  assert.ok(paraphrase.compiledPagesUsed?.some(page=>page.id===important.id));
  const old=book.entries.find(entry=>entry.fact?.value.includes('最初的相册'))!;repository.commit(scope,{remove:[old.id]},book.revision,'forget-experience');runtime.invalidate(scope.characterId);
  assert.ok(!JSON.stringify(repository.snapshot(scope).wikiPages).includes('最初的相册'));assert.equal(repository.snapshot({...scope,pairingId:'other'}).wikiPages?.length??0,0);
});

test('incremental compilation reuses unaffected bodies and batches multiple changed facts in one page revision',t=>{
  const repository=fixture(t);ingest(repository,'person','# 阿敏\n工作：设计师');const before=ingest(repository,'preferences','称呼：小林\n喜欢的茶：伯爵茶');
  const stats={compiled:0,reused:0,removed:0};assert.deepEqual(compilePersonalWiki(before,stats),before.wikiPages);assert.equal(stats.compiled,0);assert.equal(stats.reused,before.wikiPages!.length);
  const wiki=new FactWikiService(repository),preview=wiki.preview(scope,{sourceId:'preferences',title:'用户',text:'称呼：小林\n喜欢的茶：绿茶\n沟通方式：直接些',private:true});
  const upsert=preview.facts.filter(entry=>preview.changes.some(change=>change.id===entry.id&&['add','update','retire'].includes(change.action)));
  const changed={...before,entries:[...before.entries.filter(entry=>!upsert.some(next=>next.id===entry.id)),...upsert.map(entry=>({...entry,revision:(before.entries.find(old=>old.id===entry.id)?.revision??0)+1}))],wikiSources:[...before.wikiSources!.filter(source=>source.id!==preview.source.id),preview.source]};
  const compiled=compilePersonalWiki(changed,stats);assert.equal(stats.compiled,2);assert.equal(stats.reused,2);
  const person=before.wikiPages!.find(page=>page.subject==='阿敏')!;assert.deepEqual(compiled.find(page=>page.id===person.id),person);
  wiki.apply(scope,preview.id,'batched-preferences');const next=repository.snapshot(scope);
  const profile=before.wikiPages!.find(page=>page.kind==='profile')!;assert.equal(next.wikiPages!.find(page=>page.id===profile.id)!.revision,profile.revision+1);
  const preference=next.entries.find(entry=>entry.fact?.predicate==='喜欢的茶')!;repository.commit(scope,{remove:[preference.id]},next.revision,'forget-green');
  assert.ok(!JSON.stringify(repository.snapshot(scope).wikiPages).includes('绿茶'));assert.deepEqual(compilePersonalWiki(repository.snapshot(scope),stats),repository.snapshot(scope).wikiPages);assert.equal(stats.compiled,0);
});
function fixture(t:test.TestContext){mkdirSync('.local/allmind-m4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/allmind-m4/tests/wiki-'));t.after(()=>repository.close());return repository;}
function ingest(repository:FileBookRepository,id:string,text:string){const wiki=new FactWikiService(repository),preview=wiki.preview(scope,{sourceId:id,title:'用户',text,private:true});wiki.apply(scope,preview.id,`apply-${id}`);return repository.snapshot(scope);}

test('personal Wiki persists profile/preference/person facets, sources and reciprocal page links', t=>{
  const repository=fixture(t),book=ingest(repository,'profile','称呼：小林\n朋友：阿敏\n喜欢的茶：伯爵茶');
  assert.ok(Array.isArray(book.wikiPages)&&book.wikiPages.length>=3,'compiled personal facets must be persisted');
  const profile=book.wikiPages!.find(page=>page.kind==='profile')!,person=book.wikiPages!.find(page=>page.kind==='person')!;
  assert.match(profile.body,/小林/);assert.match(profile.body,/伯爵茶/);assert.equal(person.subject,'阿敏');
  assert.match(profile.body,/身份与称呼/);assert.match(profile.body,/兴趣与相处偏好/);assert.match(profile.body,/人物联系/);assert.ok(!profile.body.includes('目前有据记录为'),'the compiled profile organizes an integrated account instead of repeating the old per-fact template');
  assert.match(person.body,/用户的朋友：阿敏/,'a person facet must preserve the original fact subject');
  assert.ok(profile.links.includes(person.id));assert.ok(person.backlinks.includes(profile.id));
  assert.ok(profile.basisRefs.every(ref=>book.entries.some(entry=>entry.id===ref.entryId&&entry.revision===ref.revision)));
  assert.equal(repository.snapshot({...scope,pairingId:'different-user'}).wikiPages?.length??0,0);
  repository.close();const reopened=new FileBookRepository(repository.directory);t.after(()=>reopened.close());
  assert.equal(reopened.snapshot(scope).wikiPages!.find(page=>page.id===profile.id)!.fingerprint,profile.fingerprint);
});

test('source revocation removes compiled pages and keeps the explicit source audit', t=>{
  const repository=fixture(t),book=ingest(repository,'revoked','喜欢的茶：伯爵茶'),wiki=new FactWikiService(repository);
  assert.ok(wiki.query(scope,'伯爵茶').pages.length>0);
  wiki.revoke(scope,'revoked',book.revision,'revoke');
  assert.equal(repository.snapshot(scope).wikiPages!.length,0);
  assert.ok(wiki.lint(scope).issues.some(issue=>issue.code==='source_revoked_or_superseded'));
  assert.equal(repository.snapshot(scope).wikiSources![0]!.enabled,false);
});

test('explicit aliases merge the same person across sources and participate in production recall', async t=>{
  const repository=fixture(t);ingest(repository,'friend-alias','朋友：Amy');
  const book=ingest(repository,'person-details','# 阿敏\n英文名：Amy\n工作：设计师');
  const person=book.wikiPages!.find(page=>page.kind==='person'&&page.subject==='阿敏')!;
  assert.ok(person.aliases?.includes('Amy'));assert.equal(book.wikiPages!.some(page=>page.kind==='person'&&page.subject==='Amy'),false);
  assert.equal(person.sourceIds.length,2);
  const runtime=new BookRuntime(repository,{async complete(){throw Error('Alias recall must stay local')}});
  const context=await runtime.inspect(scope,'Amy 是做什么工作的',new AbortController().signal);
  assert.ok(context.messages.some(message=>message.content.includes('设计师')));
});

test('compilation merges independent sources, keeps unchanged versions, and forget removes dependent text/history', t=>{
  const repository=fixture(t);ingest(repository,'name','称呼：小林');const before=ingest(repository,'tea','喜欢的茶：伯爵茶');
  const old=before.wikiPages!.find(page=>page.kind==='profile')!;
  const next=ingest(repository,'project','当前项目：桌宠字幕同步');const updated=next.wikiPages!.find(page=>page.id===old.id)!;
  assert.ok(updated.revision>old.revision);assert.ok(updated.history.length>0);assert.equal(updated.sourceIds.length,3);
  repository.commit(scope,{upsert:[]},next.revision,'unchanged');
  assert.equal(repository.snapshot(scope).wikiPages!.find(page=>page.id===old.id)!.revision,updated.revision);
  const tea=repository.snapshot(scope).entries.find(entry=>entry.fact?.value==='伯爵茶')!;
  repository.commit(scope,{remove:[tea.id]},repository.snapshot(scope).revision,'forget-tea');
  assert.ok(!JSON.stringify(repository.snapshot(scope).wikiPages).includes('伯爵茶'),'current pages and history cannot retain forgotten fact text');
});

test('formal Context consumes compiled facets with source refs without duplicating raw facts', async t=>{
  const repository=fixture(t);ingest(repository,'tea','喜欢的茶：伯爵茶');const runtime=new BookRuntime(repository,{async complete(){throw Error('Inspector must not call model')}});
  const context=await runtime.inspect(scope,'我喜欢的茶是什么',new AbortController().signal);
  assert.ok(context.compiledPagesUsed?.length,'the production Builder must actually consume a compiled facet');
  assert.ok(context.messages.some(message=>message.content.includes('个人 Wiki')));
  assert.equal(context.messages.filter(message=>message.content.includes('伯爵茶')).length,1,'page and canonical facts must not consume duplicate prompt slots');
  assert.ok(context.consumed.some(ref=>repository.snapshot(scope).entries.some(entry=>entry.id===ref.entryId&&entry.fact?.value==='伯爵茶')));
});

test('growth beyond 512 sources archives bounded segments and keeps old evidence recallable and erasable', async t=>{
  const repository=fixture(t);
  for(let i=0;i<600;i++)ingest(repository,`growth-${i}`,`记录${i}：旧经历编号${i}`);
  const book=repository.snapshot(scope);assert.equal(book.entries.length,600);assert.equal(book.wikiSources!.length,600);
  const file=join(repository.directory,readdirSync(repository.directory).find(name=>name.startsWith('book-'))!);
  const stored=JSON.parse(readFileSync(file,'utf8'));assert.equal(stored.data.entries.length,512);assert.equal(stored.data.wikiSources.length,512);assert.equal(stored.data.archives.length,1);assert.equal(stored.data.archives[0].entries.length,88);
  assert.ok((book.archiveCounts?.entries??0)>0);assert.ok((book.archiveCounts?.sources??0)>0);
  const runtime=new BookRuntime(repository,{async complete(){throw Error('Archived recall must stay local')}});
  const context=await runtime.inspect(scope,'记录0 旧经历编号0',new AbortController().signal);
  const old=book.entries.find(entry=>entry.fact?.predicate==='记录0')!;
  assert.ok(context.consumed.some(ref=>ref.entryId===old.id));
  repository.commit(scope,{remove:[old.id]},book.revision,'forget-archived');
  assert.equal(repository.snapshot(scope).entries.length,599);
  assert.ok(!JSON.stringify(repository.snapshot(scope).wikiPages).includes('旧经历编号0'));
  repository.close();const reopened=new FileBookRepository(repository.directory);t.after(()=>reopened.close());
  assert.equal(reopened.snapshot(scope).entries.length,599);assert.equal(reopened.snapshot({...scope,pairingId:'other'}).entries.length,0);
  assert.equal(reopened.snapshot({...scope,pairingId:'other'}).archiveCounts!.entries,0);
  const corrupt=JSON.parse(readFileSync(file,'utf8'));corrupt.data.archives[0].entries[0].body='corrupted';writeFileSync(file,JSON.stringify(corrupt));
  assert.throws(()=>reopened.snapshot(scope),{code:'corrupt_data'},'archive corruption must fail before recall');
});

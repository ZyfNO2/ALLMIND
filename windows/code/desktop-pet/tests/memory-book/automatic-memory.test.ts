import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { BookRuntime } from '../../app/book-runtime.js';
import { DEFAULT_COMPANION_SETTINGS } from '../../contracts/book-companion.js';
import type { BookScope, ModelBinding } from '../../contracts/memory-book.js';
import {BookProactiveScheduler,zonedTime} from '../../core/book-proactive.js';
const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'automatic' };
const binding: ModelBinding = { baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', credentialId: 'fixture', inputTokens: 8192, outputTokens: 512 };

test('raw erasure clears compiled prose, relationship, trace, active recall and grounded proactive delivery together',async t=>{
  const repository=fixture(t),config=repository.loadConfig();repository.commitConfig({...config,wikiModel:binding},config.revision,'wiki-model');
  const runtime=new BookRuntime(repository,{async complete(_binding,messages,_signal,options){if(options?.purpose==='wiki'){const input=JSON.parse(messages[1]!.content);return JSON.stringify({pages:input.pages.map((page:{pageId:string;facts:{id:string}[]})=>({pageId:page.pageId,paragraphs:[{text:'有据综合：用户与角色一起整理过琥珀相册。',entryIds:page.facts.map(fact=>fact.id)}]}))})}return '好的'}});
  await runtime.chat(scope,'共同经历：我和你一起整理琥珀相册\n称呼：小岚\n信任反馈：你记对了',new AbortController().signal,{turnId:'shared-original'});await runtime.automaticMemory!.flush();
  const book=repository.snapshot(scope),page=book.wikiPages!.find(page=>page.kind==='experience'&&!page.layer)!;assert.ok(page,'shared experience page exists');
  const job=runtime.wikiMaintenance!.queue(scope,[page.id],'erase-queue');await runtime.wikiMaintenance!.run(scope,job.id,new AbortController().signal);runtime.wikiMaintenance!.apply(scope,job.id,repository.snapshot(scope).revision,'erase-apply');
  const reply=await runtime.chat(scope,'之前的共同经历是什么？',new AbortController().signal,{turnId:'recall-consumer'});await runtime.automaticMemory!.flush();assert.match(JSON.stringify(reply.context!.messages),/琥珀相册/);assert.ok(reply.context!.relationshipUsed);assert.ok(runtime.trace(scope,reply.turn.traceId));
  let now=zonedTime('2026-10-14',8,55,'Asia/Singapore');const proactive=new BookProactiveScheduler(repository,async()=> '我记得琥珀相册',()=>{},()=>now);proactive.takeover(scope,null);
  const settings=repository.loadConfig();repository.commitConfig({...settings,companion:{...settings.companion!,proactive:true}},settings.revision,'enable-proactive');now+=6*60000;await proactive.tick(scope,{hidden:false,dnd:false,typing:false,recording:false,busy:false,quiet:false});
  assert.equal(repository.loadCompanionData(scope).deliveries[0]!.status,'dispatched');
  repository.eraseTurns(scope,['shared-original'],repository.snapshot(scope).revision);runtime.invalidate(scope.characterId);
  const erased=repository.snapshot(scope),data=repository.loadCompanionData(scope);assert.doesNotMatch(JSON.stringify(erased),/琥珀相册|小岚/);assert.equal(erased.relationships?.length??0,0);
  assert.deepEqual(data.wikiJobs!.find(row=>row.id===job.id)!.results,[]);assert.equal(data.deliveries[0]!.status,'cancelled');assert.equal(data.deliveries[0]!.text,null);assert.doesNotMatch(data.deliveries[0]!.reason,/琥珀相册/);
  assert.throws(()=>runtime.trace(scope,reply.turn.traceId));
  const after=await runtime.inspect({...scope,sessionId:'after-erasure'},'之前的共同经历是什么？',new AbortController().signal);assert.doesNotMatch(JSON.stringify(after.messages),/琥珀相册|小岚/);assert.equal(after.relationshipUsed,undefined);assert.equal(after.consumed.length,0);
});

test('explicit event progress persists sourced outcome and erasure removes its influence', async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  for(const [id,text] of [['planned','面试：明天下午三点 A公司面试'],['ongoing','A公司面试正在进行'],['ended','A公司面试已经结束，通过了']]){
    await runtime.chat(scope,text!,new AbortController().signal,{turnId:id!});await runtime.automaticMemory!.flush();
  }
  const data=repository.loadCompanionData(scope);assert.equal(data.events.length,1);assert.equal(data.events[0]!.status,'ended');
  assert.deepEqual(data.events[0]!.reportedTimeline?.map(row=>row.status),['ongoing','ended']);
  assert.ok(data.events[0]!.reportedTimeline!.every(row=>repository.snapshot(scope).entries.some(entry=>entry.id===row.entryId&&entry.fact)));
  const endedTurn=repository.readSession(scope).find(turn=>turn.id==='ended')!;assert.equal(data.events[0]!.progressReportedAt,Date.parse(endedTurn.timestamp));
  const entry=repository.snapshot(scope).entries.find(entry=>entry.id===data.events[0]!.progressEntryId)!;
  assert.ok(entry.fact?.quote.includes('已经结束'));assert.ok(entry.sourceRefs.includes('turn:automatic:ended'));
  assert.ok(entry.fact?.value.includes('通过了'),'the reported result must survive the event update');
  const context=await runtime.inspect({...scope,sessionId:'new'},'A公司面试事件进展',new AbortController().signal);
  assert.ok(context.messages.some(message=>message.content.includes('已经结束')));
  repository.eraseTurns(scope,['ended'],repository.snapshot(scope).revision);runtime.invalidate(scope.characterId);
  assert.equal(repository.loadCompanionData(scope).events.length,0,'never revive the old ongoing status after outcome erasure');
  assert.ok(!JSON.stringify(repository.snapshot(scope).wikiPages).includes('已经结束'));
});

test('a factual outcome followed by future plans or a question retains only the reported progress',async t=>{
  for(const suffix of ['，明天再签合同','，你能记住吗？']){
    const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
    await runtime.chat(scope,'面试：明天下午三点 A公司面试',new AbortController().signal);await runtime.automaticMemory!.flush();
    await runtime.chat(scope,'A公司面试已经结束，通过了'+suffix,new AbortController().signal);await runtime.automaticMemory!.flush();
    const event=repository.loadCompanionData(scope).events[0]!;assert.equal(event.status,'ended');
    const progress=repository.snapshot(scope).entries.find(entry=>entry.id===event.progressEntryId)!;assert.match(progress.fact!.quote,/已经结束，通过了/);assert.doesNotMatch(progress.fact!.quote,/明天|你能记住/);
  }
});

test('third-party or interviewer activity cannot advance the users existing interview',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.chat(scope,'朋友：阿敏',new AbortController().signal);await runtime.automaticMemory!.flush();
  await runtime.chat(scope,'面试：明天下午三点 A公司面试',new AbortController().signal);await runtime.automaticMemory!.flush();
  for(const text of ['朋友的A公司面试已经结束，通过了','她的A公司面试正在进行','A公司的面试官正在参加培训','昨天阿敏的A公司面试已经结束，通过了']){await runtime.chat(scope,text,new AbortController().signal);await runtime.automaticMemory!.flush();assert.equal(repository.loadCompanionData(scope).events[0]!.status,'scheduled');}
});

test('a sourced friends schedule remains a person fact and does not become the users proactive calendar',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.chat(scope,'# 阿敏\n面试：明天下午三点 A公司面试',new AbortController().signal);await runtime.automaticMemory!.flush();
  assert.ok(repository.snapshot(scope).entries.some(entry=>entry.fact?.subject==='阿敏'&&entry.fact.predicate==='面试'));
  assert.equal(repository.loadCompanionData(scope).events.length,0);
});

test('an unknown result or another selection stage cannot complete the scheduled interview',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.chat(scope,'面试：明天下午三点 A公司面试',new AbortController().signal);await runtime.automaticMemory!.flush();
  for(const text of ['A公司面试不知道是否通过了','A公司面试资格审查结束了，通过了']){await runtime.chat(scope,text,new AbortController().signal);await runtime.automaticMemory!.flush();assert.equal(repository.loadCompanionData(scope).events[0]!.status,'scheduled');}
  assert.equal(repository.loadCompanionData(scope).jobs.at(-1)!.status,'done');
  assert.ok(repository.loadCompanionData(scope).events.some(event=>event.reportedOnly&&event.status==='ended'&&event.quote.includes('资格审查')));
});

test('past reports need no prior plan and preserve occurrence time separately from the report',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.chat(scope,'昨天上午九点 A公司面试已经结束，通过了',new AbortController().signal,{turnId:'unplanned-report'});await runtime.automaticMemory!.flush();
  const event=repository.loadCompanionData(scope).events[0]!,turn=repository.readSession(scope)[0]!;
  assert.equal(event.reportedOnly,true);assert.equal(event.status,'ended');assert.equal(event.date,null);assert.equal(event.at,null);
  assert.equal(event.reportedTimeline![0]!.reportedAt,Date.parse(turn.timestamp));assert.equal(event.reportedTimeline![0]!.occurrence!.precision,'minute');assert.match(event.reportedTimeline![0]!.occurrence!.timeExpression,/昨天/);
  assert.ok(event.reportedTimeline![0]!.occurrence!.at!<Date.parse(turn.timestamp));
  const context=await runtime.inspect({...scope,sessionId:'another'},'A公司面试的结果',new AbortController().signal);assert.match(JSON.stringify(context.messages),/通过了/);
  repository.eraseTurns(scope,['unplanned-report'],repository.snapshot(scope).revision);runtime.invalidate(scope.characterId);assert.equal(repository.loadCompanionData(scope).events.length,0);
  await runtime.chat({...scope,sessionId:'another-report'},'昨天上午九点 A公司面试已经结束，通过了',new AbortController().signal);await runtime.automaticMemory!.flush();assert.equal(repository.loadCompanionData(scope).events.length,0,'a new session/job ID must not resurrect the erased report');
});

test('same-company reports on explicit different dates remain distinct and repeated reports stay idempotent',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  for(const text of ['2026-10-12 上午九点 A公司面试已经结束，通过了','2026-10-13 下午三点 A公司面试已经结束，通过了']){await runtime.chat(scope,text,new AbortController().signal);await runtime.automaticMemory!.flush();}
  assert.equal(repository.loadCompanionData(scope).events.length,2);
  assert.deepEqual(repository.loadCompanionData(scope).events.map(event=>event.reportedTimeline!.at(-1)!.occurrence!.date).sort(),['2026-10-12','2026-10-13']);
  await runtime.chat({...scope,sessionId:'another'},'2026-10-13 下午三点 A公司面试已经结束，通过了',new AbortController().signal);await runtime.automaticMemory!.flush();assert.equal(repository.loadCompanionData(scope).events.length,2);
});

test('ambiguous progress needs an explicit event choice and speculative future start does not change status', async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  for(const text of ['面试：明天下午三点 A公司面试','面试B：后天下午三点 B公司面试','面试结束了']){await runtime.chat(scope,text,new AbortController().signal);await runtime.automaticMemory!.flush();}
  const data=repository.loadCompanionData(scope),job=data.jobs.at(-1)!;assert.equal(job.status,'review');assert.equal(job.eventCandidates?.length,2);
  assert.ok(data.events.every(event=>event.status==='scheduled'));
  const selected=data.events.find(event=>event.quote.includes('B公司'))!;
  runtime.automaticMemory!.approve(scope,job.id,selected.id);
  assert.equal(repository.loadCompanionData(scope).events.find(event=>event.id===selected.id)!.status,'ended');
  await runtime.chat(scope,'如果 A公司面试开始了，我会告诉你',new AbortController().signal);await runtime.automaticMemory!.flush();
  assert.equal(repository.loadCompanionData(scope).events.find(event=>event.quote.includes('A公司'))!.status,'scheduled');
});
function fixture(t: test.TestContext, model = false) {
  mkdirSync('.local/allmind-m23/tests', { recursive: true }); const dir = mkdtempSync('.local/allmind-m23/tests/memory-'), repository = new FileBookRepository(dir);
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = repository.loadConfig(); repository.commitConfig({ ...config, mainModel: binding, wikiModel: model ? binding : null,
    companion: { ...DEFAULT_COMPANION_SETTINGS, autoMemory: true, extraction: model ? 'model' : 'declarations', cloudMemoryConsent: model } }, 0, 'config');
  return repository;
}
test('successful formal chat produces private facts, deduplicates replay, recalls across sessions', async t => {
  const repository = fixture(t), runtime = new BookRuntime(repository, { async complete() { return '记住了。'; } });
  await runtime.chat(scope, '喜欢的茶：伯爵茶', new AbortController().signal, { turnId: 'turn-one' }); await runtime.automaticMemory!.flush();
  const book = repository.snapshot(scope); assert.equal(book.entries.length, 1); assert.equal(book.entries[0]!.fact!.quote, '喜欢的茶：伯爵茶');
  assert.equal(book.entries[0]!.pairingId, scope.pairingId); assert.equal(repository.loadCompanionData(scope).jobs[0]!.status, 'done');
  await runtime.chat(scope, '喜欢的茶：伯爵茶', new AbortController().signal, { turnId: 'turn-one' }); await runtime.automaticMemory!.flush();
  assert.equal(repository.loadCompanionData(scope).jobs.length, 1);
  const context = await runtime.inspect({ ...scope, sessionId: 'new-session' }, '喜欢的茶', new AbortController().signal);
  assert.ok(context.messages.some(message => message.content.includes('伯爵茶')));
});
test('failed extraction preserves successful chat and explicit retry succeeds once', async t => {
  const repository = fixture(t, true); let extraction = 0;
  const runtime = new BookRuntime(repository, { async complete(_b, _m, _s, options) { if (options?.purpose === 'wiki') { if (++extraction === 1) throw Error('fixture upstream failure'); return JSON.stringify({ claims: [{ subject: '用户', predicate: '茶', value: '伯爵茶', quote: '我喜欢伯爵茶' }] }); } return '好的'; } });
  await runtime.chat(scope, '我喜欢伯爵茶', new AbortController().signal); await runtime.automaticMemory!.flush();
  const job = repository.loadCompanionData(scope).jobs[0]!; assert.equal(job.status, 'failed'); assert.equal(repository.readSession(scope).length, 1);
  runtime.automaticMemory!.retry(scope, job.id); await runtime.automaticMemory!.flush(); assert.equal(repository.loadCompanionData(scope).jobs[0]!.status, 'done'); assert.equal(extraction, 2);
});
test('late cloud result after consent revocation cannot write facts', async t => {
  const repository = fixture(t, true); let release!: (text: string) => void;
  const runtime = new BookRuntime(repository, { async complete(_b, _m, _s, options) { return options?.purpose === 'wiki' ? new Promise<string>(resolve => { release = resolve; }) : '好的'; } });
  await runtime.chat(scope, '我喜欢伯爵茶', new AbortController().signal); await new Promise(resolve => setImmediate(resolve));
  const config = repository.loadConfig(); repository.commitConfig({ ...config, companion: { ...config.companion!, autoMemory: false } }, config.revision, 'revoke');
  release(JSON.stringify({ claims: [{ subject: '用户', predicate: '茶', value: '伯爵茶', quote: '我喜欢伯爵茶' }] })); await runtime.automaticMemory!.flush();
  assert.equal(repository.snapshot(scope).entries.length, 0); assert.notEqual(repository.loadCompanionData(scope).jobs[0]!.status, 'done');
});
test('contradiction awaits review; explicit correction replaces effective value', async t => {
  const repository = fixture(t, true), runtime = new BookRuntime(repository, { async complete(_b, messages, _s, options) {
    if (options?.purpose !== 'wiki') return '好的'; const text = messages.at(-1)!.content;
    return JSON.stringify({ claims: [{ subject: '用户', predicate: '茶', value: text.includes('绿茶') ? '绿茶' : '伯爵茶', quote: text, correction: text.includes('更正') }] });
  } });
  for (const text of ['我喜欢伯爵茶', '我喜欢绿茶']) { await runtime.chat(scope, text, new AbortController().signal); await runtime.automaticMemory!.flush(); }
  assert.equal(repository.loadCompanionData(scope).jobs.at(-1)!.status, 'review'); assert.equal(repository.snapshot(scope).entries.filter(e => e.enabled).length, 1);
  await runtime.chat(scope, '更正，我现在喜欢绿茶', new AbortController().signal); await runtime.automaticMemory!.flush();
  assert.deepEqual(repository.snapshot(scope).entries.filter(e => e.enabled).map(e => e.fact?.value), ['绿茶']);
});
test('forget forbids equivalent facts with changed source ID and removes recent source from Builder', async t => {
  const repository = fixture(t), runtime = new BookRuntime(repository, { async complete() { return '好的'; } });
  await runtime.chat(scope, '茶：伯爵茶', new AbortController().signal); await runtime.automaticMemory!.flush();
  const book = repository.snapshot(scope); repository.commit(scope, { remove: [book.entries[0]!.id] }, book.revision, 'forget'); runtime.invalidate(scope.characterId);
  await runtime.chat(scope, '茶：伯爵茶', new AbortController().signal); await runtime.automaticMemory!.flush();
  assert.equal(repository.snapshot(scope).entries.length, 0);
  assert.throws(() => repository.commit(scope, { upsert: [{ ...book.entries[0]!, id: 'changed-id', revision: 0 }] }, repository.snapshot(scope).revision, 'resurrect'), { code: 'conflict' });
});

test('explicit remembering grants only the new fact and source, never restores forgotten raw content', async t => {
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.chat(scope,'地址：旧地址',new AbortController().signal);await runtime.automaticMemory!.flush();
  const old=repository.snapshot(scope).entries[0]!;repository.commit(scope,{remove:[old.id]},repository.snapshot(scope).revision,'forget-address');
  assert.throws(()=>runtime.rememberNewFact(scope,{subject:'用户',predicate:'地址',value:'新地址',confirmed:false},repository.snapshot(scope).revision),{code:'invalid_input'});
  runtime.rememberNewFact(scope,{subject:'用户',predicate:'地址',value:'新地址',confirmed:true},repository.snapshot(scope).revision);
  const book=repository.snapshot(scope);assert.deepEqual(book.entries.map(entry=>entry.fact?.value),['新地址']);
  assert.ok(repository.loadCompanionData(scope).forgottenKeys.includes(`fact:${old.fact!.key}`));
  assert.throws(()=>repository.commit(scope,{upsert:[{...old,id:'old-with-new-id',revision:0}]},book.revision,'old-again'),{code:'conflict'});
  const newFact=book.entries[0]!;
  assert.throws(()=>repository.commit(scope,{upsert:[{...newFact,id:'grant-copy',revision:0}]},book.revision,'copy-grant'),{code:'conflict'});
  repository.commit(scope,{remove:[newFact.id]},book.revision,'forget-new');
  assert.throws(()=>repository.commit(scope,{upsert:[{...newFact,revision:0}]},repository.snapshot(scope).revision,'revive-grant'),{code:'conflict'});
});
test('speculative and assistant-only facts are never endorsed', async t => {
  const repository = fixture(t), runtime = new BookRuntime(repository, { async complete() { return '你喜欢咖啡。'; } });
  await runtime.chat(scope, '假如我喜欢咖啡：拿铁', new AbortController().signal); await runtime.automaticMemory!.flush(); assert.equal(repository.snapshot(scope).entries.length, 0);
});

test('mixed factual statement and a question retains only the grounded claim', async t => {
  const repository = fixture(t, true), runtime = new BookRuntime(repository, { async complete(_b, _m, _s, options) {
    return options?.purpose === 'wiki' ? JSON.stringify({ claims: [
      { subject: '用户', predicate: '面试安排', value: '明天下午三点面试', quote: '我明天下午三点面试' },
      { subject: '用户', predicate: '咖啡', value: '拿铁', quote: '我喜欢拿铁' },
    ] }) : '好的';
  } });
  await runtime.chat(scope, '我明天下午三点面试，你能记住吗？如果我喜欢拿铁呢？', new AbortController().signal);
  await runtime.automaticMemory!.flush();
  assert.deepEqual(repository.snapshot(scope).entries.map(entry => entry.fact?.value), ['明天下午三点面试']);
  assert.equal(repository.loadCompanionData(scope).events.length, 1);
});

test('conditional scope includes following clauses, but ends before a separate factual sentence', async t => {
  const repository = fixture(t, true), runtime = new BookRuntime(repository, { async complete(_b, _m, _s, options) {
    return options?.purpose === 'wiki' ? JSON.stringify({ claims: [
      { subject: '用户', predicate: '工作地', value: '上海', quote: '我在上海工作' },
      { subject: '用户', predicate: '茶', value: '伯爵茶', quote: '我喜欢伯爵茶' },
    ] }) : '好的';
  } });
  await runtime.chat(scope, '假设明年搬家，我在上海工作。我喜欢伯爵茶，你喜欢什么？', new AbortController().signal);
  await runtime.automaticMemory!.flush();
  assert.deepEqual(repository.snapshot(scope).entries.map(entry => entry.fact?.value), ['伯爵茶']);
});
test('explicit erasure removes source, turns, jobs and managed backups, refuses resurrected raw turn', async t=>{
  let calls=0;const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){calls++;return 'secret-assistant-raw';}});
  const result=await runtime.chat(scope,'茶：secret-user-raw',new AbortController().signal,{turnId:'erase-one'});await runtime.automaticMemory!.flush();
  const backup=repository.exportPrivate(scope);assert.ok(backup.text.includes('secret-user-raw'));assert.ok(!backup.text.includes('credentialId'));assert.ok(existsSync(join(repository.directory,backup.filename)));
  runtime.invalidate(scope.characterId);repository.eraseTurns(scope,['erase-one'],repository.snapshot(scope).revision);
  assert.equal(repository.readSession(scope).length,0);assert.equal(repository.snapshot(scope).entries.length,0);assert.equal(repository.snapshot(scope).wikiSources!.length,0);assert.equal(repository.loadCompanionData(scope).jobs.length,0);assert.ok(!existsSync(join(repository.directory,backup.filename)));
  for(const name of readdirSync(repository.directory).filter(name=>name.endsWith('.json')||name.endsWith('.jsonl')))assert.ok(!readFileSync(join(repository.directory,name),'utf8').includes('secret-user-raw'));
  assert.throws(()=>repository.appendTurn(scope,result.turn),{code:'conflict'});
  await assert.rejects(runtime.chat(scope,'茶：secret-user-raw',new AbortController().signal,{turnId:'erase-one'}),{code:'conflict'});assert.equal(calls,1,'erased turn retry must fail before another provider call');
});
test('retry after fact commit but before job receipt neither duplicates facts nor regenerates extraction',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的';}}),save=repository.saveCompanionData.bind(repository);let interrupted=false;
  repository.saveCompanionData=(scope,data)=>{if(!interrupted&&data.jobs.some(job=>job.status==='done')&&repository.snapshot(scope).entries.length){interrupted=true;throw Error('fixture crash after committed facts');}return save(scope,data)};
  await runtime.chat(scope,'茶：伯爵茶',new AbortController().signal);await runtime.automaticMemory!.flush();const first=repository.snapshot(scope),job=repository.loadCompanionData(scope).jobs[0]!;assert.equal(job.status,'failed');
  runtime.automaticMemory!.retry(scope,job.id);await runtime.automaticMemory!.flush();assert.equal(repository.loadCompanionData(scope).jobs[0]!.status,'done');assert.equal(repository.snapshot(scope).revision,first.revision);assert.equal(repository.snapshot(scope).entries.length,1);
});
test('invalid model quotes fail before candidate persistence or review UI can consume them',async t=>{
  const repository=fixture(t,true),runtime=new BookRuntime(repository,{async complete(_binding,_messages,_signal,options){return options?.purpose==='wiki'?JSON.stringify({claims:[{subject:'用户',predicate:'茶',value:'伯爵茶',quote:{unsupported:'object'}}]}):'好的'}});
  await runtime.chat(scope,'我喜欢伯爵茶',new AbortController().signal);await runtime.automaticMemory!.flush();const job=repository.loadCompanionData(scope).jobs[0]!;assert.equal(job.status,'failed');assert.deepEqual(job.claims,[]);assert.equal(repository.snapshot(scope).entries.length,0);
});
test('plain explicit cancellation stops an event even in local declaration mode',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.chat(scope,'面试安排：2026-10-14 下午三点面试',new AbortController().signal);await runtime.automaticMemory!.flush();assert.equal(repository.loadCompanionData(scope).events[0]!.status,'scheduled');
  await runtime.chat(scope,'面试取消了',new AbortController().signal,{turnId:'cancel-event'});await runtime.automaticMemory!.flush();assert.equal(repository.loadCompanionData(scope).events[0]!.status,'cancelled');
  repository.eraseTurns(scope,['cancel-event'],repository.snapshot(scope).revision);assert.equal(repository.loadCompanionData(scope).events.length,0);
});

test('dated cancellation targets one event and ambiguous cancellation remains reviewable', async t => {
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  for (const text of ['第一场面试：2026-10-15 下午三点 A公司面试','第二场面试：2026-10-16 下午四点 B公司面试']) {
    await runtime.chat(scope,text,new AbortController().signal);await runtime.automaticMemory!.flush();
  }
  await runtime.chat(scope,'取消我的面试',new AbortController().signal);await runtime.automaticMemory!.flush();
  assert.equal(repository.loadCompanionData(scope).events.filter(e=>e.status==='scheduled').length,2);
  const review=repository.loadCompanionData(scope).jobs.at(-1)!;
  assert.equal(review.status,'review');assert.match(review.error!,/明确|选择/);
  await runtime.chat(scope,'2026-10-15 的面试取消了',new AbortController().signal);await runtime.automaticMemory!.flush();
  const events=repository.loadCompanionData(scope).events;
  assert.equal(events.find(e=>e.date==='2026-10-15')!.status,'cancelled');
  assert.equal(events.find(e=>e.date==='2026-10-16')!.status,'scheduled');
});

test('a question, conditional or negated cancellation cannot cancel a real event', async t => {
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.chat(scope,'面试安排：2026-10-15 下午三点面试',new AbortController().signal);await runtime.automaticMemory!.flush();
  for(const text of ['如果面试取消了怎么办？','不要取消我的面试','面试取消了吗？']){
    await runtime.chat(scope,text,new AbortController().signal);await runtime.automaticMemory!.flush();
    assert.equal(repository.loadCompanionData(scope).events[0]!.status,'scheduled');
  }
});
test('ended report preserves an explicitly unknown result without inventing success',async t=>{
  const repository=fixture(t),runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.chat(scope,'A公司面试已经结束，结果还没出来',new AbortController().signal);await runtime.automaticMemory!.flush();
  const event=repository.loadCompanionData(scope).events[0]!;assert.equal(event.status,'ended');assert.equal((event as typeof event & {resultStatus?:string}).resultStatus,'unknown');
  const fact=repository.snapshot(scope).entries.find(entry=>entry.id===event.progressEntryId)!;assert.match(fact.fact!.quote,/结果还没出来/);assert.equal(repository.snapshot(scope).relationships![0]!.emotion,null);
});

test('foreground input interrupts proactive generation and keeps the single model source free',async t=>{
  const repository=fixture(t);let calls=0,active=0;
  const runtime=new BookRuntime(repository,{async complete(_b,_messages,signal){calls++;active++;assert.equal(active,1);if(calls===1)return new Promise<string>((_resolve,reject)=>{signal.addEventListener('abort',()=>{active--;reject(Error('fixture cancelled by foreground'))},{once:true})});active--;return '前台回答';}});
  const pending=runtime.proactive(scope,'准备得怎么样',new AbortController().signal),rejected=assert.rejects(pending,/fixture cancelled by foreground/);await new Promise(resolve=>setImmediate(resolve));
  const result=await runtime.chat(scope,'你好',new AbortController().signal);await rejected;assert.equal(result.turn.assistant,'前台回答');assert.equal(repository.readSession(scope).length,1);await runtime.automaticMemory!.flush();
});

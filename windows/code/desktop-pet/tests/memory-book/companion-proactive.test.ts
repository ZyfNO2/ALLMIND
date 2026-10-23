import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { DEFAULT_COMPANION_SETTINGS } from '../../contracts/book-companion.js';
import { BookProactiveScheduler, parseCompanionEvent, zonedTime } from '../../core/book-proactive.js';
import { emptyEntry, type BookScope } from '../../contracts/memory-book.js';
import { FactWikiService } from '../../memory/fact-wiki.js';
const scope:BookScope={characterId:'aika',pairingId:'local-user',sessionId:'desktop'};
const available={hidden:false,dnd:false,typing:false,recording:false,busy:false,quiet:false};

test('ongoing user report permits one evidenced progress question in the configured window without marking completion',async t=>{
  const repository=fixture(t),wiki=new FactWikiService(repository),p=wiki.preview(scope,{sourceId:'ongoing',title:'用户',text:'事件进展 event.ongoing：A公司面试正在进行',private:true});wiki.apply(scope,p.id,'source');
  const entry=repository.snapshot(scope).entries.find(entry=>entry.fact?.sourceId==='ongoing')!,data=repository.loadCompanionData(scope);data.events=[{id:'event.ongoing',entryId:entry.id,revision:entry.revision,quote:'A公司面试正在进行',timeExpression:'',timezone:'Asia/Singapore',date:null,at:null,precision:'unknown',status:'ongoing',reportedOnly:true,progressEntryId:entry.id,progressReportedAt:zonedTime('2026-10-14',10,0,'Asia/Singapore')}];repository.saveCompanionData(scope,data);
  const config=repository.loadConfig();repository.commitConfig({...config,companion:{...config.companion!,followUpHour:13}},config.revision,'window');
  let now=zonedTime('2026-10-14',10,10,'Asia/Singapore'),calls=0,prompt='';const scheduler=new BookProactiveScheduler(repository,async(_scope,text)=>{calls++;prompt=text;return '现在方便聊聊进展吗？'},()=>{},()=>now);scheduler.takeover(scope,null);
  await scheduler.tick(scope,available);assert.equal(calls,0);
  now=zonedTime('2026-10-14',13,1,'Asia/Singapore');await scheduler.tick(scope,available);await scheduler.tick(scope,available);assert.equal(calls,1);assert.match(prompt,/询问|进展/);assert.match(prompt,/不.*结束|不.*结果/);assert.equal(repository.loadCompanionData(scope).events[0]!.status,'ongoing');
  const delivery=repository.loadCompanionData(scope).deliveries[0]!;scheduler.ack(scope,delivery.id,now);await scheduler.tick(scope,available);assert.equal(calls,1);
});

test('without an explicit follow window an ongoing report stays quiet, and a missed window is not replayed',async t=>{
  const repository=fixture(t),wiki=new FactWikiService(repository),preview=wiki.preview(scope,{sourceId:'unknown-end',title:'用户',text:'事件进展 event.running：A公司面试正在进行',private:true});wiki.apply(scope,preview.id,'ongoing-evidence');
  const entry=repository.snapshot(scope).entries.find(row=>row.fact?.sourceId==='unknown-end')!,data=repository.loadCompanionData(scope);data.events=[{id:'event.running',entryId:entry.id,revision:entry.revision,quote:entry.fact!.value,timeExpression:'',timezone:'Asia/Singapore',date:null,at:null,precision:'unknown',status:'ongoing',reportedOnly:true,progressEntryId:entry.id,progressReportedAt:zonedTime('2026-10-14',10,0,'Asia/Singapore')}];repository.saveCompanionData(scope,data);
  const config=repository.loadConfig();repository.commitConfig({...config,companion:{...config.companion!,followUpHour:null}},config.revision,'no-window');
  let now=zonedTime('2026-10-14',14,5,'Asia/Singapore'),calls=0;const scheduler=new BookProactiveScheduler(repository,async()=>{calls++;return '不能生成'},()=>{},()=>now);scheduler.takeover(scope,null);await scheduler.tick(scope,available);assert.equal(calls,0);
  const next=repository.loadConfig();repository.commitConfig({...next,companion:{...next.companion!,followUpHour:13}},next.revision,'missed');now+=6*60000;await scheduler.tick(scope,available);await scheduler.tick(scope,available);assert.equal(calls,0);assert.equal(repository.loadCompanionData(scope).events[0]!.status,'ongoing');
});

test('explicit planned intervals are quiet without inventing an end or a successful result',async t=>{
  const end=parseCompanionEvent('今天下午两点到三点 A公司面试','2026-10-14T08:00:00+08:00','Asia/Singapore','interview',1)!;
  assert.equal(end.plannedEndAt,zonedTime('2026-10-14',15,0,'Asia/Singapore'));assert.equal(end.status,'scheduled');
  assert.equal(parseCompanionEvent('今天下午三点面试','2026-10-14T08:00:00+08:00','Asia/Singapore','unknown',1)!.plannedEndAt,undefined);
  assert.equal(parseCompanionEvent('今天下午三点到两点面试','2026-10-14T08:00:00+08:00','Asia/Singapore','ambiguous',1)!.plannedEndAt,undefined);
  assert.equal(parseCompanionEvent('今天晚上十一点到次日上午一点面试','2026-10-14T08:00:00+08:00','Asia/Singapore','overnight',1)!.plannedEndAt,zonedTime('2026-10-15',1,0,'Asia/Singapore'));
  const repository=fixture(t),data=repository.loadCompanionData(scope);data.events=[end];repository.saveCompanionData(scope,data);
  let now=zonedTime('2026-10-14',13,55,'Asia/Singapore'),calls=0;
  const scheduler=new BookProactiveScheduler(repository,async()=>{calls++;return '不应发生'},()=>{},()=>now);scheduler.takeover(scope,null);
  now+=6*60000;await scheduler.tick(scope,available);assert.equal(calls,0);assert.match(scheduler.reason,/事件区间/);assert.equal(repository.loadCompanionData(scope).events[0]!.status,'scheduled');
});

test('production greeting candidates honor sourced quiet preference and ground a shared experience once',async t=>{
  const quiet=fixture(t),wiki=new FactWikiService(quiet);let preview=wiki.preview(scope,{sourceId:'quiet-pref',title:'用户',text:'沟通方式：希望安静，不要主动闲聊',private:true});wiki.apply(scope,preview.id,'quiet-pref');
  let now=zonedTime('2026-10-14',8,55,'Asia/Singapore'),calls=0;
  const silent=new BookProactiveScheduler(quiet,async()=>{calls++;return '不应调用'},()=>{},()=>now);silent.takeover(scope,null);now+=6*60000;await silent.tick(scope,available);assert.equal(calls,0);
  const shared=fixture(t),sharedWiki=new FactWikiService(shared);preview=sharedWiki.preview(scope,{sourceId:'shared',title:'用户',text:'共同经历：昨天我和你一起整理桌宠项目',private:true});sharedWiki.apply(scope,preview.id,'shared');
  now=zonedTime('2026-10-14',8,55,'Asia/Singapore');const prompts:string[]=[];
  const scheduler=new BookProactiveScheduler(shared,async(_scope,prompt)=>{prompts.push(prompt);return '昨天的项目现在怎么样？'},()=>{},()=>now);scheduler.takeover(scope,null);now+=6*60000;await scheduler.tick(scope,available);
  assert.equal(prompts.length,1);assert.match(prompts[0]!,/有据共同经历/);const ledger=shared.loadCompanionData(scope);assert.equal(ledger.deliveries[0]!.basisRefs.length,1);
  const fact=shared.snapshot(scope).entries.find(entry=>entry.fact?.predicate==='共同经历')!;assert.equal(ledger.deliveries[0]!.basisRefs[0]!.id,fact.id);
  scheduler.ack(scope,ledger.deliveries[0]!.id);scheduler.responded(scope);
  now=zonedTime('2026-10-14',19,1,'Asia/Singapore');await scheduler.tick(scope,available);await scheduler.tick(scope,available);
  assert.equal(prompts.length,2);assert.ok(!prompts[1]!.includes('昨天我和你一起整理桌宠项目'),'later greetings must not keep selecting the same shared experience');
});

test('a week-later restart offers one sourced reunion within the existing focus and budget gates',async t=>{
  const repository=fixture(t),wiki=new FactWikiService(repository),preview=wiki.preview(scope,{sourceId:'reunion-source',title:'用户',text:'共同经历：我和你一起整理最初的相册',private:true});wiki.apply(scope,preview.id,'reunion-source');
  let now=zonedTime('2026-10-21',11,0,'Asia/Singapore'),calls=0;const prompts:string[]=[];
  const data=repository.loadCompanionData(scope);Object.assign(data,{lastInteractionAt:now-7*86400000,focus:true});repository.saveCompanionData(scope,data);
  const scheduler=new BookProactiveScheduler(repository,async(_scope,prompt)=>{calls++;prompts.push(prompt);return '欢迎回来，有空再聊相册。'},()=>{},()=>now);scheduler.takeover(scope,null);
  now+=6*60000;await scheduler.tick(scope,available);assert.equal(calls,0,'focus must suppress a reunion too');
  const resumed=repository.loadCompanionData(scope);resumed.focus=false;repository.saveCompanionData(scope,resumed);
  await scheduler.tick(scope,available);assert.equal(calls,1);assert.match(prompts[0]!,/重逢|回来/);assert.match(prompts[0]!,/最初的相册/);assert.match(prompts[0]!,/不.*责备|不.*催促/);
  const delivery=repository.loadCompanionData(scope).deliveries[0]!;assert.ok(delivery.basisRefs.length);assert.match(delivery.dedupKey,/^reunion:/);scheduler.ack(scope,delivery.id);
  await scheduler.tick(scope,available);assert.equal(calls,1);
  repository.close();const reopened=new FileBookRepository(repository.directory);t.after(()=>reopened.close());const restarted=new BookProactiveScheduler(reopened,async()=>{calls++;return '不应重复'},()=>{},()=>now);restarted.takeover(scope,null);now+=6*60000;await restarted.tick(scope,available);assert.equal(calls,1,'restarting must not repeat the same reunion');
  assert.equal(reopened.loadCompanionData({...scope,pairingId:'other'}).lastInteractionAt,undefined);
  reopened.close();
});

test('persistent focus gates calls, cancels late delivery, and stays separate from life and other instances',async t=>{
  const repository=fixture(t),now=zonedTime('2026-10-14',14,40,'Asia/Singapore');let calls=0,dispatched=0;
  let release!:(text:string)=>void;
  const scheduler=new BookProactiveScheduler(repository,()=>{calls++;return new Promise(resolve=>{release=resolve})},()=>{dispatched++},()=>now);scheduler.takeover(scope,null);
  const data=repository.loadCompanionData(scope);data.focus=true;repository.saveCompanionData(scope,data);
  await scheduler.tick(scope,available);assert.equal(calls,0);
  assert.equal(repository.loadCompanionData({...scope,pairingId:'other'}).focus,undefined);
  const off=repository.loadCompanionData(scope);off.focus=false;repository.saveCompanionData(scope,off);
  const pending=scheduler.tick(scope,available);assert.equal(calls,1);
  const on=repository.loadCompanionData(scope);on.focus=true;on.deliveries[0]!.status='cancelled';repository.saveCompanionData(scope,on);
  release('这条不应展示');await assert.rejects(pending,{code:'conflict'});assert.equal(dispatched,0);assert.equal(repository.loadCompanionData(scope).deliveries[0]!.status,'cancelled');
  repository.close();const reopened=new FileBookRepository(repository.directory);
  assert.equal(reopened.loadCompanionData(scope).focus,true);
  assert.equal(reopened.loadCompanionLife(scope),null,'focus must not rewrite the autonomous life owner');
  reopened.close();
});
function fixture(t:test.TestContext){mkdirSync('.local/allmind-m23/tests',{recursive:true});const directory=mkdtempSync('.local/allmind-m23/tests/proactive-'),repository=new FileBookRepository(directory);t.after(()=>{repository.close();rmSync(directory,{recursive:true,force:true})});const config=repository.loadConfig();repository.commitConfig({...config,companion:{...DEFAULT_COMPANION_SETTINGS,proactive:true,followUpHour:19}},0,'settings');const entry=emptyEntry('interview','memory','面试','明天下午三点面试');entry.pairingId=scope.pairingId;entry.origin='observed';repository.commit(scope,{upsert:[entry]},0,'event');const data=repository.loadCompanionData(scope);data.events.push(parseCompanionEvent(entry.body,'2026-10-13T12:00:00+08:00','Asia/Singapore',entry.id,1)!);repository.saveCompanionData(scope,data);return repository}

test('delayed offers are revalidated before text release without refunding quota or fabricating acknowledgements',async t=>{
  for(const gate of ['hidden','dnd','typing','busy','focus','cancel','ongoing','ended','interval','forget','expired','disabled','settings','role','valid'])await t.test(gate,async t=>{
    const repository=fixture(t);let now=zonedTime('2026-10-14',14,40,'Asia/Singapore'),calls=0;
    const scheduler=new BookProactiveScheduler(repository,async()=>{calls++;return '即将面试，准备得怎么样？'},()=>{},()=>now);scheduler.takeover(scope,null);
    await scheduler.tick(scope,available);const initial=repository.loadCompanionData(scope).deliveries[0]!;assert.equal(initial.status,'dispatched');
    const presence={...available};
    if(['hidden','dnd','typing','busy'].includes(gate))presence[gate as 'hidden'|'dnd'|'typing'|'busy']=true;
    if(['focus','cancel','ongoing','ended','interval'].includes(gate)){const data=repository.loadCompanionData(scope);if(gate==='focus')data.focus=true;else if(gate==='interval'){data.events[0]!.at=now-60000;data.events[0]!.plannedEndAt=now+60000;}else data.events[0]!.status=gate==='cancel'?'cancelled':gate as 'ongoing'|'ended';repository.saveCompanionData(scope,data);}
    if(gate==='forget'){const snapshot=repository.snapshot(scope),entry=snapshot.entries.find(row=>row.id==='interview')!;repository.commit(scope,{upsert:[{...entry,enabled:false}]},snapshot.revision,'forget-before-display');}
    if(gate==='expired')now=initial.expiresAt;
    if(gate==='disabled'||gate==='role'){const config=repository.loadConfig();repository.commitConfig({...config,...(gate==='disabled'?{companion:{...config.companion!,proactive:false}}:{characters:[...config.characters,{id:'other',name:'其他角色',intro:'',appearancePath:null}],currentCharacterId:'other'})},config.revision,'gate-config');}
    if(gate==='settings'){const config=repository.loadConfig();repository.commitConfig({...config,companion:{...config.companion!,followUpHour:null}},config.revision,'changed-follow-window');}
    const claimed=scheduler.claim(scope,initial.id,presence);
    assert.equal(!!claimed,gate==='valid');assert.equal(calls,1);assert.equal(scheduler.budget(scope,initial.reservedAt).callsToday,1);assert.equal(scheduler.budget(scope,initial.reservedAt).displaysToday,0);
    const saved=repository.loadCompanionData(scope).deliveries[0]!;assert.equal(saved.acknowledgedAt,null);
    if(gate!=='valid'){assert.equal(saved.status,'cancelled');assert.equal(saved.text,null);assert.equal(scheduler.claim(scope,initial.id,available),null,'removing a gate cannot replay a cancelled offer');}
  });
});
test('time parser retains day precision and timezone without inventing end or ambiguous AM',()=>{
  const day=parseCompanionEvent('明天面试','2026-10-13T23:00:00+08:00','Asia/Singapore','one',1)!;assert.equal(day.at,null);assert.equal(day.date,'2026-10-14');assert.equal(day.precision,'day');
  assert.equal(parseCompanionEvent('明天三点面试','2026-10-13T23:00:00+08:00','Asia/Singapore','two',1)!.at,null);
  assert.equal(parseCompanionEvent('明天下午三点面试','2026-10-13T23:00:00+08:00','Asia/Singapore','three',1)!.at,zonedTime('2026-10-14',15,0,'Asia/Singapore'));
});
test('all presence gates and disabled takeover reject before model call',async t=>{
  const repository=fixture(t);let calls=0;let now=zonedTime('2026-10-14',14,40,'Asia/Singapore');const scheduler=new BookProactiveScheduler(repository,async()=>{calls++;return '加油'},()=>{},()=>now);
  await scheduler.tick(scope,available);assert.equal(calls,0);scheduler.takeover(scope,null);
  for(const key of Object.keys(available))await scheduler.tick(scope,{...available,[key]:true});assert.equal(calls,0);
  await scheduler.tick(scope,available);assert.equal(calls,1);
});
test('reserve dispatch acknowledgement idempotence and one producer under concurrent ticks',async t=>{
  const repository=fixture(t);let calls=0,deliveries=0;const now=zonedTime('2026-10-14',14,40,'Asia/Singapore');const scheduler=new BookProactiveScheduler(repository,async()=>{calls++;await new Promise(r=>setTimeout(r,10));return '准备好了吗'},()=>{deliveries++},()=>now);scheduler.takeover(scope,null);
  await Promise.all([scheduler.tick(scope,available),scheduler.tick(scope,available)]);assert.equal(calls,1);assert.equal(deliveries,1);
  const delivery=repository.loadCompanionData(scope).deliveries[0]!;assert.equal(delivery.status,'dispatched');scheduler.ack(scope,delivery.id,now);scheduler.ack(scope,delivery.id,now);assert.equal(repository.loadCompanionData(scope).deliveries[0]!.status,'committed');assert.equal(repository.readSession(scope).length,0);
});
test('lost ack on restart keeps delivery ID and never resends',async t=>{
  const repository=fixture(t);let now=zonedTime('2026-10-14',14,40,'Asia/Singapore'),calls=0;const create=()=>new BookProactiveScheduler(repository,async()=>{calls++;return '加油'},()=>{},()=>now);
  const first=create();first.takeover(scope,null);await first.tick(scope,available);const id=repository.loadCompanionData(scope).deliveries[0]!.id;
  const second=create();second.takeover(scope,null);await second.tick(scope,available);assert.equal(calls,1);assert.equal(repository.loadCompanionData(scope).deliveries[0]!.id,id);assert.equal(repository.loadCompanionData(scope).deliveries[0]!.status,'unknown');
});
test('forget during generation invalidates late result; model failure consumes budget',async t=>{
  const repository=fixture(t);let release!:(text:string)=>void;const now=zonedTime('2026-10-14',14,40,'Asia/Singapore');let dispatched=0;const scheduler=new BookProactiveScheduler(repository,()=>new Promise(resolve=>{release=resolve}),()=>{dispatched++},()=>now);scheduler.takeover(scope,null);
  const pending=scheduler.tick(scope,available);const book=repository.snapshot(scope);repository.commit(scope,{remove:['interview']},book.revision,'forget');release('祝你面试顺利');await assert.rejects(pending,{code:'conflict'});assert.equal(dispatched,0);
  const retry=new BookProactiveScheduler(repository,async()=>{throw Error('must not call')},()=>{},()=>now);retry.takeover(scope,null);await retry.tick(scope,available);assert.equal(repository.loadCompanionData(scope).deliveries.length,1);
});
test('clock jumps skip missed greetings; shared daily quota and no-response backoff persist',async t=>{
  const repository=fixture(t);let now=zonedTime('2026-10-14',14,40,'Asia/Singapore');let calls=0;const scheduler=new BookProactiveScheduler(repository,async()=>{calls++;return '你好'},()=>{},()=>now);scheduler.takeover(scope,null);await scheduler.tick(scope,available);
  now=zonedTime('2026-10-14',19,1,'Asia/Singapore');await scheduler.tick(scope,available);assert.equal(calls,1);await scheduler.tick(scope,available);assert.equal(calls,2);
  now+=3600000;await scheduler.tick(scope,available);assert.equal(calls,2);
  now=zonedTime('2026-10-14',14,30,'Asia/Singapore');await scheduler.tick(scope,available);assert.equal(calls,2);
});
test('persisted ready is insufficient on restart; failed takeover leaves the new producer stopped',async t=>{
  const repository=fixture(t),now=zonedTime('2026-10-14',14,40,'Asia/Singapore');let calls=0;
  const first=new BookProactiveScheduler(repository,async()=>{calls++;return '你好'},()=>{},()=>now);first.takeover(scope,null,true);assert.equal(repository.loadCompanionData(scope).inheritedGreetingEnabled,true);
  const restarted=new BookProactiveScheduler(repository,async()=>{calls++;return '你好'},()=>{},()=>now);await restarted.tick(scope,available);assert.equal(calls,0);
  const save=repository.saveCompanionData.bind(repository);repository.saveCompanionData=()=>{throw Error('fixture takeover persistence failed')};assert.throws(()=>restarted.takeover(scope,null),/persistence failed/);repository.saveCompanionData=save;await restarted.tick(scope,available);assert.equal(calls,0);
});
test('quiet weekends, explicit foreign timezone and date-only follow-up window are evidence driven',async t=>{
  assert.equal(parseCompanionEvent('2026-10-14 下午三点面试，时区 Asia/Tokyo','2026-10-13T00:00:00Z','Asia/Singapore','tokyo',1)!.at,zonedTime('2026-10-14',15,0,'Asia/Tokyo'));
  const repository=fixture(t);let now=zonedTime('2026-10-17',22,5,'Asia/Singapore'),calls=0;const scheduler=new BookProactiveScheduler(repository,async()=>{calls++;return '你好'},()=>{},()=>now);scheduler.takeover(scope,null);
  await scheduler.tick(scope,available);assert.equal(calls,0);
  now=zonedTime('2026-10-18',9,1,'Asia/Singapore');await scheduler.tick(scope,available);assert.equal(calls,0,'resume skips old windows');await scheduler.tick(scope,available);assert.equal(calls,1);
});
test('crossing quiet boundary cancels late model output before display',async t=>{
  const repository=fixture(t),book=repository.snapshot(scope),entry={...book.entries[0]!,body:'2026-10-14 晚上十点十五分面试'};repository.commit(scope,{upsert:[entry]},book.revision,'late-event');
  const data=repository.loadCompanionData(scope);data.events=[parseCompanionEvent(entry.body,'2026-10-13T00:00:00Z','Asia/Singapore',entry.id,2)!];repository.saveCompanionData(scope,data);
  let now=zonedTime('2026-10-14',21,59,'Asia/Singapore'),release!:(text:string)=>void,dispatched=0;const scheduler=new BookProactiveScheduler(repository,()=>new Promise(resolve=>{release=resolve}),()=>{dispatched++},()=>now);scheduler.takeover(scope,null);
  const pending=scheduler.tick(scope,available);now=zonedTime('2026-10-14',22,0,'Asia/Singapore');await scheduler.tick(scope,available);release('加油');await assert.rejects(pending,{code:'conflict'});assert.equal(dispatched,0);
});

test('unanswered pause survives more than 72 hours and restart, resumes only on user interaction', async t => {
  const repository = fixture(t); let now = zonedTime('2026-10-14',14,40,'Asia/Singapore'), calls = 0;
  const create = () => new BookProactiveScheduler(repository,async()=>{calls++;return '你好'},()=>{},()=>now);
  const first = create(); first.takeover(scope,null); await first.tick(scope,available);
  first.ack(scope,repository.loadCompanionData(scope).deliveries.at(-1)!.id);
  now = zonedTime('2026-10-14',19,1,'Asia/Singapore'); await first.tick(scope,available); await first.tick(scope,available);
  first.ack(scope,repository.loadCompanionData(scope).deliveries.at(-1)!.id);
  assert.equal(calls,2);
  now = zonedTime('2026-10-19',9,1,'Asia/Singapore'); const restarted = create(); restarted.takeover(scope,null);
  now += 300000; await restarted.tick(scope,available); await restarted.tick(scope,available);
  assert.equal(calls,2,'wall-clock aging must not resume unsolicited contacts');
  restarted.responded(scope); await restarted.tick(scope,available); assert.equal(calls,3);
});

test('generation failure consumes call budget while successful display has independent accounting', async t => {
  const repository = fixture(t); let now = zonedTime('2026-10-14',14,40,'Asia/Singapore');
  const scheduler = new BookProactiveScheduler(repository,async()=>{throw Error('fixture generation failure')},()=>{},()=>now);
  scheduler.takeover(scope,null); await assert.rejects(scheduler.tick(scope,available),/fixture generation failure/);
  const data = repository.loadCompanionData(scope); assert.equal(data.deliveries[0]!.status,'failed');
  const metrics = scheduler.budget(scope,now);
  assert.equal(metrics.callsToday,1); assert.equal(metrics.displaysToday,0); assert.equal(metrics.unknownDisplays,0);
});


test('frequency settings preserve legacy defaults, persist and reject invalid values without a revision change',t=>{
  const repository=fixture(t),config=repository.loadConfig();
  const legacy={...config.companion!};delete legacy.dailyLimit;delete legacy.minimumIntervalMinutes;
  repository.commitConfig({...config,companion:legacy},config.revision,'legacy-frequency');
  const next=repository.loadConfig();
  for(const [field,values] of [['dailyLimit',[null,0,7,1.5,'2']],['minimumIntervalMinutes',[null,29,1441,30.5,'180']]] as const){
    for(const value of values){assert.throws(()=>repository.commitConfig({...next,companion:{...next.companion!,[field]:value}},next.revision,'invalid-frequency-'+field+String(value)),{code:'invalid_input'});assert.equal(repository.loadConfig().revision,next.revision);}
  }
  repository.commitConfig({...next,companion:{...legacy,dailyLimit:4,minimumIntervalMinutes:45}},next.revision,'custom-frequency');
  repository.close();const reopened=new FileBookRepository(repository.directory);
  try{assert.equal(reopened.loadConfig().companion!.dailyLimit,4);assert.equal(reopened.loadConfig().companion!.minimumIntervalMinutes,45);}finally{reopened.close();}
});

test('frequency drives actual reservations while retaining failure, rolling-day, busy and unanswered gates',async t=>{
  for(const variant of ['legacy','shorter','lower-limit','higher-limit','rolling','unanswered','busy'])await t.test(variant,async t=>{
    const repository=fixture(t),config=repository.loadConfig(),settings={...config.companion!};
    delete settings.dailyLimit;delete settings.minimumIntervalMinutes;
    if(variant!=='legacy'){settings.minimumIntervalMinutes=30;settings.dailyLimit=variant==='lower-limit'||variant==='rolling'?1:6;}
    repository.commitConfig({...config,companion:settings},config.revision,'frequency');
    const now=zonedTime('2026-10-14',14,40,'Asia/Singapore'),data=repository.loadCompanionData(scope),count=variant==='higher-limit'||variant==='unanswered'?2:1;
    for(let i=0;i<count;i++){
      const at=now-(variant==='rolling'?18*3600000:3600000)-i*3600000;
      data.deliveries.push({id:'prior-'+i,dedupKey:'prior-'+i,basisRefs:[],reason:'prior fixture attempt',day:variant==='rolling'?'2026-10-13':'2026-10-14',timezone:'Asia/Singapore',reservedAt:at,expiresAt:at+120000,status:variant==='unanswered'?'committed':'failed',text:null,error:null,acknowledgedAt:variant==='unanswered'?at:null,respondedAt:null});
    }
    repository.saveCompanionData(scope,data);let calls=0;
    const scheduler=new BookProactiveScheduler(repository,async()=>{calls++;return '面试前，愿意聊聊准备情况吗？'},()=>{},()=>now);scheduler.takeover(scope,null);
    await scheduler.tick(scope,{...available,busy:variant==='busy'});
    const allowed=variant==='shorter'||variant==='higher-limit';assert.equal(calls,allowed?1:0,variant);assert.equal(repository.loadCompanionData(scope).deliveries.length,count+(allowed?1:0));
    if(variant==='legacy')assert.match(scheduler.reason,/180 分钟/);
    if(variant==='lower-limit'||variant==='rolling')assert.match(scheduler.reason,/调用预算/);
    if(variant==='unanswered')assert.match(scheduler.reason,/未回应暂停/);
    if(allowed){const id=repository.loadCompanionData(scope).deliveries.at(-1)!.id;assert.ok(scheduler.claim(scope,id,available,now));const current=repository.loadConfig();repository.commitConfig({...current,companion:{...settings,dailyLimit:1}},current.revision,'lower-after-reserve');assert.equal(scheduler.claim(scope,id,available,now),null,'a saved frequency change invalidates pending offers');assert.equal(repository.loadCompanionData(scope).deliveries.length,count+1,'frequency edit does not refund attempts');}
  });
});

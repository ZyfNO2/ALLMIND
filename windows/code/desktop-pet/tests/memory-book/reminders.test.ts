import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {saveReminder,deleteReminder,reminderOccurrence} from '../../core/book-reminders.js';
import {BookProactiveScheduler,zonedTime} from '../../core/book-proactive.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../contracts/book-companion.js';
import type {CompanionReminder,ReminderInput} from '../../contracts/book-reminders.js';
const scope={characterId:'aika',pairingId:'local-user',sessionId:'desktop'},available={hidden:false,dnd:false,typing:false,recording:false,busy:false,quiet:false};
const at=(date:string,hour=9,minute=0,zone='Asia/Singapore')=>zonedTime(date,hour,minute,zone);
const draft=(schedule:ReminderInput['schedule']={kind:'interval',minutes:60}):ReminderInput=>({id:'drink-water',title:'喝水',enabled:true,timezone:'Asia/Singapore',schedule});
function fixture(t:test.TestContext){mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/reminders-'));t.after(()=>{repository.close();rmSync(repository.directory,{recursive:true,force:true})});const config=repository.loadConfig();repository.commitConfig({...config,companion:{...DEFAULT_COMPANION_SETTINGS,proactive:true}},config.revision,'settings');return repository}
function reminder(schedule:ReminderInput['schedule']):CompanionReminder{return {...draft(schedule),revision:1,createdAt:at('2024-01-01',8),updatedAt:at('2024-01-01',8),schedule:schedule.kind==='interval'?{...schedule,anchorAt:at('2026-10-16',8)}:schedule}}

test('reminder editing is private, revision checked, idempotent and durable; deleted IDs cannot resurrect',t=>{
 const repository=fixture(t),now=at('2026-10-16',8),first=saveReminder(repository,scope,draft(),0,now);assert.equal(first.reminders![0]!.schedule.kind,'interval');assert.deepEqual(saveReminder(repository,scope,draft(),0,now+1000),first);
 const next=saveReminder(repository,scope,{...draft(),title:'定时活动'},1,now+60000);assert.equal(next.reminders![0]!.revision,2);assert.equal((next.reminders![0]!.schedule as {anchorAt:number}).anchorAt,now+60000);
 assert.throws(()=>saveReminder(repository,scope,{...draft(),title:'旧草稿'},1,now+60001),{code:'conflict'});assert.equal(repository.loadCompanionData({...scope,pairingId:'other'}).reminders,undefined);
 repository.close();const reopened=new FileBookRepository(repository.directory);try{assert.equal(reopened.loadCompanionData(scope).reminders![0]!.title,'定时活动');
 const removed=deleteReminder(reopened,scope,draft().id,2);assert.equal(removed.reminders!.length,0);assert.deepEqual(deleteReminder(reopened,scope,draft().id,2),removed);assert.throws(()=>saveReminder(reopened,scope,draft(),0,now+120000),{code:'conflict'});assert.equal(reopened.snapshot(scope).entries.length,0);
 }finally{reopened.close()}
});
test('invalid plans fail before saving and have explicit bounded capacity',t=>{
 const repository=fixture(t),now=at('2026-10-16',8);
 for(const value of [{...draft(),timezone:'not/a-zone'},{...draft(),title:''},draft({kind:'interval',minutes:0}),draft({kind:'daily',time:'25:00'}),draft({kind:'anniversary',date:'2026-02-30',time:'09:00',leapDay:'skip'})])assert.throws(()=>saveReminder(repository,scope,value,0,now),{code:'invalid_input'});
 assert.equal(repository.loadCompanionData(scope).reminders,undefined);
 for(let i=0;i<64;i++)saveReminder(repository,scope,{...draft(),id:'plan-'+i},0,now);assert.throws(()=>saveReminder(repository,scope,draft(),0,now),{code:'budget'});
});
test('interval and daily reminders select only current occurrence, with no missed-window catchup or startup replay',()=>{
 const interval=reminder({kind:'interval',minutes:60}),nine=at('2026-10-16');assert.equal(reminderOccurrence(interval,nine+1000,nine-60000)!.at,nine);assert.equal(reminderOccurrence(interval,nine+120000,0),null);assert.equal(reminderOccurrence(interval,nine+1000,nine+1),null);
 const daily=reminder({kind:'daily',time:'09:00'});assert.equal(reminderOccurrence(daily,nine+1000,0)!.at,nine);assert.equal(reminderOccurrence(daily,at('2026-10-16',8,59),0),null);
 assert.equal(reminderOccurrence({...daily,updatedAt:nine+100},nine+1000,0),null,'new edits never replay a due time before the edit');
 assert.equal(reminderOccurrence({...daily,timezone:'America/New_York'},nine+1000,0),null,'each plan uses its explicit timezone');
});
test('anniversaries honor first date, leap choice and DST nonexistent/repeated local times',()=>{
 const leap=reminder({kind:'anniversary',date:'2024-02-29',time:'09:00',leapDay:'skip'});assert.equal(reminderOccurrence(leap,at('2027-02-28'),0),null);assert.ok(reminderOccurrence(leap,at('2028-02-29'),0));
 assert.ok(reminderOccurrence({...leap,schedule:{...leap.schedule as {kind:'anniversary';date:string;time:string;leapDay:'skip'},leapDay:'feb28'}},at('2027-02-28'),0));assert.equal(reminderOccurrence(leap,at('2023-02-28'),0),null);
 const ny={...reminder({kind:'daily',time:'02:30'}),timezone:'America/New_York'};assert.equal(reminderOccurrence(ny,Date.parse('2026-03-08T07:30:00Z'),0),null);
 const fold={...ny,schedule:{kind:'daily' as const,time:'01:30'}};assert.equal(['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'].filter(time=>reminderOccurrence(fold,Date.parse(time),0)).length,1);
});
test('reminder candidate uses the one scheduler, real claims and shared cooldown/quota, never a fake saved conversation',async t=>{
 const repository=fixture(t);let now=at('2026-10-16',8),calls=0,dispatches=0,prompt='';saveReminder(repository,scope,draft(),0,now);
 const scheduler=new BookProactiveScheduler(repository,async(_scope,text)=>{calls++;prompt=text;return '到喝水的提醒时间了。'},()=>{dispatches++},()=>now);scheduler.takeover(scope,null);
 now=at('2026-10-16');await scheduler.tick(scope,available);const delivery=repository.loadCompanionData(scope).deliveries[0]!;assert.equal(calls,1);assert.equal(dispatches,1);assert.equal(delivery.reminderRef!.id,draft().id);assert.match(prompt,/用户显式设置/);assert.match(prompt,/不.*久坐/);assert.equal(scheduler.claim(scope,delivery.id,available)!.text,'到喝水的提醒时间了。');scheduler.ack(scope,delivery.id);
 now=at('2026-10-16',10);await scheduler.tick(scope,available);await scheduler.tick(scope,available);assert.equal(calls,1,'hourly candidate cannot bypass shared three-hour cooldown');
 now=at('2026-10-16',12);await scheduler.tick(scope,available);await scheduler.tick(scope,available);assert.equal(calls,2);scheduler.ack(scope,repository.loadCompanionData(scope).deliveries.at(-1)!.id);
 now=at('2026-10-16',15);await scheduler.tick(scope,available);await scheduler.tick(scope,available);assert.equal(calls,2);assert.equal(scheduler.budget(scope).callsToday,2);assert.equal(repository.readSession(scope).length,0);
});
test('editing or deleting during generation invalidates late model text and retains the consumed attempt',async t=>{
 for(const action of ['disable','delete'])await t.test(action,async t=>{
  const repository=fixture(t);let now=at('2026-10-16',8),release!:(text:string)=>void;saveReminder(repository,scope,draft(),0,now);
  const scheduler=new BookProactiveScheduler(repository,()=>new Promise(resolve=>{release=resolve}),()=>assert.fail('must not dispatch'),()=>now);scheduler.takeover(scope,null);now=at('2026-10-16');const pending=scheduler.tick(scope,available);
  if(action==='delete')deleteReminder(repository,scope,draft().id,1);else saveReminder(repository,scope,{...draft(),enabled:false},1,now);
  release('迟到内容');await assert.rejects(pending,{code:'conflict'});assert.equal(scheduler.budget(scope).callsToday,1);assert.equal(scheduler.budget(scope).displaysToday,0);assert.equal(repository.loadCompanionData(scope).deliveries[0]!.status,'cancelled');
 });
});
test('queued reminder cannot be claimed after revision change and restarting cannot replay it',async t=>{
 const repository=fixture(t);let now=at('2026-10-16',8),calls=0;saveReminder(repository,scope,draft(),0,now);const create=()=>new BookProactiveScheduler(repository,async()=>{calls++;return '到点提醒'},()=>{},()=>now),scheduler=create();scheduler.takeover(scope,null);now=at('2026-10-16');await scheduler.tick(scope,available);const id=repository.loadCompanionData(scope).deliveries[0]!.id;
 saveReminder(repository,scope,{...draft(),title:'新标题'},1,now+1);assert.equal(scheduler.claim(scope,id,available),null);now+=1000;const restarted=create();restarted.takeover(scope,null);await restarted.tick(scope,available);assert.equal(calls,1);assert.equal(repository.loadCompanionData(scope).deliveries[0]!.text,null);
});

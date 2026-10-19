import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,appendFileSync} from 'node:fs';
const fixtureRoot='.local/book-activity-tests';mkdirSync(fixtureRoot,{recursive:true});
import {join} from 'node:path';
import {BookActivity,activityBin} from '../../core/book-activity.js';
import type {CollectionHelperClientOptions,HelperEvent} from '../../core/collection-helper-client.js';

const event=(start:number,end:number,count=5):HelperEvent=>({kind:'keyboard',op:'activity',requestId:'r',grantRevision:1,payload:{bucketStart:new Date(start).toISOString(),bucketEnd:new Date(end).toISOString(),activityCount:count,foregroundAppId:null,countingPolicy:'keydown-repeat-v2'}});
test('coverage, timestamps and private payloads are validated',()=>{
  assert.equal(activityBin('a',Date.parse('2026-10-15T16:00:00Z'),Date.parse('2026-10-15T16:00:10Z'),3,-480,'Asia/Singapore').day,'2026-10-16');
  assert.throws(()=>activityBin('a',100,20000,0,0,'UTC'));
  assert.throws(()=>activityBin('../a',100,200,0,0,'UTC'));
  assert.throws(()=>activityBin('a',100,200,-1,0,'UTC'));
});
test('opt-in, scope changes, deduplication, deletion and restart share one durable owner',async t=>{
  const directory=mkdtempSync(join(fixtureRoot,'book-activity-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let now=Date.parse('2026-10-15T08:00:10Z'),starts=0,closes=0,callback:CollectionHelperClientOptions|undefined;
  const factory=(options:CollectionHelperClientOptions)=>{callback=options;return {start(){starts++},async startKeyboard(){},async close(){closes++}}};
  const activity=new BookActivity(directory,'.',()=>{},()=>{},()=>now,factory);
  await activity.select('a');assert.equal(starts,0);assert.equal(activity.view('a').state,'disabled');
  await activity.enable('a',true);assert.equal(starts,1);assert.equal(activity.view('a').state,'active');
  activity.ingest('a',event(now-10000,now));activity.ingest('a',event(now-10000,now));
  assert.equal(activity.view('a').days[0]?.count,5);assert.equal(activity.view('a').days[0]?.coveredMs,10000);
  now+=10000;activity.ingest('a',event(now-10000,now,0));assert.equal(activity.view('a').days[0]?.coveredMs,20000);
  assert.deepEqual(activity.view('a').habitSlots,[]);
  const stale=callback!;await activity.select('b');stale.onEvent(event(now,now+10000));assert.equal(activity.view('b').days.length,0);assert.equal(activity.view('b').enabled,false);
  await activity.select('a');const day=activity.view('a').days[0]!.day;await activity.remove('a',day);assert.equal(activity.view('a').days.length,0);
  await activity.close();assert.ok(closes>=2);
  const restored=new BookActivity(directory,'.',()=>{},()=>{},()=>now,factory);
  await restored.select('a');assert.equal(restored.view('a').days.length,0);
  assert.throws(()=>restored.ingest('a',{...event(now,now+1000),payload:{...event(now,now+1000).payload,foregroundAppId:'private.exe'}}));
  await restored.close();
});
test('crash recovery projects pending journal once; deleted sources never revive',async t=>{
  const directory=mkdtempSync(join(fixtureRoot,'book-activity-crash-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const now=Date.parse('2026-10-15T08:00:10Z'),raw={start:now-10000,end:now,count:20,offset:new Date(now).getTimezoneOffset(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
  const day=activityBin('a',raw.start,raw.end,raw.count,raw.offset,raw.timezone).day;
  const activity=new BookActivity(directory,'.',()=>{},()=>{},()=>now);
  await activity.close();appendFileSync(join(directory,`raw.a.${day}.jsonl`),JSON.stringify(raw)+'\n');
  const recovered=new BookActivity(directory,'.',()=>{},()=>{},()=>now);
  assert.equal(recovered.view('a').days[0]?.count,20);await recovered.close();
  const again=new BookActivity(directory,'.',()=>{},()=>{},()=>now);assert.equal(again.view('a').days[0]?.count,20);await again.close();
  const saved=JSON.parse(readFileSync(join(directory,'activity.json'),'utf8'));saved.deletedBefore.a=now+1;saved.rows=[];writeFileSync(join(directory,'activity.json'),JSON.stringify(saved));
  const deleted=new BookActivity(directory,'.',()=>{},()=>{},()=>now);assert.equal(deleted.view('a').days.length,0);await deleted.close();
});
test('raw samples expire at seven days, derived bins at thirty days',async t=>{
  const directory=mkdtempSync(join(fixtureRoot,'book-activity-expiry-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const now=Date.parse('2026-10-15T08:00:10Z'),old=now-8*86400000,day=new Date(old).toISOString().slice(0,10);
  writeFileSync(join(directory,`raw.a.${day}.jsonl`),JSON.stringify({start:old-10000,end:old,count:5,offset:0,timezone:'UTC'})+'\n');
  const rows=[8,31].map(age=>activityBin('a',now-age*86400000-10000,now-age*86400000,5,0,'UTC'));
  writeFileSync(join(directory,'activity.json'),JSON.stringify({version:1,consents:[],rows,lastEnds:{},deletedBefore:{}}));
  const a=new BookActivity(directory,'.',()=>{},()=>{},()=>now);assert.ok(!readdirSync(directory).some(file=>file.endsWith('.jsonl')));assert.equal(a.view('a').days.length,1);await a.close();
});
test('habits require three covered comparable days; gaps never become zero activity',async t=>{
  const directory=mkdtempSync(join(fixtureRoot,'book-activity-habit-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const now=Date.parse('2026-10-15T08:10:00Z'),offset=new Date(now).getTimezoneOffset(),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows=[0,1,2].map(age=>({...activityBin('a',now-age*86400000-10000,now-age*86400000,60,offset,timezone),coveredMs:300000}));
  const write=(values:typeof rows)=>writeFileSync(join(directory,'activity.json'),JSON.stringify({version:1,consents:['a'],rows:values,lastEnds:{},deletedBefore:{}}));
  const source=()=>({start(){},async startKeyboard(){},async close(){}});
  write(rows);const known=new BookActivity(directory,'.',()=>{},()=>{},()=>now,source);await known.select('a');assert.equal(known.view('a').sampleDays,3);assert.deepEqual(known.view('a').habitSlots,[rows[0]!.slot]);assert.equal(known.view('a').quietCompanion,true);await known.close();
  write(rows.map(row=>({...row,coveredMs:60000})));const insufficient=new BookActivity(directory,'.',()=>{},()=>{},()=>now,source);assert.deepEqual(insufficient.view('a').habitSlots,[]);assert.equal(insufficient.view('a').days.length,3);await insufficient.close();
  write(rows.slice(0,2));const missing=new BookActivity(directory,'.',()=>{},()=>{},()=>now,source);assert.deepEqual(missing.view('a').habitSlots,[]);assert.equal(missing.view('b').days.length,0);await missing.close();
});
test('a malformed source stops observation and retains its visible first error',async t=>{
  const directory=mkdtempSync(join(fixtureRoot,'book-activity-error-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let callback,closes=0;const now=Date.now();
  const activity=new BookActivity(directory,'.',()=>{},()=>{},()=>now,options=>{callback=options;return {start(){},async startKeyboard(){},async close(){closes++}}});
  await activity.select('a');await activity.enable('a',true);
  (callback! as CollectionHelperClientOptions).onEvent(event(now-10000,now,-1));
  assert.equal(activity.view('a').state,'unavailable');assert.match(activity.view('a').error!,/Invalid keyboard/);assert.equal(closes,1);
  assert.equal(activity.view('a').days.length,0);await activity.close();
});

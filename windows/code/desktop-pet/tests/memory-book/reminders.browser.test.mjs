import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {saveReminder} from '../../dist/core/book-reminders.js';

test('actual reminder UI creates annual and interval plans, retains conflicted draft, toggles and confirms deletion',{timeout:45000},async t=>{
 mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(resolve(mkdtempSync('.local/ui-v4/tests/reminders-ui-'))),scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'};
 const runtime=new BookRuntime(repository,{async complete(){throw Error('Reminder configuration must never call a model')}}),server=await startBookServer({runtime,credentials:new BookCredentials(join(repository.directory,'credentials')),uiRoot:resolve('management')}),browser=await chromium.launch({headless:true});
 t.after(async()=>{await browser.close();await server.close();repository.close()});const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(server.url);await page.getByRole('link',{name:'陪伴',exact:true}).click();
 const region=page.getByRole('region',{name:'提醒与纪念日',exact:true});await region.getByText('尚未设置提醒或纪念日。',{exact:true}).waitFor();
 await region.getByText('新建提醒或纪念日',{exact:true}).click();await region.getByLabel('提醒名称',{exact:true}).fill('喝水');await region.getByLabel('间隔分钟',{exact:true}).fill('60');await region.getByRole('button',{name:'添加提醒',exact:true}).click();await region.getByRole('button',{name:'编辑 喝水',exact:true}).waitFor();
 let stored=repository.loadCompanionData(scope);assert.equal(stored.reminders.length,1);const initial=stored.reminders[0];assert.equal(initial.schedule.minutes,60);assert.equal(initial.enabled,true);assert.equal(repository.readSession(scope).length,0);
 await region.getByRole('button',{name:'编辑 喝水',exact:true}).click();await region.getByLabel('提醒名称',{exact:true}).fill('保留这份草稿');saveReminder(repository,scope,{id:initial.id,title:'外部更改',enabled:true,timezone:initial.timezone,schedule:{kind:'interval',minutes:50}},initial.revision);
 await region.getByRole('button',{name:'保存提醒更改',exact:true}).click();await region.getByRole('alert').waitFor();assert.equal(await region.getByLabel('提醒名称',{exact:true}).inputValue(),'保留这份草稿');assert.equal(repository.loadCompanionData(scope).reminders[0].title,'外部更改');
 await region.getByRole('button',{name:'放弃提醒草稿',exact:true}).click();await region.getByRole('button',{name:'编辑 外部更改',exact:true}).waitFor();
  // Keep the real API/owner; delay the response to expose controlled-checkbox reset.
  await page.route('**/api/memory-book/v1/companion/reminders',async route=>{if(route.request().method()==='POST')await new Promise(done=>setTimeout(done,350));await route.continue()});
  const toggled=page.waitForResponse(response=>response.url().includes('/companion/reminders')&&response.request().method()==='POST');
  await region.getByLabel('启用提醒 外部更改',{exact:true}).uncheck();
  assert.equal((await toggled).status(),200);
  await page.waitForFunction(()=>!document.querySelector('[aria-label="启用提醒 外部更改"]').checked);assert.equal(repository.loadCompanionData(scope).reminders[0].enabled,false);
 await region.getByRole('button',{name:'删除 外部更改',exact:true}).click();assert.equal(repository.loadCompanionData(scope).reminders.length,1);await region.getByRole('button',{name:'确认删除提醒',exact:true}).click();await region.getByText('尚未设置提醒或纪念日。',{exact:true}).waitFor();
 await region.getByText('新建提醒或纪念日',{exact:true}).click();await region.getByLabel('提醒名称',{exact:true}).fill('第一次发布');await region.getByLabel('提醒周期',{exact:true}).selectOption('anniversary');await region.getByLabel('纪念日期',{exact:true}).fill('2024-02-29');await region.getByLabel('当地提醒时刻',{exact:true}).fill('10:30');await region.getByLabel('闰日规则',{exact:true}).selectOption('feb28');await region.getByRole('button',{name:'添加提醒',exact:true}).click();await region.getByRole('button',{name:'编辑 第一次发布',exact:true}).waitFor();
 stored=repository.loadCompanionData(scope);assert.deepEqual(stored.reminders[0].schedule,{kind:'anniversary',date:'2024-02-29',time:'10:30',leapDay:'feb28'});assert.equal(stored.retiredReminderIds[0],initial.id);assert.equal(repository.loadCompanionData({...scope,pairingId:'other'}).reminders,undefined);assert.deepEqual(errors,[]);
});

test('reminder API requires auth, explicit confirmation and current row revision, without leaking other instances',async t=>{
 mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(resolve(mkdtempSync('.local/ui-v4/tests/reminders-http-'))),runtime=new BookRuntime(repository,{async complete(){throw Error('must not send')}}),server=await startBookServer({runtime,credentials:new BookCredentials(join(repository.directory,'credentials')),uiRoot:resolve('management')});t.after(async()=>{await server.close();repository.close()});
 const url=new URL(server.url),endpoint=url.origin+'/api/memory-book/v1/companion/reminders',headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'},body={characterId:'aika',sessionId:'desktop',expectedReminderRevision:0,confirmed:true,reminder:{id:'daily',title:'每日活动',enabled:true,timezone:'Asia/Singapore',schedule:{kind:'daily',time:'10:30'}}},send=(data,method='POST')=>fetch(endpoint,{method,headers,body:JSON.stringify(data)});
 assert.equal((await fetch(endpoint,{method:'POST',body:JSON.stringify(body)})).status,401);assert.equal((await send({...body,confirmed:false})).status,400);assert.equal((await send(body)).status,200);assert.equal((await send(body)).status,200,'same committed create is idempotent');
 const response=await send({...body,reminder:{...body.reminder,title:'stale change'}});assert.equal(response.status,409);assert.equal((await send({characterId:'aika',sessionId:'desktop',id:'daily',expectedReminderRevision:0},'DELETE')).status,400);
 const foreign=await fetch(url.origin+'/api/memory-book/v1/companion?characterId=aika&pairingId=other&sessionId=desktop',{headers});assert.equal((await foreign.json()).reminders,undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { chromium } from '@playwright/test';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { BookRuntime } from '../../dist/app/book-runtime.js';
import { BookCredentials } from '../../dist/management/book-credentials.js';
import { startBookServer } from '../../dist/management/book-server.js';
import { DEFAULT_COMPANION_SETTINGS } from '../../dist/contracts/book-companion.js';
import { zonedParts } from '../../dist/core/book-proactive.js';
import { FactWikiService } from '../../dist/memory/fact-wiki.js';

test('event timeline UI distinguishes planned interval from explicit sourced progress reports', {timeout:45000},async t=>{
  mkdirSync('.local/allmind-m4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m4/tests/events-ui-')),repository=new FileBookRepository(directory);
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9999/v1',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},0,'config');
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'},runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  for(const [id,text] of [['plan','面试：明天下午两点到三点 A公司面试'],['start','A公司面试正在进行'],['end','A公司面试已经结束，通过了']]){await runtime.chat(scope,text,new AbortController().signal,{turnId:id});await runtime.automaticMemory.flush();}
  await runtime.chat(scope,'昨天上午九点 B公司面试已经结束，通过了',new AbortController().signal,{turnId:'past-only'});await runtime.automaticMemory.flush();
  await runtime.chat(scope,'C公司面试已经结束，结果还没出来',new AbortController().signal,{turnId:'unknown-result'});await runtime.automaticMemory.flush();
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});let browser;
  t.after(async()=>{await browser?.close();await server.close();repository.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);await page.getByRole('link',{name:'陪伴',exact:true}).click();await page.getByText('日程进展与主动记录',{exact:true}).click();await page.getByText('事件时间线与报告来源',{exact:true}).click();
  const timeline=page.getByText('事件时间线与报告来源',{exact:true}).locator('..');
  assert.deepEqual(await timeline.locator('blockquote').allTextContents(),['A公司面试正在进行','A公司面试已经结束，通过了','昨天上午九点 B公司面试已经结束，通过了','C公司面试已经结束，结果还没出来']);
  assert.match(await timeline.textContent(),/结果：未知，结束不等于通过或失败/);
  assert.match(await timeline.textContent(),/没有先前安排，不从报告补造计划时间/);assert.match(await timeline.textContent(),/用户报告的发生时间/);assert.match(await timeline.textContent(),/精度 minute/);
  assert.match(await timeline.textContent(),/计划时间不证明事件实际发生或结束/);assert.match(await timeline.textContent(),/历史报告不替代当前状态/);
  const event=repository.loadCompanionData(scope).events[0];assert.equal(event.status,'ended');assert.ok(event.plannedEndAt>event.at);assert.equal(event.reportedTimeline.length,2);assert.deepEqual(errors,[]);
});

test('relationship UI shows sourced preferences and revokes their real Context influence', {timeout:45000},async t=>{
  mkdirSync('.local/allmind-m4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m4/tests/relationship-ui-')),repository=new FileBookRepository(directory);
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'},wiki=new FactWikiService(repository);
  const preview=wiki.preview(scope,{sourceId:'communication',title:'用户',text:'回复长度：希望简短些\n信任反馈：你记对了',private:true});wiki.apply(scope,preview.id,'seed');
  const runtime=new BookRuntime(repository,{async complete(){throw Error('Inspector remains local')}}),server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});let browser;
  t.after(async()=>{await browser?.close();await server.close();repository.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);await page.getByRole('link',{name:'角色',exact:true}).click();await page.getByText(/关系与相处依据 · r/).click();
  await page.getByText('沟通偏好：回复长度 · 希望简短些',{exact:true}).waitFor();await page.getByText(/信任 55\/100/).waitFor();
  await page.getByText('查看关系来源并撤销',{exact:true}).click();
  const before=await runtime.inspect(scope,'你好',new AbortController().signal);assert.ok(JSON.stringify(before.messages).includes('希望简短些'));
  const erased=page.waitForResponse(response=>response.url().endsWith('/entries')&&response.request().method()==='DELETE');
  await page.getByText('用户的回复长度：希望简短些',{exact:true}).locator('..').getByRole('button',{name:'撤销此关系依据',exact:true}).click();assert.equal((await erased).status(),200);
  await page.getByText('沟通偏好：回复长度 · 希望简短些',{exact:true}).waitFor({state:'detached'});
  const after=await runtime.inspect({...scope,sessionId:'fresh'},'你好',new AbortController().signal);assert.ok(!JSON.stringify(after.messages).includes('希望简短些'));assert.equal(repository.snapshot(scope).relationships[0].preferences.length,0);assert.deepEqual(errors,[]);
});
test('production management UI saves consent, displays automatic ledger, downloads private backup and explicitly erases original', {timeout:45000},async t=>{
  mkdirSync('.local/allmind-m23/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m23/tests/ui-')),repository=new FileBookRepository(directory);
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9999/v1',credentialId:'local-no-auth',model:'fixture',inputTokens:8192,outputTokens:1024}},0,'fixture');
  const runtime=new BookRuntime(repository,{async complete(){return '好的，已收到。';}}),server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});let browser;
  t.after(async()=>{await browser?.close();await runtime.automaticMemory?.flush();await server.close();repository.close();});browser=await chromium.launch({headless:true});const page=await browser.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByLabel('自动记忆',{exact:true}).check();await page.getByLabel('主动问候与事件跟进',{exact:true}).check();await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('当前配置已保存'));
  assert.equal(repository.loadConfig().companion.autoMemory,true);assert.equal(repository.loadConfig().companion.proactive,true);assert.equal(repository.loadConfig().companion.cloudMemoryConsent,false);
  await page.getByRole('link',{name:'首页',exact:true}).click();await page.getByLabel('聊天消息').fill('茶：伯爵茶');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('好的，已收到。',{exact:true}).waitFor();await runtime.automaticMemory.flush();
  await page.getByRole('link',{name:'记忆',exact:true}).click();await page.getByRole('button',{name:'入库队列',exact:true}).click();await page.getByRole('heading',{name:'记忆整理队列',exact:true}).waitFor();await page.getByText('更多管理工具',{exact:true}).click();assert.match(await page.locator('main').textContent(),/done/);
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'导出本实例私有备份',exact:true}).click();const download=await downloading;assert.match(download.suggestedFilename(),/^private-backup-/);
  await page.getByText('清除最近一轮原文',{exact:true}).click();const erase=page.getByRole('button',{name:'执行所选原文清除',exact:true});assert.equal(await erase.isEnabled(),false);await page.getByLabel('明确清除这一轮原文和本实例应用备份',{exact:true}).check();const responseWait=page.waitForResponse(response=>response.url().includes('/memory/erase')&&response.request().method()==='POST');const navigation=page.waitForEvent('framenavigated',frame=>frame===page.mainFrame());await erase.click();const erasedResponse=await responseWait;assert.equal(erasedResponse.status(),200);await navigation;
  await page.getByRole('button',{name:'入库队列',exact:true}).click();await page.getByRole('heading',{name:'记忆整理队列',exact:true}).waitFor();await page.getByText('更多管理工具',{exact:true}).click();const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'};assert.equal(repository.readSession(scope).length,0);assert.equal(repository.snapshot(scope).entries.length,0);assert.equal(repository.snapshot(scope).wikiSources.length,0);assert.deepEqual(errors,[]);
});

test('management shows independent budgets, resumes paused contacts and explicitly remembers a new value', {timeout:45000},async t=>{
  mkdirSync('.local/allmind-m23/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m23/tests/followup-ui-')),repository=new FileBookRepository(directory);
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9999/v1',credentialId:'local-no-auth',model:'fixture',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true,proactive:true}},0,'fixture');
  const runtime=new BookRuntime(repository,{async complete(){return '好的'}}),scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'};
  await runtime.chat(scope,'地址：旧地址',new AbortController().signal);await runtime.automaticMemory.flush();
  const old=repository.snapshot(scope).entries[0];repository.commit(scope,{remove:[old.id]},repository.snapshot(scope).revision,'forget');runtime.invalidate(scope.characterId);
  const now=Date.now(),ledger=repository.loadCompanionData(scope),day=zonedParts(now,'Asia/Singapore').date;
  for(let i=0;i<2;i++)ledger.deliveries.push({id:`paused-${i}`,dedupKey:`paused-${i}`,basisRefs:[],reason:'合成问候',day,timezone:'Asia/Singapore',reservedAt:now-i*1000,expiresAt:now+120000,status:'committed',text:'你好',error:null,acknowledgedAt:now-i*1000,respondedAt:null});
  repository.saveCompanionData(scope,ledger);
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});let browser;
  t.after(async()=>{await browser?.close();await runtime.automaticMemory.flush();await server.close();repository.close()});
  browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);await page.getByRole('link',{name:'记忆',exact:true}).click();
  await page.getByRole('button',{name:'入库队列',exact:true}).click();await page.getByText(/连续未回应，主动交流已暂停/).waitFor();await page.getByText('更多管理工具',{exact:true}).click();
  await page.getByText(/今日主动生成 2\/2 次.*已确认展示 2\/2 次/).waitFor();
  const resumed=page.waitForResponse(response=>response.url().includes('/companion/resume')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'恢复主动交流',exact:true}).click();assert.equal((await resumed).status(),200);
  assert.ok(repository.loadCompanionData(scope).deliveries.every(delivery=>delivery.respondedAt));
  await page.getByText('重新记住新事实',{exact:true}).click();
  await page.getByLabel('已遗忘的属性',{exact:true}).fill('地址');await page.getByLabel('要重新记住的值',{exact:true}).fill('新地址');
  const save=page.getByRole('button',{name:'保存新事实',exact:true});assert.equal(await save.isEnabled(),false);
  await page.getByLabel('明确记录这条新事实',{exact:true}).check();
  const remembered=page.waitForResponse(response=>response.url().includes('/memory/relearn')&&response.request().method()==='POST');
  await save.click();assert.equal((await remembered).status(),200);
  assert.deepEqual(repository.snapshot(scope).entries.map(entry=>entry.fact.value),['新地址']);
  assert.ok(repository.loadCompanionData(scope).forgottenKeys.includes(`fact:${old.fact.key}`));
  const focused=page.waitForResponse(response=>response.url().includes('/companion/focus')&&response.request().method()==='POST');
  await page.keyboard.press('Escape');await page.getByRole('link',{name:'陪伴',exact:true}).click();await page.getByLabel('专注模式',{exact:true}).check();assert.equal((await focused).status(),200);assert.equal(repository.loadCompanionData(scope).focus,true);
  await page.reload();await page.getByRole('link',{name:'陪伴',exact:true}).click();await page.getByLabel('专注模式',{exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('input[type=checkbox]')].some(input=>input.checked&&input.parentElement.textContent.includes('专注模式')));
  const unfocused=page.waitForResponse(response=>response.url().includes('/companion/focus')&&response.request().method()==='POST');await page.getByLabel('专注模式',{exact:true}).uncheck();assert.equal((await unfocused).status(),200);
  assert.equal(repository.loadCompanionData(scope).focus,false);
  await page.getByRole('link',{name:'记忆',exact:true}).click();await page.getByRole('button',{name:'日常整理'}).click();await page.getByText('高级工具与来源',{exact:true}).click();await page.getByLabel('查询个人 Wiki',{exact:true}).fill('新地址');await page.getByRole('button',{name:'搜索 Wiki',exact:true}).click();
  await page.getByText(/已编纂 [1-9]/).waitFor();
  assert.ok(repository.snapshot(scope).wikiPages.some(page=>page.body.includes('新地址')));
  assert.deepEqual(errors,[]);
});

test('ambiguous cancellation UI explicitly selects one evidenced event', {timeout:45000},async t=>{
  mkdirSync('.local/allmind-m23/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m23/tests/cancel-ui-')),repository=new FileBookRepository(directory);
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9999/v1',credentialId:'local-no-auth',model:'fixture',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},0,'fixture');
  const runtime=new BookRuntime(repository,{async complete(){return '好的'}}),scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'};
  for(const text of ['第一场面试：2026-10-15 下午三点面试','第二场面试：2026-10-16 下午三点面试','取消我的面试']){await runtime.chat(scope,text,new AbortController().signal);await runtime.automaticMemory.flush()}
  assert.equal(repository.loadCompanionData(scope).events.filter(event=>event.status==='scheduled').length,2);
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});let browser;
  t.after(async()=>{await browser?.close();await runtime.automaticMemory.flush();await server.close();repository.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(10000);
  await page.goto(server.url);await page.getByRole('link',{name:'记忆',exact:true}).click();
  await page.getByRole('button',{name:'入库队列',exact:true}).click();const approved=page.waitForResponse(response=>response.url().includes('/companion/approve')&&response.request().method()==='POST');
  await page.getByRole('button',{name:/明确取消：.*2026-10-15/}).click();assert.equal((await approved).status(),200);
  const events=repository.loadCompanionData(scope).events;assert.equal(events.find(event=>event.date==='2026-10-15').status,'cancelled');assert.equal(events.find(event=>event.date==='2026-10-16').status,'scheduled');
});

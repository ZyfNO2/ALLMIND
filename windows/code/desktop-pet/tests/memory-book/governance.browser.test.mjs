import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {emptyEntry} from '../../dist/contracts/memory-book.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../dist/contracts/book-companion.js';
import {bookEntryHash} from '../../dist/memory/book-entry-hash.js';

test('private favorites preserve author hash and recall pinning, time filters agree with graph and two-step delete cleans favorite references',{timeout:45000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/governance-')),repository=new FileBookRepository(directory);t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'},config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},config.revision,'seed');
  const author=emptyEntry('author-test','wiki','作者收藏资料','不修改作者正文');repository.commit(scope,{upsert:[author]},0,'author');const hash=bookEntryHash(repository.snapshot(scope).entries.find(entry=>entry.id==='author-test'));
  let modelCalls=0;const runtime=new BookRuntime(repository,{async complete(){modelCalls++;return '好的'}});await runtime.chat(scope,'2026-10-12 上午九点 A公司面试已经结束，通过了',new AbortController().signal);await runtime.automaticMemory.flush();
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});t.after(()=>server.close());const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);await page.getByRole('link',{name:'我们的回忆',exact:true}).click();await page.getByRole('button',{name:'列表与编辑',exact:true}).click();await page.getByRole('button',{name:'04 · 编纂与高级工具'}).click();await page.getByText('高级工具与来源',{exact:true}).click();await page.getByText('服务与入库状态',{exact:true}).click();await page.getByText(/本地回忆：读取正常/).waitFor();await page.getByRole('button',{name:'重新检查本地状态',exact:true}).click();await page.getByText(/已配置，当前可用性未测试/).waitFor();assert.equal(modelCalls,1,'health read must not send model test requests');await page.getByRole('button',{name:'列表与编辑',exact:true}).click();await page.locator('.mb-entry').filter({hasText:'作者收藏资料'}).click();await page.getByRole('button',{name:'收藏此条目',exact:true}).click();await page.getByRole('button',{name:'取消收藏',exact:true}).waitFor();
  const saved=repository.snapshot(scope).entries.find(entry=>entry.id==='author-test');assert.equal(bookEntryHash(saved),hash);assert.equal(saved.pinned,false);assert.deepEqual(repository.loadCompanionData({...scope,pairingId:'other'}).favorites??[],[]);
  await page.getByLabel('只看收藏',{exact:true}).check();assert.equal(await page.locator('.mb-entry').count(),1);await page.reload();await page.getByRole('button',{name:'列表与编辑',exact:true}).click();await page.getByLabel('只看收藏',{exact:true}).check();assert.equal(await page.locator('.mb-entry').count(),1);
  await page.getByLabel('只看收藏',{exact:true}).uncheck();await page.getByLabel('时间依据',{exact:true}).selectOption('occurred');await page.getByLabel('筛选开始日期',{exact:true}).fill('2026-10-12');await page.getByLabel('筛选结束日期',{exact:true}).fill('2026-10-12');assert.equal(await page.locator('.mb-entry').count(),1);
  await page.locator('.mb-entry').click();await page.getByText('这条记忆的来源与原文',{exact:true}).click();await page.getByRole('button',{name:'回查此原始来源',exact:true}).click();assert.ok(await page.getByText('来源与版本',{exact:true}).locator('..').getByText(/2026-10-12 上午九点 A公司/).count());
  await page.getByRole('button',{name:'知识图谱',exact:true}).click();await page.getByRole('button',{name:/查看节点：/}).first().waitFor();
  await page.getByRole('button',{name:'列表与编辑',exact:true}).click();await page.getByLabel('时间依据',{exact:true}).selectOption('all');await page.locator('.mb-entry').filter({hasText:'作者收藏资料'}).click();await page.getByRole('button',{name:'移除条目',exact:true}).click();assert.ok(repository.snapshot(scope).entries.some(entry=>entry.id==='author-test'));await page.getByRole('button',{name:'取消移除',exact:true}).click();assert.ok(repository.snapshot(scope).entries.some(entry=>entry.id==='author-test'));
  await page.getByRole('button',{name:'移除条目',exact:true}).click();await page.getByRole('button',{name:'确认遗忘条目',exact:true}).click();await page.getByText('选择或新建一个条目。',{exact:true}).waitFor();assert.ok(!repository.snapshot(scope).entries.some(entry=>entry.id==='author-test'));assert.ok(!repository.loadCompanionData(scope).favorites.includes('author-test'));assert.deepEqual(errors,[]);
});

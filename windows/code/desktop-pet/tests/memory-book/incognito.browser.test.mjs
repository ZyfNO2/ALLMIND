import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../dist/contracts/book-companion.js';

test('management incognito persists no content, clears on reload, and ordinary chat still saves',{timeout:45000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/private-ui-')),repository=new FileBookRepository(directory);t.after(()=>repository.close());
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},config.revision,'seed');
  const calls=[],runtime=new BookRuntime(repository,{async complete(_binding,messages,_signal,options){calls.push({messages,options});return 'private-ui-answer'}});
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});t.after(()=>server.close());const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url);await page.getByLabel('本地无痕会话',{exact:true}).check();const input=page.getByLabel('聊天消息',{exact:true});await input.fill('饮品：private-ui-secret');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('log').getByText('private-ui-answer',{exact:true}).waitFor();
  const scope=calls[0].options.scope;assert.equal(calls[0].options.incognito,true);assert.equal(repository.readSession(scope).length,0);assert.equal(repository.loadCompanionData(scope).jobs.length,0);
  await page.reload();for(let attempt=0;attempt<100&&runtime.incognitoHistory(scope).length;attempt++)await new Promise(resolve=>setTimeout(resolve,20));await input.waitFor();assert.equal(await page.getByRole('log').getByText('private-ui-answer',{exact:true}).count(),0);assert.equal(runtime.incognitoHistory(scope).length,0);
  await page.getByRole('button',{name:'开始新话题',exact:true}).click();await input.fill('饮品：普通乌龙茶');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('log').getByText('private-ui-answer',{exact:true}).waitFor();await runtime.automaticMemory.flush();assert.equal(repository.readSession(calls.at(-1).options.scope).length,1);assert.ok(repository.snapshot(calls.at(-1).options.scope).entries.some(entry=>entry.body.includes('普通乌龙茶')));
  for(const name of readdirSync(directory).filter(name=>/\.jsonl?$/.test(name)))assert.ok(!readFileSync(join(directory,name),'utf8').includes('private-ui-secret'));
  await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByLabel('新会话默认无痕',{exact:true}).check();await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('设置已保存并生效。',{exact:true}).waitFor();await page.getByRole('link',{name:'首页',exact:true}).click();await page.getByRole('button',{name:'开始新话题',exact:true}).click();assert.equal(await page.getByLabel('本地无痕会话',{exact:true}).isChecked(),true);assert.deepEqual(errors,[]);
});

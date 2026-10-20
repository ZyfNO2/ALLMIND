import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {FactWikiService} from '../../dist/memory/fact-wiki.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';

test('a late Wiki source application cannot overwrite the newly selected role Book',{timeout:25000},async t=>{
  mkdirSync('.local/allmind-m4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m4/tests/wiki-role-')),repository=new FileBookRepository(directory),config=repository.loadConfig();
  repository.commitConfig({...config,characters:[...config.characters,{id:'other',name:'隔离角色',intro:'',appearancePath:null}]},config.revision,'two-roles');
  const wiki=new FactWikiService(repository);
  for(const [characterId,text] of [['aika','称呼：小林'],['other','称呼：小周']]){const scope={characterId,pairingId:'local-user',sessionId:'web-chat'},p=wiki.preview(scope,{sourceId:'seed-'+characterId,title:'用户',text,private:true});wiki.apply(scope,p.id,'seed-'+characterId)}
  const runtime=new BookRuntime(repository,{async complete(){throw Error('No model should be called')}}),server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});let browser,release;
  t.after(async()=>{release?.();await browser?.close();await server.close();repository.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let markApplied;const applied=new Promise(resolve=>markApplied=resolve);
  await page.route('**/wiki/apply',async route=>{const response=await route.fetch();assert.equal(response.status(),200);markApplied();await new Promise(resolve=>release=resolve);await route.fulfill({response})});
  await page.goto(server.url);await page.getByRole('link',{name:'记忆',exact:true}).click();
  // V2 keeps the fact-wiki source form inside the collapsed 高级工具与来源 panel on the memory page.
  await page.getByRole('button',{name:'日常整理'}).click();await page.getByText('高级工具与来源',{exact:true}).click();await page.getByText('整理事实来源',{exact:true}).click();
  await page.getByLabel('Wiki 资料名称',{exact:true}).fill('用户');await page.getByLabel('Wiki 事实资料',{exact:true}).fill('私密标记：旧角色密语青石');
  await page.getByRole('button',{name:'预览事实整理',exact:true}).click();await page.getByRole('button',{name:'确认事实并应用',exact:true}).click();await applied;
  await page.getByLabel(/当前角色/).selectOption('other');await page.getByText(/小周/).first().waitFor({state:'attached'});
  const delivered=page.waitForResponse(response=>response.url().endsWith('/wiki/apply'));release();await delivered;
  // Wait for a production render after receipt, rather than only checking the network response.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByLabel(/当前角色/).inputValue(),'other');assert.doesNotMatch(await page.locator('body').textContent(),/旧角色密语青石/);
  assert.match(JSON.stringify(repository.snapshot({characterId:'aika',pairingId:'local-user',sessionId:'web-chat'})),/旧角色密语青石/);
  assert.doesNotMatch(JSON.stringify(repository.snapshot({characterId:'other',pairingId:'local-user',sessionId:'web-chat'})),/旧角色密语青石/);assert.deepEqual(errors,[]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';

test('proactive frequency is edited and persisted from UI, keeps old defaults and rejects invalid HTTP saves',{timeout:60000},async t=>{
  const output=resolve('.local/goal-completion/frequency-browser');mkdirSync(output,{recursive:true});
  const directory=mkdtempSync(join(output,'data-')),repo=new FileBookRepository(directory);
  const runtime=new BookRuntime(repo,{async complete(){throw Error('No model call expected');}});
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')}),browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close();repo.close();});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await page.goto(server.url);await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'设置',exact:true}).click();
  async function open(){await page.getByRole('navigation',{name:'设置分组'}).getByRole('button',{name:'高级工具',exact:true}).click();await page.getByRole('button',{name:'陪伴规则与主动互动',exact:true}).click();}
  await open();
  const limit=page.getByRole('combobox',{name:'每日主动请求上限',exact:true}),interval=page.getByRole('spinbutton',{name:'最短间隔（分钟）',exact:true});
  assert.equal(await limit.inputValue(),'2');assert.equal(await interval.inputValue(),'180');
  const initial=repo.loadConfig().revision;
  await limit.selectOption('4');await interval.fill('45');assert.equal(repo.loadConfig().revision,initial,'draft must not silently save');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.waitForFunction(()=>document.body.innerText.includes('当前配置已保存'));
  assert.equal(repo.loadConfig().companion.dailyLimit,4);assert.equal(repo.loadConfig().companion.minimumIntervalMinutes,45);assert.equal(repo.loadConfig().companion.proactive,false,'frequency edits must not opt in');
  await page.reload();await open();assert.equal(await limit.inputValue(),'4');assert.equal(await interval.inputValue(),'45');
  await interval.fill('29');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('陪伴设置无效。',{exact:false}).first().waitFor();
  assert.equal(repo.loadConfig().companion.minimumIntervalMinutes,45,'invalid frequency must not change persisted config');
  await page.getByRole('button',{name:'放弃更改',exact:true}).click();assert.equal(await interval.inputValue(),'45');
  for(const width of [320,768,1440]){await page.setViewportSize({width,height:1000});await limit.scrollIntoViewIfNeeded();assert.equal(await limit.isVisible(),true);await interval.scrollIntoViewIfNeeded();assert.equal(await interval.isVisible(),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow at '+width);}
  assert.deepEqual(errors,[]);
});

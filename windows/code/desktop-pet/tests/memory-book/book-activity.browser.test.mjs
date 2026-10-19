import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {BookActivity} from '../../dist/core/book-activity.js';

test('built settings uses real Book activity routes, opt-in, coverage display and deletion', {timeout:45000},async t=>{
  const root=resolve('.local/book-activity-tests');mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(join(root,'browser-')),repository=new FileBookRepository(directory),now=Date.now();
  const runtime=new BookRuntime(repository,{async complete(){throw Error('Activity UI must not call a model')}});
  let opened=0;
  const activity=new BookActivity(join(directory,'keyboard'),'.',()=>{},()=>{},()=>now,()=>({start(){opened++},async startKeyboard(){},async close(){}}));
  await activity.select('aika');
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management'),activity});
  let browser;t.after(async()=>{await browser?.close();await activity.close();await server.close();repository.close();rmSync(directory,{recursive:true,force:true});});
  browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();
  // V4 groups keyboard activity under 设置 → 桌面; the label drops the 陪敲 suffix (typing companionship is declaration-gated now).
  const checkbox=page.getByLabel('开启当前角色的键盘活动记录');await checkbox.waitFor();assert.equal(await checkbox.isChecked(),false);assert.equal(opened,0);
  await checkbox.click();await page.getByText('来源：监听中',{exact:true}).waitFor();assert.equal(await checkbox.isChecked(),true);assert.equal(opened,1);
  activity.ingest('aika',{kind:'keyboard',op:'activity',requestId:'fixture',grantRevision:1,payload:{bucketStart:new Date(now-10000).toISOString(),bucketEnd:new Date(now).toISOString(),activityCount:17,foregroundAppId:null,countingPolicy:'keydown-repeat-v2'}});
  // Re-enter the real settings route, causing its normal mount refresh.
  await page.getByRole('link',{name:'聊天',exact:true}).click();await page.getByRole('link',{name:'设置',exact:true}).click();
  await page.getByText(/17 次按下通知/).waitFor();await page.getByText(/画像未知/).waitFor();
  await page.getByRole('button',{name:'清空当前角色活动记录',exact:true}).click();await page.getByText(/暂无样本：0 次按下通知/).waitFor();
  assert.equal(activity.view('aika').days.length,0);assert.deepEqual(errors,[]);
});

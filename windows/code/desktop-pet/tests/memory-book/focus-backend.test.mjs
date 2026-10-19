import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {createCompanionLifeState} from '../../dist/core/companion-behavior.js';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';

test('production desktop backend restores the same focus deadline after process restart and completes once after sleep',{timeout:60000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/focus-backend-'));
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'desktop'},now=Date.now(),repository=new FileBookRepository(directory);
  repository.saveCompanionLife(scope,{...createCompanionLifeState(scope,now),activity:'walking',localHistory:[{id:'prior-touch',kind:'petting',at:now-1000,presentation:'missing'}]},0);
  const runtime=new BookRuntime(repository,{async complete(){throw Error('focus must not call a model')}});
  runtime.setFocus(scope,true,25,now);const original=repository.loadCompanionData(scope).focusTimer;repository.close();
  async function run(offset){
    const wrapper=join(directory,`backend-${offset}.mjs`);writeFileSync(wrapper,`import {runBookBackend} from ${JSON.stringify(pathToFileURL(resolve('dist/app/book-backend.js')).href)};Date.now=()=>${now+offset};await runBookBackend(${JSON.stringify(directory)});`);
    const child=spawn(process.execPath,[wrapper],{cwd:process.cwd(),windowsHide:true,env:{...process.env,AIKI_BOOK_PORT:'0'},stdio:['pipe','pipe','pipe']}),messages=[];let buffer='',stderr='';
    child.stdout.on('data',part=>{buffer+=part;let index;while((index=buffer.indexOf('\n'))>=0){messages.push(JSON.parse(buffer.slice(0,index)));buffer=buffer.slice(index+1)}});child.stderr.on('data',part=>stderr+=part);
    let closed=false;const stop=async()=>{if(closed)return;closed=true;child.stdin.end();await new Promise((resolve,reject)=>{if(child.exitCode!==null)return child.exitCode===0?resolve():reject(Error(stderr));child.once('exit',code=>code===0?resolve():reject(Error(stderr)));setTimeout(()=>{if(child.exitCode===null){child.kill();reject(Error('backend did not stop: '+stderr))}},5000).unref()})};t.after(stop);
    const deadline=performance.now()+15000;while(performance.now()<deadline){const state=messages.find(row=>row.channel==='companion_state');if(state)return {state,stop};if(child.exitCode!==null)throw Error('backend exit: '+stderr);await new Promise(resolve=>setTimeout(resolve,20))}throw Error('backend missing focus state: '+stderr);
  }
  const before=await run(10*60000);assert.equal(before.state.focus,true);assert.deepEqual(before.state.focusTimer,original);
  assert.equal(before.state.state.activity,'idle','focus pauses autonomous activity');assert.equal(before.state.state.enabled,true,'focus preserves the original enabled preference');
  const management=JSON.parse(readFileSync(join(directory,'management-session.json'),'utf8')),url=new URL(management.url),token=new URLSearchParams(url.hash.slice(1)).get('token');
  const endpoint=new URL('/api/memory-book/v1/companion/life',url).href;
  assert.equal((await fetch(endpoint)).status,401);
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  let life=await (await fetch(endpoint,{headers})).json();
  const change=body=>fetch(endpoint,{method:'POST',headers,body:JSON.stringify({characterId:scope.characterId,...body})});
  assert.equal((await change({action:'clear_history',expectedRevision:life.revision})).status,400,'destructive clear requires explicit confirmation');
  assert.equal((await change({action:'set_quiet',enabled:true,expectedRevision:life.revision-1})).status,409,'stale state cannot overwrite settings');
  const quiet=await change({action:'set_quiet',enabled:true,expectedRevision:life.revision});assert.equal(quiet.status,200);life=await quiet.json();assert.equal(life.quiet,true);
  const clear=await change({action:'clear_history',confirmed:true,expectedRevision:life.revision});assert.equal(clear.status,200);life=await clear.json();assert.deepEqual(life.localHistory,[]);
  const restore=await change({action:'set_quiet',enabled:false,expectedRevision:life.revision});assert.equal(restore.status,200);assert.equal((await restore.json()).quiet,false);
  assert.equal((await change({characterId:'foreign',action:'set_enabled',enabled:false,expectedRevision:0})).ok,false,'cannot control another role');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:960}});const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(management.url);await page.getByRole('link',{name:'设置',exact:true}).click();
  const groups=['AI 与对话','陪伴与行为','感知与记忆','外观与显示','隐私与系统'];assert.deepEqual(await page.getByRole('navigation',{name:'设置分组'}).getByRole('button').allTextContents(),groups);
  await page.getByRole('button',{name:'陪伴与行为',exact:true}).click();
  await page.getByLabel('专注模式',{exact:true}).waitFor();assert.equal(await page.getByLabel('专注模式',{exact:true}).isChecked(),true);
  const quietControl=page.getByRole('checkbox',{name:'免打扰',exact:true});await quietControl.waitFor();
  const [enabledResponse]=await Promise.all([page.waitForResponse(response=>response.url().includes('/companion/life')&&response.request().method()==='POST'),quietControl.click()]);assert.equal(enabledResponse.status(),200);
  await page.waitForFunction(()=>document.querySelectorAll('section[aria-label="自主活动与免打扰"] input')[1].checked&&!document.querySelector('section[aria-label="自主活动与免打扰"] fieldset').disabled);
  assert.equal((await (await fetch(endpoint,{headers})).json()).quiet,true,'settings switch reaches the real desktop owner');
  const [disabledResponse]=await Promise.all([page.waitForResponse(response=>response.url().includes('/companion/life')&&response.request().method()==='POST'),quietControl.click()]);assert.equal(disabledResponse.status(),200);
  await page.waitForFunction(()=>!document.querySelectorAll('section[aria-label="自主活动与免打扰"] input')[1].checked&&!document.querySelector('section[aria-label="自主活动与免打扰"] fieldset').disabled);
  assert.equal((await (await fetch(endpoint,{headers})).json()).quiet,false);
  await page.getByRole('button',{name:'隐私与系统',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'清空相处记录',exact:true}).isDisabled(),true,'clear cannot run before confirmation');
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+'px settings must not overflow');}
  await page.setViewportSize({width:1440,height:960});await page.screenshot({path:join(directory,'settings-five-groups.png'),fullPage:true});assert.deepEqual(pageErrors,[]);await browser.close();
  await before.stop();
  const slept=await run(30*60000);assert.equal(slept.state.focus,false);assert.equal(slept.state.focusTimer.id,original.id);assert.equal(slept.state.focusTimer.until,original.until);assert.equal(slept.state.focusTimer.completedAt,now+30*60000);await slept.stop();
  const restarted=await run(40*60000);assert.equal(restarted.state.focus,false);assert.deepEqual(restarted.state.focusTimer,slept.state.focusTimer);await restarted.stop();
  const reopened=new FileBookRepository(directory);t.after(()=>reopened.close());assert.deepEqual(reopened.loadCompanionData(scope).focusTimer,slept.state.focusTimer);assert.equal(reopened.readSession(scope).length,0);
});

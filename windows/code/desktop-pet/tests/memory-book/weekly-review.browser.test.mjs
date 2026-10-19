import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {FactWikiService} from '../../dist/memory/fact-wiki.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../dist/contracts/book-companion.js';

test('manual weekly review shows real empty state and sourced private records, refresh removes forgotten influence without new memory or model calls',{timeout:45000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/week-ui-')),repository=new FileBookRepository(directory);t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'},runtime=new BookRuntime(repository,{async complete(){throw Error('local review must not send a model request')}}),server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});t.after(()=>server.close());
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);await page.getByRole('link',{name:'陪伴',exact:true}).click();await page.getByRole('button',{name:'生成本地周回顾',exact:true}).click();await page.getByText('这段时间没有可回顾的聊天或有效新回忆。',{exact:true}).waitFor();
  const wiki=new FactWikiService(repository),p=wiki.preview(scope,{sourceId:'week-source',title:'用户分享',text:'爱好：园艺',private:true});wiki.apply(scope,p.id,'seed');repository.appendTurn({...scope,sessionId:'other-session'},{id:'one',characterId:'aika',pairingId:'local-user',sessionId:'other-session',timestamp:new Date().toISOString(),user:'爱好：园艺',assistant:'记下了',traceId:'trace-one'});
  const revision=repository.snapshot(scope).revision;await page.getByRole('button',{name:'生成本地周回顾',exact:true}).click();await page.getByText(/聊天 1 天 · 1 轮 · 新有效回忆 1 条/).waitFor();const panel=page.locator('section').filter({has:page.getByRole('heading',{name:'我们的这一周',exact:true})});assert.equal(await panel.locator('blockquote').innerText(),'爱好：园艺');assert.ok((await panel.innerText()).includes('week-source'));assert.equal(repository.snapshot(scope).revision,revision);
  await page.getByRole('button',{name:'撤销本次回顾',exact:true}).click();assert.equal(await panel.locator('blockquote').count(),0);assert.equal(repository.snapshot(scope).revision,revision);
  wiki.revoke(scope,'week-source',revision,'forget-source');await page.getByRole('button',{name:'生成本地周回顾',exact:true}).click();await page.getByText(/新有效回忆 0 条/).waitFor();assert.equal(await panel.locator('blockquote').count(),0);assert.equal(repository.readSession({...scope,sessionId:'other-session'}).length,1);assert.deepEqual(errors,[]);
});

test('manual AI week review uses real API, shows cited excerpts and clears or cancels without memory writes',{timeout:45000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(resolve(mkdtempSync('.local/ui-v4/tests/week-ai-ui-'))),config=repository.loadConfig();
  repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:1/v1',model:'review-fixture',credentialId:'none',inputTokens:16384,outputTokens:2048},companion:{...DEFAULT_COMPANION_SETTINGS,cloudMemoryConsent:true}},config.revision,'settings');
  let calls=0,hold=false,release;const runtime=new BookRuntime(repository,{async complete(binding,messages,_signal,options){calls++;assert.equal(binding.model,'review-fixture');assert.equal(options.purpose,'wiki');const facts=JSON.parse(messages.at(-1).content).memories;if(hold)await new Promise(done=>{release=done});return JSON.stringify({items:[{text:'你提到了对园艺的兴趣。',entryIds:[facts[0].entryId]}]})}}),scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'};
  const preview=runtime.wiki.preview(scope,{sourceId:'week-ai-source',title:'用户',text:'爱好：园艺',private:true});runtime.wiki.apply(scope,preview.id,'source');const before=repository.snapshot(scope);
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(repository.directory,'credentials')),uiRoot:resolve('management')}),browser=await chromium.launch({headless:true});t.after(async()=>{release?.();await browser.close();await server.close();repository.close()});
  const page=await browser.newPage();page.setDefaultTimeout(10000);await page.goto(server.url);await page.getByRole('link',{name:'陪伴',exact:true}).click();
  const local=page.getByRole('button',{name:'生成本地周回顾',exact:true}),ai=page.getByRole('button',{name:'生成AI有据回顾（发送本次摘录）',exact:true});await local.click();assert.equal(calls,0);await ai.click();
  const narrative=page.getByRole('region',{name:'AI有据周回顾',exact:true});await narrative.getByText('你提到了对园艺的兴趣。',{exact:true}).waitFor();const link=narrative.locator('a');assert.equal(await link.count(),1);assert.ok((await link.getAttribute('href')).startsWith('#week-source-'));assert.deepEqual(repository.snapshot(scope),before);assert.equal(repository.readSession(scope).length,0);
  await page.getByRole('button',{name:'撤销本次回顾',exact:true}).click();assert.equal(await narrative.count(),0);await local.click();hold=true;await ai.click();
  const until=Date.now()+10000;while(!release&&Date.now()<until)await new Promise(done=>setTimeout(done,20));assert.equal(typeof release,'function');
  await page.getByRole('button',{name:'停止并清除本次回顾',exact:true}).click();release();hold=false;
  while(runtime.isConversing(scope.characterId)&&Date.now()<until)await new Promise(done=>setTimeout(done,20));assert.equal(runtime.isConversing(scope.characterId),false);assert.equal(await narrative.count(),0);assert.equal(await local.isEnabled(),true);assert.equal(repository.readSession(scope).length,0);
  runtime.wiki.revoke(scope,'week-ai-source',before.revision,'revoke');runtime.invalidate(scope.characterId);await local.click();await ai.click();await page.getByText(/没有有效摘录，未调用模型/).waitFor();assert.equal(calls,2);
  const url=new URL(server.url);assert.equal((await fetch(url.origin+'/api/memory-book/v1/companion/weekly-review/narrative',{method:'POST',body:'{}'})).status,401);
});

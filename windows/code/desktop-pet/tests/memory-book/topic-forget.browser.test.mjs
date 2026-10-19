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
import {emptyEntry} from '../../dist/contracts/memory-book.js';

test('topic review excludes author and other pairs, refuses changed targets and atomically forgets all reviewed facts with graph invalidation',{timeout:45000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/topic-')),repository=new FileBookRepository(directory);t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'},wiki=new FactWikiService(repository);
  for(const [suffix,target] of [['self',scope],['other',{...scope,pairingId:'other'}]]){const preview=wiki.preview(target,{sourceId:suffix,title:'用户分享',text:'爱好：园艺\n项目：园艺日记\n饮品：白茶',private:true});wiki.apply(target,preview.id,'seed-'+suffix)}
  repository.commit(scope,{upsert:[emptyEntry('author-garden','persona','园艺角色','作者核心人格：喜爱园艺')]},repository.snapshot(scope).revision,'author');
  const runtime=new BookRuntime(repository,{async complete(){throw Error('forget must not call a model')}}),server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});t.after(()=>server.close());
  const url=new URL(server.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
  async function call(route,data){const response=await fetch(url.origin+'/api/memory-book/v1'+route,{method:'POST',headers,body:JSON.stringify({...scope,...data})});return {status:response.status,data:await response.json()}}
  assert.equal((await call('/memory/topic-preview',{topic:''})).status,400);
  const preview=(await call('/memory/topic-preview',{topic:'园艺'})).data;assert.equal(preview.entries.length,2);assert.ok(preview.entries.every(row=>row.id!=='author-garden'));
  assert.equal((await call('/memory/topic-forget',{...preview,entryIds:[preview.entries[0].id],operationId:'bad-scope',confirmed:true})).status,409);assert.equal(repository.snapshot(scope).entries.length,4);
  const originalRevision=repository.snapshot(scope).revision;repository.commit(scope,{upsert:[emptyEntry('unrelated','wiki','未关联','作者资料')]},originalRevision,'changed');
  assert.equal((await call('/memory/topic-forget',{...preview,entryIds:preview.entries.map(row=>row.id),operationId:'stale',confirmed:true})).status,409);
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);await page.getByRole('link',{name:'我们的回忆',exact:true}).click();
  // V4 nests topic review inside the collapsed 高级工具与来源 panel on the memory page.
  await page.getByRole('button',{name:'04 · 编纂与高级工具'}).click();await page.getByText('高级工具与来源',{exact:true}).click();await page.getByText('按话题核对与遗忘',{exact:true}).click();await page.getByLabel('要遗忘的话题',{exact:true}).fill('园艺');await page.getByRole('button',{name:'预览话题范围',exact:true}).click();await page.getByText(/匹配 2 条私人记忆/).waitFor();
  assert.equal(await page.getByRole('button',{name:'确认遗忘整个话题',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'取消话题遗忘',exact:true}).click();assert.ok(repository.snapshot(scope).entries.some(row=>row.fact?.value==='园艺'));
  await page.getByRole('button',{name:'预览话题范围',exact:true}).click();await page.getByLabel('我已核对全部条目，包括固定条目',{exact:true}).check();
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/memory/topic-forget')&&response.ok());await page.getByRole('button',{name:'确认遗忘整个话题',exact:true}).click();const response=await responsePromise,request=response.request().postDataJSON(),result=await response.json();
  assert.equal((await call('/memory/topic-forget',request)).status,200,'exact retry returns the committed receipt');assert.ok(!JSON.stringify(wiki.graph(scope)).includes('园艺日记'));
  assert.ok(repository.snapshot(scope).entries.some(row=>row.id==='author-garden'));assert.ok(repository.snapshot(scope).entries.some(row=>row.fact?.value==='白茶'));assert.ok(repository.snapshot({...scope,pairingId:'other'}).entries.some(row=>row.fact?.value==='园艺'));
  const current=repository.snapshot(scope),source=current.wikiSources.find(row=>row.id==='self');assert.ok(source.snapshots[0].text.includes('园艺'));assert.ok(source.forgottenKeys.length===2);assert.ok(result.receipt.changedIds.length>=2);
  const repeated=wiki.preview(scope,{sourceId:'new-source',title:'用户分享',text:'爱好：园艺',private:true});assert.throws(()=>wiki.apply(scope,repeated.id,'resurrect'),/遗忘/);assert.ok(!repository.snapshot(scope).entries.some(row=>row.fact?.value==='园艺'),'new source cannot resurrect a forgotten fact');assert.deepEqual(errors,[]);
});

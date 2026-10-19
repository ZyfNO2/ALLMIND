import {readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {BookRuntime} from '../dist/app/book-runtime.js';
import {BookCredentials} from '../dist/management/book-credentials.js';
import {startBookServer} from '../dist/management/book-server.js';
const directory=JSON.parse(readFileSync('.local/weekly-real-current.json','utf8')).directory,input=JSON.parse(readFileSync(join(directory,'input.json'),'utf8')),report=JSON.parse(readFileSync(input.evidence,'utf8'));
assert.equal(report.status,'FAILED');assert.equal(report.http,200);assert.ok(report.error.includes('parsing css selector'));copyFileSync(input.evidence,input.evidence.replace(/\.json$/, '-selector-failure.json'));
const repository=new FileBookRepository(directory),runtime=new BookRuntime(repository,{async complete(){throw Error('Resume must never resubmit the real request')}}),scope=input.scope;
let server,browser;try{
 const before=repository.snapshot(scope);assert.equal(before.revision,report.preview.revision);assert.equal(repository.readSession(scope).length,0);assert.equal(before.entries.filter(entry=>report.preview.memories.some(row=>row.entryId===entry.id)).length,report.preview.memories.length);
 server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(10000);
 // Replay the already captured real provider result only to finish UI checks after the selector failure; no new provider call.
 await page.route('**/companion/weekly-review/narrative',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(report.result)}));await page.goto(server.url);await page.getByRole('link',{name:'陪伴',exact:true}).click();await page.getByRole('button',{name:'生成本地周回顾',exact:true}).click();await page.getByRole('button',{name:'生成AI有据回顾（发送本次摘录）',exact:true}).click();const narrative=page.getByRole('region',{name:'AI有据周回顾',exact:true});await narrative.waitFor();
 for(const item of report.result.items){await narrative.getByText(item.text,{exact:true}).waitFor();for(const id of item.entryIds)assert.ok(report.preview.memories.some(row=>row.entryId===id))}
 for(const anchor of await narrative.locator('a').all()){const href=await anchor.getAttribute('href');assert.equal(await page.locator('[id='+JSON.stringify(href.slice(1))+']').count(),1)}
 await page.screenshot({path:input.evidence.replace(/\.json$/,'.png'),fullPage:true});await page.getByRole('button',{name:'撤销本次回顾',exact:true}).click();assert.equal(await narrative.count(),0);assert.deepEqual(repository.snapshot(scope),before);
 runtime.wiki.revoke(scope,'weekly-real-synthetic',before.revision,'weekly-real-resume-revoke');const after=repository.snapshot(scope),empty=await runtime.narrateWeek(scope,{expectedRevision:after.revision,confirmed:true},new AbortController().signal);assert.equal(empty.model,null);assert.deepEqual(empty.items,[]);assert.equal(repository.readSession(scope).length,0);
 report.firstError=report.error;delete report.error;report.checks.push('captured real GPT-6 response and initial actual UI region; remaining source anchors and clear verified by replaying that exact recorded response without provider calls','Book revision unchanged after generation; no saved turn; revoked source yields empty narrative without provider call');report.resumeMethod='isolated production server; exact recorded real response replay for remaining UI assertions, not another model request';report.status='ENGINEERING_PASS_AWAITING_SEMANTIC_REVIEW';report.finishedAt=new Date().toISOString();writeFileSync(input.evidence,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,items:report.result.items}));
}finally{await browser?.close();await server?.close();repository.close()}

import {app,BrowserWindow} from 'electron';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
const input=JSON.parse(readFileSync(join(process.env.AIKI_BOOK_DATA,'input.json'),'utf8'));
if(existsSync(input.evidence))throw Error('Do not repeat a real submission over existing evidence');
const report={status:'IN_PROGRESS',model:input.model,method:'actual production Electron embedded provider and hidden Playwright management UI; isolated synthetic Book; original signed-in profile; regular conversation',checks:[],startedAt:new Date().toISOString()},save=()=>writeFileSync(input.evidence,JSON.stringify(report,null,2));let browser;
const wait=async(fn,label,budget=30000)=>{const until=Date.now()+budget;while(Date.now()<until){const value=await fn();if(value)return value;await new Promise(done=>setTimeout(done,200))}throw Error('Timed out: '+label)};
async function run(){try{
 save();await import('../desktop/electron/main.mjs');await app.whenReady();
 await wait(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('pet:')),'production host');
 await wait(()=>existsSync(join(input.directory,'management-session.json')),'management session');const session=JSON.parse(readFileSync(join(input.directory,'management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
 const request=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(330000)}),data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data};
 const params=new URLSearchParams({characterId:'aika',sessionId:'web-chat'}).toString();await wait(async()=>{const state=await request('/chatgpt-web/status');return state.state==='signed-in'},'signed in',60000);
 const before=await request('/book?'+params),historyBefore=await request('/chat/history?'+params);report.source=(await request('/runtime')).config.wikiModel;
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(session.url);await page.getByRole('link',{name:'陪伴',exact:true}).click();
 await page.getByRole('button',{name:'生成本地周回顾',exact:true}).click();const section=page.locator('section.mb-card').filter({has:page.getByRole('heading',{name:'我们的这一周',exact:true})});await section.locator('blockquote').first().waitFor();report.preview=await request('/companion/weekly-review?'+params);assert.ok(report.preview.memories.length>=3);save();
 const responsePromise=page.waitForResponse(response=>response.url().endsWith('/companion/weekly-review/narrative')&&response.request().method()==='POST',{timeout:330000});report.submissionStartedAt=new Date().toISOString();save();await page.getByRole('button',{name:'生成AI有据回顾（发送本次摘录）',exact:true}).click();
 const response=await responsePromise;report.http=response.status();report.result=await response.json();save();assert.equal(response.status(),200);assert.equal(report.result.model,input.model);
 const narrative=page.getByRole('region',{name:'AI有据周回顾',exact:true});await narrative.waitFor();assert.ok(report.result.items.length>0);const refs=new Set(report.preview.memories.map(row=>row.entryId));for(const item of report.result.items)for(const id of item.entryIds)assert.ok(refs.has(id));
 for(const anchor of await narrative.locator('a').all()){const href=await anchor.getAttribute('href');assert.ok(href?.startsWith('#week-source-'));assert.equal(await page.locator('[id='+JSON.stringify(href.slice(1))+']').count(),1)}
 assert.deepEqual(await request('/book?'+params),before);assert.deepEqual(await request('/chat/history?'+params),historyBefore);assert.deepEqual(errors,[]);report.checks.push('real configured Wiki model response rendered with valid source anchors; no Book/turn writes');
 await page.screenshot({path:input.evidence.replace(/\.json$/,'.png'),fullPage:true});await page.getByRole('button',{name:'撤销本次回顾',exact:true}).click();assert.equal(await narrative.count(),0);report.checks.push('user clears rendered real narrative');
 await request('/wiki/revoke',{characterId:'aika',sessionId:'web-chat',sourceId:'weekly-real-synthetic',expectedRevision:before.revision,operationId:'weekly-real-revoke'});const empty=await request('/companion/weekly-review?'+params);assert.equal(empty.memories.length,0);const noModel=await request('/companion/weekly-review/narrative',{characterId:'aika',sessionId:'web-chat',expectedRevision:empty.revision,confirmed:true});assert.equal(noModel.model,null);assert.deepEqual(noModel.items,[]);report.checks.push('revoked excerpts excluded; empty narrative reports no model');report.status='ENGINEERING_PASS_AWAITING_SEMANTIC_REVIEW';report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,items:report.result.items}));
}catch(error){report.status='FAILED';report.error=error.stack??String(error);save();console.error(report.error);process.exitCode=1}finally{await browser?.close();app.quit()}}
void run();

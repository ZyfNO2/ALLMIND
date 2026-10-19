import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {CompanionBehavior,createCompanionLifeState} from '../../dist/core/companion-behavior.js';
import {interactionBindings,saveInteractionSettings} from '../../dist/core/book-interactions.js';
import {BookError} from '../../dist/contracts/memory-book.js';
const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'},labels=['戳一戳','喂食（虚拟互动）','送礼物（虚拟互动）'];
async function fixture(t,declared=true){
 mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(resolve(mkdtempSync('.local/ui-v4/tests/interactions-ui-'))),runtime=new BookRuntime(repository,{async complete(){throw Error('Interactions must not invoke a model')}}),life=new CompanionBehavior(createCompanionLifeState(scope,Date.now()));
 let manifest={type:'sprite',skinId:'ui-test',assetFingerprint:'b'.repeat(64),sprite:{clips:{happy:{start:0,frameCount:2}}}},rejectPlay=false;const ids=[];
 if(declared)manifest.localInteractions={schemaVersion:'local-pet/v1',skinId:manifest.skinId,assetFingerprint:manifest.assetFingerprint,bindings:{petting:{kind:'sprite',targetId:'happy'},feeding:{kind:'sprite',targetId:'happy'},gifting:{kind:'sprite',targetId:'happy'}}};
 const read=()=>({available:true,...interactionBindings(repository,scope,manifest),skinId:manifest.skinId,assetFingerprint:manifest.assetFingerprint,mood:life.snapshot().mood,records:life.snapshot().interactions??[],allowance:life.interactionAllowance(Date.now()),pending:false});
 const server=await startBookServer({runtime,credentials:new BookCredentials(join(repository.directory,'credentials')),uiRoot:resolve('management'),companionInteractions:{read,configure(_scope,input,revision){saveInteractionSettings(repository,scope,manifest,input,revision);return read()},async perform(_scope,kind,id,revision,signal){signal.throwIfAborted();ids.push(id);if(rejectPlay)throw new BookError('unavailable','页面fixture：实际桌面播放未确认。');assert.equal(revision,repository.loadCompanionData(scope).interactionSettings.revision);const result=life.interact(kind,id,Date.now());return {controls:read(),played:result.applied,message:'页面fixture回执；原生实播由另一个验收覆盖。'}},async undo(_scope,id){life.undoInteraction(id,Date.now());return read()}}});
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close()});const page=await browser.newPage();page.setDefaultTimeout(10000);await page.goto(server.url);await page.getByRole('link',{name:'陪伴',exact:true}).click();const region=page.getByRole('region',{name:declared?'小互动与动作映射':'小互动',exact:true});if(declared)await region.getByRole('button',{name:'保存动作映射',exact:true}).waitFor();else await region.getByText('当前角色未提供小互动。',{exact:true}).waitFor();
 return {repository,life,page,region,server,ids,setRejected:value=>{rejectPlay=value},changeManifest:value=>{manifest=value},manifest:()=>manifest};
}
test('UI saves real available mappings, uses idempotent play retry and undoes without refund or memory writes',{timeout:45000},async t=>{
 const {repository,life,region,ids,setRejected,server}=await fixture(t);
 for(const name of labels)await region.getByLabel(name+'动作映射',{exact:true}).selectOption('clip:happy');await region.getByRole('button',{name:'保存动作映射',exact:true}).click();await region.getByText('动作映射已保存，绑定当前资源。',{exact:true}).waitFor();assert.equal(repository.loadCompanionData(scope).interactionSettings.revision,1);
 setRejected(true);await region.getByRole('button',{name:labels[1],exact:true}).click();await region.getByRole('alert').waitFor();assert.equal(life.snapshot().interactions,undefined);
 setRejected(false);await region.getByRole('button',{name:labels[1],exact:true}).click();await region.getByText('页面fixture回执；原生实播由另一个验收覆盖。',{exact:true}).waitFor();assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal(life.snapshot().interactions.length,1);assert.ok(life.snapshot().mood>50);
 await region.getByRole('button',{name:'撤销最近一次互动反馈',exact:true}).click();await region.getByText('已撤销该次短期反馈，次数不退回。',{exact:true}).waitFor();assert.ok(Math.abs(life.snapshot().mood-50)<.001);assert.equal(life.snapshot().interactions.length,1);assert.equal(await region.getByRole('button',{name:labels[1],exact:true}).isDisabled(),true);assert.equal(repository.snapshot(scope).entries.length,0);assert.equal(repository.readSession(scope).length,0);
 const url=new URL(server.url);assert.equal((await fetch(url.origin+'/api/memory-book/v1/companion/interactions/play',{method:'POST',body:'{}'})).status,401);
});
test('mapping conflicts retain draft and resource replacement cannot silently reuse old bindings',{timeout:45000},async t=>{
 const {repository,region,manifest,changeManifest}=await fixture(t);
 for(const name of labels)await region.getByLabel(name+'动作映射',{exact:true}).selectOption('clip:happy');await region.getByRole('button',{name:'保存动作映射',exact:true}).click();await region.getByText('动作映射已保存，绑定当前资源。',{exact:true}).waitFor();
 saveInteractionSettings(repository,scope,manifest(),{skinId:manifest().skinId,assetFingerprint:manifest().assetFingerprint,bindings:{touch:null,feed:null,gift:null}},1);
 await region.getByRole('button',{name:'保存动作映射',exact:true}).click();await region.getByRole('alert').waitFor();assert.equal(await region.getByLabel(labels[2]+'动作映射',{exact:true}).inputValue(),'clip:happy');assert.equal(repository.loadCompanionData(scope).interactionSettings.bindings.gift,null);
 await region.getByRole('button',{name:'重新读取当前资源（放弃草稿）',exact:true}).click();await region.getByText('已放弃草稿，读取当前资源与已保存映射。',{exact:true}).waitFor();
 const {localInteractions,...resource}=manifest();changeManifest({...resource,assetFingerprint:'c'.repeat(64),sprite:{clips:{}}});const empty=region.page().getByRole('region',{name:'小互动',exact:true});await empty.getByText('当前角色未提供小互动。',{exact:true}).waitFor();for(const name of labels)assert.equal(await region.page().getByRole('button',{name,exact:true}).count(),0);
});
test('headless mode advertises unavailable consumer instead of simulating interactions',async t=>{
 mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(resolve(mkdtempSync('.local/ui-v4/tests/interactions-headless-'))),runtime=new BookRuntime(repository,{async complete(){throw Error('must not send')}}),server=await startBookServer({runtime,credentials:new BookCredentials(join(repository.directory,'credentials')),uiRoot:resolve('management')});t.after(async()=>{await server.close();repository.close()});const url=new URL(server.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
 const read=await fetch(url.origin+'/api/memory-book/v1/companion/interactions',{headers});assert.equal((await read.json()).available,false);const response=await fetch(url.origin+'/api/memory-book/v1/companion/interactions/play',{method:'POST',headers,body:JSON.stringify({...scope,kind:'feed',id:'one',expectedRevision:0})});assert.equal(response.status,503);assert.equal(repository.loadCompanionLife(scope),null);
});

test('generic artwork without a role declaration exposes no made-up interaction controls',{timeout:45000},async t=>{
 const {region,page,repository}=await fixture(t,false);
 for(const name of labels)assert.equal(await page.getByRole('button',{name,exact:true}).count(),0);
 assert.equal(await region.getByRole('combobox').count(),0);
 assert.equal(repository.loadCompanionData(scope).interactionSettings,undefined);
});

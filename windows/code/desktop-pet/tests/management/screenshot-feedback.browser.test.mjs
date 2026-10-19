import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { roleConsoleFixture } from './role-console-fixture.mjs';
import { scope, message, change } from '../../dist/tests/memory/sqlite-fixture.js';

test('RWR-11 production console: loading/reload, model picker, forget/read-back and single import heading', {timeout:120000}, async t => {
 const f=await roleConsoleFixture(t);
 // Existing registry entries can predate the role-configuration file. Concurrent owner reads must
 // migrate once and keep unknown ids rejected; imported knowledge is not a prerequisite.
 f.store.registry.create({id:'legacy-role',label:'旧角色',operationId:'rwr11-legacy-registry'});
 const [profile,bindings]=await Promise.all([f.request('/api/characters/profile?characterId=legacy-role'),f.request('/api/characters/bindings?characterId=legacy-role')]);
 assert.equal(profile.identity.intro,'');assert.equal(bindings.configuration.bindings.dialogue.mode,'inherit-default');
 await assert.rejects(f.request('/api/characters/profile?characterId=unknown-role'),{status:404});
 assert.equal(f.roles.get('unknown-role'),null);
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let release;
 await page.route('**/api/self-setup',async route=>{await new Promise(r=>release=r);await route.continue();});
 await page.goto(`${f.server.origin}/#token=${f.server.token}`);
 await expect(page.getByRole('heading',{name:'正在加载…',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'需要从桌宠重新打开控制台'})).toHaveCount(0);
 { const response = page.waitForResponse('**/api/self-setup'); release(); await response; await page.unroute('**/api/self-setup'); }
 await expect(page.getByRole('heading',{name:'正在加载…',exact:true})).toHaveCount(0);
 // A fresh document must recover the token from sessionStorage and remain loading until authenticated.
 await page.route('**/api/self-setup',async route=>{await new Promise(r=>release=r);await route.continue();});
 await page.reload();await expect(page.getByRole('heading',{name:'正在加载…',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'需要从桌宠重新打开控制台'})).toHaveCount(0);
 { const response = page.waitForResponse('**/api/self-setup'); release(); await response; await page.unroute('**/api/self-setup'); }
 await page.getByRole('button',{name:'角色',exact:true}).click();
 await page.getByRole('button',{name:`查看角色 ${f.memory.characters().find(role=>role.id==='companion').label}`,exact:true}).click();
 const tabs=page.getByRole('navigation',{name:'角色详情分区'});
 await expect(page.locator('#role-preview-intro')).toBeEnabled();
 await tabs.getByRole('button',{name:'形象来源',exact:true}).click();
 await expect(page.getByRole('heading',{name:'导入 Live2D',exact:true})).toHaveCount(1);
 await tabs.getByRole('button',{name:'API 配置',exact:true}).click();
 const models=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{id:'first-model'},{id:'second-model'}]));});
 await new Promise(r=>models.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>models.close(r)));
 await page.locator('#role-api-dialogue-adapter').selectOption('openai-compatible-text');
 await page.locator('#role-api-dialogue-endpoint').fill(`http://127.0.0.1:${models.address().port}/v1`);
 await page.locator('#role-api-dialogue-auth').selectOption('none');
 await page.locator('#role-api-dialogue-discover').click();
 await expect(page.locator('#role-api-dialogue-models')).toBeVisible();
 await page.locator('#role-api-dialogue-models').selectOption('second-model');
 await expect(page.locator('#role-api-dialogue-model')).toHaveValue('second-model');
 // Seed anonymous production ledger records; the user database is never opened.
 f.store.append(scope(),[message('rwr11-raw','匿名独立记忆','companion',f.store.now())]);
 f.store.apply({...change({type:'add',id:'rwr11-memory',text:'匿名独立记忆',sourceIds:['rwr11-raw']},'rwr11-add'),createdAt:f.store.now()});
 // Navigate away and back to re-read the owner without changing the runtime role.
 await page.getByRole('button',{name:'← 所有角色',exact:true}).click();
 await page.getByRole('button',{name:`查看角色 ${f.memory.characters().find(role=>role.id==='role-b').label}`,exact:true}).click();
 await page.getByRole('button',{name:'← 所有角色',exact:true}).click();
 // Existing draft needs explicit reload here, simulating a new document as the normal supported refresh.
 await page.reload();await page.getByRole('button',{name:'角色',exact:true}).click();
 await page.getByRole('button',{name:`查看角色 ${f.memory.characters().find(role=>role.id==='companion').label}`,exact:true}).click();
 await tabs.getByRole('button',{name:'Wiki',exact:true}).click();
 const detail=page.locator('.role-memory-detail').filter({hasText:'匿名独立记忆'});
 await detail.locator('summary').click();
 await detail.getByRole('button',{name:'遗忘此条目',exact:true}).click();
 await detail.getByRole('button',{name:'确认遗忘',exact:true}).click();
 await expect(page.getByText('条目已遗忘。',{exact:true})).toBeVisible();
 await expect(page.locator('.role-memory-detail').filter({hasText:'匿名独立记忆'})).toHaveCount(0);
 assert.equal(f.store.search(scope(),'匿名独立记忆',20,'lexical').length,0);
 assert.deepEqual(errors,[]);
});

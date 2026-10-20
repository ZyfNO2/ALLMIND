import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookHttpModel} from '../../dist/providers/book-model.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {emptyEntry} from '../../dist/contracts/memory-book.js';

test('new user configures HTTP and imports original Nano Bear through UI, edits Depth, inspects and chats after reload',{timeout:90000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-preset-ui-')),repository=new FileBookRepository(directory),credentials=new BookCredentials(join(directory,'credentials')),requests=[];
  const model=new BookHttpModel(id=>credentials.get(id),async(url,init)=>{assert.ok(String(url).endsWith('/chat/completions'));const body=JSON.parse(init.body);requests.push(body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'合成预设验收回复 '+requests.length}}]}),{status:200});});
  const runtime=new BookRuntime(repository,model),server=await startBookServer({runtime,credentials,uiRoot:resolve('management')});
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close()});
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  const origin=new URL(server.url).origin;
  await page.goto(origin+'/settings');await page.getByRole('button',{name:'API Key 接入',exact:true}).click();
  const dialog=page.locator('.v2-main');
  await dialog.getByLabel('端点',{exact:true}).fill('http://127.0.0.1:1/v1');await dialog.getByLabel('模型',{exact:true}).fill('fixture-model');await dialog.getByLabel('API Key',{exact:true}).fill('synthetic-only-key');
  await dialog.getByRole('button',{name:'保存连接设置',exact:true}).click();await dialog.getByText('设置已保存并生效。',{exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'对话预设',exact:true}).click();const panel=page.getByRole('region',{name:'对话预设管理',exact:true});await panel.getByLabel('导入预设 JSON').setInputFiles(resolve('../../../validation/fixtures/prompt-presets/nano-bear-roleplay.json'));
  const imported=JSON.parse(readFileSync(resolve('../../../validation/fixtures/prompt-presets/nano-bear-roleplay.json'),'utf8'));
  await panel.getByLabel('当前角色预设',{exact:true}).selectOption({label:'nano-bear-roleplay · r1'});await panel.getByLabel('预设用户称呼').fill('验收用户');
  await panel.getByText('● +++ MAIN PROMPT',{exact:false}).click();await panel.getByLabel('正文 main',{exact:true}).fill('Use {{char}} naturally. Address {{user}}. Keep the supplied facts.');
  await panel.getByLabel('Position main',{exact:true}).selectOption('1');await panel.getByLabel('Depth main',{exact:true}).fill('0');
  await panel.getByRole('button',{name:'保存预设设置',exact:true}).click();await panel.getByText('当前预设配置已保存',{exact:false}).waitFor();
  const saved=repository.loadConfig(),selected=saved.promptPresets[0];assert.deepEqual(JSON.parse(selected.original),imported);assert.equal(selected.document.prompts.find(row=>row.identifier==='main').injection_depth,0);assert.equal(saved.characters[0].promptPresetId,selected.id);
  await panel.getByRole('button',{name:'预览最终 Prompt',exact:true}).click();await panel.getByRole('heading',{name:'Prompt Inspector',exact:true}).waitFor();assert.equal(requests.length,0);
  await page.getByRole('link',{name:'首页',exact:true}).click();await page.getByLabel('聊天消息',{exact:true}).fill('你好');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('合成预设验收回复 1',{exact:true}).waitFor();
  assert.equal(requests.length,1);assert.equal(requests[0].temperature,.8);assert.equal(requests[0].top_p,.95);assert.equal(requests[0].max_tokens,2048);
  const current=requests[0].messages.findIndex(row=>row.role==='user'&&row.content==='你好');assert.ok(current>=0);assert.equal(requests[0].messages.filter(row=>row.role==='user'&&row.content==='你好').length,1);
  assert.deepEqual(requests[0].messages[current+1],{role:'system',content:'Use ALLMIND naturally. Address 验收用户. Keep the supplied facts.'});assert.equal(requests[0].messages.at(-1).content,'</history>','relative closing tag must stay after the in-chat block');
  await page.reload();await page.getByLabel('聊天消息',{exact:true}).fill('再见');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('合成预设验收回复 2',{exact:true}).waitFor();assert.equal(requests.length,2);
  await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'对话预设',exact:true}).click();await panel.getByRole('button',{name:'预览最终 Prompt',exact:true}).click();await panel.getByRole('heading',{name:'Prompt Inspector',exact:true}).waitFor();
  const ambiguous={prompts:[{identifier:'main',role:'system',content:'Test only'}],prompt_order:[{character_id:7,order:[{identifier:'main',enabled:true}]},{character_id:8,order:[{identifier:'main',enabled:true}]}]};
  await panel.getByLabel('导入预设 JSON').setInputFiles({name:'ambiguous.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(ambiguous))});
  await panel.getByRole('group',{name:'选择导入 Order block'}).waitFor();assert.equal(await panel.getByRole('button',{name:'确认导入预设',exact:true}).isEnabled(),false);assert.equal(repository.loadConfig().promptPresets.length,1);
  await panel.getByLabel('导入 Order block',{exact:true}).selectOption('8');await panel.getByRole('button',{name:'确认导入预设',exact:true}).click();await panel.getByRole('button',{name:'保存预设设置',exact:true}).click();await panel.getByText('当前预设配置已保存',{exact:false}).waitFor();assert.equal(repository.loadConfig().promptPresets[1].orderBlock,8);
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+' settings fits '+JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('main *')].filter(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1}).slice(0,12).map(node=>({tag:node.tagName,class:node.className,width:node.getBoundingClientRect().width,text:node.textContent.slice(0,70)})))));}
  // A backend restart changes the management token. Navigation cookie renewal must recover safely.
  await page.context().addInitScript(()=>sessionStorage.setItem('pet-management-session-v1','0'.repeat(64)));await page.reload();await page.getByRole('button',{name:'对话预设',exact:true}).click();await panel.getByRole('heading',{name:'对话预设 · Prompt Compiler',exact:true}).waitFor();
  assert.equal(requests.length,2);assert.deepEqual(errors,[]);
  mkdirSync(resolve('../../../validation/output/p0'),{recursive:true});await page.setViewportSize({width:1440,height:960});await page.screenshot({path:resolve('../../../validation/output/p0/preset-settings.png'),fullPage:true});
});

test('graph range, factual edges, typed inspector and node dragging work through the production UI',{timeout:45000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'allmind-graph-ui-')),repository=new FileBookRepository(directory),scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'};
  const a=emptyEntry('world-a','wiki','测试组织','有来源的模拟设定A'),b=emptyEntry('world-b','wiki','测试地点','有来源的模拟设定B');
  a.entities=['测试组织'];b.entities=['测试地点'];a.related=['world-b'];b.related=['world-a'];a.knowledge={worldId:'demo',branch:'main',chapter:2,awareness:'heard'};b.knowledge={...a.knowledge};repository.commit(scope,{upsert:[a,b]},0,'graph-fixture');
  const runtime=new BookRuntime(repository,{async complete(){throw Error('Graph must not call model')}}),server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close()});const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(10000);
  await page.goto(new URL(server.url).origin+'/memory-book');await page.getByRole('button',{name:'知识图谱',exact:true}).click();
  await page.getByText('当前没有可见的有据关联',{exact:true}).waitFor();assert.equal(await page.locator('svg.mb-memory-graph line').count(),0);
  await page.getByLabel('图谱查看范围',{exact:true}).selectOption('management');await page.getByRole('button',{name:'查看节点：测试组织',exact:true}).waitFor();
  assert.equal(await page.getByLabel('记忆图谱画布',{exact:true}).getAttribute('data-edge-count'),'1');await page.getByRole('button',{name:'查看节点：测试组织',exact:true}).click();await page.locator('#mb-graph-detail').getByText('有来源的模拟设定A',{exact:true}).waitFor();
  const node=page.getByRole('button',{name:'查看节点：测试组织',exact:true}),before=await node.getAttribute('style'),box=await node.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+35,box.y+box.height/2+35,{steps:4});await page.mouse.up();assert.notEqual(await node.getAttribute('style'),before);
  const stable=await node.getAttribute('style');await page.getByRole('button',{name:'本轮召回',exact:true}).click();assert.equal(await node.getAttribute('style'),stable);await page.getByText(/当前没有同角色、同会话、同修订/).waitFor();
  assert.equal(repository.loadConfig().characters[0].knowledgeView,undefined,'browse cannot change model knowledge');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByLabel('图谱查看范围',{exact:true}).selectOption('known');await page.getByText('当前没有可见的有据关联',{exact:true}).waitFor();
});

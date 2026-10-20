import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {FactWikiService} from '../../dist/memory/fact-wiki.js';
import {emptyEntry} from '../../dist/contracts/memory-book.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';

// No external provider or personal data: production HTTP routes and UI, explicit model fixture.
test('V2 blank-user journey: role, inline connection, notes, chat, archive, restore, scope and responsive layout',{timeout:120000},async t=>{
 const output=resolve(process.env.ALLMIND_UI_TEST_OUTPUT??'.local/ui-v2-browser');mkdirSync(output,{recursive:true});
 const directory=mkdtempSync(join(output,'data-')),repository=new FileBookRepository(directory);
 const calls=[];const runtime=new BookRuntime(repository,{async complete(binding,messages){calls.push({model:binding.model,messages});return '这是本地自动化 fixture 的回复。'}});
 const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});
 assert.equal((await fetch(new URL('/api/memory-book/v1/sessions/archive',server.url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({characterId:'aika',sessionId:'web-chat',archived:true})})).status,401);
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close()});
 const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const nav=(name)=>page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name});
 const shot=async name=>{await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(output,name+'.png'),fullPage:true})};
 const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.goto(server.url);await page.getByRole('button',{name:'连接对话模型',exact:true}).waitFor();assert.equal(await page.locator('nav[aria-label="主导航"] a[href="/chat"]').count(),0);await shot('01-blank-home');
 await nav('角色').click();await page.getByRole('button',{name:'新增角色',exact:true}).click();await page.getByRole('textbox',{name:'新角色名称'}).fill('小凛');await page.getByRole('button',{name:'新建角色',exact:true}).click();
 await page.getByRole('button',{name:'编辑角色资料',exact:true}).click();await page.getByRole('textbox',{name:'简介',exact:true}).fill('一个用于验收 V2 操作流程的合成角色。');await page.getByRole('button',{name:'保存角色',exact:true}).click();await page.getByRole('button',{name:'编辑角色资料',exact:true}).waitFor();await shot('02-role');
 const roleId=repository.loadConfig().currentCharacterId;
 await nav('设置').click();await page.getByRole('button',{name:'API Key 接入',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);
 assert.equal(repository.loadConfig().mainModel,null); // Merely choosing API mode must not create a dirty/empty binding.
 await page.getByRole('textbox',{name:'端点',exact:true}).fill('http://127.0.0.1:9999/v1');await page.getByLabel('模型',{exact:true}).fill('fixture-ui-v2');
 await page.getByRole('button',{name:'测试连接',exact:true}).click();await page.getByText(/请求成功 ·/).waitFor();assert.equal(repository.loadConfig().mainModel,null);
 await page.getByRole('button',{name:'保存连接设置',exact:true}).click();await page.getByRole('button',{name:'开始对话',exact:true}).waitFor();assert.equal(repository.loadConfig().mainModel.model,'fixture-ui-v2');await shot('03-inline-settings');
 await page.getByRole('button',{name:'ChatGPT 网页接入',exact:true}).click();await page.getByText('ChatGPT 普通 Chat',{exact:true}).waitFor();assert.equal(repository.loadConfig().mainModel.model,'fixture-ui-v2');
 await page.getByRole('button',{name:'对话预设',exact:true}).click();await shot('04-presets');
 await nav('记忆').click();await page.getByRole('button',{name:'＋ 新建笔记',exact:true}).click();await page.getByRole('textbox',{name:'标题',exact:true}).fill('周末的约定');await page.getByRole('textbox',{name:'正文',exact:true}).fill('这是一条合成验收笔记，不代表真实共同经历。');await page.getByRole('button',{name:'保存条目',exact:true}).click();await page.getByRole('button',{name:'编辑当前笔记',exact:true}).waitFor();
 assert.equal(repository.snapshot({characterId:roleId,pairingId:'local-user',sessionId:'web-chat'}).entries.some(row=>row.title==='周末的约定'),true);await shot('05-notes');await noOverflow();
 await page.getByRole('button',{name:/^陪伴记录/}).click();await page.getByRole('button',{name:'＋ 新建笔记',exact:true}).click();await page.getByRole('textbox',{name:'标题',exact:true}).fill('手动陪伴记录');await page.getByRole('textbox',{name:'正文',exact:true}).fill('用户手动添加的合成记录。');await page.getByRole('button',{name:'保存条目',exact:true}).click();await page.getByRole('button',{name:'编辑当前笔记',exact:true}).waitFor();assert.equal(repository.snapshot({characterId:roleId,pairingId:'local-user',sessionId:'web-chat'}).entries.find(row=>row.title==='手动陪伴记录').pairingId,'local-user');
 await page.getByRole('button',{name:/^我的知识库/}).click();
 await page.getByRole('button',{name:'知识图谱',exact:true}).click();await page.locator('.knowledge-workspace').waitFor();await shot('06-graph');await noOverflow();
 await page.getByRole('button',{name:'日常整理',exact:true}).click();await page.getByRole('heading',{name:'日常整理',exact:true}).waitFor();await shot('07-organize');
 await nav('首页').click();await page.getByRole('textbox',{name:'聊天消息',exact:true}).fill('V2 自动化会话验收');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('这是本地自动化 fixture 的回复。',{exact:true}).waitFor();await page.getByRole('button',{name:'会话操作 ···',exact:true}).waitFor({state:'visible'});await shot('08-chat');
 await page.getByRole('button',{name:'会话操作 ···',exact:true}).click();await page.getByRole('button',{name:'归档当前会话'}).click();await page.getByRole('button',{name:'查看归档 →',exact:true}).click();await page.getByRole('button',{name:'恢复到最近对话',exact:true}).waitFor();await shot('09-archive');
 await page.reload(); // Group selection is navigation state, choose it again after refresh.
 await page.getByRole('navigation',{name:'设置分组'}).getByRole('button',{name:'归档的会话',exact:true}).click();await page.getByRole('button',{name:'恢复到最近对话',exact:true}).click();await page.getByText('还没有归档的会话。',{exact:true}).waitFor();
 await nav('首页').click();await page.getByRole('complementary',{name:'最近对话'}).getByRole('button',{name:/V2 自动化会话验收/}).click();await page.getByText('这是本地自动化 fixture 的回复。',{exact:true}).waitFor();await page.reload();await page.getByText('这是本地自动化 fixture 的回复。',{exact:true}).waitFor();
 await page.getByRole('combobox',{name:'当前角色',exact:true}).selectOption('aika');await page.getByRole('heading',{name:'和 ALLMIND 说点什么',exact:true}).waitFor();assert.equal(await page.getByText('这是本地自动化 fixture 的回复。',{exact:true}).count(),0);
 await page.getByRole('combobox',{name:'当前角色',exact:true}).selectOption(roleId);await page.getByText('这是本地自动化 fixture 的回复。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'切换会话',exact:true}).click();await page.getByRole('dialog',{name:'会话记录'}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
 for(const width of [1024,390]){await page.setViewportSize({width,height:900});await noOverflow();await shot('10-home-'+width);await nav('设置').click();await noOverflow();await shot('11-settings-'+width);await nav('记忆').click();await noOverflow();await shot('12-memory-'+width);await nav('首页').click()}
 await page.setViewportSize({width:1440,height:960});
 const scope={characterId:roleId,pairingId:'local-user',sessionId:'web-chat'};
 await page.getByRole('button',{name:'会话操作 ···',exact:true}).click();await page.getByRole('button',{name:'清除本地会话…',exact:true}).click();
 await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(repository.readSession(scope).length,1);
 await page.getByRole('button',{name:'会话操作 ···',exact:true}).click();await page.getByRole('button',{name:'清除本地会话…',exact:true}).click();await page.getByRole('button',{name:'确认清除本地会话',exact:true}).click();
 await page.getByRole('heading',{name:'和 小凛 说点什么',exact:true}).waitFor();assert.equal(repository.readSession(scope).length,0);assert.equal(repository.snapshot(scope).entries.some(row=>row.title==='周末的约定'),true);
 assert.deepEqual(errors,[]);assert.ok(calls.length>=2);writeFileSync(join(output,'result.json'),JSON.stringify({status:'PASS',provider:'fixture',calls:calls.length,pageErrors:errors,roleId},null,2));
});


test('V2 note sources and backlinks open real owned records without writing or calling a model',{timeout:30000},async t=>{
 const output=resolve(process.env.ALLMIND_UI_TEST_OUTPUT??'.local/ui-v2-browser');mkdirSync(output,{recursive:true});
 const repository=new FileBookRepository(mkdtempSync(join(output,'evidence-'))),scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'};
 const wiki=new FactWikiService(repository),preview=wiki.preview(scope,{sourceId:'read-only-source',title:'合成验收来源',text:'饮品：红茶',private:true});wiki.apply(scope,preview.id,'source-seed');
 const book=repository.snapshot(scope);assert.ok(book.entries.length);const note=emptyEntry('backlink','wiki','另一篇笔记','这条链接由合成验收明确提供。');note.related=[book.entries[0].id];repository.commit(scope,{upsert:[note]},book.revision,'backlink-seed');
 const revision=repository.snapshot(scope).revision;let calls=0;
 const server=await startBookServer({runtime:new BookRuntime(repository,{async complete(){calls++;throw Error('Reading must not call a model')}}),credentials:new BookCredentials(join(output,'read-only-credentials')),uiRoot:resolve('management')});
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close()});
 const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(10000);await page.goto(server.url);await page.getByRole('link',{name:'记忆',exact:true}).click();
 const evidence=page.getByRole('complementary',{name:'关联与来源'});await evidence.getByRole('button',{name:'合成验收来源 →',exact:true}).click();
 const modal=page.getByRole('dialog',{name:'原始来源',exact:true});await modal.getByText('饮品：红茶',{exact:true}).waitFor();await page.keyboard.press('Escape');
 await evidence.getByRole('button',{name:'另一篇笔记 →',exact:true}).click();await page.getByRole('heading',{name:'另一篇笔记',exact:true}).waitFor();
 assert.equal(repository.snapshot(scope).revision,revision);assert.equal(calls,0);await page.screenshot({path:join(output,'13-note-evidence.png'),fullPage:true});
});

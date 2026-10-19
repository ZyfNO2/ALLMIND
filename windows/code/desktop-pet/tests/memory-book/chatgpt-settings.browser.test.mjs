import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { BookRuntime } from '../../dist/app/book-runtime.js';
import { BookCredentials } from '../../dist/management/book-credentials.js';
import { startBookServer } from '../../dist/management/book-server.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../dist/contracts/memory-book.js';

test('actual settings UI: explicit bridge/CLI selection, authenticated pairing and active-request account-switch guard', { timeout: 60000 }, async t => {
  const root = resolve('.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const repository = new FileBookRepository(mkdtempSync(join(root, 'bridge-settings-')));
  const config = repository.loadConfig(); repository.commitConfig({ ...config, chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE } }, config.revision, 'seed');
  const runtime = new BookRuntime(repository, { complete: async () => { throw new Error('Settings must not call a model'); } });
  let active = false; let resets = 0;
  let embeddedLogins=0;
  const server = await startBookServer({ runtime, credentials: new BookCredentials(join(repository.directory, 'credentials')), uiRoot: resolve('management'),
    chatgptWeb: { probe: async () => ({ state: 'signed-in', checkedAt: new Date().toISOString() }), openLoginPage: async () => {}, currentRequest: () => active ? { requestId: 'active', submitted: 'yes' } : null },
    chatgptEmbedded:{login:async()=>{embeddedLogins++;},probe:async()=>({ready:true,temporary:true})},
    chatgptPairing: async reset => { if (reset) resets++; return { code: 'a'.repeat(64), url: 'http://127.0.0.1:17643', connected: false }; } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); repository.close(); });
  const page = await browser.newPage(); page.setDefaultTimeout(10000); await page.goto(server.url);
  await page.getByRole('link', { name: '设置', exact: true }).click();await page.getByRole('button',{name:'连接模型',exact:true}).click();await page.getByRole('dialog',{name:'连接文字主模型',exact:true}).getByRole('button',{name:'ChatGPT 网页接入',exact:true}).click();
  const card = page.getByRole('region', { name: 'ChatGPT 普通 Chat', exact: true });
  assert.equal(await card.getByLabel('ChatGPT 连接方式', { exact: true }).inputValue(), 'bridge');
  assert.equal(await card.getByLabel('正式聊天模式',{exact:true}).inputValue(),'temporary');
  await card.getByRole('button',{name:'准备独立页面登录（不切换来源）',exact:true}).click();
  assert.equal(embeddedLogins,1);assert.equal(repository.loadConfig().chatgptWeb.transport,'bridge');
  await card.getByRole('button',{name:'检查独立页面',exact:true}).click();
  await card.getByText('独立页面已就绪；可选择独立常驻页面并保存',{exact:true}).waitFor();
  await card.getByRole('button', { name: '显示本地配对码', exact: true }).click();
  assert.equal(await card.getByLabel('本地配对码', { exact: true }).inputValue(), 'a'.repeat(64));
  await card.getByRole('button', { name: '隐藏', exact: true }).click();
  assert.equal(await card.getByLabel('本地配对码', { exact: true }).count(), 0);
  const origin = new URL(server.url).origin;
  assert.equal((await fetch(origin+'/api/memory-book/v1/chatgpt-web/embedded/login',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(origin + '/api/memory-book/v1/chatgpt-web/pairing', { method: 'POST', body: '{}' })).status, 401);
  await card.getByRole('button', { name: '更换浏览器配置（重新配对）', exact: true }).click();
  await page.getByText('旧浏览器配对已撤销，请在目标配置中使用新配对码。', { exact: true }).waitFor(); assert.equal(resets, 1);
  active = true;
  await card.getByRole('button', { name: '更换浏览器配置（重新配对）', exact: true }).click();
  await page.getByRole('alert').filter({hasText:'网页请求尚未确认结束'}).waitFor();
  assert.equal(await page.getByRole('alert').filter({hasText:'网页请求尚未确认结束'}).evaluate(node => node.firstChild.textContent), '网页请求尚未确认结束，不能更换浏览器配置。'); assert.equal(resets, 1);
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get('token');
  const saved = repository.loadConfig();
  const response = await fetch(origin + '/api/memory-book/v1/runtime', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...saved, chatgptWeb: { ...saved.chatgptWeb, transport: 'cli' } }, expectedRevision: saved.revision, operationId: 'blocked-switch' }) });
  assert.equal(response.ok, false); assert.equal(repository.loadConfig().chatgptWeb.transport, 'bridge');
  active = false;
  await card.getByLabel('ChatGPT 连接方式', { exact: true }).selectOption('cli');
  await card.getByLabel('正式聊天模式',{exact:true}).selectOption('regular');
  await card.getByText('备选工具连接设置', { exact: true }).waitFor();
  assert.equal(repository.loadConfig().chatgptWeb.transport, 'bridge', 'Draft selection must not change the source until save');
  await page.getByRole('button', { name: '保存连接设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mb-save-bar small')?.textContent.includes('当前配置已保存'));
  assert.equal(repository.loadConfig().chatgptWeb.transport, 'cli');
  assert.equal(repository.loadConfig().chatgptWeb.conversationMode,'regular');
});

test('project settings check and bind only current role, retain default mode, and block in-flight rebinding',{timeout:60000},async t=>{
  const root=resolve('.local/memory-book-tests');mkdirSync(root,{recursive:true});
  const repository=new FileBookRepository(mkdtempSync(join(root,'project-settings-'))),initial=repository.loadConfig();
  repository.commitConfig({...initial,chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded'}},initial.revision,'seed-project');
  const runtime=new BookRuntime(repository,{complete:async()=>{throw Error('Settings must not send a message');}});
  let active=false,checks=0;
  const projectId='g-p-'+'a'.repeat(32),account='b'.repeat(64);
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(repository.directory,'credentials')),uiRoot:resolve('management'),chatgptWeb:{probe:async()=>({state:'signed-in',checkedAt:new Date().toISOString()}),openLoginPage:async()=>{},currentRequest:()=>active?{requestId:'pending',submitted:'yes'}:null,inspectProject:async id=>{checks++;assert.equal(id,projectId);return {projectId,name:'Project Test',account,memory:'unverified'};}}});
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close();});
  const page=await browser.newPage();page.setDefaultTimeout(10000);await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'连接模型',exact:true}).click();await page.getByRole('dialog',{name:'连接文字主模型',exact:true}).getByRole('button',{name:'ChatGPT 网页接入',exact:true}).click();
  const region=page.getByRole('region',{name:'对话所属 ChatGPT 项目',exact:true});
  await region.getByLabel('已有项目链接',{exact:true}).fill('https://chatgpt.com/g/'+projectId+'-test/project');
  await region.getByRole('button',{name:'检查项目链接',exact:true}).click();
  await region.getByRole('button',{name:'保存项目绑定',exact:true}).waitFor();assert.equal(checks,1);assert.equal(repository.loadConfig().chatgptProjects,undefined);
  await region.getByRole('checkbox',{name:'我已确认此项目使用仅项目记忆',exact:true}).check();
  await region.getByRole('button',{name:'保存项目绑定',exact:true}).click();await region.getByText('项目绑定已保存并回读。',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.mb-save-bar small')?.textContent.includes('当前配置已保存'));
  const saved=repository.loadConfig();assert.equal(saved.chatgptProjects[0].characterId,saved.currentCharacterId);assert.equal(saved.chatgptProjects[0].memory,'user-confirmed-project-only');assert.equal(saved.chatgptWeb.conversationMode,'temporary','explicit role project does not rewrite the global default');
  active=true;await region.getByRole('button',{name:'暂停项目绑定',exact:true}).click();await page.getByRole('alert').filter({hasText:/未确认|未决|进行|请求/}).waitFor();assert.equal(repository.loadConfig().chatgptProjects[0].enabled,true);
  const url=new URL(server.url);assert.equal((await fetch(url.origin+'/api/memory-book/v1/chatgpt-web/projects/check',{method:'POST',body:JSON.stringify({url:'https://chatgpt.com/g/'+projectId+'/project'})})).status,401);
});

test('thinking HTTP requires auth, exact revision and valid operation before native changes; generation blocks switching',async t=>{
  const root=resolve('.local/memory-book-tests');mkdirSync(root,{recursive:true});const repository=new FileBookRepository(mkdtempSync(join(root,'thinking-http-'))),initial=repository.loadConfig();
  repository.commitConfig({...initial,chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded'},mainModel:{kind:'chatgpt-web',baseUrl:'chatgpt-web',model:'GPT-6',credentialId:'none',inputTokens:4096,outputTokens:512}},initial.revision,'seed-thinking');
  const runtime=new BookRuntime(repository,{complete:async()=>{throw Error('Settings must not invoke model');}});let level=0,active=false,setCalls=0;
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(repository.directory,'credentials')),uiRoot:resolve('management'),chatgptWeb:{probe:async()=>({state:'signed-in',checkedAt:new Date().toISOString()}),openLoginPage:async()=>{},currentRequest:()=>active?{requestId:'r',submitted:'yes'}:null,thinking:async(choice,model)=>{assert.equal(model,'GPT-6');if(choice!==undefined){setCalls++;level=choice;}return {level,label:['即时','中','高'][level],options:[0,1,2].map(level=>({level,label:['即时','中','高'][level]}))};}}});
  t.after(async()=>{await server.close();repository.close();});const url=new URL(server.url),endpoint=url.origin+'/api/memory-book/v1/chatgpt-web/thinking',headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
  assert.equal((await fetch(endpoint)).status,401);const current=await(await fetch(endpoint,{headers})).json();
  const set=body=>fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await set({level:1,expectedRevision:current.revision,operationId:''})).ok,false);assert.equal(setCalls,0);
  assert.equal((await set({level:1,expectedRevision:current.revision-1,operationId:'stale'})).ok,false);assert.equal(setCalls,0);
  const result=await set({level:1,expectedRevision:current.revision,operationId:'set-medium'});assert.equal(result.ok,true);assert.equal((await result.json()).level,1);assert.equal(repository.loadConfig().chatgptWeb.thinkingLevel,1);assert.equal(setCalls,1);
  active=true;assert.equal((await set({level:2,expectedRevision:repository.loadConfig().revision,operationId:'busy'})).ok,false);assert.equal(setCalls,1);
});

test('V4 settings retain ordinary archive mode, expose warmup/stop and save only verified thinking options',{timeout:60000},async t=>{
  mkdirSync('.local/memory-book-tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync(resolve('.local/memory-book-tests/v4-source-'))),initial=repository.loadConfig();
  repository.commitConfig({...initial,mainModel:{kind:'chatgpt-web',baseUrl:'chatgpt-web',model:'GPT-6',credentialId:'none',inputTokens:4096,outputTokens:512},chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded',conversationMode:'regular',temporaryChatTests:false}},initial.revision,'v4-source-seed');
  let level=0,active=false,cancelled=0,changes=0;
  const runtime=new BookRuntime(repository,{complete:async()=>{throw Error('Settings must not send a chat');}});
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(repository.directory,'credentials')),uiRoot:resolve('management'),chatgptWeb:{
    probe:async()=>({state:'signed-in',checkedAt:new Date().toISOString(),detail:active?'已有请求，等待确认停止':'后台页面已预热 · 角色项目',...(active?{activeRequest:{requestId:'active',submitted:'yes'}}:{})}),openLoginPage:async()=>{},currentRequest:()=>active?{requestId:'active',submitted:'yes'}:null,
    cancel:async id=>{assert.equal(id,'active');cancelled++;active=false;return {kind:'cancelled',confirmed:true,message:'已确认停止。'}},
    thinking:async(choice,model)=>{assert.equal(model,'GPT-6');if(choice!==undefined){assert.ok([0,2].includes(choice));level=choice;changes++}return {level,label:level===0?'即时':'高',options:[{level:0,label:'即时'},{level:2,label:'高'}]}}
  }});
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close()});const page=await browser.newPage();page.setDefaultTimeout(10000);await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'连接模型',exact:true}).click();await page.getByRole('dialog',{name:'连接文字主模型',exact:true}).getByRole('button',{name:'ChatGPT 网页接入',exact:true}).click();
  const card=page.getByRole('region',{name:'ChatGPT 普通 Chat',exact:true});await card.getByRole('button',{name:'检查已保存来源状态',exact:true}).click();await card.getByText('signed-in · 后台页面已预热 · 角色项目',{exact:true}).waitFor();
  const read=page.getByRole('button',{name:'读取可用思考强度',exact:true});await read.click();await page.getByRole('button',{name:'高',exact:true}).click();await page.getByText('思考强度已核对并保存。',{exact:true}).waitFor();assert.equal(changes,1);assert.equal(repository.loadConfig().chatgptWeb.thinkingLevel,2);
  assert.equal(repository.loadConfig().chatgptWeb.conversationMode,'regular');assert.equal(repository.loadConfig().chatgptWeb.temporaryChatTests,false);
  await page.getByRole('button',{name:'关闭连接文字主模型',exact:true}).click();await page.getByLabel('回复语言',{exact:true}).selectOption('ja-JP');await page.getByRole('button',{name:'连接模型',exact:true}).click();await page.getByRole('dialog',{name:'连接文字主模型',exact:true}).getByRole('button',{name:'ChatGPT 网页接入',exact:true}).click();assert.equal(await read.isDisabled(),true,'unsaved draft must prevent thinking from overwriting settings');await page.getByRole('button',{name:'放弃连接更改',exact:true}).click();assert.equal(await read.isEnabled(),true);
  active=true;await card.getByRole('button',{name:'检查已保存来源状态',exact:true}).click();await card.getByRole('button',{name:'停止并核对结果',exact:true}).click();await card.getByText('已确认停止。',{exact:true}).waitFor();assert.equal(cancelled,1);assert.equal(await card.getByRole('button',{name:'停止并核对结果',exact:true}).count(),0);
});

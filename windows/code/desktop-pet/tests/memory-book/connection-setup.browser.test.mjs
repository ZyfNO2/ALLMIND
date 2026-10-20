import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookHttpModel} from '../../dist/providers/book-model.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {DEFAULT_CHATGPT_WEB_SOURCE} from '../../dist/contracts/memory-book.js';
import {ChatgptExtensionHost} from '../../dist/providers/chatgpt-extension-host.js';
import {ChatgptBackgroundBridge} from '../../dist/providers/chatgpt-background-bridge.js';
import {ChatgptWebModel} from '../../dist/providers/chatgpt-web-model.js';
import {writeFileSync} from 'node:fs';

test('browsing connection types never creates an empty model draft or overwrites a saved binding',{timeout:60000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  for(const mode of ['empty','web','api']){
    const directory=resolve(mkdtempSync('.local/ui-v4/tests/connection-browse-'));
    const repository=new FileBookRepository(directory),initial=repository.loadConfig();
    if(mode!=='empty')repository.commitConfig({...initial,...(mode==='web'?{chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE}}:{}),mainModel:{kind:mode==='web'?'chatgpt-web':'http',baseUrl:mode==='web'?'chatgpt-web':'http://127.0.0.1:1/v1',model:mode+'-saved',credentialId:mode==='web'?'none':'main-key',inputTokens:16384,outputTokens:4096}},initial.revision,'seed');
    const before=repository.loadConfig();
    const server=await startBookServer({runtime:new BookRuntime(repository,{async complete(){throw Error('Browsing must not call a model')}}),credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});
    const page=await browser.newPage();page.setDefaultTimeout(10000);
    let confirmations=0;page.on('dialog',async dialog=>{confirmations++;await dialog.dismiss()});
    try{
      await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();
      await page.getByRole('button',{name:'API Key 接入',exact:true}).click();
      const dialog=page.locator('.v2-main');
      await dialog.getByLabel('端点',{exact:true}).waitFor();
      for(const name of ['ChatGPT 网页接入','API Key 接入'])await dialog.getByRole('button',{name,exact:true}).click();
      assert.match(await page.locator('.mb-save-bar').innerText(),/当前配置已保存/);
      assert.equal(await dialog.getByRole('button',{name:'放弃连接更改',exact:true}).isDisabled(),true);
      if(mode==='empty')assert.equal(await page.getByText('已绑定 ·',{exact:true}).count(),0);
      assert.deepEqual(repository.loadConfig(),before);
      await page.keyboard.press('Escape');await page.getByRole('link',{name:'首页',exact:true}).click();
      await page.getByRole('link',{name:'设置',exact:true}).click();assert.equal(confirmations,0);
      await page.getByRole('button',{name:'API Key 接入',exact:true}).click();
      await dialog.getByLabel('端点',{exact:true}).fill('http://127.0.0.1:2/v1');
      assert.equal(await dialog.getByRole('button',{name:'放弃连接更改',exact:true}).isEnabled(),true);
      await dialog.getByRole('button',{name:'ChatGPT 网页接入',exact:true}).click();
      await dialog.getByRole('button',{name:'API Key 接入',exact:true}).click();
      assert.equal(await dialog.getByLabel('端点',{exact:true}).inputValue(),'http://127.0.0.1:2/v1');
      await dialog.getByRole('button',{name:'放弃连接更改',exact:true}).click();
      assert.deepEqual(repository.loadConfig(),before);
      assert.match(await page.locator('.mb-save-bar').innerText(),/当前配置已保存/);
    }finally{await page.close();await server.close();repository.close()}
  }
});

test('visible API Key path replaces a web binding despite a pending web receipt, saves key, tests and chats via production HTTP',{timeout:60000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/connection-api-'));
  const repository=new FileBookRepository(directory),credentials=new BookCredentials(join(directory,'credentials')),initial=repository.loadConfig();
  repository.commitConfig({...initial,chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'bridge'},mainModel:{kind:'chatgpt-web',baseUrl:'chatgpt-web',credentialId:'none',model:'old-web-model',inputTokens:16384,outputTokens:4096}},initial.revision,'seed-web');
  const requests=[];const provider=createServer(async(request,response)=>{try{
    assert.equal(request.headers.authorization,'Bearer synthetic-api-key');
    response.setHeader('Content-Type','application/json');
    if(request.url==='/v1/models'){requests.push('models');response.end(JSON.stringify({data:[{id:'api-fixture-model'}]}));return;}
    assert.equal(request.url,'/v1/chat/completions');let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw);assert.equal(body.model,'api-fixture-model');requests.push('chat');
    response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'API 链路合成回复'}}]}));
  }catch(error){response.writeHead(500);response.end(String(error));}});await new Promise(done=>provider.listen(0,'127.0.0.1',done));
  const runtime=new BookRuntime(repository,new BookHttpModel(id=>credentials.get(id)));let pending=true;
  const server=await startBookServer({runtime,credentials,uiRoot:resolve('management'),chatgptWeb:{probe:async()=>({state:'not-connected',checkedAt:new Date().toISOString()}),openLoginPage:async()=>{},currentRequest:()=>pending?{requestId:'orphan-web',submitted:'unknown'}:null,cancel:async()=>{pending=false;return {kind:'cancelled',confirmed:true,message:'已确认停止。'}}}});
  assert.equal((await fetch(new URL('/api/memory-book/v1/chatgpt-web/active-request',server.url))).status,401,'local receipt status remains authenticated');
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();provider.closeAllConnections();await new Promise(done=>provider.close(done));repository.close()});
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();
  const dialog=page.locator('.v2-main');
  await dialog.getByRole('region',{name:'网页请求恢复',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'API Key 接入',exact:true}).click();
  const card=dialog.locator('.mb-model-card');await card.getByLabel('端点',{exact:true}).fill(`http://127.0.0.1:${provider.address().port}/v1`);await card.getByLabel('API Key',{exact:true}).fill('synthetic-api-key');
  await card.getByRole('button',{name:'获取模型',exact:true}).click();await card.getByLabel('已获取的模型',{exact:true}).selectOption('api-fixture-model');
  await card.getByRole('button',{name:'测试连接',exact:true}).click();await card.getByText('测试成功',{exact:true}).waitFor();assert.equal(repository.loadConfig().mainModel.kind,'chatgpt-web','test does not save draft');
  await dialog.getByRole('button',{name:'保存连接设置',exact:true}).click();await dialog.getByText('设置已保存并生效。',{exact:true}).waitFor();
  assert.equal(repository.loadConfig().mainModel.kind,'http');assert.equal(await credentials.get('main-key'),'synthetic-api-key');assert.equal(pending,true,'API save must not erase web receipt');assert.equal(repository.loadConfig().chatgptWeb.transport,'bridge');
  await page.screenshot({path:join(directory,'api-setup.png'),fullPage:true});await page.keyboard.press('Escape');await page.getByRole('link',{name:'首页',exact:true}).click();await page.getByLabel('聊天消息',{exact:true}).fill('通过 API 聊天');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('API 链路合成回复',{exact:true}).waitFor();
  assert.deepEqual(requests,['models','chat','chat']);await page.reload();await page.getByRole('link',{name:'设置',exact:true}).click();assert.equal(await dialog.getByLabel('API Key',{exact:true}).inputValue(),'','saved key is not echoed');assert.equal(await dialog.getByLabel('端点',{exact:true}).inputValue(),`http://127.0.0.1:${provider.address().port}/v1`);
});

test('independent setup exposes login, verifies readiness before binding and tests saved source; pending recovery needs no remote probe',{timeout:60000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/connection-embedded-')),repository=new FileBookRepository(directory);let ready=false,logins=0,probeCalls=0,modelCalls=0,pending=true,holdProbe=false,releaseProbe;
  const runtime=new BookRuntime(repository,{async complete(){modelCalls++;return '独立页面合成回复'}});
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management'),chatgptEmbedded:{login:async()=>{logins++},probe:async()=>{if(holdProbe)await new Promise(done=>releaseProbe=done);return {ready,detail:'请在独立窗口完成登录。'}}},chatgptWeb:{probe:async()=>{probeCalls++;throw Error('unreachable remote')},openLoginPage:async()=>{},currentRequest:()=>pending?{requestId:'old-request',submitted:'unknown'}:null,cancel:async()=>{pending=false;return {kind:'cancelled',confirmed:true,message:'已确认停止。'}}}});
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close()});const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'ChatGPT 网页接入',exact:true}).click();
  const dialog=page.locator('.v2-main');const recovery=dialog.getByRole('region',{name:'网页请求恢复',exact:true});await recovery.waitFor();assert.equal(probeCalls,0);await recovery.getByRole('button',{name:'停止并核对结果',exact:true}).click();await recovery.waitFor({state:'detached'});
  assert.equal(await dialog.getByLabel('ChatGPT 网页模型',{exact:true}).inputValue(),'current','fresh web setup must not invent an account model name');
  await dialog.getByLabel('ChatGPT 连接方式',{exact:true}).selectOption('embedded');await dialog.getByRole('button',{name:'打开独立登录窗口',exact:true}).click();await dialog.getByText(/登录窗口已打开/).waitFor();assert.equal(logins,1);
  await dialog.getByRole('button',{name:'检查登录并绑定独立页面',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'请在独立窗口完成登录'}).waitFor();assert.equal(repository.loadConfig().mainModel,null);
  ready=true;await dialog.getByRole('button',{name:'检查登录并绑定独立页面',exact:true}).click();await dialog.getByText(/独立页面已登录，文字主模型已绑定并保存/).waitFor();assert.equal(repository.loadConfig().chatgptWeb.transport,'embedded');assert.equal(repository.loadConfig().mainModel.kind,'chatgpt-web');
  await dialog.getByRole('button',{name:'测试网页连接',exact:true}).click();await dialog.getByText(/网页连接测试成功/).waitFor();assert.equal(modelCalls,1);
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1));}
  await page.screenshot({path:join(directory,'independent-setup.png'),fullPage:true});
  await page.setViewportSize({width:1280,height:900});holdProbe=true;const revision=repository.loadConfig().revision;
  await dialog.getByRole('button',{name:'检查登录并绑定独立页面',exact:true}).click();
  await dialog.getByText('正在处理网页操作；可以继续编辑 API 配置或关闭此面板。',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'API Key 接入',exact:true}).click();await dialog.getByLabel('端点',{exact:true}).fill('http://127.0.0.1:12345/v1');
  const deadline=Date.now()+3000;while(!releaseProbe&&Date.now()<deadline)await new Promise(done=>setTimeout(done,10));assert.equal(typeof releaseProbe,'function');releaseProbe();
  await dialog.getByRole('alert').filter({hasText:'已切换到 API 接入，未保存旧网页操作。'}).waitFor();assert.equal(repository.loadConfig().revision,revision);assert.equal(await dialog.getByLabel('端点',{exact:true}).inputValue(),'http://127.0.0.1:12345/v1','late web result preserves editable API draft');
});

test('persisted dead Chrome tab recovers through authenticated extension error, binds already-ready independent page and sends one new chat',{timeout:60000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/connection-dead-tab-')),repository=new FileBookRepository(directory),initial=repository.loadConfig();
  repository.commitConfig({...initial,mainModel:{kind:'chatgpt-web',baseUrl:'chatgpt-web',credentialId:'none',model:'GPT-6',inputTokens:16384,outputTokens:4096},chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'bridge',authorizedPurposes:['reply','wiki']}},initial.revision,'old-config');
  const receiptPath=join(directory,'web-receipts.json');writeFileSync(receiptPath,JSON.stringify({used:['lost-request'],active:{id:'lost-request',submitted:'yes'}}));
  const extension=new ChatgptExtensionHost({port:0,timeoutMs:5000}),pair=await extension.pairing(),controller=new AbortController();
  const extensionActions=[];let submits=0;
  const post=(path,body)=>fetch(pair.url+path,{method:'POST',headers:{Origin:'chrome-extension://'+'a'.repeat(32),Authorization:'Bearer '+pair.code},body:JSON.stringify({client:'dead-tab-fixture',...body}),signal:controller.signal});
  let connected;const ready=new Promise(done=>connected=done);
  const relay=(async()=>{try{let response=post('/pull',{});await new Promise(done=>setTimeout(done,30));connected();for(;;){const command=await(await response).json();if(!command.idle){extensionActions.push(command.action);await post('/result',{id:command.id,error:'Error: No tab with id: 628202419.'})}response=post('/pull',{})}}catch(error){if(!controller.signal.aborted)throw error}})();await ready;
  const config=()=>repository.loadConfig().chatgptWeb;
  const bridge=new ChatgptBackgroundBridge({config,receiptPath,pollMs:1,intervalMs:0,pageHost:{login:async()=>{},navigate:async()=>{},execute:async(action,input)=>{if(config().transport==='bridge')return extension.execute(action,input);if(action==='probe')return{ready:true,temporary:true,hasTurns:false};if(action==='prepare')return{ready:true,temporary:true};if(action==='model')return{model:input.model};if(action==='submit'){submits++;return{submitted:true}};if(action==='read')return{state:'completed',text:'独立页面恢复合成回复',conversationId:'fixture'};return{ok:true}}}});
  const model=new ChatgptWebModel({bridge,config,runtime:()=>repository.loadConfig()}),runtime=new BookRuntime(repository,model);
  const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management'),chatgptWeb:bridge,chatgptEmbedded:{login:async()=>{},probe:async()=>({ready:true})}});
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();controller.abort();await relay;await extension.close();repository.close()});
  const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(10000);await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();
  const dialog=page.locator('.v2-main');await dialog.getByRole('region',{name:'网页请求恢复',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'检查独立页面',exact:true}).click();await dialog.getByRole('button',{name:'绑定已就绪的独立页面',exact:true}).click();
  await dialog.getByText('独立页面已登录，文字主模型已绑定并保存。现在可以测试网页连接。',{exact:true}).waitFor();
  assert.equal(repository.loadConfig().chatgptWeb.transport,'embedded');assert.equal(bridge.currentRequest(),null);assert.equal(bridge.requestStatus('lost-request').outcome,'unknown');assert.deepEqual(extensionActions,['submission']);assert.equal(submits,0,'switch never resends the old message');
  await page.screenshot({path:join(directory,'recovered.png'),fullPage:true});await page.keyboard.press('Escape');await page.getByRole('link',{name:'首页',exact:true}).click();await page.getByLabel('聊天消息',{exact:true}).fill('新的合成消息');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('独立页面恢复合成回复',{exact:true}).waitFor();assert.equal(submits,1);assert.equal((await bridge.ask({requestId:'lost-request',prompt:'never replay',timeoutMs:100})).kind,'failed');assert.equal(submits,1);
});

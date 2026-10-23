import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {chromium} from '@playwright/test';
import {WebSocket} from 'ws';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {QqChannelManager} from '../../dist/app/qq-channel-manager.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {emptyEntry} from '../../dist/contracts/memory-book.js';

test('blank QQ settings UI reviews publication, saves explicit binding and whitelist, then controlled WS delivery and stops',{timeout:60000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'allmind-qq-browser-')),source=new FileBookRepository(join(root,'book')),credentials=new BookCredentials(join(root,'credentials'));
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'};source.commit(scope,{upsert:[emptyEntry('public','persona','公开身份','PUBLIC_ROLE'),emptyEntry('secret','wiki','私人资料','PRIVATE_SENTINEL')]},0,'seed');
  let calls=0;const model={async complete(_binding,messages){calls++;assert.ok(!JSON.stringify(messages).includes('PRIVATE_SENTINEL'));return 'controlled QQ reply';}};
  const config=source.loadConfig();source.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:1',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},config.revision,'model');
  const qq=new QqChannelManager({directory:join(root,'qq'),source,credentials,model:()=>model});
  const server=await startBookServer({runtime:new BookRuntime(source,model),qq,credentials,uiRoot:resolve('management')});
  const browser=await chromium.launch({headless:true});let ws;
  t.after(async()=>{ws?.terminate();await browser.close();await qq.close();await server.close();source.close();rmSync(root,{recursive:true,force:true});});
  const page=await browser.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));page.setDefaultTimeout(8000);await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'QQ 接入',exact:true}).click();
  await page.getByText('QQ 已停止',{exact:true}).waitFor();assert.equal(calls,0);
  const currentRole=source.loadConfig().characters.find(row=>row.id===source.loadConfig().currentCharacterId);
  assert.equal(await page.getByLabel('公开名称',{exact:true}).inputValue(),currentRole.name);assert.equal(await page.getByLabel('公开简介',{exact:true}).inputValue(),currentRole.intro);
  await page.getByLabel('公开简介',{exact:true}).fill('Only reviewed public material');await page.getByText(/选择公开条目/).click();await page.locator('label').filter({hasText:'公开身份 · persona'}).getByRole('checkbox').check();
  await page.getByRole('button',{name:'生成完整公开预览',exact:true}).click();await page.getByRole('heading',{name:'即将对外提供的完整内容'}).waitFor();
  const preview=page.getByRole('region',{name:'QQ 公开预览'});assert.ok((await preview.innerText()).includes('PUBLIC_ROLE'));assert.ok(!(await preview.innerText()).includes('PRIVATE_SENTINEL'));
  assert.equal(await page.getByRole('button',{name:'确认发布此版本'}).isEnabled(),false);
  await page.getByRole('checkbox',{name:'我已核对全部正文、来源和预设，允许用于这些 QQ 会话'}).check();await page.getByRole('button',{name:'确认发布此版本'}).click();await page.getByText('公开角色已审核保存；尚未启动 QQ。',{exact:true}).waitFor();
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  await page.getByText('机器人账号与连接配置',{exact:true}).click();
  await page.getByLabel('机器人 QQ 号',{exact:true}).fill('10001');await page.getByLabel('本机监听端口',{exact:true}).fill(String(port));await page.getByLabel('OneBot access token',{exact:true}).fill('T'.repeat(48));
  await page.getByLabel('允许的好友 QQ 号（每行一个）',{exact:true}).fill('20001\n20002');await page.getByLabel('允许的群号（每行一个，仅 @ 回复）',{exact:true}).fill('30001');await page.getByLabel('对外角色',{exact:true}).selectOption('public-aika');
  await page.getByRole('button',{name:'复制当前已保存连接供 QQ 使用'}).click();await page.getByRole('button',{name:'保存 QQ 设置',exact:true}).click();await page.getByText('QQ 设置已保存，尚未启动。',{exact:true}).waitFor();
  assert.deepEqual(qq.view().config.privateIds,['20001','20002']);assert.equal(await page.getByLabel('OneBot access token',{exact:true}).inputValue(),'');assert.equal(qq.view().config.enabled,false);
  await page.getByRole('button',{name:'启动 QQ 通道',exact:true}).click();await page.getByText('监听已启动，等待 NapCat',{exact:true}).waitFor();assert.equal(calls,0);
  ws=new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`,{headers:{Authorization:'Bearer '+'T'.repeat(48),'X-Self-ID':'10001','X-Client-Role':'Universal'}});
  ws.on('message',data=>{const action=JSON.parse(data.toString());ws.send(JSON.stringify({status:'ok',retcode:0,echo:action.echo,data:action.action==='get_login_info'?{user_id:10001}:action.action==='get_status'?{online:true,good:true}:{message_id:902}}));});await once(ws,'open');
  const until=Date.now()+5000;while(!qq.view().status.ready){if(Date.now()>until)throw Error('QQ fixture not ready');await new Promise(resolve=>setTimeout(resolve,10));}
  ws.send(JSON.stringify({post_type:'message',message_type:'private',sub_type:'friend',self_id:10001,user_id:20001,message_id:1,message:[{type:'text',data:{text:'synthetic greeting'}}]}));
  while(qq.view().deliveries[0]?.state!=='sent'){if(Date.now()>until)throw Error('QQ fixture delivery not completed');await new Promise(resolve=>setTimeout(resolve,10));}
  await page.getByRole('button',{name:'回读状态',exact:true}).click();await page.getByText('账号已核对，QQ 在线',{exact:true}).waitFor();await page.getByText('最近投递记录（1）',{exact:true}).click();await page.getByText('好友 20001 · 已确认发送',{exact:true}).waitFor();assert.equal(calls,1);
  await page.getByText('QQ 会话列表',{exact:true}).click();await page.getByRole('button',{name:'为此会话开始新话题',exact:true}).click();await page.getByText('此会话已开始新话题；旧记录保留，不带入新上下文。',{exact:true}).waitFor();assert.ok(qq.view().config.conversationEpochs['private:20001']);assert.equal(calls,1);
  assert.equal(await page.getByLabel('允许的好友 QQ 号（每行一个）',{exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'编辑白名单',exact:true}).click();await page.getByText('QQ 已停止',{exact:true}).waitFor();assert.equal(qq.view().status.listening,false);
  const whitelist=page.getByLabel('允许的好友 QQ 号（每行一个）',{exact:true});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='允许的好友 QQ 号（每行一个）');await whitelist.fill('20001\n20003');await page.getByRole('button',{name:'保存 QQ 设置',exact:true}).click();await page.getByText('QQ 设置已保存，尚未启动。',{exact:true}).waitFor();
  assert.deepEqual(qq.view().config.privateIds,['20001','20003']);assert.equal(qq.view().config.publicationId,'public-aika');assert.equal(qq.view().config.enabled,false);assert.equal(calls,1);
  assert.equal(await page.getByRole('button',{name:'保存设置',exact:true}).count(),0);
  await page.reload();await page.getByRole('button',{name:'QQ 接入',exact:true}).click();assert.equal(await whitelist.inputValue(),'20001\n20003');
  assert.equal(await page.getByLabel('发布版本',{exact:true}).inputValue(),'2');
  const screenshots=resolve('.local/goal-completion/qq-ui');mkdirSync(screenshots,{recursive:true});
  for(const theme of ['light','dark'])for(const width of [375,768,1024,1440]){
    await page.setViewportSize({width,height:1000});await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),theme+' '+width+' must not overflow');
    assert.ok(await page.getByRole('region',{name:'QQ 白名单'}).isVisible());
    if(width===1440||width===375&&theme==='dark')await page.screenshot({path:join(screenshots,`qq-${theme}-${width}.png`),fullPage:true});
  }
  await page.emulateMedia({reducedMotion:'reduce'});await whitelist.press('Tab');
  assert.ok(await page.getByLabel('允许的群号（每行一个，仅 @ 回复）',{exact:true}).evaluate(el=>document.activeElement===el&&parseFloat(getComputedStyle(el).outlineWidth)>=2));
  assert.equal(await page.getByRole('button',{name:'编辑白名单',exact:true}).evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
  assert.deepEqual(pageErrors,[]);
});

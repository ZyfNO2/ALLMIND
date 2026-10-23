import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {QqChannelManager} from '../../dist/app/qq-channel-manager.js';
import {NapcatHostManager} from '../../dist/app/napcat-host.js';
import {startBookServer} from '../../dist/management/book-server.js';

test('settings imports local NapCat, shows QR, verifies exact account, switches login, prepares bridge and controls only configured host',{timeout:90000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'allmind-napcat-browser-')),install=join(root,'runtime'),configDir=join(install,'versions','fixture','resources','app','napcat','config');
  mkdirSync(configDir,{recursive:true});writeFileSync(join(configDir,'..','napcat.mjs'),'// fixture');writeFileSync(join(install,'NapCatWinBootMain.exe'),'never executed');
  let running=true,loggedIn=false,account='10001',launches=0,stops=0,restarts=0;
  const upstream=createServer(async(req,res)=>{
    for await(const _chunk of req){};
    if(!running){res.statusCode=503;res.end('{}');return;}
    const path=req.url;
    let data;
    if(path==='/api/auth/login')data={Credential:'FIXTURE_SESSION_ONLY'};
    else if(path.endsWith('CheckLoginStatus'))data={isLogin:loggedIn,isOffline:false,loginPhase:'fixture'};
    else if(path.endsWith('GetQQLoginInfo'))data={uin:account,nick:'Fixture QQ',online:true};
    else if(path.endsWith('GetQQLoginQrcode'))data={qrcode:'https://ssl.ptlogin2.qq.com/fixture'};
    else if(path.endsWith('RefreshQRcode'))data={qrcodeurl:'https://ssl.ptlogin2.qq.com/fixture-new'};
    else if(path.endsWith('SetQuickLoginQQ'))data=null;
    else if(path.endsWith('RestartNapCat')){restarts++;loggedIn=false;data={};}
    else {res.statusCode=404;res.end('{}');return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data}));
  });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const upstreamPort=upstream.address().port;
  writeFileSync(join(configDir,'webui.json'),JSON.stringify({host:'127.0.0.1',port:upstreamPort,token:'PRIVATE_WEBUI_TOKEN'}));
  const source=new FileBookRepository(join(root,'book')),credentials=new BookCredentials(join(root,'credentials'));
  const qq=new QqChannelManager({directory:join(root,'qq'),source,credentials,model:()=>({async complete(){throw Error('No model calls authorized in login fixture');}})});
  qq.napcat=new NapcatHostManager({directory:join(root,'qq'),credentials,channel:()=>qq.view().config,processes:async(_install,action)=>{const old=running;if(action==='stop'){running=false;stops++;}return old?1:0;},launch:async()=>{running=true;launches++;}});
  await qq.configure({...qq.view().config,selfId:'10001',privateIds:['20001']},0,'T'.repeat(48));
  const runtime=new BookRuntime(source,{async complete(){throw Error('No desktop model calls authorized');}});
  const server=await startBookServer({runtime,qq,credentials,uiRoot:resolve('management'),port:0});
  const origin=new URL(server.url).origin;
  assert.equal((await fetch(origin+'/api/memory-book/v1/channels/qq/napcat')).status,401);
  assert.equal((await fetch(origin+'/api/memory-book/v1/channels/qq/napcat/switch-account',{method:'POST',headers:{Authorization:'Bearer '+server.token,'Content-Type':'application/json'},body:JSON.stringify({confirmed:false})})).status,400);assert.equal(restarts,0);
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close();await qq.close();source.close();await new Promise(resolve=>upstream.close(resolve));rmSync(root,{recursive:true,force:true});});
  const page=await browser.newPage();page.setDefaultTimeout(10000);await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'QQ 接入',exact:true}).click();
  const panel=page.getByRole('region',{name:'NapCat 登录与管理'});
  await panel.getByLabel('NapCat 安装目录').fill(install);await panel.getByRole('button',{name:'连接此安装',exact:true}).click();await panel.getByText('NapCat 已启动，等待扫码登录',{exact:true}).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_WEBUI_TOKEN'));
  await panel.getByRole('button',{name:'显示登录二维码',exact:true}).click();const image=panel.getByAltText('NapCat QQ 登录二维码');await image.waitFor();assert.match(await image.getAttribute('src'),/^data:image\/png;base64,/);assert.ok(await image.evaluate(img=>img.complete&&img.naturalWidth===256));
  loggedIn=true;account='10002';await panel.getByRole('button',{name:'检查登录状态',exact:true}).click();await panel.getByText(/当前 QQ：10002/).waitFor();await panel.getByText(/账号不匹配，请勿启用回复/).waitFor();assert.equal(await image.count(),0);
  account='10001';await panel.getByRole('button',{name:'检查登录状态',exact:true}).click();await panel.getByText(/当前 QQ：10001/).waitFor();
  await panel.getByText('登错号？重新扫码',{exact:true}).click();assert.equal(await panel.getByRole('button',{name:'退出当前账号并重新扫码',exact:true}).isEnabled(),false);
  await panel.getByRole('checkbox',{name:'确认退出当前 NapCat 账号，重新扫码',exact:true}).check();await panel.getByRole('button',{name:'退出当前账号并重新扫码',exact:true}).click();await panel.getByText('已请求重新扫码，等待后台重启后显示二维码。',{exact:true}).waitFor();assert.equal(restarts,1);
  await panel.getByRole('button',{name:'检查登录状态',exact:true}).click();await panel.getByRole('button',{name:'刷新二维码',exact:true}).click();await image.waitFor();
  await panel.getByRole('button',{name:'停止 NapCat',exact:true}).click();await panel.getByText('已停止指定独立目录的 NapCat，其他 QQ 未操作。',{exact:true}).waitFor();assert.equal(stops,1);
  await panel.getByText('自动配置 OneBot 反向连接',{exact:true}).click();await panel.getByRole('button',{name:'写入 ALLMIND 反向连接',exact:true}).click();await panel.getByText('反向连接已写入。现在启动 NapCat，登录后审核角色并启动 QQ 通道。',{exact:true}).waitFor();
  const saved=JSON.parse(readFileSync(join(configDir,'onebot11_10001.json'),'utf8'));assert.equal(saved.network.websocketClients[0].token,'T'.repeat(48));
  await panel.getByRole('button',{name:'启动 NapCat',exact:true}).click();await panel.getByText(/已请求启动 NapCat/).waitFor();assert.equal(launches,1);assert.equal(qq.view().config.enabled,false);
});

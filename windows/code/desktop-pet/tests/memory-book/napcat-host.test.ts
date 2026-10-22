import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {NapcatHostManager} from '../../app/napcat-host.js';
import {BookCredentials} from '../../management/book-credentials.js';
import type {QqChannelConfig} from '../../contracts/book-channel.js';

async function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'allmind-napcat-host-')),install=join(root,'runtime'),dir=join(install,'versions','fixture','resources','app','napcat'),configDir=join(dir,'config');
  mkdirSync(configDir,{recursive:true});writeFileSync(join(dir,'napcat.mjs'),'// fixture');writeFileSync(join(install,'NapCatWinBootMain.exe'),'fixture, never executed');
  let loggedIn=false,account='10001',rejectAuth=false,running=false,launches=0,stops=0;
  const token='PRIVATE_WEBUI_FIXTURE',credential='PRIVATE_SESSION_FIXTURE',actions:{path:string;body:any}[]=[];
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);actions.push({path:req.url!,body});
    const reply=(data:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data}));};
    if(req.url==='/api/auth/login'){
      assert.equal(body.hash,createHash('sha256').update(token+'.napcat').digest('hex'));
      res.end(JSON.stringify(rejectAuth?{code:-1,message:token}:{code:0,data:{Credential:credential}}));return;
    }
    assert.equal(req.headers.authorization,'Bearer '+credential);
    if(rejectAuth){res.statusCode=403;res.end('{}');return;}
    if(req.url?.endsWith('CheckLoginStatus'))reply({isLogin:loggedIn,isOffline:false,loginPhase:loggedIn?'logged_in':'waiting_qrcode'});
    else if(req.url?.endsWith('GetQQLoginInfo'))reply({uin:account,nick:'Synthetic robot',online:true});
    else if(req.url?.endsWith('GetQQLoginQrcode'))reply({qrcode:'https://ssl.ptlogin2.qq.com/fixture'});
    else if(req.url?.endsWith('RefreshQRcode'))reply({qrcodeurl:'https://ssl.ptlogin2.qq.com/fixture-new'});
    else if(req.url?.endsWith('SetQuickLoginQQ')){assert.equal(body.uin,'');reply(null);}
    else if(req.url?.endsWith('RestartNapCat')){loggedIn=false;reply({message:'restarting'});}
    else {res.statusCode=404;res.end('{}');}
  });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  writeFileSync(join(configDir,'webui.json'),JSON.stringify({host:'127.0.0.1',port:address.port,token}));
  const credentials=new BookCredentials(join(root,'credentials'));credentials.save('qq-test-token','T'.repeat(48));
  const channel:QqChannelConfig={revision:0,enabled:false,connectorId:'qq-main',selfId:'10001',port:54188,privateIds:['20001'],groupIds:[],publicationId:'',epoch:'initial',model:null,tokenCredentialId:'qq-test-token'};
  let channelBusy=false;
  const options={directory:join(root,'settings'),credentials,channel:()=>channel,channelBusy:()=>channelBusy,processes:async(_install:unknown,action:'status'|'stop')=>{if(action==='stop'){stops++;running=false;}return running?1:0;},launch:async()=>{launches++;running=true;}};
  let host=new NapcatHostManager(options);
  t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(root,{recursive:true,force:true});});
  return {root,install,configDir,channel,actions,get host(){return host;},get launches(){return launches;},get stops(){return stops;},setRunning:(value:boolean)=>{running=value;},setLogin:(value:boolean,uin='10001')=>{loggedIn=value;account=uin;},rejectAuth:()=>{rejectAuth=true;},setBusy:()=>{channelBusy=true;},reopen:()=>{host=new NapcatHostManager(options);}};
}

test('NapCat import is explicit, local-only and persists without exposing WebUI credentials',async t=>{
  const f=await fixture(t);assert.equal((await f.host.view()).configured,false);assert.equal(f.actions.length,0);
  const view=await f.host.configure({installDirectory:f.install},0);assert.equal(view.reachable,true);assert.equal(view.online,false);assert.equal(view.revision,1);
  assert.ok(!JSON.stringify(view).includes('PRIVATE_'));assert.ok(!readFileSync(join(f.root,'settings','napcat-host.json'),'utf8').includes('PRIVATE_'));
  await assert.rejects(f.host.configure({installDirectory:f.install},0),/已变化/);
  f.reopen();assert.equal((await f.host.view()).configured,true);assert.equal(f.launches,0);
  const logins=f.actions.filter(row=>row.path==='/api/auth/login').length;await f.host.view();await f.host.view();assert.equal(f.actions.filter(row=>row.path==='/api/auth/login').length,logins);
  const web=join(f.configDir,'webui.json'),original=JSON.parse(readFileSync(web,'utf8'));writeFileSync(web,JSON.stringify({...original,host:'0.0.0.0'}));
  await assert.rejects(f.host.configure({installDirectory:f.install},1),/127.0.0.1/);assert.equal((await f.host.view()).revision,1);
});

test('QR uses authenticated backend and login state verifies exact QQ number; active channel blocks account changes',async t=>{
  const f=await fixture(t);await f.host.configure({installDirectory:f.install},0);
  assert.match((await f.host.qr(false)).image,/^data:image\/png;base64,/);assert.match((await f.host.qr(true)).image,/^data:image\/png;base64,/);
  f.setLogin(true,'10002');let view=await f.host.view();assert.equal(view.accountId,'10002');assert.equal(view.accountMatches,false);assert.match(view.error!,/账号/);
  f.setLogin(true);view=await f.host.view();assert.equal(view.accountMatches,true);
  f.channel.enabled=true;const count=f.actions.length;
  await assert.rejects(f.host.switchAccount(),/停止 QQ/);await assert.rejects(f.host.qr(true),/停止 QQ/);await assert.rejects(f.host.stop(),/停止 QQ/);assert.equal(f.actions.length,count);
  f.channel.enabled=false;f.setBusy();await assert.rejects(f.host.start(),/停止 QQ/);
});

test('bridge configuration preserves unrelated settings, refuses running host and other active reverse clients',async t=>{
  const f=await fixture(t);await f.host.configure({installDirectory:f.install},0);const file=join(f.configDir,'onebot11_10001.json');
  writeFileSync(file,JSON.stringify({musicSignUrl:'retained',network:{httpServers:[],websocketClients:[{name:'other',enable:false,url:'ws://127.0.0.1:1'}]}}));
  f.setRunning(true);await assert.rejects(f.host.prepareBridge(),/停止 NapCat/);f.setRunning(false);await f.host.prepareBridge();
  let saved=JSON.parse(readFileSync(file,'utf8'));assert.equal(saved.musicSignUrl,'retained');assert.equal(saved.network.websocketClients.length,2);assert.equal(saved.network.websocketClients[1].token,'T'.repeat(48));assert.equal(saved.network.websocketClients[1].messagePostFormat,'array');
  saved.network.websocketClients[0].enable=true;writeFileSync(file,JSON.stringify(saved));const before=readFileSync(file,'utf8');
  await assert.rejects(f.host.prepareBridge(),/其他启用/);assert.equal(readFileSync(file,'utf8'),before);
});

test('start reuses exact installation, stop delegates only configured directory, switch clears auto-login before restart',async t=>{
  const f=await fixture(t);await f.host.configure({installDirectory:f.install},0);await f.host.start();assert.equal(f.launches,1);await f.host.start();assert.equal(f.launches,1);await f.host.stop();assert.equal(f.stops,1);
  f.setLogin(true);await f.host.switchAccount();const operations=f.actions.filter(row=>row.path.endsWith('SetQuickLoginQQ')||row.path.endsWith('RestartNapCat'));assert.deepEqual(operations.map(row=>row.path),['/api/QQLogin/SetQuickLoginQQ','/api/QQLogin/RestartNapCat']);assert.equal((await f.host.view()).online,false);
  f.rejectAuth();assert.match((await f.host.view()).error!,/403/);const view=await f.host.view();assert.equal(view.reachable,false);assert.match(view.error!,/授权失败/);assert.ok(!JSON.stringify(view).includes('PRIVATE_'));
});

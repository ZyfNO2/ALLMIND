import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createChatgptPageHost,createParallelChatgptPageHost} from '../../desktop/electron/chatgpt-page-host.mjs';

test('independent host stays hidden, reuses one isolated page, and never accepts arbitrary destinations',async()=>{
  const windows=[];
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.destroyed=false;this.visible=false;this.url='';this.loads=[];
      this.webContents=new EventEmitter();this.webContents.getURL=()=>this.url;
      this.webContents.setWindowOpenHandler=handler=>this.openHandler=handler;
      this.webContents.executeJavaScript=async script=>script.includes('"account"')?{account:'a'.repeat(64)}:{ready:true};windows.push(this);}
    setMenu(){} setSkipTaskbar(){} show(){this.visible=true;} hide(){this.visible=false;}
    isDestroyed(){return this.destroyed;}destroy(){this.destroyed=true;}
    async loadURL(url){this.url=url;this.loads.push(url);}
  }
  const host=createChatgptPageHost({BrowserWindow:Window,getParent:()=>null});
  await host.handle({action:'navigate',temporary:true});await host.handle({action:'probe'});
  await host.handle({action:'navigate',temporary:false});
  assert.equal(windows.length,1);const window=windows[0];assert.equal(window.visible,false);
  assert.equal(window.options.webPreferences.partition,'persist:aiki-chatgpt-user');
  assert.equal(window.options.webPreferences.nodeIntegration,false);assert.equal(window.options.webPreferences.sandbox,true);
  assert.deepEqual(window.loads,['https://chatgpt.com/?temporary-chat=true','https://chatgpt.com/']);
  await host.handle({action:'login'});assert.equal(window.visible,true);
  assert.equal((await host.handle({action:'probe'})).signedIn,true);
  assert.equal(window.visible,false,'successful explicit login check immediately completes login mode');
  await host.handle({action:'prepare',input:{id:'after-login'}});
  assert.equal(window.openHandler({url:'https://example.com/'}).action,'deny');
  window.webContents.executeJavaScript=async script=>script.includes('"account"')?{}:{ready:true};
  assert.equal((await host.handle({action:'probe'})).ready,false,'a composer alone is not login evidence');
  window.webContents.executeJavaScript=async script=>script.includes('"account"')?{account:'b'.repeat(64)}:{ready:true};
  await assert.rejects(host.handle({action:'prepare',input:{id:'r'}}),/账号.*不同/);
  await assert.rejects(host.handle({action:'navigate',temporary:true,url:'https://example.com/'}),/参数无效/);
  const event={preventDefault(){this.prevented=true;}};window.emit('close',event);assert.equal(event.prevented,true);assert.equal(window.destroyed,false);
  host.close();assert.equal(window.destroyed,true);
});

test('first login becomes visible before a slow navigation completes and surfaces load errors',async()=>{
  let window,finish;
  class Window extends EventEmitter{
    constructor(){super();window=this;this.visible=false;this.webContents=new EventEmitter();this.webContents.getURL=()=>'';this.webContents.setWindowOpenHandler=()=>{};}
    setMenu(){}setSkipTaskbar(value){this.skip=value;}show(){this.visible=true;}hide(){this.visible=false;}isDestroyed(){return false;}destroy(){}
    loadURL(url){assert.equal(this.visible,true,'network wait must not hide the login surface');if(url.startsWith('data:'))return Promise.resolve();return new Promise((resolve,reject)=>{finish=reject;});}
  }
  const host=createChatgptPageHost({BrowserWindow:Window,getParent:()=>null});
  const pending=host.handle({action:'login'});assert.equal(window.visible,true);assert.equal(window.skip,false);finish(Error('network unavailable'));
  await assert.rejects(pending,/network unavailable/);host.close();
});

test('explicit login retries a failed HTTPS document instead of trusting its retained URL',async()=>{
 let window,attempts=0;
 class Window extends EventEmitter{
  constructor(){super();window=this;this.url='';this.loads=[];this.webContents=new EventEmitter();this.webContents.getURL=()=>this.url;this.webContents.setWindowOpenHandler=()=>{};this.webContents.executeJavaScript=async script=>script.includes('"account"')?{account:'a'.repeat(64)}:{ready:true};}
  setMenu(){}setSkipTaskbar(){}show(){}hide(){}isDestroyed(){return false;}destroy(){}
  async loadURL(url){this.url=url;this.loads.push(url);if(url.startsWith('https:')&&attempts++===0)throw Error('ERR_CONNECTION_CLOSED');}
 }
 const host=createChatgptPageHost({BrowserWindow:Window,getParent:()=>null});
 await assert.rejects(host.handle({action:'navigate',temporary:true}),/ERR_CONNECTION_CLOSED/);
 assert.equal(window.url,'https://chatgpt.com/?temporary-chat=true');
 await assert.rejects(host.handle({action:'probe'}),/未加载成功/);
 await host.handle({action:'login'});assert.equal(attempts,2);assert.equal(window.url,'https://chatgpt.com/');
 assert.equal((await host.handle({action:'probe'})).signedIn,true);
 window.webContents.emit('did-fail-load',{},-100,'ERR_CONNECTION_CLOSED',window.url,true);
 await assert.rejects(host.handle({action:'probe'}),/ERR_CONNECTION_CLOSED/);
 await host.handle({action:'login'});assert.equal(attempts,3);
 await host.handle({action:'probe'});host.close();
});


test('parallel host isolates task pages, shares only login partition and rejects arbitrary lanes',async()=>{
 const windows=[];
 class Window extends EventEmitter {
  constructor(options){super();this.options=options;this.destroyed=false;this.url='';this.loads=[];this.webContents=new EventEmitter();this.webContents.getURL=()=>this.url;this.webContents.setWindowOpenHandler=()=>{};this.webContents.executeJavaScript=async script=>script.includes('"account"')?{account:'a'.repeat(64)}:{ready:true};windows.push(this);}
  setMenu(){}setSkipTaskbar(){}show(){}hide(){}isDestroyed(){return this.destroyed;}destroy(){this.destroyed=true;}async loadURL(url){this.url=url;this.loads.push(url);}
 }
 const host=createParallelChatgptPageHost({BrowserWindow:Window,getParent:()=>null});
 await Promise.all([host.handle({lane:0,action:'navigate',temporary:true}),host.handle({lane:1,action:'navigate',temporary:false})]);
 assert.equal(windows.length,2);assert.notEqual(windows[0],windows[1]);assert.equal(windows[0].options.webPreferences.partition,windows[1].options.webPreferences.partition);
 assert.deepEqual(windows[0].loads,['https://chatgpt.com/?temporary-chat=true']);assert.deepEqual(windows[1].loads,['https://chatgpt.com/']);
 await host.handle({lane:1,action:'probe'});assert.equal(windows.length,2);
 for(const lane of [-1,4,'1',{},null])await assert.rejects(host.handle({lane,action:'probe'}),/通道无效/);
 await assert.rejects(host.handle({lane:2,action:'navigate',temporary:true,url:'https://example.com'}),/参数无效/);
 host.close();assert.ok(windows.every(window=>window.destroyed));
});

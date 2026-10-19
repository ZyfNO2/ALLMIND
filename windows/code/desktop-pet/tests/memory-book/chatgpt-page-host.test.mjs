import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createChatgptPageHost} from '../../desktop/electron/chatgpt-page-host.mjs';

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
    loadURL(){assert.equal(this.visible,true,'network wait must not hide the login surface');return new Promise((resolve,reject)=>{finish=reject;});}
  }
  const host=createChatgptPageHost({BrowserWindow:Window,getParent:()=>null});
  const pending=host.handle({action:'login'});assert.equal(window.visible,true);assert.equal(window.skip,false);finish(Error('network unavailable'));
  await assert.rejects(pending,/network unavailable/);host.close();
});

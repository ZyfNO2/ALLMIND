import {app,BrowserWindow,screen,powerMonitor} from 'electron';
import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const option=name=>process.argv[process.argv.indexOf(name)+1];
const evidence=option('--probe-evidence');
const report={status:'IN_PROGRESS',checks:[],source:'production Book/Electron/renderer/native helper, isolated Book and window; synthetic DOM gestures and fixture windows; no user application modified',startedAt:new Date().toISOString()};
let win,surface,host;
const mark=(name,details={})=>{report.checks.push({name,...details});writeFileSync(evidence,JSON.stringify(report,null,2));};
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function run(){
try{
  host=await import('../desktop/electron/main.mjs');await app.whenReady();
  const wait=async(predicate,label,ms=25000)=>{const until=Date.now()+ms;while(Date.now()<until){const value=await predicate();if(value)return value;await sleep(100);}throw Error(label);};
  win=await wait(()=>BrowserWindow.getAllWindows().find(row=>row.webContents.getURL().startsWith('pet:')),'production window');
  win.setFocusable(false);win.showInactive();
  const evaluate=code=>win.webContents.executeJavaScript(code),probe=()=>evaluate('window.__aikaCompanionProbe()');
  await wait(()=>evaluate('window.__aikaCompanionProbe?.().life&&window.__aikaAppearanceProbe?.().appearanceReady'),'Book/renderer ready');
  const session=JSON.parse(readFileSync(join(process.env.AIKI_BOOK_DATA,'management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
  const api=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})}),data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data;};
  const menu=async(prefix)=>{await evaluate("if(document.getElementById('drawer').hidden)document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));if(!document.getElementById('drawer-more-menu'))document.getElementById('drawer-settings').click()");await evaluate(`(()=>{const button=Array.from(document.querySelectorAll('#drawer-more-menu [role^=menuitem]')).find(row=>row.textContent.startsWith(${JSON.stringify(prefix)}));if(!button)throw Error('Missing menu '+${JSON.stringify(prefix)});button.click()})()`);};
  const close=()=>evaluate("if(!document.getElementById('drawer').hidden)document.getElementById('close').click()");
  await close();await sleep(300);
  if(!process.argv.includes('--geometry-only')){
  await evaluate("document.getElementById('character').dispatchEvent(new PointerEvent('pointerdown',{pointerId:8,button:0,screenX:100,screenY:100,clientY:100}));document.getElementById('character').dispatchEvent(new PointerEvent('pointerup',{pointerId:8,button:0,screenX:100,screenY:100,clientY:100}))");
  await wait(async()=>!!(await probe()).life.localHistory?.some(row=>row.kind==='petting'),'tap completion journal');
  mark('tap -> transient action -> persistent summary, missing artwork does not hang');
  await menu('投喂');await close();await wait(async()=>!!(await probe()).life.localHistory?.some(row=>row.kind==='feeding'),'feed completes');
  if(process.argv.includes('--interaction-pack')){assert.equal((await probe()).life.localHistory.find(row=>row.kind==='feeding').presentation,'played');mark('optional role manifest resource reaches real renderer/frame acknowledgement and played receipt');}
  await menu('赠送小礼物');await close();await wait(async()=>!!(await probe()).life.localHistory?.some(row=>row.kind==='gifting'),'gift completes');
  mark('feed and gift complete independently of reward cooldown');
  await menu('玩纸团');await close();
  await evaluate("(()=>{const target=document.getElementById('character');for(let i=0;i<3;i++){target.dispatchEvent(new PointerEvent('pointerdown',{pointerId:10+i,button:0,screenX:100,screenY:100}));target.dispatchEvent(new PointerEvent('pointerup',{pointerId:10+i,button:0,screenX:100,screenY:100}));}})()");
  await wait(async()=>!!(await probe()).life.localHistory?.some(row=>row.kind==='playing'),'three catches complete toy');mark('paper toy requires three catches');
  const count=(await probe()).life.localHistory.length;
  await menu('玩纸团');await close();await sleep(4500);assert.equal((await probe()).life.localHistory.length,count);mark('expired toy does not create a completed interaction');
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'desktop'};
  assert.equal((await api('/companion/keyboard?characterId=aika')).enabled,false);
  await api('/companion/keyboard',{...scope,action:'enable',enabled:true});
  await wait(async()=>(await api('/companion/keyboard?characterId=aika')).state==='active','native keyboard listener');
  await wait(async()=>(await api('/companion/keyboard?characterId=aika')).days.length>0,'real ten-second keyboard coverage',16000);
  const keyboard=await api('/companion/keyboard?characterId=aika');assert.ok(keyboard.days[0].coveredMs>0);assert.equal(keyboard.habitSlots.length,0);
  mark('actual Raw Input source opens through visible authenticated opt-in; ten-second native coverage',{state:keyboard.state,coverageMs:keyboard.days[0].coveredMs,policy:keyboard.policy});
  await api('/companion/keyboard',{...scope,action:'delete'});assert.equal((await api('/companion/keyboard?characterId=aika')).days.length,0);
  await api('/companion/keyboard',{...scope,action:'enable',enabled:false});mark('delete clears derived activity; stop disables the listener');
  }
  if(!process.argv.includes('--local-only')){
  let surfaceInfo=null,buffer='';
  surface=spawn(process.execPath,[resolve('tools/local-pet-surface.mjs')],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},stdio:['pipe','pipe','pipe']});
  surface.stdout.on('data',chunk=>{buffer+=chunk;let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);try{surfaceInfo=JSON.parse(line)}catch{}}});
  await wait(()=>surfaceInfo,'separate fixture window');
  await close();await sleep(300);
  // Place the production pet using its actual drag IPC, keeping its model bottom at the fixture top.
  const rect=await evaluate("(()=>{const r=document.getElementById('character').getBoundingClientRect();return {height:r.height}})()");
  const current=win.getBounds(),target={x:surfaceInfo.bounds.x+150-current.width/2,y:surfaceInfo.bounds.y-rect.height};
  await evaluate(`window.desktopHost.postMessage('shell',{type:'drag',dx:${target.x-current.x},dy:${target.y-current.y}})`);
  await evaluate("window.desktopHost.postMessage('shell',{type:'pet_motion',mode:'dock'})");
  await sleep(1000);const hostState=host.localPetHostProbe();report.dockInput={anchor:hostState.anchor,docked:hostState.docked,motion:hostState.motion,surface:surfaceInfo.bounds,candidate:hostState.windows.find(row=>row.pid===surfaceInfo.pid),candidates:hostState.windows.length};
  await wait(async()=>(await probe()).localAction?.kind==='docked','native window docking');
  const before=win.getBounds();surface.stdin.write(JSON.stringify({action:'move',bounds:{...surfaceInfo.bounds,x:surfaceInfo.bounds.x+80}})+'\n');
  await sleep(1000);const follow=host.localPetHostProbe();report.followInput={before,after:win.getBounds(),anchor:follow.anchor,surface:surfaceInfo.bounds,candidate:follow.windows.find(row=>row.pid===surfaceInfo.pid),docked:follow.docked};
  await wait(()=>Math.abs(win.getBounds().x-before.x-80)<4,'follow native moved window');mark('native window geometry docking and following');
  surface.stdin.write(JSON.stringify({action:'minimize'})+'\n');
  await wait(async()=>(await probe()).localAction?.kind!=='docked','detach from minimized window');mark('native minimization invalidates dock');
  }
  report.displays=screen.getAllDisplays().map(row=>({scaleFactor:row.scaleFactor,bounds:row.bounds}));
  report.unverified=['Physical monitor removal, unavailable scale factors and true dual-screen hardware','Real multi-day habit effect','Artwork and authored sit/jump animation quality'];
  report.final=await probe();report.status='PASS';
}catch(error){report.status='FAILED';report.error=error.stack;process.exitCode=1;try{report.final=await win?.webContents.executeJavaScript('window.__aikaCompanionProbe?.()')}catch{}}
finally{if(surface){surface.stdin.end();surface.kill();}report.finishedAt=new Date().toISOString();writeFileSync(evidence,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks.length,error:report.error}));app.quit();}
}
void run();

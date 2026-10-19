import {app,BrowserWindow} from 'electron';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const directory=process.env.AIKI_BOOK_DATA,input=JSON.parse(readFileSync(join(directory,'native-gates-input.json'),'utf8'));
const report={status:'IN_PROGRESS',provider:'local HTTP fixture; no real account/model evaluation',consumer:'production Electron/preload/NDJSON/Book/scheduler/renderer acknowledgements',profile:'independent isolated profile; normal instance untouched',clock:'scheduler clock injected at 2026-10-16 14:40 Asia/Singapore, normal monotonic advance',source:'explicit synthetic source/event fixture seeded in isolated Book; no fabricated user history or ack',checks:[],startedAt:new Date().toISOString()};
const save=()=>writeFileSync(input.evidence,JSON.stringify(report,null,2));let win;
if(input.reminders){report.source='reminder created through actual authenticated API in isolated Book; no seeded memory/event or fabricated dialogue/ack';report.clock='scheduler injected at 14:39; +60s controlled advance to daily reminder window, same monotonic clock afterward';}
async function run(){try{
 save();await import('../desktop/electron/main.mjs');await app.whenReady();
 const wait=async(predicate,label,ms=30000)=>{const until=Date.now()+ms;while(Date.now()<until){const value=await predicate();if(value)return value;await new Promise(done=>setTimeout(done,100))}throw Error('Gate timeout: '+label)};
 win=await wait(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('pet:')),'native window');win.setFocusable(false);win.setAlwaysOnTop(false);win.showInactive();
 const evaluate=script=>win.webContents.executeJavaScript(script);
 await wait(()=>evaluate('window.__aikaCompanionProbe?.().life&&window.__aikaAppearanceProbe?.().appearanceReady'),'production ready');
 await evaluate(`(()=>{const original=window.petBridge.receive;window.__gateOffers=[];window.__gateRelease=()=>{const args=window.__gateOffers.shift();if(!args)throw Error('No genuine queued offer');original(...args)};window.petBridge.receive=(...args)=>{if(args[0]?.channel==='companion_offer'){window.__gateOffers.push(args);return}return original(...args)}})()`);
 const session=JSON.parse(readFileSync(join(directory,'management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
 const api=async(path,body,method)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{method:method??(body?(path==='/runtime'?'PUT':'POST'):'GET'),headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)}),data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data};
 const config=async(change,operationId)=>{const current=(await api('/runtime')).config;return api('/runtime',{config:{...current,...change,companion:{...current.companion,...change.companion}},expectedRevision:current.revision,operationId})};
 const menu=async(prefix)=>{await evaluate("if(document.getElementById('drawer').hidden)document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));if(!document.getElementById('drawer-more-menu'))document.getElementById('drawer-settings').click()");await evaluate(`(()=>{const control=Array.from(document.querySelectorAll('#drawer-more-menu [role^=menuitem]')).find(row=>row.textContent.startsWith(${JSON.stringify(prefix)}));if(!control)throw Error('Missing menu');control.click()})()`)};
 const close=()=>evaluate("if(!document.getElementById('drawer').hidden)document.getElementById('close').click()");
 for(const [index,gate] of input.cases.entries()){
  const characterId=input.roles[index],scope={characterId,pairingId:'local-user',sessionId:'desktop'},params=new URLSearchParams(scope);
  await config({currentCharacterId:characterId,companion:{proactive:false}},'prepare-'+gate);
  await wait(()=>evaluate(`window.__aikaCompanionProbe().life?.characterId===${JSON.stringify(characterId)}`),'role '+gate);await close();
  if(input.reminders)await api('/companion/reminders',{...scope,confirmed:true,expectedReminderRevision:0,reminder:{id:'native-daily',title:'定时喝水',timezone:'Asia/Singapore',enabled:true,schedule:{kind:'daily',time:'14:40'}}});
  await config({companion:{proactive:true}},'enable-'+gate);
  if(input.reminders&&index===0)writeFileSync(input.clockOffset,JSON.stringify({offset:60000}));
  await wait(()=>evaluate('window.__gateOffers.length===1'),'queued real offer '+gate);
  const offer=await evaluate('window.__gateOffers[0][0]');assert.equal(offer.delivery,undefined);assert.equal(offer.text,undefined);
  if(input.reminders){const data=await api('/companion?'+params);assert.equal(data.deliveries.find(row=>row.id===offer.id).reminderRef?.id,'native-daily');assert.equal(data.events.length,0);}
  if(gate==='reminder-delete')await api('/companion/reminders',{...scope,id:'native-daily',expectedReminderRevision:1},'DELETE');
  // Background acceptance intentionally has no system tray. Exercise the real native hide event.
  if(gate==='hidden'){await close();win.hide();await wait(()=>evaluate('window.__aikaCompanionProbe().hidden'),'native hidden');assert.equal(win.isVisible(),false);}
  if(gate==='dnd'){await menu('免打扰');await wait(()=>evaluate('window.__aikaCompanionProbe().life.quiet'),'native quiet');await close();}
  if(gate==='focus'){await api('/companion/focus',{...scope,enabled:true});await wait(()=>evaluate('window.__aikaCompanionProbe().focus===true'),'native focus');}
  if(gate==='cancel'){await api('/chat',{...scope,text:'取消这次面试',turnId:'cancel-gate-turn'});await wait(async()=>{const data=await api('/companion?'+params);return data.events[0]?.status==='cancelled'},'actual cancellation memory job');}
  if(gate==='forget'){const book=await api('/book?'+params);await api('/wiki/revoke',{...scope,sourceId:'gate-source',expectedRevision:book.revision,operationId:'gate-source-revoke'});}
  if(gate==='role'){await config({currentCharacterId:'gate-other',companion:{proactive:false}},'switch-before-display');await wait(()=>evaluate('window.__aikaCompanionProbe().life?.characterId==="gate-other"'),'native role switch');}
  await evaluate('window.__gateRelease();void 0');
  if(gate==='valid')await wait(async()=>{const data=await api('/companion?'+params);return data.deliveries.find(row=>row.id===offer.id)?.status==='committed'},'actual renderer ack');
  else await new Promise(done=>setTimeout(done,1500));
  const ledger=await api('/companion?'+params),delivery=ledger.deliveries.find(row=>row.id===offer.id),visible=await evaluate("document.getElementById('reply').textContent");
  assert.ok(delivery);assert.equal(delivery.status==='committed',gate==='valid');assert.equal(!!delivery.acknowledgedAt,gate==='valid');
  if(gate!=='valid')assert.doesNotMatch(visible,/隔离主动验收消息/);
  report.checks.push({gate,passed:true,deliveryId:offer.id,status:delivery.status,acknowledged:!!delivery.acknowledgedAt,modelAttempts:ledger.deliveries.length,nativeFocused:win.isFocused()});save();
  if(gate==='hidden'){win.showInactive();await wait(()=>evaluate('!window.__aikaCompanionProbe().hidden'),'restore visibility');}
  if(gate==='dnd'){await menu('免打扰');await wait(()=>evaluate('!window.__aikaCompanionProbe().life.quiet'),'restore dnd');await close();}
  await config({companion:{proactive:false}},'finish-'+gate);
 }
 writeFileSync(input.evidence.replace(/\.json$/,'.png'),(await win.webContents.capturePage()).toPNG());report.status='AUTO_PASS_PENDING_USER_REVIEW';report.finishedAt=new Date().toISOString();
}catch(error){report.status='FAILED';report.error=error.stack;if(win)report.snapshot=await win.webContents.executeJavaScript('window.__aikaCompanionProbe?.()').catch(()=>null);console.error(error.stack);process.exitCode=1;}finally{save();app.quit()}}
void run();

import {app,BrowserWindow} from 'electron';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const directory=process.env.AIKI_BOOK_DATA,input=JSON.parse(readFileSync(join(directory,'native-combined-input.json'),'utf8'));
const resuming=process.env.AIKI_NATIVE_RESUME_AFTER_FORGET==='1';
const report=resuming?JSON.parse(readFileSync(input.evidence,'utf8')):{status:'IN_PROGRESS',productionFactsWritten:false,method:'real production Electron/preload/NDJSON/Book/embedded model; synthetic isolated Book with original signed-in profile',model:input.model,wikiModel:input.wikiModel,clock:'event window clock injected; source/report time and process wall clock real',checks:[],turns:[],startedAt:new Date().toISOString()},save=()=>writeFileSync(input.evidence,JSON.stringify(report,null,2));
if(resuming){assert.equal(report.status,'FAILED');assert.equal(report.turns.at(-1)?.stage,'forgotten');report.status='RESUMING_AFTER_VERIFIED_FORGET';report.resumeStartedAt=new Date().toISOString();delete report.error;}
async function run(){try{
  save();await import('../desktop/electron/main.mjs');await app.whenReady();
  const wait=async(predicate,label,budget=300000)=>{const deadline=Date.now()+budget;while(Date.now()<deadline){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,200))}throw Error('Native acceptance timed out: '+label)};
  const win=await wait(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('pet:')),'native pet window',30000),evaluate=script=>win.webContents.executeJavaScript(script);
  await wait(()=>evaluate("!!window.petBridge&&window.__aikaAppearanceProbe?.().appearanceReady&&!document.getElementById('send').disabled"),'renderer ready',30000);win.setFocusable(false);win.setAlwaysOnTop(false);win.showInactive();
  let session,url,headers;function refreshSession(){session=JSON.parse(readFileSync(join(directory,'management-session.json'),'utf8'));url=new URL(session.url);headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'}}refreshSession();
  const request=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{method:body?(path==='/runtime'?'PUT':'POST'):'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(330000)}),result=await response.json();if(!response.ok)throw Error(result.error?.message??'HTTP '+response.status);return result};
  if(resuming){const current=(await request('/runtime')).config;if(current.currentCharacterId!=='aika'){const restored=await request('/runtime',{config:{...current,currentCharacterId:'aika'},expectedRevision:current.revision,operationId:'resume-aika-'+Date.now()});assert.equal(restored.activationError,null);await wait(()=>evaluate('window.__aikaCompanionProbe().life?.characterId==="aika"&&!document.getElementById("send").disabled'),'resume original isolated role',30000);}}
  const mark=(name,details={})=>{const check={name,passed:true,...details},previous=report.checks.findIndex(row=>row.name===name);if(previous<0)report.checks.push(check);else report.checks[previous]=check;save();console.log('NATIVE_CHECK '+name)};
  let characterId='aika';const scope=()=>({characterId,sessionId:'desktop'}),params=()=>new URLSearchParams(scope()).toString();
  async function send(stage,text){const before=(await request('/chat/history?'+params())).turns.length,at=Date.now();await evaluate(`if(document.getElementById('drawer').hidden)document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));document.getElementById('text').value=${JSON.stringify(text)};document.getElementById('form').requestSubmit()`);
    const turn=await wait(async()=>{const result=await request('/chat/history?'+params());return result.turns.length>before?result.turns.at(-1):null},stage+' real reply');
    await wait(()=>evaluate('!document.getElementById("send").disabled'),'composer released',10000);const visible=await evaluate('document.getElementById("reply").textContent');assert.ok(visible.includes(turn.assistant),'real renderer contains committed reply');
    const context=await request('/recall/traces/'+encodeURIComponent(turn.traceId)+'?'+params());const row={stage,user:text,reply:turn.assistant,durationMs:Date.now()-at,turnId:turn.id,selected:context.consumed,relationshipUsed:context.relationshipUsed??null};report.turns.push(row);save();console.log(JSON.stringify({stage,reply:row.reply}));return row;
  }
  let current;
  if(!resuming){
  await send('new-user','你知道我喜欢怎样被称呼，以及我们以前一起做过什么吗？');
  current=(await request('/runtime')).config;await request('/runtime',{config:{...current,companion:{...current.companion,autoMemory:true,proactive:true}},expectedRevision:current.revision,operationId:'enable-memory'});
  const event=await send('future-event',`我${input.eventDate} 下午三点有A公司面试，时区是 Asia/Singapore，你能记住吗？`);
  await evaluate("if(!document.getElementById('drawer').hidden)document.getElementById('close').click()");
  const memory=await wait(async()=>{const ledger=await request('/companion?'+params()),job=ledger.jobs.find(job=>job.turnId===event.turnId);if(job&&['failed','cancelled','review'].includes(job.status))throw Error('Real extraction '+job.status+': '+job.error);return job?.status==='done'?ledger:null},'real automatic extraction');
  assert.ok(memory.events.some(event=>event.date===input.eventDate&&event.precision==='minute'));report.memory={jobs:memory.jobs,events:memory.events};mark('real reply and real automatic extraction persist an evidenced event');
  const delivery=await wait(async()=>{const ledger=await request('/companion?'+params()),failed=ledger.deliveries.find(delivery=>['failed','cancelled','unknown'].includes(delivery.status));if(failed)throw Error('Proactive failed: '+failed.error);return ledger.deliveries.find(delivery=>delivery.status==='committed')},'actual native bubble acknowledgement',110000);
  const bubble=await evaluate('document.getElementById("speech-bubble-text").textContent');assert.equal(bubble,delivery.text);report.delivery=delivery;report.actualBubble=bubble;mark('actual renderer bubble ack, no fixture acknowledgement');
  current=(await request('/runtime')).config;await request('/runtime',{config:{...current,companion:{...current.companion,autoMemory:false,proactive:false}},expectedRevision:current.revision,operationId:'stop-background'});
  await send('responded','谢谢，我会准备。');assert.ok((await request('/companion?'+params())).deliveries.find(row=>row.id===delivery.id).respondedAt);mark('actual user response clears unanswered delivery');
  const oldPid=session.pid;await request('/chatgpt-web/backend/restart',{});await wait(()=>{refreshSession();return session.pid!==oldPid},'new actual backend process',30000);await wait(async()=>{try{return (await request('/chatgpt-web/status')).state==='signed-in'}catch(error){if(error.message==='fetch failed')return false;throw error}},'restarted source',30000);await wait(()=>evaluate('window.__aikaCompanionProbe().connected&&!document.getElementById("send").disabled'),'renderer reconnect',30000);
  await send('restarted-recall','我之前说的A公司面试是哪天几点，时区是什么？');mark('actual backend process restart followed by sourced real reply');
  const preview=await request('/wiki/preview',{...scope(),source:{sourceId:'native-relationship',title:'用户',text:'称呼：小岚\n回复长度：希望简短些\n共同经历：昨天我和你一起整理旧照片',private:true},mode:'declarations'});await request('/wiki/apply',{...scope(),previewId:preview.id,operationId:'seed-relationship'});
  const experienced=await send('experienced','关于一起整理旧照片，我们做过什么？请自然地称呼我，按我的回复长度偏好回答。');assert.ok(experienced.relationshipUsed?.basisRefs.length);mark('full formal relationship Context reaches native reply');
  const book=await request('/book?'+params());await request('/wiki/revoke',{...scope(),sourceId:'native-relationship',expectedRevision:book.revision,operationId:'revoke-relationship'});
  await send('forgotten','我们以前一起整理旧照片了吗？你还知道我喜欢怎样被称呼吗？');
  }
  const revokedBook=await request('/book?'+params()),revokedIds=new Set(revokedBook.entries.filter(entry=>entry.fact?.sourceId==='native-relationship').map(entry=>entry.id)),forgotten=report.turns.findLast(turn=>turn.stage==='forgotten');
  assert.ok(revokedIds.size>0,'the exact revoked source still has inspectable fact ids');assert.equal(revokedBook.wikiSources.find(source=>source.id==='native-relationship')?.enabled,false);
  assert.ok(!forgotten.relationshipUsed||forgotten.relationshipUsed.basisRefs.every(ref=>!revokedIds.has(ref.entryId)),'only the revoked source must disappear; unrelated valid interview evidence must survive');
  assert.ok(revokedBook.entries.some(entry=>entry.fact?.sourceId!=='native-relationship'&&entry.body.includes('面试')));report.revokedEntryIds=[...revokedIds];mark('source revocation removes formal relationship refs before real reply');
  current=(await request('/runtime')).config;const switched=await request('/runtime',{config:{...current,currentCharacterId:'native-other'},expectedRevision:current.revision,operationId:'switch-role-'+Date.now()});assert.equal(switched.activationError,null);characterId='native-other';await wait(()=>evaluate('window.__aikaCompanionProbe().life?.characterId==="native-other"&&!document.getElementById("send").disabled'),'actual role switch',30000);
  const other=await send('other-role','你知道我喜欢怎样被称呼，以及我们以前一起做过什么吗？');assert.equal(other.selected.length,0);assert.equal(other.relationshipUsed,null);mark('actual role switch rejects foreign private relationship refs');
  report.native={focused:win.isFocused(),visible:win.isVisible(),probe:await evaluate('window.__aikaCompanionProbe()')};assert.equal(report.native.focused,false);writeFileSync(input.evidence.replace(/\.json$/,'.png'),(await win.webContents.capturePage()).toPNG());report.status='ENGINEERING_PASS_AWAITING_SEMANTIC_REVIEW';report.finishedAt=new Date().toISOString();save();
}catch(error){report.status='FAILED';report.error=error instanceof Error?error.stack:String(error);save();console.error(report.error);process.exitCode=1}finally{app.quit()}}
void run();

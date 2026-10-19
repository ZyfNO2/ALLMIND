import { app,BrowserWindow } from 'electron';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const directory=process.env.AIKI_BOOK_DATA,input=JSON.parse(readFileSync(join(directory,'probe-input.json'),'utf8'));
const report={...input,status:'IN_PROGRESS',provider:'existing authorized Chat bridge',displayAck:'real Electron main/preload/NDJSON/production renderer',productionUserDataChanged:false,results:{},timings:{}};
const save=()=>writeFileSync(input.evidence,JSON.stringify(report,null,2));
async function run(){
  try{
    save();await import('../desktop/electron/main.mjs');await app.whenReady();
    const until=Date.now()+30000;while(!BrowserWindow.getAllWindows().length&&Date.now()<until)await new Promise(done=>setTimeout(done,100));
    const win=BrowserWindow.getAllWindows()[0];assert.ok(win,'isolated native window exists');
    const evaluate=script=>win.webContents.executeJavaScript(script);
    const wait=async(predicate,label,budget=300000)=>{const deadline=Date.now()+budget;while(Date.now()<deadline){const value=await predicate();if(value)return value;await new Promise(done=>setTimeout(done,200));}throw Error(label+': '+await evaluate("document.getElementById('status').textContent"));};
    await wait(()=>evaluate("!!window.petBridge&&!document.getElementById('send').disabled&&window.__aikaAppearanceProbe?.().appearanceReady"),'production renderer ready',30000);
    report.timings.rendererReadyMs=Date.now()-Date.parse(input.startedAt);
    win.setFocusable(false);win.showInactive();await wait(()=>evaluate('!document.hidden&&!window.__aikaCompanionProbe().hidden'),'native window visible',10000);
    const session=JSON.parse(readFileSync(join(directory,'management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:`Bearer ${new URLSearchParams(url.hash.slice(1)).get('token')}`};
    const api=async route=>{const response=await fetch(url.origin+'/api/memory-book/v1'+route,{headers});if(!response.ok)throw Error(`Management HTTP ${response.status}`);return response.json()};
    const submittedAt=Date.now();await evaluate(`document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));document.getElementById('text').value=${JSON.stringify(input.userMessage)};document.getElementById('form').requestSubmit()`);
    const turns=await wait(async()=>{const result=await api('/chat/history?sessionId=desktop');return result.turns.length?result.turns:null},'real dialogue committed');
    report.timings.dialogueMs=Date.now()-submittedAt;const memoryStart=Date.now();report.results.dialogue=turns[0].assistant;save();console.log('REAL_DESKTOP_DIALOGUE_COMMITTED');
    await evaluate("if(!document.getElementById('drawer').hidden)document.getElementById('close').click()");
    const memory=await wait(async()=>{const ledger=await api('/companion?sessionId=desktop');const job=ledger.jobs[0];if(job&&['failed','cancelled','review'].includes(job.status))throw Error(`Automatic extraction ${job.status}: ${job.error}`);return job?.status==='done'?ledger:null},'real memory extraction');
    assert.ok(memory.events.some(event=>event.date===input.eventDate&&event.precision==='minute'),'mixed factual/question input retains the real event');
    report.timings.extractionAfterReplyMs=Date.now()-memoryStart;const proactiveStart=Date.now();report.results.memory={job:memory.jobs[0],events:memory.events};save();console.log('REAL_DESKTOP_EVENT_COMMITTED');
    const displayed=await wait(async()=>{const ledger=await api('/companion?sessionId=desktop');const delivery=ledger.deliveries.find(delivery=>delivery.status==='committed');if(ledger.deliveries.some(delivery=>['failed','cancelled','unknown'].includes(delivery.status)))throw Error('Proactive generation/display failed: '+JSON.stringify(ledger.deliveries));return delivery??null},'actual renderer display acknowledgement',100000);
    report.timings.proactiveAfterMemoryMs=Date.now()-proactiveStart;report.results.delivery=displayed;report.results.actualBubble=await evaluate("document.getElementById('speech-bubble-text').textContent");
    assert.equal(report.results.actualBubble,displayed.text,'ack matches the displayed native bubble');
    const history=await api('/chat/history?sessionId=desktop');assert.equal(history.turns.length,1,'proactive contact does not fabricate a user turn');
    report.results.savedTurns=history.turns.length;report.results.nativeWindow={visible:win.isVisible(),focused:win.isFocused(),life:await evaluate('window.__aikaCompanionProbe()')};
    writeFileSync(input.evidence.replace(/\.json$/,'.png'),(await win.webContents.capturePage()).toPNG());
    report.status='AUTO_PASS_PENDING_USER_REVIEW';report.finishedAt=new Date().toISOString();save();console.log('REAL_MODEL_NATIVE_RENDERER_ACK_PASS');
  }catch(error){report.status='FAILED';report.error=error instanceof Error?error.stack:String(error);save();console.error(report.error);process.exitCode=1;}
  finally{app.quit();}
}
void run();

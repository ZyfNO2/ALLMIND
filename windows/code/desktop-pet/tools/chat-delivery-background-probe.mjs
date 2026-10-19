import {app,BrowserWindow,session} from 'electron';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';

const input=JSON.parse(readFileSync(join(process.env.AIKI_BOOK_DATA,'background-input.json'),'utf8'));
const report={status:'IN_PROGRESS',startedAt:new Date().toISOString(),mode:'hidden isolated production Electron / local HTTP model fixture',turns:[],screenshots:[],noVisibleWindow:true,noFocusedWindow:true};
const embeddedResponses=[];
const projectId='g-p-'+'a'.repeat(32);
if(input.embeddedFixture)report.embeddedResponses=embeddedResponses;
const save=()=>writeFileSync(input.evidence,JSON.stringify(report,null,2));
let win;
async function run(){
const watchdog=setTimeout(()=>{report.status='FAIL';report.error='Background native acceptance exceeded 60 seconds';save();app.exit(1);},60000);
try{
  save();await import('../desktop/electron/main.mjs');await app.whenReady();
  if(input.embeddedFixture){
    report.mode='hidden isolated production Electron / embedded ChatGPT page and native stream fixture';
    let requestCount=0;const records=new Map();
    await session.fromPartition('persist:aiki-chatgpt-user').protocol.handle('https',async request=>{
      const url=new URL(request.url);
      if(url.hostname!=='chatgpt.com')return new Response('Blocked test destination',{status:403});
      if(url.pathname==='/api/auth/session')return Response.json({user:{id:'isolated-fixture-account'}});
      if(request.method==='GET'&&url.pathname.startsWith('/backend-api/conversation/'))return records.has(url.pathname.split('/').at(-1))?Response.json(records.get(url.pathname.split('/').at(-1))):new Response('Missing fixture conversation',{status:404});
      if(/\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)&&request.method==='POST'){
        const payload=await request.json();const index=++requestCount;
        embeddedResponses.push({index,at:Date.now(),temporary:payload.history_and_training_disabled===true,projectId:payload.gizmo_id??null,conversationId:payload.conversation_id??null});
        const conversationId=input.projectFixture?'fixture-project-c':'fixture-c-'+index;
        const message={conversation_id:conversationId,message:{id:'fixture-a-'+index,author:{role:'assistant'},channel:'final',recipient:'all',status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:[`BACKGROUND-${index}-OK`]}}};
        records.set(conversationId,{conversation_id:conversationId,gizmo_id:payload.gizmo_id,current_node:message.message.id,mapping:{[message.message.id]:{message:message.message}}});
        return new Response('data: '+JSON.stringify(message)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
      }
      const temporary=url.searchParams.get('temporary-chat')==='true';
      const projectPayload=input.projectFixture?(url.pathname.includes('/c/')?{gizmo_id:projectId,conversation_id:'fixture-project-c'}:{gizmo_id:projectId}):{};
      const thinkingMarkup='<div data-reasoning-slider="true" role="menuitem" aria-describedby="thinking-label"><span role="slider" aria-valuemin="0" aria-valuemax="2" aria-valuenow="0"></span></div><span id="thinking-label" role="status">6 即时，第 1 项，共 3 项。</span>';
      return new Response(`<h1>项目隔离验收</h1>${thinkingMarkup}<textarea id="prompt-textarea"></textarea>${temporary?'<button aria-label="Turn off temporary chat">Temporary</button>':''}<button aria-label="Select ChatGPT model" aria-expanded="false">Model</button><button data-testid="send-button">Send</button><script>const control=document.querySelector("[data-reasoning-slider]");control.onkeydown=e=>{const slider=control.querySelector("[role=slider]");let level=Number(slider.getAttribute("aria-valuenow"));if(e.key==="ArrowRight")level=Math.min(2,level+1);if(e.key==="ArrowLeft")level=Math.max(0,level-1);slider.setAttribute("aria-valuenow",String(level));document.getElementById("thinking-label").textContent="6 "+["即时","中","高"][level]+"，第 "+(level+1)+" 项，共 3 项。"};const picker=document.querySelector('[aria-label="Select ChatGPT model"]');picker.onkeydown=e=>{if(e.key==='Enter'){picker.setAttribute('aria-expanded','true');if(!document.querySelector('[role="menuitemradio"]')){const item=document.createElement('button');item.setAttribute('role','menuitemradio');item.setAttribute('aria-checked','true');item.textContent='GPT-6';document.body.append(item)}}else if(e.key==='Escape')picker.setAttribute('aria-expanded','false')};document.querySelector('[data-testid="send-button"]').onclick=()=>fetch('/backend-api/conversation',{method:'POST',body:JSON.stringify({...${JSON.stringify(projectPayload)},history_and_training_disabled:${temporary},messages:[{id:crypto.randomUUID(),author:{role:'user'},content:{content_type:'text',parts:[document.getElementById('prompt-textarea').value]}}]})}).then(r=>r.text());</script>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
    });
  }
  const wait=async(fn,label,budget=25000)=>{const deadline=Date.now()+budget;while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,25));}throw Error('Background acceptance timeout: '+label);};
  win=await wait(()=>BrowserWindow.getAllWindows()[0],'native window');win.setFocusable(false);
  const evaluate=script=>win.webContents.executeJavaScript(script);
  await wait(()=>evaluate("!!window.petBridge&&!document.getElementById('send').disabled&&window.__aikaAppearanceProbe?.().appearanceReady"),'renderer ready');
  assert.equal(win.isVisible(),false);assert.equal(win.isFocused(),false);
  const originalSend=win.webContents.send.bind(win.webContents);let firstId=null,dropped=0;
  let management;
  if(input.embeddedFixture){management=JSON.parse(readFileSync(join(process.env.AIKI_BOOK_DATA,'management-session.json'),'utf8'));}
  win.webContents.send=(channel,method,message,...rest)=>{
    if(channel==='pet:delivery'&&method==='receive'&&message?.channel==='event'){
      const event=message.event;
      if(event.type==='turn'&&!firstId)firstId=event.input.scope.turnId;
      if(event.type==='reply'&&event.reply.scope.turnId===firstId || event.type==='presentation'&&event.presentation.scope.turnId===firstId&&event.presentation.state==='idle'){dropped++;return;}
    }
    return originalSend(channel,method,message,...rest);
  };
  await evaluate("document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))");
  for(let index=1;index<=2;index++){
    if(input.embeddedFixture&&!input.projectFixture&&index===2){
      const url=new URL(management.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'},base=url.origin+'/api/memory-book/v1';
      const current=await (await fetch(base+'/runtime',{headers})).json();
      const response=await fetch(base+'/runtime',{method:'PUT',headers,body:JSON.stringify({config:{...current.config,chatgptWeb:{...current.config.chatgptWeb,conversationMode:'regular'}},expectedRevision:current.config.revision,operationId:'background-regular-mode'})});
      assert.ok(response.ok,'isolated source mode persisted');
    }
    const started=Date.now(),expected=`BACKGROUND-${index}-OK`;
    await evaluate(`document.getElementById('text').value=${JSON.stringify('后台隔离验收第 '+index+' 轮')};document.getElementById('form').requestSubmit()`);
    await wait(()=>evaluate(`document.getElementById('reply').textContent.includes(${JSON.stringify(expected)})&&!document.getElementById('send').disabled&&document.getElementById('thinking-indicator').hidden`),'reply '+index);
    assert.equal(win.isVisible(),false);assert.equal(win.isFocused(),false);
    const screenshot=join(input.screenshotDirectory,`${input.projectFixture?'project':input.embeddedFixture?'embedded':'background'}-turn-${index}.png`),image=await win.webContents.capturePage();
    assert.ok(!image.isEmpty(),'hidden compositor produced a screenshot');writeFileSync(screenshot,image.toPNG());
    report.screenshots.push(screenshot);report.turns.push({index,expected,displayObservedAt:Date.now(),elapsedMs:Date.now()-started,recoveryRequired:index===1,sendAvailable:true,thinkingEnded:true});save();
  }
  assert.equal(dropped,2,'first reply and idle IPC deliberately omitted');report.droppedFirstTerminalEvents=dropped;
  if(input.projectFixture){
    await evaluate("document.getElementById('drawer-settings').click();document.getElementById('menu-thinking').click()");
    await wait(()=>evaluate("Array.from(document.querySelectorAll('#thinking-panel button')).some(button=>button.textContent==='6 中'&&!button.disabled)"),'native thinking options');
    await evaluate("Array.from(document.querySelectorAll('#thinking-panel button')).find(button=>button.textContent==='6 中').click()");
    await wait(()=>evaluate("Array.from(document.querySelectorAll('#thinking-panel button')).some(button=>button.textContent==='6 中'&&button.getAttribute('aria-pressed')==='true'&&!button.disabled)&&!document.getElementById('send').disabled"),'native thinking confirmed');
    const screenshot=join(input.screenshotDirectory,'thinking-panel.png');writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG());report.screenshots.push(screenshot);report.thinking={selectedLevel:1,verifiedThrough:'renderer → NDJSON → management → real bridge/page keyboard → saved config'};
  }
  if(input.embeddedFixture){assert.deepEqual(embeddedResponses.map(r=>r.temporary),input.projectFixture?[false,false]:[true,false]);report.embeddedResponses=embeddedResponses;}
  if(input.projectFixture){assert.deepEqual(embeddedResponses.map(r=>r.projectId),[projectId,projectId]);assert.deepEqual(embeddedResponses.map(r=>r.conversationId),[null,'fixture-project-c']);report.projectRouting='same project and resumed conversation; ordinary debug records';}
  report.status='PASS';report.finishedAt=new Date().toISOString();save();
}catch(error){report.status='FAIL';report.error=String(error.stack ?? error);save();process.exitCode=1;}
finally{clearTimeout(watchdog);app.quit();}
}
void run();

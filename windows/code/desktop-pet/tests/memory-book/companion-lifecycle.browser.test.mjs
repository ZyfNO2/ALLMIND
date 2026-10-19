import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { createCompanionLifeState } from '../../dist/core/companion-behavior.js';

test('production renderer arbitrates dialogue, touch and life and rejects stale/foreign transport', { timeout: 25000 }, async t => {
  const root = resolve('desktop');
  const server = createServer(async (request, response) => {
    const path = resolve(root, '.' + new URL(request.url, 'http://127.0.0.1').pathname);
    if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    try { const data = await readFile(path); response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream'); response.end(data); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 950 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.hostMessages = []; window.desktopHost = { postMessage(name, value) { window.hostMessages.push({ name, value }); }, subscribe() {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => !!window.petBridge);
  const expectState = async state => {
    try { await page.waitForFunction(state => window.__aikaCompanionProbe().presentation?.characterState === state, state, { timeout: 3000 }); }
    catch (cause) { throw Error(`Expected ${state}: ${JSON.stringify(await page.evaluate(() => ({ probe: window.__aikaCompanionProbe(), hidden: document.hidden, drawerHidden: document.getElementById('drawer').hidden })))}`, { cause }); }
  };
  await page.evaluate(() => { window.petBridge.connectionChanged({ generation: 1, state: 'connecting' }); window.petBridge.receive({ channel: 'backend_ready', bridgeVersion: '0.8.0', characterId: 'aika', characterLabel: '验收角色', sessionId: 'desktop', productMode: 'memory-book' }, 1); });
  const state = { ...createCompanionLifeState({ characterId: 'aika', pairingId: 'local-user' }, Date.now()), activity: 'resting' };
  const sendLife = (sequence, life) => page.evaluate(value => window.petBridge.receive({ channel: 'companion_state', ...value }, 1), { sequence, state: life });
  await sendLife(2, state); await expectState('sleeping');
  await sendLife(1, { ...state, activity: 'walking' }); assert.equal(await page.evaluate(() => window.__aikaCompanionProbe().life.activity), 'resting');
  await sendLife(3, { ...state, characterId: 'foreign' }); assert.equal(await page.evaluate(() => window.__aikaCompanionProbe().life.characterId), 'aika');
  await page.evaluate(state=>window.petBridge.receive({channel:'companion_state',sequence:3,state:{...state,activity:'idle'},focus:true,relationship:{emotion:'happy',intensity:.45,until:Date.now()+10000}},1),state);
  await expectState('idle');
  await page.locator('#model').click({button:'right'});await page.getByRole('button',{name:'更多操作',exact:true}).click();
  assert.equal(await page.getByRole('menuitem',{name:/专注模式/}).count(),0);
  await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.hostMessages.some(message=>message.value?.type==='open_management'&&message.value.path==='/settings')));
  await page.getByRole('button',{name:'收起对话',exact:true}).click();
  await sendLife(4, { ...state, updatedAt: state.updatedAt - 1000, touchedUntil: Date.now() + 4000 });
  await expectState('happy');
  await page.evaluate(state=>window.petBridge.receive({channel:'companion_state',sequence:5,state:{...state,activity:'walking'},focus:true},1),state);
  await expectState('idle');assert.equal(await page.evaluate(()=>window.__aikaCompanionProbe().focus),true);
  await page.locator('#model').click({button:'right'});
  await page.locator('#text').fill('验收输入'); await page.locator('#form').evaluate(form => form.requestSubmit());
  const requestId = await page.evaluate(() => window.hostMessages.findLast(message => message.value?.message?.command?.type === 'submit_text').value.message.command.clientRequestId);
  const scope = { characterId: 'aika', sessionId: 'desktop', turnId: requestId, generation: 1 };
  await page.evaluate(scope => window.petBridge.receive({ channel: 'event', event: { type: 'turn', input: { scope, kind: 'text', startedAt: new Date().toISOString(), text: '验收输入', clientRequestId: scope.turnId } } }, 1), scope);
  await expectState('thinking');
  await page.evaluate(() => window.petBridge.receive({ channel: 'companion_error', message: '独立生活操作失败' }, 1));
  assert.equal(await page.evaluate(() => window.__aikaCompanionProbe().presentation.characterState), 'thinking', 'life errors must not cancel dialogue scope');
  await page.evaluate(() => window.petBridge.desktopVisibility(false));
  assert.equal(await page.evaluate(() => window.__aikaCompanionProbe().hidden), true);
  // Simulate a missing reply/idle IPC. Only the matching receipt may complete it.
  await page.evaluate(scope=>window.petBridge.receive({channel:'book_turn_state',clientRequestId:scope.turnId,scope:{...scope,characterId:'foreign'},state:'completed',text:'不得显示'},1),scope);
  assert.ok(!(await page.locator('#reply').innerText()).includes('不得显示'));
  await page.evaluate(scope=>window.petBridge.receive({channel:'book_turn_state',clientRequestId:scope.turnId,scope,state:'completed',text:'已保存的真实轮次结果'},1),scope);
  assert.ok((await page.locator('#reply').innerText()).includes('已保存的真实轮次结果'));
  assert.equal(await page.locator('#send').isDisabled(),false);
  assert.equal(await page.locator('#thinking-indicator').isVisible(),false);
  const sendCount=await page.evaluate(()=>window.hostMessages.filter(m=>m.value?.message?.command?.type==='submit_text').length);
  await page.locator('#text').fill('第二轮');await page.locator('#form').evaluate(form=>form.requestSubmit());
  const second=await page.evaluate(()=>window.hostMessages.findLast(m=>m.value?.message?.command?.type==='submit_text').value.message.command.clientRequestId);
  await page.locator('#text').fill('忙时重复');await page.locator('#form').evaluate(form=>form.requestSubmit());
  assert.equal(await page.evaluate(()=>window.hostMessages.filter(m=>m.value?.message?.command?.type==='submit_text').length),sendCount+1);
  await page.evaluate(scope=>window.petBridge.receive({channel:'book_turn_state',clientRequestId:scope.turnId,scope,state:'completed',text:'迟到旧结果'},1),scope);
  assert.ok(!(await page.locator('#reply').innerText()).includes('迟到旧结果'));
  await page.locator('#stop').click();
  await page.evaluate(scope=>window.petBridge.receive({channel:'book_turn_state',clientRequestId:scope.turnId,scope,state:'completed',text:'取消后不复活'},1),{...scope,turnId:second,generation:2});
  assert.ok(!(await page.locator('#reply').innerText()).includes('取消后不复活'));
  // A fresh backend restarts generations at one even when desktop session ID stays constant.
  await page.evaluate(()=>{window.petBridge.connectionChanged({generation:2,state:'connecting'});window.petBridge.receive({channel:'backend_ready',bridgeVersion:'0.8.0',characterId:'aika',characterLabel:'验收角色',sessionId:'desktop',productMode:'memory-book',backendInstanceId:'new-backend'},2);});
  await page.locator('#text').fill('重连后的新轮次');await page.locator('#form').evaluate(form=>form.requestSubmit());
  const third=await page.evaluate(()=>window.hostMessages.findLast(m=>m.value?.message?.command?.type==='submit_text').value.message.command.clientRequestId);
  await page.evaluate(scope=>{
    window.petBridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'text',clientRequestId:scope.turnId,text:'重连后的新轮次',startedAt:new Date().toISOString()}}},2);
    window.petBridge.receive({channel:'input_route',scope,route:'companion'},2);
    window.petBridge.receive({channel:'event',event:{type:'reply',reply:{scope,text:'新后端第一轮回复',expression:{emotion:'neutral'}}}},2);
    window.petBridge.receive({channel:'event',event:{type:'presentation',presentation:{scope,state:'idle',expression:{emotion:'neutral'},mouth:0}}},2);
  },{...scope,turnId:third,generation:1});
  assert.ok((await page.locator('#reply').innerText()).includes('新后端第一轮回复'));
  assert.equal(await page.locator('#send').isDisabled(),false);
  await page.evaluate(state=>window.petBridge.receive({channel:'companion_state',sequence:100,state:{...state,activity:'idle'},focus:false,focusTimer:{id:'completed-timer',startedAt:Date.now()-30*60000,until:Date.now()-5*60000,completedAt:Date.now()}},2),state);
  await page.getByRole('button',{name:'更多操作',exact:true}).click();
  assert.equal(await page.getByRole('menuitem',{name:/专注模式/}).count(),0);
  assert.equal(await page.getByRole('menuitemcheckbox',{name:/自主活动/}).count(),1);
  assert.equal(await page.locator('#send').isDisabled(),false,'completion is local status and does not block normal chat');
  await page.evaluate(state=>{
    window.petBridge.receive({channel:'backend_ready',bridgeVersion:'0.8.0',characterId:'native-other',characterLabel:'隔离验收角色 B',sessionId:'desktop',productMode:'memory-book',backendInstanceId:'new-backend'},2);
  },state);
  assert.equal(await page.evaluate(()=>window.__aikaCompanionProbe().life),null,'old role life is cleared at the new role handshake before its first state');
  await page.evaluate(state=>window.petBridge.receive({channel:'companion_state',sequence:101,state:{...state,characterId:'native-other',activity:'idle'},focus:false},2),state);
  await page.waitForFunction(()=>window.__aikaCompanionProbe().life?.characterId==='native-other'&&!document.getElementById('send').disabled,{timeout:5000});
  await page.evaluate(id=>window.petBridge.receive({channel:'book_erased',characterId:'aika',sessionId:'desktop',turnIds:[id]},2),third);
  await page.evaluate(state=>{window.petBridge.receive({channel:'backend_ready',bridgeVersion:'0.8.0',characterId:'aika',characterLabel:'验收角色',sessionId:'desktop',productMode:'memory-book',backendInstanceId:'new-backend'},2);window.petBridge.receive({channel:'companion_state',sequence:102,state,focus:false},2)},state);
  assert.ok(!(await page.locator('#reply').innerText()).includes('新后端第一轮回复'),'erasing an inactive role also removes its cached rows before switching back');
  await page.locator('#text').fill('擦除后正常输入');await page.locator('#form').evaluate(form=>form.requestSubmit());
  const fourth=await page.evaluate(()=>window.hostMessages.findLast(message=>message.value?.message?.command?.type==='submit_text').value.message.command.clientRequestId);
  await page.evaluate(scope=>{window.petBridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'text',clientRequestId:scope.turnId,text:'擦除后正常输入',startedAt:new Date().toISOString()}}},2);window.petBridge.receive({channel:'input_route',scope,route:'companion'},2);window.petBridge.receive({channel:'event',event:{type:'reply',reply:{scope,text:'擦除后正常回复',expression:{emotion:'neutral'}}}},2);window.petBridge.receive({channel:'event',event:{type:'presentation',presentation:{scope,state:'idle',expression:{emotion:'neutral'},mouth:0}}},2)},{...scope,turnId:fourth,generation:2});
  assert.ok((await page.locator('#reply').innerText()).includes('擦除后正常回复'));
  await page.evaluate(id=>window.petBridge.receive({channel:'book_erased',characterId:'aika',sessionId:'desktop',turnIds:[id]},2),fourth);
  assert.ok(!(await page.locator('#reply').innerText()).includes('擦除后正常回复'));
  // companionPresentation is a rAF-throttled arbitration snapshot (main.mjs animate loop, 32ms): the erase
  // clears view/DOM synchronously, but the probe only reflects it on the next frame. Wait for the same
  // condition instead of racing the frame under load.
  await page.waitForFunction(() => window.__aikaCompanionProbe().presentation?.reply === '');
  assert.equal(await page.locator('#send').isDisabled(),false);
  assert.deepEqual(errors, []);
});

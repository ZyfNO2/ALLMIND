import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from '@playwright/test';
import {createCompanionLifeState} from '../../dist/core/companion-behavior.js';

test('production desktop menu stays at seven entries and appearance controls are opt-in',{timeout:30000},async t=>{
  const root=resolve('desktop'),image=await readFile('tests/companion-knowledge/fixtures/ocr/blank.png');
  const server=createServer(async(req,res)=>{
    if(req.url==='/fixture.png'){res.setHeader('Content-Type','image/png');res.end(image);return;}
    const file=resolve(root,'.'+new URL(req.url,'http://127.0.0.1').pathname);
    if(!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
    try{const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]||'application/octet-stream');res.end(data)}catch{res.writeHead(404);res.end()}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done))});
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.hostMessages=[];window.desktopHost={postMessage(name,value){window.hostMessages.push({name,value})},subscribe(){}}});
  const base=`http://127.0.0.1:${server.address().port}/`;
  await page.goto(base+'index.html');await page.waitForFunction(()=>!!window.petBridge);
  const state={...createCompanionLifeState({characterId:'aika',pairingId:'local-user'},Date.now()),activity:'walking'};
  await page.evaluate(state=>{window.petBridge.connectionChanged({generation:1,state:'connecting'});window.petBridge.receive({channel:'backend_ready',bridgeVersion:'0.8.0',characterId:'aika',characterLabel:'AIKI',sessionId:'desktop',productMode:'memory-book'},1);window.petBridge.receive({channel:'companion_state',sequence:1,state},1)},state);
  assert.equal(await page.locator('#drawer-role-name').textContent(),'ALLMIND','legacy default product label is shown as ALLMIND');
  const manifest={type:'sprite',schemaVersion:1,skinId:'menu-test',assetFingerprint:'a'.repeat(64),modelEntry:'fixture.png',catalog:{items:[]},sprite:{rows:1,columns:1,frameCount:1,fps:8,width:image.readUInt32BE(16),height:image.readUInt32BE(20),clips:{happy:{start:0,frameCount:1}}}};
  async function appearance(manifest,id){await page.evaluate(({manifest,id,base})=>window.petBridge.receive({channel:'appearance',requestId:id,manifest,assetBase:base},1),{manifest,id,base});await page.waitForFunction(id=>window.hostMessages.some(row=>row.value?.message?.channel==='ack'&&row.value.message.requestId===id),id)}
  async function menu(){if(await page.locator('#drawer').isHidden())await page.locator('#model').click({button:'right'});if(!await page.locator('#drawer-more-menu').count())await page.locator('#drawer-settings').click()}
  await appearance(manifest,'empty');
  await page.waitForFunction(()=>document.getElementById('model').dataset.localActivity==='walking');
  const verticalOffsets=await page.evaluate(async()=>{
    const offsets=[];for(let frame=0;frame<20;frame++){await new Promise(requestAnimationFrame);offsets.push(new DOMMatrix(getComputedStyle(document.getElementById('model')).transform).m42)}return offsets;
  });
  assert.ok(verticalOffsets.every(y=>Math.abs(y)<0.01),'autonomous activity must not bob the pet vertically');
  await page.evaluate(state=>window.petBridge.receive({channel:'companion_state',sequence:2,state:{...state,activity:'resting',updatedAt:Date.now()}},1),state);
  await page.waitForFunction(()=>document.getElementById('model').dataset.localActivity==='resting');
  assert.equal(await page.locator('#model').evaluate(canvas=>getComputedStyle(canvas).transform),'none','resting must not shift or shrink the pet');
  await menu();
  for(const label of ['投喂','赠送小礼物','玩纸团','玩耍','窗口停靠（交互占位）','窗口跳转（交互占位）'])assert.equal(await page.getByRole('menuitem',{name:label,exact:true}).count(),0);
  assert.equal(await page.getByRole('menuitem',{name:/再来一次常用互动/}).count(),0);
  assert.equal(await page.getByRole('menuitem',{name:'设置',exact:true}).count(),1);
  const declared={...manifest,localInteractions:{schemaVersion:'local-pet/v1',skinId:manifest.skinId,assetFingerprint:manifest.assetFingerprint,bindings:{feeding:{kind:'sprite',targetId:'happy'}}}};
  await appearance(declared,'feed-only');await menu();
  const expected=['免打扰：已关闭','本地无痕：已关闭','自主活动：已开启','Memory Book','打开管理','设置','收起到系统托盘'];
  assert.deepEqual(await page.locator('#drawer-more-menu button').allTextContents(),expected,'resource actions must not expand the quick menu');
  assert.equal(await page.getByRole('menuitemcheckbox').count(),3);
  await page.locator('#menu-quiet').focus();await page.keyboard.press('ArrowDown');assert.equal(await page.locator('#menu-incognito').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#drawer-settings').evaluate(node=>node===document.activeElement),true);
  assert.equal(await page.locator('#size-panel').isHidden(),true,'appearance defaults closed');
  await page.getByRole('button',{name:'外观与大小',exact:true}).click();assert.equal(await page.locator('#size-panel').isVisible(),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#size-panel').isHidden(),true);assert.equal(await page.locator('#drawer-appearance').evaluate(node=>node===document.activeElement),true);
  await page.setViewportSize({width:390,height:844});await menu();
  const box=await page.locator('#drawer-more-menu').boundingBox();assert.ok(box.y>=0&&box.y+box.height<=844,'quick menu fits a narrow viewport');
  await mkdir('../../../validation/output/menu-cleanup',{recursive:true});await page.screenshot({path:'../../../validation/output/menu-cleanup/desktop-menu.png',fullPage:true});
  await appearance(manifest,'removed');
  assert.equal(await page.evaluate(()=>window.__aikaCompanionProbe().localAction),null);
  assert.equal(await page.evaluate(()=>window.hostMessages.filter(row=>row.value?.message?.channel==='local_pet_complete').length),0);
  assert.deepEqual(errors,[]);
});

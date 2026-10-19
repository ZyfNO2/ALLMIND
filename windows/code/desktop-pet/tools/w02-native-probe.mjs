import {app,BrowserWindow,nativeImage} from 'electron';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const directory=process.env.AIKI_BOOK_DATA,input=JSON.parse(readFileSync(join(directory,'w02-native-input.json'),'utf8')),stage=process.argv[process.argv.indexOf('--w02-stage')+1];
const report={stage,status:'IN_PROGRESS',source:'isolated production Electron host / renderer / Book HTTP with original user-supplied portraits',checks:[]},file=join(input.evidence,'native-'+stage+'.json'),save=()=>writeFileSync(file,JSON.stringify(report,null,2)+'\n'),mark=(name,value)=>{report.checks.push({name,value});save()};
const ignored=BrowserWindow.prototype.setIgnoreMouseEvents;BrowserWindow.prototype.setIgnoreMouseEvents=function(value,...args){this.w02MouseIgnored=value;return ignored.call(this,value,...args)};
let win;
async function run(){try{
 await import('../desktop/electron/main.mjs');await app.whenReady();
 const wait=async(fn,label)=>{const until=Date.now()+30000;while(Date.now()<until){const result=await fn();if(result)return result;await new Promise(done=>setTimeout(done,80));}throw Error('Timeout: '+label);};
 win=await wait(()=>BrowserWindow.getAllWindows().find(row=>row.webContents.getURL().startsWith('pet:')),'renderer');win.setFocusable(false);win.showInactive();
 const evaluate=code=>win.webContents.executeJavaScript(code),probe=()=>evaluate('window.__aikaCompanionProbe?.()');
 const expected=stage==='restart'?input.generatedVariant:input.variants[0];
 await wait(async()=>{const current=await probe();return current?.renderer?.skinId===expected.skinId&&current.renderer.placement&&current.appearanceRequestId},'persisted static portrait actually drawn');
 assert.equal(app.getName(),'ALLMIND');assert.match(win.getTitle(),/ALLMIND/);const icon=nativeImage.createFromPath(resolve('desktop/assets/allmind/icon-32.png'));assert.equal(icon.isEmpty(),false);mark('native ALLMIND window title and derived icon decode',{title:win.getTitle(),icon:icon.getSize()});
 mark('startup uses selected portrait from durable collection',(await probe()).renderer);
 const session=new URL(JSON.parse(readFileSync(join(directory,'management-session.json'),'utf8')).url),headers={Authorization:'Bearer '+new URLSearchParams(session.hash.slice(1)).get('token'),'Content-Type':'application/json'},scope={characterId:'aika',sessionId:'w02-native'},query='?'+new URLSearchParams(scope);
 const api=async(path,body,method)=>{const response=await fetch(session.origin+'/api/memory-book/v1'+path,{method:method??(body?'POST':'GET'),headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)}),result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));return result;};
 if(stage==='initial'){
  assert.equal((await probe()).renderer.framing,'full');writeFileSync(join(input.evidence,'native-full.png'),(await win.webContents.capturePage()).toPNG());
  const applied=await api('/appearance/outfits/'+input.realJob.id+'/apply',{...scope,resourceId:input.realJob.images[0].resourceId,sha256:input.realJob.images[0].sha256,expectedAppearanceRevision:input.realJob.expectedAppearanceRevision,operationId:'native-real-apply'});
  const afterApply=await api('/appearance/portraits'+query);input.generatedVariant=afterApply.variants.find(row=>row.id===applied.appliedVariantId);assert.ok(input.generatedVariant);assert.equal((await probe()).renderer.skinId,input.generatedVariant.skinId);
  writeFileSync(join(input.evidence,'native-real-generated.png'),(await win.webContents.capturePage()).toPNG());mark('actual received GPT output applies through production OutfitService and native acknowledgement',{phase:applied.phase,variant:input.generatedVariant,provenance:input.provenance});
  let set=await api('/appearance/portraits'+query);set=await api('/appearance/portraits/select',{...scope,variantId:input.variants[1].id,expectedRevision:set.revision,operationId:'native-select-2'});
  assert.equal((await probe()).renderer.skinId,input.variants[1].skinId);mark('select HTTP returns only after native portrait acknowledgement',set.selectedVariantId);
  set=await api('/appearance/portraits/framing',{...scope,framing:'bust',expectedRevision:set.revision,operationId:'native-bust'});
  await wait(async()=>(await probe()).renderer.framing==='bust','bust actually drawn');assert.ok((await probe()).renderer.placement.source.height<1448);writeFileSync(join(input.evidence,'native-bust.png'),(await win.webContents.capturePage()).toPNG());mark('bust changes the viewport of the original image',(await probe()).renderer);
  set=await api('/appearance/portraits/framing',{...scope,framing:'full',expectedRevision:set.revision,operationId:'native-full'});
  const preferences=await api('/desktop/preferences');await api('/desktop/preferences',{expectedRevision:preferences.revision,operationId:'native-half',patch:{mode:'half',preferredWidth:320}},'PUT');await wait(async()=>(await probe()).renderer.framing==='bust','native half menu maps to sprite bust');mark('host half display drives actual sprite framing',(await probe()).renderer.framing);
  const currentPreferences=await api('/desktop/preferences');await api('/desktop/preferences',{expectedRevision:currentPreferences.revision,operationId:'native-host-full',patch:{mode:'full'}},'PUT');await wait(async()=>(await probe()).renderer.framing==='full','native full display');
  const shell=value=>evaluate(`window.desktopHost.postMessage('shell',${JSON.stringify(value)})`);
  const before=win.getBounds();await shell({type:'drag',dx:21,dy:11});await wait(()=>win.getBounds().x!==before.x||win.getBounds().y!==before.y,'native drag');await shell({type:'drag_end'});mark('production shell drag updates real window bounds',{before,after:win.getBounds()});
  await shell({type:'set_click_through',enabled:true});await shell({type:'pointer_position',inside:false});await wait(()=>win.w02MouseIgnored===true,'outside pointer passes through');
  const hit=(await probe()).renderer.interactiveRect;await shell({type:'pointer_position',inside:true,x:hit.x+hit.width/2,y:hit.y+hit.height/2});await wait(()=>win.w02MouseIgnored===false,'portrait receives pointer');
  await shell({type:'pointer_position',inside:true,x:1,y:1});await wait(()=>win.w02MouseIgnored===true,'transparent margin passes through');await shell({type:'set_click_through',enabled:false});mark('real host mouse policy follows rendered portrait content bounds',hit);
  await evaluate("document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));document.getElementById('drawer-settings').click()");const menu=await evaluate("Array.from(document.querySelectorAll('#drawer-more-menu [role^=menuitem]')).map(row=>row.textContent)");for(const forbidden of ['投喂','赠送小礼物','玩纸团','窗口停靠（交互占位）','窗口跳转（交互占位）'])assert.ok(!menu.includes(forbidden));mark('undeclared portrait interactions absent in native menu',menu);await evaluate("document.getElementById('close').click()");
  set=await api('/appearance/portraits/select',{...scope,variantId:input.generatedVariant.id,expectedRevision:set.revision,operationId:'native-persist-generated'});
  await api('/appearance/portraits/framing',{...scope,framing:'bust',expectedRevision:set.revision,operationId:'native-persist-bust'});writeFileSync(join(directory,'w02-native-input.json'),JSON.stringify(input));
 }else{assert.equal((await probe()).renderer.framing,'bust');mark('full Electron restart restores selected variant and framing',(await probe()).renderer);}
 report.status='AUTO_PASS_PENDING_USER_REVIEW';
}catch(error){report.status='FAILED';report.error=error.stack;console.error(error.stack);process.exitCode=1;}finally{save();app.quit();}}
void run();

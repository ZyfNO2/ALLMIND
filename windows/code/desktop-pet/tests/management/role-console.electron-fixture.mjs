// Isolated native host: actual desktop HTML, renderer bundle, preload and registry asset handler.
import { app, BrowserWindow, protocol, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
app.setPath('userData',join(config.scratch,'electron-user-data'));
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
protocol.registerSchemesAsPrivileged([{scheme:'pet',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const events=[], errors=[];
ipcMain.on('pet:diagnostic',(_event,value)=>events.push(value));
ipcMain.on('pet:desktop',(_event,value)=>events.push(value.message));
app.whenReady().then(async()=>{
  let win;
  try {
    const {assetResponse}=await import(pathToFileURL(join(config.root,'desktop/electron/assets.mjs')).href);
    const routes=new Map(config.assets);
    protocol.handle('pet',req=>assetResponse(join(config.root,'desktop'),req.url,routes));
    win=new BrowserWindow({show:false,width:360,height:550,webPreferences:{preload:join(config.root,'desktop/electron/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
    await win.loadURL('pet://app/index.html');
    const run=code=>win.webContents.executeJavaScript(code);
    const wait=async check=>{const start=Date.now();while(!check()){if(Date.now()-start>15000)throw Error('native fixture timeout: '+JSON.stringify(events.slice(-4)));await new Promise(resolve=>setTimeout(resolve,20));}};
    await wait(()=>events.some(e=>e.type==='model-loaded'));
    await run(`window.petBridge.connectionChanged({generation:1,state:'connecting'}); window.petBridge.receive({channel:'backend_ready',bridgeVersion:'0.8.0',characterId:'companion',sessionId:'fixture'},1);`);
    const receive=async(index,manifest)=>{await run(`window.petBridge.receive(${JSON.stringify({channel:'appearance',requestId:`native-${index}`,manifest,assetBase:`pet://app/skin-assets/${index}/`})},1)`);await wait(()=>events.some(e=>e.requestId===`native-${index}`));return events.find(e=>e.requestId===`native-${index}`);};
    const results=[];
    for (const [index,manifest] of config.manifests.entries()) {
      const receipt=await receive(index,manifest);
      if(receipt.channel!=='ack')throw Error('Native switch refused: '+JSON.stringify(receipt));
      // WebGL's default framebuffer clears after composition. Sample inside the real animation frame,
      // after the production renderer's registered frame callback, rather than changing its options.
      const pixels=await run(`new Promise((resolve,reject)=>{const start=performance.now();function sample(){const canvas=document.getElementById('model'),gl=canvas.getContext('webgl');let bytes;if(gl){bytes=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);}else bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let paintedPixels=0,redPixels=0;for(let i=0;i<bytes.length;i+=4){if(bytes[i+3])paintedPixels++;if(bytes[i]>240&&bytes[i+1]<15&&bytes[i+2]<15&&bytes[i+3]>240)redPixels++;}if(paintedPixels>500)resolve({width:canvas.width,height:canvas.height,paintedPixels,redPixels,visible:true,count:document.querySelectorAll('#model').length});else if(performance.now()-start>15000)reject(Error('No rendered pixels in animation frames'));else requestAnimationFrame(sample);}requestAnimationFrame(sample);})`);
      results.push({type:manifest.type||'live2d',receipt,pixels});
      if(!pixels.visible||pixels.count!==1)throw Error('Native canvas did not render visible pixels: '+JSON.stringify(pixels));
      if(manifest.type==='sprite'&&pixels.redPixels<500)throw Error('Sprite fixture red pixels were not rendered');
      await run(`window.fixtureOriginal = document.getElementById('model')`);
      const rejected=await receive(index+'-bad',{...manifest,modelEntry:'missing-asset.png'});
      const retained=await run(`window.fixtureOriginal===document.getElementById('model')&&document.querySelectorAll('#appearance-candidate').length===0`);
      if(rejected.channel!=='rpc_error'||!retained)throw Error('Failed switch did not retain old canvas');
    }
    const diagnostics=events.filter(e=>e.type==='model-loaded').map(e=>({skinId:e.skinId,runtime:e.runtime}));
    writeFileSync(config.result,JSON.stringify({results,diagnostics,errors}));win.destroy();app.exit(0);
  } catch(error) { writeFileSync(config.result,JSON.stringify({error:error.stack,events,errors}));win?.destroy();app.exit(1); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFile,readFile,mkdir } from 'node:fs/promises';
import { roleConsoleFixture } from './role-console-fixture.mjs';
test('实际桌面 renderer：Sprite 与 Live2D 切换、可见像素、失败保留原 Canvas', {timeout:60000},async t=>{
  const f=await roleConsoleFixture(t), browser=await chromium.launch();
  try {
    const page=await browser.newPage(), data=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,16,16);return canvas.toDataURL().split(',')[1];});
    const file=join(f.c.projectRoot,'native.png');await writeFile(file,Buffer.from(data,'base64'));await f.skins.import(file,{type:'sprite',skinId:'native-sprite'});
  } finally {await browser.close();}
  const assets=[], manifests=[];
  for(const [index,id] of ['native-sprite','local-model'].entries()) {
    const routes=f.skins.routes(id);manifests.push(JSON.parse(routes.get('pet.skin.json').body));
    for(const [name,route] of routes)assets.push([`skin-assets/${index}/${name}`,route]);
  }
  const result=join(f.c.projectRoot,'native-result.json'), config=join(f.c.projectRoot,'native-config.json');
  await writeFile(config,JSON.stringify({root:f.root,scratch:f.c.projectRoot,result,assets,manifests}));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const code=await new Promise((resolve,reject)=>{const child=spawn(createRequire(import.meta.url)('electron'),[join(f.root,'tests/management/role-console.electron-fixture.mjs'),config],{env,windowsHide:true,stdio:'ignore'});const timer=setTimeout(()=>{child.kill();reject(Error('native renderer timeout'));},45000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  const report=JSON.parse(await readFile(result,'utf8')); assert.equal(code,0,JSON.stringify(report));assert.equal(report.results.length,2);assert.ok(report.results.every(item=>item.pixels.visible));
  const reports=join(f.root,'.local/reports/role-console');await mkdir(reports,{recursive:true});await writeFile(join(reports,'native-renderer.json'),JSON.stringify(report,null,2));
});

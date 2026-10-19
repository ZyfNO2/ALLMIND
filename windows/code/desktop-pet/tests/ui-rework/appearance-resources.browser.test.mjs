import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { roleConsoleFixture } from '../management/role-console-fixture.mjs';
import { startManagementServer } from '../../dist/management/server.js';
import { desktopHostManagement } from '../../dist/management/desktop-host-routes.js';
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js';
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js';

test('appearance stays in React: native ticket import, real Sprite preview, explicit role-scoped apply and cleanup', {timeout:60000}, async t=>{
  const f=await roleConsoleFixture(t),browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=32;c.height=32;const x=c.getContext('2d');x.fillStyle='red';x.fillRect(0,0,32,32);return c.toDataURL().split(',')[1]});
  const image=join(f.c.projectRoot,'anonymous-sprite.png');await writeFile(image,Buffer.from(png,'base64'));
  const nativeCalls=[];
  const host=desktopHostManagement({async request(method,input){nativeCalls.push({method,input});return input.type==='sprite'?{outcome:'selected',source:image,root:image,displayName:'anonymous-sprite.png',entries:[]}:{outcome:'cancelled'}}},{instanceId:'appearance-browser',skins:f.skins});
  const presets=await CharacterPresetStore.open({memory:f.memory,settings:f.settings,skins:f.skins,base:f.c,roleConfigurations:f.roles});
  const server=await startManagementServer({uiRoot: resolve('management'),settings:f.settings,memory:f.memory,presets,roleConfigurations:f.roles,skins:f.skins,desktopHost:host,presentationAssets:await presentationAssetRoutes(resolve('../..')),snapshot:()=>f.request('/api/snapshot')});
  t.after(()=>server.close());
  const before=f.skins.state(),roleBefore=f.roles.get('role-b');
  await page.goto(`${server.origin}/characters/role-b/config#token=${server.token}`);
  // LUI-02 tab-ified the config page: the resource panel lives in the 形象 tab.
  await page.getByRole('button',{name:'形象',exact:true}).click();
  await expect(page.getByRole('button',{name:'导入资源',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'导入资源',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'资源导入'});
  await expect(dialog).toBeVisible();assert.match(page.url(),/characters\/role-b\/config\?tab=appearance$/);
  await dialog.getByRole('button',{name:'选择模型包目录',exact:true}).click();await expect(dialog.getByText('已取消选择，没有改动任何设置。',{exact:true})).toBeVisible();assert.equal(f.skins.state().revision,before.revision);
  await dialog.getByLabel('导入类型',{exact:true}).selectOption('sprite');
  await dialog.getByRole('button',{name:'选择 PNG / WebP',exact:true}).click();await expect(dialog.getByText('已选择：anonymous-sprite.png',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'确认导入',exact:true}).click();
  // CUX-01: 导入成功后自动关闭弹窗、选中新资源并在形象页内嵌预览（不自动应用）。
  await expect(page.getByText('已导入并预览，尚未应用。',{exact:true})).toBeVisible({timeout:60000});
  await expect(dialog).toHaveCount(0,{timeout:60000});
  assert.equal(f.skins.state().revision,before.revision+1);assert.equal(f.skins.state().activeSkinId,before.activeSkinId);assert.deepEqual(f.roles.get('role-b'),roleBefore);
  await expect(page.getByText(/正在预览：anonymous-sprite/)).toBeVisible();
  await page.waitForFunction(()=>{const c=[...document.querySelectorAll('canvas[aria-label="资源实际预览"]')].find(item=>!item.hidden);const x=c?.getContext('2d');return x&&c&&c.width>1&&x.getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)});
  const imported=f.skins.list().find(s=>s.origin==='imported');assert.ok(imported);
  // DUX-02: preview follows the selection automatically — there is no permanent close button. Switching
  // the resource selection away must show the selection prompt; canvases stay in the DOM (context reuse).
  await page.locator('#appearance-type').selectOption('live2d');
  await expect(page.getByText('请选择要预览的已登记资源。',{exact:true})).toBeVisible();
  // A non-running role saves its own selection (`保存到该角色`); only the running role flips the live skin.
  await page.locator('#appearance-type').selectOption('sprite');
  await page.locator('#appearance-resource').selectOption(imported.skinId);
  await page.getByRole('button',{name:'保存到该角色',exact:true}).click();await expect(page.getByText(/角色形象已保存/)).toBeVisible();
  assert.equal(f.roles.get('role-b').appearance.resourceId,imported.skinId);assert.equal(f.roles.get('companion').appearance.resourceId,'local-model');assert.equal(f.skins.state().activeSkinId,before.activeSkinId);
  assert.ok(nativeCalls.every(c=>c.input.characterId==='role-b'));assert.ok(!requests.includes('/legacy.html'));assert.ok(!requests.includes('/app.mjs'));assert.deepEqual(errors,[]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';

test('Endfield reading surfaces remain usable across light/dark, narrow screens and reduced motion',{timeout:120000},async t=>{
 const output=resolve(process.env.ALLMIND_UI_TEST_OUTPUT??'.local/endfield-ui');mkdirSync(output,{recursive:true});
 const directory=mkdtempSync(join(output,'visual-')),repository=new FileBookRepository(directory);
 let modelCalls=0;const runtime=new BookRuntime(repository,{async complete(){modelCalls++;throw Error('Visual checks must never call a provider');}});
 const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management')});
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close();});
 const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});page.setDefaultTimeout(10000);
 const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).origin!==new URL(server.url).origin)external.push(r.url());});
 await page.goto(server.url);await page.getByLabel('聊天消息',{exact:true}).waitFor();
 const nav=name=>page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name,exact:true});
 const geometries=[];
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>{localStorage.setItem('aiki-theme',theme);window.dispatchEvent(new Event('allmind-theme-change'));},theme);
  for(const width of [375,768,1024,1440]){
   await page.setViewportSize({width,height:960});
   for(const name of ['首页','角色','记忆','设置']){
    await nav(name).click();
    const facts=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme}));
    assert.ok(facts.scrollWidth<=facts.width,`${name}/${theme}/${width} must not overflow: ${JSON.stringify(facts)}`);assert.equal(facts.theme,theme);geometries.push({name,...facts});
    if(name==='首页'){
     const box=await page.getByLabel('聊天消息',{exact:true}).boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=960,`composer must be reachable at ${width}/${theme}`);
    }
    if(width===1440||width===375)await page.screenshot({path:join(output,`endfield-${theme}-${width}-${{首页:'chat',角色:'role',记忆:'memory',设置:'settings'}[name]}.png`),fullPage:true});
   }
  }
 }
 await page.setViewportSize({width:1440,height:960});await nav('首页').click();
 await page.getByLabel('聊天消息',{exact:true}).focus();
 const focus=await page.getByLabel('聊天消息',{exact:true}).evaluate(el=>({focused:el===document.activeElement,outline:getComputedStyle(el).outlineStyle}));assert.equal(focus.focused,true);assert.notEqual(focus.outline,'none');
 await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.fonts.check('16px Saira')),true,'local font loaded');assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(modelCalls,0);
 writeFileSync(join(output,'endfield-result.json'),JSON.stringify({status:'PASS',provider:'NOT_CALLED',geometries,pageErrors:errors,externalRequests:external,reducedMotion:true},null,2));
});

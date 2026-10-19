import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {pageAction} from '../../dist/providers/chatgpt-background-bridge.js';
import {consumeChatgptStreamEvent} from '../../dist/providers/chatgpt-stream-observer.js';

test('model trigger variants work without aria-haspopup and reject ambiguous visible triggers',{timeout:30000},async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:'<main></main>'}));
  await page.goto('https://chatgpt.com/');
  for(const attr of ['data-testid="model-switcher-dropdown-button"','aria-label="Model selector, current model is GPT-6"']){
    await page.setContent(`<button ${attr} aria-expanded="false">GPT-6</button><div role="menu" hidden><button role="menuitemradio" aria-checked="false">GPT-6</button></div><script>(()=>{const picker=document.querySelector('button'),menu=document.querySelector('[role=menu]'),option=menu.querySelector('button');picker.onclick=()=>{menu.hidden=false;picker.setAttribute('aria-expanded','true')};picker.onkeydown=e=>{if(e.key==='Escape'){menu.hidden=true;picker.setAttribute('aria-expanded','false')}};option.onclick=()=>{option.setAttribute('aria-checked','true');menu.hidden=true;picker.setAttribute('aria-expanded','false')};})();</script>`);
    await page.addScriptTag({content:`window.productionPageAction=${pageAction.toString()};`});
    assert.equal((await page.evaluate(()=>window.productionPageAction('model',{model:'GPT-6'},()=>null))).model,'GPT-6');
    assert.equal(await page.getByRole('menuitemradio',{includeHidden:true}).getAttribute('aria-checked'),'true');
  }
  await page.setContent('<button aria-label="Select ChatGPT model">One</button><button data-testid="model-switcher-dropdown-button">Two</button>');
  await assert.rejects(page.evaluate(()=>window.productionPageAction('model',{model:'GPT-6'},()=>null)),/多个可见模型按钮/);
  await page.setContent('<button data-testid="model-switcher-dropdown-button" disabled>Disabled</button><button aria-label="Select ChatGPT model" style="visibility:hidden">Hidden</button>');
  await assert.rejects(page.evaluate(()=>window.productionPageAction('model',{model:'GPT-6'},()=>null)),/无法确认唯一模型按钮/);
});
test('production model selection waits for delayed exact options and ignores hidden duplicates',{timeout:20000},async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:`<button aria-label="Select ChatGPT model" aria-expanded="false">Model</button><div hidden><button role="menuitemradio" aria-checked="true">GPT-6</button></div><script>const picker=document.querySelector('button');picker.onkeydown=event=>{if(event.key==='Enter'){picker.setAttribute('aria-expanded','true');setTimeout(()=>{const item=document.createElement('button');item.setAttribute('role','menuitemradio');item.setAttribute('aria-checked','true');item.textContent='GPT-6';document.body.append(item)},900)}else if(event.key==='Escape')picker.setAttribute('aria-expanded','false')};</script>`}));
  await page.goto('https://chatgpt.com/');await page.addScriptTag({content:`window.productionPageAction=${pageAction.toString()};`});
  const start=Date.now(),result=await page.evaluate(()=>window.productionPageAction('model',{model:'GPT-6'},()=>null));assert.equal(result.model,'GPT-6');assert.ok(Date.now()-start>=800);
  assert.equal(await page.locator('button[aria-label="Select ChatGPT model"]').getAttribute('aria-expanded'),'false');
  await page.setContent('<div>Page without a model selector</div>');
  assert.deepEqual(await page.evaluate(()=>window.productionPageAction('model',{model:'current'},()=>null)),{model:'current'},'explicit current model does not require a selector');
  await assert.rejects(page.evaluate(()=>window.productionPageAction('model',{model:'GPT-6'},()=>null)),/跟随网页当前模型/,'a requested named model must fail clearly, never silently fall back');
});

test('stream handoff recovers only the exact submitted user boundary and a completed final message',{timeout:20000},async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  let userId='u-1';
  await page.route('https://chatgpt.com/**',route=>{
    if(route.request().url().includes('/backend-api/conversation/c-1'))return route.fulfill({contentType:'application/json',body:JSON.stringify({conversation_id:'c-1',current_node:'a',mapping:{a:{parent:'u',message:{id:'a-1',author:{role:'assistant'},channel:'final',recipient:'all',status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:['handoff-final']}}},u:{parent:null,message:{id:userId,author:{role:'user'},content:{content_type:'text',parts:['exact-prompt']}}}}})});
    return route.fulfill({contentType:'text/html',body:'<textarea></textarea>'});
  });
  await page.goto('https://chatgpt.com/');await page.addScriptTag({content:`window.productionPageAction=${pageAction.toString()};window.consume=${consumeChatgptStreamEvent.toString()};`});
  await page.evaluate(()=>{window.__aikiChatRequest={id:'r-1',temporary:true,prompt:'exact-prompt',sentPrompt:'exact-prompt',userMessageId:'u-1',submitted:true,streamEnded:false,stream:{document:{},path:'',operation:'',done:false,error:null,handoff:{conversationId:'c-1',turnExchangeId:'t-1'}}};});
  const read=()=>page.evaluate(()=>window.productionPageAction('read',{id:'r-1'},window.consume));
  assert.equal((await read()).text,'handoff-final');userId='foreign';assert.equal((await read()).state,'incomplete');
});

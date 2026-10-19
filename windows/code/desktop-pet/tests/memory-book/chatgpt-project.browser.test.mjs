import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {chatgptPageScript} from '../../dist/providers/chatgpt-background-bridge.js';
const projectId='g-p-'+'a'.repeat(32);
test('project page blocks wrong native project and refuses foreign thread ancestry before any message',{timeout:25000},async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();let posts=0,gizmo='g-p-'+'b'.repeat(32),node='a-1';
  await page.route('https://chatgpt.com/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/backend-api/conversation/c-1')return route.fulfill({json:{conversation_id:'c-1',gizmo_id:gizmo,current_node:'n',mapping:{n:{message:{id:node}}}}});
    if(route.request().method()==='POST'){posts++;return route.fulfill({body:'unexpected POST'});}
    return route.fulfill({contentType:'text/html',body:`<h1>Test Project</h1><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><script>document.querySelector('button').onclick=()=>fetch('/backend-api/conversation',{method:'POST',body:JSON.stringify({gizmo_id:'wrong-project',messages:[{id:'u-1',author:{role:'user'},content:{content_type:'text',parts:[document.querySelector('textarea').value]}}]})}).catch(()=>{});</script>`});
  });
  await page.goto('https://chatgpt.com/g/'+projectId+'/project');
  const call=(action,input={})=>page.evaluate(chatgptPageScript(action,input));
  assert.equal((await call('project',{projectId})).memory,'unverified');
  await call('prepare',{id:'r-1',projectId,temporary:false});await call('write',{id:'r-1',text:'private-context'});await call('submit',{id:'r-1'});
  await page.waitForFunction(()=>Boolean(window.__aikiChatRequest?.blockedMessage));assert.equal(posts,0);
  assert.equal((await call('submission',{id:'r-1'})).submitted,false);
  await assert.rejects(call('project',{projectId,conversationId:'c-1',expectedNode:'a-1'}),/归属/);
  gizmo=projectId;node='external-change';await assert.rejects(call('project',{projectId,conversationId:'c-1',expectedNode:'a-1'}),/外部修改/);
  node='a-1';assert.equal((await call('project',{projectId,conversationId:'c-1',expectedNode:'a-1'})).currentNode,'a-1');assert.equal(posts,0);
});

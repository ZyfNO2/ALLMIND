import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { artifactAction } from '../../providers/chatgpt-artifacts.js';
import {pageAction} from '../../providers/chatgpt-background-bridge.js';
import {consumeChatgptStreamEvent} from '../../providers/chatgpt-stream-observer.js';

test('an aborted native stream recovers only the same user request through verified readback',async()=>{
 const user={id:'user-1',author:{role:'user'},content:{parts:['本次换装测试']}};
 const final={id:'final-1',author:{role:'assistant'},status:'finished_successfully',end_turn:true,channel:'final',recipient:'all',content:{content_type:'multimodal_text',parts:[{asset_pointer:'file-service://file-generated'}]}};
 const context={window:{__aikiChatRequest:{id:'request-1',temporary:false,submitted:true,prompt:'本次换装测试',sentPrompt:'本次换装测试',userMessageId:'user-1',streamEnded:true,stream:{document:{conversation_id:'conversation-1'},done:false,error:'原生流观察失败：AbortError: BodyStreamBuffer was aborted'}}},location:{hostname:'chatgpt.com',pathname:'/c/conversation-1'},document:{querySelector:()=>null,querySelectorAll:()=>[]},AbortSignal,fetch:async()=>({ok:true,status:200,json:async()=>({conversation_id:'conversation-1',current_node:'final',mapping:{user:{message:user,parent:null},final:{message:final,parent:'user'}}})})};
 const run=()=>vm.runInNewContext(`(${pageAction.toString()})('read',{id:'request-1'},${consumeChatgptStreamEvent.toString()})`,context);
 const result=await run();assert.equal(result.state,'completed');assert.equal(result.messageId,'final-1');
 user.id='foreign';const rejected=await run();assert.equal(rejected.state,'incomplete');assert.match(rejected.message,/不属于本次/);
});

test('generated image probe reads only the successor of this user message', async () => {
  const png = { asset_pointer: 'file-service://file-generated', name: 'outfit.png', mime_type: 'image/png' };
  const mapping = {
    user: { message: { id: 'user-1', author: { role: 'user' } }, children: ['tool'] },
    tool: { message: { id: 'tool-1', author: { role: 'tool' }, content: { parts: [png] } }, children: ['final'] },
    old: { message: { id: 'old-image', author: { role: 'tool' }, content: { parts: [{ asset_pointer: 'file-service://file-old', name: 'old.png' }] } }, children: [] },
    final: { message: { id: 'final-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['好的'] } }, children: [] }
  };
  const request = { id: 'request-1', userMessageId: 'user-1', terminalMessage: mapping.final.message, stream: { document: { conversation_id: 'conversation-1' } }, artifacts: {} };
  const calls: string[] = [];
  const context = {
    window: { __aikiChatRequest: request },
    location: { origin: 'https://chatgpt.com', pathname: '/c/conversation-1' },
    URL, fetch: async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ conversation_id: 'conversation-1', mapping }) }; },
    AbortSignal: { timeout: () => new AbortController().signal }
  };
  const output = await vm.runInNewContext(`(${artifactAction.toString()})('artifacts', ${JSON.stringify({ id: 'request-1', includeGenerated: true })})`, context) as { discovery: string; artifacts: { nameHint: string }[] };
  assert.equal(output.discovery, 'complete');
  assert.equal(output.artifacts.length, 1);
  assert.equal(String(output.artifacts[0]!.nameHint), 'outfit.png');
  assert.equal(calls.some(url => url.includes('/backend-api/conversation/conversation-1')), true);
  assert.equal(output.artifacts.some(item => item.nameHint === 'old.png'), false);
});

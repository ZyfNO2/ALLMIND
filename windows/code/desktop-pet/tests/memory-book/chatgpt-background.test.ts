import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../contracts/memory-book.js';
import { ChatgptBackgroundBridge } from '../../providers/chatgpt-background-bridge.js';
import { ChatgptWebModel } from '../../providers/chatgpt-web-model.js';
import type { ChatgptToolRunner } from '../../providers/chatgpt-web-bridge.js';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

test('explicit stop releases a persisted closed extension tab, records unknown outcome and never replays after restart',async()=>{
 mkdirSync('.local/memory-book-tests',{recursive:true});const receiptPath=join(mkdtempSync('.local/memory-book-tests/dead-tab-'),'receipts.json');
 writeFileSync(receiptPath,JSON.stringify({used:['old-tab-request'],active:{id:'old-tab-request',submitted:'yes'}}));
 let submits=0;const pageHost={async login(){},async navigate(){},async execute(){throw Error('Error: No tab with id: 628202419.')}};
 const bridge=new ChatgptBackgroundBridge({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'bridge'}),receiptPath,pageHost});
 await assert.rejects(bridge.resume('old-tab-request',100),/No tab/);assert.equal(bridge.currentRequest()?.requestId,'old-tab-request','resume failure must not silently release');
 const result=await bridge.cancel('old-tab-request');assert.equal(result.kind,'cancelled');assert.equal(result.kind==='cancelled'&&result.confirmed,false);assert.equal(bridge.currentRequest(),null);assert.equal(bridge.requestStatus('old-tab-request')?.outcome,'unknown');
 const restarted=new ChatgptBackgroundBridge({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded'}),receiptPath,intervalMs:0,pollMs:1,pageHost:{async login(){},async navigate(){},async execute(action){if(action==='probe')return{ready:true,temporary:true,hasTurns:false};if(action==='prepare')return{ready:true,temporary:true};if(action==='model')return{model:'current'};if(action==='submit'){submits++;return{submitted:true}};if(action==='read')return{state:'completed',text:'new source',conversationId:'fixture'};return{ok:true}}}});
 assert.equal(restarted.currentRequest(),null);assert.equal(restarted.requestStatus('old-tab-request')?.outcome,'unknown');assert.equal((await restarted.ask({requestId:'old-tab-request',prompt:'do not replay',timeoutMs:100})).kind,'failed');assert.equal(submits,0);
 assert.equal((await restarted.ask({requestId:'new-independent-request',prompt:'synthetic',temporary:true,timeoutMs:1000})).kind,'completed');assert.equal(submits,1);
});

test('stop does not release a network timeout, arbitrary error containing No tab, or missing tab on a different transport',async()=>{
 mkdirSync('.local/memory-book-tests',{recursive:true});
 for(const [transport,message]of [['bridge','network timeout'],['bridge','unexpected payload: No tab with id: 123.'],['embedded','Error: No tab with id: 123.']] as const){const receiptPath=join(mkdtempSync('.local/memory-book-tests/retain-tab-'),'receipts.json');writeFileSync(receiptPath,JSON.stringify({used:['pending'],active:{id:'pending',submitted:'unknown'}}));const bridge=new ChatgptBackgroundBridge({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport}),receiptPath,pageHost:{async login(){},async navigate(){},async execute(){throw Error(message)}}});await assert.rejects(bridge.cancel('pending'),/尚未释放连接/);assert.equal(bridge.currentRequest()?.requestId,'pending');}
});

test('explicit orphan cancellation releases only an empty idle owned page and never resubmits',async()=>{
 let submits=0,lose=false;
 const bridge=new ChatgptBackgroundBridge({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded'}),intervalMs:0,pollMs:1,pageHost:{async login(){},async navigate(){},async execute(action){
   if(action==='probe')return{ready:true,temporary:true,hasTurns:false,generating:false};
   if(action==='prepare')return{ready:true,temporary:true};if(action==='model')return{model:'current'};
   if(action==='submit'){submits++;return{submitted:true};}
   if(action==='submission'&&lose)throw Error('页面请求身份丢失；提交状态未知，不得自动重发。');
   if(action==='read')return{state:'incomplete',message:'interrupted observation'};
   return{ok:true};
 }}});
 const input={requestId:'orphan-review',prompt:'synthetic',temporary:true,timeoutMs:100};
 assert.equal((await bridge.ask(input)).kind,'failed');lose=true;
 const cancelled=await bridge.cancel(input.requestId);assert.equal(cancelled.kind,'cancelled');assert.equal(cancelled.kind==='cancelled'&&cancelled.confirmed,false);assert.equal(bridge.currentRequest(),null);
 assert.equal((await bridge.ask(input)).kind,'failed');assert.equal(submits,1);
});

function fixture(terminal: Record<string, unknown> = { state: 'completed', text: '正文', conversationId: 'c-1' }) {
  const calls: Array<{ args: string[]; script: string }> = [];
  const runner: ChatgptToolRunner = async (program, args) => {
    assert.equal(program, 'chrome-use');
    const script = args[args.indexOf('eval') + 1] ?? '';
    calls.push({ args: [...args], script });
    const value = script.includes('aiki:read') ? terminal
      : script.includes('aiki:model') ? { model: /"model":"([^"]+)"/.exec(script)?.[1] ?? 'current' }
      : script.includes('aiki:submit') ? { submitted: true }
      : script.includes('aiki:prepare') ? { ready: true, temporary: true }
      : script.includes('aiki:probe') ? { ready: true, temporary: true, hasTurns: false }
      : script.includes('aiki:cancel') ? { confirmed: true }
      : { ok: true };
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false };
  };
  const bridge = new ChatgptBackgroundBridge({ runner, config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'cli', profile: 'profile-id', session: 'mvp', submitMechanism: 'page' }), pollMs: 1, intervalMs: 0 });
  return { bridge, calls };
}

test('background Chat: complete uses existing window, preserves all context, verifies temporary and model', async () => {
  const { bridge, calls } = fixture();
  const result = await bridge.ask({ prompt: '问题', context: '[系统设定]\n召回事实\n[角色]\n历史', requestId: 'reply-1', timeoutMs: 5000, model: 'GPT-6', temporary: true });
  assert.equal(result.kind, 'completed');
  assert.ok(calls.some(call => call.args.includes('--window') && call.args.includes('user')));
  assert.ok(calls.every(call => !call.args.includes('--launch')));
  assert.ok(calls.every(call => !call.args.includes('press') && !call.args.includes('find')));
  assert.ok(calls.some(call => call.script.includes('召回事实') && call.script.includes('历史') && call.script.includes('问题')));
  assert.ok(calls.findIndex(call => call.script.includes('aiki:model')) < calls.findIndex(call => call.script.includes('aiki:submit')));
});

test('background Chat: incomplete/unknown submission locks the source; resume only reads', async () => {
  const { bridge, calls } = fixture({ state: 'incomplete', message: '网络中断' });
  const first = await bridge.ask({ prompt: 'q', requestId: 'q-1', timeoutMs: 5000 });
  assert.equal(first.kind, 'failed');
  if (first.kind === 'failed') assert.equal(first.submitted, 'yes');
  const second = await bridge.ask({ prompt: 'q', requestId: 'q-2', timeoutMs: 5000 });
  assert.equal(second.kind, 'failed');
  if (second.kind === 'failed') assert.equal(second.code, 'busy');
  const count = calls.filter(call => call.script.includes('aiki:submit')).length;
  await bridge.resume('q-1', 5000);
  assert.equal(calls.filter(call => call.script.includes('aiki:submit')).length, count);
});

test('background Chat: model adapter processes JSON without second API or model request', async () => {
  const { bridge, calls } = fixture({ state: 'completed', text: '```json\n{"claims":[]}\n```', conversationId: 'c-2' });
  const model = new ChatgptWebModel({ bridge, config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE }), requestId: () => 'wiki-1' });
  const result = await model.complete({ kind: 'chatgpt-web', baseUrl: 'chatgpt-web', credentialId: 'none', model: 'GPT-6', inputTokens: 8192, outputTokens: 1024 }, [{ role: 'system', content: '整理指令' }, { role: 'user', content: '授权材料' }], new AbortController().signal, { purpose: 'wiki', json: true });
  assert.equal(result, '{"claims":[]}');
  assert.equal(calls.filter(call => call.script.includes('aiki:submit')).length, 1);
  assert.ok(calls.some(call => call.script.includes('整理指令') && call.script.includes('授权材料')));
});

test('background Chat: used request identity never sends twice, even after completion', async () => {
  const { bridge, calls } = fixture();
  await bridge.ask({ prompt: 'q', requestId: 'same-1', timeoutMs: 5000 });
  const count = calls.length;
  const duplicate = await bridge.ask({ prompt: 'q', requestId: 'same-1', timeoutMs: 5000 });
  assert.equal(duplicate.kind, 'failed');
  if (duplicate.kind === 'failed') assert.equal(duplicate.code, 'duplicate');
  assert.equal(calls.length, count);
});

test('background Chat: a disconnected default browser cannot launch a replacement', async () => {
  const calls: string[][] = [];
  const bridge = new ChatgptBackgroundBridge({ config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'cli' }), runner: async (_program, args) => {
    calls.push([...args]);
    return { exitCode: 0, stdout: JSON.stringify({ data: { browsers: [] } }), stderr: '', timedOut: false };
  }, intervalMs: 0 });
  const result = await bridge.ask({ prompt: 'q', requestId: 'cold-1', timeoutMs: 5000 });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.submitted, 'no');
  assert.deepEqual(calls, [['browsers', '--json']]);
});

test('background Chat: expired temporary mode refuses before any submit', async () => {
  let submits = 0;
  const bridge = new ChatgptBackgroundBridge({ config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'cli', profile: 'profile-id' }), intervalMs: 0,
    runner: async (_program, args) => {
      const script = args[args.indexOf('eval') + 1] ?? '';
      if (script.includes('aiki:submit')) submits++;
      return { exitCode: 0, stdout: JSON.stringify({ ready: true, temporary: false }), stderr: '', timedOut: false };
    } });
  const result = await bridge.ask({ prompt: 'q', requestId: 'temporary-1', timeoutMs: 5000, temporary: true });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.submitted, 'no');
  assert.equal(submits, 0);
});

test('background Chat: a lost task tab before submission reopens only its destination', async () => {
  const { bridge, calls } = fixture();
  const original = (bridge as any).runner as ChatgptToolRunner;
  let lost = true;
  (bridge as any).runner = async (program: any, args: readonly string[], options: any) => {
    if (lost && args.some(a => a.includes('aiki:probe'))) {
      lost = false;
      return { exitCode: 1, stdout: '', stderr: 'the tab this command was driving is gone', timedOut: false };
    }
    return original(program, args, options);
  };
  const result = await bridge.ask({ prompt: 'q', requestId: 'restore-1', timeoutMs: 5000, temporary: true });
  assert.equal(result.kind, 'completed');
  const opens = calls.filter(c => c.args.includes('open'));
  assert.equal(opens.length, 1);
  assert.equal(opens[0]!.args.at(-1), 'https://chatgpt.com/?temporary-chat=true');
  assert.equal(calls.filter(c => c.script.includes('aiki:submit')).length, 1);
});

test('background Chat: a lost task tab after submission cannot navigate or replay', async () => {
  const { bridge, calls } = fixture();
  const original = (bridge as any).runner as ChatgptToolRunner;
  (bridge as any).runner = async (program: any, args: readonly string[], options: any) => {
    if (args.some(a => a.includes('aiki:read'))) return { exitCode: 1, stdout: '', stderr: 'the tab this command was driving is gone', timedOut: false };
    return original(program, args, options);
  };
  const result = await bridge.ask({ prompt: 'q', requestId: 'lost-sent-1', timeoutMs: 5000, temporary: true });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.submitted, 'yes');
  await assert.rejects(bridge.resume('lost-sent-1', 5000), /gone/);
  assert.equal(calls.filter(c => c.args.includes('open')).length, 0);
  assert.equal(calls.filter(c => c.script.includes('aiki:submit')).length, 1);
});

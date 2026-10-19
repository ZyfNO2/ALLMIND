import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../contracts/memory-book.js';
import { ChatgptBackgroundBridge, type ChatgptPageHost } from '../../providers/chatgpt-background-bridge.js';
import { artifactAction } from '../../providers/chatgpt-artifacts.js';
import vm from 'node:vm';

test('native image upload accepts NDJSON completion and preserves independently padded base64 chunks', async () => {
  const request: any = { id: 'image-turn' };
  let uploaded: File | undefined;
  const window: any = { __aikiChatRequest: request, __aikiUploads: {}, fetch: async () => new Response('{"event":"file.processing.completed","file_id":"file-proof"}\n') };
  const context = vm.createContext({ window, File, TextDecoder, Uint8Array, URL, DataTransfer: class {
    files: File[] = []; items = { add: (file: File) => this.files.push(file) };
  }, Event, atob, setTimeout, document: { querySelector: () => ({ set files(value: File[]) { uploaded = value[0]; }, dispatchEvent() {
    void window.fetch('/backend-api/files/process_upload_stream', { body: '{"file_id":"file-proof"}' });
  } }) } });
  const run = (input: object) => vm.runInContext(`(${artifactAction.toString()})('upload-image',${JSON.stringify(input)})`, context);
  const base = { id: 'image-turn', slot: 'slot', name: 'test.png', mime: 'image/png' };
  run({ ...base, data: Buffer.from([1]).toString('base64') });
  run({ ...base, data: Buffer.from([2,3]).toString('base64') });
  const result = await run({ ...base, done: true });
  assert.equal(result.attached, true);
  assert.deepEqual([...new Uint8Array(await uploaded!.arrayBuffer())], [1,2,3]);
  assert.equal(request.verifiedUploads[0].fileId, 'file-proof');
});

test('native completed reply survives bridge reconstruction and identical replay never submits twice', async t => {
  const root=join(process.cwd(),'.local','artifact-review');mkdirSync(root,{recursive:true});
  const directory = mkdtempSync(join(root, 'completion-')); t.after(() => rmSync(directory, {recursive:true,force:true}));
  let submits = 0;
  const host: ChatgptPageHost = { navigate: async () => {}, login: async () => {}, execute: async (action,input) => {
    if (action === 'model') return {model:input.model};
    if (action === 'submit') { submits++; return {submitted:true}; }
    if (action === 'probe' || action === 'prepare') return {ready:true,temporary:false,hasTurns:false};
    if (action === 'read') return {state:'completed',text:'synthetic reply',conversationId:'conversation-1',messageId:'message-1'};
    return {};
  } };
  const options = {config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded' as const,submitMechanism:'page' as const}),pageHost:host,intervalMs:0,receiptPath:join(directory,'receipts.json')};
  const input = {prompt:'synthetic question',requestId:'durable-turn',timeoutMs:1000,recoverableCompletion:true,captureArtifacts:true};
  const first=await new ChatgptBackgroundBridge(options).ask(input);
  assert.equal(first.kind,'completed',JSON.stringify(first));
  const restored = new ChatgptBackgroundBridge(options);
  assert.equal((await restored.ask(input)).kind,'completed');
  const conflict = await restored.ask({...input,prompt:'changed'});
  assert.equal(conflict.kind,'failed');
  assert.equal(submits,1);
});

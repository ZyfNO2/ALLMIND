import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { FileBookRepository } from '../../dist/memory/file-book-repository.js';
import { emptyEntry } from '../../dist/contracts/memory-book.js';

/** Real backend NDJSON chain: submit_text.replyStyle -> runtime.chat -> the same frozen decision
 * travels on BOTH the reply event and the on-demand book_turn_state receipt; a reused request id
 * with a different explicit style is refused and never re-submits. */
test('backend command chain carries the frozen style decision on reply event and turn receipt', { timeout: 60000 }, async t => {
  mkdirSync('.local/memory-book-tests', { recursive: true });
  const directory = mkdtempSync(join(resolve('.local/memory-book-tests'), 'reply-style-backend-'));
  const prompts = [];
  const upstream = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    prompts.push(JSON.parse(raw).messages.map(message => message.content).join('\n'));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '在的，我在。' } }] }));
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const repository = new FileBookRepository(directory);
  const config = repository.loadConfig();
  repository.commitConfig({ ...config, mainModel: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'protocol-stub', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 } }, config.revision, 'seed');
  repository.commit({ characterId: 'aika', pairingId: 'local-user', sessionId: 'desktop' }, { upsert: [emptyEntry('persona', 'persona', '人格', '温和诚实。')] }, 0, 'persona');
  repository.close();
  const evidence = resolve('.local/b03/backend-chain.json');
  mkdirSync('.local/b03', { recursive: true }); // cold clone has no .local tree; create our own evidence dir
  const child = spawn(process.execPath, ['dist/app/book-backend.js'], { cwd: process.cwd(), env: { ...process.env, AIKI_BOOK_DATA: directory }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exited = false;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.once('exit', () => { exited = true; });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const messages = [];
  let collectedLines=0;
  const collect=()=>{const lines=stdout.split('\n');while(collectedLines<lines.length-1){const line=lines[collectedLines++];if(!line.trim())continue;try{messages.push(JSON.parse(line));}catch{/* non-protocol SDK output */}}};
  const waitFor = async (predicate, label, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !exited) { collect(); if (predicate()) return true; await new Promise(done => setTimeout(done, 150)); }
    collect();
    if (exited) throw new Error(`后端提前退出（${label}）：${stderr.slice(-600)}`);
    return predicate();
  };
  t.after(async () => {
    try { child.stdin.end(); } catch { /* already gone */ }
    if (!exited) await new Promise(resolveExit => { const timer = setTimeout(() => { child.kill(); resolveExit(null); }, 5000); child.once('exit', () => { clearTimeout(timer); resolveExit(null); }); });
    child.kill();
    try { upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); } catch { /* already closed */ }
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* disposable temp dir */ }
  });
  await waitFor(() => stdout.includes('backend_ready'), 'backend_ready');
  send({channel:'book_reply_style',requestId:'preview-1',characterId:'aika',sessionId:'desktop',text:'这次不超过80字',replyStyle:'detailed'});
  assert.ok(await waitFor(()=>messages.some(row=>row.channel==='book_reply_style'&&row.requestId==='preview-1'),'policy preview'));
  assert.equal(messages.find(row=>row.channel==='book_reply_style'&&row.requestId==='preview-1').decision.targetChars,80);
  assert.equal(prompts.length,0,'发送前预览无模型调用');
  send({channel:'command',command:{type:'submit_text',text:'无效档位',clientRequestId:'invalid-style',replyStyle:'invalid'}});
  assert.ok(await waitFor(() => messages.some(row => row.channel==='event' && row.event?.type==='error' && (row.event.message??'').includes('本轮回复风格必须')), 'invalid style refusal'));
  assert.equal(prompts.length,0,'非法档位不能触发模型，也不能锁死后续请求');
  send({ channel: 'command', command: { type: 'submit_text', text: '帮我说句简短的话', clientRequestId: 'style-turn-1', replyStyle: 'short' } });
  assert.ok(await waitFor(() => messages.some(message => message.channel === 'event' && message.event?.type === 'reply' && message.event.reply?.scope?.turnId === 'style-turn-1'), 'reply event'), '缺少回复事件');
  assert.equal(prompts.length, 1, '普通请求模型调用恰好一次');
  assert.ok(prompts[0]?.includes('本轮回复风格：简短'), '唯一长度政策必须随普通请求发给模型');
  // The stored turn receipt is replayed on demand (book_turn_status) and must carry the SAME decision.
  send({ channel: 'book_turn_status', clientRequestId: 'style-turn-1', characterId: 'aika', sessionId: 'desktop' });
  assert.ok(await waitFor(() => messages.some(message => message.channel === 'book_turn_state' && message.clientRequestId === 'style-turn-1' && message.state === 'completed'), 'turn receipt'), '缺少完成回执');
  const replyEvent = messages.find(message => message.channel === 'event' && message.event?.type === 'reply' && message.event.reply?.scope?.turnId === 'style-turn-1');
  const completed = messages.find(message => message.channel === 'book_turn_state' && message.state === 'completed' && message.clientRequestId === 'style-turn-1');
  assert.equal(replyEvent.event.reply.replyStyleDecision.requestedStyle, 'short');
  assert.equal(replyEvent.event.reply.replyStyleDecision.selectedStyle, 'short');
  assert.equal(replyEvent.event.reply.replyStyleDecision.source, 'turn');
  assert.equal(completed.replyStyleDecision.requestedStyle, 'short');
  assert.equal(completed.replyStyleDecision.selectedStyle, 'short');
  assert.equal(completed.replyStyleDecision.effectiveRange.minChars, replyEvent.event.reply.replyStyleDecision.effectiveRange.minChars, '普通结果与恢复回执一致');
  // same request id with a different explicit style is refused, nothing new is submitted
  send({ channel: 'command', command: { type: 'submit_text', text: '帮我说句简短的话', clientRequestId: 'style-turn-1', replyStyle: 'detailed' } });
  assert.ok(await waitFor(() => messages.some(message => message.channel === 'event' && message.event?.type === 'error' && (message.event.message ?? '').includes('回复风格')), 'conflict refusal'), '换风格重放同一轮次必须被拒绝');
  assert.equal(prompts.length, 1, '拒绝重放不得再次提交模型');
  send({ channel: 'book_turn_status', clientRequestId: 'style-turn-1', characterId: 'aika', sessionId: 'desktop' });
  assert.ok(await waitFor(() => messages.some(message => message.channel === 'book_turn_state' && message.clientRequestId === 'style-turn-1' && message.state === 'failed' && (message.message ?? '').includes('回复风格')), 'refused receipt'), '拒绝同样记录在可恢复回执中');
  const beforeRecovery=messages.length;
  send({channel:'book_turn_status',clientRequestId:'style-turn-1',characterId:'aika',sessionId:'desktop'});
  assert.ok(await waitFor(()=>messages.slice(beforeRecovery).some(row=>row.channel==='book_turn_state'&&row.clientRequestId==='style-turn-1'),'original completed receipt after conflict'));
  const recovered=messages.slice(beforeRecovery).find(row=>row.channel==='book_turn_state'&&row.clientRequestId==='style-turn-1');
  assert.equal(recovered.state,'completed','换风格拒绝不能覆盖原先成功的恢复回执');
  assert.equal(recovered.replyStyleDecision.requestedStyle,'short');
  // persistence is verified through the backend's own management read path: the child still owns
  // the repository lock, so reopening the directory would fight it.
  await waitFor(() => {
    try {
      const session = JSON.parse(readFileSync(join(directory, 'management-session.json'), 'utf8'));
      return typeof session.url === 'string' && session.url.includes('#token=');
    } catch { return false; }
  }, 'management session');
  const session = JSON.parse(readFileSync(join(directory, 'management-session.json'), 'utf8'));
  const historyToken = new URLSearchParams(new URL(session.url).hash.slice(1)).get('token');
  const history = await fetch(new URL('/api/memory-book/v1/chat/history?characterId=aika&sessionId=desktop', session.url).href, { headers: { Authorization: 'Bearer ' + historyToken } });
  const persisted = await history.json();
  const turn = persisted.turns.find(row => row.id === 'style-turn-1');
  assert.equal(turn?.replyStyleDecision?.requestedStyle, 'short');
  assert.equal(turn?.assistant, '在的，我在。');
  writeFileSync(evidence, JSON.stringify({ replyEvents: 1, receiptReplayed: true, conflictRefused: true, modelCalls: prompts.length, stderrSample: stderr.slice(-300) }, null, 2));
});

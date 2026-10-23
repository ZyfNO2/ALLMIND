import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { BookRuntime, chatTurnBudgetMs, wikiCompilationBinding, wikiCompilationBudgetMs } from '../../app/book-runtime.js';
import { startBookServer } from '../../management/book-server.js';
import { BookCredentials } from '../../management/book-credentials.js';
import { validateModelBinding, validateRuntime } from '../../memory/book-validation.js';
import { BookError, DEFAULT_CHATGPT_WEB_SOURCE, type ChatgptWebSourceConfig, type ModelBinding, type BookScope, type ChatMessage, type RuntimeConfig } from '../../contracts/memory-book.js';
import { ChatgptToolMissingError, ChatgptWebBridge, type ChatgptToolOptions, type ChatgptToolRun, type ChatgptWebProgram } from '../../providers/chatgpt-web-bridge.js';
import { ChatgptWebModel,normalizeChatgptReplyDecoration } from '../../providers/chatgpt-web-model.js';
import { createModelRouter, isChatgptWebBinding } from '../../providers/model-router.js';
import type { BookModelPort, ModelCallOptions } from '../../providers/book-model.js';

test('web reply hides only the observed empty memcite decoration and preserves code, public citations and JSON source quotes',()=>{
  const token='\uE200memcite\uE201',raw=`又见面了。还记得 10 月 13 日我们一起检查过园艺项目——最近怎么样？ ${token}`;
  assert.equal(normalizeChatgptReplyDecoration(raw),'又见面了。还记得 10 月 13 日我们一起检查过园艺项目——最近怎么样？');
  const literal='`'+token+'`\n```text\n'+token+'\n```';assert.equal(normalizeChatgptReplyDecoration(literal),literal);
  assert.equal(normalizeChatgptReplyDecoration('资料 \uE200cite\uE202source\uE201'),'资料 \uE200cite\uE202source\uE201');
});

test('web model normalization preserves JSON quotes and explicit requests for transport-marker literals',async()=>{
  const runner=new FakeRunner(),token='\uE200memcite\uE201',model=new ChatgptWebModel({bridge:makeBridge(runner),config:()=>sourceConfig()}),binding:ModelBinding={kind:'chatgpt-web',baseUrl:'chatgpt-web',model:'auto',credentialId:'none',inputTokens:8192,outputTokens:1024};
  runner.handle('chatgpt-use',async()=>envelope({status:'completed',result:{text:'欢迎回来。 '+token}}));
  assert.equal(await model.complete(binding,[{role:'user',content:'普通问候'}],new AbortController().signal,{purpose:'reply'}),'欢迎回来。');
  runner.handle('chatgpt-use',async()=>envelope({status:'completed',result:{text:JSON.stringify({quote:token})}}));
  assert.deepEqual(JSON.parse(await model.complete(binding,[{role:'user',content:'原文整理'}],new AbortController().signal,{purpose:'wiki',json:true})),{quote:token});
  runner.handle('chatgpt-use',async()=>envelope({status:'completed',result:{text:token}}));
  assert.equal(await model.complete(binding,[{role:'user',content:'请展示memcite标记原文'}],new AbortController().signal,{purpose:'reply'}),token);
});

/** chatgpt-use prints exactly one JSON envelope line; helper mirrors its statuses. */
function envelope(value: Record<string, unknown>, exitCode = 0): ChatgptToolRun {
  return { exitCode, stdout: `${JSON.stringify(value)}\n`, stderr: '', timedOut: false };
}
/** One captured model call: required props that explicitly accept undefined (exactOptionalPropertyTypes). */
interface CapturedCall { purpose: ModelCallOptions['purpose'] | undefined; messages?: ChatMessage[]; binding?: ModelBinding }

function plainRun(stdout: string, exitCode: number | null = 0, stderr = '', timedOut = false): ChatgptToolRun {
  return { exitCode, stdout, stderr, timedOut };
}

interface RecordedCall { program: ChatgptWebProgram; args: string[]; options: ChatgptToolOptions }

class FakeRunner {
  calls: RecordedCall[] = [];
  private handlers = new Map<ChatgptWebProgram, (call: RecordedCall) => Promise<ChatgptToolRun>>();
  gate: { release: ((run: ChatgptToolRun) => void) | null } = { release: null };

  handle(program: ChatgptWebProgram, handler: (call: RecordedCall) => Promise<ChatgptToolRun>): this {
    this.handlers.set(program, handler); return this;
  }

  run = async (program: ChatgptWebProgram, args: readonly string[], options: ChatgptToolOptions): Promise<ChatgptToolRun> => {
    const call = { program, args: [...args], options };
    this.calls.push(call);
    const handler = this.handlers.get(program);
    if (!handler) throw new Error(`测试未为 ${program} 设置 handler（args=${JSON.stringify(args)}）`);
    return handler(call);
  };

  callsOf(program: ChatgptWebProgram): RecordedCall[] { return this.calls.filter(call => call.program === program); }
}

function sourceConfig(patch: Partial<ChatgptWebSourceConfig> = {}): ChatgptWebSourceConfig {
  return { ...DEFAULT_CHATGPT_WEB_SOURCE, ...patch };
}

const FIXED_NOW = 1_000_000_000;
const fixedClock = () => FIXED_NOW;
/** Hermetic cooldown lookup: never reads the developer's real ~/.chatgpt-use state. */
const NO_THROTTLE_PATH = () => join(process.cwd(), '.local/memory-book-tests', 'no-such-throttle.json');

function makeBridge(runner: FakeRunner, patch: Partial<ChatgptWebSourceConfig> = {}, cooldownPath: () => string = NO_THROTTLE_PATH) {
  return new ChatgptWebBridge({
    runner: runner.run,
    config: () => sourceConfig(patch),
    cooldownPath,
    now: fixedClock,
  });
}

test('chatgpt-web bridge: completed envelope maps to text and asks with the documented CLI contract', async () => {
  const runner = new FakeRunner();
  runner.handle('chatgpt-use', async () => envelope({ status: 'completed', result: { text: 'こんにちは' }, conversation_id: 'c-1' }));
  const bridge = makeBridge(runner);
  const result = await bridge.ask({ prompt: '今天怎么样？', requestId: 'aika-reply-1', timeoutMs: 120_000 });
  assert.equal(result.kind, 'completed');
  if (result.kind === 'completed') { assert.equal(result.text, 'こんにちは'); assert.equal(result.conversationId, 'c-1'); }
  const args = runner.callsOf('chatgpt-use')[0]!.args;
  assert.equal(args[0], 'ask');
  assert.equal(args[1], '今天怎么样？');
  for (const expected of ['--json', '--no-stdin', '--busy', 'wait']) assert.ok(args.includes(expected), expected);
  assert.deepEqual(args.slice(args.indexOf('--request-id'), args.indexOf('--request-id') + 2), ['--request-id', 'aika-reply-1']);
  assert.deepEqual(args.slice(args.indexOf('--profile'), args.indexOf('--profile') + 2), ['--profile', 'auto']);
  assert.deepEqual(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2), ['--session', 'chatgpt-web']);
  assert.deepEqual(args.slice(args.indexOf('--project'), args.indexOf('--project') + 2), ['--project', '']);
  assert.deepEqual(args.slice(args.indexOf('--timeout'), args.indexOf('--timeout') + 2), ['--timeout', '120']);
  // explicit effort label is forwarded; auto/current/default leave the account picker alone
  const runner2 = new FakeRunner();
  runner2.handle('chatgpt-use', async () => envelope({ status: 'completed', result: { text: 'ok' } }));
  await makeBridge(runner2).ask({ prompt: 'q', requestId: 'aika-reply-2', timeoutMs: 60_000, model: 'high' });
  const args2 = runner2.callsOf('chatgpt-use')[0]!.args;
  assert.deepEqual(args2.slice(args2.indexOf('--model'), args2.indexOf('--model') + 2), ['--model', 'high']);
});

test('chatgpt-web bridge: every chatgpt-use failure kind keeps its own code and submitted state', async () => {
  const cases: Array<[Record<string, unknown>, number, string, string]> = [
    [{ status: 'unavailable', error: { kind: 'login_required', message: '需要登录', submitted: 'no' } }, 6, 'login_required', 'no'],
    [{ status: 'unavailable', error: { kind: 'rate_limited', message: '限流', submitted: 'no' } }, 6, 'rate_limited', 'no'],
    [{ status: 'unavailable', error: { kind: 'session_unavailable', message: '会话卡死', submitted: 'no' } }, 6, 'session_unavailable', 'no'],
    [{ status: 'unavailable', error: { kind: 'page_blocked', message: '页面弹窗', submitted: 'no' } }, 6, 'page_blocked', 'no'],
    [{ status: 'failed', error: { kind: 'not_submitted', message: '未提交', submitted: 'no' } }, 1, 'not_submitted', 'no'],
    [{ status: 'submission_unknown', error: { kind: 'submit_unknown', message: '提交未知', submitted: 'unknown' } }, 10, 'submit_unknown', 'unknown'],
    [{ status: 'incomplete', error: { kind: 'incomplete', message: '未完成', submitted: 'yes' } }, 5, 'incomplete', 'yes'],
    [{ status: 'busy', error: { kind: 'busy', message: '忙', submitted: 'no' } }, 7, 'busy', 'no'],
    [{ status: 'duplicate', error: { kind: 'duplicate', message: '重复', submitted: 'yes' } }, 9, 'duplicate', 'yes'],
    [{ status: 'completed' }, 0, 'bad_output', 'yes'],
  ];
  for (const [value, exit, code, submitted] of cases) {
    const runner = new FakeRunner();
    runner.handle('chatgpt-use', async () => envelope(value, exit));
    const result = await makeBridge(runner).ask({ prompt: 'q', requestId: 'aika-reply-e', timeoutMs: 30_000 });
    assert.equal(result.kind, 'failed', JSON.stringify(value));
    if (result.kind === 'failed') { assert.equal(result.code, code, JSON.stringify(value)); assert.equal(result.submitted, submitted, JSON.stringify(value)); }
  }
  // no envelope at all: timeout ⇒ unknown submission; exit code fallback keeps 7 ⇒ busy
  const timed = new FakeRunner();
  timed.handle('chatgpt-use', async () => plainRun('', null, 'killed', true));
  const timedResult = await makeBridge(timed).ask({ prompt: 'q', requestId: 'aika-reply-t', timeoutMs: 30_000 });
  assert.equal(timedResult.kind, 'failed');
  if (timedResult.kind === 'failed') { assert.equal(timedResult.code, 'timeout'); assert.equal(timedResult.submitted, 'unknown'); assert.ok(timedResult.message.includes('不得自动重发')); }
  const busy = new FakeRunner();
  busy.handle('chatgpt-use', async () => plainRun('', 7));
  const busyResult = await makeBridge(busy).ask({ prompt: 'q', requestId: 'aika-reply-b', timeoutMs: 30_000 });
  assert.equal(busyResult.kind, 'failed');
  if (busyResult.kind === 'failed') assert.equal(busyResult.code, 'busy');
  // missing tool ⇒ failed(tool_missing), nothing was ever sent
  const missing = new FakeRunner();
  missing.handle('chatgpt-use', async () => { throw new ChatgptToolMissingError('chatgpt-use'); });
  const missingResult = await makeBridge(missing).ask({ prompt: 'q', requestId: 'aika-reply-m', timeoutMs: 30_000 });
  assert.equal(missingResult.kind, 'failed');
  if (missingResult.kind === 'failed') { assert.equal(missingResult.code, 'tool_missing'); assert.equal(missingResult.submitted, 'no'); }
});

test('chatgpt-web bridge: context rides stdin, oversized prompts move wholly to stdin, invalid ids are rejected', async () => {
  const runner = new FakeRunner();
  runner.handle('chatgpt-use', async () => envelope({ status: 'completed', result: { text: 'ok' } }));
  await makeBridge(runner).ask({ prompt: '问题', context: '角色设定与检索材料', requestId: 'aika-reply-c', timeoutMs: 30_000 });
  const call = runner.callsOf('chatgpt-use')[0]!;
  assert.ok(call.args.includes('--stdin')); assert.ok(!call.args.includes('--no-stdin'));
  assert.equal(call.options.stdin, '角色设定与检索材料');
  const huge = '巨'.repeat(13_000);
  await makeBridge(runner).ask({ prompt: huge, requestId: 'aika-reply-h', timeoutMs: 30_000 });
  const hugeCall = runner.callsOf('chatgpt-use')[1]!;
  assert.ok(hugeCall.options.stdin?.includes(huge));
  assert.ok((hugeCall.options.stdin?.length ?? 0) > 12_000);
  assert.ok(hugeCall.args[1]!.length < 100 && !hugeCall.args[1]!.includes('巨'));
  await assert.rejects(makeBridge(runner).ask({ prompt: 'q', requestId: '../evil', timeoutMs: 30_000 }), { code: 'invalid_input' });
});

test('chatgpt-web bridge: one active generation per source; abort settles on the cancel receipt', async t => {
  const runner = new FakeRunner();
  runner.handle('chatgpt-use', call => {
    if (call.args[0] === 'ask') return new Promise<ChatgptToolRun>(resolve => { runner.gate.release = resolve; });
    assert.equal(call.args[0], 'cancel');
    assert.ok(call.args.includes('aika-reply-x'));
    // windows semantics: chatgpt-use cancel kills the owner ⇒ ask exits without an envelope
    runner.gate.release?.(plainRun('', 1, 'terminated'));
    return Promise.resolve(envelope({ status: 'cancelled', message: '停止成功' }, 11));
  });
  const bridge = makeBridge(runner);
  const controller = new AbortController();
  const ask = bridge.ask({ prompt: '长问题', requestId: 'aika-reply-x', timeoutMs: 60_000, signal: controller.signal });
  await new Promise(done => setTimeout(done, 10));
  // source-level lease: a second ask while the first is in flight fails busy
  const second = await bridge.ask({ prompt: '并发', requestId: 'aika-reply-y', timeoutMs: 60_000 });
  assert.equal(second.kind, 'failed');
  if (second.kind === 'failed') assert.equal(second.code, 'busy');
  controller.abort();
  const result = await ask;
  assert.equal(result.kind, 'cancelled');
  if (result.kind === 'cancelled') assert.equal(result.confirmed, true);
  // unconfirmed stop stays unconfirmed
  const runner2 = new FakeRunner();
  runner2.handle('chatgpt-use', call => {
    if (call.args[0] === 'ask') return new Promise<ChatgptToolRun>(resolve => { runner2.gate.release = resolve; });
    return Promise.resolve(envelope({ status: 'cancel_requested', message: '尚未确认' }, 12));
  });
  const bridge2 = new ChatgptWebBridge({ runner: runner2.run, config: () => sourceConfig(), cooldownPath: NO_THROTTLE_PATH, now: fixedClock, cancelSettleWaitMs: 20 });
  const controller2 = new AbortController();
  const ask2 = bridge2.ask({ prompt: 'q', requestId: 'aika-reply-u', timeoutMs: 60_000, signal: controller2.signal });
  await new Promise(done => setTimeout(done, 10));
  controller2.abort();
  const unconfirmed = await ask2;
  runner2.gate.release?.(plainRun('', 1));
  assert.equal(unconfirmed.kind, 'cancelled');
  if (unconfirmed.kind === 'cancelled') { assert.equal(unconfirmed.confirmed, false); assert.ok(unconfirmed.message.includes('停止未确认')); }
  void t;
});

test('chatgpt-web bridge: cooldown precheck refuses without touching any tool; receipts and resume never resend', async t => {
  const dir = mkdtempSync(join(process.cwd(), '.local/memory-book-tests', 'bridge-cd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const throttle = () => join(dir, 'throttle.json');
  writeFileSync(throttle(), JSON.stringify({ until: Math.floor(FIXED_NOW / 1000) + 120 }));
  const runner = new FakeRunner();
  const bridged = makeBridge(runner, {}, throttle);
  const refused = await bridged.ask({ prompt: 'q', requestId: 'aika-reply-cd', timeoutMs: 30_000 });
  assert.equal(refused.kind, 'failed');
  if (refused.kind === 'failed') { assert.equal(refused.code, 'rate_limited'); assert.equal(refused.submitted, 'no'); }
  assert.equal(runner.calls.length, 0);
  const probe = await bridged.probe();
  assert.equal(probe.state, 'cooldown');
  assert.equal(probe.cooldownLeftMs, 120_000);
  // expired cooldown is not a cooldown anymore
  writeFileSync(throttle(), JSON.stringify({ until: Math.floor(FIXED_NOW / 1000) - 1 }));
  const okProbe = await bridged.probe();
  assert.notEqual(okProbe.state, 'cooldown');
});

test('chatgpt-web bridge: probe is eval-only and reports each state honestly', async () => {
  const evalResult = (value: unknown, exitCode = 0): ChatgptToolRun => plainRun(`${JSON.stringify(JSON.stringify(value))}\n`, exitCode);
  // version missing ⇒ tool-missing, and no eval happens
  const missing = new FakeRunner();
  missing.handle('chatgpt-use', async () => { throw new ChatgptToolMissingError('chatgpt-use'); });
  assert.equal((await makeBridge(missing).probe()).state, 'tool-missing');
  assert.equal(missing.callsOf('chrome-use').length, 0);
  // eval failure ⇒ not-connected; probe never uses ask or open
  const disconnected = new FakeRunner();
  disconnected.handle('chatgpt-use', async () => plainRun('chatgpt-use 0.0.11'));
  disconnected.handle('chrome-use', async () => plainRun('', 1, 'no tab'));
  const disconnectedProbe = await makeBridge(disconnected).probe();
  assert.equal(disconnectedProbe.state, 'not-connected');
  assert.ok(disconnected.callsOf('chatgpt-use').every(call => call.args[0] === '--version'));
  assert.ok(disconnected.callsOf('chrome-use').every(call => call.args.includes('eval') && !call.args.includes('open')));
  // signed-out / signed-in / unknown host
  const visible = new FakeRunner();
  visible.handle('chatgpt-use', async () => plainRun('v'));
  visible.handle('chrome-use', async () => Promise.resolve(evalResult({ host: 'chatgpt.com', login: true, composer: false })));
  assert.equal((await makeBridge(visible).probe()).state, 'signed-out');
  visible.handle('chrome-use', async () => Promise.resolve(evalResult({ host: 'chatgpt.com', login: false, composer: true })));
  assert.equal((await makeBridge(visible).probe()).state, 'signed-in');
  visible.handle('chrome-use', async () => Promise.resolve(evalResult({ host: 'chatgpt.com', login: false, composer: true, limited: true })));
  const limitedProbe = await makeBridge(visible).probe();
  assert.equal(limitedProbe.state, 'signed-in'); assert.equal(limitedProbe.rateLimited, true);
  visible.handle('chrome-use', async () => Promise.resolve(evalResult({ host: 'github.com', login: false, composer: false })));
  assert.equal((await makeBridge(visible).probe()).state, 'unknown');
  visible.handle('chrome-use', async () => plainRun('not json'));
  assert.equal((await makeBridge(visible).probe()).state, 'not-connected');
  // explicit profile becomes a chrome-use global flag BEFORE the subcommand
  visible.handle('chrome-use', async () => Promise.resolve(evalResult({ host: 'chatgpt.com', login: false, composer: true })));
  await makeBridge(visible, { profile: 'Profile 3' }).probe();
  const evalArgs = visible.callsOf('chrome-use').at(-1)!.args;
  assert.deepEqual(evalArgs.slice(0, 2), ['--profile', 'Profile 3']);
  assert.deepEqual(evalArgs.slice(-2), ['--session', 'chatgpt-web']);
  // login page open is a user action; standalone adds --launch
  await makeBridge(visible, { profile: 'Profile 3' }).openLoginPage({ standalone: true });
  const openCall = visible.callsOf('chrome-use').at(-1)!.args;
  assert.deepEqual(openCall, ['--profile', 'Profile 3', '--launch', 'open', 'https://chatgpt.com/', '--session', 'chatgpt-web']);
  // receipts: status is receipt-only; resume reads the server record without sending
  const receipts = new FakeRunner();
  receipts.handle('chatgpt-use', async call => {
    if (call.args[0] === 'status') return plainRun(JSON.stringify({ request_id: 'r', state: 'submission_unknown', submitted: 'unknown', conversation_id: 'c-5', outcome: null }));
    assert.equal(call.args[0], 'resume');
    return envelope({ status: 'completed', result: { text: '补收的回复' }, conversation_id: 'c-9' });
  });
  const receiptBridge = makeBridge(receipts);
  const status = await receiptBridge.requestStatus('r');
  assert.equal(status?.state, 'submission_unknown'); assert.equal(status?.submitted, 'unknown');
  const resumed = await receiptBridge.resume('r', 60_000);
  assert.equal(resumed.kind, 'completed');
  if (resumed.kind === 'completed') assert.equal(resumed.text, '补收的回复');
  assert.ok(receipts.callsOf('chatgpt-use').every(call => call.args[0] !== 'ask'));
});

test('chatgpt-web model: message split, JSON extraction, budgets per purpose and BookError mapping', async () => {
  const runner = new FakeRunner();
  runner.handle('chatgpt-use', async call => envelope({ status: 'completed', result: { text: '网页回复' } }));
  const config = sourceConfig({ replyBudgetMs: 240_000, wikiBudgetMs: 90_000 });
  const model = new ChatgptWebModel({ bridge: makeBridge(runner), config: () => config, requestId: purpose => `aiki-${purpose}-fixed` });
  const webBinding: ModelBinding = { kind: 'chatgpt-web', baseUrl: 'chatgpt-web', model: 'auto', credentialId: 'none', inputTokens: 8192, outputTokens: 1024 };
  const messages: ChatMessage[] = [
    { role: 'system', content: '系统设定' },
    { role: 'user', content: '历史问题' },
    { role: 'assistant', content: '历史回答' },
    { role: 'user', content: '今天怎么样？' },
  ];
  const reply = await model.complete(webBinding, messages, new AbortController().signal, { purpose: 'reply' });
  assert.equal(reply, '网页回复');
  const ask = runner.callsOf('chatgpt-use')[0]!;
  assert.equal(ask.args[1], '今天怎么样？');
  assert.ok(ask.options.stdin?.includes('系统设定') && ask.options.stdin?.includes('历史回答'));
  assert.deepEqual(ask.args.slice(ask.args.indexOf('--request-id'), ask.args.indexOf('--request-id') + 2), ['--request-id', 'aiki-reply-fixed']);
  assert.deepEqual(ask.args.slice(ask.args.indexOf('--timeout'), ask.args.indexOf('--timeout') + 2), ['--timeout', '240']);
  // wiki purpose uses the wiki budget; test purpose uses the generous 120s test budget
  const timeoutPair = (call: RecordedCall): string[] => {
    const index = call.args.indexOf('--timeout');
    return call.args.slice(index, index + 2);
  };
  await model.complete(webBinding, [{ role: 'user', content: 'q' }], new AbortController().signal, { purpose: 'wiki' });
  assert.deepEqual(timeoutPair(runner.callsOf('chatgpt-use')[1]!), ['--timeout', '90']);
  await model.complete(webBinding, [{ role: 'user', content: 'q' }], new AbortController().signal, { purpose: 'test' });
  assert.deepEqual(timeoutPair(runner.callsOf('chatgpt-use')[2]!), ['--timeout', '120']);
  // json mode: fenced replies are extracted deterministically (no repair turns)
  runner.handle('chatgpt-use', async () => envelope({ status: 'completed', result: { text: '说明文字\n```json\n{"claims":[]}\n```\n尾部' } }));
  const jsonReply = await model.complete(webBinding, [{ role: 'user', content: 'q' }], new AbortController().signal, { json: true, purpose: 'wiki' });
  assert.equal(jsonReply, '{"claims":[]}');
  // output reserve becomes an approximate cap unless allowTruncated
  const longBinding = { ...webBinding, outputTokens: 100 };
  runner.handle('chatgpt-use', async () => envelope({ status: 'completed', result: { text: 'x'.repeat(900) } }));
  await assert.rejects(model.complete(longBinding, [{ role: 'user', content: 'q' }], new AbortController().signal, { allowTruncated: false, purpose: 'reply' }), { code: 'unavailable' });
  const truncated = await model.complete(longBinding, [{ role: 'user', content: 'q' }], new AbortController().signal, { allowTruncated: true, purpose: 'reply' });
  assert.equal(truncated.length, 800);
  // failure mapping: login ⇒ unavailable with guidance; busy ⇒ busy; submit-unknown ⇒ never auto-resend
  const failing = new FakeRunner();
  failing.handle('chatgpt-use', async () => envelope({ status: 'unavailable', error: { kind: 'login_required', message: '需要登录', submitted: 'no' } }, 6));
  const failingModel = new ChatgptWebModel({ bridge: makeBridge(failing), config: () => config });
  await assert.rejects(failingModel.complete(webBinding, [{ role: 'user', content: 'q' }], new AbortController().signal, { purpose: 'reply' }),
    (error: unknown) => error instanceof Error && /ChatGPT 需要登录/.test(error.message));
  failing.handle('chatgpt-use', async () => envelope({ status: 'busy', error: { kind: 'busy', message: '忙', submitted: 'no' } }, 7));
  await assert.rejects(failingModel.complete(webBinding, [{ role: 'user', content: 'q' }], new AbortController().signal, { purpose: 'reply' }), { code: 'busy' });
  failing.handle('chatgpt-use', async () => envelope({ status: 'submission_unknown', error: { kind: 'submit_unknown', message: '提交未知', submitted: 'unknown' } }, 10));
  await assert.rejects(failingModel.complete(webBinding, [{ role: 'user', content: 'q' }], new AbortController().signal, { purpose: 'reply' }),
    (error: unknown) => error instanceof Error && /不会自动重发/.test(error.message));
  // empty web reply never masquerades as success
  failing.handle('chatgpt-use', async () => envelope({ status: 'completed', result: { text: '   ' } }));
  await assert.rejects(failingModel.complete(webBinding, [{ role: 'user', content: 'q' }], new AbortController().signal, { purpose: 'reply' }), { code: 'unavailable' });
});

test('model router: legacy bindings keep the HTTP path; web bindings route to the web adapter or fail explicitly', async () => {
  const httpCalls: string[] = [];
  const webCalls: string[] = [];
  const http: BookModelPort = { async complete(binding) { httpCalls.push(binding.model); return 'http 回复'; } };
  const web: BookModelPort = { async complete(binding) { webCalls.push(binding.model); return 'web 回复'; } };
  const legacyBinding: ModelBinding = { baseUrl: 'http://127.0.0.1:9/v1', model: 'legacy', credentialId: 'k', inputTokens: 8192, outputTokens: 1024 };
  const webBinding: ModelBinding = { kind: 'chatgpt-web', baseUrl: 'chatgpt-web', model: 'auto', credentialId: 'none', inputTokens: 8192, outputTokens: 1024 };
  const router = createModelRouter({ http, chatgpt: () => web });
  assert.equal(isChatgptWebBinding(legacyBinding), false);
  assert.equal(await router.complete(legacyBinding, [], new AbortController().signal), 'http 回复');
  assert.equal(await router.complete(webBinding, [], new AbortController().signal), 'web 回复');
  assert.deepEqual(httpCalls, ['legacy']); assert.deepEqual(webCalls, ['auto']);
  const noWeb = createModelRouter({ http, chatgpt: () => null });
  await assert.rejects(noWeb.complete(webBinding, [], new AbortController().signal), { code: 'unavailable' });
  assert.deepEqual(httpCalls, ['legacy']);
});

test('web resume independently rejects empty or oversized receipts without asking again',async()=>{
 let asks=0,resumes=0,text='   ';
 const model=new ChatgptWebModel({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE}),bridge:{async ask(){asks++;throw Error('Resume must never submit');},async resume(){resumes++;return {kind:'completed',text,conversationId:null,durationMs:0};}}});
 const binding:ModelBinding={kind:'chatgpt-web',baseUrl:'chatgpt-web',model:'current',credentialId:'none',inputTokens:8192,outputTokens:128};
 for(const json of [false,true])await assert.rejects(model.resume(binding,'saved-empty',new AbortController().signal,{json}),/接续网页回复为空/);
 text='x'.repeat(1025);await assert.rejects(model.resume(binding,'saved-long',new AbortController().signal),{code:'budget'});
 text='```json\n{"ok":true}\n```';assert.equal(await model.resume(binding,'saved-json',new AbortController().signal,{json:true}),'{"ok":true}');
 assert.equal(resumes,4);assert.equal(asks,0);
});

const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'chatgpt-web-tests' };
const webBinding: ModelBinding = { kind: 'chatgpt-web', baseUrl: 'chatgpt-web', model: 'auto', credentialId: 'none', inputTokens: 8192, outputTokens: 1024 };
const httpBinding: ModelBinding = { baseUrl: 'http://127.0.0.1:9999/v1', model: 'stub', credentialId: 'local', inputTokens: 8192, outputTokens: 1024 };
const webSource = (authorized: ChatgptWebSourceConfig['authorizedPurposes']): ChatgptWebSourceConfig =>
  ({ ...DEFAULT_CHATGPT_WEB_SOURCE, authorizedPurposes: authorized });

function runtimeFixture(t: test.TestContext) {
  const root = join(process.cwd(), '.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'chatgpt-web-')), repository = new FileBookRepository(directory);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  return repository;
}

test('runtime: web reply requires per-purpose consent and never falls back to the http model', async t => {
  const repository = runtimeFixture(t);
  const http: string[] = []; const web: CapturedCall[] = [];
  const httpPort: BookModelPort = { async complete(binding) { http.push(binding.model); return '不应出现'; } };
  const webPort: BookModelPort = { async complete(_binding, messages, _signal, options) { web.push({ purpose: options?.purpose, messages: structuredClone(messages) }); return '网页答复。'; } };
  const router = createModelRouter({ http: httpPort, chatgpt: () => webPort });
  const runtime = new BookRuntime(repository, router);
  const base = repository.loadConfig();
  // consent recorded for wiki only ⇒ reply refused before any model call
  repository.commitConfig({ ...base, mainModel: webBinding, chatgptWeb: webSource(['wiki']) }, base.revision, 'web-reply');
  await assert.rejects(runtime.chat(scope, '你好', new AbortController().signal), (error: unknown) => error instanceof Error && /未授权对话资料外发/.test(error.message));
  // length checks only: assert.deepEqual(web, []) would narrow web to never[] (asserts actual is T)
  assert.equal(http.length, 0); assert.equal(web.length, 0);
  // consent for reply ⇒ full chain through the production runtime; http stays untouched
  const second = repository.loadConfig();
  repository.commitConfig({ ...second, mainModel: webBinding, chatgptWeb: webSource(['reply', 'wiki']) }, second.revision, 'web-reply-2');
  const result = await runtime.chat(scope, '第一次见面在哪里？', new AbortController().signal);
  assert.equal(result.turn.assistant, '网页答复。');
  assert.equal(web.length, 1);
  assert.equal(web[0]?.purpose, 'reply');
  assert.ok(web[0]?.messages?.some(message => message.content.includes('第一次见面在哪里')));
  assert.deepEqual(http, []);
  assert.equal(repository.readSession(scope).length, 1);
  // web failure is terminal for the turn: no silent http fallback
  const failingWeb: BookModelPort = { async complete() { throw new BookError('unavailable', '需要登录'); } };
  const failingRuntime = new BookRuntime(repository, createModelRouter({ http: httpPort, chatgpt: () => failingWeb }));
  await assert.rejects(failingRuntime.chat(scope, '再问一次', new AbortController().signal), { code: 'unavailable' });
  assert.deepEqual(http, []);
});

test('runtime: pure Chat deep recall and wiki never call the API planner or rewriting path', async t => {
  const repository = runtimeFixture(t);
  let apiCalls = 0;
  const purposes: ModelCallOptions['purpose'][] = [];
  const model = createModelRouter({ http: { async complete() { apiCalls++; throw new Error('纯 Chat 不得调用 API'); } }, chatgpt: () => ({ async complete(_binding, _messages, _signal, options) {
    purposes.push(options?.purpose);
    return options?.purpose === 'wiki' ? JSON.stringify({ claims: [{ subject: '测试角色', predicate: '饮品', value: '咖啡', quote: '测试角色喜欢咖啡' }] }) : '这是本地召回后的网页回复';
  } }) });
  const base = repository.loadConfig();
  repository.commitConfig({ ...base, mainModel: webBinding, wikiModel: webBinding, fastModel: null, recall: { ...base.recall, mode: 'deep' }, chatgptWeb: webSource(['reply', 'wiki']) }, base.revision, 'pure-chat-config');
  const runtime = new BookRuntime(repository, model);
  await runtime.chat(scope, '请比较我们此前的饮食偏好，并结合共同经历给出具体的建议与理由。', new AbortController().signal);
  await runtime.previewWiki(scope, { sourceId: 'pure-chat-source', title: '测试材料', text: '测试角色喜欢咖啡。' }, 'model', new AbortController().signal);
  assert.equal(apiCalls, 0);
  assert.deepEqual(purposes, ['reply', 'wiki']);
});

test('runtime: wiki compilation uses the dedicated web binding with its own consent and budget helpers stay pure', async t => {
  const repository = runtimeFixture(t);
  const seen: CapturedCall[] = [];
  // claims must be verifiable against the source text: quote must occur in it verbatim.
  const port: BookModelPort = {
    async complete(binding, _messages, _signal, options) {
      seen.push({ purpose: options?.purpose, binding });
      return JSON.stringify({ claims: [{ subject: '用户', predicate: '饮品', value: '咖啡', quote: '喜欢咖啡' }] });
    },
  };
  const runtime = new BookRuntime(repository, port);
  const base = repository.loadConfig();
  // wikiModel(web) + no wiki consent ⇒ refused before any bytes leave
  repository.commitConfig({ ...base, fastModel: httpBinding, wikiModel: webBinding, chatgptWeb: webSource(['reply']) }, base.revision, 'wiki-web');
  const input = { sourceId: 'chat-source', title: '用户', text: '喜欢咖啡' };
  await assert.rejects(runtime.previewWiki(scope, input, 'model', new AbortController().signal), (error: unknown) => error instanceof Error && /未授权Wiki 编纂资料外发/.test(error.message));
  assert.equal(seen.length, 0);
  // consent ⇒ goes through the web binding with purpose 'wiki'
  const second = repository.loadConfig();
  repository.commitConfig({ ...second, fastModel: httpBinding, wikiModel: webBinding, chatgptWeb: webSource(['reply', 'wiki']) }, second.revision, 'wiki-web-2');
  const preview = await runtime.previewWiki(scope, input, 'model', new AbortController().signal);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.purpose, 'wiki');
  assert.equal(seen[0]?.binding?.kind, 'chatgpt-web');
  assert.equal(preview.source.title, '用户');
  // no wikiModel ⇒ legacy fastModel path still works
  const third = repository.loadConfig();
  repository.commitConfig({ ...third, wikiModel: null }, third.revision, 'wiki-legacy');
  const legacy = await runtime.previewWiki(scope, input, 'model', new AbortController().signal);
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.binding?.model, 'stub');
  assert.equal(legacy.source.title, '用户');
  // budget helpers: web bindings read the source budgets; http keeps the historical ones
  const withWeb: RuntimeConfig = { ...repository.loadConfig(), mainModel: webBinding, wikiModel: webBinding, chatgptWeb: sourceConfig({ replyBudgetMs: 240_000, wikiBudgetMs: 90_000 }) };
  assert.equal(chatTurnBudgetMs(withWeb), 240_000);
  assert.equal(wikiCompilationBudgetMs(withWeb), 90_000);
  assert.equal(wikiCompilationBinding(withWeb)?.kind, 'chatgpt-web');
  const withHttp: RuntimeConfig = { ...withWeb, mainModel: httpBinding, wikiModel: null };
  assert.equal(chatTurnBudgetMs(withHttp), 75_000);
  assert.equal(wikiCompilationBudgetMs(withHttp), 30_000);
  assert.equal(wikiCompilationBinding(withHttp)?.model, 'stub');
});

test('validation: web bindings, dedicated wiki binding and source block rules; legacy configs unchanged', () => {
  // web binding rules
  assert.throws(() => validateModelBinding({ kind: 'chatgpt-web', baseUrl: 'https://api.example.com', model: 'auto', credentialId: 'none', inputTokens: 8192, outputTokens: 1024 }), { code: 'invalid_input' });
  assert.throws(() => validateModelBinding({ kind: 'chatgpt-web', baseUrl: 'chatgpt-web', model: 'auto', credentialId: 'a-key', inputTokens: 8192, outputTokens: 1024 }), { code: 'invalid_input' });
  assert.throws(() => validateModelBinding({ kind: 'weird', baseUrl: 'https://api.example.com', model: 'm', credentialId: 'k', inputTokens: 8192, outputTokens: 1024 } as unknown as ModelBinding), { code: 'invalid_input' });
  validateModelBinding(webBinding);
  // legacy http binding validation is untouched
  validateModelBinding(httpBinding);
  const root = join(process.cwd(), '.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'chatgpt-web-validation-'));
  const repository = new FileBookRepository(directory);
  try {
    const config = repository.loadConfig();
    // legacy config from disk passes validation unchanged
    validateRuntime(config);
    // web mainModel without a source declaration is rejected at the config boundary
    assert.throws(() => validateRuntime({ ...config, mainModel: webBinding }), { code: 'invalid_input' });
    // fastModel(web) is refused outright (planner budget)
    assert.throws(() => validateRuntime({ ...config, mainModel: webBinding, fastModel: webBinding, chatgptWeb: webSource(['reply']) }), { code: 'invalid_input' });
    // full valid web setup round-trips through the repository
    const valid = { ...config, mainModel: webBinding, wikiModel: webBinding, chatgptWeb: webSource(['reply', 'wiki']) };
    validateRuntime(valid);
    repository.commitConfig(valid, config.revision, 'web-roundtrip');
    const reloaded = repository.loadConfig();
    assert.equal(reloaded.mainModel?.kind, 'chatgpt-web');
    assert.equal(reloaded.wikiModel?.kind, 'chatgpt-web');
    assert.deepEqual(reloaded.chatgptWeb?.authorizedPurposes, ['reply', 'wiki']);
    // source block bounds
    assert.throws(() => validateRuntime({ ...valid, chatgptWeb: { ...webSource([]), replyBudgetMs: 1000 } }), { code: 'invalid_input' });
    assert.throws(() => validateRuntime({ ...valid, chatgptWeb: { ...webSource([]), session: '' } }), { code: 'invalid_input' });
    assert.throws(() => validateRuntime({ ...valid, chatgptWeb: { ...webSource(['reply', 'reply']) } }), { code: 'invalid_input' });
    assert.throws(() => validateRuntime({ ...valid, chatgptWeb: { ...webSource(['nope' as 'reply']) } }), { code: 'invalid_input' });
  } finally { repository.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('repository: older Chat config defaults only absent switches and preserves invalid-value failures', t => {
  const repository = runtimeFixture(t);
  const original = { ...repository.loadConfig(), mainModel: webBinding, chatgptWeb: webSource(['reply']) };
  const stored = JSON.parse(JSON.stringify(original));
  delete stored.chatgptWeb.temporaryChatTests; delete stored.chatgptWeb.submitMechanism;
  const file = join(repository.directory, 'runtime.json');
  writeFileSync(file, JSON.stringify({ data: stored, operations: {} }));
  assert.equal(repository.loadConfig().chatgptWeb?.temporaryChatTests, true);
  assert.equal(repository.loadConfig().chatgptWeb?.submitMechanism, 'auto');
  repository.commitConfig(repository.loadConfig(), original.revision, 'migrate-chat');
  assert.equal(repository.loadConfig().revision, original.revision + 1);
  stored.chatgptWeb.temporaryChatTests = 'invalid';
  writeFileSync(file, JSON.stringify({ data: stored, operations: {} }));
  assert.throws(() => repository.loadConfig(), { code: 'corrupt_data' });
});

test('management: chatgpt-web status/login routes are authenticated and explicit; web drafts skip URL rules', async t => {
  const root = join(process.cwd(), '.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'chatgpt-web-server-')), repository = new FileBookRepository(directory);
  t.after(() => { rmSync(directory, { recursive: true, force: true }); });
  const seen: CapturedCall[] = [];
  const port: BookModelPort = { async complete(binding, _messages, _signal, options) { seen.push({ purpose: options?.purpose, binding }); return '测试成功'; } };
  const runtime = new BookRuntime(repository, port);
  const probed: boolean[] = [];
  const opened: Array<{ standalone?: boolean } | undefined> = [];
  const receipts: string[] = [];
  const server = await startBookServer({
    runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management'),
    chatgptWeb: {
      async probe() { probed.push(true); return { state: 'signed-out', detail: '页面显示登录入口', checkedAt: '2026-10-13T00:00:00.000Z' }; },
      async openLoginPage(options) { opened.push(options); },
      requestStatus(id) { receipts.push('status:' + id); return { active: true }; },
      async resume(id) { receipts.push('resume:' + id); return { kind: 'completed', text: '已有回复', conversationId: null, durationMs: 0 }; },
      async cancel(id) { receipts.push('cancel:' + id); return { kind: 'cancelled', confirmed: true, message: '已确认', durationMs: 0 }; },
    },
  });
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  // status requires the management token
  assert.equal((await fetch(`${origin}/api/memory-book/v1/chatgpt-web/status`)).status, 401);
  const auth = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/memory-book/v1/chatgpt-web/requests/r-1/resume`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal(receipts.length, 0);
  assert.equal((await fetch(`${origin}/api/memory-book/v1/chatgpt-web/requests/r-1`, { headers: auth })).status, 200);
  assert.equal((await fetch(`${origin}/api/memory-book/v1/chatgpt-web/requests/r-1/resume`, { method: 'POST', headers: auth, body: '{}' })).status, 200);
  assert.equal((await fetch(`${origin}/api/memory-book/v1/chatgpt-web/requests/r-1/cancel`, { method: 'POST', headers: auth, body: '{}' })).status, 200);
  assert.deepEqual(receipts, ['status:r-1', 'resume:r-1', 'cancel:r-1']);
  const status = await fetch(`${origin}/api/memory-book/v1/chatgpt-web/status`, { headers: auth });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { state: 'signed-out', detail: '页面显示登录入口', checkedAt: '2026-10-13T00:00:00.000Z' });
  assert.deepEqual(probed, [true]);
  // login is an explicit POST; standalone flag passes through
  const login = await fetch(`${origin}/api/memory-book/v1/chatgpt-web/login`, { method: 'POST', headers: auth, body: JSON.stringify({ standalone: true }) });
  assert.equal(login.status, 200);
  assert.deepEqual(opened, [{ standalone: true }]);
  // a web draft binding skips the HTTP URL rules and runs one explicit test through the router
  const draft = { binding: webBinding, prompt: '只回复测试成功' };
  const testResponse = await fetch(`${origin}/api/memory-book/v1/models/test`, { method: 'POST', headers: auth, body: JSON.stringify(draft) });
  assert.equal(testResponse.status, 200);
  const testResult = await testResponse.json() as { ok: boolean; reply?: string };
  assert.equal(testResult.ok, true);
  assert.equal(testResult.reply, '测试成功');
  assert.equal(seen.length, 1); assert.equal(seen[0]?.purpose, 'test'); assert.equal(seen[0]?.binding?.kind, 'chatgpt-web');
  // an instance without the bridge reports the capability honestly
  const bare = await startBookServer({ runtime, credentials: new BookCredentials(join(directory, 'credentials-2')), uiRoot: resolve('management') });
  t.after(() => bare.close());
  const bareStatus = await fetch(`${new URL(bare.url).origin}/api/memory-book/v1/chatgpt-web/status`, { headers: { Authorization: `Bearer ${bare.token}` } });
  assert.equal(bareStatus.status, 503);
  repository.close();
});

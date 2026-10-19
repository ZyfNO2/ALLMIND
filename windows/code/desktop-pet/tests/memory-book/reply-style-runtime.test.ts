import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { BookRuntime } from '../../app/book-runtime.js';
import type { BookModelPort, ModelCallOptions } from '../../providers/book-model.js';
import { countReplyChars } from '../../core/reply-length.js';

function fixture(t: import('node:test').TestContext) {
  const root = join(process.cwd(), '.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'reply-style-rt-')), repository = new FileBookRepository(directory);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  return repository;
}
function spyRuntime(repository: FileBookRepository, reply = '好的。') {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options?: ModelCallOptions }> = [];
  const port: BookModelPort = { async complete(_binding, messages, _signal, options) { calls.push({ messages: structuredClone(messages), ...(options !== undefined ? { options } : {}) }); return reply; } };
  const runtime = new BookRuntime(repository, port);
  const config = repository.loadConfig();
  if (!config.mainModel) repository.commitConfig({ ...config, mainModel: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 } }, config.revision, 'seed-model');
  return { runtime, calls };
}
const STYLE_MARKER = '本轮回复风格：';

test('per-turn style reaches the one Builder policy and the persisted turn decision', async t => {
  const repository = fixture(t), { runtime, calls } = spyRuntime(repository);
  const base = repository.loadConfig();
  repository.commitConfig({ ...base, mainModel: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 } }, base.revision, 'seed');
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 's1' };
  const result = await runtime.chat(scope, '帮我看看这段代码为什么报错', new AbortController().signal, { replyStyle: 'short' });
  assert.equal(result.turn.replyStyleDecision?.version, 1);
  assert.equal(result.turn.replyStyleDecision?.requestedStyle, 'short');
  assert.equal(result.turn.replyStyleDecision?.selectedStyle, 'short');
  assert.equal(result.turn.replyStyleDecision?.source, 'turn');
  assert.deepEqual(result.turn.replyStyleDecision?.effectiveRange, { minChars: null, maxChars: null });
  assert.equal(result.turn.replyLength, undefined, '无范围时不得凭空制造字数结果');
  const system = calls[0]!.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes(`${STYLE_MARKER}简短`), '本轮选择必须进入唯一 Builder 政策');
  assert.ok(system.includes('约 50 字'));
  assert.ok(!system.includes('本轮回复风格：自然'), '不发送矛盾的风格说明');
  // the turn is persisted with the decision and the shared counter stays consistent
  const stored = repository.readSession(scope).at(-1)!;
  assert.equal(stored.replyStyleDecision?.selectedStyle, 'short');
  assert.equal(stored.assistant, '好的。');
});

test('idempotency: same turnId+style replays; changing the explicit style is a conflict with zero new submits', async t => {
  const repository = fixture(t), { runtime, calls } = spyRuntime(repository);
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 's1' };
  const first = await runtime.chat(scope, '你好', new AbortController().signal, { turnId: 'turn-style-1', replyStyle: 'short' });
  assert.equal(first.replayed, false);
  const again = await runtime.chat(scope, '你好', new AbortController().signal, { turnId: 'turn-style-1', replyStyle: 'short' });
  assert.equal(again.replayed, true); assert.equal(calls.length, 1, '重放不得再次调用模型');
  await assert.rejects(runtime.chat(scope, '你好', new AbortController().signal, { turnId: 'turn-style-1', replyStyle: 'detailed' }), /回复风格/);
  await assert.rejects(runtime.chat(scope, '你好', new AbortController().signal, { turnId: 'turn-style-1' }), /回复风格/);
  assert.equal(calls.length, 1);
  // an explicit style after an implicit (inherit) turn is a different request identity
  const second = await runtime.chat(scope, '第二次', new AbortController().signal, { replyStyle: 'balanced' });
  assert.equal(second.turn.replyStyleDecision?.requestedStyle, 'balanced');
  assert.equal(calls.length, 2);
});

test('inspect preview and ordinary chat resolve the same length policy for the same inputs', async t => {
  const repository = fixture(t), { runtime } = spyRuntime(repository);
  const base = repository.loadConfig();
  repository.commitConfig({ ...base, mainModel: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 }, characters: base.characters.map(role => ({ ...role, replyStyle: 'detailed' as const, replyLength: { minChars: null, maxChars: 900 } })) }, base.revision, 'seed-detailed');
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 's1' };
  const chatResult = await runtime.chat(scope, '为什么天空是蓝色的', new AbortController().signal);
  const inspectContext = await runtime.inspect(scope, '为什么天空是蓝色的', new AbortController().signal, undefined, undefined);
  const policyOf = (context: { messages: Array<{ role: string; content: string }> }) => context.messages.filter(message => message.role === 'system').map(message => message.content).join('\n').split('【当前回复').slice(1).join('【当前回复');
  assert.equal(policyOf(inspectContext), policyOf(chatResult.context!), '同 query/config/选项必须得到同长度政策');
  assert.match(policyOf(chatResult.context!), /本轮回复风格：详细/);
  assert.match(policyOf(chatResult.context!), /最多 900 字/);
});

test('proactive greetings never inherit the ordinary style or range', async t => {
  const repository = fixture(t), { runtime, calls } = spyRuntime(repository);
  const base = repository.loadConfig();
  repository.commitConfig({ ...base, mainModel: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 }, characters: base.characters.map(role => ({ ...role, replyStyle: 'detailed' as const, replyLength: { minChars: 400, maxChars: null } })) }, base.revision, 'seed-proactive');
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 's1' };
  await runtime.proactive(scope, 'user returned', new AbortController().signal);
  const system = calls[0]!.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(!system.includes('本轮回复风格'), '主动发言不继承普通风格');
  assert.ok(!system.includes('最少 400 字'), '主动发言不继承普通范围');
});

test('numeric requests narrow this turn, flag conflicts and keep the saved bounds visible', async t => {
  const longReply = '这是一段足够长的合成回复。'.repeat(30);
  const repository = fixture(t), { runtime, calls } = spyRuntime(repository, longReply);
  const base = repository.loadConfig();
  repository.commitConfig({ ...base, mainModel: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 }, characters: base.characters.map(role => ({ ...role, replyLength: { minChars: 200, maxChars: null } })) }, base.revision, 'seed-range');
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 's1' };
  const conflict = await runtime.chat(scope, '这次不超过80字', new AbortController().signal);
  assert.equal(conflict.turn.replyStyleDecision?.requestConflict, true);
  assert.deepEqual(conflict.turn.replyStyleDecision?.effectiveRange, { minChars: 200, maxChars: null });
  assert.equal(conflict.turn.replyLength?.minChars, 200, '按保存范围测量');
  const system = calls[0]!.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes('最少 200 字'), '冲突时沿用保存范围，不悄悄改设置');
  assert.ok(!system.includes('不超过 80 字'), '不把被拒绝的要求发给模型');
  const valid = await runtime.chat({ ...scope, sessionId: 's2' }, '这次不超过900字', new AbortController().signal);
  assert.equal(valid.turn.replyStyleDecision?.requestConflict, false);
  assert.deepEqual(valid.turn.replyStyleDecision?.effectiveRange, { minChars: 200, maxChars: 900 });
  assert.equal(valid.turn.replyLength?.status, 'within');
  assert.equal(valid.turn.replyLength?.actualChars, countReplyChars(valid.turn.assistant));
});

test('incognito keeps the same policy in memory and never persists turn or decision', async t => {
  const repository = fixture(t), { runtime, calls } = spyRuntime(repository);
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'private-1' };
  const result = await runtime.chat(scope, '简单说说就好', new AbortController().signal, { incognito: true });
  assert.equal(result.turn.replyStyleDecision?.source, 'explicit-text');
  assert.equal(result.turn.replyStyleDecision?.selectedStyle, 'short');
  const system = calls[0]!.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes(`${STYLE_MARKER}简短`));
  assert.equal(repository.readSession(scope).length, 0, '无痕不落盘');
});

test('repository validates stored decisions and keeps legacy turns without decisions readable', async t => {
  const repository = fixture(t), { runtime } = spyRuntime(repository);
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 's1' };
  const result = await runtime.chat(scope, '你好', new AbortController().signal, { turnId: 'legacy-check' });
  const persisted = repository.readSession(scope).at(-1)!;
  assert.equal(persisted.replyStyleDecision?.requestedStyle, 'inherit');
  assert.equal(persisted.replyStyleDecision?.selectedStyle, 'natural');
  assert.equal(persisted.replyStyleDecision?.source, 'role');
  // a decision claiming bounds without the matching measured result is rejected, and a
  // self-consistent deviation (short reply under a saved floor) stays legal and preserved
  const tampered = { ...structuredClone(result.turn), id: 'tampered-1', replyStyleDecision: { ...structuredClone(result.turn.replyStyleDecision)!, effectiveRange: { minChars: 500, maxChars: null } } };
  assert.throws(() => repository.appendTurn(scope, tampered), /范围不一致|字数结果/);
  const deviating = { ...structuredClone(result.turn), id: 'tampered-2', replyStyleDecision: { ...structuredClone(result.turn.replyStyleDecision)!, effectiveRange: { minChars: 500, maxChars: null } }, replyLength: { minChars: 500, maxChars: null, actualChars: countReplyChars(result.turn.assistant), status: 'too-short' as const } };
  repository.appendTurn(scope, deviating);
  assert.equal(repository.readSession(scope).at(-1)?.replyLength?.status, 'too-short', '偏离结果按原样保留');
  // legacy turns (pre-B03) carry no decision and stay readable through the same repository
  const cloned = structuredClone(result.turn) as typeof result.turn & { replyStyleDecision?: unknown };
  delete cloned.replyStyleDecision;
  const legacy = { ...cloned, id: 'legacy-turn-1' };
  repository.appendTurn(scope, legacy);
  assert.equal(repository.readSession(scope).find(row => row.id === 'legacy-turn-1')?.replyStyleDecision, undefined);
});


test('review: read-only preview and explicit inspect range use the same resolver without writes', async t => {
  const repository=fixture(t),{runtime,calls}=spyRuntime(repository);
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'preview'};
  const before=repository.loadConfig();
  const decision=runtime.replyStylePreview(scope,'这次不超过80字','detailed');
  assert.equal(decision.targetChars,80);assert.equal(calls.length,0);
  assert.equal(repository.readSession(scope).length,0);assert.deepEqual(repository.loadConfig(),before);
  const context=await runtime.inspect(scope,'你好',new AbortController().signal,undefined,{minChars:200,maxChars:null},'short');
  const system=context.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n');
  assert.match(system,/最少 200 字/);assert.match(system,/约 200 字/);assert.doesNotMatch(system,/约 50 字/);
});

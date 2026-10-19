import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BookError, DEFAULT_CHATGPT_WEB_SOURCE, type BookScope, type ChatMessage } from '../../contracts/memory-book.js';
import type { ChatgptProjectBinding } from '../../contracts/chatgpt-project.js';
import { ChatgptBackgroundBridge } from '../../providers/chatgpt-background-bridge.js';
import { ChatgptWebModel } from '../../providers/chatgpt-web-model.js';
import type { ChatgptWebAskResult } from '../../providers/chatgpt-web-bridge.js';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { BookRuntime } from '../../app/book-runtime.js';
import type { BookModelPort, ModelCallOptions } from '../../providers/book-model.js';

/** B01 §5 rows not already covered by chatgpt-project.test.ts: new-session threads,
 * dual-role isolation, pause/unbind attribution, unknown/cancel receipts and the
 * zero-message project inspection. Keys are ids, never display names: both roles and
 * both projects deliberately share one display name here. */
const account = 'a'.repeat(64);
const projectA = 'g-p-' + '1'.repeat(32);
const projectB = 'g-p-' + '2'.repeat(32);
const bindingA: ChatgptProjectBinding = { id: 'bind-a', characterId: 'char-a', pairingId: 'local-user', enabled: true, projectId: projectA, name: '同名项目', account, memory: 'unverified' };
const bindingB: ChatgptProjectBinding = { id: 'bind-b', characterId: 'char-b', pairingId: 'local-user', enabled: true, projectId: projectB, name: '同名项目', account, memory: 'unverified' };
const scopeA1: BookScope = { characterId: 'char-a', pairingId: 'local-user', sessionId: 'session-1' };
const scopeA2: BookScope = { characterId: 'char-a', pairingId: 'local-user', sessionId: 'session-2' };
const scopeB1: BookScope = { characterId: 'char-b', pairingId: 'local-user', sessionId: 'session-1' };

function fixtureDirectory(prefix: string): string {
  const root = join(process.cwd(), '.local', 'memory-book-tests');
  mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, prefix));
}

type HostCall = { action: string; input: Record<string, unknown> };

/** A page host that owns several project conversations at once, mirroring what the
 * embedded page can really do: new chat per project, continuation by conversation id
 * and node, and the same account fingerprint for every role. */
function multiThreadHost(calls: HostCall[]) {
  const conversations = new Map<string, { projectId: string; node: string }>();
  let sequence = 0;
  let pending: { projectId?: string; conversationId?: string } | null = null;
  let activeConversation: string | null = null;
  const host = {
    conversations,
    /** 'auto' completes with the verified node; 'pending' stalls the poll; 'cancelled' reports a stopped generation. */
    readMode: 'auto' as 'auto' | 'pending' | 'cancelled',
    async navigate(_temporary: boolean, target?: any) { calls.push({ action: 'navigate', input: target ?? {} }); },
    async login() {},
    async execute(action: string, input: any = {}) {
      calls.push({ action, input });
      if (action === 'account') return { account };
      if (action === 'project') {
        if (!input.conversationId) return { projectId: input.projectId, name: '同名项目', conversationId: null, memory: 'unverified' };
        const record = conversations.get(String(input.conversationId));
        if (!record || record.projectId !== input.projectId) throw new Error('项目线程归属证据缺失或不匹配，不发送/交付。');
        if (input.expectedNode && record.node !== input.expectedNode) throw new Error('网页线程已被外部修改或结果未同步，不能自动续接。');
        return { projectId: input.projectId, conversationId: input.conversationId, currentNode: record.node };
      }
      if (action === 'probe' || action === 'prepare') {
        if (action === 'prepare') pending = { ...(input.projectId !== undefined ? { projectId: String(input.projectId) } : {}), ...(input.conversationId !== undefined ? { conversationId: String(input.conversationId) } : {}) };
        return { ready: true, temporary: false, hasTurns: false };
      }
      if (action === 'model') return { model: input.model };
      if (action === 'write') return { ok: true };
      if (action === 'submit') {
        if (pending?.conversationId) activeConversation = pending.conversationId;
        else {
          sequence += 1; activeConversation = 'c-' + sequence;
          conversations.set(activeConversation, { projectId: String(pending?.projectId), node: 'node-' + sequence });
        }
        return { submitted: true };
      }
      if (action === 'read') {
        if (host.readMode === 'pending') return { state: 'pending' };
        if (host.readMode === 'cancelled') return { state: 'cancelled' };
        const record = activeConversation ? conversations.get(activeConversation) : undefined;
        if (!activeConversation || !record) throw new Error('页面没有活动线程。');
        return { state: 'completed', text: '项目回复正文', conversationId: activeConversation, messageId: record.node };
      }
      return { ok: true };
    },
  };
  return host;
}

function bridgeFor(host: ReturnType<typeof multiThreadHost>, receiptPath: string) {
  return new ChatgptBackgroundBridge({ config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded' as const }), pageHost: host, receiptPath, intervalMs: 0, pollMs: 10 });
}

const submitsOf = (calls: HostCall[]) => calls.filter(row => row.action === 'submit').length;

/** Narrowing helper: node:test assertions do not refine the result union. */
function failureCode(result: ChatgptWebAskResult): string | undefined { return result.kind === 'failed' ? result.code : undefined; }

async function waitForSubmit(calls: HostCall[]) {
  for (let attempt = 0; attempt < 500 && submitsOf(calls) === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(submitsOf(calls) > 0, '请求未到达提交边界。');
}

test('project threads are keyed by scope: new session opens a new thread and two same-named roles never share mappings', async () => {
  const directory = fixtureDirectory('aiki-project-matrix-');
  try {
    const calls: HostCall[] = [];
    const host = multiThreadHost(calls);
    const bridge = bridgeFor(host, join(directory, 'receipt.json'));
    const ask = (id: string, binding: ChatgptProjectBinding, scope: BookScope, local: string | null, next: string, context: string) =>
      bridge.ask({ requestId: id, prompt: '本轮问题', context, continuationContext: 'CTX-SYSTEMS-ONLY', project: { binding, scope, localTurnId: local, nextTurnId: next }, temporary: false, timeoutMs: 5000 });
    // session-1 round 1: brand-new thread inside project A
    assert.equal((await ask('a1-r1', bindingA, scopeA1, null, 'turn-a1-1', 'CTX-FULL-A1')).kind, 'completed');
    assert.equal(host.conversations.size, 1);
    const threadA1 = bridge.projectThreads(bindingA, scopeA1)!;
    assert.equal(threadA1.conversationId, 'c-1'); assert.equal(threadA1.projectId, projectA); assert.equal(threadA1.targetChanged, false);
    assert.equal(threadA1.projectName, '同名项目');
    // session-1 round 2: continues the verified thread, carries systems-only continuation context
    const beforeRound2 = calls.length;
    assert.equal((await ask('a1-r2', bindingA, scopeA1, 'turn-a1-1', 'turn-a1-2', 'CTX-FULL-A1')).kind, 'completed');
    assert.equal(host.conversations.size, 1);
    const round2 = calls.slice(beforeRound2);
    assert.equal(round2.filter(row => row.action === 'navigate').at(-1)?.input.conversationId, 'c-1');
    assert.ok(round2.filter(row => row.action === 'write').every(row => String(row.input.text).includes('CTX-SYSTEMS-ONLY')));
    assert.ok(round2.filter(row => row.action === 'write').every(row => !String(row.input.text).includes('CTX-FULL-A1')));
    assert.equal(submitsOf(calls), 2);
    // session-2: same character, same project, but a NEW session opens a NEW thread and never adopts c-1
    const beforeNewSession = calls.length;
    assert.equal((await ask('a2-r1', bindingA, scopeA2, null, 'turn-a2-1', 'CTX-FULL-A2')).kind, 'completed');
    assert.equal(host.conversations.size, 2);
    const threadA2 = bridge.projectThreads(bindingA, scopeA2)!;
    assert.equal(threadA2.conversationId, 'c-2'); assert.notEqual(threadA2.conversationId, threadA1.conversationId);
    assert.equal(threadA2.projectId, projectA); assert.equal(threadA2.targetChanged, false);
    const newSession = calls.slice(beforeNewSession);
    assert.equal(newSession.filter(row => row.action === 'navigate').at(-1)?.input.conversationId, undefined, 'new session must not navigate into the previous thread');
    assert.ok(newSession.filter(row => row.action === 'write').every(row => String(row.input.text).includes('CTX-FULL-A2')));
    assert.equal(bridge.projectThreads(bindingA, scopeA1)!.conversationId, 'c-1', 'session-1 attribution is untouched');
    // role B (same display name everywhere) gets its own project and its own thread
    assert.equal((await ask('b1-r1', bindingB, scopeB1, null, 'turn-b1-1', 'CTX-FULL-B1')).kind, 'completed');
    assert.equal(host.conversations.size, 3);
    const threadB1 = bridge.projectThreads(bindingB, scopeB1)!;
    assert.equal(threadB1.projectId, projectB); assert.equal(threadB1.conversationId, 'c-3'); assert.equal(threadB1.targetChanged, false);
    // mismatched lookups keep the ACTUAL attribution and flag the target change instead of guessing
    assert.equal(bridge.projectThreads(bindingB, scopeA1)!.conversationId, 'c-1');
    assert.equal(bridge.projectThreads(bindingB, scopeA1)!.targetChanged, true);
    assert.equal(bridge.projectThreads(bindingA, scopeB1)!.conversationId, 'c-3');
    assert.equal(bridge.projectThreads(bindingA, scopeB1)!.targetChanged, true);
    assert.equal(bridge.projectThreads(bindingB, { ...scopeB1, sessionId: 'session-9' }), null, 'a scope without a confirmed thread has no archive');
    // a binding that does not match the scope is refused before any page submit
    const beforeCross = submitsOf(calls);
    assert.equal((await bridge.ask({ requestId: 'cross-role', prompt: 'x', project: { binding: bindingB, scope: scopeA1, localTurnId: null, nextTurnId: 't' }, temporary: false, timeoutMs: 1000 })).kind, 'failed');
    assert.equal(submitsOf(calls), beforeCross);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('paused and unbound targets keep the confirmed attribution, refuse sends and never drop the cloud mapping', async () => {
  const directory = fixtureDirectory('aiki-project-pause-');
  try {
    const calls: HostCall[] = [];
    const host = multiThreadHost(calls);
    const receiptPath = join(directory, 'receipt.json');
    const bridge = bridgeFor(host, receiptPath);
    assert.equal((await bridge.ask({ requestId: 'seed-turn', prompt: '第一轮', project: { binding: bindingA, scope: scopeA1, localTurnId: null, nextTurnId: 'turn-1' }, temporary: false, timeoutMs: 5000 })).kind, 'completed');
    const paused: ChatgptProjectBinding = { ...bindingA, enabled: false };
    // the runtime does not route a paused binding into the project at all
    const routed: Array<{ project?: unknown; temporary?: boolean }> = [];
    const model = new ChatgptWebModel({ config: () => ({ ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded' as const, conversationMode: 'temporary' as const }), runtime: () => ({ chatgptProjects: [paused] }) as never, bridge: { ask: async input => { routed.push(input); return { kind: 'completed', text: 'ok', conversationId: 'c-9', durationMs: 1 }; } } });
    await model.complete({ kind: 'chatgpt-web', baseUrl: 'chatgpt-web', model: 'GPT-6', credentialId: 'none', inputTokens: 4096, outputTokens: 512 }, [{ role: 'user', content: 'q' }], new AbortController().signal, { purpose: 'reply', scope: scopeA1 });
    assert.equal(routed[0]!.project, undefined); assert.equal(routed[0]!.temporary, true);
    // a paused binding cannot send through the bridge either
    const before = submitsOf(calls);
    assert.equal((await bridge.ask({ requestId: 'paused-send', prompt: 'x', project: { binding: paused, scope: scopeA1, localTurnId: 'turn-1', nextTurnId: 'turn-2' }, temporary: false, timeoutMs: 1000 })).kind, 'failed');
    assert.equal(submitsOf(calls), before);
    // the UI still shows the real archive, marked as target-changed
    const pausedView = bridge.projectThreads(paused, scopeA1)!;
    assert.equal(pausedView.conversationId, 'c-1'); assert.equal(pausedView.targetChanged, true); assert.equal(pausedView.projectName, '同名项目');
    // after unbinding the scope keeps the confirmed attribution
    const unboundView = bridge.projectThreads(null, scopeA1)!;
    assert.equal(unboundView.conversationId, 'c-1'); assert.equal(unboundView.targetChanged, true); assert.equal(unboundView.projectName, '同名项目');
    // the persisted receipt still carries the mapping: pause/unbind deletes nothing cloud-side
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { threads: Array<{ conversationId: string }> };
    assert.ok(receipt.threads.some(row => row.conversationId === 'c-1'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unknown submission resumes the same request without resending; a cancel never fakes success or pollutes the mapping', async () => {
  const directory = fixtureDirectory('aiki-project-unknown-');
  try {
    const calls: HostCall[] = [];
    const host = multiThreadHost(calls);
    const receiptPath = join(directory, 'receipt.json');
    const bridge = bridgeFor(host, receiptPath);
    // stall the page read so the ask times out with an unknown submission state
    host.readMode = 'pending';
    const inFlight = bridge.ask({ requestId: 'unknown-1', prompt: 'x', project: { binding: bindingA, scope: scopeA1, localTurnId: null, nextTurnId: 'turn-1' }, temporary: false, timeoutMs: 400 });
    await waitForSubmit(calls);
    // a second request is refused while the first is unresolved (no parallel page use)
    assert.equal(failureCode(await bridge.ask({ requestId: 'second', prompt: 'x', project: { binding: bindingA, scope: scopeA2, localTurnId: null, nextTurnId: 't' }, temporary: false, timeoutMs: 1000 })), 'busy');
    const first = await inFlight;
    assert.equal(first.kind, 'failed'); assert.equal(failureCode(first), 'timeout'); assert.equal(first.kind === 'failed' ? first.submitted : undefined, 'unknown');
    // the same request id is never re-submitted; only resume may continue it
    assert.equal(failureCode(await bridge.ask({ requestId: 'unknown-1', prompt: 'x', project: { binding: bindingA, scope: scopeA1, localTurnId: null, nextTurnId: 't' }, temporary: false, timeoutMs: 1000 })), 'busy');
    host.readMode = 'auto';
    const resumed = await bridge.resume('unknown-1', 5000);
    assert.equal(resumed.kind, 'completed');
    assert.equal(submitsOf(calls), 1, 'resume must not submit a second message');
    // the late result is recorded only after the project receipt verified it
    assert.equal(bridge.projectThreads(bindingA, scopeA1)!.conversationId, 'c-1');
    // a restarted bridge reads the same receipt: mapping survives, the used id is still refused
    const reopened = bridgeFor(host, receiptPath);
    assert.equal(reopened.projectThreads(bindingA, scopeA1)!.conversationId, 'c-1');
    assert.equal(failureCode(await reopened.ask({ requestId: 'unknown-1', prompt: 'x', project: { binding: bindingA, scope: scopeA1, localTurnId: 'turn-1', nextTurnId: 't' }, temporary: false, timeoutMs: 1000 })), 'duplicate');
    // a cancelled project turn never writes a thread mapping and the next send opens a fresh thread
    host.readMode = 'cancelled';
    const cancelled = await reopened.ask({ requestId: 'cancel-1', prompt: 'x', project: { binding: bindingA, scope: scopeA2, localTurnId: null, nextTurnId: 'turn-2' }, temporary: false, timeoutMs: 5000 });
    assert.equal(cancelled.kind, 'cancelled'); assert.equal(cancelled.confirmed, true);
    assert.equal(reopened.projectThreads(bindingA, scopeA2), null, 'an unverified cancelled thread must not become the confirmed archive');
    host.readMode = 'auto';
    assert.equal((await reopened.ask({ requestId: 'after-cancel', prompt: 'y', project: { binding: bindingA, scope: scopeA2, localTurnId: null, nextTurnId: 'turn-2' }, temporary: false, timeoutMs: 5000 })).kind, 'completed');
    assert.equal(reopened.projectThreads(bindingA, scopeA2)!.conversationId, 'c-3');
    assert.equal(bridge.projectThreads(bindingA, scopeA1)!.conversationId, 'c-1', 'the verified first mapping is untouched');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('project inspection is zero-message and refuses while a request is active', async () => {
  const directory = fixtureDirectory('aiki-project-inspect-');
  try {
    const calls: HostCall[] = [];
    const host = multiThreadHost(calls);
    const bridge = bridgeFor(host, join(directory, 'receipt.json'));
    // hold the page busy with an unresolved project request
    host.readMode = 'pending';
    const inFlight = bridge.ask({ requestId: 'inspect-busy', prompt: 'x', project: { binding: bindingA, scope: scopeA1, localTurnId: null, nextTurnId: 'turn-1' }, temporary: false, timeoutMs: 4000 });
    await waitForSubmit(calls);
    await assert.rejects(bridge.inspectProject(projectA), (error: unknown) => error instanceof BookError && error.code === 'busy');
    host.readMode = 'auto';
    assert.equal((await inFlight).kind, 'completed');
    // the check itself navigates and reads the project page, but never writes or submits
    const mark = calls.length;
    const inspected = await bridge.inspectProject(projectA);
    assert.equal(inspected.projectId, projectA); assert.equal(inspected.account, account);
    assert.equal(inspected.name, '同名项目'); assert.equal(inspected.memory, 'unverified');
    const segment = calls.slice(mark);
    assert.ok(segment.some(row => row.action === 'account'));
    assert.ok(segment.some(row => row.action === 'project'));
    assert.ok(segment.every(row => !['write', 'submit'].includes(row.action)), '检查必须是零消息');
    // an invalid project id never reaches the page
    await assert.rejects(bridge.inspectProject('g-p-' + 'z'.repeat(32)), (error: unknown) => error instanceof BookError && error.code === 'invalid_input');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('runtime keeps session scope: a new session starts from a null turn boundary and carries no prior-session private text', async t => {
  const directory = fixtureDirectory('aiki-matrix-runtime-');
  let repository: FileBookRepository | null = null;
  try {
    repository = new FileBookRepository(directory);
    const captured: Array<{ options?: ModelCallOptions; messages: ChatMessage[] }> = [];
    const port: BookModelPort = { async complete(_binding, messages, _signal, options) { captured.push({ ...(options !== undefined ? { options } : {}), messages: structuredClone(messages) }); return '好的。'; } };
    const runtime = new BookRuntime(repository, port);
    const base = repository.loadConfig();
    repository.commitConfig({
      ...base,
      mainModel: { kind: 'chatgpt-web', baseUrl: 'chatgpt-web', model: 'GPT-6', credentialId: 'none', inputTokens: 4096, outputTokens: 512 },
      chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded', authorizedPurposes: ['reply'] },
      chatgptProjects: [bindingA, bindingB],
      characters: [...base.characters, { id: 'char-a', name: '同名角色', intro: '', appearancePath: null }, { id: 'char-b', name: '同名角色', intro: '', appearancePath: null }],
    }, base.revision, 'matrix-runtime-seed');
    await runtime.chat(scopeA1, 'SESSION1-PRIVATE 第一轮问题', new AbortController().signal);
    const firstTurnId = repository.readSession(scopeA1).at(-1)!.id;
    await runtime.chat(scopeA1, '第二轮问题', new AbortController().signal);
    assert.equal(captured[1]!.options!.localTurnId, firstTurnId, '同一会话第二轮必须携带第一轮边界');
    assert.equal(captured[1]!.options!.scope!.sessionId, 'session-1');
    await runtime.chat(scopeA2, '新会话问题', new AbortController().signal);
    assert.equal(captured[2]!.options!.localTurnId, null, '新会话必须从空边界开始');
    const newSessionMessages = JSON.stringify(captured[2]!.messages);
    assert.ok(!newSessionMessages.includes('SESSION1-PRIVATE'), '新会话不得混入上一会话私人原文');
    assert.ok(newSessionMessages.includes('新会话问题'));
    await runtime.chat(scopeB1, '角色B的问题', new AbortController().signal);
    assert.ok(!JSON.stringify(captured[3]!.messages).includes('SESSION1-PRIVATE'), '另一角色不得混入任何前一角色的会话内容');
    assert.equal(captured[3]!.options!.scope!.characterId, 'char-b');
    // the local Book stays session-scoped too
    assert.equal(repository.readSession(scopeA1).length, 2);
    assert.equal(repository.readSession(scopeA2).length, 1);
    assert.equal(repository.readSession(scopeB1).length, 1);
  } finally { repository?.close(); rmSync(directory, { recursive: true, force: true }); }
});

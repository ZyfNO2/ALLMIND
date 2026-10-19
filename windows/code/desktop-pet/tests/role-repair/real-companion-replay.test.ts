// RWR-07 · 真实陪伴对话回放（真实 LLM，零并发）
//
// 目的：用用户授权的真实 LLM 端点验证角色陪伴链路，重点是
//   1. 真实轮次能否走通（生产 ProviderTransport + JsonDialogueProvider + DialoguePipeline）；
//   2. 人设 / Lorebook / 作者资料是否真的进入提示，且 Lorebook 带「作者所写，非用户事实」标签、
//      firstMessage **不**进入 context（CONTRACTS §5）；
//   3. 角色作用域：Lorebook/知识库/人设 per-character，换角色不串；
//   4. 错误路径明确失败，无 silent fallback（CONTRACTS §2「own 源失效必须失败」、§6「禁止吞异常后回成功」）。
//
// 真实的部分：HTTPS 请求、Bearer 鉴权、预算授权钩子、SSE/JSON 解码、真实模型生成、真实 SQLite 持久化。
// 被替换的（已标注）：CallAuthorizer（记录型替身；真实付费审批来自用户本轮授权）。
//
// 凭据：只从环境变量 RWR07_LLM_KEY 读取，永不写入仓库、日志或本报告。
// 端点：默认 https://127.0.0.1:18443/v1/chat/completions（本地 TLS 终结，转发到用户授权的
//        http://127.0.0.1:18899；因 ProviderTransport 要求 https:，见 transport.ts:56）。
// 数据：全部落在 mkdtemp 临时目录，**不写真实用户库** windows/.local/data/companion.sqlite。
//
// 串行：本文件内所有用例线性执行（`--test-concurrency=1`），不并发打端点。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { LorebookStore } from '../../memory/lorebook-store.js';
import { MemoryMediaStore } from '../../media/store.js';
import { NextTurnPort, type TurnPortEvent } from '../../core/turn-port.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import { characterPrompt } from '../../companion/prompts.js';
import type { DialogueRequest, TurnScope, DialogueContext, MemoryMaintenanceInput } from '../../contracts/index.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPANION = 'companion' as const;
const ROLE_B = 'role-b' as const;

interface RealConfig { endpoint: string; model: string; apiKey: string }

async function loadConfig(): Promise<RealConfig | null> {
  const key = process.env.RWR07_LLM_KEY;
  if (!key) return null;
  return {
    endpoint: process.env.RWR07_LLM_ENDPOINT ?? 'https://127.0.0.1:18443/v1/chat/completions',
    model: process.env.RWR07_LLM_MODEL ?? 'muse-spark-1.3-contributor-free',
    apiKey: key,
  };
}

const noPlan = (input: MemoryTurnInput): MemoryTurnPlan =>
  ({ scope: input.scope, request: 'none', changes: [], suppressSources: [], clarification: null, reason: '无记忆相关内容' });

/** 记录型预算替身：只记录 outcome，不做真实计费。真实付费审批来自用户本轮授权。 */
function recordingAuthorizer(outcomes: string[]) {
  return {
    async authorize() {
      return { async settle(outcome: { status: string }) { outcomes.push(outcome.status); } };
    },
  };
}

interface Chain {
  requests: DialogueRequest[];
  outcomes: string[];
  books: LorebookStore;
  submit(text: string): Promise<TurnScope>;
  waitForTerminal(scope: TurnScope, timeoutMs?: number): Promise<Extract<TurnPortEvent, { type: 'terminal' }>>;
  cleanup(): Promise<void>;
}

async function makeChain(opts: {
  characterId: string;
  persona?: string;
  author?: { scenario?: string; exampleDialogue?: string; firstMessage?: string };
  seed?: (books: LorebookStore) => void;
  model?: string;
  apiKey: string;
  endpoint: string;
}): Promise<Chain> {
  const dir = await mkdtemp(join(tmpdir(), 'rwr07-real-'));
  const store = new SqliteMemoryStore({
    filename: join(dir, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
  });
  for (const id of [COMPANION, ROLE_B]) {
    if (!store.registry.exists(id)) store.registry.create({ id, label: id, operationId: `rwr07-create-${id}` });
  }

  const books = LorebookStore.open(store);
  opts.seed?.(books);

  // 人设：per-character，写进该角色自己的 prompt 权威源（memory.prompt，CONTRACTS §2）。
  const persona = opts.persona ?? '你是Aika，一个简洁自然的桌面伙伴。';
  store.setPrompt({ characterId: opts.characterId, sessionId: 'rwr07', turnId: 'seed', generation: 1 } as TurnScope, persona);

  // 作者资料（作者散文；firstMessage 仅展示，不进 Context）
  const author = opts.author;
  const roleAuthor = author
    ? () => ({
        ...(author.scenario ? { scenario: author.scenario } : {}),
        ...(author.exampleDialogue ? { exampleDialogue: author.exampleDialogue } : {}),
        fieldRevision: 1,
      })
    : undefined;

  const lifecycle = new SqliteLifecycleMemoryPort(store, {
    context: {
      summaryLimit: 1000, inputTokenBudget: 6000, maxRecentMessages: 20, maxMemories: 5,
      // 真实计数：按字符估算，绝不用 0 让预算形同虚设。
      countTokens: (c: DialogueContext, text: string) =>
        Math.ceil([...JSON.stringify(c), ...text].length / 2),
      relevance: () => 0,
      lorebook: (scope, text, remaining) => books.select(scope.characterId as never, text, remaining),
      ...(roleAuthor ? { roleAuthor } : {}),
    },
    turn: {
      inputTokenBudget: 4000,
      countTokens: () => 0,
      provider: { plan: async (input: MemoryTurnInput) => noPlan(input) },
      maxSupplementaryPlans: 0,
    },
    summary: {
      inputTokenBudget: 4000, countTokens: () => 0, minMessages: 50, maxMessages: 100,
      provider: { summarize: async input => ({ scope: input.scope, text: '摘要', sourceVersions: [] }) },
    },
  }, { propose: async (_input: MemoryMaintenanceInput) => [] });

  const outcomes: string[] = [];
  const transport = new ProviderTransport();
  const provider = new JsonDialogueProvider(
    { endpoint: opts.endpoint, model: opts.model ?? 'muse-spark-1.3-contributor-free', apiKey: () => opts.apiKey, authorizer: recordingAuthorizer(outcomes) },
    transport,
  );

  const requests: DialogueRequest[] = [];
  const media = new MemoryMediaStore();
  // D1: the RUNNING role enters once, at composition. A caller that boots with a non-companion
  // effective selection passes it here; omitted keeps every existing companion trajectory unchanged.
  const port = new NextTurnPort({
    outputMode: 'text',
    perception: { perceive: async () => { throw new Error('perception unused (STT not in scope)'); } },
    dialogue: {
      reply: async (request, signal) => {
        requests.push(structuredClone(request));
        return provider.reply(request, signal);
      },
    },
    tts: { synthesize: async () => { throw new Error('tts unused (TTS not in scope)'); } },
    playback: { play: async () => {}, stop: async () => {} },
    memory: lifecycle,
    memoryLifecycle: lifecycle,
    mediaStore: {
      put: (scope, bytes, mime) => media.put(scope, bytes, mime),
      read: (scope, asset) => media.read(scope, asset),
      releaseScope: async () => {},
    },
  }, opts.characterId === COMPANION ? undefined : (opts.characterId as never));

  const events: TurnPortEvent[] = [];
  port.subscribe(event => events.push(event));

  const waitForTerminal = (scope: TurnScope, timeoutMs = 180000) =>
    new Promise<Extract<TurnPortEvent, { type: 'terminal' }>>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('turn did not reach a terminal in time')), timeoutMs);
      const seen = events.find(e => e.type === 'terminal' && e.scope.turnId === scope.turnId);
      const finish = (e: Extract<TurnPortEvent, { type: 'terminal' }>) => { clearTimeout(timer); unsub(); done(e); };
      if (seen) return finish(seen as Extract<TurnPortEvent, { type: 'terminal' }>);
      const unsub = port.subscribe(e => {
        if (e.type === 'terminal' && e.scope.turnId === scope.turnId) finish(e);
      });
    });

  return {
    requests, outcomes, books,
    submit: text => port.submit({ text }),
    waitForTerminal,
    cleanup: async () => { store.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

// ── AC-1 · 真实对话轮次走通 ────────────────────────────────────────────────────────
test('AC-1 真实 LLM：一次文本轮次走通生产链路并返回非空回复', { timeout: 240000 }, async t => {
  const config = await loadConfig();
  if (!config) return t.skip('RWR07_LLM_KEY 未配置；fixture 不能冒充真实模型对话');
  const chain = await makeChain({ characterId: COMPANION, ...config });
  try {
    const scope = await chain.submit('请用一句话打个招呼，并说出一个只属于你的口头禅。');
    const terminal = await chain.waitForTerminal(scope);
    assert.equal(terminal.status, 'completed', `terminal=${JSON.stringify(terminal)}`);
    assert.ok((terminal.replyText ?? '').length > 0, '真实回复必须非空');
    assert.ok(chain.outcomes.includes('success'), `authorizer outcomes=${chain.outcomes.join(',')}`);
    assert.equal(chain.requests.length, 1, '一次提交只产生一次 provider 请求');
    console.log(`[AC-1] reply=${JSON.stringify(terminal.replyText)}`);
  } finally {
    await chain.cleanup();
  }
});

// ── AC-2 · Lorebook / 作者资料真的进入提示；firstMessage 不进 ────────────────────────
test('AC-2 真实 LLM：Lorebook 与作者资料进入 provider 提示，且 firstMessage 不在其中', { timeout: 240000 }, async t => {
  const config = await loadConfig();
  if (!config) return t.skip('RWR07_LLM_KEY 未配置');
  const MARKER_SCENARIO = '星港七号是一座漂浮在云海之上的观测站。';
  const MARKER_LORE = '观测站的猫头鹰信使叫咕咕。';
  const MARKER_FIRST = '你好，我是星港的守望者，今晚也一起看云海吧。';
  const chain = await makeChain({
    characterId: COMPANION,
    ...config,
    persona: '你是星港七号的守望者。',
    author: { scenario: MARKER_SCENARIO, exampleDialogue: '用户：今晚云海好看吗？\n守望者：比昨夜更亮一些。', firstMessage: MARKER_FIRST },
    seed: books => {
      const book = books.create(COMPANION as never, '星港设定');
      books.addEntry(book.id, COMPANION as never, { title: '信使', content: MARKER_LORE, strategy: 'always' });
    },
  });
  try {
    const scope = await chain.submit('今晚的云海怎么样？');
    const terminal = await chain.waitForTerminal(scope);
    assert.equal(terminal.status, 'completed', `terminal=${JSON.stringify(terminal)}`);

    const request = chain.requests[0]!;
    // Context 侧：Lorebook 选择真的发生，并带作者虚构标记
    assert.ok(request.context.lorebook, 'Context 必须携带 Lorebook 选择');
    assert.equal(request.context.lorebook!.authoredFiction, true, 'Lorebook 必须标记为作者虚构');
    assert.equal(request.context.lorebook!.refs.length, 1, 'always 条目必须被选中');
    assert.match(request.context.lorebook!.text, /作者设定（虚构，非用户事实）/, 'Lorebook 文本必须带「作者所写，非用户事实」标签');
    assert.match(request.context.lorebook!.text, /咕咕/);

    // 作者资料：scenario/exampleDialogue 进 Context；firstMessage 永不在
    assert.equal(request.context.roleAuthor?.scenario, MARKER_SCENARIO, 'scenario 必须进入 Context');
    assert.ok(request.context.roleAuthor?.exampleDialogue, 'exampleDialogue 必须进入 Context');
    assert.ok(!('firstMessage' in (request.context.roleAuthor ?? {})), 'firstMessage 不得进入 Context（CONTRACTS §5）');

    // Provider 侧：真正拼进请求体的提示词（这是"有没有进提示"的直接证据）
    // 抓真实出站 body：重放一次同样的请求捕获不方便，这里改为直接断言 provider 组装函数的结果——
    // 通过再次调用 provider 并检查它抛错前/后的 messages 不便获取，故用 transport 注入捕获。
    console.log(`[AC-2] lorebookTokens=${request.context.lorebook!.tokens} roleAuthorScenario=${!!request.context.roleAuthor?.scenario}`);
  } finally {
    await chain.cleanup();
  }
});

// ── AC-2b · 真实出站提示词（body 级证据）────────────────────────────────────────────
test('AC-2b 真实 LLM：出站请求体真的包含人设/Lorebook/作者资料块', { timeout: 240000 }, async t => {
  const config = await loadConfig();
  if (!config) return t.skip('RWR07_LLM_KEY 未配置');
  const PERSONA = '你是星港七号的守望者，说话简短。';
  const SCENARIO = '星港七号是云海之上的观测站。';
  const LORE = '观测站的猫头鹰信使叫咕咕。';
  const FIRST = '你好，我是星港的守望者，今晚也一起看云海吧。';

  const dir = await mkdtemp(join(tmpdir(), 'rwr07-body-'));
  const store = new SqliteMemoryStore({
    filename: join(dir, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
  });
  if (!store.registry.exists(COMPANION)) store.registry.create({ id: COMPANION, label: COMPANION, operationId: 'rwr07-body' });
  const books = LorebookStore.open(store);
  const book = books.create(COMPANION as never, '星港设定');
  books.addEntry(book.id, COMPANION as never, { title: '信使', content: LORE, strategy: 'always' });

  let captured: string | null = null;
  const outcomes: string[] = [];
  try {
    // 唯一替换点：注入一个"透传 + 记录 body"的 fetch，其余全部是生产 transport 代码。
    const transport = new ProviderTransport(async (url, init) => {
      captured = String(init?.body ?? '');
      const response = await fetch(url as string, init as RequestInit);
      return response;
    });
    const provider = new JsonDialogueProvider(
      { endpoint: config.endpoint, model: config.model, apiKey: () => config.apiKey, authorizer: recordingAuthorizer(outcomes) },
      transport,
    );
    const context: DialogueContext = {
      scope: { characterId: COMPANION, sessionId: 's1', turnId: 't1', generation: 1 },
      characterPrompt: characterPrompt(COMPANION as never, { companion: PERSONA }),
      recent: [{ characterId: COMPANION, id: 't1:user', role: 'user', text: '云海怎么样？', createdAt: new Date().toISOString() }],
      summary: '', memories: [], perception: null, inputTokenBudget: 6000,
      lorebook: books.select(COMPANION as never, '云海怎么样？', 2048),
      roleAuthor: { scenario: SCENARIO, exampleDialogue: '用户：好看吗？\n守望者：比昨夜亮。', fieldRevision: 1, firstMessage: FIRST } as never,
    } as DialogueContext;
    const reply = await provider.reply({ scope: context.scope, text: '云海怎么样？', context }, new AbortController().signal);
    assert.ok(reply.text.length > 0, '真实回复必须非空');

    const body = captured ?? '';
    assert.ok(body.length > 0, '必须捕获到真实出站请求体');
    assert.match(body, /云海之上的观测站/, '出站提示必须包含作者情境设定');
    assert.match(body, /猫头鹰信使叫咕咕/, '出站提示必须包含 Lorebook 正文');
    assert.match(body, /作者设定（虚构，非用户事实）/i, '出站 Lorebook 必须带「作者所写，非用户事实」标签');
    assert.match(body, /情境设定（作者所写，非用户事实）/, '出站作者资料必须带作者标签而非用户事实');
    // firstMessage 是"仅展示"，绝不能出现在任何出站提示里
    assert.doesNotMatch(body, /今晚也一起看云海吧/, 'firstMessage 不得进入出站提示（CONTRACTS §5 仅展示）');
    assert.doesNotMatch(body, /ofm-/, 'Bearer 凭据不得出现在请求体');
    console.log(`[AC-2b] bodyBytes=${Buffer.byteLength(body, 'utf8')} reply=${JSON.stringify(reply.text.slice(0, 80))}`);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── AC-3 · 角色作用域：A 的 Lorebook 不进 B ─────────────────────────────────────────
//
// AC-3a（store 层）：LorebookStore 按 ownerCharacterId 过滤 —— companion 的书在 role-b 的 select() 里不可见。
// AC-3b（运行层）：构造时传入运行角色后，以 role-b 发起的轮次真正以 role-b 运行（D1 落地；修复前
//   TurnController 把 characterId 硬编码为 COMPANION_ID，任何"以 role-b 运行一轮"的尝试实际上仍然以
//   companion 身份执行 —— 该缺陷已由本轮修复，见 AC-3b）。
test('AC-3a Lorebook 存储层：companion 的书对 role-b 不可见（per-character 生效）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rwr07-scope-'));
  const store = new SqliteMemoryStore({
    filename: join(dir, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
  });
  try {
    for (const id of [COMPANION, ROLE_B]) {
      if (!store.registry.exists(id)) store.registry.create({ id, label: id, operationId: `rwr07-scope-${id}` });
    }
    const books = LorebookStore.open(store);
    const book = books.create(COMPANION as never, '星港设定');
    books.addEntry(book.id, COMPANION as never, { title: '信使', content: '星港的猫头鹰信使叫咕咕。', strategy: 'always' });

    assert.equal(books.list(ROLE_B as never).length, 0, 'role-b 不应看到任何书');
    assert.equal(books.get(book.id, ROLE_B as never), null, 'companion 的书对 role-b 应为 not_found');
    const selectionB = books.select(ROLE_B as never, '任意输入', 4096);
    assert.equal(selectionB.refs.length, 0, 'role-b 的 select 不得选中 companion 的条目');
    assert.doesNotMatch(selectionB.text, /咕咕/, 'companion 的正文不得进入 role-b 的选择');
    const selectionA = books.select(COMPANION as never, '任意输入', 4096);
    assert.equal(selectionA.refs.length, 1, 'companion 自己仍应选中（控制组：不是"全都不选"）');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── AC-3b · 运行层：第二角色可以作为运行角色启动（D1 落地）────────────────────────────
//
// D1 承诺「同一桌宠进程只运行一个 active character，切换在重启时生效」。TurnController 与 NextTurnPort
// 的运行角色在组合时一次性指定（turn-controller.ts / turn-port.ts 注释）：默认 companion；
// 启动装配点传入 registry 的 effectiveCharacterId 时，turn 就以该角色运行。
// 本用例构造一个 role-b 的 NextTurnPort 并验证轮次 scope、上下文与记忆都落在 role-b —— 与此同时
// companion 的轮次不受影响（仍是默认行为，对照 AC-1）。
test('AC-3b 运行层：以 role-b 发起的轮次真正以 role-b 运行，companion 轮次仍默认', { timeout: 240000 }, async t => {
  const config = await loadConfig();
  if (!config) return t.skip('RWR07_LLM_KEY 未配置');
  const MARKER_B = 'role-b 的私有标记：潮汐灯塔的守夜人。';
  const chain = await makeChain({
    characterId: ROLE_B,
    ...config,
    persona: '你是潮汐灯塔的守夜人，说话简短。',
    seed: books => {
      const own = books.create(ROLE_B as never, '灯塔设定');
      books.addEntry(own.id, ROLE_B as never, { title: '守夜', content: MARKER_B, strategy: 'always' });
      const other = books.create(COMPANION as never, '星港设定');
      books.addEntry(other.id, COMPANION as never, { title: '信使', content: '星港的猫头鹰信使叫咕咕。', strategy: 'always' });
    },
  });
  try {
    const scope = await chain.submit('今晚的灯塔怎么样？');
    const terminal = await chain.waitForTerminal(scope);
    assert.equal(terminal.status, 'completed', `terminal=${JSON.stringify(terminal)}`);
    assert.ok((terminal.replyText ?? '').length > 0, 'role-b 的真实回复必须非空');

    // 1. 轮次 scope 就是 role-b —— 不再是硬编码 companion。
    const request = chain.requests[0]!;
    assert.equal(request.scope.characterId, ROLE_B, '轮次必须以请求的角色运行');
    assert.equal(request.context.scope.characterId, ROLE_B);

    // 2. Context 侧：选中 role-b 自己的 Lorebook（含私有标记），不含 companion 的书。
    assert.ok(request.context.lorebook, 'Context 必须携带 Lorebook 选择');
    assert.equal(request.context.lorebook!.refs.length, 1, '只能选中 role-b 自己的那一条');
    assert.match(request.context.lorebook!.text, /潮汐灯塔/, 'role-b 的正文必须进入选择');
    assert.doesNotMatch(request.context.lorebook!.text, /咕咕/, 'companion 的正文不得进入 role-b 的轮次');

    // 3. 同一进程里默认行为不变：另一个 chain 不传角色，仍以 companion 运行（对照，证明单 active、互不干扰）。
    const companionChain = await makeChain({ characterId: COMPANION, ...config });
    try {
      const cScope = await companionChain.submit('打个招呼。');
      const cTerminal = await companionChain.waitForTerminal(cScope);
      assert.equal(cTerminal.status, 'completed');
      assert.equal(companionChain.requests[0]!.scope.characterId, COMPANION, '默认 chain 仍以 companion 运行');
    } finally {
      await companionChain.cleanup();
    }
    console.log(`[AC-3b] role-b turn=${request.scope.turnId} reply=${JSON.stringify((terminal.replyText ?? '').slice(0, 60))}`);
  } finally {
    await chain.cleanup();
  }
});

// ── AC-4 · 错误路径必须明确失败，无 silent fallback ─────────────────────────────────
test('AC-4a 模型缺失：端点返回错误时轮次必须 failed，不得回成功', { timeout: 240000 }, async t => {
  const config = await loadConfig();
  if (!config) return t.skip('RWR07_LLM_KEY 未配置');
  // 真实端点 + 一个不存在的模型 → 真实拒绝，必须显式失败
  const chain = await makeChain({ characterId: COMPANION, ...config, model: 'definitely-not-a-real-model-rwr07' });
  try {
    const scope = await chain.submit('你好。');
    const terminal = await chain.waitForTerminal(scope);
    assert.equal(terminal.status, 'failed', `模型缺失必须显式失败，实际=${JSON.stringify(terminal)}`);
    assert.ok(chain.outcomes.includes('failed') || chain.outcomes.includes('cancelled'),
      `预算结算必须记录失败而非成功：${chain.outcomes.join(',')}`);
    assert.ok(!chain.outcomes.includes('success'), '失败请求不得结算为 success');
    console.log(`[AC-4a] errorCode=${terminal.errorCode} outcomes=${chain.outcomes.join(',')}`);
  } finally {
    await chain.cleanup();
  }
});

test('AC-4b 端点拒绝：不可达端口必须显式失败且无静默降级', { timeout: 120000 }, async t => {
  const config = await loadConfig();
  if (!config) return t.skip('RWR07_LLM_KEY 未配置');
  const chain = await makeChain({
    characterId: COMPANION, apiKey: config.apiKey, model: config.model,
    endpoint: 'https://127.0.0.1:1/v1/chat/completions', // 无监听
  });
  try {
    const scope = await chain.submit('你好。');
    const terminal = await chain.waitForTerminal(scope, 60000);
    assert.equal(terminal.status, 'failed', `端点拒绝必须显式失败，实际=${JSON.stringify(terminal)}`);
    assert.ok(!chain.outcomes.includes('success'), '不得把失败的调用结算为 success');
    console.log(`[AC-4b] errorCode=${terminal.errorCode}`);
  } finally {
    await chain.cleanup();
  }
});

test('AC-4c 畸形响应：非 JSON 正文必须抛错，不得当作成功回复', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rwr07-malformed-'));
  const store = new SqliteMemoryStore({
    filename: join(dir, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
  });
  try {
    if (!store.registry.exists(COMPANION)) store.registry.create({ id: COMPANION, label: COMPANION, operationId: 'rwr07-malformed' });
    const transport = new ProviderTransport(async () => new Response('这不是 JSON', { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new JsonDialogueProvider(
      { endpoint: 'https://127.0.0.1:18443/v1/chat/completions', model: 'm', apiKey: () => 'k', authorizer: recordingAuthorizer([]) },
      transport,
    );
    const context: DialogueContext = {
      scope: { characterId: COMPANION, sessionId: 's', turnId: 't', generation: 1 },
      characterPrompt: '你是Aika。', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 6000,
    } as DialogueContext;
    await assert.rejects(
      provider.reply({ scope: context.scope, text: '你好', context }, new AbortController().signal),
      '畸形响应必须抛错，不能静默回一个空/假成功',
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('AC-4d 缺少凭据：apiKey 为空时 transport 必须拒绝，不得无鉴权发出请求', async t => {
  const transport = new ProviderTransport(async () => { throw new Error('must not reach the network'); });
  await assert.rejects(
    transport.request(
      { endpoint: 'https://127.0.0.1:18443/v1/chat/completions', model: 'm', apiKey: () => '', authorizer: recordingAuthorizer([]) },
      { characterId: COMPANION, sessionId: 's', turnId: 't', generation: 1 }, 'dialogue', { messages: [] }, new AbortController().signal,
    ),
    /API key|凭据|key/i,
    '空凭据必须显式失败（不得无鉴权调用或静默成功）',
  );
});

test('AC-4e 非 HTTPS 端点：生产 transport 必须拒绝（不得悄悄放行明文）', async t => {
  const transport = new ProviderTransport(async () => { throw new Error('must not reach the network'); });
  await assert.rejects(
    transport.request(
      { endpoint: 'http://127.0.0.1:18899/v1/chat/completions', model: 'm', apiKey: () => 'k', authorizer: recordingAuthorizer([]) },
      { characterId: COMPANION, sessionId: 's', turnId: 't', generation: 1 }, 'dialogue', { messages: [] }, new AbortController().signal,
    ),
    /HTTPS/,
    'ProviderTransport 必须强制 HTTPS（transport.ts:56），不得为指向本地反代而放宽',
  );
});

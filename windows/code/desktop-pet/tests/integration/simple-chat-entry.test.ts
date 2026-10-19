/**
 * 简单聊天入口回归：桌宠文字入口不再经过任务分类链。
 *
 * 覆盖两点，缺一不可：
 * 1. 所有输入（含「你好」）都直接进 LLM，不调用分类器、不建任务草稿、不转发执行。
 * 2. 「直连」不等于「裸调」：上下文照常装配——近期对话、召回的记忆/知识库条目、
 *    角色提示词都要真的喂给模型，不能被一起摘掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopEvent, DialogueRequest, MemoryReference, TurnScope } from '../../contracts/index.js';
import { DesktopRuntime, type RuntimePorts } from '../../core/desktop-runtime.js';
import { MemoryMediaStore } from '../../media/store.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** 合成召回条目：模拟知识库/Wiki/长期记忆真正检索到的内容。 */
const RECALLED: readonly MemoryReference[] = [
  { characterId: 'companion', id: 'm1', version: 1, text: '用户喜欢的乐队是 Yoasobi', sourceIds: [] },
];

function harness(options: { workHandled?: boolean } = {}) {
  const events: DesktopEvent[] = [];
  const mediaStore = new MemoryMediaStore();
  let classifyCalls = 0;
  const requests: DialogueRequest[] = [];
  const ports: RuntimePorts = {
    mediaStore,
    capture: {
      async start() {}, async stop() {},
      async finish(scope) { return { scope, audio: await mediaStore.put(scope, Uint8Array.of(1), 'audio/wav'), images: [], inputEndedAt: new Date().toISOString(), captureStoppedAt: new Date().toISOString() }; },
    },
    perception: { async perceive(input) { return { scope: input.scope, transcript: '语音输入', modalities: [], cues: [], status: 'complete' }; } },
    memory: {
      async append() {}, async maintain() { return []; },
      async context(scope: TurnScope) {
        return {
          scope, characterPrompt: '你是青梅竹马 Aika',
          recent: [{ characterId: scope.characterId, id: 'prev:user', role: 'user' as const, text: '上一轮我说过的话', createdAt: '2026-10-10T00:00:00.000Z' }],
          summary: '', memories: RECALLED, perception: null, inputTokenBudget: 4000,
        };
      },
    },
    dialogue: {
      async reply(request: DialogueRequest) {
        requests.push(request);
        return { scope: request.scope, text: '你好呀，我在。', expression: { emotion: 'calm', intensity: 0.4, delivery: '自然', gesture: null } };
      },
    },
    tts: { async synthesize(input) { return { ...input, audio: await mediaStore.put(input.scope, Uint8Array.of(1), 'audio/wav'), durationMs: 1, synchronization: 'amplitude' as const }; } },
    playback: { async stop() {}, async play(input, emit) { emit({ scope: input.scope, at: new Date().toISOString(), type: 'started', audioId: input.audio.id, timingBasis: 'device_observed' as const }); emit({ scope: input.scope, at: new Date().toISOString(), type: 'ended' }); } },
  };
  const runtime = new DesktopRuntime(ports, event => events.push(event));
  // 对照：显式挂上「一律按任务处理」的 work 端口时，聊天确实会被拦截（回归基线）。
  if (options.workHandled) {
    runtime.attachWork({
      async route() { classifyCalls++; return 'handled'; },
      async action() {}, onInput() {}, async close() {},
    });
  }
  return { runtime, events, requests, mediaStore, classify: () => classifyCalls };
}

test('未挂载 work 时，「你好」直接进 LLM 且不产生任何任务路由调用', async () => {
  const h = harness();
  await h.runtime.dispatch({ type: 'submit_text', text: '你好' });
  await h.runtime.drain();

  assert.equal(h.classify(), 0, '分类器不应被前置调用');
  assert.equal(h.requests.length, 1, '应当只有一次聊天生成调用');
  assert.equal(h.requests[0]!.text, '你好', '传入模型的必须是用户真实文字，不是固定回复');
  assert.equal(h.requests[0]!.context.characterPrompt, '你是青梅竹马 Aika');
  const reply = h.events.find(e => e.type === 'reply');
  assert.ok(reply && reply.type === 'reply', '应当发出真实的助手文字回复');
  assert.equal(reply.reply.text, '你好呀，我在。');
  assert.equal(h.mediaStore.count, 0);
});

test('直连不等于裸调：召回的记忆/知识库条目与近期上下文照常进入模型请求', async () => {
  const h = harness();
  await h.runtime.dispatch({ type: 'submit_text', text: '帮我分析这段话' });
  await h.runtime.drain();

  const request = h.requests.at(-1)!;
  assert.deepEqual(request.context.memories, RECALLED, '召回条目必须随请求发给模型');
  assert.equal(request.context.recent.length, 1, '近期对话历史要保留');
  assert.equal(request.context.recent[0]!.text, '上一轮我说过的话');
  assert.ok(request.context.inputTokenBudget > 0, '预算仍然由上下文装配给出');
});

test('连续两轮：第二轮带着第一轮的近期历史，且不重复追加当前用户消息', async () => {
  const h = harness();
  await h.runtime.dispatch({ type: 'submit_text', text: '第一句' });
  await h.runtime.drain();
  await h.runtime.dispatch({ type: 'submit_text', text: '第二句' });
  await h.runtime.drain();

  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1]!.text, '第二句');
  // 当前这条用户消息由管线在 append 之后装配，上下文里的 recent 不应重复包含它。
  const currentInRecent = h.requests[1]!.context.recent.filter(message => message.text === '第二句');
  assert.equal(currentInRecent.length, 0, '当前用户消息不得在上下文中重复出现');
});

test('对照基线：一旦挂载 work 且路由为 handled，聊天仍会被拦截（证明修复点在挂载而非管线）', async () => {
  const h = harness({ workHandled: true });
  await h.runtime.dispatch({ type: 'submit_text', text: '你好' });
  await h.runtime.drain();

  assert.equal(h.classify(), 1, '对照：挂载后确实会走分类');
  assert.equal(h.requests.length, 0, '对照：被任务路由拦截时不会生成聊天回复');
});

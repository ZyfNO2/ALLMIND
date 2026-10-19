/**
 * tests/companion-knowledge/observation-admission.test.ts
 *
 * CK-12 (GAP-06): the internal observation admission entry.
 *
 * The property under test is the reason this entry exists: the periodic path already captured and
 * recognised a frame, so admitting that result must not capture a second time. A second capture
 * would double the resource cost AND could observe something different from what was evaluated.
 *
 * Second property: this entry is internal. It must be unreachable with a fabricated observation or
 * an out-of-scope session, so no client surface can inject material that was never captured.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionTriggerRuntime } from '../../management/companion-trigger-runtime.js';
import type { CompanionModeRuntime, CompanionTriggerRecord } from '../../core/companion-mode-runtime.js';
import type { ScreenGrantRuntime } from '../../management/screen-grant-runtime.js';

const PAIRING = { userId: 'u', characterId: 'companion', characterInstanceId: 'inst-gap06' };
const IDENTITY = { characterId: 'companion', sessionId: 's-1', generation: 3 };

/** A mode runtime stand-in that records every transition and enforces the state machine loosely. */
function modeRuntime() {
  const records = new Map<string, CompanionTriggerRecord>();
  const byOperation = new Map<string, string>();
  const transitions: { status: string; reason?: string }[] = [];
  let counter = 0;
  const port = {
    recoverInterruptedCompanionTriggers: () => {},
    // Keyed by the operation-derived trigger id, which is how the real owner resolves a replay.
    getCompanionTrigger: (triggerId: string) => records.get(triggerId) ?? null,
    registerCompanionTrigger: (input: { operationId: string; kind: 'screen' | 'greeting'; outcome: string; reason?: string; runtimeSessionId: string; generation: number }) => {
      counter += 1;
      const triggerId = `rwr10-trigger-${Buffer.from(input.operationId, 'utf8').toString('base64url')}`;
      const record = {
        triggerId, operationId: input.operationId, kind: input.kind,
        outcome: input.outcome, status: 'accepted', runtimeSessionId: input.runtimeSessionId,
        generation: input.generation, ...(input.reason ? { reason: input.reason } : {}),
      } as unknown as CompanionTriggerRecord;
      records.set(triggerId, record);
      byOperation.set(input.operationId, triggerId);
      return record;
    },
    transitionCompanionTrigger: (input: { triggerId: string; status: string; reason?: string; observationId?: string; turnScope?: unknown }) => {
      transitions.push({ status: input.status, ...(input.reason ? { reason: input.reason } : {}) });
      const prior = records.get(input.triggerId)!;
      const next = { ...prior, status: input.status, ...(input.reason ? { reason: input.reason } : {}) } as unknown as CompanionTriggerRecord;
      records.set(input.triggerId, next);
      return next;
    },
    getContextUseGrant: () => null,
  };
  return { port: port as unknown as CompanionModeRuntime, transitions, records, byOperation };
}

function screenGrants(options: { targetId?: string; revision?: number; grantId?: string | null } = {}) {
  const targetId = options.targetId ?? 'display-1';
  const revision = options.revision ?? 1;
  return {
    triggerReadiness: () => ({
      targetSelected: true, grantId: options.grantId === undefined ? 'g-1' : options.grantId,
      capture: true, localOcr: true, cloudVlm: false,
      target: { targetId, targetRevision: revision, kind: 'screen' as const, displayName: '主显示器',
        bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 },
    }),
  } as unknown as ScreenGrantRuntime;
}

function runtime(options: {
  requireContextGrant?: boolean;
  dispatched?: string[];
  captures?: number;
  grants?: Parameters<typeof screenGrants>[0];
} = {}) {
  const mode = modeRuntime();
  const dispatched = options.dispatched ?? [];
  const port = new CompanionTriggerRuntime({
    pairing: PAIRING,
    mode: mode.port,
    screenGrants: screenGrants(options.grants),
    perception: { processCapture: async () => { options.captures = (options.captures ?? 0) + 1; return { observationId: 'obs-x' }; } } as never,
    session: {
      identity: () => IDENTITY,
      readiness: () => ({ ready: true }),
      dispatch: async (triggerId: string, observationId: string) => { dispatched.push(observationId); },
      cancel: async () => true,
    },
    requiresContextUseGrant: options.requireContextGrant ?? false,
    dialogueModelBinding: 'm',
    now: () => 1_000,
  });
  return { port, mode, dispatched };
}

const admitInput = {
  operationId: 'adm-1', observationId: 'obs-1', targetId: 'display-1', targetRevision: 1,
  text: '识别出的屏幕文本内容。',
  sourceLease: { grantId: 'g-1', grantRevision: 1 },
  scope: { characterId: 'companion', sessionId: 's-1', generation: 3 },
};

// ================================================================================================
// The core property: one capture, straight to generating
// ================================================================================================

test('GAP-06: 已识别的观察直接进入 generating，不再二次捕获', async () => {
  let captures = 0;
  const { port, mode, dispatched } = runtime({ dispatched: [], captures });
  const receipt = await port.admitObservation(admitInput);

  assert.equal(receipt.outcome, 'accepted');
  assert.equal(receipt.status, 'generating', '必须直接到 generating');
  // The critical assertion: no capture happened inside this path.
  const statuses = mode.transitions.map(t => t.status);
  assert.deepEqual(statuses, ['recognized', 'generating'], '不得出现 captured 阶段（那意味着二次捕获）');
  assert.equal(statuses.includes('captured'), false);
  assert.deepEqual(dispatched, ['obs-1'], '用上游已完成的 observationId 派发');
  void captures;
});

test('GAP-06: 通过 MCP 重放同一 operationId 不会二次派发', async () => {
  const { port, dispatched } = runtime({ dispatched: [] });
  const first = await port.admitObservation(admitInput);
  const replay = await port.admitObservation(admitInput);
  assert.equal(replay.triggerId, first.triggerId, '重放命中同一 trigger');
  assert.deepEqual(dispatched, ['obs-1'], '重放不得二次派发');
});

// ================================================================================================
// Internal-only: no client can inject material
// ================================================================================================

test('GAP-06: 跨 session/generation 的观察被拒绝（浏览器无法伪造）', async () => {
  const { port } = runtime();
  await assert.rejects(port.admitObservation({ ...admitInput, scope: { ...admitInput.scope, sessionId: 'other-session' } }),
    /does not belong to the active session/);
  await assert.rejects(port.admitObservation({ ...admitInput, scope: { ...admitInput.scope, generation: 99 } }),
    /does not belong to the active session/);
  await assert.rejects(port.admitObservation({ ...admitInput, scope: { ...admitInput.scope, characterId: 'sweetheart' } }),
    /does not belong to the active session/);
});

test('GAP-06: 目标不符的观察被拒绝（不能拿别的目标的结果顶替）', async () => {
  const { port } = runtime();
  await assert.rejects(port.admitObservation({ ...admitInput, targetId: 'display-9' }),
    /not the active target/);
  await assert.rejects(port.admitObservation({ ...admitInput, targetRevision: 7 }),
    /not the active target/);
});

test('GAP-06: 非法 operationId 被拒绝', async () => {
  const { port } = runtime();
  await assert.rejects(port.admitObservation({ ...admitInput, operationId: '' }), /Invalid admit operation id/);
  await assert.rejects(port.admitObservation({ ...admitInput, operationId: 'x'.repeat(300) }), /Invalid admit operation id/);
});

// ================================================================================================
// No-content and authorization boundaries
// ================================================================================================

test('GAP-06: 空文本是 no-content，不是一次投递', async () => {
  const { port, mode, dispatched } = runtime({ dispatched: [] });
  const receipt = await port.admitObservation({ ...admitInput, text: '   ' });
  assert.equal(receipt.status, 'no-content');
  assert.equal(mode.transitions.at(-1)?.status, 'no-content');
  assert.deepEqual(dispatched, [], '无内容不得派发');
});

test('GAP-06: 需要 context grant 而缺失时失败，不派发', async () => {
  const { port, dispatched } = runtime({ requireContextGrant: true, dispatched: [] });
  const receipt = await port.admitObservation(admitInput);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.reason, 'context_use_grant_required');
  assert.deepEqual(dispatched, [], '未授权不得派发');
});

test('GAP-06: 派发失败转入 failed，不留半成品', async () => {
  const mode = modeRuntime();
  const port = new CompanionTriggerRuntime({
    pairing: PAIRING, mode: mode.port, screenGrants: screenGrants(),
    perception: {} as never,
    session: {
      identity: () => IDENTITY,
      readiness: () => ({ ready: true }),
      dispatch: async () => { throw new Error('renderer_disconnected'); },
      cancel: async () => true,
    },
    requiresContextUseGrant: false, dialogueModelBinding: 'm', now: () => 1_000,
  });
  const receipt = await port.admitObservation(admitInput);
  assert.equal(receipt.status, 'generating', '派发是异步的；立即回执为 generating');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(mode.transitions.at(-1)?.status, 'failed', '派发失败后必须转 failed');
});
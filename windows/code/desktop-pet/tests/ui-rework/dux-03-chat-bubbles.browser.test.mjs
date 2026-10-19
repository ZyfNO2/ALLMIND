/**
 * DUX-03 · Playground 即时气泡与持续等待。
 *
 * 失败证据（DUX-00 矩阵第 3 行）：旧 Chat.tsx 在 `await submitTurn` 返回**之后**才 setMessages，
 * HTTP 延迟期间既没有用户气泡也没有助手占位，等待形态是整页黄色 Notice 长条。
 *
 * 目标（[DUX-03 SPEC](../../docs/next/ui-rework/specs/DUX-03.md) / [DUX_CONTRACTS §3](../../docs/next/ui-rework/DUX_CONTRACTS.md)）：
 *   1. 点击发送**立即**出现右侧用户气泡（submitting）+ 左侧助手占位（等待动画），输入清空；
 *   2. HTTP 返回 running 后占位持续（不消失、不重复气泡），持续轮询；
 *   3. completed 填充原占位（只有一条回复）；重复回执/乱序不复制气泡；
 *   4. 提交异常（网络失败）保留输入与操作意图，可重试；
 *   5. 整页黄色等待长条移除。
 *
 * 组合根：真实 management server（角色工作区 React SPA）+ 注入**受控延迟的 stub turn port**
 * （外部模型按授权允许隔离 stub；被测对象是 Chat 前端状态机与真实 HTTP 往返）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { roleConsoleFixture } from '../management/role-console-fixture.mjs';

/** 受控延迟的 PlaygroundManagementPort stub：外部模型隔离物；submit 可挂起、可排程终态。 */
function delayedTurnPort() {
  const turns = new Map();
  let submitCalls = 0;
  const port = {
    session() {
      return { pairing: { userId: 'trial-user', characterId: 'companion', characterInstanceId: 'inst-01' },
        sessionId: 'session-dux03', capabilities: { canSubmitText: true, canCancel: true, hasStt: false, hasTts: false },
        effectiveConfigRevision: 1, status: 'idle' };
    },
    async submitTurn(input) {
      submitCalls++;
      const turnId = `turn-${input.operationId}`;
      const turn = { turnId, operationId: input.operationId, status: 'running', text: input.text, reply: '', traceRef: `trace-${turnId}`, startedAt: new Date().toISOString() };
      turns.set(turnId, turn);
      // 延迟返回 running 回执：这段时间 UI 必须已经显示用户气泡与助手占位。
      await new Promise(done => setTimeout(done, 1200));
      return turn;
    },
    getTurn(turnId) { return turns.get(turnId) ? { ...turns.get(turnId) } : null; },
    async cancelTurn(turnId) { const turn = turns.get(turnId); if (turn) turn.status = 'cancelled'; return { cancelled: !!turn, turnId }; },
    /** 测试排程：把最近一轮推进到终态（前端经真实 GET 轮询看到）。 */
    complete(reply) { const turn = [...turns.values()].at(-1); if (turn) { turn.status = 'completed'; turn.reply = reply; turn.completedAt = new Date().toISOString(); } },
    stats() { return { submitCalls, size: turns.size }; },
  };
  return port;
}

async function openChat(page, server) {
  await page.goto(`${server.origin}/characters/companion/chat#token=${server.token}`);
  await expect(page.getByRole('heading', { name: '正式文字 Playground' })).toBeVisible({ timeout: 60000 });
}

test('DUX-03 发送立即出用户气泡与助手占位，等待持续到 completed 且不重复', { timeout: 240000 }, async t => {
  const port = delayedTurnPort();
  const f = await roleConsoleFixture(t, { playground: port });
  await mkdir(resolve('.local/reports/dux-03'), { recursive: true });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openChat(page, f.server);

  const input = page.getByPlaceholder('输入文字…');
  await input.fill('你好，今天过得怎么样？');
  const sendButton = page.getByRole('button', { name: '发送' });
  // HTTP 延迟（1200ms）期间：用户气泡与助手占位必须**立即**出现 —— 这是旧实现失败的时点。
  const submitPending = sendButton.click();
  await expect(page.getByText('你好，今天过得怎么样？')).toBeVisible({ timeout: 3000 });
  await expect(page.getByText('正在回复…')).toBeVisible({ timeout: 3000 });
  await expect(input).toHaveValue('', { timeout: 3000 });
  await page.screenshot({ path: resolve('.local/reports/dux-03/03-1-immediate-bubbles.png'), fullPage: true });
  // running 回执返回后占位仍在（不消失、不出现黄色整页长条）。
  await submitPending;
  await expect(page.getByText('正在回复…')).toBeVisible();
  assert.equal(await page.getByText(/正式轮次处理中/).count(), 0, '整页黄色等待长条必须移除');
  // stub 后端推进到 completed：前端经真实 GET 轮询取得，占位被唯一回复替换。
  port.complete('我很好，谢谢你关心。今天也很适合聊天。');
  await expect(page.getByText('我很好，谢谢你关心。今天也很适合聊天。')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('正在回复…')).toHaveCount(0);
  // 不重复：用户气泡 1 条、助手回复 1 条（重复轮询/迟到回执不复制）。
  assert.equal(await page.getByText('你好，今天过得怎么样？').count(), 1);
  assert.equal(await page.getByText('我很好，谢谢你关心。今天也很适合聊天。').count(), 1);
  assert.equal(port.stats().submitCalls, 1, '全程只提交一次');
  await page.screenshot({ path: resolve('.local/reports/dux-03/03-3-completed.png'), fullPage: true });
  assert.deepEqual(errors, []);
});

test('DUX-03 提交异常保留输入与意图，重试不再出现黄色长条且能完成', { timeout: 240000 }, async t => {
  // 注入一个总是抛错的 port：前端必须把失败显示在气泡区/错误提示，输入保留，不做假成功。
  const failing = {
    session() {
      return { pairing: { userId: 'trial-user', characterId: 'companion', characterInstanceId: 'inst-01' },
        sessionId: 'session-dux03b', capabilities: { canSubmitText: true, canCancel: false, hasStt: false, hasTts: false },
        effectiveConfigRevision: 1, status: 'idle' };
    },
    async submitTurn() { throw new Error('连接已断开，请检查网络'); },
    getTurn() { return null; },
    async cancelTurn() { return { cancelled: false }; },
  };
  const f = await roleConsoleFixture(t, { playground: failing });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openChat(page, f.server);
  const input = page.getByPlaceholder('输入文字…');
  await input.fill('这句话会失败');
  await page.getByRole('button', { name: '发送' }).click();
  // 失败可见：助手占位消失、无伪回答；服务端把内部错误净化为通用文案（既有安全行为），
  // 用户气泡文本保留且输入可再次使用。
  await expect(page.getByText('这句话会失败')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('这次管理操作未完成，原始内容和内部错误未对外输出。').first()).toBeVisible();
  assert.equal(await page.getByText('正在回复…').count(), 0, '失败后不得残留助手占位动画');
  await page.screenshot({ path: resolve('.local/reports/dux-03/03-4-submit-failure.png'), fullPage: true });
  await page.screenshot({ path: resolve('.local/reports/dux-03/03-4-submit-failure.png'), fullPage: true });
  assert.deepEqual(errors, []);
});

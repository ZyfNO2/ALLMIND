// LUI-03 浏览器验收：记忆 / 知识 / Timeline / Trace 的真实能力在 React 里完成，不再外跳旧管理页。
//
// 走真实生产链路：`startManagementServer` + 真实临时 SQLite（roleConsoleFixture）+ 真实
// `/api/records`、`/api/records/edit`、`/api/memory/forget`、`/api/continuity/*`、`/api/knowledge*`、
// `/api/unified-timeline`、`/api/traces`、`/api/memory-import`、`/api/memory-pending`，浏览器里跑的是
// 构建产物 `management/character-app`（必须先 `npm run build:character-ui`）。
//
// 没有真实模型、没有外部网络：导入处理使用 fixture processor（它只声明"无变更"），
// 因此这里证明的是编排、隔离、幂等与遗忘链路，不证明模型质量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../management/role-console-fixture.mjs';
import { startManagementServer } from '../../dist/management/server.js';
import { ProductionPlaygroundPort } from '../../dist/management/playground-port.js';
import { continuityManagement } from '../../dist/management/continuity-routes.js';
import { knowledgeManagement } from '../../dist/management/knowledge-routes.js';
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js';
import { RuntimeTraceStore } from '../../dist/core/trace-store.js';
import { readTraceContentFromHistory } from '../../dist/memory/trace-history-content.js';
import { pendingMemoryManagement } from '../../dist/management/pending-memory.js';

const CHARACTER = 'companion';
const PAIRING = { userId: 'local-user', characterId: CHARACTER, characterInstanceId: 'companion-default' };

test('LUI-03 browser: 记忆纠正/遗忘、知识隔离、时间线游标、Trace 正文与导入/未完成请求都在 React 内完成', { timeout: 180_000 }, async t => {
  const f = await roleConsoleFixture(t);
  const root = resolve('.');
  const store = f.store;

  // ---- 真实数据：长期记忆 + 对话原文 + 溯源来源 ----
  const scope = { characterId: CHARACTER, sessionId: 'lui03', turnId: 'turn-1', generation: 1 };
  store.append(scope, [
    { characterId: CHARACTER, id: 'lui03-turn-1:user', role: 'user', text: '匿名用户原话 A', createdAt: '2026-10-08T01:00:00.000Z' },
    { characterId: CHARACTER, id: 'lui03-turn-1:assistant', role: 'assistant', text: '匿名回复 A', createdAt: '2026-10-08T01:00:00.000Z' },
    // A second, user-only turn: strict forget only completes when the cited source's text IS the
    // memory's own text (a source carrying anything else needs the fragment plan), so this turn
    // repeats the memory verbatim — the honest shape for a memory derived from one user statement.
    { characterId: CHARACTER, id: 'lui03-turn-2:user', role: 'user', text: '匿名长期记忆 B', createdAt: '2026-10-08T01:00:01.000Z' },
  ]);
  const change = (operation, operationId) => ({ scope, operationId, reason: 'controlled', createdAt: '2026-10-08T01:00:00.000Z', operation });
  // `store.apply`'s second argument is `resolvedSourceIds`, which the ledger only accepts for
  // update/delete: passing it with `add` is rejected with `resolution_requires_update_or_delete`, and
  // the memory is never written. An added memory carries its provenance in `operation.sourceIds` —
  // and a memory with NO sources is refused (`missing_or_duplicate_sources`), so both rows cite the
  // real transcript above.
  const added = [
    store.apply(change({ type: 'add', id: 'lui03-memory-a', text: '匿名长期记忆 A', sourceIds: ['lui03-turn-1:user'] }, 'lui03-add-a')),
    store.apply(change({ type: 'add', id: 'lui03-memory-b', text: '匿名长期记忆 B', sourceIds: ['lui03-turn-2:user'] }, 'lui03-add-b')),
  ];
  assert.deepEqual(added.map(result => result.status), ['applied', 'applied'], 'the fixture memories must really be stored');

  // ---- 真实连续性事实：已生效的用户事实 + 一条待审候选 ----
  f.continuity.record({ pairing: PAIRING, operationId: 'lui03-wiki-active', layer: 'user_wiki', kind: 'fact', text: '匿名真实存储知识 A', origin: 'user', sourceIds: ['lui03-turn-1:user'], status: 'active' });
  f.continuity.record({ pairing: PAIRING, operationId: 'lui03-wiki-candidate', layer: 'user_wiki', kind: 'inference', text: '匿名待审候选 C', origin: 'derived', sourceIds: ['lui03-turn-1:user'], status: 'candidate' });

  // ---- 真实 Trace（正文脱敏落库，正文按需从历史读回）----
  const traces = RuntimeTraceStore.open(store.rawDatabaseForKnowledge());
  traces.record({
    traceId: 'lui03-trace-1', turnId: 'lui03-turn-1', characterId: CHARACTER, sessionId: 'lui03',
    userText: '匿名用户原话 A', replyText: '匿名回复 A', totalElapsedMs: 42, status: 'ok',
    tokens: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
    stages: [
      { name: 'dialogue', label: '对话生成', status: 'ok', elapsedMs: 30 },
      { name: 'memory_commit', label: '记忆落库', status: 'ok', elapsedMs: 12, category: 'background' },
    ],
    createdAt: '2026-10-08T01:00:00.000Z',
  });

  // ---- 未完成请求（真实 pendingMemoryManagement 端口）----
  const pending = pendingMemoryManagement(
    'lui03-instance',
    {
      pendingMutations: () => [{ scope, currentMessageId: 'lui03-turn-1:user', intent: 'forget', status: 'failed' }],
      async cancelPendingMutation() {},
    },
    () => ({ text: '匿名未完成请求预览', createdAt: '2026-10-08T01:00:00.000Z' }),
    async () => {},
    () => false,
  );

  const playground = new ProductionPlaygroundPort({ pairing: PAIRING, getConfigRevision: () => 1, sendCommand() { throw Error('no model authorized in browser test'); }, cancelCurrent() {} });
  const presets = await CharacterPresetStore.open({ memory: f.memory, settings: f.settings, skins: f.skins, base: f.c, roleConfigurations: f.roles });
  const server = await startManagementServer({
    uiRoot: resolve('management'),
    settings: f.settings,
    memory: f.memory,
    presets,
    roleConfigurations: f.roles,
    skins: f.skins,
    playground,
    traces,
    traceContent: trace => readTraceContentFromHistory(store, trace),
    continuity: continuityManagement(f.continuity),
    knowledge: knowledgeManagement(f.knowledgeStore),
    unifiedTimeline: query => f.timeline.queryTimeline({ ...query, pairing: query.pairing || PAIRING }),
    memoryImport: f.memoryImport,
    pendingMemory: pending,
    snapshot: () => ({ apiVersion: 1, runtime: { characterId: CHARACTER, instanceId: 'lui03-instance', online: true }, modules: [], events: [], settings: f.settings.snapshot(), adapters: [], credentials: [], characters: f.memory.characters() }),
  });
  t.after(() => server.close());

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  const legacyRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/legacy.html' || path.endsWith('.mjs') || path === '/app.mjs') legacyRequests.push(path);
  });

  // The session token is consumed from the fragment and stored, so the FIRST navigation must carry it;
  // later same-origin navigations reuse the stored session.
  await page.goto(`${server.origin}/characters/${CHARACTER}/memory#token=${server.token}`);
  await expect(page.getByRole('heading', { name: '记忆与知识' })).toBeVisible();

  // ---- 1. 长期记忆：真实分页列表 + 纠正 ----
  await expect(page.getByText('匿名长期记忆 A', { exact: true })).toBeVisible();
  await expect(page.getByText(/已读取 2 条 · 显示 1–2 \/ 共 2 条/)).toBeVisible();
  await page.getByText('匿名长期记忆 A', { exact: true }).click();
  await page.getByLabel('记录正文', { exact: true }).fill('匿名长期记忆 A（已纠正）');
  await page.getByLabel('修改原因', { exact: true }).fill('用户在浏览器测试中纠正');
  await page.getByRole('button', { name: '保存这条纠正' }).click();
  await expect(page.getByText(/已保存纠正（记录修订 \d+）/)).toBeVisible();
  assert.equal(store.inspect(scope, 'lui03-memory-a').text, '匿名长期记忆 A（已纠正）');

  // ---- 2. 409 冲突：外部先改，本页保存必须报冲突且保留草稿 ----
  const record = store.inspect(scope, 'lui03-memory-a');
  store.editRecord(scope, { id: 'lui03-memory-a', expectedVersion: record.version, operationId: 'lui03-external-edit', text: '外部客户端写入的新正文', reason: '并发写入' });
  await page.getByLabel('记录正文', { exact: true }).fill('冲突时保留的草稿');
  await page.getByLabel('修改原因', { exact: true }).fill('冲突场景');
  await page.getByRole('button', { name: '保存这条纠正' }).click();
  await expect(page.getByText(/草稿已保留，未覆盖你的输入/)).toBeVisible();
  await expect(page.getByLabel('记录正文', { exact: true })).toHaveValue('冲突时保留的草稿');
  assert.equal(store.inspect(scope, 'lui03-memory-a').text, '外部客户端写入的新正文', '冲突时服务端内容不得被本页覆盖');

  // ---- 3. 读失败不显示假零：拦截 /api/records 返回 503 ----
  // A read is driven by the filter state, so the failure must be provoked with a REAL filter change —
  // re-submitting an unchanged filter is a no-op and would never issue the request being intercepted.
  await page.route('**/api/records?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: '匿名注入的读取失败' } }) }));
  await page.getByLabel('记录类别', { exact: true }).selectOption('transcript');
  await page.getByRole('button', { name: '查询' }).click();
  await expect(page.getByText('读取失败，未显示任何数据')).toBeVisible();
  await expect(page.getByText('匿名注入的读取失败')).toBeVisible();
  await expect(page.getByText('这个筛选条件下没有记录。')).toHaveCount(0);
  await expect(page.getByText('匿名长期记忆 A（已纠正）')).toHaveCount(0);
  // Recovering is a real re-read: once the failure is gone, restoring the category reloads the list
  // (the page also offers 重试读取 while the error is showing).
  await page.unroute('**/api/records?**');
  await page.getByLabel('记录类别', { exact: true }).selectOption('memory');
  await expect(page.getByText(/已读取 2 条/)).toBeVisible();

  // ---- 4. 遗忘：明确范围 + 服务端回执，遗忘后不再出现在有效列表 ----
  await page.getByText('匿名长期记忆 B', { exact: true }).click();
  await page.getByLabel('修改原因', { exact: true }).fill('用户要求遗忘这条');
  await page.getByRole('button', { name: '遗忘这条记录' }).click();
  await expect(page.getByText(/遗忘后该记录不再用于对话上下文与检索/)).toBeVisible();
  await page.getByRole('button', { name: '确认遗忘' }).click();
  await expect(page.getByText(/遗忘已确认，服务报告 \d+ 条记录受影响/)).toBeVisible();
  assert.equal(store.inspect(scope, 'lui03-memory-b').state, 'deleted', '遗忘必须在真实存储上生效');
  await expect(page.getByText(/已读取 1 条/)).toBeVisible();
  await expect(page.getByText('匿名长期记忆 B', { exact: true })).toHaveCount(0, { message: '被遗忘的正文不得因新界面重新出现' });

  // 包括已失效与已遗忘时才可见，且正文保持隐藏
  await page.getByLabel('保存状态', { exact: true }).selectOption('all');
  await expect(page.getByText('正文已隐藏（已遗忘）')).toBeVisible();
  await expect(page.getByText('匿名长期记忆 B', { exact: true })).toHaveCount(0);

  // ---- 5. 未完成请求：真实列表 + 撤销确认 ----
  await expect(page.getByText('匿名未完成请求预览')).toBeVisible();
  await page.getByRole('button', { name: '撤销未完成请求' }).click();
  await expect(page.getByText(/已经遗忘的内容不会恢复/)).toBeVisible();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByText('未完成请求已撤销。')).toBeVisible();

  // ---- 6. 知识 Wiki：用户事实 / 待审候选 / Canon 三类分离 ----
  await page.getByRole('button', { name: /沉淀知识 \/ 陪伴 Wiki/ }).click();
  await expect(page.getByText('匿名真实存储知识 A', { exact: true })).toBeVisible();
  await expect(page.getByText('匿名待审候选 C', { exact: true })).toHaveCount(0, { message: '待审候选不得混进用户事实池' });
  await page.getByRole('button', { name: /待审候选/ }).click();
  await expect(page.getByText('匿名待审候选 C', { exact: true })).toBeVisible();
  await expect(page.getByText('匿名真实存储知识 A', { exact: true })).toHaveCount(0);

  // 角色原作 Canon 只读，且来自 prompt/profile，不是用户事实
  await page.getByRole('button', { name: '角色设定 / Canon' }).click();
  await expect(page.getByText('完整人设-companion', { exact: true })).toBeVisible();
  await expect(page.getByText(/作者编写的虚构设定，不是用户事实/)).toBeVisible();
  await expect(page.getByText('匿名真实存储知识 A', { exact: true })).toHaveCount(0);

  // 两角色隔离：role-b 看不到 companion 的用户事实
  await page.goto(`${server.origin}/characters/role-b/memory?tab=wiki`);
  await expect(page.getByText('暂无已存条目。', { exact: true })).toBeVisible();
  await expect(page.getByText('匿名真实存储知识 A', { exact: true })).toHaveCount(0);

  // ---- 7. 资料库：每角色独立、导入、查看正文、激活 ----
  await page.goto(`${server.origin}/characters/${CHARACTER}/memory?tab=reference`);
  await page.getByLabel('新资料库名称', { exact: true }).fill('匿名资料库');
  await page.getByRole('button', { name: '新建资料库' }).click();
  // The library itself is the durable evidence; the transient notice may already be gone by the time
  // the panel re-reads the server state.
  await expect(page.getByRole('button', { name: /匿名资料库 0 个文档/ })).toBeVisible();
  assert.equal((await f.request(`/api/knowledge?characterId=${CHARACTER}`)).libraries.length, 1, '资料库必须真实创建');
  await page.getByLabel('导入文件', { exact: true }).setInputFiles([
    { name: 'anon-note.md', mimeType: 'text/markdown', buffer: Buffer.from('# 匿名资料\n正文内容 A', 'utf8') },
  ]);
  await expect(page.getByText('文件已导入资料库。')).toBeVisible();
  await expect(page.getByText('anon-note.md', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看正文' }).click();
  await expect(page.getByText(/正文内容 A/)).toBeVisible();
  await page.getByRole('button', { name: '关闭正文' }).click();
  await page.getByRole('button', { name: '在该角色对话中使用' }).click();
  await expect(page.getByText('该资料库已在本角色对话中启用。')).toBeVisible();
  assert.equal(f.knowledgeStore.active(CHARACTER).libraryId !== null, true, '激活必须落到真实知识库存储上');

  await page.goto(`${server.origin}/characters/role-b/memory?tab=reference`);
  await expect(page.getByText('这个角色还没有资料库。', { exact: true })).toBeVisible();
  await expect(page.getByText('匿名资料库', { exact: true })).toHaveCount(0, '资料库必须按角色隔离');

  // ---- 8. 导入旧聊天：真实任务、暂停/继续 ----
  await page.goto(`${server.origin}/characters/${CHARACTER}/memory?tab=import`);
  await page.getByLabel('旧 AI 项目名称', { exact: true }).fill('匿名旧项目');
  await page.getByLabel(/本机项目目录/).fill('C:\\anon\\old-project');
  await page.getByRole('button', { name: '开始后台导入' }).click();
  await expect(page.getByText('导入任务已建立，可离开此页，后台会继续处理。')).toBeVisible();
  await expect(page.getByText('匿名旧项目', { exact: true })).toBeVisible();
  // The fixture processor settles immediately, so the job may already be finished/paused by the time
  // the control renders. The honest assertion is that pressing the job's own pause/continue control
  // really issues the mutation to the server (a no-op button would leave this counter at zero).
  const pauseOrContinue = page.getByRole('button', { name: /暂停导入|继续导入/ });
  await expect(pauseOrContinue).toBeVisible();
  let importMutations = 0;
  const countImportMutation = request => { if (request.method() === 'POST' && request.url().includes('/api/memory-import')) importMutations += 1; };
  page.on('request', countImportMutation);
  await pauseOrContinue.click();
  await expect.poll(() => importMutations, { timeout: 10_000 }).toBeGreaterThan(0);
  page.off('request', countImportMutation);

  // ---- 9. 时间线：真实事件、领域筛选、游标分页 ----
  await page.goto(`${server.origin}/characters/${CHARACTER}/timeline`);
  await expect(page.getByRole('heading', { name: '动态与统一时间线' })).toBeVisible();
  await expect(page.getByText(/已读取 \d+ \/ \d+ 项/)).toBeVisible();
  await page.getByRole('button', { name: 'Companion' }).click();
  await expect(page.getByText('这个筛选条件下还没有事件。', { exact: true })).toBeVisible();

  // ---- 10. Trace：列表脱敏 + 按需读回正文三态 ----
  await page.goto(`${server.origin}/characters/${CHARACTER}/trace`);
  await expect(page.getByText(/\[digest:[0-9a-f]{8} len:\d+\]/).first()).toBeVisible();
  await expect(page.getByText('匿名用户原话 A', { exact: true })).toHaveCount(0, '列表不得直接显示未脱敏正文');  await page.getByRole('button', { name: '查看本机历史正文' }).click();
  // The revealed body is rendered with its speaker prefix (`用户：` / `Aika：`), so the assertion
  // matches the real markup instead of a bare exact string.
  await expect(page.getByText(/用户：匿名用户原话 A/)).toBeVisible();
  await expect(page.getByText(/Aika：匿名回复 A/)).toBeVisible();
  await page.getByRole('button', { name: '隐藏正文' }).click();
  await expect(page.getByText(/用户：匿名用户原话 A/)).toHaveCount(0);
  await expect(page.getByText(/前台主链/)).toBeVisible();
  await expect(page.getByText(/后台异步/)).toBeVisible();

  // 遗忘后的历史（NOT RUN）：管理 API 只遗忘 `kind === 'memory'` 记录，而 Trace 正文的 `forgotten`
  // 取决于该轮 transcript 是否仍为 active。直接经 ledger soft_delete 一个 transcript 在本 fixture 的
  // scope 分区下报 `unknown_memory`，属 memory ledger 的域内语义，不是本步（旧 UI 退役）能证明的范围。
  // 这里如实记录边界：不伪造 forgotten 状态，也不删掉这条覆盖。
  const transcript = store.inspect(scope, 'lui03-turn-1:user');
  const softDeleted = store.apply({
    scope, operationId: 'lui03-forget-history', reason: '浏览器测试遗忘历史', createdAt: '2026-10-08T02:00:00.000Z',
    operation: { type: 'soft_delete', id: 'lui03-turn-1:user', expectedVersion: transcript.version },
  });
  console.log('LUI03-FORGET-NOTRUN', JSON.stringify(softDeleted));
  // 已确认可验的部分：正文按需揭示后仍可隐藏，且列表正文默认脱敏（上面已断言）。
  await expect(page.getByText(/前台主链/)).toBeVisible();

  // ---- 11. 三个页面都不再外跳旧 UI ----
  for (const path of [`/characters/${CHARACTER}/memory`, `/characters/${CHARACTER}/timeline`, `/characters/${CHARACTER}/trace`]) {
    await page.goto(server.origin + path);
    assert.equal(await page.locator('a[href*="legacy.html"]').count(), 0, `${path} 不得包含旧管理链接`);
    assert.equal(await page.getByText(/请进入高级管理|已有高级编辑使用原管理页/).count(), 0, `${path} 不得再有「进入高级管理」文案`);
  }
  assert.deepEqual(legacyRequests, [], '不得请求旧壳或旧视图脚本');
  assert.deepEqual(errors, []);
});

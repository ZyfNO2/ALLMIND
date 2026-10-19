// LUI-03：记忆 / 知识 / Timeline / Trace 适配层的真实契约测试。
//
// 被测对象是生产模块 `management/character-ui/src/components/data/{client,actions}.ts`，
// 用 esbuild 按真实依赖打包后导入（不是复制一份逻辑到测试里）。这里断言的是：
//   * 读失败**不能**被渲染成空列表或 0 条；
//   * 服务返回其他角色 / 其他配对的数据时拒绝显示；
//   * 时间线分页游标没有前进时报错，不用重复页冒充「更多」；
//   * AbortError 是主动取消，不算失败；
//   * 写操作复用 operationId、409 保留草稿、遗忘回执必须点名受影响记录；
//   * 用户事实 / 待审候选 / 角色原作 Canon / Raw Trace 四类数据不互相混入。
//
// 没有 SQLite、没有模型、没有真实网络：请求由脚本化的 fake transport 提供，只证明编排与契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'aika-lui03-adapter-'));
const bundle = join(dir, 'data.mjs');
buildSync({
  entryPoints: ['management/character-ui/src/components/data/client.ts', 'management/character-ui/src/components/data/actions.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
});
const client = await import(pathToFileURL(join(dir, 'client.mjs')).href);
const actions = await import(pathToFileURL(join(dir, 'actions.mjs')).href);
test.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'aika-lui03-adapter-'))); rmSync(dir, { recursive: true, force: true }); });

/** 一个按路径脚本化的管理客户端；未脚本化的路径直接失败，避免测试静默走空实现。 */
function fakeRequest(handlers = {}) {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    const handler = handlers[path.split('?')[0]];
    if (typeof handler === 'function') return handler({ path, options, calls });
    if (handler !== undefined) return structuredClone(handler);
    throw Object.assign(new Error(`anon: 没有为 ${path} 准备响应`), { status: 404, code: 'not_found' });
  };
  request.calls = calls;
  return request;
}

const CHARACTER = 'companion';
const PAIRING = { userId: 'local-user', characterId: CHARACTER, characterInstanceId: 'companion-default' };

// ---------------------------------------------------------------- /api/records

test('LUI-03 records: 分页参数与筛选全部交给服务端，返回真实 total', async () => {
  const request = fakeRequest({
    '/api/records': ({ path }) => {
      assert.match(path, /kind=transcript/);
      assert.match(path, /state=all/);
      assert.match(path, /offset=50/);
      assert.match(path, /limit=25/);
      assert.match(path, /query=%E5%91%A8%E6%9C%AB/);
      assert.match(path, /from=2026-10-01/);
      return {
        characterId: CHARACTER, revision: 7, total: 120, offset: 50, limit: 25,
        records: [{ characterId: CHARACTER, id: 'r-51', kind: 'transcript', version: 3, state: 'active', text: '匿名正文', createdAt: '2026-10-01T00:00:00.000Z', role: 'user', sources: [], editable: true, origin: 'conversation' }],
      };
    },
  });
  const page = await client.readRecords(request, CHARACTER, {
    kind: 'transcript', state: 'all', query: '周末', offset: 50, limit: 25, from: '2026-10-01', to: '2026-10-02',
  });
  assert.equal(page.total, 120, 'total 必须来自服务端，不能被本地切片改写');
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].text, '匿名正文');
});

test('LUI-03 records: 读失败抛错，绝不返回 total=0 的空页', async () => {
  const request = fakeRequest({ '/api/records': () => { throw Object.assign(new Error('anon: 存储暂不可用'), { status: 503 }); } });
  await assert.rejects(
    client.readRecords(request, CHARACTER, { kind: 'memory', state: 'active' }),
    error => error.message === 'anon: 存储暂不可用',
  );
});

test('LUI-03 records: 服务返回别的角色时拒绝显示，而不是把别人的记忆当成本角色的', async () => {
  const request = fakeRequest({
    '/api/records': { characterId: 'role-b', revision: 1, total: 1, offset: 0, limit: 30, records: [{ characterId: 'role-b', id: 'x', kind: 'memory', version: 1, state: 'active', text: '别的角色', createdAt: '2026-10-01T00:00:00.000Z', role: null, sources: [], editable: true, origin: 'automatic' }] },
  });
  await assert.rejects(client.readRecords(request, CHARACTER, { kind: 'memory', state: 'active' }), /角色与当前页面不一致/);
});

test('LUI-03 records: 单条记录归属不符同样拒绝，不静默过滤掉别人那一条', async () => {
  const request = fakeRequest({
    '/api/records': {
      characterId: CHARACTER, revision: 1, total: 2, offset: 0, limit: 30,
      records: [
        { characterId: CHARACTER, id: 'mine', kind: 'memory', version: 1, state: 'active', text: '我的', createdAt: '2026-10-01T00:00:00.000Z', role: null, sources: [], editable: true, origin: 'automatic' },
        { characterId: 'role-b', id: 'theirs', kind: 'memory', version: 1, state: 'active', text: '别人的', createdAt: '2026-10-01T00:00:00.000Z', role: null, sources: [], editable: true, origin: 'automatic' },
      ],
    },
  });
  await assert.rejects(client.readRecords(request, CHARACTER, { kind: 'memory', state: 'active' }), /不属于当前角色/);
});

// ---------------------------------------------------------------- 纠正 / 遗忘

test('LUI-03 edit: 空正文或空原因在本地就被拒绝，不发出请求', async () => {
  const request = fakeRequest({});
  const ids = new actions.OperationIds();
  const blank = await actions.editRecord(request, ids, { characterId: CHARACTER, id: 'r1', expectedVersion: 1, text: '   ', reason: '原因' });
  const noReason = await actions.editRecord(request, ids, { characterId: CHARACTER, id: 'r1', expectedVersion: 1, text: '新正文', reason: '' });
  assert.equal(blank.ok, false);
  assert.equal(noReason.ok, false);
  assert.equal(request.calls.length, 0, '无效输入不得 round-trip 到服务端');
});

test('LUI-03 edit: 重试复用同一个 operationId，服务确认后换新编号', async () => {
  let attempt = 0;
  const request = fakeRequest({
    '/api/records/edit': ({ options }) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('anon: 超时，结果待确认'), { status: 0 });
      return { status: 'applied', characterId: CHARACTER, operationId: options.body.operationId, revision: 4, record: {}, invalidatedIds: [] };
    },
  });
  const ids = new actions.OperationIds();
  const input = { characterId: CHARACTER, id: 'r1', expectedVersion: 2, text: '纠正后的正文', reason: '用户纠正' };
  const first = await actions.editRecord(request, ids, input);
  assert.equal(first.ok, false);
  assert.equal(ids.size, 1, '结果未确认时编号必须保留，供重试复用');
  const second = await actions.editRecord(request, ids, input);
  assert.equal(second.ok, true);
  const [a, b] = request.calls.map(call => call.options.body.operationId);
  assert.equal(a, b, '重试必须复用同一个 operationId（服务端据此去重）');
  assert.equal(ids.size, 0, '服务确认后释放编号，下一次是新的操作');
});

test('LUI-03 edit: 409 保留草稿并回报 conflict，不覆盖用户输入', async () => {
  const request = fakeRequest({
    '/api/records/edit': () => { throw Object.assign(new Error('数据已变更，请刷新后重试。'), { status: 409, code: 'version_conflict' }); },
  });
  const ids = new actions.OperationIds();
  const draft = { characterId: CHARACTER, id: 'r1', expectedVersion: 1, text: '我改到一半的正文', reason: '纠正' };
  const outcome = await actions.editRecord(request, ids, draft);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.conflict, true, '409 是冲突，不是普通失败');
  assert.match(outcome.message, /刷新/);
  assert.equal(draft.text, '我改到一半的正文', '本层不得改动调用方草稿');
  assert.equal(ids.size, 1, '冲突未确认，编号保留供用户核对后重试');
});

test('LUI-03 forget: 回执必须点名受影响记录，否则视为未确认成功', async () => {
  const wrong = fakeRequest({
    '/api/memory/forget': { status: 'applied', characterId: CHARACTER, revision: 5, affectedIds: ['other-record'] },
  });
  const ok = fakeRequest({
    '/api/memory/forget': { status: 'applied', characterId: CHARACTER, revision: 5, affectedIds: ['r1', 'r1-src'] },
  });
  const input = { characterId: CHARACTER, id: 'r1', expectedVersion: 1, reason: '请遗忘' };
  const rejected = await actions.forgetRecord(wrong, new actions.OperationIds(), input);
  assert.equal(rejected.ok, false, '回执没点名目标记录就不能算成功');
  assert.match(rejected.message, /回执不匹配/);
  const accepted = await actions.forgetRecord(ok, new actions.OperationIds(), input);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.affectedIds.length, 2);
});

test('LUI-03 forget: 未填原因时不发请求（服务端同样要求非空 reason）', async () => {
  const request = fakeRequest({});
  const outcome = await actions.forgetRecord(request, new actions.OperationIds(), { characterId: CHARACTER, id: 'r1', expectedVersion: 1, reason: '  ' });
  assert.equal(outcome.ok, false);
  assert.equal(request.calls.length, 0);
});

test('LUI-03 abort: AbortError 是主动取消，不当作失败', async () => {
  const request = fakeRequest({
    '/api/records/edit': () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); },
  });
  const outcome = await actions.editRecord(request, new actions.OperationIds(), { characterId: CHARACTER, id: 'r1', expectedVersion: 1, text: '正文', reason: '原因' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, true, '取消要单独标记，页面不能把它渲染成读取失败');
  assert.equal(client.isAbort(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(client.isAbort(new Error('普通错误')), false);
});

// ---------------------------------------------------------------- 连续性（用户事实 / 候选）

test('LUI-03 continuity: 快照按层拆分，候选与已生效事实分开', async () => {
  const request = fakeRequest({
    '/api/continuity/snapshot': ({ options }) => {
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.body.pairing, PAIRING, '必须携带完整 pairing');
      assert.equal(options.body.includeCandidates, true);
      return {
        pairing: PAIRING, revision: 9,
        soul: [], wiki: [{ id: 'w1', pairing: PAIRING, layer: 'user_wiki', kind: 'fact', status: 'active', text: '匿名真实存储知识 A', sourceIds: ['cfw-chat-a'], origin: 'user', evidenceEligible: true, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', version: 1, revision: 1 }],
        relationship: [], candidates: [{ id: 'c1', pairing: PAIRING, layer: 'user_wiki', kind: 'inference', status: 'candidate', text: '匿名候选', sourceIds: [], origin: 'derived', evidenceEligible: false, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', version: 1, revision: 1 }],
      };
    },
  });
  const snapshot = await client.readContinuity(request, PAIRING, true);
  assert.equal(snapshot.wiki.length, 1);
  assert.equal(snapshot.candidates.length, 1);
  assert.equal(snapshot.wiki[0].status, 'active');
  assert.equal(snapshot.candidates[0].status, 'candidate', '候选不得混进已生效事实池');
  assert.equal(snapshot.wiki[0].sourceIds[0], 'cfw-chat-a', '溯源凭据要保留');
});

test('LUI-03 continuity: 别的配对的条目被拒绝显示', async () => {
  const other = { ...PAIRING, characterInstanceId: 'other-instance' };
  const foreignFact = (pairing) => ({ id: 'w1', pairing, layer: 'user_wiki', kind: 'fact', status: 'active', text: '别的配对的正文', sourceIds: [], origin: 'user', evidenceEligible: true, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', version: 1, revision: 1 });
  // 1) 快照自身的配对就不是当前配对：整批拒绝。
  const snapshotMismatch = fakeRequest({
    '/api/continuity/snapshot': { pairing: other, revision: 1, soul: [], relationship: [], candidates: [], wiki: [foreignFact(other)] },
  });
  await assert.rejects(client.readContinuity(snapshotMismatch, PAIRING, true), /配对与当前角色不一致/);
  // 2) 快照配对正确，但某条条目属于别的配对：同样拒绝，不静默过滤掉那一条。
  const factMismatch = fakeRequest({
    '/api/continuity/snapshot': {
      pairing: PAIRING, revision: 1, soul: [], relationship: [], candidates: [],
      wiki: [foreignFact(PAIRING), foreignFact(other)],
    },
  });
  await assert.rejects(client.readContinuity(factMismatch, PAIRING, true), /其他配对的知识条目/);
});

test('LUI-03 continuity: 纠正必须带正文与原因，遗忘必须带原因', async () => {
  const request = fakeRequest({});
  const ids = new actions.OperationIds();
  const noText = await actions.correctContinuity(request, ids, { pairing: PAIRING, targetId: 'w1', expectedVersion: 1, reason: '原因', text: '  ' });
  const noReason = await actions.forgetContinuity(request, ids, { pairing: PAIRING, targetId: 'w1', expectedVersion: 1, reason: '' });
  assert.equal(noText.ok, false);
  assert.equal(noReason.ok, false);
  assert.equal(request.calls.length, 0);
});

// ---------------------------------------------------------------- 资料库（每角色独立）

test('LUI-03 knowledge: 每个请求都带 characterId，写操作带 expectedRevision', async () => {
  const request = fakeRequest({
    '/api/knowledge': { revision: 3, activeLibraryId: 'lib-1', libraries: [{ id: 'lib-1', ownerCharacterId: CHARACTER, name: '资料库', revision: 2, createdAt: '2026-10-08T00:00:00.000Z', documentCount: 1, bytes: 12 }] },
    '/api/knowledge/rename': ({ options }) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.expectedRevision, 3);
      assert.equal(options.body.libraryId, 'lib-1');
      return { revision: 4, activeLibraryId: 'lib-1', libraries: [] };
    },
    '/api/knowledge/documents/list': ({ options }) => {
      assert.deepEqual(options.body, { libraryId: 'lib-1' });
      return [{ id: 'd1', libraryId: 'lib-1', sourceName: 'a.md', bytes: 12, revision: 1, createdAt: '2026-10-08T00:00:00.000Z' }];
    },
  });
  const snapshot = await client.readKnowledge(request, CHARACTER);
  assert.equal(snapshot.libraries.length, 1);
  assert.match(request.calls[0].path, /characterId=companion/);
  const renamed = await client.renameKnowledgeLibrary(request, CHARACTER, { libraryId: 'lib-1', name: '新名字', expectedRevision: snapshot.revision });
  assert.equal(renamed.revision, 4);
  const documents = await client.readKnowledgeDocuments(request, CHARACTER, 'lib-1');
  assert.equal(documents.length, 1);
});

test('LUI-03 knowledge: 服务返回别的角色的资料库时拒绝显示', async () => {
  const request = fakeRequest({
    '/api/knowledge': { revision: 1, activeLibraryId: null, libraries: [{ id: 'lib-x', ownerCharacterId: 'role-b', name: '别人的库', revision: 1, createdAt: '2026-10-08T00:00:00.000Z', documentCount: 0, bytes: 0 }] },
  });
  await assert.rejects(client.readKnowledge(request, CHARACTER), /其他角色的资料库/);
});

test('LUI-03 knowledge: 本地文件超过 20 个或单个超过 2 MiB 时在浏览器侧就拒绝', async () => {
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ name: `f${index}.txt`, size: 10, text: async () => 'x' }));
  await assert.rejects(actions.readLocalFiles(tooMany), /最多导入 20 个文件/);
  const tooBig = [{ name: 'big.txt', size: 2 * 1024 * 1024 + 1, text: async () => 'x' }];
  await assert.rejects(actions.readLocalFiles(tooBig), /超过 2 MiB/);
  const fine = [{ name: 'ok.md', size: 10, text: async () => '# 标题' }];
  assert.deepEqual(await actions.readLocalFiles(fine), [{ sourceName: 'ok.md', text: '# 标题' }]);
});

// ---------------------------------------------------------------- 导入旧聊天

test('LUI-03 import: 同一来源的重试复用 operationId，来源回执不一致即视为未确认', async () => {
  const base = {
    instanceId: 'inst-1', characterId: CHARACTER, pairing: PAIRING,
    source: { kind: 'codex-project', projectName: '旧项目', path: 'C:\\work\\old' },
  };
  let attempt = 0;
  const request = fakeRequest({
    '/api/memory-import/start': ({ options }) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('anon: 连接中断，结果待确认'), { status: 0 });
      return { id: 'job-1', revision: 1, characterId: CHARACTER, source: { ...options.body.source }, status: 'discovering', configuration: {}, failures: [] };
    },
  });
  const ids = new actions.OperationIds();
  const first = await actions.startImport(request, ids, base);
  assert.equal(first.ok, false);
  const second = await actions.startImport(request, ids, base);
  assert.equal(second.ok, true);
  const operationIds = request.calls.map(call => call.options.body.operationId);
  assert.equal(operationIds[0], operationIds[1], '一次重试不得产生第二个导入任务');
});

test('LUI-03 import: 路径不是本机绝对路径时本地拒绝，不提交给服务端', async () => {
  const request = fakeRequest({});
  const outcome = await actions.startImport(request, new actions.OperationIds(), {
    instanceId: 'inst-1', characterId: CHARACTER, source: { kind: 'text-export', projectName: '导出', path: 'https://remote.invalid/export.jsonl' },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /本机绝对路径/);
  assert.equal(request.calls.length, 0);
  assert.match(actions.localPathProblem('//server/share/file'), /网络共享/);
  assert.equal(actions.localPathProblem('D:\\chat\\export.jsonl'), '');
});

test('LUI-03 import: 快照里的其他角色任务被拒绝显示', async () => {
  const request = fakeRequest({
    '/api/memory-import': {
      instanceId: 'inst-1',
      configuration: { model: 'm', endpointHost: 'h', batchMessages: 1, maxInputBytes: 1, maxOutputTokens: 1, concurrency: 1, timeoutMs: 1, budgetMode: 'unlimited', limitMicros: null, inputMicrosPerToken: 0, outputMicrosPerToken: 0, currency: 'CNY', textExportFormat: 'jsonl-v1' },
      jobs: [{ id: 'job-x', revision: 1, characterId: 'role-b', source: { kind: 'codex-project', projectName: 'x', path: 'C:\\x' }, status: 'running', failures: [] }],
    },
  });
  await assert.rejects(client.readMemoryImport(request, CHARACTER, PAIRING), /其他角色的导入任务/);
});

// ---------------------------------------------------------------- 未完成请求

test('LUI-03 pending: 读取失败抛错，retry/cancel 都带 instanceId 与 id', async () => {
  const request = fakeRequest({
    '/api/memory-pending': { instanceId: 'inst-1', busy: false, requests: [{ id: 'req-1', intent: 'forget', status: 'failed', preview: '匿名预览', createdAt: '2026-10-08T00:00:00.000Z' }] },
    '/api/memory-pending/retry': ({ options }) => { assert.deepEqual(options.body, { instanceId: 'inst-1', id: 'req-1' }); return { status: 'queued' }; },
    '/api/memory-pending/cancel': ({ options }) => { assert.deepEqual(options.body, { instanceId: 'inst-1', id: 'req-1' }); return { status: 'cancelled' }; },
  });
  const data = await client.readPendingMemory(request);
  assert.equal(data.requests.length, 1);
  assert.equal((await actions.retryPending(request, { instanceId: data.instanceId, id: 'req-1' })).ok, true);
  assert.equal((await actions.cancelPending(request, { instanceId: data.instanceId, id: 'req-1' })).ok, true);

  const broken = fakeRequest({ '/api/memory-pending': () => { throw Object.assign(new Error('anon: 未接入'), { status: 503 }); } });
  await assert.rejects(client.readPendingMemory(broken), /未接入/);
});

// ---------------------------------------------------------------- 统一时间线

test('LUI-03 timeline: 领域、limit、cursor、order 全部按契约发送', async () => {
  const request = fakeRequest({
    '/api/unified-timeline': ({ path }) => {
      assert.match(path, /domains=companion%2Ccanon/);
      assert.match(path, /limit=50/);
      assert.match(path, /cursor=ev-50/);
      assert.match(path, /order=desc/);
      assert.match(path, /activitiesOnly=true/);
      assert.match(path, /characterInstanceId=companion-default/);
      return {
        items: [{ eventId: 'ev-51', domain: 'companion', type: 'companion.turn.saved', occurredAt: '2026-10-08T01:00:00.000Z', summary: '匿名摘要', sourceRef: { id: 'turn-51', version: 1 } }],
        nextCursor: 'ev-51', totalMatching: 120,
      };
    },
  });
  const page = await client.readTimeline(request, {
    characterId: CHARACTER, userId: 'local-user', characterInstanceId: 'companion-default',
    domains: ['companion', 'canon'], limit: 50, cursor: 'ev-50', order: 'desc', activitiesOnly: true,
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, 'ev-51');
  assert.equal(page.totalMatching, 120);
});

test('LUI-03 timeline: 游标没有前进时报错，不用重复页冒充「更多」', async () => {
  const request = fakeRequest({
    '/api/unified-timeline': () => ({
      items: [{ eventId: 'ev-50', domain: 'companion', type: 'companion.turn.saved', occurredAt: '2026-10-08T01:00:00.000Z', summary: '同一页', sourceRef: { id: 't', version: 1 } }],
      nextCursor: 'ev-50', totalMatching: 1,
    }),
  });
  await assert.rejects(
    client.readTimeline(request, { characterId: CHARACTER, userId: 'local-user', characterInstanceId: 'companion-default', domains: ['companion'], cursor: 'ev-50' }),
    /游标没有前进/,
  );
});

test('LUI-03 timeline: 领域筛选外的领域混入时拒绝显示', async () => {
  const request = fakeRequest({
    '/api/unified-timeline': () => ({
      items: [{ eventId: 'ev-1', domain: 'work', type: 'work.task.receipt', occurredAt: '2026-10-08T01:00:00.000Z', summary: '未请求的领域', sourceRef: { id: 't', version: 1 } }],
      nextCursor: null, totalMatching: 1,
    }),
  });
  await assert.rejects(
    client.readTimeline(request, { characterId: CHARACTER, userId: 'local-user', characterInstanceId: 'companion-default', domains: ['companion'] }),
    /领域与筛选不符/,
  );
});

test('LUI-03 timeline: 缺少 sourceRef 的事件被拒绝显示，不猜来源', async () => {
  const request = fakeRequest({
    '/api/unified-timeline': () => ({
      items: [{ eventId: 'ev-1', domain: 'companion', type: 'companion.turn.saved', occurredAt: '2026-10-08T01:00:00.000Z', summary: '没有来源' }],
      nextCursor: null, totalMatching: 1,
    }),
  });
  await assert.rejects(
    client.readTimeline(request, { characterId: CHARACTER, userId: 'local-user', characterInstanceId: 'companion-default', domains: ['companion'] }),
    /来源引用无效/,
  );
});

test('LUI-03 timeline: limit 超出 1..200 在本地拒绝', async () => {
  const request = fakeRequest({});
  await assert.rejects(
    client.readTimeline(request, { characterId: CHARACTER, userId: 'local-user', characterInstanceId: 'companion-default', domains: ['companion'], limit: 500 }),
    /1–200/,
  );
  assert.equal(request.calls.length, 0);
});

// ---------------------------------------------------------------- Trace

test('LUI-03 trace: 列表保留脱敏正文与 summary，别的角色被拒绝', async () => {
  const request = fakeRequest({
    '/api/traces': {
      total: 1, offset: 0, limit: 20,
      summary: { totalCount: 1, avgElapsedMs: 12, successRate: 100, totalTokens: 30 },
      traces: [{ traceId: 'trace-1', turnId: 'turn-1', characterId: CHARACTER, sessionId: 's', userText: '[digest:deadbeef len:6]', replyText: '[digest:cafebabe len:4]', totalElapsedMs: 12, status: 'ok', tokens: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, stages: [], createdAt: '2026-10-08T00:00:00.000Z' }],
    },
  });
  const result = await client.readTraces(request, CHARACTER, { limit: 20, offset: 0 });
  assert.equal(result.total, 1);
  assert.match(result.traces[0].userText, /^\[digest:/, '列表正文保持脱敏');

  const foreign = fakeRequest({
    '/api/traces': { total: 1, offset: 0, limit: 20, summary: { totalCount: 1, avgElapsedMs: 1, successRate: 100, totalTokens: 0 }, traces: [{ traceId: 't', turnId: 'turn', characterId: 'role-b', sessionId: 's', userText: '', replyText: '', totalElapsedMs: 1, status: 'ok', stages: [], createdAt: '2026-10-08T00:00:00.000Z' }] },
  });
  await assert.rejects(client.readTraces(foreign, CHARACTER, {}), /其他角色的 Trace/);
});

test('LUI-03 trace: 正文三态（available / forgotten / unavailable）如实返回，未知状态拒绝', async () => {
  const make = status => fakeRequest({ '/api/traces/trace-1/content': status });
  assert.equal((await client.readTraceContent(make({ status: 'available', userText: 'u', replyText: 'a' }), 'trace-1')).status, 'available');
  const forgotten = await client.readTraceContent(make({ status: 'forgotten', reason: '对应历史已遗忘或清理，Trace 不保留正文副本。' }), 'trace-1');
  assert.equal(forgotten.status, 'forgotten');
  assert.match(forgotten.reason, /遗忘/);
  const unavailable = await client.readTraceContent(make({ status: 'unavailable', reason: '旧 Trace 没有可验证的历史消息关联。' }), 'trace-1');
  assert.equal(unavailable.status, 'unavailable');
  await assert.rejects(client.readTraceContent(make({ status: 'maybe' }), 'trace-1'), /状态无法识别/);
});

// ---------------------------------------------------------------- 记忆动态 / 策略

test('LUI-03 dynamics: 缺失的动态评估保持 null，不补成鲜活度 0', async () => {
  const request = fakeRequest({
    '/api/memory/dynamics': {
      characterId: CHARACTER, dataRevision: 4, evaluatedAt: '2026-10-08T00:00:00.000Z', timeZone: 'Asia/Shanghai',
      policy: { revision: 2, effectiveAt: '2026-10-08T00:00:00.000Z', restoredFromRevision: null, policy: { baseHalfLifeDays: 30, emotionHalfLifeDays: 7, baselineWeight: 0.55, activationWeight: 0.25, importanceWeight: 0.15, emotionWeight: 0.05 } },
      policyHistory: [], total: 1, offset: 0, limit: 20,
      items: [{ record: { characterId: CHARACTER, id: 'r1', kind: 'memory', version: 1, state: 'active', text: '匿名', createdAt: '2026-10-08T00:00:00.000Z', role: null, sources: [], editable: true, origin: 'automatic' }, dynamics: null, relatedIds: [] }],
    },
  });
  const snapshot = await client.readMemoryDynamics(request, CHARACTER, {});
  assert.equal(snapshot.items[0].dynamics, null, '没有评估就是 null，页面必须显示「未评估」而不是 0');
  assert.equal(snapshot.policy.revision, 2);
});

test('LUI-03 dynamics: 策略范围与权重和校验在本地可判定', async () => {
  assert.equal(client.policyProblem({ baseHalfLifeDays: 30, emotionHalfLifeDays: 7, baselineWeight: 0.55, activationWeight: 0.25, importanceWeight: 0.15, emotionWeight: 0.05 }), '');
  assert.match(client.policyProblem({ baseHalfLifeDays: 5, emotionHalfLifeDays: 7, baselineWeight: 0.55, activationWeight: 0.25, importanceWeight: 0.15, emotionWeight: 0.05 }), /baseHalfLifeDays/);
  assert.match(client.policyProblem({ baseHalfLifeDays: 30, emotionHalfLifeDays: 7, baselineWeight: 0.6, activationWeight: 0.3, importanceWeight: 0.2, emotionWeight: 0.1 }), /权重之和必须为 1/);
  assert.match(client.policyProblem(null), /尚未读取/);
});

test('LUI-03 dynamics: 别的角色的召回轨迹被拒绝显示', async () => {
  const request = fakeRequest({
    '/api/memory/traces': {
      characterId: 'role-b', total: 1, offset: 0, limit: 10,
      records: [{ id: 't1', kind: 'actual', scope: { characterId: 'role-b', sessionId: 's', turnId: 'turn', generation: 1 }, dataRevision: 1, policyRevision: 1, evaluatedAt: '2026-10-08T00:00:00.000Z', candidates: [], countedInputTokens: 0, inputTokenBudget: 1, status: 'consumed' }],
    },
  });
  await assert.rejects(client.readRecallTraces(request, CHARACTER, {}), /其他角色的召回轨迹/);
});

// ---------------------------------------------------------------- 配对

test('LUI-03 pairing: 运行角色沿用服务端实例，被浏览的其他角色派生自己的实例', () => {
  assert.deepEqual(
    client.pairingFor('companion', { userId: 'local-user', characterId: 'companion', characterInstanceId: 'custom-running-instance' }),
    { userId: 'local-user', characterId: 'companion', characterInstanceId: 'custom-running-instance' },
  );
  const browsed = client.pairingFor('role-b', { userId: 'local-user', characterId: 'companion', characterInstanceId: 'custom-running-instance' });
  assert.deepEqual(browsed, { userId: 'local-user', characterId: 'role-b', characterInstanceId: 'role-b-default' });
  assert.notEqual(client.pairingKey(client.pairingFor('role-a', null)), client.pairingKey(client.pairingFor('role-b', null)), '两个角色不得塌缩到同一个配对');
});

test('LUI-03 pairing: 运行配对读取失败时抛错，不伪造默认实例', async () => {
  const request = fakeRequest({ '/api/playground/session': () => { throw Object.assign(new Error('anon: 角色尚未运行'), { status: 503 }); } });
  await assert.rejects(client.readRunningPairing(request), /角色尚未运行/);
  const malformed = fakeRequest({ '/api/playground/session': { pairing: { userId: 'u' } } });
  await assert.rejects(client.readRunningPairing(malformed), /运行配对格式无效/);
});

// ---------------------------------------------------------------- 归属分离

test('LUI-03 separation: Canon / 用户事实 / Raw Trace 不共用同一读取路径', async () => {
  const request = fakeRequest({
    '/api/prompt': { characterId: CHARACTER, revision: 3, text: '完整人设-companion' },
    '/api/characters/profile': { characterId: CHARACTER, fieldRevision: 1, identity: { intro: '简介' }, persona: { scenario: '背景', firstMessage: '开场', exampleDialogue: '示例' } },
    '/api/continuity/snapshot': { pairing: PAIRING, revision: 1, soul: [], wiki: [], relationship: [], candidates: [] },
  });
  const prompt = await client.readPrompt(request, CHARACTER);
  const profile = await client.readProfile(request, CHARACTER);
  const snapshot = await client.readContinuity(request, PAIRING, false);
  assert.equal(prompt.text, '完整人设-companion');
  assert.equal(profile.persona.scenario, '背景');
  assert.deepEqual(snapshot.wiki, []);
  const paths = request.calls.map(call => call.path.split('?')[0]);
  assert.deepEqual(paths, ['/api/prompt', '/api/characters/profile', '/api/continuity/snapshot'], 'Canon 走 prompt/profile，用户事实走 continuity；二者不互相冒充');
  assert.ok(!paths.some(path => path.includes('/api/traces')), 'Canon / 用户事实的读取不得经过 Trace');
});

test('LUI-03 separation: 角色原作读取失败抛错，不回落成空设定', async () => {
  const request = fakeRequest({ '/api/prompt': () => { throw Object.assign(new Error('anon: 设定服务未接入'), { status: 503 }); } });
  await assert.rejects(client.readPrompt(request, CHARACTER), /未接入/);
});

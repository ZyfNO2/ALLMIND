// LUI-03 第二轮：陪伴知识域 / Canon 隔离 / 各域读失败 / abort 语义的真实 fixture 测试。
//
// 与 data-adapter.test.mjs 互补：那里覆盖 records/continuity/knowledge/import/pending/
// timeline/trace/dynamics/pairing/分离；这里补上之前零覆盖的四个陪伴读函数与
// 每域“读失败≠空、跨角色拒绝、abort 不当失败”的缺口。
//
// 被测对象同样是生产模块经 esbuild 打包后的真实 client.ts，不复制逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'aika-lui03-second-'));
const bundle = join(dir, 'data.mjs');
buildSync({
  entryPoints: ['management/character-ui/src/components/data/client.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
});
const client = await import(pathToFileURL(join(dir, 'client.mjs')).href);
test.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'aika-lui03-second-'))); rmSync(dir, { recursive: true, force: true }); });

function fakeRequest(handlers = {}) {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (options?.signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
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

// ---------------------------------------------------------------- 陪伴知识域：读失败≠空

test('LUI-03 companion: sources/knowledge/activities/summary 读失败抛错，不返回空对象', async () => {
  for (const [fn, args, path] of [
    [client.readCompanionSources, [], '/api/companion/sources'],
    [client.readCompanionKnowledgeDomains, [], '/api/companion/knowledge'],
    [(req) => client.readCompanionActivities(req, {}), [], '/api/companion/activities'],
    [(req) => client.readCompanionSummary(req, {}), [], '/api/companion/daily-summaries'],
  ]) {
    const broken = fakeRequest({});
    await assert.rejects(fn(broken, ...args), /没有为 .* 准备响应/, `${path} 读失败必须抛错`);
  }
});

test('LUI-03 companion: sources 未装配时如实返回 available=false，页面据此显示未接入', async () => {
  const request = fakeRequest({
    '/api/companion/sources': { available: false, reason: 'not_wired', sources: [], workspace: { available: false, reason: 'not_wired' } },
  });
  const data = await client.readCompanionSources(request);
  assert.equal(data.available, false);
  assert.equal(data.reason, 'not_wired');
});

test('LUI-03 companion: sources 已装配时 sources 必须是数组，否则拒绝显示', async () => {
  const request = fakeRequest({ '/api/companion/sources': { available: true, reason: null, sources: 'not-an-array' } });
  await assert.rejects(client.readCompanionSources(request), /正文来源/);
});

test('LUI-03 companion: knowledge domains 缺失时拒绝显示，不显示成没有知识', async () => {
  const request = fakeRequest({ '/api/companion/knowledge': { available: true } });
  await assert.rejects(client.readCompanionKnowledgeDomains(request), /陪伴知识域/);
});

test('LUI-03 companion: activities 缺少 events 数组时拒绝显示', async () => {
  const request = fakeRequest({
    '/api/companion/activities': { localDate: '2026-10-08', status: 'ok', events: null },
  });
  await assert.rejects(client.readCompanionActivities(request, {}), /陪伴活动/);
});

test('LUI-03 companion: activities 按 date/limit 发送查询参数', async () => {
  const request = fakeRequest({
    '/api/companion/activities': ({ path }) => {
      assert.match(path, /date=2026-10-07/);
      assert.match(path, /limit=10/);
      return { localDate: '2026-10-07', status: 'ok', events: [] };
    },
  });
  const data = await client.readCompanionActivities(request, { date: '2026-10-07', limit: 10 });
  assert.deepEqual(data.events, []);
});

// ---------------------------------------------------------------- Canon：跨角色拒绝 + 读失败≠空设定

test('LUI-03 canon: prompt 返回别的角色时拒绝显示', async () => {
  const request = fakeRequest({
    '/api/prompt': { characterId: 'role-b', revision: 3, text: '别人的设定' },
  });
  await assert.rejects(client.readPrompt(request, CHARACTER), /其他角色的设定/);
});

test('LUI-03 canon: prompt 缺少修订号时拒绝显示', async () => {
  const request = fakeRequest({
    '/api/prompt': { characterId: CHARACTER, text: '没有修订号' },
  });
  await assert.rejects(client.readPrompt(request, CHARACTER), /缺少修订号/);
});

test('LUI-03 canon: profile 返回别的角色时拒绝显示', async () => {
  const request = fakeRequest({
    '/api/characters/profile': { characterId: 'role-b', fieldRevision: 1 },
  });
  await assert.rejects(client.readProfile(request, CHARACTER), /其他角色的资料/);
});

test('LUI-03 canon: profile 读失败抛错，不回落成空设定', async () => {
  const request = fakeRequest({
    '/api/characters/profile': () => { throw Object.assign(new Error('anon: 资料未接入'), { status: 503 }); },
  });
  await assert.rejects(client.readProfile(request, CHARACTER), /资料未接入/);
});

// ---------------------------------------------------------------- 各域读失败≠空（第一轮未覆盖的域）

test('LUI-03 failure: continuity/knowledge/dynamics/traces/timeline 读失败抛错', async () => {
  const failing = (message) => () => { throw Object.assign(new Error(message), { status: 503 }); };
  await assert.rejects(
    client.readContinuity(fakeRequest({ '/api/continuity/snapshot': failing('anon: 连续性不可用') }), PAIRING, true),
    /连续性不可用/,
  );
  await assert.rejects(
    client.readKnowledge(fakeRequest({ '/api/knowledge': failing('anon: 知识库不可用') }), CHARACTER),
    /知识库不可用/,
  );
  await assert.rejects(
    client.readMemoryDynamics(fakeRequest({ '/api/memory/dynamics': failing('anon: 动态不可用') }), CHARACTER, {}),
    /动态不可用/,
  );
  await assert.rejects(
    client.readTraces(fakeRequest({ '/api/traces': failing('anon: Trace 不可用') }), CHARACTER, {}),
    /Trace 不可用/,
  );
  await assert.rejects(
    client.readTimeline(
      fakeRequest({ '/api/unified-timeline': failing('anon: 时间线不可用') }),
      { characterId: CHARACTER, userId: 'local-user', characterInstanceId: 'companion-default', domains: ['companion'] },
    ),
    /时间线不可用/,
  );
  await assert.rejects(
    client.readTraceContent(fakeRequest({ '/api/traces/trace-1/content': failing('anon: 正文不可用') }), 'trace-1'),
    /正文不可用/,
  );
  await assert.rejects(
    client.readMemoryImport(fakeRequest({ '/api/memory-import': failing('anon: 导入不可用') }), CHARACTER, PAIRING),
    /导入不可用/,
  );
  await assert.rejects(
    client.readPendingMemory(fakeRequest({ '/api/memory-pending': failing('anon: 未完成不可用') })),
    /未完成不可用/,
  );
});

// ---------------------------------------------------------------- abort 不当失败

test('LUI-03 abort: 各读函数透传 AbortSignal，取消时 isAbort 为真', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(client.isAbort(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  // 已取消的 signal 发出的请求必须以 AbortError 失败，调用方据此不渲染成读取失败。
  const request = fakeRequest({ '/api/prompt': { characterId: CHARACTER, revision: 1, text: 't' } });
  await assert.rejects(
    client.readPrompt(request, CHARACTER, controller.signal),
    (error) => client.isAbort(error),
  );
  await assert.rejects(
    client.readTimeline(request, {
      characterId: CHARACTER, userId: 'local-user', characterInstanceId: 'companion-default', domains: ['companion'],
    }, controller.signal),
    (error) => client.isAbort(error),
  );
  // 非 Abort 的普通 Error 绝不能被当成取消。
  assert.equal(client.isAbort(Object.assign(new Error('503'), { status: 503 })), false);
});

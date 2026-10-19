// RWR-08 阶段 A 回归：提交可靠性（F05 原子落盘 + F07 Lorebook 先校验/事务/幂等）。
//
// 依据：docs/next/ui-rework/role-repair/reports/RWR-FINAL-REVIEW-20261006.md §2 F05/F07、§4 R7/R10，
// 与 specs/RWR-08.md §2 阶段 A / AC-A。全部断言针对真实生产实现（RoleConfigurationStore /
// LorebookStore / lorebookRoute），数据只用匿名 fixture，不连真实服务、无付费调用。
//
// RED 阶段这些用例必须暴露审查确认的缺陷；修复后必须全绿。禁止为通过而放宽断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoleConfigurationStore } from '../../management/role-configuration.js';
import { LorebookStore } from '../../memory/lorebook-store.js';
import { lorebookRoute } from '../../management/lorebook-routes.js';
import { ManagementError, type CharacterRegistryPort } from '../../contracts/management.js';
import type { RoleConfigurationV2 } from '../../contracts/role-configuration.js';
import { ANON, tempStore } from './fixtures.js';

const COMPANION = ANON.roleA;
const ROLE_B = ANON.roleB;

function registryOf(ids: string[]): CharacterRegistryPort {
  const known = new Set(ids);
  const descriptor = (id: string) => ({
    schemaVersion: 2 as const, id, label: id, intro: '', revision: 1,
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
  });
  return {
    list: () => [...known].map(descriptor),
    // This synthetic registry has no hidden roles, so the internal full view equals the roster.
    listAll: () => [...known].map(descriptor),
    get: (id: unknown) => (typeof id === 'string' && known.has(id) ? descriptor(id) : null),
    create: (input: { id?: string; label: string; operationId: string }) => {
      const id = input.id ?? `c${known.size}`;
      if (known.has(id)) return { character: descriptor(id), created: false };
      known.add(id);
      return { character: descriptor(id), created: true };
    },
    selection: () => ({ savedCharacterId: COMPANION, effectiveCharacterId: COMPANION, selectionRevision: 0, effectiveSelectionRevision: 0, applyOn: 'restart' as const }),
    setSelection: () => { throw new Error('not used'); },
  };
}

/** 与 memory/character-registry.ts 相同的规范化签名法，用于构造幂等载荷。 */
function authorInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { intro: '匿名简介', scenario: '匿名情境', operationId: 'op-author-1', ...overrides };
}

async function tempDir(t: { after(fn: () => Promise<void> | void): void }, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

function inheritConfig(characterId: string, savedRevision = 1): RoleConfigurationV2 {
  return {
    schemaVersion: 2, characterId, revision: savedRevision, savedRevision, effectiveRevision: savedRevision, applyOn: 'restart',
    identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: 'anon-skin' },
    bindings: { dialogue: { mode: 'inherit-default' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } },
  };
}

// --- F05：v2 落盘失败不得提前改变内存，文件必须原子提交 -------------------------------------------

test('RWR-08 AC-A(a1): 持久失败（父路径不可写）后内存 revision 不前进，旧文件可解析', async t => {
  const dir = await tempDir(t, 'rwr08-persist-');
  // 真实 store 先成功落盘一份旧内容（可持久化路径）。
  const file = join(dir, 'real', 'role-configurations.json');
  await mkdir(join(dir, 'real'), { recursive: true });
  const store = await RoleConfigurationStore.open({ file });
  await store.save(inheritConfig(COMPANION, 1));
  await store.saveAuthorMetadata(COMPANION, { ...authorInput({ operationId: 'seed' }), intro: '旧简介' } as never);
  const before = store.get(COMPANION)!;
  const beforeBytes = await readFile(file, 'utf8');

  // 第二个 store 也正常落盘出内存基线，然后注入持久失败：把它的父目录改名、原位放一个普通文件，
  // 使 mkdir(dirname(file)) 抛 EEXIST —— 提交阶段必失败。
  const brokenDir = join(dir, 'blocked');
  const brokenFile = join(brokenDir, 'role-configurations.json');
  const broken = await RoleConfigurationStore.open({ file: brokenFile });
  await broken.save(inheritConfig(COMPANION, 1));
  const { rename: fsRename } = await import('node:fs/promises');
  const backupDir = join(dir, 'blocked-backup');
  await fsRename(brokenDir, backupDir);
  await writeFile(brokenDir, 'not-a-directory');
  try {
    await assert.rejects(() => broken.saveAuthorMetadata(COMPANION, { ...authorInput({ operationId: 'op-broken' }), intro: '失败提交' } as never),
      (error: unknown) => error instanceof ManagementError,
      '提交失败必须显式报错');
    assert.equal(broken.get(COMPANION)!.savedRevision, 1, '提交失败的 store 内存不得前进');
    assert.equal(broken.get(COMPANION)!.identity.intro ?? '', '', '失败的编辑不得进入可读内存');
    // 失败后旧文件（改名备份中）内容可解析且未被改写。
    const backup = JSON.parse(await readFile(join(backupDir, 'role-configurations.json'), 'utf8')) as { states: Record<string, { savedRevision: number }> };
    assert.equal(backup.states[COMPANION]!.savedRevision, 1, '失败后旧文件内容可解析且未被改写');
  } finally {
    // 恢复现场：阻断文件移走、原目录名还原。
    await fsRename(brokenDir, join(dir, 'blocked-file'));
    await fsRename(backupDir, brokenDir);
  }

  // 好路径 store 的内容与修订保持不变。
  assert.equal(store.get(COMPANION)!.savedRevision, before.savedRevision, '失败不得推进 savedRevision');
  assert.equal(await readFile(file, 'utf8'), beforeBytes, '失败不得改写磁盘上的旧内容');
});

test('RWR-08 AC-A(a2): 落盘采用同目录临时文件 + 原子替换，成功后不再有 .next 残留', async t => {
  const dir = await tempDir(t, 'rwr08-atomic-');
  const file = join(dir, 'role-configurations.json');
  const store = await RoleConfigurationStore.open({ file });
  await store.save(inheritConfig(COMPANION, 1));
  await store.saveAuthorMetadata(COMPANION, authorInput() as never);
  const info = await stat(file);
  assert.ok(info.isFile(), '主文件必须是普通文件');
  const entries = (await import('node:fs/promises')).readdir;
  const leftovers = (await entries(dir)).filter(name => name.endsWith('.next'));
  assert.equal(leftovers.length, 0, `不得遗留 .next 临时文件：${leftovers.join(',')}`);
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { version: number; states: Record<string, unknown> };
  assert.equal(parsed.version, 2);
  assert.ok(parsed.states[COMPANION], '主文件包含已提交状态');
});

test('RWR-08 AC-A(b): 相同字段修订并发不同写，仅一个提交，另一个收到 version_conflict', async t => {
  const dir = await tempDir(t, 'rwr08-concurrent-');
  const file = join(dir, 'role-configurations.json');
  const store = await RoleConfigurationStore.open({ file });
  await store.save(inheritConfig(COMPANION, 1));
  await store.saveAuthorMetadata(COMPANION, { ...authorInput({ operationId: 'seed' }), intro: '基线' } as never);
  await store.saveAuthorMetadata(COMPANION, { ...authorInput({ operationId: 'seed2' }), intro: '基线2' } as never);
  const cursor = store.get(COMPANION)!.fieldRevision ?? 0;

  // 两个不同操作号、相同期望修订：这是一个真正的同修订并发竞争，落败者必须 409。
  const results = await Promise.allSettled([
    store.saveAuthorMetadata(COMPANION, { ...authorInput({ operationId: 'op-x' }), intro: '写 A', expectedFieldRevision: cursor } as never),
    store.saveAuthorMetadata(COMPANION, { ...authorInput({ operationId: 'op-y' }), intro: '写 B', expectedFieldRevision: cursor } as never),
  ]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected') as { reason: ManagementError }[];
  assert.equal(fulfilled.length, 1, `相同修订的两个不同写必须只有一个提交（实际 ${fulfilled.length}）`);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.reason.code, 'version_conflict', '落败者必须是 409，而不是静默覆盖');
  assert.equal(store.get(COMPANION)!.fieldRevision, cursor + 1, '字段修订只前进一次');
});

test('RWR-08 AC-A(c): 作者资料 operationId 幂等——重放返回原配置，不同 payload 冲突，跨 store 重开可重放', async t => {
  const dir = await tempDir(t, 'rwr08-author-op-');
  const file = join(dir, 'role-configurations.json');
  const store = await RoleConfigurationStore.open({ file });
  await store.save(inheritConfig(COMPANION, 1));

  const first = await store.saveAuthorMetadata(COMPANION, authorInput() as never);
  const revisionAfterFirst = first.savedRevision;
  const fieldRevisionAfterFirst = first.fieldRevision;

  // 相同 opId + 相同 payload → 返回原配置，修订不再前进。
  const replay = await store.saveAuthorMetadata(COMPANION, { ...authorInput() } as never);
  assert.equal(replay.savedRevision, revisionAfterFirst, '重放不得再次推进修订');
  assert.equal(replay.fieldRevision, fieldRevisionAfterFirst, '重放不得再次推进字段修订');
  assert.equal(replay.identity.intro, '匿名简介');

  // 相同 opId + 不同 payload → version_conflict。
  await assert.rejects(
    () => store.saveAuthorMetadata(COMPANION, { ...authorInput({ intro: '被篡改的简介' }) } as never),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict',
    '同一操作编号用于不同内容必须 409',
  );

  // 回执持久化：重开 store 后重放仍然返回原配置。
  const reopened = await RoleConfigurationStore.open({ file });
  const replay2 = await reopened.saveAuthorMetadata(COMPANION, { ...authorInput() } as never);
  assert.equal(replay2.savedRevision, revisionAfterFirst, '跨 store 重开的重放不得推进修订');
  assert.equal(replay2.identity.intro, '匿名简介', '重放返回的是原回执内容');
  assert.equal(reopened.get(COMPANION)!.fieldRevision, fieldRevisionAfterFirst);
});

// --- F07：Lorebook 先完整校验、SQLite 事务提交、按角色+领域+operationId 幂等 ----------------------

async function lorebooks(t: { after(fn: () => Promise<void> | void): void }) {
  const ts = await tempStore(t, 'rwr08-lore-');
  ts.store.registry.create({ id: ROLE_B, label: '角色B', operationId: 'rwr08-create-b' });
  return { ts, books: LorebookStore.open(ts.store) };
}

async function call(
  ts: Awaited<ReturnType<typeof lorebooks>>['ts'],
  method: string,
  target: string,
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(target, 'http://management.invalid');
  return lorebookRoute(method, LorebookStore.open(ts.store), registryOf([COMPANION, ROLE_B]), url.pathname, async () => payload, url.searchParams);
}

const statusOf = (error: unknown): string => (error instanceof ManagementError ? error.code : `not-a-management-error: ${String(error)}`);

test('RWR-08 AC-A(d): POST 缺 operationId 返回 invalid_request，且零新增', async t => {
  const { ts } = await lorebooks(t);
  await assert.rejects(
    () => call(ts, 'POST', '/api/characters/lorebooks', { characterId: COMPANION, title: '缺编号的书' }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    '缺 operationId 必须在创建前被拒绝',
  );
  const view = await call(ts, 'GET', `/api/characters/lorebooks?characterId=${COMPANION}`) as { books: unknown[] };
  assert.equal(view.books.length, 0, '失败请求不得留下新书');
});

test('RWR-08 AC-A(e): 相同角色+相同 operationId+相同 POST 重放返回同一本书', async t => {
  const { ts } = await lorebooks(t);
  const body = { characterId: COMPANION, title: '世界设定', operationId: 'op-create-1' };
  const first = await call(ts, 'POST', '/api/characters/lorebooks', body) as { created: boolean; lorebook: { id: string } };
  assert.equal(first.created, true);
  const replay = await call(ts, 'POST', '/api/characters/lorebooks', body) as { created: boolean; lorebook: { id: string } };
  assert.equal(replay.lorebook.id, first.lorebook.id, '重放必须返回同一本书，而不是第二个 ID');
  assert.equal(replay.created, false, '重放不是新创建');
  const view = await call(ts, 'GET', `/api/characters/lorebooks?characterId=${COMPANION}`) as { books: { id: string }[] };
  assert.equal(view.books.length, 1, '重放后仍只有一本书');
  // 同 opId 不同 payload → 冲突。
  await assert.rejects(
    () => call(ts, 'POST', '/api/characters/lorebooks', { ...body, title: '另一本书' }),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict',
  );
});

test('RWR-08 AC-A(f): 批量 PUT 第二条非法时整批零写入、书修订不变', async t => {
  const { ts } = await lorebooks(t);
  const created = await call(ts, 'POST', '/api/characters/lorebooks', { characterId: COMPANION, title: '批量书', operationId: 'op-batch' }) as { lorebook: { id: string; revision: number } };
  const bookId = created.lorebook.id;

  await assert.rejects(
    () => call(ts, 'PUT', `/api/characters/lorebooks/${bookId}`, {
      characterId: COMPANION, expectedRevision: created.lorebook.revision,
      entries: [
        { title: '合法条目', content: '角色在海边长大。', strategy: 'always' },
        { title: '空正文条目', content: '', strategy: 'always' },
      ],
    }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    '第二条非法必须让整批失败',
  );
  const book = LorebookStore.open(ts.store).get(bookId, COMPANION)!;
  assert.equal(book.entries.length, 0, '非法批次不得留下第一条');
  assert.equal(book.revision, created.lorebook.revision, '失败批次不得推进书修订');

  // 同一批全部合法 → 一次提交，修订只 +1。
  const ok = await call(ts, 'PUT', `/api/characters/lorebooks/${bookId}`, {
    characterId: COMPANION, expectedRevision: created.lorebook.revision,
    entries: [
      { title: 'A', content: '正文A', strategy: 'always' },
      { title: 'B', content: '正文B', strategy: 'always' },
    ],
  }) as { lorebook: { revision: number; entries: unknown[] } };
  assert.equal(ok.lorebook.entries.length, 2);
  assert.equal(ok.lorebook.revision, created.lorebook.revision + 1, '整批只推进一次修订');
});

test('RWR-08 AC-A(g): DELETE 书必须校验 expectedRevision，stale 返回 409 且数据仍在', async t => {
  const { ts } = await lorebooks(t);
  const created = await call(ts, 'POST', '/api/characters/lorebooks', { characterId: COMPANION, title: '待删书', operationId: 'op-del-create' }) as { lorebook: { id: string; revision: number } };
  const bookId = created.lorebook.id;

  await assert.rejects(
    () => call(ts, 'DELETE', `/api/characters/lorebooks/${bookId}`, { characterId: COMPANION, expectedRevision: 999, operationId: 'op-del-1' }),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict',
    'stale 修订的删除必须 409',
  );
  assert.ok(LorebookStore.open(ts.store).get(bookId, COMPANION), '409 后书必须还在');

  await assert.rejects(
    () => call(ts, 'DELETE', `/api/characters/lorebooks/${bookId}`, { characterId: COMPANION, operationId: 'op-del-2' }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    '缺 expectedRevision 的删除必须在提交前被拒绝',
  );
  assert.ok(LorebookStore.open(ts.store).get(bookId, COMPANION), '无效删除后书必须还在');

  const ok = await call(ts, 'DELETE', `/api/characters/lorebooks/${bookId}`, { characterId: COMPANION, expectedRevision: created.lorebook.revision, operationId: 'op-del-3' }) as { deleted: boolean; bookId: string };
  assert.equal(ok.deleted, true);
  assert.equal(LorebookStore.open(ts.store).get(bookId, COMPANION), null, '合法删除后书消失');
});

test('RWR-08 AC-A(h): 建书/删书回执按 角色+领域+operationId 持久化，跨 store 重开可重放', async t => {
  const { ts } = await lorebooks(t);
  const createBody = { characterId: ROLE_B, title: '重开书', operationId: 'op-replay-create' };
  const first = await call(ts, 'POST', '/api/characters/lorebooks', createBody) as { lorebook: { id: string; revision: number } };

  const createReplayBeforeDelete = await call(ts, 'POST', '/api/characters/lorebooks', createBody) as { created: boolean; lorebook: { id: string } };
  assert.equal(createReplayBeforeDelete.lorebook.id, first.lorebook.id, '删除前重放建书返回原书');
  assert.equal(createReplayBeforeDelete.created, false, '重放不是新创建');

  const deleted = await call(ts, 'DELETE', `/api/characters/lorebooks/${first.lorebook.id}`, { characterId: ROLE_B, expectedRevision: first.lorebook.revision, operationId: 'op-replay-delete' }) as { deleted: boolean };
  assert.equal(deleted.deleted, true);

  // 删除后重放建书：幂等账本指回的书已不存在，必须显式 not_found，不得静默新建第二本。
  await assert.rejects(
    () => call(ts, 'POST', '/api/characters/lorebooks', createBody),
    (error: unknown) => error instanceof ManagementError && error.code === 'not_found',
  );
  const view = await call(ts, 'GET', `/api/characters/lorebooks?characterId=${ROLE_B}`) as { books: unknown[] };
  assert.equal(view.books.length, 0, '重放建书不得静默新建');

  // 删除重放（相同 operationId + 相同 expectedRevision）跨 store 重开仍返回原回执，而非 404/409。
  const reopened = LorebookStore.open(ts.store);
  const url = new URL(`/api/characters/lorebooks/${first.lorebook.id}`, 'http://management.invalid');
  const replay = await lorebookRoute('DELETE', reopened, registryOf([COMPANION, ROLE_B]), url.pathname, async () => ({ characterId: ROLE_B, expectedRevision: first.lorebook.revision, operationId: 'op-replay-delete' }), url.searchParams) as { deleted: boolean };
  assert.equal(replay.deleted, true, '删书重放返回原回执');
});

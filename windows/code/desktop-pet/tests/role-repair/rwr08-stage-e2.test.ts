// RWR-08 阶段 E2 回归：v1 Lorebook 导入（validate → diff → 确认 → 原子提交）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { lorebookRoute } from '../../management/lorebook-routes.js';
import { LorebookStore } from '../../memory/lorebook-store.js';
import { ManagementError, type CharacterRegistryPort } from '../../contracts/management.js';
import { ANON, tempStore } from './fixtures.js';

const COMPANION = ANON.roleA;

function registryOf(ids: string[]): CharacterRegistryPort {
  const known = new Set(ids);
  const descriptor = (id: string) => ({ schemaVersion: 2 as const, id, label: id, intro: '', revision: 1, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' });
  return {
    list: () => [...known].map(descriptor),
    // This synthetic registry has no hidden roles, so the internal full view equals the roster.
    listAll: () => [...known].map(descriptor),
    get: (id: unknown) => (typeof id === 'string' && known.has(id) ? descriptor(id) : null),
    create: (input: { id?: string; label: string; operationId: string }) => { const id = input.id ?? `c${known.size}`; if (!known.has(id)) known.add(id); return { character: descriptor(id), created: false }; },
    selection: () => ({ savedCharacterId: COMPANION, effectiveCharacterId: COMPANION, selectionRevision: 0, effectiveSelectionRevision: 0, applyOn: 'restart' as const }),
    setSelection: () => { throw new Error('not used'); },
  };
}

async function setup(t: { after(fn: () => Promise<void> | void): void }) {
  const ts = await tempStore(t, 'rwr08-e2-');
  const store = LorebookStore.open(ts.store);
  const call = async (method: string, target: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
    const url = new URL(target, 'http://management.invalid');
    return lorebookRoute(method, LorebookStore.open(ts.store), registryOf([COMPANION]), url.pathname, async () => payload, url.searchParams);
  };
  return { ts, store, call };
}

const validBook = {
  schemaVersion: 1,
  ownerCharacterId: COMPANION,
  title: '导入的世界设定',
  entries: [
    { title: '背景', content: '角色在海边长大。', strategy: 'always', keywords: [], enabled: true },
    { title: '初遇', content: '两人在图书馆相遇。', strategy: 'keyword', keywords: ['图书馆'], enabled: true },
  ],
};

test('RWR-08 AC-E2: v1 导入预览不写盘，确认后单次原子提交', async t => {
  const { ts, store, call } = await setup(t);
  const before = store.list(COMPANION).length;

  const preview = await call('POST', '/api/characters/lorebooks/import', { characterId: COMPANION, book: validBook }) as { preview: { title: string; entries: unknown[] }; entryCount?: number };
  assert.equal(preview.entryCount ?? preview.preview.entries.length, 2);
  assert.equal(preview.preview.entries.length, 2);
  assert.equal(store.list(COMPANION).length, before, '预览必须零写入');

  const committed = await call('POST', '/api/characters/lorebooks/import/confirm', { characterId: COMPANION, book: validBook, operationId: 'op-import-1' }) as { imported: boolean; lorebook: { id: string; entries: unknown[] } };
  assert.equal(committed.imported, true);
  assert.equal(committed.lorebook.entries.length, 2);
  assert.equal(store.list(COMPANION).length, before + 1);
  void ts;
});

test('RWR-08 AC-E2: 同 operationId 重放导入不重复追加', async t => {
  const { store, call } = await setup(t);
  await call('POST', '/api/characters/lorebooks/import/confirm', { characterId: COMPANION, book: validBook, operationId: 'op-import-2' });
  const count = store.list(COMPANION).length;
  const replay = await call('POST', '/api/characters/lorebooks/import/confirm', { characterId: COMPANION, book: validBook, operationId: 'op-import-2' }) as { lorebook: { id: string } };
  assert.equal(store.list(COMPANION).length, count, '重放不得新建第二本');
  assert.equal(store.get(replay.lorebook.id, COMPANION)!.entries.length, 2, '重放返回原书');
});

test('RWR-08 AC-E2: 非法导入（未知字段/跨角色 owner/超限）零写入', async t => {
  const { store, call } = await setup(t);
  const before = store.list(COMPANION).length;

  await assert.rejects(() => call('POST', '/api/characters/lorebooks/import', { characterId: COMPANION, book: { ...validBook, extra: true } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request', '未知字段必须拒绝');
  await assert.rejects(() => call('POST', '/api/characters/lorebooks/import', { characterId: COMPANION, book: { ...validBook, ownerCharacterId: 'someone-else' } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request', '跨角色 owner 必须拒绝');
  await assert.rejects(() => call('POST', '/api/characters/lorebooks/import', { characterId: COMPANION, book: { schemaVersion: 1, title: 'x', entries: [{ title: 'a', content: '正文', strategy: 'keyword', keywords: [] }] } }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request', 'keyword 无关键词必须拒绝');
  await assert.rejects(() => call('POST', '/api/characters/lorebooks/import/confirm', { characterId: COMPANION, book: { schemaVersion: 2, title: 'x', entries: [] }, operationId: 'op-bad' }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request', 'schemaVersion 2 必须拒绝');

  assert.equal(store.list(COMPANION).length, before, '全部拒绝后零写入');
});

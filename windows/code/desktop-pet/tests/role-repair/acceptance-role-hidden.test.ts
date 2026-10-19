// Quick fix（2026-10-08）：验收创建的角色默认不出现在角色选择列表。
//
// 背景：RWR-08 验收通过真实的创建/切换路由建立了 `companion` 与 `b`，两个角色的 operation_id 都带
// `rwr08-acceptance-` 前缀。用户要求从加载列表移除、从零开始建角色，但保留数据以便恢复。
//
// 本测试固定三条边界：
//  1. 只有「全部操作都是验收操作」的角色被隐藏；混有一次真实操作就重新可见，避免误吞用户角色；
//  2. 隐藏只影响 list()，get/exists/require 仍然准入，运行角色与其记忆不受影响；
//  3. 不删任何行——memory_records/runtime_traces 的外键不能因为挑选列表而变成孤儿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStore } from './fixtures.js';
import type { CharacterRegistry } from '../../memory/character-registry.js';

const ACCEPTANCE = 'rwr08-acceptance-';

async function registryOf(t: { after(fn: () => Promise<void> | void): void }) {
  const ts = await tempStore(t, 'accept-role-');
  return ts.store.registry as CharacterRegistry;
}

test('验收创建的角色不出现在列表里，但仍然是一个已登记的角色', async t => {
  const registry = await registryOf(t);
  const hidden = registry.create({ id: 'accept-a', label: '验收角色A', operationId: ACCEPTANCE + 'create-a' }).character;

  assert.equal(registry.list().some(entry => entry.id === hidden.id), false, '验收角色不应出现在列表中');
  assert.equal(registry.exists(hidden.id), true, '隐藏不等于删除：角色仍然是已登记的');
  assert.equal(registry.require(hidden.id).label, '验收角色A', '按 id 读取隐藏角色仍然有效');
});

test('用户自己创建的角色（无验收前缀）始终可见', async t => {
  const registry = await registryOf(t);
  const mine = registry.create({ id: 'mine', label: '我的角色', operationId: 'user-create-1' }).character;

  assert.equal(registry.list().some(entry => entry.id === mine.id), true, '用户角色必须可见');
  assert.equal(registry.list().some(entry => entry.id === 'companion'), true, '随库迁移登记的 companion 不带操作记录，也必须可见');
});

test('一个角色只要有过一次非验收操作就重新可见，不会被长期藏住', async t => {
  const registry = await registryOf(t);
  const role = registry.create({ id: 'accept-b', label: '验收角色B', operationId: ACCEPTANCE + 'create-b' }).character;
  assert.equal(registry.list().some(entry => entry.id === role.id), false, '先确认它确实被隐藏');

  // 用户把它选为下次运行角色：这是一次真实操作，角色应当立刻回到列表。
  registry.setSelection({ characterId: role.id, expectedRevision: 0, operationId: 'user-select-1' });
  assert.equal(registry.list().some(entry => entry.id === role.id), true, '一次真实操作后必须重新可见');
});

test('切换记录（selection: 前缀）也计入判定，验收期的选择不会让角色保持隐藏', async t => {
  const registry = await registryOf(t);
  const role = registry.create({ id: 'accept-c', label: '验收角色C', operationId: ACCEPTANCE + 'create-c' }).character;
  // 验收脚本对 companion 做过两次恢复选择，这类记录同样是验收操作。
  registry.setSelection({ characterId: role.id, expectedRevision: 0, operationId: ACCEPTANCE + 'restore-c' });
  assert.equal(registry.list().some(entry => entry.id === role.id), false, '全程只有验收操作时保持隐藏');
});

test('隐藏不删除任何行：登记表与记忆记录都保持原样', async t => {
  const registry = await registryOf(t);
  registry.create({ id: 'accept-d', label: '验收角色D', operationId: ACCEPTANCE + 'create-d' });
  // 表行数才是「有没有删数据」的真实判据；list() 是过滤后的可见数，不等于行数。
  const count = () => (registry as unknown as { db: import('better-sqlite3').Database })
    .db.prepare('SELECT count(*) AS n FROM character_registry').get() as { n: number };
  const before = count().n;
  assert.ok(before >= 2, 'companion 与新建的验收角色都在表里');

  registry.list();
  registry.list();
  assert.equal(count().n, before, '反复读取列表不得增删角色登记行');
  assert.equal(registry.exists('accept-d'), true, '隐藏角色仍然可按 id 准入');
});

test('内部全量视图仍然看得见隐藏角色，否则留存清理会漏掉它们', async t => {
  const registry = await registryOf(t);
  const hidden = registry.create({ id: 'accept-e', label: '验收角色E', operationId: ACCEPTANCE + 'create-e' }).character;

  // 挑选面看不到它，记账面必须看得到。
  assert.equal(registry.list().some(entry => entry.id === hidden.id), false);
  assert.equal(registry.listAll().some(entry => entry.id === hidden.id), true,
    'listAll 必须包含隐藏角色：漏掉会让它们的记忆永远不被清理、persona 行不被补齐');

  // 用户角色在两面都在。
  const mine = registry.create({ id: 'mine-e', label: '我的角色E', operationId: 'user-create-e' }).character;
  assert.equal(registry.listAll().some(entry => entry.id === mine.id), true);
  assert.deepEqual(
    registry.list().map(e => e.id).sort(),
    registry.listAll().filter(e => registry.list().some(v => v.id === e.id)).map(e => e.id).sort(),
    'listAll 必须是 list 的超集，多出来的只有被隐藏的角色',
  );
});
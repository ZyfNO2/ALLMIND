// RWR-07 · HTTP 层的作者资料与角色简介
//
// 为什么这一层需要自己的测试：`optionalText` 的注释写着「显式传空表示清空」，但实现却走了会拒绝空串
// 的 `text()`，于是这条**自己承诺的契约在 HTTP 上无法表达**。store 层的清空测试（role-profile-metadata）
// 全绿，因为 store 的 `authorText` 本来就接受空串——缺陷只在 HTTP 边界，而这一层当时**没有任何测试**。
// 真实后果（浏览器自动化实测）：用户不填「角色简介」时，`PUT /api/characters/profile` 必然 400
// 「角色简介无效。」，于是**任何作者资料都保存不了**，而且报错指向一个用户根本没碰过的字段。
//
// 本文件锁定三条边界：
//   1. 显式空串 = 清空该字段（这是 `optionalText` 承诺的语义，必须可用）；
//   2. 字段缺省 = 不动该字段（两者绝不能混淆）；
//   3. 真正非法的输入（非字符串、超长、NUL）仍然是 invalid_request，不能被「放宽成清空」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { charactersRoute } from '../../management/character-routes.js';
import { RoleConfigurationStore } from '../../management/role-configuration.js';
import { ManagementError, type CharacterRegistryPort } from '../../contracts/management.js';
import type { CharacterDescriptor } from '../../contracts/character.js';

const ROLE = 'companion' as const;

test('RWR-11: known legacy role without author configuration reads empty metadata, unknown remains rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rwr11-legacy-profile-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const store = await RoleConfigurationStore.open({file:join(dir,'roles.json')});
  const registry = registryOf([ROLE]);
  const view = await charactersRoute('GET', registry, '/api/characters/profile', async()=>({}), store, undefined, new URLSearchParams({characterId:ROLE})) as {identity:{intro:string}};
  assert.equal(view.identity.intro,'');
  assert.ok(store.get(ROLE), 'legacy configuration is persisted through the real owner');
  await assert.rejects(() => charactersRoute('GET', registry, '/api/characters/profile', async()=>({}), store, undefined, new URLSearchParams({characterId:'unknown'})), {code:'not_found'});
  assert.equal(store.get('unknown'),null);
});

function registryOf(ids: string[]): CharacterRegistryPort {
  const known = new Set(ids);
  const descriptor = (id: string): CharacterDescriptor => ({
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
    selection: () => ({ savedCharacterId: ROLE, effectiveCharacterId: ROLE, selectionRevision: 0, effectiveSelectionRevision: 0, applyOn: 'restart' as const }),
    setSelection: () => { throw new Error('not used'); },
  };
}

async function profile(t: { after(fn: () => Promise<void> | void): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'rwr07-profile-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const file = join(dir, 'role-configurations.json');
  const store = await RoleConfigurationStore.open({ file });
  await store.save({
    characterId: ROLE, operationId: 'seed', label: ROLE,
    persona: { text: '原始人设正文' }, bindings: { dialogue: { mode: 'inherit-default' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } },
  } as never);
  return { store, registry: registryOf([ROLE]) };
}

const put = (
  registry: CharacterRegistryPort, store: RoleConfigurationStore, payload: Record<string, unknown>,
) => charactersRoute('PUT', registry, '/api/characters/profile', async () => payload, store) as Promise<{ fieldRevision: number; configuration: { identity: { intro: string }; persona: { scenario: string; firstMessage: string; exampleDialogue: string } } }>;

// 1 · 清空是可表达的 --------------------------------------------------------------------------------
test('RWR-07: 显式空串清空作者字段（optionalText 承诺的语义必须真的可用）', async t => {
  const { store, registry } = await profile(t);
  await put(registry, store, { characterId: ROLE, operationId: 'p-1', intro: '第一版简介', scenario: '第一版情境' });

  const cleared = await put(registry, store, { characterId: ROLE, operationId: 'p-2', intro: '', scenario: '' });

  assert.equal(cleared.configuration.identity.intro, '', '空串必须真的清空简介，而不是 400');
  assert.equal(cleared.configuration.persona.scenario, '', '空串必须真的清空情境');
  assert.equal(store.get(ROLE)!.identity.intro, '', '并且要落到持久层，不只是回执');
  assert.equal(store.get(ROLE)!.persona.scenario, '');
});

test('RWR-07: 浏览器实测场景——简介留空也能保存其它作者资料', async t => {
  const { store, registry } = await profile(t);
  // 这正是 roles-view 的现状：draft.intro 恒为 ''，用户只改了情境。修复前这里必然 400。
  const saved = await put(registry, store, {
    characterId: ROLE, operationId: 'p-3', intro: '', scenario: '住在隔壁的室友', firstMessage: '今天很晚吧。',
  });
  assert.equal(saved.configuration.persona.scenario, '住在隔壁的室友', '只改一个字段不该被另一个空字段阻塞');
  assert.equal(saved.configuration.identity.intro, '');
});

// 2 · 缺省与清空绝不混淆 -----------------------------------------------------------------------------
test('RWR-07: 字段缺省表示「不动」，与「清空」严格区分', async t => {
  const { store, registry } = await profile(t);
  await put(registry, store, { characterId: ROLE, operationId: 'p-4', intro: '保留的简介', scenario: '保留的情境' });

  const partial = await put(registry, store, { characterId: ROLE, operationId: 'p-5', intro: '' });

  assert.equal(partial.configuration.persona.scenario, '保留的情境', '未提及的情境必须原样保留');
  assert.equal(partial.configuration.identity.intro, '', '被显式提及为空串的简介才清空');
  assert.equal(store.get(ROLE)!.persona.scenario, '保留的情境');
});

// 3 · 真正的非法输入没有被放宽 -----------------------------------------------------------------------
test('RWR-07: 放宽只针对空串；非字符串/超长/NUL 仍是 invalid_request', async t => {
  const { store, registry } = await profile(t);
  for (const bad of [123, { a: 1 }, ['x'], 'x'.repeat(4001), 'bad\0text']) {
    await assert.rejects(
      put(registry, store, { characterId: ROLE, operationId: 'p-bad', scenario: bad as never }),
      (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
      `scenario=${JSON.stringify(bad)} 必须仍是 invalid_request，不能被「空串可清空」顺带放过`,
    );
  }
  await assert.rejects(
    put(registry, store, { characterId: ROLE, operationId: '', scenario: 'x' }),
    (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    '缺 operationId 仍然拒绝',
  );
  await assert.rejects(
    put(registry, store, { characterId: 'never-registered', operationId: 'p-6', intro: 'x' }),
    (error: unknown) => error instanceof ManagementError && error.code === 'not_found',
    '未注册角色仍然 not_found（CONTRACTS §6）',
  );
});

// 4 · 角色创建的 intro 走同一套语义 -------------------------------------------------------------------
test('RWR-07: POST /api/characters 的空 intro 被接受（同一处矛盾一并修掉）', async () => {
  const registry = registryOf([]);
  const created = await charactersRoute('POST', registry, '/api/characters', async () => ({ label: '角色C', intro: '', operationId: 'c-1' })) as { created: boolean; character: { id: string } };
  assert.equal(created.created, true, '空简介必须能创建成功，而不是 400');
  const rejected = await charactersRoute('POST', registryOf([]), '/api/characters', async () => ({ label: '角色D', intro: 42, operationId: 'c-2' }))
    .then(() => assert.fail('非字符串 intro 必须被拒绝'), (error: unknown) => assert.equal((error as ManagementError).code, 'invalid_request'));
  assert.equal(rejected, undefined);
});

// 5 · RWR-08 (B1)：新建角色立刻可写作者资料（创建路径播种 v2），保存路径仍对未注册角色 not_found ----
test('RWR-08 AC-B(B1): 新建角色的第一次作者保存成功；未注册角色仍是 not_found', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rwr08-b1-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const store = await RoleConfigurationStore.open({ file: join(dir, 'role-configurations.json') });
  const registry = registryOf([]);

  const created = await charactersRoute('POST', registry, '/api/characters', async () => ({ label: '角色B', operationId: 'b1-create' }), store) as { character: { id: string } };
  const roleId = created.character.id;
  assert.ok(store.get(roleId), '创建必须播种一份 inherit-default v2 配置');

  const saved = await charactersRoute('PUT', registry, '/api/characters/profile', async () => ({ characterId: roleId, operationId: 'b1-author', intro: '新建角色的第一版简介' }), store) as { fieldRevision: number; configuration: { identity: { intro: string } } };
  assert.equal(saved.configuration.identity.intro, '新建角色的第一版简介', '新建角色的第一次作者保存必须成功');
  assert.equal(saved.fieldRevision, 1);

  // 准入仍是注册表的职责：未注册角色不得被 v2 存储“顺手创建”。
  await assert.rejects(
    () => store.saveAuthorMetadata('never-registered-role', { intro: 'x', operationId: 'b1-unknown' }),
    (error: unknown) => error instanceof ManagementError && error.code === 'not_found',
    '未注册角色仍必须是 not_found（CONTRACTS §6）',
  );
});

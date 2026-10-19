/**
 * tests/companion-knowledge/character-publication.test.ts
 *
 * CK-08: persona / Wiki / Lorebook 确认发布与回退。
 *
 * AC-08-1: 编辑/选择/预览/确认/409/replay 真实 owner 一致；未发布或失败零活动改变。
 * AC-08-2: 任意阶段故障与重启后只有一个一致 effective set；未确认不提交。
 * AC-08-3: 发布后 effective 与所选版本一致；saved 不冒充 applied；回退与撤销被遵守。
 * AC-08-4: 未选域不动；其他角色/实例不被污染。
 *
 * 被测对象是本步新增的发布协调器；三个 owner 用结构端口替换为可观测替身，
 * 因此「是否经原 owner 提交」「是否被并发编辑抢占」这类性质能被直接断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CharacterPublicationCoordinator,
  PublicationConflictError,
  type PublicationOwnerSet,
  type PersonaPort,
  type PackPublishPort,
  type LorebookPort,
  type PreviewLorebook,
} from '../../management/character-distillation-publish.js';
import type { CharacterPack, CharacterPackDraft } from '../../contracts/character-pack.js';

const PAIRING = { userId: 'u-a', characterId: 'companion', characterInstanceId: 'inst-a' };

/** A persona owner that behaves like `memory.savePrompt`: optimistic revision + real storage. */
function personaOwner(initial = 1) {
  let revision = initial;
  let text = '原始人设';
  const saves: { expectedRevision: number; text: string }[] = [];
  const port: PersonaPort = {
    async revision() { return revision; },
    async save(input) {
      if (input.expectedRevision !== revision) throw new Error('人设修订已变化');
      saves.push({ expectedRevision: input.expectedRevision, text: input.text });
      revision += 1;
      text = input.text;
      return { text, revision };
    },
  };
  return { port, saves, snapshot: () => ({ revision, text }) };
}

function draft(overrides: Partial<CharacterPackDraft> = {}): CharacterPackDraft {
  return Object.freeze({
    id: 'cpd-1', characterId: 'companion', packVersion: 'draft-1', schemaVersion: '0.7-draft-1',
    status: 'validated',
    payload: {
      schemaVersion: '0.7-draft-1',
      character: { name: '阿航', soul: '在旧城区经营旧书店，偏好简洁的回复。' },
      canonFacts: [], gaps: [],
    },
    sourceIds: ['src-1'],
    validation: { valid: true, errors: [], validatedAt: '2026-10-07T02:00:00.000Z' },
    createdAt: '2026-10-07T02:00:00.000Z',
    ...overrides,
  }) as CharacterPackDraft;
}

function packOwner(d: CharacterPackDraft = draft(), options: { packRevision?: number; revoked?: string[]; failActivate?: string } = {}) {
  let packRevision = options.packRevision ?? 1;
  const activations: { characterId: string; draftId: string }[] = [];
  const revoked = new Set(options.revoked ?? []);
  const port: PackPublishPort = {
    getDraft: () => d,
    getPackRevision: () => packRevision,
    async activateDraft(params) {
      if (options.failActivate) throw new Error(options.failActivate);
      activations.push({ characterId: params.characterId, draftId: params.draftId });
      packRevision += 1;
      return { id: 'pack-new' } as CharacterPack;
    },
    // The real store exposes this; the coordinator probes it structurally.
    isSourceRevoked: (_characterId: string, sourceId: string) => revoked.has(sourceId),
  } as PackPublishPort;
  return { port: port as PackPublishPort, activations, packRevision: () => packRevision };
}

function lorebookOwner() {
  let revision = 0;
  const imports: { title: string; entryCount: number; operationId: string }[] = [];
  const port: LorebookPort = {
    revision: () => revision,
    get: () => null,
    commitImport(_owner, preview, operationId) {
      imports.push({ title: preview.title, entryCount: preview.entries.length, operationId });
      revision += 1;
      return { id: `lb-${revision}`, revision };
    },
  };
  return { port, imports, revision: () => revision };
}

const LOREBOOK: PreviewLorebook = {
  title: '阿航的故事书',
  entries: [
    { title: '旧书店', content: '阿航在旧城区经营一家旧书店。', strategy: 'always', keywords: [], enabled: true },
    { title: '清晨', content: '他每天清晨整理昨夜到货的新书。', strategy: 'keyword', keywords: ['新书'], enabled: true },
  ],
};

function coordinatorFor(parts: { persona: ReturnType<typeof personaOwner>; pack: ReturnType<typeof packOwner>; lorebook: ReturnType<typeof lorebookOwner> }, appliesNow = true) {
  const owners: PublicationOwnerSet = { persona: parts.persona.port, pack: parts.pack.port, lorebook: parts.lorebook.port };
  return new CharacterPublicationCoordinator({
    owners, pairingOf: () => PAIRING, appliesWithoutRestart: () => appliesNow,
  });
}

function partsWith(overrides: { d?: CharacterPackDraft; pack?: Parameters<typeof packOwner>[1]; appliesNow?: boolean } = {}) {
  const persona = personaOwner();
  const pack = packOwner(overrides.d ?? draft(), overrides.pack);
  const lorebook = lorebookOwner();
  return { persona, pack, lorebook, coordinator: coordinatorFor({ persona, pack, lorebook }, overrides.appliesNow ?? true) };
}

// ================================================================================================
// AC-08-1 预览/选择/确认/冲突/重放
// ================================================================================================

test('AC-08-1: 预览给出当前修订、拟发布内容与阻塞项', async () => {
  const p = partsWith();
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona'] });
  assert.deepEqual([...preview.blockers], [], '可发布草稿不应有阻塞项');
  assert.equal(preview.current.personaRevision, 1);
  assert.ok(preview.proposed.personaText?.includes('旧书店'), '预览必须显示拟发布的 persona 正文');
  assert.equal(preview.proposed.lorebookTitle, null, '未选域不得出现在拟发布内容中');
});

test('AC-08-1: 未确认不提交任何 owner', async () => {
  const p = partsWith();
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona', 'pack'] });
  await assert.rejects(
    p.coordinator.publish(preview.previewRef, {
      operationId: 'op-1', previewRef: preview.previewRef,
      expectedPersonaRevision: preview.current.personaRevision,
      expectedPackRevision: preview.current.packRevision, userConfirmed: false,
    }),
    (error: unknown) => error instanceof PublicationConflictError && error.code === 'not_confirmed',
  );
  assert.equal(p.persona.snapshot().revision, 1, '未确认不得改写 persona');
  assert.equal(p.pack.packRevision(), 1, '未确认不得激活角色包');
});

test('AC-08-1: 并发编辑使预览失效，发布被拒', async () => {
  const p = partsWith();
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona'] });
  // 用户在别处改了人设。
  await p.persona.port.save({ characterId: 'companion', expectedRevision: 1, text: '别人改的人设', operationId: 'other' });

  await assert.rejects(
    p.coordinator.publish(preview.previewRef, {
      operationId: 'op-1', previewRef: preview.previewRef,
      expectedPersonaRevision: preview.current.personaRevision,
      expectedPackRevision: preview.current.packRevision, userConfirmed: true,
    }),
    (error: unknown) => error instanceof PublicationConflictError && error.code === 'version_conflict',
    '并发编辑必须优先于旧预览',
  );
  assert.equal(p.persona.snapshot().text, '别人改的人设', '不得覆盖他人编辑');
});

test('AC-08-1: 同 operationId 重放同一回执；不同意图 409', async () => {
  const p = partsWith();
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona'] });
  const request = {
    operationId: 'op-1', previewRef: preview.previewRef,
    expectedPersonaRevision: preview.current.personaRevision,
    expectedPackRevision: preview.current.packRevision, userConfirmed: true,
  };
  const first = await p.coordinator.publish(preview.previewRef, request);
  const replay = await p.coordinator.publish(preview.previewRef, request);
  assert.equal(replay.activationSetId, first.activationSetId, '重放必须返回首次回执');
  assert.equal(p.persona.snapshot().revision, 2, '重放不得二次写入');

  const other = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona'] });
  await assert.rejects(
    p.coordinator.publish(other.previewRef, { ...request, previewRef: other.previewRef, expectedPersonaRevision: other.current.personaRevision }),
    (error: unknown) => error instanceof PublicationConflictError && error.code === 'version_conflict',
  );
});

test('AC-08-1: 失效预览（未 previewRef）被拒', async () => {
  const p = partsWith();
  await assert.rejects(
    p.coordinator.publish('prev-unknown', {
      operationId: 'op-1', previewRef: 'prev-unknown',
      expectedPersonaRevision: 1, expectedPackRevision: 1, userConfirmed: true,
    }),
    (error: unknown) => error instanceof PublicationConflictError && error.code === 'preview_expired',
  );
});

test('AC-08-1: 草稿未通过校验/来源被撤销时阻塞发布', async () => {
  const invalid = partsWith({ d: draft({ validation: { valid: false, errors: ['x'], validatedAt: '2026-10-07T02:00:00.000Z' } }) });
  const blocked = await invalid.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['pack'] });
  assert.ok(blocked.blockers.includes('draft_not_validated'));
  await assert.rejects(
    invalid.coordinator.publish(blocked.previewRef, {
      operationId: 'op-x', previewRef: blocked.previewRef,
      expectedPersonaRevision: blocked.current.personaRevision,
      expectedPackRevision: blocked.current.packRevision, userConfirmed: true,
    }),
    (error: unknown) => error instanceof PublicationConflictError && error.code === 'blocked',
  );

  const revoked = partsWith({ pack: { revoked: ['src-1'] } });
  const revokedPreview = await revoked.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['pack'] });
  assert.ok(revokedPreview.blockers.some(b => b.startsWith('source_revoked')), '来源撤销必须阻塞');
});

test('AC-08-1: 空选择被拒绝', async () => {
  const p = partsWith();
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: [] });
  assert.ok(preview.blockers.includes('empty_selection'));
});

// ================================================================================================
// AC-08-2 一致 effective set
// ================================================================================================

test('AC-08-2: 发布成功时 effective 与所选版本一致，未选域不动', async () => {
  const p = partsWith();
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona', 'lorebook'], lorebook: LOREBOOK });
  const receipt = await p.coordinator.publish(preview.previewRef, {
    operationId: 'op-1', previewRef: preview.previewRef,
    expectedPersonaRevision: preview.current.personaRevision,
    expectedPackRevision: preview.current.packRevision, userConfirmed: true,
  });
  assert.equal(receipt.failure, null);
  assert.equal(receipt.saved.persona, true);
  assert.equal(receipt.saved.lorebook, true);
  assert.equal(receipt.saved.pack, false, '未选域不得被发布');
  assert.equal(p.pack.activations.length, 0, '未选域不得激活角色包');
  assert.equal(p.persona.snapshot().text, '在旧城区经营旧书店，偏好简洁的回复。', 'persona 经 owner 提交');
  assert.equal(p.lorebook.imports.length, 1, '故事书经 owner 提交');
});

test('AC-08-2: 发布失败时旧 effective set 保持不变（不出现半新）', async () => {
  const p = partsWith({ pack: { failActivate: '角色包激活失败' } });
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona', 'pack'] });
  const before = p.coordinator.effectiveSet('companion');
  const receipt = await p.coordinator.publish(preview.previewRef, {
    operationId: 'op-1', previewRef: preview.previewRef,
    expectedPersonaRevision: preview.current.personaRevision,
    expectedPackRevision: preview.current.packRevision, userConfirmed: true,
  });
  assert.ok(receipt.failure, '失败必须被报告');
  assert.ok(receipt.failure?.startsWith('pack:'), '失败原因必须定位到域');
  // 关键：effective 未推进——不出现「新 persona + 旧包」的半套状态。
  assert.deepEqual(p.coordinator.effectiveSet('companion'), before, '失败不得推进 effective set');
  assert.equal(receipt.previousEffective.personaRevision, before.personaRevision, '旧有效集被保留在回执中');
});

test('AC-08-2: 故事书条目缺失时阻塞，不产生空故事书', async () => {
  const p = partsWith();
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['lorebook'] });
  assert.ok(preview.blockers.includes('lorebook_entries_missing'), '选中故事书却无条目必须阻塞');
  assert.equal(p.lorebook.imports.length, 0, '阻塞时不得写入');
});

// ================================================================================================
// AC-08-3 saved 不冒充 applied + 回退
// ================================================================================================

test('AC-08-3: 需重启生效时 saved=true 但 applied=false，并给出 applyOn', async () => {
  const p = partsWith({ appliesNow: false });
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['pack'] });
  const receipt = await p.coordinator.publish(preview.previewRef, {
    operationId: 'op-1', previewRef: preview.previewRef,
    expectedPersonaRevision: preview.current.personaRevision,
    expectedPackRevision: preview.current.packRevision, userConfirmed: true,
  });
  assert.equal(receipt.saved.pack, true, '确实已持久化');
  assert.equal(receipt.applied.pack, false, '尚未被运行中进程消费，不得冒充 applied');
  assert.equal(receipt.applyOn, 'restart', '必须明确告知何时生效');
});

test('AC-08-3: 即时生效时 applied 为 true', async () => {
  const p = partsWith({ appliesNow: true });
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona'] });
  const receipt = await p.coordinator.publish(preview.previewRef, {
    operationId: 'op-1', previewRef: preview.previewRef,
    expectedPersonaRevision: preview.current.personaRevision,
    expectedPackRevision: preview.current.packRevision, userConfirmed: true,
  });
  assert.equal(receipt.applied.persona, true);
  assert.equal(receipt.applyOn, 'now');
});

test('AC-08-3: 回退到前一有效集，且不覆盖更新的人工更正', async () => {
  const p = partsWith();
  const first = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona'] });
  const beforePublish = first.current;
  const receipt = await p.coordinator.publish(first.previewRef, {
    operationId: 'op-1', previewRef: first.previewRef,
    expectedPersonaRevision: first.current.personaRevision,
    expectedPackRevision: first.current.packRevision, userConfirmed: true,
  });
  assert.equal(receipt.saved.persona, true);

  const restored = p.coordinator.rollback('companion', beforePublish);
  assert.equal(restored.restored, true);
  assert.equal(restored.effective.personaRevision, beforePublish.personaRevision, '回退到发布前修订');

  // 回退到比当前更新的修订必须被拒——不得覆盖新的人工更正。
  const refused = p.coordinator.rollback('companion', { personaRevision: 99, packRevision: 1, lorebookRevision: null });
  assert.equal(refused.restored, false);
  assert.equal(refused.reason, 'rollback_would_overwrite_newer_persona');
});

// ================================================================================================
// AC-08-4 隔离
// ================================================================================================

test('AC-08-4: 其他角色的发布不受本次影响（按角色隔离 effective）', async () => {
  const p = partsWith();
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['persona'] });
  await p.coordinator.publish(preview.previewRef, {
    operationId: 'op-1', previewRef: preview.previewRef,
    expectedPersonaRevision: preview.current.personaRevision,
    expectedPackRevision: preview.current.packRevision, userConfirmed: true,
  });
  const other = p.coordinator.effectiveSet('other-character');
  assert.equal(other.personaRevision, 0, '其他角色不应被本角色的发布污染');
  assert.equal(other.packRevision, p.pack.packRevision(), 'pack 是共享存储，其修订按 owner 报告');
});

test('AC-08-4: 草稿角色与请求角色不符时阻塞', async () => {
  const p = partsWith({ d: draft({ characterId: 'other-character' }) });
  const preview = await p.coordinator.preview({ characterId: 'companion', draftId: 'cpd-1', selection: ['pack'] });
  assert.ok(preview.blockers.includes('draft_character_mismatch'), '不得把别的角色的草稿发布到本角色');
});

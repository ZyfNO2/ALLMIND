/**
 * TASK-EDIT-01 · 编辑 buffer 纯函数契约（目标断言，RED）。
 *
 * 目标 local buffer（[TASK-EDIT-01 SPEC](../../docs/next/followup-design/specs/TASK-EDIT-01.md)）：
 * `{context,draftId,baseDraftVersion,text,dirty,pendingAction,conflict}`，只归当前明确选中的任务；
 * 原话只读、当前整理稿可编辑。服务端推送同 draft 新 version 时：
 *   * 未编辑（dirty=false）→ 自动同步到新 version（textarea 不吞用户打字）；
 *   * dirty → 保留本地文本 + conflict 标记（提示版本变化，绝不自动覆盖/自动 confirm）；
 *   * 换 draft/换 context → buffer 解除（不挂给新卡）。
 * "保存修改" = revise（带 expectedVersion）；dirty/conflict 时不可 confirm。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginEdit, applyServerState, canConfirm } from '../../desktop/work-editor.mjs';

const cardState = draft => ({
  focus: 'work', stage: 'confirming', draft,
  confirmation: { id: 'req-1', version: 1, phase: 'awaiting_confirmation', text: draft.text, executor: 'codex' },
  requests: [], pendingCount: 0,
});
const draftV = (version, text) => ({ id: 'draft-1', version, text, originalText: '1111 原始请求', targets: [{ hostId: 'local', threadId: 't1', title: '任务一' }], projects: [] });
const CONTEXT = { characterId: 'companion', generation: 1 };

test('TASK-EDIT-01 beginEdit 生成目标 buffer：context/draftId/baseDraftVersion/text/dirty/conflict', () => {
  const buffer = beginEdit(cardState(draftV(2, '整理后的任务')), CONTEXT, { text: '整理后的任务' });
  assert.equal(buffer.context.characterId, 'companion');
  assert.equal(buffer.context.generation, 1);
  assert.equal(buffer.draftId, 'draft-1');
  assert.equal(buffer.baseDraftVersion, 2);
  assert.equal(buffer.text, '整理后的任务');
  assert.equal(buffer.dirty, false);
  assert.equal(buffer.conflict, false);
});

test('TASK-EDIT-01 未编辑时服务端新 version 自动同步；dirty 时保留本地并标记 conflict', () => {
  let buffer = beginEdit(cardState(draftV(2, '整理后的任务')), CONTEXT, { text: '整理后的任务' });
  // 未编辑：同 draft 新 version → 同步。
  const synced = applyServerState(buffer, cardState(draftV(3, '整理后的任务')));
  assert.equal(synced.baseDraftVersion, 3, '未编辑时同步到新 version');
  assert.equal(synced.conflict, false);
  // dirty：新 version 不覆盖文本。
  buffer = { ...buffer, dirty: true, text: '我改过的稿子' };
  const conflicted = applyServerState(buffer, cardState(draftV(3, '整理后的任务')));
  assert.equal(conflicted.text, '我改过的稿子', 'dirty 时保留本地文本');
  assert.equal(conflicted.baseDraftVersion, 2, '本地 base 不被静默推进');
  assert.equal(conflicted.conflict, true, '必须标记版本变化冲突');
});

test('TASK-EDIT-01 换 draft/换 context 解除 buffer，不挂给新卡', () => {
  let buffer = beginEdit(cardState(draftV(2, 'A 任务')), CONTEXT, { text: 'A' });
  buffer = { ...buffer, dirty: true };
  // 另一条 draft 的新 state：buffer 解除。
  const other = applyServerState(buffer, cardState(draftV(1, 'B 任务')), 'draft-2');
  assert.equal(other, null, '换 draft 后 buffer 解除');
  // 换 context（新 session/新角色）：同样解除。
  const nextContext = applyServerState(buffer, cardState(draftV(3, 'A 任务')), 'draft-1', { characterId: 'companion', generation: 2 });
  assert.equal(nextContext, null, 'generation 变化后 buffer 解除');
});

test('TASK-EDIT-01 dirty/conflict 不可 confirm；干净且版本匹配才可确认', () => {
  const clean = beginEdit(cardState(draftV(2, '整理后的任务')), CONTEXT, { text: '整理后的任务' });
  // 干净 buffer 仍视为编辑中：必须先保存/取消编辑才能确认（编辑器打开期间不产生语音/确认授权）。
  assert.equal(canConfirm(clean, { id: 'req-1', version: 1, phase: 'awaiting_confirmation' }), false, '编辑打开时不可 confirm');
  const dirty = { ...clean, dirty: true };
  assert.equal(canConfirm(dirty, { id: 'req-1', version: 1, phase: 'awaiting_confirmation' }), false);
  const conflicted = { ...clean, conflict: true };
  assert.equal(canConfirm(conflicted, { id: 'req-1', version: 1, phase: 'awaiting_confirmation' }), false);
  // 无编辑 buffer + 回执可确认形态 → 可确认（版本与卡片的一致性由 action 层的 expectedVersion 校验负责）。
  assert.equal(canConfirm(null, { id: 'req-1', version: 1, phase: 'awaiting_confirmation' }), true);
});

test('TASK-EDIT-01 原话只读：buffer 携带 originalText，编辑文本与原话分离', () => {
  const buffer = beginEdit(cardState(draftV(2, '整理后的任务')), CONTEXT, { text: '整理后的任务' });
  assert.equal(buffer.originalText, '1111 原始请求', '原话必须只读携带（来自 draft.originalText）');
  assert.notEqual(buffer.text, buffer.originalText);
});

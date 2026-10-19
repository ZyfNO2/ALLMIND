/**
 * TASK-EDIT-01 · WorkCard 编辑 buffer 行为（真实 card + 可查询的 DOM stub，派发 stub 计数）。
 *
 * buffer 语义（dirty 同步/冲突/解除）由 work-editor.test.mjs 的纯函数用例覆盖；本文件验证
 * **卡片集成**：编辑打开时确认门禁、conflict 时保存/确认禁用、换 draft/新 context 解除、
 * 原话只读块渲染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkCard } from '../../desktop/work-card.mjs';

const draftV = (version, text) => ({ id: 'draft-1', version, text, originalText: '1111 原始请求', targets: [{ hostId: 'local', threadId: 't1', title: '任务一' }], projects: [] });
const stateV = (version, text, sequence = 1) => ({
  sequence, focus: 'work', stage: 'confirming',
  draft: draftV(version, text),
  confirmation: { id: 'req-1', version: 1, phase: 'awaiting_confirmation', text, executor: 'codex' },
  requests: [], pendingCount: 0,
});

/** A tiny queryable DOM: createElement registers top-level nodes into a forest; get(id) searches it. */
function rig() {
  const forest = [], fixed = new Map();
  const find = (nodes, id) => { for (const node of nodes) { if (node.id === id) return node; const found = node.children?.length ? find(node.children, id) : undefined; if (found) return found; } return undefined; };
  globalThis.document = {
    activeElement: null,
    createElement: tag => { const el = { tagName: String(tag).toUpperCase(), children: [], dataset: {}, hidden: false, disabled: false, textContent: '', value: '', className: '', append: (...kids) => { el.children.push(...kids); for (const kid of kids) if (kid && typeof kid === 'object') forest.push(kid); }, replaceChildren: (...kids) => { el.children = kids; for (const kid of kids) if (kid && typeof kid === 'object') forest.push(kid); }, setAttribute: () => {}, onclick: null, oninput: null }; forest.push(el); return el; },
  };
  const get = id => {
    // Fixed containers the card always touches; test targets come from the forest.
    if (['work-badge', 'work-card', 'work-actions', 'drawer', 'conversation'].includes(id)) {
      if (!fixed.has(id)) fixed.set(id, { id, hidden: false, children: [], dataset: {}, textContent: '', scrollTop: 0, replaceChildren: (...kids) => { const el = fixed.get(id); el.children = kids; for (const kid of kids) if (kid && typeof kid === 'object') forest.push(kid); }, append: (...kids) => { const el = fixed.get(id); el.children.push(...kids); for (const kid of kids) if (kid && typeof kid === 'object') forest.push(kid); }, setAttribute: () => {} });
      return fixed.get(id);
    }
    return find(forest, id);
  };
  const sent = [];
  const card = new WorkCard({ get, send: message => sent.push(message), open: () => {}, onToggle: () => {}, onRecords: () => {}, onState: () => {} });
  card.setEditorContext({ characterId: 'companion', generation: 1 });
  return { card, get, sent };
}

test('TASK-EDIT-01 编辑打开时确认禁用（buffer 门禁）；dirty/conflict 时保存与确认都禁用', () => {
  const { card, get, sent } = rig();
  card.receive(stateV(2, '整理后的任务', 1));
  card.beginEdit();
  assert.ok(card.edit, 'beginEdit 打开编辑 buffer');
  card.render();
  assert.equal(get('work-confirm')?.disabled, true, '编辑打开时确认禁用（无语音/输入授权）');
  card.edit = { ...card.edit, dirty: true, text: '我改过的稿子' };
  card.receive(stateV(3, '整理后的任务', 2));
  assert.equal(card.edit.conflict, true, 'dirty 遇新版本标记 conflict');
  assert.equal(card.edit.text, '我改过的稿子', '本地文本保留');
  card.render();
  assert.equal(get('work-save')?.disabled, true, 'conflict 时保存禁用');
  assert.equal(get('work-confirm')?.disabled, true, 'conflict 时确认禁用');
  assert.equal(sent.filter(m => m.action?.type === 'confirm').length, 0, '全程零 confirm 派发');
});

test('TASK-EDIT-01 未编辑 buffer 收新版本自动同步；换 draft/新 context 解除', () => {
  const { card } = rig();
  card.receive(stateV(2, '整理后的任务', 1));
  card.beginEdit();
  card.receive(stateV(3, '整理后的任务', 2));
  assert.equal(card.edit.baseDraftVersion, 3, '未编辑时同步到新 version');
  assert.equal(card.edit.conflict, false);
  const other = { ...stateV(1, '另一任务', 3), draft: { ...draftV(1, '另一任务'), id: 'draft-2' } };
  card.receive(other);
  assert.equal(card.edit, null, '换 draft 后 buffer 解除');
  card.receive(stateV(2, '整理后的任务', 4));
  card.beginEdit();
  card.setEditorContext({ characterId: 'companion', generation: 2 });
  assert.equal(card.edit, null, '新 context 解除 buffer');
});

test('TASK-EDIT-01 编辑表单含原话只读块', () => {
  const { card, get } = rig();
  card.receive(stateV(2, '整理后的任务', 1));
  card.beginEdit();
  card.render();
  const form = get('work-edit-form');
  assert.ok(form, '编辑表单必须渲染');
  assert.ok(JSON.stringify(form.children).includes('1111 原始请求'), '编辑表单必须含原话只读块');
});

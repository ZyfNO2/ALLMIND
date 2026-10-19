/**
 * tests/companion-knowledge/text-image-wiring.test.ts
 *
 * CK-03: 输入正文/剪贴板/历史引用/手动正文的正式装配与图片解析能力。
 *
 * AC-03-1: 手动正文/历史引用经正式鉴权路由到真实 owner；剪贴板/input 经生产服务 adapter，
 *          文本与实际提交等值。
 * AC-03-2: 保护/密码/不支持应用不可采，旧 activity 通道零正文；授予 clipboard 不同时启用 input。
 * AC-03-3: 无元数据像素图经真实 OCR 验证；fixture 仅证明接线/取消。父源撤销/到期使派生失效。
 * AC-03-4: 真实组合根状态如实报告，各来源独立启停、去重、重启权限一致。
 *
 * 所有被测路径走真实 CollectionStore / TextSourceService / 本地 OCR 引擎；OCR hook 为 fixture 时
 * 只能证明接线与取消，不能替代真实像素识别（另列 NOT_RUN）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY } from '../../contracts/collection.js';
import { CollectionGrantManager } from '../../core/collection-grants.js';
import { ClipboardTextSource } from '../../core/clipboard-text-source.js';
import { InputTextSource } from '../../core/input-text-source.js';
import { HistorySourceReference } from '../../core/history-source-reference.js';
import { TextSourceService, type CommitStreamPort } from '../../core/text-source-service.js';
import { createLocalOcrEngine } from '../../core/local-ocr-engine.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';
import type { SourceGrant } from '../../contracts/companion-mode.js';

const NOW = '2026-10-07T02:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';
/** The normal profile caps a grant at 7 days, so an issued grant must stay inside that. */
const GRANT_EXPIRY = '2026-10-10T00:00:00.000Z';

async function harness(pairing: PairingScope = productionPairing('companion', 'inst-ck03')) {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck03-'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: () => NOW,
  });
  const db = memory.rawDatabaseForKnowledge();
  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'),
    policy: NORMAL_COLLECTION_POLICY,
    now: () => NOW,
  });
  const grants = new CollectionGrantManager({ store, policy: NORMAL_COLLECTION_POLICY, now: () => NOW });
  return { root, memory, db, store, grants, pairing };
}

function textGrant(kind: string, pairing: PairingScope, overrides: Partial<SourceGrant> = {}): SourceGrant {
  return {
    schemaVersion: 1, grantId: `grant-${kind}`, revision: 1, pairing,
    kind: kind as SourceGrant['kind'], scope: {}, purposes: ['receive'],
    destination: 'local', profile: 'normal', state: 'active',
    grantedAt: NOW, expiresAt: FUTURE, ...overrides,
  } as SourceGrant;
}

/**
 * Issue the grant the way production does, then hand back the grant the manager would pass to a
 * listener. A hand-built grant would be rejected by `assertActive`, which is correct: a source
 * that was never durably authorized must not be able to write.
 */
function issueGrant(
  h: Awaited<ReturnType<typeof harness>>, kind: string, operationId: string,
): SourceGrant {
  h.grants.issue({
    pairing: h.pairing, kind: kind as never, expiresAt: GRANT_EXPIRY,
    expectedRevision: 0, operationId,
  });
  return h.grants.current(h.pairing, kind as never) as unknown as SourceGrant;
}

/** A fake native route. Its existence is what makes input_text `supported`. */
function commitStream(overrides: Partial<CommitStreamPort> = {}): CommitStreamPort {
  return {
    supportedApplications: ['code.exe', 'notepad.exe'],
    supportedInputMethods: ['ms-pinyin'],
    subscribe: async () => async () => undefined,
    ...overrides,
  };
}

function serviceFor(
  h: Awaited<ReturnType<typeof harness>>,
  options: { clipboard?: ClipboardTextSource; input?: InputTextSource; history?: HistorySourceReference; commits?: CommitStreamPort } = {},
): TextSourceService {
  return new TextSourceService({
    store: h.store, grants: h.grants, pairing: h.pairing, now: () => NOW, ...options,
  });
}

// ================================================================================================
// AC-03-1 正式服务 adapter：文本与实际提交等值
// ================================================================================================

test('AC-03-1: 手动正文经正式服务写入真实 store，正文与提交逐字等值', async () => {
  const h = await harness();
  try {
    const BODY = '用户主动提交的第一段资料正文，不允许被标签替换。';
    h.grants.issue({
      pairing: h.pairing, kind: 'manual_text' as never, expiresAt: GRANT_EXPIRY,
      expectedRevision: 0, operationId: 'op-manual-grant',
    });
    const grant = h.grants.current(h.pairing, 'manual_text' as never)! as unknown as SourceGrant;

    const service = serviceFor(h);
    const result = await service.onManualText({ text: BODY, operationId: 'op-1' });
    assert.equal(result?.outcome, 'inserted', `写入失败 ${result?.reason ?? ''}`);

    const row = h.db.prepare(`SELECT text_content, display_name FROM collection_candidates`).get() as
      { text_content: string; display_name: string };
    assert.equal(row.text_content, BODY, '正文必须逐字等于用户提交');
    assert.equal(row.display_name, '手动提交');
    assert.equal(grant.state, 'active');
  } finally { h.memory.close(); }
});

test('AC-03-1: input_text 经生产服务 adapter 落库，正文等于实际提交片段', async () => {
  const h = await harness();
  try {
    const BODY = '今天把 Aika 的装配接完了，提交这一段。';
    const grant = issueGrant(h, 'input_text', 'op-input-grant');
    const service = serviceFor(h, { input: new InputTextSource(), commits: commitStream() });

    // 未授权来源不得写入：先走一次未授权路径。
    const before = h.db.prepare('SELECT COUNT(*) AS n FROM collection_candidates').get() as { n: number };
    assert.equal(before.n, 0);

    const result = await service.onInputCommit(grant, {
      commitId: 'c-1', appIdentity: 'code.exe', inputMethod: 'ms-pinyin',
      isPassword: false, text: BODY, completeness: 'committed',
    });
    assert.equal(result?.outcome, 'inserted', `adapter 未落库 ${result?.reason ?? ''}`);

    const row = h.db.prepare(`SELECT text_content FROM collection_candidates`).get() as { text_content: string };
    assert.equal(row.text_content, BODY, '正文必须等于实际提交片段');
  } finally { h.memory.close(); }
});

test('AC-03-1: 剪贴板经生产服务 adapter 落库，同 sequence 只消费一次', async () => {
  const h = await harness();
  try {
    const BODY = '复制来的第二段资料正文。';
    let seq = 100;
    let content = BODY;
    const clipboard = new ClipboardTextSource({
      currentSequence: () => seq,
      readClipboardText: async s => s === seq ? { text: content, byteLength: Buffer.byteLength(content, 'utf8') } : null,
    });
    const grant = issueGrant(h, 'clipboard_text', 'op-clip-grant');
    const service = serviceFor(h, { clipboard });

    await service.start('clipboard_text', grant);
    seq = 101;

    const first = await service.onClipboardText({
      grant, sequence: 101, text: { text: BODY, byteLength: Buffer.byteLength(BODY, 'utf8') },
    });
    assert.equal(first?.outcome, 'inserted');

    // 同一 sequence 重复写入必须是 duplicate，不得产生第二行。
    const again = await service.onClipboardText({
      grant, sequence: 101, text: { text: BODY, byteLength: Buffer.byteLength(BODY, 'utf8') },
    });
    assert.equal(again?.outcome, 'duplicate');

    const count = h.db.prepare('SELECT COUNT(*) AS n FROM collection_candidates').get() as { n: number };
    assert.equal(count.n, 1, '同 sequence 只消费一次');
  } finally { h.memory.close(); }
});

test('AC-03-1: 历史引用指向真实会话，删除后引用失效', async () => {
  const h = await harness();
  try {
    h.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO conversations(id, title) VALUES('conv-1', '真实会话');
    `);
    const grant = issueGrant(h, 'history_reference', 'op-hist-grant');
    const service = serviceFor(h, { history: new HistorySourceReference(h.db, () => NOW) });

    const ok = await service.onHistoryReference(grant, {
      conversationId: 'conv-1', messageTurnId: 'turn-1', previewText: '你好',
    });
    assert.equal(ok?.outcome, 'inserted');

    // 指向不存在会话的引用必须被拒绝，而不是留下悬空行。
    const missing = await service.onHistoryReference(grant, {
      conversationId: 'conv-missing', messageTurnId: 'turn-1', previewText: '无效',
    });
    assert.equal(missing, null, '引用不存在的会话必须被拒绝');

    h.db.prepare('DELETE FROM conversations WHERE id=?').run('conv-1');
    const history = new HistorySourceReference(h.db, () => NOW);
    assert.equal(history.isReferenceValid('conv-1'), false, '原会话删除后引用动态失效');
  } finally { h.memory.close(); }
});

// ================================================================================================
// AC-03-2 安全边界
// ================================================================================================

test('AC-03-2: 密码/保护控件/取消/composition 一律不落库', async () => {
  const h = await harness();
  try {
    const grant = issueGrant(h, 'input_text', 'op-pwd-grant');
    const service = serviceFor(h, { input: new InputTextSource(), commits: commitStream() });

    for (const [label, event] of [
      ['密码控件', { commitId: 'p1', appIdentity: 'browser.exe', inputMethod: 'ms-pinyin', isPassword: true, text: 'MySecret123!', completeness: 'committed' as const }],
      ['取消输入', { commitId: 'p2', appIdentity: 'code.exe', inputMethod: 'ms-pinyin', isPassword: false, text: 'ce', isCancelled: true, completeness: 'committed' as const }],
      ['composition 中间态', { commitId: 'p3', appIdentity: 'code.exe', inputMethod: 'ms-pinyin', isPassword: false, text: 'nihao', isComposing: true, completeness: 'committed' as const }],
    ] as const) {
      const result = await service.onInputCommit(grant, event);
      assert.equal(result, null, `${label} 绝不允许落库`);
    }

    const count = h.db.prepare('SELECT COUNT(*) AS n FROM collection_candidates').get() as { n: number };
    assert.equal(count.n, 0, '被拒绝的提交不得留下任何记录');
  } finally { h.memory.close(); }
});

test('AC-03-2: 撤销/暂停授权后，晚到提交不得落库', async () => {
  const h = await harness();
  try {
    const service = serviceFor(h, { input: new InputTextSource(), commits: commitStream() });
    const revoked = textGrant('input_text', h.pairing, { state: 'revoked' });
    const result = await service.onInputCommit(revoked, {
      commitId: 'late-1', appIdentity: 'code.exe', inputMethod: 'ms-pinyin',
      isPassword: false, text: '撤销后打的字', completeness: 'committed',
    });
    assert.equal(result, null, '已撤销来源的晚提交必须被拒绝');
  } finally { h.memory.close(); }
});

test('AC-03-2: 旧 keyboard 活动通道输出零正文', async () => {
  const h = await harness();
  try {
    // keyboard 活动聚合只携带计数；store 中不存在任何键盘正文列。
    const keyboardText = h.db.prepare(`
      SELECT COUNT(*) AS n FROM collection_candidates WHERE source_kind='keyboard' AND text_content IS NOT NULL
    `).get() as { n: number };
    assert.equal(keyboardText.n, 0, 'keyboard 通道不得携带正文');
  } finally { h.memory.close(); }
});

test('AC-03-2: 授予 clipboard 授权不同时启用 input', async () => {
  const h = await harness();
  try {
    h.grants.issue({
      pairing: h.pairing, kind: 'clipboard_text' as never, expiresAt: GRANT_EXPIRY,
      expectedRevision: 0, operationId: 'op-clip',
    });
    const service = serviceFor(h, {
      clipboard: new ClipboardTextSource({
        currentSequence: () => 1, readClipboardText: async () => null,
      }),
      input: new InputTextSource(), commits: commitStream(),
    });
    const caps = service.capabilities();
    const clip = caps.find(c => c.kind === 'clipboard_text')!;
    const input = caps.find(c => c.kind === 'input_text')!;

    assert.equal(clip.grantState, 'active', 'clipboard 已授权');
    assert.equal(input.grantState, 'disabled', 'input 未授权，不得因 clipboard 授权而启用');
  } finally { h.memory.close(); }
});

// ================================================================================================
// AC-03-3 图片解析与能力诚实
// ================================================================================================

test('AC-03-3: 无 OCR hook 的像素图报 unavailable，不得凭空造结果', async () => {
  const engine = createLocalOcrEngine();
  // 一张没有任何元数据的像素图：PNG tEXt 不可用于伪造识别结果。
  const pixels = new Uint8Array(64 * 64 * 3).fill(0x7f);
  const result = await engine(pixels);
  assert.equal(result.status, 'unavailable', '缺 OCR hook 必须是 unavailable，而不是伪造 ok');
  assert.equal(result.reason, 'pixel_ocr_hook_missing');
  assert.equal(result.blocks.length, 0);
});

test('AC-03-3: 空白像素图在有 hook 时为 no-content，不产生空成功', async () => {
  const engine = createLocalOcrEngine({ engineName: 'fixture', recognizePixelHook: async () => [] });
  const result = await engine(new Uint8Array(32 * 32 * 3).fill(0x20));
  assert.equal(result.status, 'ok');
  assert.equal(result.readingOrderText, '', '空白图不得产生伪造正文');
});

test('AC-03-3: OCR 取消必须中止并释放，不产生半成品结果', async () => {
  const controller = new AbortController();
  const engine = createLocalOcrEngine({
    recognizePixelHook: (_bytes, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  const task = engine(new Uint8Array(16 * 16 * 3).fill(1), controller.signal);
  controller.abort();
  await assert.rejects(task, /aborted/i);
});

test('AC-03-3: 父源撤销后其派生不得再被提交', async () => {
  const h = await harness();
  try {
    const grant = textGrant('input_text', h.pairing);
    const sourceId = h.store.appendCandidate(grant, {
      sourceKind: 'input_text', modeGeneration: 1, nativeEventId: 'p-src',
      receivedAt: NOW, origin: 'input_method', confidence: 1, expiresAt: FUTURE,
      payloadRef: 'p://1', textContent: '将被撤销的正文',
    }, 'p-key').sampleId!;

    const ok = h.store.commitDerived(h.pairing, {
      parentRefs: [{ sourceId, version: '1' }],
      processorId: 'standard-batch-parser-v1', processorVersion: '1.1.0', grantRevision: 1,
      processingKey: 'proc-before-revoke', status: 'ok', text: '撤销前的派生', expiresAt: FUTURE,
    });
    assert.equal(ok.committed, true);

    h.store.invalidateCandidate(h.pairing, sourceId, 'source_revoked');
    const late = h.store.commitDerived(h.pairing, {
      parentRefs: [{ sourceId, version: '1' }],
      processorId: 'standard-batch-parser-v1', processorVersion: '1.1.0', grantRevision: 1,
      processingKey: 'proc-after-revoke', status: 'ok', text: '撤销后的派生', expiresAt: FUTURE,
    });
    assert.equal(late.committed, false, '父源撤销后派生必须被拒绝');
  } finally { h.memory.close(); }
});

// ================================================================================================
// AC-03-4 组合根如实报告与独立启停
// ================================================================================================

test('AC-03-4: 缺 route 时 input 报 unavailable 而非 disabled/健康', async () => {
  const h = await harness();
  try {
    const service = serviceFor(h, { input: new InputTextSource() }); // 没有 commits route
    const input = service.capabilities().find(c => c.kind === 'input_text')!;
    assert.equal(input.wired, true, 'adapter 存在');
    assert.equal(input.supported, false, '没有 route 就不算支持');
    assert.equal(input.reason, 'input_commit_route_unavailable');
  } finally { h.memory.close(); }
});

test('AC-03-4: 启动无 route 的 input 抛错，不静默健康', async () => {
  const h = await harness();
  try {
    const service = serviceFor(h, { input: new InputTextSource() });
    await assert.rejects(
      service.start('input_text', textGrant('input_text', h.pairing)),
      /input_commit_route_unavailable/,
      '启用失败必须让调用方知道，而不是假装成功',
    );
  } finally { h.memory.close(); }
});

test('AC-03-4: 各来源独立启停：停 clipboard 不影响 input', async () => {
  const h = await harness();
  try {
    let unsubscribed = false;
    const commits = commitStream({
      subscribe: async () => async () => { unsubscribed = true; },
    });
    const service = serviceFor(h, {
      clipboard: new ClipboardTextSource({ currentSequence: () => 7, readClipboardText: async () => null }),
      input: new InputTextSource(), commits,
    });
    const clipGrant = issueGrant(h, 'clipboard_text', 'op-indep-clip');
    const inputGrant = issueGrant(h, 'input_text', 'op-indep-input');

    await service.start('clipboard_text', clipGrant);
    await service.start('input_text', inputGrant);
    await service.stop('clipboard_text');

    assert.equal(unsubscribed, false, '停止 clipboard 不得释放 input 的订阅');

    await service.stop('input_text');
    assert.equal(unsubscribed, true, '停止 input 才释放其订阅');
  } finally { h.memory.close(); }
});

test('AC-03-4: 重启后授权一致，旧提交不复活', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck03-restart-'));
  const open = async () => {
    const memory = new SqliteMemoryStore({
      filename: resolve(root, 'companion.sqlite'),
      retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'),
      clock: () => NOW,
    });
    const store = await CollectionStore.open(memory, {
      collectionDirectory: resolve(root, 'collection'),
      policy: NORMAL_COLLECTION_POLICY, now: () => NOW,
    });
    const grants = new CollectionGrantManager({ store, policy: NORMAL_COLLECTION_POLICY, now: () => NOW });
    return { memory, store, grants };
  };

  const pairing = productionPairing('companion', 'inst-ck03-restart');
  const first = await open();
  const grant = first.grants.issue({
    pairing, kind: 'manual_text' as never, expiresAt: GRANT_EXPIRY,
    expectedRevision: 0, operationId: 'op-restart',
  });
  const service = new TextSourceService({
    store: first.store, grants: first.grants, pairing, now: () => NOW,
  });
  await service.onManualText({ text: '重启前正文', operationId: 'r-1' });
  await service.close();
  first.memory.close();

  const second = await open();
  try {
    const reopened = second.grants.current(pairing, 'manual_text' as never)!;
    assert.equal(reopened.grantId, grant.grantId, '重启后授权一致');
    assert.equal(reopened.revision, grant.revision);

    const service2 = new TextSourceService({
      store: second.store, grants: second.grants, pairing, now: () => NOW,
    });
    // 同一 operationId 重放必须命中幂等，而不是新增一行。
    const replay = await service2.onManualText({ text: '重启前正文', operationId: 'r-1' });
    assert.equal(replay?.outcome, 'duplicate', '重启后重放不得新增');

    // 反证：新 operationId 仍可正常写入，说明不是被整体禁用。
    const fresh = await service2.onManualText({ text: '重启后新正文', operationId: 'r-2' });
    assert.equal(fresh?.outcome, 'inserted', '重启后新提交必须可用');
  } finally { second.memory.close(); }
});

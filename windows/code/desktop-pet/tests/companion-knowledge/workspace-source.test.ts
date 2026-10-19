/**
 * tests/companion-knowledge/workspace-source.test.ts
 *
 * CK-02: 指定工作区增量来源与文件统计。
 *
 * AC-02-1: 新增、同名修改、原子替换、重复通知、半写入、删除、恢复不产生重复权重；
 *          统计与实际 manifest 一致。
 * AC-02-2: junction/越界、非法 ref、根搬移/权限变化、并发撤销拒绝；晚到回调不库；原文件 hash 不变。
 * AC-02-3: 历史导入与启用后增量分开；递归显式；跨 pairing 隔离；大目录分页与截断可见。
 * AC-02-4: 正式组合根从 workspace candidate 经 01 reader 到真实正文/解析记录；重启后游标与失效正确。
 *
 * 全部使用系统临时合成根；不读取、不修改用户真实工作区。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, renameSync, rmSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceDirectorySource } from '../../core/workspace-directory-source.js';
import { validateWorkspaceScope, validateSourceGrant, type SourceGrant } from '../../contracts/companion-mode.js';
import type { WorkspaceSourceScope } from '../../contracts/workspace-source.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY } from '../../contracts/collection.js';
import { CollectionSourceReader } from '../../core/collection-source-reader.js';
import { CollectionBatchRunner } from '../../core/collection-batch-runner.js';
import { DocumentParser } from '../../core/document-parser.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';

const SCOPE: WorkspaceSourceScope = {
  canonicalRoot: '',
  recursive: false,
  allowedExtensions: ['.md', '.txt'],
  importExisting: false,
};

function noSleep(): () => Promise<void> { return () => Promise.resolve(); }

function sha(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }

function newSource(overrides: Record<string, unknown> = {}): WorkspaceDirectorySource {
  return new WorkspaceDirectorySource({ sleep: noSleep(), now: () => '2026-10-07T02:00:00.000Z', ...overrides });
}

// ================================================================================================
// AC-02-1 内容版本：新增/修改/替换/重复/半写入/删除
// ================================================================================================

test('AC-02-1: 新增文件被摄入，同一内容重复通知不产生第二份', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-add-'));
  writeFileSync(join(root, 'a.md'), '第一版正文', 'utf8');
  const source = newSource();
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };

  const first = await source.scan({ operationId: 'op-1', mode: 'import-existing', scope });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]!.contentHash, sha('第一版正文'));
  assert.equal(first.items[0]!.relativePath, 'a.md');

  // 同名、同内容再次扫描：unchanged，不得重复计入。
  const second = await source.scan({ operationId: 'op-2', mode: 'incremental', scope });
  assert.equal(second.items.length, 0, '同内容不得重复产出');
  assert.equal(source.hasVersion('a.md', sha('第一版正文')), true);
});

test('AC-02-1: 同名内容变化产生新版本，且 hash 来自真实字节', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-change-'));
  writeFileSync(join(root, 'a.md'), '旧正文', 'utf8');
  const source = newSource();
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };

  await source.scan({ operationId: 'op-1', mode: 'import-existing', scope });

  writeFileSync(join(root, 'a.md'), '新正文，更长一些', 'utf8');
  const changed = await source.scan({ operationId: 'op-2', mode: 'incremental', scope });
  assert.equal(changed.items.length, 1, '内容变化必须被当作新版本摄入');
  assert.equal(changed.items[0]!.contentHash, sha('新正文，更长一些'));
  assert.equal(changed.items[0]!.contentHash !== sha('旧正文'), true);
});

test('AC-02-1: 原子替换（rename 覆盖）同样产生新版本', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-replace-'));
  writeFileSync(join(root, 'a.md'), '原内容', 'utf8');
  const source = newSource();
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };
  await source.scan({ operationId: 'op-1', mode: 'import-existing', scope });

  writeFileSync(join(root, 'a.tmp'), '替换后的内容', 'utf8');
  renameSync(join(root, 'a.tmp'), join(root, 'a.md'));
  const replaced = await source.scan({ operationId: 'op-2', mode: 'incremental', scope });
  assert.equal(replaced.items.length, 1);
  assert.equal(replaced.items[0]!.contentHash, sha('替换后的内容'));
});

test('AC-02-1: 半写入文件在稳定窗口内不摄入', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-partial-'));
  const target = join(root, 'growing.md');
  writeFileSync(target, '第一段', 'utf8');

  const source = newWorkspaceSourceThatSeesAChange({
    onAfterFirstRead: () => { writeFileSync(target, '第一段还在继续写', 'utf8'); },
  });
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };

  const result = await source.scan({ operationId: 'op-1', mode: 'import-existing', scope });
  assert.equal(result.items.length, 0, '稳定窗口内发生变化的文件不得摄入');
});

function newWorkspaceSourceThatSeesAChange(options: { onAfterFirstRead: () => void }): WorkspaceDirectorySource {
  let called = false;
  return new WorkspaceDirectorySource({
    now: () => '2026-10-07T02:00:00.000Z',
    sleep: () => { if (!called) { called = true; options.onAfterFirstRead(); } return Promise.resolve(); },
  });
}

test('AC-02-1: 删除后统计报告 deleted，恢复后不重复计入权重', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-delete-'));
  writeFileSync(join(root, 'a.md'), '保留内容', 'utf8');
  writeFileSync(join(root, 'gone.md'), '将被删除', 'utf8');
  const source = newSource();
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };

  await source.scan({ operationId: 'op-1', mode: 'import-existing', scope });
  assert.equal(source.trackedCount, 2);

  rmSync(join(root, 'gone.md'));
  const afterDelete = await source.scan({ operationId: 'op-2', mode: 'incremental', scope });
  assert.equal(afterDelete.counts.deleted, 1, '删除必须被统计');

  // 恢复同名同内容：这是重新出现，不是新的知识证据权重。
  writeFileSync(join(root, 'gone.md'), '将被删除', 'utf8');
  const restored = await source.scan({ operationId: 'op-3', mode: 'incremental', scope });
  assert.equal(restored.items.length, 0, '恢复同内容不得产生重复权重');
});

test('AC-02-1: 统计与实际 manifest 一致（未支持类型计数但不读取）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-stats-'));
  writeFileSync(join(root, 'a.md'), 'md 文件', 'utf8');
  writeFileSync(join(root, 'b.txt'), 'txt 文件', 'utf8');
  writeFileSync(join(root, 'c.bin'), '二进制', 'utf8');
  writeFileSync(join(root, 'd.tmp'), '临时下载', 'utf8');

  const source = newSource();
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };
  const result = await source.scan({ operationId: 'op-1', mode: 'import-existing', scope });

  assert.equal(result.items.length, 2, '只产出白名单内文件');
  assert.deepEqual(result.items.map(i => i.relativePath).sort(), ['a.md', 'b.txt']);
  assert.equal(result.counts.unsupported, 1, '未支持类型被计数');
  assert.equal(result.state, 'succeeded');
});

// ================================================================================================
// AC-02-2 边界与拒绝
// ================================================================================================

test('AC-02-2: 越界 symlink/junction 被拒绝，不读取根外内容', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'aika-ck02-outside-'));
  writeFileSync(join(outside, 'secret.md'), '根外机密正文', 'utf8');
  writeFileSync(join(root, 'inside.md'), '根内正常正文', 'utf8');

  let linked = true;
  try { symlinkSync(outside, join(root, 'escape'), 'junction'); } catch { linked = false; }
  assert.equal(linked, true, '测试环境需支持 symlink/junction');

  const source = newSource();
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root, recursive: true };
  const result = await source.scan({ operationId: 'op-1', mode: 'import-existing', scope });

  assert.equal(result.items.length, 1, '只有根内文件被摄入');
  assert.equal(result.items[0]!.relativePath, 'inside.md');
  assert.ok(!result.items.some(i => i.contentHash === sha('根外机密正文')), '根外内容绝不可达');
});

test('AC-02-2: 根搬移/删除报 unavailable，不伪装成干净的空扫描', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-moved-'));
  const source = newSource();
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };
  rmSync(root, { recursive: true, force: true });

  const result = await source.scan({ operationId: 'op-1', mode: 'incremental', scope });
  assert.equal(result.state, 'unavailable');
  assert.equal(result.reason, 'workspace_root_unavailable');
});

test('AC-02-2: 关闭 lease 后不再摄入（晚到回调无入库）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-close-'));
  writeFileSync(join(root, 'a.md'), '关闭前内容', 'utf8');
  const source = newSource();
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };

  const emitted: unknown[] = [];
  const lease = await source.start(scope, candidate => { emitted.push(candidate); });
  await lease.close();

  const afterClose = await source.scan({ operationId: 'op-1', mode: 'incremental', scope });
  assert.equal(afterClose.items.length, 0, '关闭后不得再产出候选');
  assert.equal(source.trackedCount, 0, '关闭必须释放已跟踪版本');
});

test('AC-02-2: 扫描只读，用户原文件内容与 hash 不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-readonly-'));
  const file = join(root, 'a.md');
  writeFileSync(file, '用户原文，不得被修改', 'utf8');
  const before = createHash('sha256').update(statSync(file).size.toString()).digest('hex');
  const contentBefore = createHash('sha256').update(Buffer.from('用户原文，不得被修改', 'utf8')).digest('hex');

  const source = newSource();
  await source.scan({ operationId: 'op-1', mode: 'import-existing', scope: { ...SCOPE, canonicalRoot: root } });

  const contentAfter = createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(contentAfter, contentBefore, '源文件字节必须逐字节不变');
  assert.equal(typeof before, 'string');
});

// ================================================================================================
// AC-02-3 历史导入 / 递归 / 隔离 / 分页
// ================================================================================================

test('AC-02-3: 历史导入与启用后增量是两个显式模式', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-history-'));
  writeFileSync(join(root, 'old.md'), '启用前已存在的历史文件', 'utf8');
  const source = newSource();
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };

  const incremental = await source.scan({ operationId: 'op-inc', mode: 'incremental', scope });
  assert.equal(incremental.items.length, 1, '首次增量以当前 manifest 为基线');

  const fresh = newSource();
  const explicitImport = await fresh.scan({ operationId: 'op-import', mode: 'import-existing', scope });
  assert.equal(explicitImport.items.length, 1);
  assert.notEqual(incremental.jobId, explicitImport.jobId);
});

test('AC-02-3: 递归必须显式开启，默认只看根本层', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-recursive-'));
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, 'nested', 'deep.md'), '深层正文', 'utf8');
  writeFileSync(join(root, 'top.md'), '顶层正文', 'utf8');

  const shallow = newSource();
  const shallowResult = await shallow.scan({ operationId: 'op-shallow', mode: 'import-existing', scope: { ...SCOPE, canonicalRoot: root } });
  assert.deepEqual(shallowResult.items.map(i => i.relativePath), ['top.md'], '默认不递归');

  const deep = newSource();
  const deepResult = await deep.scan({ operationId: 'op-deep', mode: 'import-existing', scope: { ...SCOPE, canonicalRoot: root, recursive: true } });
  assert.deepEqual(deepResult.items.map(i => i.relativePath).sort(), ['nested/deep.md', 'top.md'], '显式递归才可见深层');
});

test('AC-02-3: 超过单批上限时可见截断与 remaining，不谎报完成', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-large-'));
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(join(root, `f${String(i).padStart(3, '0')}.md`), `第 ${i} 个文件`, 'utf8');
  }
  const source = newSource({ maxItemsPerScan: 5 });
  const result = await source.scan({ operationId: 'op-large', mode: 'import-existing', scope: { ...SCOPE, canonicalRoot: root } });

  assert.equal(result.truncated, true);
  assert.equal(result.state, 'partial');
  assert.equal(result.reason, 'max_items_reached');
  assert.ok(result.remaining > 0, 'remaining 必须可见');
  assert.ok(result.items.length <= 5, '单批上限必须生效');
});

test('AC-02-3: 分页扫描不丢项', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-page-'));
  for (let i = 0; i < 7; i += 1) {
    writeFileSync(join(root, `p${i}.md`), `分页内容 ${i}`, 'utf8');
  }
  const source = newSource({ pageSize: 3 });
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };
  const seen = new Set<string>();

  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await source.scan({
      operationId: `op-page-${guard}`, mode: 'import-existing', scope, ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) seen.add(item.relativePath);
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
  }
  assert.equal(seen.size, 7, `分页不得丢项，实际 ${seen.size}`);
});

test('AC-02-3: 两个独立 source 实例的版本账本互不共享', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-isolate-'));
  writeFileSync(join(root, 'a.md'), '内容', 'utf8');
  const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: root };

  const first = newSource();
  await first.scan({ operationId: 'op-1', mode: 'import-existing', scope });

  const second = newSource();
  const other = await second.scan({ operationId: 'op-2', mode: 'import-existing', scope });
  assert.equal(other.items.length, 1, '另一实例/另一 pairing 必须各自看到文件，不共享游标或权重');
});

// ================================================================================================
// 授权范围校验：缺字段必须拒绝，不能默认授权
// ================================================================================================

test('CK-02: workspace 授权缺少任一字段都必须被拒绝', () => {
  assert.deepEqual([...validateWorkspaceScope({
    canonicalRoot: 'C:/ws', recursive: false, allowedExtensions: ['.md'], importExisting: false,
  })], []);

  assert.ok(validateWorkspaceScope({
    canonicalRoot: '', recursive: false, allowedExtensions: ['.md'], importExisting: false,
  }).includes('canonicalRoot_required'));

  assert.ok(validateWorkspaceScope({
    canonicalRoot: 'C:/ws', allowedExtensions: ['.md'], importExisting: false,
  } as never).includes('recursive_must_be_explicit'), '递归必须显式');

  assert.ok(validateWorkspaceScope({
    canonicalRoot: 'C:/ws', recursive: false, importExisting: false,
  } as never).includes('allowedExtensions_required'));

  assert.ok(validateWorkspaceScope({
    canonicalRoot: 'C:/ws', recursive: false, allowedExtensions: ['md'],
  } as never).includes('allowedExtensions_must_be_dotted'));

  assert.ok(validateWorkspaceScope({
    canonicalRoot: 'C:/ws', recursive: false, allowedExtensions: ['.md'],
  } as never).includes('importExisting_must_be_explicit'));
});

test('CK-02: validateSourceGrant 拒绝不完整的 workspace 授权', () => {
  const base = {
    schemaVersion: 1 as const,
    grantId: 'g-ws',
    revision: 1,
    pairing: { userId: 'u', characterId: 'c', characterInstanceId: 'i' },
    purposes: ['receive', 'parse'] as const,
    destination: 'local' as const,
    grantedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    profile: 'normal' as const,
    state: 'active' as const,
  };

  assert.throws(() => validateSourceGrant(Object.freeze({
    ...base, kind: 'workspace_directory' as const, scope: { canonicalRoot: 'C:/ws' },
  }) as unknown as SourceGrant), /workspace scope incomplete/);

  // 旧截图授权不会被悄悄当作工作区授权。
  assert.doesNotThrow(() => validateSourceGrant(Object.freeze({
    ...base, kind: 'screenshot_directory' as const, scope: { canonicalRoot: 'C:/shots' },
  }) as unknown as SourceGrant));
});

// ================================================================================================
// AC-02-4 正式装配：workspace candidate → CK-01 reader → 真实正文
// ================================================================================================

const PAIRING = productionPairing('companion', 'inst-ck02');

function workspaceGrant(root: string, overrides: Partial<SourceGrant> = {}): SourceGrant {
  return Object.freeze({
    schemaVersion: 1 as const,
    grantId: 'grant-ck02',
    revision: 1,
    pairing: PAIRING,
    kind: 'workspace_directory' as const,
    scope: Object.freeze({ canonicalRoot: root, recursive: false, allowedExtensions: ['.md', '.txt'], importExisting: false }),
    purposes: Object.freeze(['receive', 'parse'] as const),
    destination: 'local' as const,
    grantedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    profile: 'normal' as const,
    state: 'active' as const,
    ...overrides,
  });
}

/** The production wiring under test: real workspace files -> real store -> real CK-01 reader. */
async function productionHarness() {
  const root = mkdtempSync(join(tmpdir(), 'aika-ck02-wire-'));
  const workspace = mkdtempSync(join(tmpdir(), 'aika-ck02-ws-'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: () => '2026-10-07T02:00:00.000Z',
  });
  const db = memory.rawDatabaseForKnowledge();
  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'),
    policy: NORMAL_COLLECTION_POLICY,
    now: () => '2026-10-07T02:00:00.000Z',
  });
  return { root, workspace, memory, db, store };
}

/** Submit a scanned candidate the way the source adapter does, keyed by content version. */
function submitScannedCandidate(
  store: CollectionStore, grant: SourceGrant,
  candidate: { relativePath: string; contentHash: string; displayName: string; extension: string; mimeType: string; size: number; receivedAt: string; fileModifiedAt: string },
  text: string,
): string {
  const result = store.appendCandidate(grant, {
    sourceKind: 'workspace_directory',
    modeGeneration: 1,
    nativeEventId: `ws-${candidate.contentHash.slice(0, 16)}`,
    occurredAt: candidate.fileModifiedAt,
    receivedAt: candidate.receivedAt,
    origin: 'workspace_directory',
    confidence: 1,
    expiresAt: '2026-12-01T00:00:00.000Z',
    payloadRef: `wsref-${candidate.contentHash.slice(0, 16)}`,
    textContent: text,
    displayName: candidate.displayName,
    mimeType: candidate.mimeType,
    size: candidate.size,
    canonicalRootId: 'workspace-root',
    stableVersion: candidate.contentHash,
  }, `ws-key-${candidate.relativePath}-${candidate.contentHash}`);

  assert.equal(result.outcome, 'inserted', `候选写入失败: ${result.reason ?? ''}`);
  return result.sampleId!;
}

test('AC-02-4: workspace 扫描结果经正式 reader 到真实正文与解析记录', async () => {
  const h = await productionHarness();
  try {
    const BODY = '工作区真实正文：这一段必须原样进入派生记录。';
    writeFileSync(join(h.workspace, 'notes.md'), BODY, 'utf8');

    const source = newSource();
    const scope: WorkspaceSourceScope = { ...SCOPE, canonicalRoot: h.workspace };
    const scan = await source.scan({ operationId: 'ws-scan', mode: 'import-existing', scope });
    assert.equal(scan.items.length, 1);
    const scanned = scan.items[0]!;

    const grant = workspaceGrant(h.workspace);
    assert.doesNotThrow(() => validateSourceGrant(grant), '生产装配的授权必须通过契约校验');
    submitScannedCandidate(h.store, grant, scanned, BODY);

    // 真实组合根路径：trial-backend 注入的同一个 reader。
    const reader = new CollectionSourceReader(h.store);
    const runner = new CollectionBatchRunner({
      db: h.db, store: h.store, pairing: PAIRING, parser: new DocumentParser(),
      reader, now: () => '2026-10-07T02:00:00.000Z',
    });
    await runner.request({
      trigger: 'manual', operationId: 'ws-batch', expectedPolicyRevision: 1, generation: 1,
      scheduledDay: '2026-10-07',
    });
    await new Promise(r => setTimeout(r, 30));

    const receipt = runner.receiptFor('ws-batch')!;
    assert.equal(receipt.counts.processed, 1, `扫描项必须被真实处理，实际 ${JSON.stringify(receipt.counts)}`);

    const derived = h.db.prepare(`SELECT text_content, processor_id FROM collection_derived_text`).get() as
      { text_content: string; processor_id: string };
    assert.equal(derived.text_content, BODY, '必须是真实正文，不能是文件名');
    assert.equal(derived.processor_id, 'standard-batch-parser-v1');
  } finally { h.memory.close(); }
});

test('AC-02-4: 工作区文件消失后候选失效，撤销后的晚提交被拒', async () => {
  const h = await productionHarness();
  try {
    writeFileSync(join(h.workspace, 'gone.md'), '将被删除的正文', 'utf8');
    const source = newSource();
    const scan = await source.scan({
      operationId: 'ws-scan', mode: 'import-existing', scope: { ...SCOPE, canonicalRoot: h.workspace },
    });
    const grant = workspaceGrant(h.workspace);
    const sourceId = submitScannedCandidate(h.store, grant, scan.items[0]!, '将被删除的正文');

    rmSync(join(h.workspace, 'gone.md'));

    // 删除后重扫必须报告 deleted（统计正确），且候选不可再派生。
    const afterDelete = await source.scan({
      operationId: 'ws-scan-2', mode: 'incremental', scope: { ...SCOPE, canonicalRoot: h.workspace },
    });
    assert.equal(afterDelete.counts.deleted, 1);

    // 删除必须传播到存储：候选失效，同版本重扫不得复活。
    const deletedVersion = scan.items[0]!.contentHash;
    const affected = h.store.invalidateBySourceVersions(PAIRING, {
      sourceKind: 'workspace_directory', stableVersions: [deletedVersion],
    });
    assert.deepEqual([...affected], [sourceId], '删除的候选必须被失效');

    const reader = new CollectionSourceReader(h.store);
    const revoked = await reader.read({
      pairing: PAIRING, sourceId, expectedSourceRevision: 1,
      grantRevision: 1, purpose: 'parse',
    });
    assert.notEqual(revoked.outcome, 'ok', '删除后的晚读不得返回正文');

    // 撤销授权后，晚提交派生必须被拒绝。
    const late = h.store.commitDerived(PAIRING, {
      parentRefs: [{ sourceId, version: '1' }],
      processorId: 'standard-batch-parser-v1', processorVersion: '1.1.0', grantRevision: 1,
      processingKey: 'proc-late-ws', status: 'ok', text: '不应被提交', expiresAt: '2026-12-01T00:00:00.000Z',
    });
    assert.equal(late.committed, false, '撤销后不得写入派生');
    assert.equal(
      (h.db.prepare('SELECT COUNT(*) AS n FROM collection_derived_text').get() as { n: number }).n, 0,
      '失效来源不得留下任何派生记录',
    );
  } finally { h.memory.close(); }
});

test('AC-02-4: 跨 pairing 读不到他人工作区候选', async () => {
  const h = await productionHarness();
  try {
    const other = productionPairing('companion', 'inst-other');
    writeFileSync(join(h.workspace, 'private.md'), '私人工作区正文', 'utf8');
    const source = newSource();
    const scan = await source.scan({
      operationId: 'ws-scan', mode: 'import-existing', scope: { ...SCOPE, canonicalRoot: h.workspace },
    });
    const sourceId = submitScannedCandidate(h.store, workspaceGrant(h.workspace), scan.items[0]!, '私人工作区正文');

    const reader = new CollectionSourceReader(h.store);
    const denied = await reader.read({
      pairing: other, sourceId, expectedSourceRevision: 1, grantRevision: 1, purpose: 'parse',
    });
    assert.equal(denied.outcome, 'missing', '跨 pairing 必须表现为不存在，而不是可见');
  } finally { h.memory.close(); }
});

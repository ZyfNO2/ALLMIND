// CB-01: management boundary for unified character document (.aiki.md) imports — zero-write
// preview, draft save, and per-item diff/conflict detection. The HTTP layer validates shape; the
// Pack owner holds the import record; the parser owns format semantics. NO business-owner writes
// (profile/prompt/Pack/Lorebook/State are read-only here); apply/rollback land in CB-02
// (management/character-document-apply.ts, assembled by the same composition root).
import { createHash } from 'node:crypto';
import { ManagementError } from '../contracts/management.js';
import type { CharacterPackStore } from '../memory/character-pack-store.js';
import type { CharacterRoleConfigurationStoreLike } from './character-wiki-roles.js';
import { parseCharacterDocument } from '../core/character-document-parser.js';
import { exportCharacterDocument } from '../core/character-document-export.js';
import type { CharacterDocumentExportDeps } from '../core/character-document-export.js';
import { AIKI_LIMITS, type AikiDocument } from '../contracts/character-document.js';
import { sha256 } from '../memory/character-pack-source.js';
import {
  applyCharacterDocument, recoverPreparedApply, restoreFromBaseline,
  type DocumentApplyDeps, type DocumentApplyInput, type DocumentApplyReceipt, type DocumentApplySelection,
  type DocumentApplyBaseline,
} from './character-document-apply.js';

export interface DocumentOwnerReadPorts {
  /** Current profile author fields + field cursor (null when the role has no configuration). */
  profileOf(characterId: string): { intro: string; scenario?: string; firstMessage?: string; exampleDialogue?: string; fieldRevision: number } | null;
  /** Current prompt revision + content hash (null when unavailable). */
  promptOf(characterId: string): { revision: number; textHash: string } | null;
  /** Stable fingerprint of the role's lorebooks (ids + revisions), for conflict baselines. */
  lorebookFingerprint(characterId: string): string;
}

export type DocumentItemAction = 'add' | 'noop' | 'update' | 'conflict' | 'skip' | 'blocked';

export interface DocumentPreviewItem {
  readonly entryId: string;
  readonly type: 'persona' | 'wiki' | 'story' | 'state' | 'authoring';
  readonly subtype: string | undefined;
  readonly title: string | undefined;
  readonly action: DocumentItemAction;
  readonly reason: string;
  readonly targetOwner: 'profile' | 'prompt' | 'pack' | 'lorebook' | 'authorState' | 'none';
  readonly targetField: string | undefined;
  readonly blocked: boolean;
}

export interface DocumentPreviewResult {
  readonly apiVersion: 1;
  readonly documentHash: string;
  readonly mode: 'aiki-character' | 'source_only';
  readonly documentId: string | undefined;
  readonly counts: { persona: number; wiki: number; story: number; state: number };
  readonly authoring: { intro: string | null; scenario: string | null; firstMessage: string | null; exampleDialogue: string | null };
  readonly nameSuggestion: { documentName: string; currentLabel: string | null; differs: boolean } | undefined;
  readonly entries: readonly DocumentPreviewItem[];
  readonly current: { profileRevision: number | null; promptRevision: number | null; packRevision: number; lorebookFingerprint: string; authorState: 'unavailable' };
  readonly canSave: boolean;
  readonly canApply: boolean;
  readonly blockers: readonly string[];
  readonly diff: { summary: string };
  readonly diagnostics: readonly { code: string; message: string; line?: number; entryId?: string; field?: string }[];
}

export interface DocumentSaveResult {
  readonly operationId: string;
  readonly importId: string;
  readonly saved: true;
  readonly applied: false;
  readonly mode: 'aiki-character' | 'source_only';
  readonly documentHash: string;
  readonly duplicate: boolean;
}

export interface CharacterDocumentManagement {
  preview(input: DocumentImportInput): Promise<DocumentPreviewResult>;
  saveDraft(input: DocumentImportInput & { operationId: string; previewHash: string }): Promise<DocumentSaveResult>;
  listDrafts(characterId: string): unknown;
  getImport(characterId: string, importId: string): unknown;
  getOperation(characterId: string, operationId: string): unknown;
  /** CB-02: zero-write apply preview (revision gates + blockers, no writes). */
  applyPreview(input: { characterId: string; importId: string; expectedRevisions: DocumentApplyInput['expectedRevisions'] }): Promise<unknown>;
  /** CB-02: one-shot autofill apply across the original owners (durable journal). */
  apply(input: DocumentApplyInput): Promise<DocumentApplyReceipt>;
  /** CB-02: zero-write rollback preview. */
  rollbackPreview(input: { characterId: string; operationId: string }): Promise<unknown>;
  /** CB-02: rollback to the pre-apply values as NEW revisions. */
  rollback(input: { characterId: string; operationId: string; userConfirmed: boolean }): Promise<unknown>;
  /** CB-06: export the current author content as a `.aiki.md` document (read-only). */
  export(characterId: string): unknown;
  /** CB-04: the author initial-state rows, shown SEPARATELY from real Continuity state. */
  authorState(characterId: string): unknown;
}

export interface DocumentImportInput {
  readonly characterId: string;
  readonly inputKind: 'file' | 'paste';
  readonly sourceName: string;
  readonly text: string;
}

const MAX_TEXT_CODE_POINTS = AIKI_LIMITS.maxDocumentBytes;
const requiredText = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ManagementError('invalid_request', `${name} 无效或超出 ${max} 字符。`);
  return value;
};

function parseInput(raw: Record<string, unknown>): DocumentImportInput {
  if (raw.apiVersion !== 1) throw new ManagementError('invalid_request', 'apiVersion 必须为 1。');
  const characterId = requiredText(raw.characterId, 'characterId', 200);
  const inputKind = raw.inputKind;
  if (inputKind !== 'file' && inputKind !== 'paste') throw new ManagementError('invalid_request', "inputKind 必须为 'file' 或 'paste'。");
  const sourceName = requiredText(raw.sourceName, 'sourceName', 200);
  if (/[\\/]/.test(sourceName)) throw new ManagementError('invalid_request', 'sourceName 不得包含路径分隔符。');
  const normalizedSourceName = /\.(aiki\.md|md|markdown|txt)$/i.test(sourceName) ? sourceName : `${sourceName}.md`;
  const text = raw.text;
  if (typeof text !== 'string' || !text.trim()) throw new ManagementError('invalid_request', '导入正文不能为空。');
  if (Buffer.byteLength(text, 'utf8') > AIKI_LIMITS.maxDocumentBytes) throw new ManagementError('invalid_request', `导入正文超过 ${AIKI_LIMITS.maxDocumentBytes} 字节传输上限。`);
  if (text.includes('\0')) throw new ManagementError('invalid_request', '导入正文包含 NUL 字符。');
  return { characterId, inputKind, sourceName: normalizedSourceName, text };
}

/** Maps CharacterPackError codes onto management error codes so revisions/409s reach the client. */
const mapAikiErrors = async <T>(work: () => Promise<T>): Promise<T> => {
  try { return await work(); } catch (error) {
    if (error instanceof ManagementError) throw error;
    const code = (error as { code?: string }).code;
    if (code && ['version_conflict', 'not_found', 'validation_failed', 'invalid_request'].includes(code)) {
      throw new ManagementError(code === 'version_conflict' ? 'version_conflict' : code === 'not_found' ? 'not_found' : 'invalid_request', (error as Error).message);
    }
    throw error;
  }
};

const TARGET_OF: Record<string, { owner: DocumentPreviewItem['targetOwner']; field: string | undefined }> = {
  persona: { owner: 'prompt', field: 'body' },
  wiki: { owner: 'pack', field: 'wikiFacts' },
  story: { owner: 'lorebook', field: 'entries' },
  state: { owner: 'authorState', field: 'value' },
};

/** Content hash of one entry (meta + body): the unit of noop/update comparison. */
export const entryContentHash = (entry: { meta: unknown; body: string }): string =>
  sha256(JSON.stringify({ meta: entry.meta, body: entry.body }));

export function characterDocumentManagement(
  store: CharacterPackStore,
  roles: CharacterRoleConfigurationStoreLike,
  ports: DocumentOwnerReadPorts,
  applyDeps?: Omit<DocumentApplyDeps, 'store' | 'roles'>,
  exportDeps?: CharacterDocumentExportDeps,
): CharacterDocumentManagement {
  const assertRole = (characterId: string) => {
    if (!roles.exists(characterId)) throw new ManagementError('not_found', '角色不存在。');
    if (!roles.allowsConfiguration(characterId)) throw new ManagementError('invalid_request', '该角色不允许配置。');
  };

  const buildPreview = async (input: DocumentImportInput): Promise<DocumentPreviewResult> => {
    assertRole(input.characterId);
    const parsed = parseCharacterDocument({ text: input.text, sourceName: input.sourceName, inputKind: input.inputKind });
    const pairing = roles.pairingFor(input.characterId);
    const packRevision = store.getPackRevision(pairing);
    const profile = ports.profileOf(input.characterId);
    const prompt = ports.promptOf(input.characterId);
    const lorebookFingerprint = ports.lorebookFingerprint(input.characterId);
    const current = {
      profileRevision: profile?.fieldRevision ?? null,
      promptRevision: prompt?.revision ?? null,
      packRevision, lorebookFingerprint, authorState: 'unavailable' as const,
    };
    const diagnostics = parsed.diagnostics.map(d => ({ code: d.code, message: d.message, ...(d.line !== undefined ? { line: d.line } : {}), ...(d.entryId !== undefined ? { entryId: d.entryId } : {}), ...(d.field !== undefined ? { field: d.field } : {}) }));

    if (parsed.mode === 'source_only' || !parsed.document) {
      const blocked = parsed.mode === 'source_only' ? [] : ['文档格式错误，修正后才能保存为可应用草稿。'];
      return {
        apiVersion: 1, documentHash: parsed.documentHash, mode: 'source_only', documentId: undefined,
        counts: { persona: 0, wiki: 0, story: 0, state: 0 },
        authoring: { intro: null, scenario: null, firstMessage: null, exampleDialogue: null },
        nameSuggestion: undefined, entries: [], current,
        canSave: parsed.mode === 'source_only', canApply: false, blockers: blocked,
        diff: { summary: parsed.mode === 'source_only' ? '来源草稿：尚无结构化角色文档，可保存来源，不能应用。' : '文档解析失败：未保存、未应用。' },
        diagnostics,
      };
    }
    const document: AikiDocument = parsed.document;
    const blocked = new Set(parsed.blockedEntryIds);
    // Diff baseline (read-only): ONLY content that is actually IN EFFECT counts.
    //
    //   1. the import of the last COMMITTED apply — the content actually published;
    //   2. otherwise NO baseline → every entry is `add`.
    //
    // A merely SAVED draft must never be a baseline. Treating it as one made "save draft, then
    // apply" report all 12 entries as noop and left the apply button permanently disabled: a
    // draft is not applied content, so a first-ever apply has to read as `add`.
    // Per-entry rule (PLAN §8.1): hash equal in the baseline → noop; id known but hash differs →
    // update; id unknown → add. Meta for hashing is the PARSED meta of the stored normalized
    // entries — never the live owner text (pack wraps wiki bodies with `## title`).
    const priorEntryHashes = new Map<string, Set<string>>();
    const committedImportId = store.latestCommittedAikiImport(input.characterId);
    const committed = committedImportId ? store.aikiImportRecord(committedImportId) : null;
    const baselines = committed ? [committed] : [];
    for (const baseline of baselines) {
      if (!baseline?.normalizedJson) continue;
      try {
        const prev = JSON.parse(baseline.normalizedJson) as { entries?: { meta: { id: string }; body: string }[] };
        for (const e of prev.entries ?? []) {
          const set = priorEntryHashes.get(e.meta.id) ?? new Set<string>();
          set.add(entryContentHash(e));
          priorEntryHashes.set(e.meta.id, set);
        }
      } catch { /* corrupt baseline: treat everything as add */ }
    }
    const activePack = (await store.getSnapshot(pairing)).activePack;
    const liveWikiById = new Map((activePack?.wikiFacts ?? []).map(fact => [fact.id, fact.text]));
    // Per-entry import ledger for wiki facts: which import last wrote each live fact. Pristine
    // means the live text equals the WRAPPED stored entry text of that import (pack rows carry
    // a `## title` prefix that the document entries do not). Resolved via the pack's importId.
    const liveWikiWriter = new Map<string, { importId: string; wrappedHash: string }>();
    {
      const writerImportId = activePack?.importId;
      if (writerImportId) {
        try {
          const writerRecord = store.aikiImportRecord(writerImportId);
          if (writerRecord?.normalizedJson) {
            const writerDoc = JSON.parse(writerRecord.normalizedJson) as { entries?: { meta: { id: string; title?: string }; body: string }[] };
            for (const e of writerDoc.entries ?? []) {
              liveWikiWriter.set(e.meta.id, {
                importId: writerImportId,
                wrappedHash: sha256(`## ${e.meta.title ?? e.meta.id}\n\n${e.body.trim()}`),
              });
            }
          }
        } catch { /* corrupt writer record: fall back to plain comparison */ }
      }
    }
    const items: DocumentPreviewItem[] = [];
    for (const entry of document.entries) {
      const target = TARGET_OF[entry.meta.type]!;
      const hash = entryContentHash(entry);
      if (blocked.has(entry.meta.id)) {
        items.push({ entryId: entry.meta.id, type: entry.meta.type, subtype: entry.meta.subtype, title: entry.meta.title, action: 'blocked', reason: '引用悬空（related/source.ref 指向文档外），该条目不可应用。', targetOwner: target.owner, targetField: target.field, blocked: true });
        continue;
      }
      // Local-edit conflict takes precedence over the noop shortcut. A hand edit must be surfaced
      // even when the SOURCE text is unchanged: reporting noop would silently hide the divergence
      // between the user's local copy and the document. Wiki facts are stored wrapped
      // (`## title\n\nbody`) by applyAikiWikiFacts — compare against the WRAPPED form. Local-edit
      // truth comes from the per-entry import ledger: the pack's importId tells which import last
      // wrote it, so a live row still equal to that import's text is pristine (no hand edit).
      if (entry.meta.type === 'wiki') {
        const live = liveWikiById.get(entry.meta.id);
        const wrapped = `## ${entry.meta.title ?? entry.meta.id}\n\n${entry.body.trim()}`;
        if (live !== undefined && live !== wrapped) {
          const writer = liveWikiWriter.get(entry.meta.id);
          const pristine = writer !== undefined && sha256(live) === writer.wrappedHash;
          if (!pristine) {
            items.push({ entryId: entry.meta.id, type: entry.meta.type, subtype: entry.meta.subtype, title: entry.meta.title, action: 'conflict', reason: '本地已有同 ID 但内容不同，默认保留本地，由用户选择。', targetOwner: target.owner, targetField: target.field, blocked: false });
            continue;
          }
        }
      }
      if ((priorEntryHashes.get(entry.meta.id) ?? new Set()).has(hash)) {
        items.push({ entryId: entry.meta.id, type: entry.meta.type, subtype: entry.meta.subtype, title: entry.meta.title, action: 'noop', reason: '与已导入内容一致，无需重复写入。', targetOwner: target.owner, targetField: target.field, blocked: false });
        continue;
      }
      if (entry.meta.type === 'wiki') {
        const known = priorEntryHashes.has(entry.meta.id);
        items.push({ entryId: entry.meta.id, type: entry.meta.type, subtype: entry.meta.subtype, title: entry.meta.title, action: known ? 'update' : 'add', reason: known ? '来源已更新，本地未编辑，预览列为更新。' : '新条目，将加入角色 Wiki。', targetOwner: target.owner, targetField: target.field, blocked: false });
        continue;
      }
      if (entry.meta.type === 'state') {
        // CB-02 storage exists: state entries now really land in `character_author_state`, so the
        // old "storage not ready" blocker is gone. They are still authored setting, never real
        // Continuity, and the apply receipt keeps them out of user memory.
        const known = priorEntryHashes.has(entry.meta.id);
        items.push({ entryId: entry.meta.id, type: entry.meta.type, subtype: entry.meta.subtype, title: entry.meta.title, action: known ? 'update' : 'add', reason: known ? '来源已更新，本地未编辑，预览列为更新（作者初始状态）。' : '新条目，将写入作者初始状态（与真实连续性状态分开）。', targetOwner: target.owner, targetField: target.field, blocked: false });
        continue;
      }
      {
        const known = priorEntryHashes.has(entry.meta.id);
        items.push({ entryId: entry.meta.id, type: entry.meta.type, subtype: entry.meta.subtype, title: entry.meta.title, action: known ? 'update' : 'add', reason: known ? '来源已更新，本地未编辑，预览列为更新。' : '新条目，将自动填入目标位置。', targetOwner: target.owner, targetField: target.field, blocked: false });
      }
    }
    const authoring = document.frontmatter.authoring;
    const counts = {
      persona: document.entries.filter(e => e.meta.type === 'persona').length,
      wiki: document.entries.filter(e => e.meta.type === 'wiki').length,
      story: document.entries.filter(e => e.meta.type === 'story').length,
      state: document.entries.filter(e => e.meta.type === 'state').length,
    };
    const hasBlocked = items.some(item => item.blocked);
    // CB-02 storage now exists, so state entries are no longer a blocker. The only remaining
    // blocker is a dangling reference, which genuinely prevents applying those entries.
    const blockers = hasBlocked ? ['部分条目引用悬空，需修正后才能应用这些条目。'] : [];
    const canApply = !hasBlocked && items.some(item => item.action === 'add' || item.action === 'update');
    return {
      apiVersion: 1, documentHash: parsed.documentHash, mode: 'aiki-character', documentId: document.frontmatter.id,
      counts,
      authoring: { intro: authoring.intro ?? null, scenario: authoring.scenario ?? null, firstMessage: authoring.firstMessage ?? null, exampleDialogue: authoring.exampleDialogue ?? null },
      nameSuggestion: undefined, entries: items, current,
      canSave: true, canApply, blockers,
      diff: { summary: `角色文档：Persona ${counts.persona} 条、Wiki ${counts.wiki} 条、故事 ${counts.story} 条、State ${counts.state} 条；新增/更新 ${items.filter(item => item.action === 'add' || item.action === 'update').length} 项，无变化 ${items.filter(item => item.action === 'noop').length} 项。` },
      diagnostics,
    };
  };

  return {
    async preview(input: DocumentImportInput): Promise<DocumentPreviewResult> {
      return buildPreview(input);
    },

    async saveDraft(input: DocumentImportInput & { operationId: string; previewHash: string }): Promise<DocumentSaveResult> {
      assertRole(input.characterId);
      const operationId = requiredText(input.operationId, 'operationId', 200);
      if (!/^[a-f0-9-]{16,64}$/i.test(operationId)) throw new ManagementError('invalid_request', 'operationId 格式无效。');
      const previewHash = requiredText(input.previewHash, 'previewHash', 64);
      const parsed = parseCharacterDocument({ text: input.text, sourceName: input.sourceName, inputKind: input.inputKind });
      if (parsed.documentHash !== previewHash) {
        throw new ManagementError('version_conflict', '预览内容已变化；请重新预览后再保存。');
      }
      if (parsed.mode === 'source_only' && parsed.document !== undefined) {
        throw new ManagementError('invalid_request', '文档状态异常。');
      }
      const normalizedJson = parsed.document
        ? JSON.stringify({ schemaVersion: parsed.schemaVersion, frontmatter: parsed.document.frontmatter, entries: parsed.document.entries, prose: parsed.document.prose })
        : undefined;
      const result = await mapAikiErrors(() => store.saveAikiImport({
        characterId: input.characterId, operationId,
        mode: parsed.mode === 'aiki-character' ? 'aiki-character' : 'aiki-source-only',
        inputKind: input.inputKind, sourceName: input.sourceName, documentHash: parsed.documentHash,
        previewHash, documentText: input.text,
        ...(normalizedJson ? { normalizedJson } : {}),
        diagnostics: parsed.diagnostics.map(d => (d.entryId ? `${d.entryId}: ${d.message}` : d.message)),
      }));
      return {
        operationId, importId: result.importId, saved: true, applied: false,
        mode: parsed.mode, documentHash: parsed.documentHash, duplicate: result.duplicate,
      };
    },

    listDrafts(characterId: string) {
      assertRole(characterId);
      return { characterId, imports: store.listAikiImports(characterId) };
    },

    getImport(characterId: string, importId: string) {
      assertRole(characterId);
      const record = store.aikiImportRecord(importId);
      if (!record || record.characterId !== characterId) throw new ManagementError('not_found', '导入记录不存在。');
      return record;
    },

    getOperation(characterId: string, operationId: string) {
      assertRole(characterId);
      const found = store.aikiImportByOperation(characterId, operationId);
      if (!found) {
        // CB-02: an apply operation's durable receipt lives in the journal.
        const journaled = store.journalGet(operationId);
        if (journaled && journaled.characterId === characterId) return journaled;
        throw new ManagementError('not_found', '没有这个操作的记录。');
      }
      return found;
    },

    async applyPreview(input: { characterId: string; importId: string; expectedRevisions: DocumentApplyInput['expectedRevisions'] }) {
      assertRole(input.characterId);
      const record = store.aikiImportRecord(input.importId);
      if (!record || record.characterId !== input.characterId) throw new ManagementError('not_found', '导入记录不存在或不属于该角色。');
      if (record.mode !== 'aiki-character' || !record.normalizedJson) throw new ManagementError('invalid_request', '来源草稿（普通 Markdown）不能应用为角色文档。');
      const pairing = roles.pairingFor(input.characterId);
      const blockers: string[] = [];
      const packRevision = store.getPackRevision(pairing);
      if (packRevision !== input.expectedRevisions.packRevision) {
        blockers.push(`角色包修订已变化（当前 ${packRevision}，请求基于 ${input.expectedRevisions.packRevision}）。`);
      }
      const profile = ports.profileOf(input.characterId);
      if (input.expectedRevisions.profileRevision !== null && (profile?.fieldRevision ?? 0) !== input.expectedRevisions.profileRevision) {
        blockers.push('角色资料已变化，请刷新预览后重新确认。');
      }
      const prompt = ports.promptOf(input.characterId);
      if (input.expectedRevisions.promptRevision !== null && (prompt?.revision ?? -1) !== input.expectedRevisions.promptRevision) {
        blockers.push('人设正文已变化，请刷新预览后重新确认。');
      }
      return {
        apiVersion: 1, documentHash: record.documentHash, importId: record.importId,
        current: {
          profileRevision: profile?.fieldRevision ?? null,
          promptRevision: prompt?.revision ?? null,
          packRevision,
          lorebookFingerprint: ports.lorebookFingerprint(input.characterId),
        },
        blockers, applyOn: 'restart' as const,
      };
    },

    async apply(input: DocumentApplyInput): Promise<DocumentApplyReceipt> {
      assertRole(input.characterId);
      if (!applyDeps) throw new ManagementError('unavailable', '当前实例尚未装配角色文档应用。');
      return mapAikiErrors(() => applyCharacterDocument({ store, roles, ...applyDeps }, input));
    },

    async rollbackPreview(input: { characterId: string; operationId: string }) {
      assertRole(input.characterId);
      const journaled = store.journalGet(input.operationId);
      if (!journaled || journaled.characterId !== input.characterId) throw new ManagementError('not_found', '没有这个应用操作的记录。');
      if (journaled.state !== 'committed') throw new ManagementError('invalid_request', '该操作未成功提交，不能回退。');
      return {
        apiVersion: 1, operationId: input.operationId,
        receipt: journaled.receipt, progress: journaled.progress,
        note: '回退将本次涉及字段/条目恢复为旧值（新修订）；期间的人工更正需先确认冲突。',
      };
    },

    async rollback(input: { characterId: string; operationId: string; userConfirmed: boolean }) {
      assertRole(input.characterId);
      if (input.userConfirmed !== true) throw new ManagementError('invalid_request', '回退需要显式确认（userConfirmed:true）。');
      if (!applyDeps) throw new ManagementError('unavailable', '当前实例尚未装配角色文档应用。');
      return mapAikiErrors(async () => {
        const journaled = store.journalGet(input.operationId);
        if (!journaled || journaled.characterId !== input.characterId) throw new ManagementError('not_found', '没有这个应用操作的记录。');
        if (journaled.state !== 'committed') throw new ManagementError('invalid_request', '该操作未成功提交，不能回退。');
        // Idempotent replay: a rollback of this operation already committed → original receipt.
        const rollbackOp = `${input.operationId}:rollback`;
        const existing = store.journalGet(rollbackOp);
        if (existing?.state === 'committed') return { ...(existing.receipt as Record<string, unknown>), duplicate: true };
        const deps = { store, roles, ...applyDeps };
        const baseline = store.journalBaselineOf(input.operationId) as DocumentApplyBaseline | null;
        if (!baseline) {
          // No recorded baseline: refuse instead of reporting a rollback that restored nothing.
          throw new ManagementError('invalid_request', '该操作没有记录回退基线（早于基线记录的旧操作），无法逐域回退；请手动调整对应字段。');
        }
        store.journalPrepare(rollbackOp, input.characterId, journaled.importId, { signature: `rollback:${input.operationId}` });
        const outcome = await restoreFromBaseline(deps, {
          characterId: input.characterId, operationId: input.operationId, importId: journaled.importId,
        });
        const result = {
          operationId: input.operationId, rolledBack: true as const,
          restored: outcome.restored, detail: outcome.detail,
          note: '已将本次涉及字段/条目恢复为旧值（新修订，不删除任何版本）。',
        };
        store.journalFinish(rollbackOp, 'committed', result);
        return result;
      });
    },

    export(characterId: string) {
      assertRole(characterId);
      if (!exportDeps) throw new ManagementError('unavailable', '当前实例尚未装配角色文档导出。');
      const result = exportCharacterDocument(exportDeps, characterId);
      return {
        apiVersion: 1, characterId, filename: result.filename,
        documentHash: sha256(result.text), entryCount: result.entryCount, counts: result.counts,
        warnings: result.warnings, text: result.text,
      };
    },

    authorState(characterId: string) {
      assertRole(characterId);
      // Authored initial state — explicitly NOT the running instance's continuity state.
      const rows = store.authorStateOf(characterId);
      const lastApply = store.latestCommittedApply(characterId);
      return {
        apiVersion: 1, characterId, origin: 'author' as const,
        importId: store.latestCommittedAikiImport(characterId),
        // CB-04: lets the panel offer rollback after a reload (the receipt is otherwise in-memory).
        lastApply,
        note: '作者设定的初始状态；与运行中的真实连续性状态分开显示，永不覆盖用户真实记忆。',
        entries: rows.map(row => ({
          entryId: row.entryId, subtype: row.subtype, title: row.title, body: row.body,
          priority: row.priority, always: row.always,
          validFrom: row.validFrom, validUntil: row.validUntil, expiresAt: row.expiresAt,
          revision: row.revision, importId: row.importId,
        })),
      };
    },
  };
}

/** /api/characters/documents/* — same Bearer authorization as all management routes. */
export function characterDocumentRoute(
  method: string | undefined, pathname: string, port: CharacterDocumentManagement | undefined, body: () => Promise<Record<string, unknown>>, query: URLSearchParams,
): Promise<unknown> | unknown {
  if (!port) throw new ManagementError('unavailable', '当前实例尚未装配角色文档导入。');
  if (pathname === '/api/characters/documents/preview') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return body().then(parseInput).then(value => port.preview(value));
  }
  if (pathname === '/api/characters/documents/drafts') {
    if (method === 'GET') {
      return port.listDrafts(requiredText(query.get('characterId') ?? '', 'characterId', 200));
    }
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return body().then(raw => {
      const operationId = requiredText(raw['operationId'], 'operationId', 200);
      const previewHash = requiredText(raw['previewHash'], 'previewHash', 64);
      const value = parseInput(raw);
      return port.saveDraft({ ...value, operationId, previewHash });
    });
  }
  const operationMatch = /^\/api\/characters\/documents\/operations\/([^/]+)$/.exec(pathname);
  if (operationMatch) {
    if (method !== 'GET') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return port.getOperation(requiredText(query.get('characterId') ?? '', 'characterId', 200), decodeURIComponent(operationMatch[1]!));
  }
  const importMatch = /^\/api\/characters\/documents\/drafts\/([^/]+)$/.exec(pathname);
  if (importMatch) {
    if (method !== 'GET') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return port.getImport(requiredText(query.get('characterId') ?? '', 'characterId', 200), decodeURIComponent(importMatch[1]!));
  }
  // --- CB-02: apply / rollback --------------------------------------------------
  if (pathname === '/api/characters/documents/apply/preview') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return body().then(raw => port.applyPreview({
      characterId: requiredText(raw['characterId'], 'characterId', 200),
      importId: requiredText(raw['importId'], 'importId', 200),
      expectedRevisions: readExpectedRevisions(raw['expectedRevisions']),
    }));
  }
  if (pathname === '/api/characters/documents/apply') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return body().then(raw => port.apply({
      characterId: requiredText(raw['characterId'], 'characterId', 200),
      importId: requiredText(raw['importId'], 'importId', 200),
      documentHash: requiredText(raw['documentHash'], 'documentHash', 64),
      selection: readSelection(raw['selection']),
      expectedRevisions: readExpectedRevisions(raw['expectedRevisions']),
      operationId: requiredText(raw['operationId'], 'operationId', 200),
      userConfirmed: raw['userConfirmed'] === true,
    }));
  }
  if (pathname === '/api/characters/documents/rollback/preview') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return body().then(raw => port.rollbackPreview({
      characterId: requiredText(raw['characterId'], 'characterId', 200),
      operationId: requiredText(raw['operationId'], 'operationId', 200),
    }));
  }
  if (pathname === '/api/characters/documents/rollback') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return body().then(raw => port.rollback({
      characterId: requiredText(raw['characterId'], 'characterId', 200),
      operationId: requiredText(raw['operationId'], 'operationId', 200),
      userConfirmed: raw['userConfirmed'] === true,
    }));
  }
  if (pathname === '/api/characters/documents/author-state') {
    if (method !== 'GET') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return port.authorState(requiredText(query.get('characterId') ?? '', 'characterId', 200));
  }
  if (pathname === '/api/characters/documents/export') {
    if (method !== 'GET') throw new ManagementError('not_found', '没有这个角色文档操作。');
    return port.export(requiredText(query.get('characterId') ?? '', 'characterId', 200));
  }
  throw new ManagementError('not_found', '没有这个角色文档操作。');
}

const readExpectedRevisions = (raw: unknown): DocumentApplyInput['expectedRevisions'] => {
  if (typeof raw !== 'object' || raw === null) throw new ManagementError('invalid_request', 'expectedRevisions 无效。');
  const r = raw as Record<string, unknown>;
  const optInt = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ManagementError('invalid_request', 'expectedRevisions 修订号无效。');
    return v;
  };
  if (typeof r['packRevision'] !== 'number' || !Number.isSafeInteger(r['packRevision']) || (r['packRevision'] as number) < 0) {
    throw new ManagementError('invalid_request', 'expectedRevisions.packRevision 无效。');
  }
  return {
    profileRevision: optInt(r['profileRevision']),
    promptRevision: optInt(r['promptRevision']),
    packRevision: r['packRevision'] as number,
    bookRevision: optInt(r['bookRevision']),
  };
};

const readSelection = (raw: unknown): DocumentApplySelection => {
  if (typeof raw !== 'object' || raw === null) throw new ManagementError('invalid_request', 'selection 无效。');
  const s = raw as Record<string, unknown>;
  const flag = (v: unknown): boolean => v === true;
  const skipped = s['skippedEntryIds'];
  if (skipped !== undefined && (!Array.isArray(skipped) || skipped.some(id => typeof id !== 'string'))) {
    throw new ManagementError('invalid_request', 'selection.skippedEntryIds 无效。');
  }
  const intro = s['intro'];
  if (intro !== undefined && typeof intro !== 'string') throw new ManagementError('invalid_request', 'selection.intro 无效。');
  return {
    profile: flag(s['profile']), prompt: flag(s['prompt']), wiki: flag(s['wiki']),
    story: flag(s['story']), state: flag(s['state']),
    skippedEntryIds: skipped === undefined ? [] : [...skipped as string[]],
    ...(intro === undefined ? {} : { intro: intro as string }),
  };
};

/** Test seam: stable lorebook fingerprint from ids + revisions (read-only, no store change). */
export const lorebookFingerprintOf = (books: readonly { id: string; revision: number }[]): string =>
  createHash('sha256').update(books.map(b => `${b.id}:${b.revision}`).sort().join(','), 'utf8').digest('hex').slice(0, 16);

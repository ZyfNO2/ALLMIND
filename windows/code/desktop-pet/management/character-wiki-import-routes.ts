// WV0-01: management boundary for character Wiki v0 imports — zero-write preview and the atomic
// draft-save transaction. The HTTP layer validates shape; the Pack owner owns persistence; the
// parser owns format semantics. No persona/Lorebook/Continuity writes, no model calls.
import { ManagementError } from '../contracts/management.js';
import type { CharacterPackStore } from '../memory/character-pack-store.js';
import type { CharacterRoleConfigurationStoreLike } from './character-wiki-roles.js';
import { parseWikiImport } from './character-wiki-import-parser.js';
import { WIKI_LIMITS } from '../contracts/character-wiki-import.js';
import { sha256 } from '../memory/character-pack-source.js';
import { splitSourceBlocks } from '../memory/character-pack-source.js';
import { DEFAULT_SOURCE_LIMITS } from '../contracts/character-pack.js';

export interface WikiImportManagement {
  preview(input: WikiImportInput): Promise<WikiPreviewResult>;
  saveDraft(input: WikiImportInput & { operationId: string; previewHash: string }): Promise<WikiSaveResult>;
  listDrafts(characterId: string): unknown;
  getImport(characterId: string, importId: string): unknown;
  getOperation(characterId: string, operationId: string): unknown;
  /** WV0-02: zero-write apply preview; source_only imports are refused. */
  applyPreview(characterId: string, importId: string): Promise<unknown>;
  /** WV0-02: revision-guarded single-domain apply (pack pointer ONLY; no persona/Lorebook writes). */
  apply(input: { characterId: string; importId: string; documentHash: string; expectedPackRevision: number; operationId: string; userConfirmed: boolean }): Promise<unknown>;
  /** WV0-02: version summary for the role. */
  versions(characterId: string): Promise<unknown>;
  /** CB-04: the active pack's canon Wiki facts (read-only), so the Wiki tab shows real content. */
  facts(characterId: string): Promise<unknown>;
  /** WV0-02: zero-write rollback preview. */
  rollbackPreview(characterId: string, targetPackId: string): Promise<unknown>;
  /** WV0-02: revision-guarded rollback forming a NEW history revision. */
  rollback(input: { characterId: string; targetPackId: string; expectedPackRevision: number; operationId: string; userConfirmed: boolean }): Promise<unknown>;
}

export interface WikiImportInput {
  readonly characterId: string;
  readonly inputKind: 'file' | 'clipboard';
  readonly sourceName: string;
  readonly text: string;
}

export interface WikiPreviewResult {
  readonly apiVersion: 1;
  readonly documentHash: string;
  readonly mode: 'structured' | 'source_only';
  readonly normalizedPreview: unknown;
  readonly diagnostics: readonly { path?: string | undefined; message: string }[];
  readonly current: { packId: string | null; packRevision: number };
  readonly canSave: boolean;
  readonly canApply: boolean;
  readonly diff: { readonly summary: string };
}

export interface WikiSaveResult {
  readonly operationId: string;
  readonly importId: string;
  readonly draftId: string | null;
  readonly saved: true;
  readonly applied: false;
  readonly mode: 'structured' | 'source_only';
  readonly documentHash: string;
  readonly duplicate: boolean;
}

const MAX_TEXT_CODE_POINTS = WIKI_LIMITS.maxDocumentBytes; // transport cap enforced on bytes below
const requiredText = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ManagementError('invalid_request', `${name} 无效或超出 ${max} 字符。`);
  return value;
};

/** Maps CharacterPackError codes onto management error codes so revisions/409s reach the client. */
const packCode = (code: string): 'invalid_request' | 'not_found' | 'version_conflict' =>
  code === 'version_conflict' ? 'version_conflict'
    : code === 'not_found' ? 'not_found'
      : code === 'validation_failed' ? 'invalid_request'
        : 'invalid_request';
const mapPackErrors = async <T>(work: () => Promise<T>): Promise<T> => {
  try { return await work(); } catch (error) {
    if (error instanceof ManagementError) throw error;
    const code = (error as { code?: string }).code;
    if (code && ['version_conflict', 'not_found', 'validation_failed', 'invalid_request'].includes(code)) {
      throw new ManagementError(packCode(code), (error as Error).message);
    }
    throw error;
  }
};

function parseInput(raw: Record<string, unknown>): WikiImportInput {
  if (raw.apiVersion !== 1) throw new ManagementError('invalid_request', 'apiVersion 必须为 1。');
  const characterId = requiredText(raw.characterId, 'characterId', 200);
  const inputKind = raw.inputKind;
  if (inputKind !== 'file' && inputKind !== 'clipboard') throw new ManagementError('invalid_request', "inputKind 必须为 'file' 或 'clipboard'。");
  const sourceName = requiredText(raw.sourceName, 'sourceName', 200);
  if (/[\\/]/.test(sourceName)) throw new ManagementError('invalid_request', 'sourceName 不得包含路径分隔符。');
  // The source snapshot layer requires a text extension; a paste label gets the default one.
  const normalizedSourceName = /\.(md|markdown|txt)$/i.test(sourceName) ? sourceName : `${sourceName}.md`;
  const text = raw.text;
  if (typeof text !== 'string' || !text.trim()) throw new ManagementError('invalid_request', '导入正文不能为空。');
  if (Buffer.byteLength(text, 'utf8') > WIKI_LIMITS.maxDocumentBytes) throw new ManagementError('invalid_request', `导入正文超过 ${WIKI_LIMITS.maxDocumentBytes} 字节传输上限。`);
  if (text.includes('\0')) throw new ManagementError('invalid_request', '导入正文包含 NUL 字符。');
  return { characterId, inputKind, sourceName: normalizedSourceName, text };
}

export function characterWikiImportManagement(store: CharacterPackStore, roles: CharacterRoleConfigurationStoreLike): WikiImportManagement {
  const assertRole = (characterId: string) => {
    if (!roles.exists(characterId)) throw new ManagementError('not_found', '角色不存在。');
    if (!roles.allowsConfiguration(characterId)) throw new ManagementError('invalid_request', '该角色不允许配置。');
  };
  const currentPack = (characterId: string) => {
    const pairing = roles.pairingFor(characterId);
    const revision = store.getPackRevision(pairing);
    const pack = store.getSnapshot(pairing).then(snapshot => snapshot.activePack);
    return pack.then(active => ({ packId: active?.id ?? null, packRevision: revision }));
  };

  return {
    async preview(input: WikiImportInput): Promise<WikiPreviewResult> {
      assertRole(input.characterId);
      const parsed = parseWikiImport({ text: input.text, sourceName: input.sourceName, inputKind: input.inputKind === 'clipboard' ? 'paste' : 'file' });
      const structured = parsed.mode === 'structured' && !!parsed.normalized;
      // Draft payload is only computed for the preview diff; nothing is persisted.
      let canApply = false;
      let diffSummary = parsed.mode === 'source_only'
        ? '来源草稿：尚无结构化角色设定，不会生成可应用的角色包。'
        : '结构化导入：canon 项为应用候选；soft_canon/inferred/draft 仅在草稿保留，不进入运行。';
      if (structured && parsed.normalized) {
        const embedded = new Map(parsed.normalized.sources.map(source => [source.id, '']));
        void embedded;
        canApply = Boolean(parsed.normalized.bible.name && parsed.normalized.bible.soul);
        diffSummary += ` 将替换活动包：核心（${parsed.normalized.bible.name}）、${parsed.normalized.wikiFacts.filter(f => f.status === 'canon').length} 条 canon 事实、${parsed.normalized.storyEvents.filter(e => e.status === 'canon').length} 条 canon 事件；候选 ${parsed.normalized.wikiFacts.length - parsed.normalized.wikiFacts.filter(f => f.status === 'canon').length} 条不进入运行。`;
      }
      const current = await currentPack(input.characterId);
      return {
        apiVersion: 1, documentHash: parsed.documentHash, mode: parsed.mode,
        normalizedPreview: parsed.normalized ?? null, diagnostics: parsed.diagnostics as readonly { path?: string | undefined; message: string }[],
        current, canSave: true, canApply, diff: { summary: diffSummary },
      };
    },

    async saveDraft(input: WikiImportInput & { operationId: string; previewHash: string }): Promise<WikiSaveResult> {
      assertRole(input.characterId);
      const operationId = requiredText(input.operationId, 'operationId', 200);
      if (!/^[a-f0-9-]{16,64}$/i.test(operationId)) throw new ManagementError('invalid_request', 'operationId 格式无效。');
      const previewHash = requiredText(input.previewHash, 'previewHash', 64);
      const parsed = parseWikiImport({ text: input.text, sourceName: input.sourceName, inputKind: input.inputKind === 'clipboard' ? 'paste' : 'file' });
      // The preview hash must match the CURRENT content; a stale preview never saves swapped content.
      if (parsed.documentHash !== previewHash) {
        throw new ManagementError('version_conflict', '预览内容已变化；请重新预览后再保存。');
      }
      // Idempotency: same operation/content returns the original receipt; content change is a 409.
      const prior = store.wikiImportByOperation(input.characterId, operationId);
      if (prior) {
        if (prior.documentHash !== parsed.documentHash) throw new ManagementError('version_conflict', '同一操作编号对应的内容发生变化；请刷新后重试。');
        const record = store.wikiImportRecord(prior.importId)!;
        return { operationId, importId: record.importId, draftId: record.draftId, saved: true, applied: false, mode: record.mode, documentHash: record.documentHash, duplicate: true };
      }
      const embeddedSources = parsed.mode === 'structured' && parsed.normalized
        ? parsed.normalized.sources.map(source => ({ sourceId: source.id, title: source.title, text: source.text }))
        : [];
      // Structured mode: map evidence to real blocks and validate BEFORE the transaction.
      let draft: Parameters<CharacterPackStore['saveWikiImport']>[0]['draft'] | undefined;
      let normalizedJson: string | undefined;
      if (parsed.mode === 'structured' && parsed.normalized) {
        // Persist embedded sources first OUTSIDE the draft build so block ids exist for mapping —
        // but ONLY as part of the same owner transaction below; here we just compute block ids from
        // the texts (deterministic split) without touching the database.
        const embedded = new Map<string, string>();
        for (const source of parsed.normalized.sources) {
          const blocks = splitSourceBlocks(source.text, `local:${source.id}`, DEFAULT_SOURCE_LIMITS.maxBlockCodePoints);
          void blocks;
          embedded.set(source.id, source.text);
        }
        void embedded;
        // The real mapping happens in the route service below via saveWikiImport's returned ids;
        // for now validate against locally-split blocks of the SAME texts.
        const localBlocks = new Map<string, import('../contracts/character-pack.js').SourceBlock[]>();
        for (const source of parsed.normalized.sources) {
          localBlocks.set(source.id, splitSourceBlocks(source.text, `local:${source.id}`, DEFAULT_SOURCE_LIMITS.maxBlockCodePoints) as unknown as import('../contracts/character-pack.js').SourceBlock[]);
        }
        const evidenceIds = (sourceId: string, location: { start: number; end: number }): string | null => {
          const blocks = localBlocks.get(sourceId);
          if (!blocks) return null;
          const covering = blocks.find(block => block.locator.start <= location.start && location.end <= block.locator.end)
            ?? blocks.find(block => location.start >= block.locator.start && location.start < block.locator.end);
          return covering?.id ?? null;
        };
        const soul = parsed.normalized.bible;
        const canonFacts = parsed.normalized.wikiFacts.filter(fact => fact.status === 'canon').map(fact => ({
          id: fact.id, text: fact.text, status: 'explicit' as const,
          evidenceIds: fact.evidence.map(item => evidenceIds(item.sourceId, item.location)).filter((id): id is string => !!id),
        }));
        const timeline = parsed.normalized.storyEvents.filter(event => event.status === 'canon').map(event => ({
          eventId: event.id, ordinal: event.ordinal, summary: event.summary, charactersInvolved: event.participants,
          awareness: event.awareness, ...(event.chapter !== undefined ? { chapter: event.chapter } : {}),
          evidenceIds: event.evidence.map(item => evidenceIds(item.sourceId, item.location)).filter((id): id is string => !!id),
          status: 'explicit' as const,
        }));
        const payload = {
          schemaVersion: '0.7-draft-1',
          character: { name: soul.name, soul: soul.soul, styleHints: [...soul.styleHints], evidenceIds: soul.evidence.map(item => evidenceIds(item.sourceId, item.location)).filter((id): id is string => !!id) },
          canonFacts, gaps: [...parsed.normalized.gaps],
          ...(timeline.length > 0 ? { workTitle: parsed.normalized.title } : {}),
        } as import('../contracts/character-pack.js').CharacterPackDraftPayload;
        // Validate against the LOCAL blocks (same texts, deterministic ids). The store transaction
        // then re-saves the sources with real ids; the draft cites the same texts via real blocks.
        const localSources = parsed.normalized.sources.map(source => ({
          id: `local:${source.id}`, characterId: input.characterId, sourceName: source.title,
          contentHash: sha256(source.text), byteLength: Buffer.byteLength(source.text, 'utf8'),
          createdAt: new Date().toISOString(), blocks: localBlocks.get(source.id)!,
        }));
        const { validateDraftEvidence } = await import('../memory/character-pack-validator.js');
        const validation = validateDraftEvidence(payload, localSources);
        normalizedJson = JSON.stringify(parsed.normalized);
        draft = { payload, sourceIds: [], validation };
      }
      const result = await store.saveWikiImport({
        characterId: input.characterId, operationId, mode: parsed.mode,
        sourceKind: parsed.mode === 'structured' ? 'structured-wiki' : 'plain-markdown',
        inputKind: input.inputKind === 'clipboard' ? 'paste' : 'file', sourceName: input.sourceName, documentHash: parsed.documentHash,
        previewHash, documentText: input.text,
        embeddedSources: parsed.mode === 'structured' && parsed.normalized
          ? parsed.normalized.sources.map(source => ({ sourceId: source.id, title: /\.(md|markdown|txt)$/i.test(source.title) ? source.title : `${source.title}.md`, text: source.text }))
          : [],
        ...(draft ? { draft } : {}), ...(normalizedJson ? { normalizedJson } : {}),
        diagnostics: parsed.diagnostics.map(d => (d.path ? `${d.path}: ${d.message}` : d.message)),
      });
      return {
        operationId, importId: result.importId, draftId: result.draftId,
        saved: true, applied: false, mode: parsed.mode, documentHash: parsed.documentHash, duplicate: result.duplicate,
      };
    },

    listDrafts(characterId: string) {
      assertRole(characterId);
      return { characterId, imports: store.listWikiImports(characterId) };
    },

    getImport(characterId: string, importId: string) {
      assertRole(characterId);
      const record = store.wikiImportRecord(importId);
      if (!record || record.characterId !== characterId) throw new ManagementError('not_found', '导入记录不存在。');
      return record;
    },

    getOperation(characterId: string, operationId: string) {
      assertRole(characterId);
      const found = store.wikiImportByOperation(characterId, operationId);
      if (!found) throw new ManagementError('not_found', '没有这个操作的记录。');
      return found;
    },

    async applyPreview(characterId: string, importId: string) {
      assertRole(characterId);
      const record = store.wikiImportRecord(importId);
      if (!record || record.characterId !== characterId) throw new ManagementError('not_found', '导入记录不存在或不属于该角色。');
      if (record.mode !== 'structured' || !record.draftId) throw new ManagementError('invalid_request', '来源草稿（普通 Markdown）不能应用为角色包。');
      const pairing = roles.pairingFor(characterId);
      const snapshot = await store.getSnapshot(pairing);
      const pack = snapshot.activePack;
      const draft = store.getDraft(record.draftId);
      return {
        apiVersion: 1, documentHash: record.documentHash, draftId: record.draftId,
        current: { packId: pack?.id ?? null, packRevision: store.getPackRevision(pairing) },
        proposed: {
          facts: (draft?.payload.canonFacts ?? []).map(fact => fact.text),
          events: store.wikiImportEvents(importId),
          candidatesExcluded: [],
        },
        diff: { summary: `应用后活动包将替换为导入的 Wiki 版本（${record.documentHash.slice(0, 12)}…）。` },
        blockers: [],
        applyOn: 'next_turn',
      };
    },

    async apply(input) {
      assertRole(input.characterId);
      if (input.userConfirmed !== true) throw new ManagementError('invalid_request', '应用需要显式确认（userConfirmed:true）。');
      if (!Number.isSafeInteger(input.expectedPackRevision)) throw new ManagementError('invalid_request', 'expectedPackRevision 无效。');
      return mapPackErrors(() => store.applyWikiImport({
        pairing: roles.pairingFor(input.characterId), importId: input.importId,
        documentHash: input.documentHash, expectedPackRevision: input.expectedPackRevision,
        operationId: input.operationId,
      }));
    },

    async versions(characterId: string) {
      assertRole(characterId);
      const pairing = roles.pairingFor(characterId);
      const snapshot = await store.getSnapshot(pairing);
      return {
        characterId,
        current: snapshot.activePack ? { packId: snapshot.activePack.id, packVersion: snapshot.activePack.packVersion, name: snapshot.activePack.name } : null,
        packRevision: store.getPackRevision(pairing),
        versions: store.listPacks(characterId).map(pack => ({ packId: pack.id, packVersion: pack.packVersion, name: pack.name, activatedAt: pack.activatedAt })),
      };
    },

    /**
     * CB-04: the active pack's canon Wiki facts, read-only.
     *
     * `versions` lists pack VERSIONS only, so a unified-document import left the Wiki tab with no
     * visible fact content. This exposes what is actually in effect.
     */
    async facts(characterId: string) {
      assertRole(characterId);
      const pairing = roles.pairingFor(characterId);
      const snapshot = await store.getSnapshot(pairing);
      const facts = (snapshot.activePack?.wikiFacts ?? []).map(fact => ({
        id: fact.id, text: fact.text, evidenceIds: [...fact.evidenceIds],
      }));
      return {
        apiVersion: 1, characterId,
        packId: snapshot.activePack?.id ?? null,
        packVersion: snapshot.activePack?.packVersion ?? null,
        importId: snapshot.activePack?.importId ?? null,
        note: '当前生效的角色 Wiki 事实（canon）；与用户资料、真实记忆分开。',
        facts,
      };
    },

    async rollbackPreview(characterId: string, targetPackId: string) {
      assertRole(characterId);
      const pairing = roles.pairingFor(characterId);
      const target = store.getPack(targetPackId);
      if (!target || target.characterId !== characterId) throw new ManagementError('not_found', '目标角色包不存在或不属于该角色。');
      const snapshot = await store.getSnapshot(pairing);
      return {
        apiVersion: 1,
        current: snapshot.activePack ? { packId: snapshot.activePack.id, packVersion: snapshot.activePack.packVersion } : null,
        target: { packId: target.id, packVersion: target.packVersion, name: target.name },
        expectedPackRevision: store.getPackRevision(pairing),
        blockers: [],
      };
    },

    async rollback(input) {
      assertRole(input.characterId);
      if (input.userConfirmed !== true) throw new ManagementError('invalid_request', '回退需要显式确认（userConfirmed:true）。');
      if (!Number.isSafeInteger(input.expectedPackRevision)) throw new ManagementError('invalid_request', 'expectedPackRevision 无效。');
      return mapPackErrors(() => store.rollbackWikiPack({
        pairing: roles.pairingFor(input.characterId), targetPackId: input.targetPackId,
        expectedPackRevision: input.expectedPackRevision, operationId: input.operationId,
      }));
    },
  };
}

/** /api/characters/wiki/import/* — same Bearer authorization as all management routes. */
export function characterWikiImportRoute(
  method: string | undefined, pathname: string, port: WikiImportManagement | undefined, body: () => Promise<Record<string, unknown>>, query: URLSearchParams,
): Promise<unknown> | unknown {
  if (!port) throw new ManagementError('unavailable', '当前实例尚未装配角色 Wiki 导入。');
  if (pathname === '/api/characters/wiki/import/preview') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个 Wiki 导入操作。');
    return body().then(parseInput).then(value => port.preview(value));
  }
  if (pathname === '/api/characters/wiki/import/drafts') {
    if (method === 'GET') {
      const characterId = query.get('characterId') ?? '';
      return port.listDrafts(characterId);
    }
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个 Wiki 导入操作。');
    return body().then(raw => {
      const operationId = requiredText(raw['operationId'], 'operationId', 200);
      const previewHash = requiredText(raw['previewHash'], 'previewHash', 64);
      const value = parseInput(raw);
      return port.saveDraft({ ...value, operationId, previewHash });
    });
  }
  const operationMatch = /^\/api\/characters\/wiki\/operations\/([^/]+)$/.exec(pathname);
  if (operationMatch) {
    if (method !== 'GET') throw new ManagementError('not_found', '没有这个 Wiki 导入操作。');
    return port.getOperation(query.get('characterId') ?? '', decodeURIComponent(operationMatch[1]!));
  }
  // --- WV0-02: apply / rollback / versions --------------------------------------------
  if (pathname === '/api/characters/wiki/apply/preview') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个 Wiki 操作。');
    return body().then(raw => port.applyPreview(requiredText(raw['characterId'], 'characterId', 200), requiredText(raw['importId'], 'importId', 200)));
  }
  if (pathname === '/api/characters/wiki/apply') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个 Wiki 操作。');
    return body().then(raw => port.apply({
      characterId: requiredText(raw['characterId'], 'characterId', 200),
      importId: requiredText(raw['importId'], 'importId', 200),
      documentHash: requiredText(raw['documentHash'], 'documentHash', 64),
      expectedPackRevision: Number(raw['expectedPackRevision']),
      operationId: requiredText(raw['operationId'], 'operationId', 200),
      userConfirmed: raw['userConfirmed'] === true,
    }));
  }
  if (pathname === '/api/characters/wiki/versions') {
    if (method !== 'GET' && method !== 'POST') throw new ManagementError('not_found', '没有这个 Wiki 操作。');
    if (method === 'GET') return port.versions(query.get('characterId') ?? '');
    return body().then(raw => port.versions(requiredText(raw['characterId'], 'characterId', 200)));
  }
  if (pathname === '/api/characters/wiki/facts') {
    if (method !== 'GET') throw new ManagementError('not_found', '没有这个 Wiki 操作。');
    return port.facts(query.get('characterId') ?? '');
  }
  if (pathname === '/api/characters/wiki/rollback/preview') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个 Wiki 操作。');
    return body().then(raw => port.rollbackPreview(requiredText(raw['characterId'], 'characterId', 200), requiredText(raw['targetPackId'], 'targetPackId', 200)));
  }
  if (pathname === '/api/characters/wiki/rollback') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个 Wiki 操作。');
    return body().then(raw => port.rollback({
      characterId: requiredText(raw['characterId'], 'characterId', 200),
      targetPackId: requiredText(raw['targetPackId'], 'targetPackId', 200),
      expectedPackRevision: Number(raw['expectedPackRevision']),
      operationId: requiredText(raw['operationId'], 'operationId', 200),
      userConfirmed: raw['userConfirmed'] === true,
    }));
  }
  const importMatch = /^\/api\/characters\/wiki\/import\/drafts\/([^/]+)$/.exec(pathname);
  if (importMatch) {
    if (method !== 'GET') throw new ManagementError('not_found', '没有这个 Wiki 导入操作。');
    return port.getImport(query.get('characterId') ?? '', decodeURIComponent(importMatch[1]!));
  }
  throw new ManagementError('not_found', '没有这个 Wiki 导入操作。');
}

export const __MAX_TEXT_CODE_POINTS_REF = MAX_TEXT_CODE_POINTS; // keep the constant referenced

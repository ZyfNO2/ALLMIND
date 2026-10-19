// CB-02: one-shot autofill apply across the original owners with a durable journal.
//
// Ordering + atomicity contract (PLAN §8.2, CB-02 SPEC):
//   1. re-parse + verify (import record, revisions, selection, limits) — zero writes;
//   2. journalPrepare (durable intent; same operation + same payload replays, different → 409);
//   3. per-owner commits in order profile → prompt → pack-wiki → lorebook → authorState,
//      each guarded by its own revision gate INSIDE its transaction; progress recorded;
//   4. all domains ok → journalFinish(committed) + receipt; any failure → compensate the
//      already-committed owners back to their previous values (as NEW revisions), then
//      journalFinish(aborted) and report failure — the old effective set stays readable.
// A `prepared` journal row left by a crash is recovered by `recoverPreparedApply` (rolls the
// listed owners back to the receipt's previous values; owner writes are revision-based so a
// partially applied set is still well-defined).
import { ManagementError } from '../contracts/management.js';
import type { CharacterPackStore } from '../memory/character-pack-store.js';
import type { CharacterRoleConfigurationStoreLike } from './character-wiki-roles.js';
import type { RoleConfigurationStore } from './role-configuration.js';
import type { LorebookStore } from '../memory/lorebook-store.js';
import { sha256 } from '../memory/character-pack-source.js';
import type { AikiEntry } from '../contracts/character-document.js';

export interface DocumentApplySelection {
  readonly profile: boolean;
  readonly prompt: boolean;
  readonly wiki: boolean;
  readonly story: boolean;
  readonly state: boolean;
  /** Per-entry opt-out: entry ids the user unchecked. Unlisted entries are applied. */
  readonly skippedEntryIds: readonly string[];
  /** Explicit intro text when the document carries none (CB-02: user-confirmed draft). */
  readonly intro?: string | undefined;
}

export interface DocumentApplyInput {
  readonly characterId: string;
  readonly importId: string;
  readonly documentHash: string;
  readonly selection: DocumentApplySelection;
  readonly expectedRevisions: {
    readonly profileRevision: number | null;
    readonly promptRevision: number | null;
    readonly packRevision: number;
    readonly bookRevision: number | null;
  };
  readonly operationId: string;
  readonly userConfirmed: boolean;
}

export interface DocumentDomainResult {
  readonly saved: boolean;
  readonly applied: boolean;
  readonly detail: string;
}

export interface DocumentApplyReceipt {
  readonly operationId: string;
  readonly importId: string;
  readonly applied: boolean;
  readonly saved: Record<'profile' | 'prompt' | 'wiki' | 'story' | 'state', boolean>;
  readonly applyRecord: Record<'profile' | 'prompt' | 'wiki' | 'story' | 'state', boolean>;
  readonly applyOn: 'now' | 'restart';
  readonly effective: {
    readonly personaRevision: number | null;
    readonly packRevision: number;
    readonly lorebookRevision: number | null;
    readonly lorebookId: string | null;
    readonly authorStateRevision: number;
  };
  readonly previousEffective: {
    readonly personaRevision: number | null;
    readonly packRevision: number;
    readonly lorebookRevision: number | null;
    readonly lorebookId: string | null;
  };
  readonly failure: string | null;
  readonly duplicate: boolean;
}

export interface DocumentApplyDeps {
  readonly store: CharacterPackStore;
  readonly roles: CharacterRoleConfigurationStoreLike;
  readonly profiles: RoleConfigurationStore;
  readonly lorebooks: LorebookStore;
  /** Resolves the management memory port (prompt owner) by admitted character id. */
  readonly memoryOf: (characterId: string) => {
    prompt(characterId: string): { revision: number; text: string };
    savePrompt(input: { characterId: string; text: string; expectedRevision: number; operationId: string }): { revision: number; text: string };
  };
}

/**
 * CB-02: the PRE-APPLY snapshot of every owner an operation may touch.
 *
 * Captured before the first owner mutation and persisted in the journal. Both user rollback and
 * crash recovery replay it, so "失败不留半份数据" holds across a process death too — not only
 * inside the in-process compensation path.
 */
export interface DocumentApplyBaseline {
  readonly profile?: {
    readonly intro: string; readonly scenario?: string | undefined;
    readonly firstMessage?: string | undefined; readonly exampleDialogue?: string | undefined;
  } | null | undefined;
  readonly prompt?: { readonly text: string; readonly revision: number } | undefined;
  /**
   * `null` means the instance had NO active pack before the apply — restoring therefore has to
   * CLEAR the pointer the apply installed, not merely "do nothing".
   */
  readonly packId?: string | null | undefined;
  /**
   * `null` means the role had no aiki storybook before the apply, so restoring has to DELETE the
   * book the apply created. `undefined` (key absent) means the story domain was not selected.
   */
  readonly lorebook?: {
    readonly bookId: string;
    readonly entries: readonly {
      readonly aikiEntryId: string; readonly title: string; readonly content: string;
      readonly strategy: 'keyword' | 'always'; readonly keywords: readonly string[]; readonly enabled: boolean;
    }[];
  } | null | undefined;
  /** `null` means the role had no author-state rows, so restoring has to remove the ones added. */
  readonly authorState?: readonly {
    readonly entryId: string; readonly subtype: string; readonly title: string;
    readonly body: string; readonly dataJson: string | null;
    readonly priority: number; readonly always: boolean; readonly sourceJson: string | null;
    readonly validFrom: string | null; readonly validUntil: string | null;
    readonly updatedAtClient: string | null; readonly expiresAt: string | null;
  }[] | undefined;
}

/** Stable persona-body layout: identity → personality → others by priority → speech. */
export function composePersonaBody(entries: readonly AikiEntry[]): string {
  const personas = entries.filter(e => e.meta.type === 'persona');
  const rank = (subtype: string | undefined): number => {
    if (subtype === 'identity') return 0;
    if (subtype === 'personality') return 1;
    if (subtype === 'speech') return 3;
    return 2;
  };
  const ordered = [...personas].sort((a, b) =>
    rank(a.meta.subtype) - rank(b.meta.subtype)
    || b.meta.priority - a.meta.priority
    || (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0));
  return ordered.map(e => `## ${e.meta.title ?? e.meta.id}\n\n${e.body.trim()}`).join('\n\n');
}

/** First complete short sentence of the identity entry (intro draft; never auto-saved). */
export function draftIntroFromIdentity(entries: readonly AikiEntry[]): { text: string; truncated: boolean } | null {
  const identity = entries.find(e => e.meta.type === 'persona' && e.meta.subtype === 'identity');
  if (!identity) return null;
  const first = identity.body.split(/(?<=[。！？\n])/)[0]?.trim() ?? '';
  if (!first) return null;
  if ([...first].length <= 200) return { text: first, truncated: false };
  return { text: first, truncated: true };
}

const storyKeywordsOf = (entry: AikiEntry): string[] => {
  if (entry.meta.keywords.length > 0) return [...entry.meta.keywords];
  // Fallback noted in the receipt: title segmentation is a heuristic, not knowledge.
  const terms = (entry.meta.title ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(terms)].slice(0, 8);
};

export async function applyCharacterDocument(deps: DocumentApplyDeps, input: DocumentApplyInput): Promise<DocumentApplyReceipt> {
  const { store, roles, profiles, lorebooks } = deps;
  const prompts = deps.memoryOf(input.characterId);
  const characterId = input.characterId;
  if (!roles.exists(characterId)) throw new ManagementError('not_found', '角色不存在。');
  if (!roles.allowsConfiguration(characterId)) throw new ManagementError('invalid_request', '该角色不允许配置。');
  if (input.userConfirmed !== true) throw new ManagementError('invalid_request', '应用需要显式确认（userConfirmed:true）。');
  const operationId = (input.operationId || '').trim();
  if (!operationId) throw new ManagementError('invalid_request', 'operationId 不能为空。');
  const pairing = roles.pairingFor(characterId);

  // Replay: same operation + same payload → original receipt (durable journal).
  const journaled = store.journalGet(operationId);
  const payloadSignature = JSON.stringify({
    characterId, importId: input.importId, documentHash: input.documentHash,
    selection: input.selection, expectedRevisions: input.expectedRevisions,
  });
  if (journaled) {
    const priorPayload = JSON.stringify((journaled.payload as { signature?: unknown }).signature ?? journaled.payload);
    if (journaled.state === 'committed' || journaled.state === 'aborted') {
      if (priorPayload !== JSON.stringify({ signature: payloadSignature }) && JSON.stringify(journaled.payload) !== JSON.stringify({ signature: payloadSignature })) {
        // Payload comparison is on the wrapped form; fall back to raw comparison for old rows.
        throw new ManagementError('version_conflict', '同一操作编号对应不同的应用内容。');
      }
      return { ...(journaled.receipt as DocumentApplyReceipt), duplicate: true };
    }
    // A `prepared` row means a previous attempt died mid-flight: fall through and recover first.
  }

  const record = store.aikiImportRecord(input.importId);
  if (!record || record.characterId !== characterId) throw new ManagementError('not_found', '导入记录不存在或不属于该角色。');
  if (record.mode !== 'aiki-character' || !record.normalizedJson) throw new ManagementError('invalid_request', '来源草稿（普通 Markdown）不能应用为角色文档。');
  if (record.documentHash !== input.documentHash) throw new ManagementError('version_conflict', '导入内容已变化；请重新预览并确认。');
  const normalized = JSON.parse(record.normalizedJson) as {
    frontmatter: { id: string; authoring: { intro?: string; scenario?: string; firstMessage?: string; exampleDialogue?: string } };
    entries: { meta: AikiEntry['meta']; body: string }[];
  };
  const entries = normalized.entries as unknown as AikiEntry[];
  // Blocked entries (dangling refs) selected for apply are refused before any write.
  const blocked = new Set<string>();
  const ids = new Set(entries.map(e => e.meta.id));
  for (const entry of entries) {
    for (const ref of entry.meta.related) if (!ids.has(ref)) blocked.add(entry.meta.id);
    const srcRef = entry.meta.source?.ref;
    if (srcRef && !ids.has(srcRef)) blocked.add(entry.meta.id);
  }
  const skipped = new Set(input.selection.skippedEntryIds);
  for (const id of skipped) {
    if (!ids.has(id)) throw new ManagementError('invalid_request', `选择中包含未知条目 "${id}"。`);
  }
  for (const id of blocked) {
    if (!skipped.has(id) && (input.selection.prompt || input.selection.wiki || input.selection.story || input.selection.state)) {
      throw new ManagementError('invalid_request', `条目 "${id}" 引用悬空，不能应用；请取消选择或修正文档。`);
    }
  }
  const wanted = entries.filter(e => !skipped.has(e.meta.id));

  store.journalPrepare(operationId, characterId, input.importId, { signature: payloadSignature });

  // Capture the PRE-APPLY snapshot BEFORE the first owner mutation and persist it. This is what
  // makes rollback and crash recovery real rather than journal-only bookkeeping.
  const baseline: DocumentApplyBaseline = {
    profile: input.selection.profile ? (() => {
      const current = profiles.get(characterId);
      return current ? {
        intro: current.identity.intro,
        ...(current.persona.scenario === undefined ? {} : { scenario: current.persona.scenario }),
        ...(current.persona.firstMessage === undefined ? {} : { firstMessage: current.persona.firstMessage }),
        ...(current.persona.exampleDialogue === undefined ? {} : { exampleDialogue: current.persona.exampleDialogue }),
      } : null;
    })() : undefined,
    ...(input.selection.prompt ? { prompt: prompts.prompt(characterId) } : {}),
    // Always record the KEY when the domain is selected — even when the value is null. `undefined`
    // would be indistinguishable from "not selected" and the restore would silently skip it.
    ...(input.selection.wiki ? { packId: store.activePackIdOf(pairing) } : {}),
    ...(input.selection.story ? {
      lorebook: (() => {
        const book = lorebooks.list(characterId).find(candidate => candidate.title === '角色故事书');
        if (!book) return null; // no storybook existed → restore must delete the one apply creates
        return {
          bookId: book.id,
          entries: book.entries.filter(entry => entry.aikiEntryId).map(entry => ({
            aikiEntryId: entry.aikiEntryId!, title: entry.title, content: entry.content,
            strategy: entry.strategy, keywords: [...entry.keywords], enabled: entry.enabled,
          })),
        };
      })(),
    } : {}),
    ...(input.selection.state ? {
      authorState: store.authorStateOf(characterId).map(row => ({
        entryId: row.entryId, subtype: row.subtype, title: row.title, body: row.body,
        dataJson: row.dataJson, priority: row.priority, always: row.always, sourceJson: row.sourceJson,
        validFrom: row.validFrom, validUntil: row.validUntil, updatedAtClient: row.updatedAtClient,
        expiresAt: row.expiresAt,
      })),
    } : {}),
  };
  store.journalBaseline(operationId, baseline);

  const saved = { profile: false, prompt: false, wiki: false, story: false, state: false };
  const applyRecord = { profile: false, prompt: false, wiki: false, story: false, state: false };
  const compensations: (() => Promise<void>)[] = [];
  const fail = async (message: string): Promise<DocumentApplyReceipt> => {
    // Compensate in reverse order; each compensation is itself revision-safe (new revision).
    for (const undo of compensations.reverse()) {
      try { await undo(); } catch { /* best effort; the failure receipt carries the truth */ }
    }
    const receipt: DocumentApplyReceipt = {
      operationId, importId: input.importId, applied: false,
      saved: { ...saved }, applyRecord: { ...applyRecord }, applyOn: 'restart',
      effective: {
        personaRevision: prompts.prompt(characterId).revision,
        packRevision: store.getPackRevision(pairing),
        lorebookRevision: null, lorebookId: null, authorStateRevision: 0,
      },
      previousEffective: {
        personaRevision: input.expectedRevisions.promptRevision,
        packRevision: input.expectedRevisions.packRevision,
        lorebookRevision: input.expectedRevisions.bookRevision,
        lorebookId: null,
      },
      failure: message, duplicate: false,
    };
    store.journalFinish(operationId, 'aborted', receipt);
    return receipt;
  };

  try {
    // --- revision gates FIRST (CB-02 SPEC §提交前一次验证) ---
    // Every selected domain's expected revision is verified BEFORE any noop short-circuit, so a
    // stale caller is always rejected (version_conflict) instead of being told "nothing to do".
    if (input.selection.profile && input.expectedRevisions.profileRevision !== null) {
      const live = profiles.get(characterId);
      if (live && (live.fieldRevision ?? 0) !== input.expectedRevisions.profileRevision) {
        return fail(`角色资料已更新（期望字段修订 ${input.expectedRevisions.profileRevision}，当前 ${live.fieldRevision ?? 0}），请刷新后再保存。`);
      }
    }
    if (input.selection.prompt && input.expectedRevisions.promptRevision !== null) {
      const live = prompts.prompt(characterId);
      if (live.revision !== input.expectedRevisions.promptRevision) {
        return fail(`人设正文已更新（期望修订 ${input.expectedRevisions.promptRevision}，当前 ${live.revision}），请刷新后再保存。`);
      }
    }
    if ((input.selection.wiki || input.selection.story) && input.expectedRevisions.packRevision !== undefined) {
      const livePack = store.getPackRevision(pairing);
      if (livePack !== input.expectedRevisions.packRevision) {
        return fail(`角色包修订已变化（当前 ${livePack}，请求基于 ${input.expectedRevisions.packRevision}）；请刷新预览后重新确认。`);
      }
    }

    // --- profile (author fields; absent fields never clear live values) ---
    // Noop short-circuit: every selected field already equals the live value → skip the owner
    // (no fieldRevision advance). The revision gate above has already run.
    if (input.selection.profile) {
      const authoring = normalized.frontmatter.authoring ?? {};
      const intro = authoring.intro ?? input.selection.intro;
      const current = profiles.get(characterId);
      const expected = input.expectedRevisions.profileRevision;
      const profileNoop = !!current
        && (intro === undefined || current.identity.intro === intro)
        && (authoring.scenario === undefined || current.persona.scenario === authoring.scenario)
        && (authoring.firstMessage === undefined || current.persona.firstMessage === authoring.firstMessage)
        && (authoring.exampleDialogue === undefined || current.persona.exampleDialogue === authoring.exampleDialogue);
      if (profileNoop) {
        saved.profile = true; applyRecord.profile = false;
        store.journalProgress(operationId, { profile: true });
      } else {
      const before = current ? {
        intro: current.identity.intro, scenario: current.persona.scenario,
        firstMessage: current.persona.firstMessage, exampleDialogue: current.persona.exampleDialogue,
      } : null;
      const next = await profiles.saveAuthorMetadata(characterId, {
        ...(intro === undefined ? {} : { intro }),
        ...(authoring.scenario === undefined ? {} : { scenario: authoring.scenario }),
        ...(authoring.firstMessage === undefined ? {} : { firstMessage: authoring.firstMessage }),
        ...(authoring.exampleDialogue === undefined ? {} : { exampleDialogue: authoring.exampleDialogue }),
        sourceRef: `aiki-doc:${input.importId}`,
        ...(expected === null ? {} : { expectedFieldRevision: expected }),
        operationId: `${operationId}:profile`,
      });
      void next;
      saved.profile = true; applyRecord.profile = false;
      store.journalProgress(operationId, { profile: true });
      if (before) {
        compensations.push(async () => {
          const live = profiles.get(characterId);
          await profiles.saveAuthorMetadata(characterId, {
            intro: before.intro,
            ...(before.scenario === undefined ? {} : { scenario: before.scenario }),
            ...(before.firstMessage === undefined ? {} : { firstMessage: before.firstMessage }),
            ...(before.exampleDialogue === undefined ? {} : { exampleDialogue: before.exampleDialogue }),
            expectedFieldRevision: live?.fieldRevision ?? 0,
            operationId: `${operationId}:profile-undo`,
          });
        });
      }
      }
    }

    // --- prompt (persona body; composed in the SPEC-frozen order) ---
    // Noop short-circuit: identical body → skip the owner (no revision advance).
    if (input.selection.prompt) {
      const body = composePersonaBody(wanted);
      if (!body.trim()) return fail('Persona 条目为空，不能写入人设正文。');
      const before = prompts.prompt(characterId);
      if (before.text === body) {
        saved.prompt = true; applyRecord.prompt = true;
        store.journalProgress(operationId, { profile: saved.profile, prompt: true });
      } else {
        const after = prompts.savePrompt({ characterId, text: body, expectedRevision: before.revision, operationId: `${operationId}:prompt` });
        void after;
        saved.prompt = true; applyRecord.prompt = true;
        store.journalProgress(operationId, { profile: saved.profile, prompt: true });
        compensations.push(async () => {
          const live = prompts.prompt(characterId);
          prompts.savePrompt({ characterId, text: before.text, expectedRevision: live.revision, operationId: `${operationId}:prompt-undo` });
        });
      }
    }

    // --- pack wiki facts ---
    // Noop short-circuit (PLAN §8.1): when every wanted fact already matches the live pack
    // text, skip the owner entirely — no new pack version, no revision advance. Otherwise the
    // second identical apply would mint an empty pack version and break "重导无推进".
    if (input.selection.wiki) {
      const facts = wanted.filter(e => e.meta.type === 'wiki').map(e => ({ id: e.meta.id, text: `## ${e.meta.title ?? e.meta.id}\n\n${e.body.trim()}` }));
      const liveFacts = new Map((((await store.getSnapshot(pairing)).activePack?.wikiFacts ?? [])).map(fact => [fact.id, fact.text]));
      const dirty = facts.filter(fact => liveFacts.get(fact.id) !== fact.text);
      if (dirty.length === 0) {
        saved.wiki = true; applyRecord.wiki = true;
        store.journalProgress(operationId, { profile: saved.profile, prompt: saved.prompt, wiki: true });
      } else if (facts.length > 0) {
        const beforePackId = (await store.getSnapshot(pairing)).activePack?.id ?? null;
        const outcome = store.applyAikiWikiFacts({
          pairing, importId: input.importId, facts,
          expectedPackRevision: input.expectedRevisions.packRevision,
          operationId: `${operationId}:wiki`,
        });
        void outcome;
        saved.wiki = true; applyRecord.wiki = true;
        store.journalProgress(operationId, { profile: saved.profile, prompt: saved.prompt, wiki: true });
        if (beforePackId) {
          compensations.push(async () => {
            const liveRevision = store.getPackRevision(pairing);
            await store.rollbackWikiPack({ pairing, targetPackId: beforePackId, expectedPackRevision: liveRevision, operationId: `${operationId}:wiki-undo` });
          });
        }
      } else {
        saved.wiki = true; applyRecord.wiki = true;
      }
    }

    // --- lorebook story entries ---
    let lorebookId: string | null = null;
    if (input.selection.story) {
      const storyEntries = wanted.filter(e => e.meta.type === 'story').map(e => ({
        aikiEntryId: e.meta.id,
        title: e.meta.title ?? e.meta.id,
        content: e.body.trim(),
        strategy: (e.meta.always ? 'always' : 'keyword') as 'keyword' | 'always',
        keywords: e.meta.keywords.length > 0 ? [...e.meta.keywords] : storyKeywordsFallback(e),
        metadataJson: JSON.stringify({
          subtype: e.meta.subtype, scope: e.meta.scope, priority: e.meta.priority, always: e.meta.always,
          time: e.meta.time, characters: e.meta.characters, locations: e.meta.locations,
          entities: e.meta.entities, importance: e.meta.importance, canon: e.meta.canon,
          related: e.meta.related, source: e.meta.source,
        }),
        contentHash: sha256(JSON.stringify({ meta: e.meta, body: e.body })),
      }));
      if (storyEntries.length > 0) {
        const outcome = lorebooks.upsertAikiEntries({
          ownerCharacterId: characterId, bookTitle: '角色故事书',
          operationId: `${operationId}:story`, importId: input.importId,
          ...(input.expectedRevisions.bookRevision === null ? {} : { expectedBookRevision: input.expectedRevisions.bookRevision }),
          entries: storyEntries,
        });
        lorebookId = outcome.bookId;
        saved.story = true; applyRecord.story = true;
        store.journalProgress(operationId, { profile: saved.profile, prompt: saved.prompt, wiki: saved.wiki, story: true });
      } else {
        saved.story = true; applyRecord.story = true;
      }
    }

    // --- author initial state ---
    if (input.selection.state) {
      const stateEntries = wanted.filter(e => e.meta.type === 'state').map(e => ({
        entryId: e.meta.id, subtype: e.meta.subtype ?? '', title: e.meta.title ?? e.meta.id,
        body: e.body.trim(), ...(e.meta.data !== undefined ? { dataJson: e.meta.data } : {}),
        priority: e.meta.priority, always: e.meta.always,
        ...(e.meta.source !== undefined ? { sourceJson: JSON.stringify(e.meta.source) } : {}),
        ...(e.meta.validFrom !== undefined ? { validFrom: e.meta.validFrom } : {}),
        ...(e.meta.validUntil !== undefined ? { validUntil: e.meta.validUntil } : {}),
        ...(e.meta.updatedAt !== undefined ? { updatedAtClient: e.meta.updatedAt } : {}),
        ...(e.meta.expiresAt !== undefined ? { expiresAt: e.meta.expiresAt } : {}),
        contentHash: sha256(JSON.stringify({ meta: e.meta, body: e.body })),
      }));
      if (stateEntries.length > 0) {
        store.upsertAuthorState({ characterId, importId: input.importId, entries: stateEntries });
        saved.state = true; applyRecord.state = true;
        store.journalProgress(operationId, { profile: saved.profile, prompt: saved.prompt, wiki: saved.wiki, story: saved.story, state: true });
      } else {
        saved.state = true; applyRecord.state = true;
      }
    }

    const books = lorebooks.list(characterId);
    const lorebookRevision = books.length > 0 ? Math.max(...books.map(b => b.revision)) : null;
    const receipt: DocumentApplyReceipt = {
      operationId, importId: input.importId, applied: true,
      saved: { ...saved }, applyRecord: { ...applyRecord }, applyOn: 'restart',
      effective: {
        personaRevision: prompts.prompt(characterId).revision,
        packRevision: store.getPackRevision(pairing),
        lorebookRevision, lorebookId,
        authorStateRevision: store.authorStateOf(characterId).length,
      },
      previousEffective: {
        personaRevision: input.expectedRevisions.promptRevision,
        packRevision: input.expectedRevisions.packRevision,
        lorebookRevision: input.expectedRevisions.bookRevision,
        lorebookId: null,
      },
      failure: null, duplicate: false,
    };
    store.journalFinish(operationId, 'committed', receipt);
    return receipt;
  } catch (error) {
    if (error instanceof ManagementError) return fail(`${error.code}：${error.message}`);
    const code = (error as { code?: string }).code;
    if (code && ['version_conflict', 'not_found', 'validation_failed', 'invalid_request'].includes(code)) {
      return fail(`${code}：${(error as Error).message}`);
    }
    return fail(`这次管理操作未完成：${(error as Error).message}`);
  }
}

const storyKeywordsFallback = (entry: AikiEntry): string[] => {
  const terms = (entry.meta.title ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(terms)].slice(0, 8);
};

/**
 * CB-02: restore every owner to the operation's recorded pre-apply snapshot.
 *
 * Used by BOTH user rollback and crash recovery. Restores are written as NEW revisions (history is
 * never rewritten) and are individually idempotent, so a repeated call converges. Returns what was
 * actually restored so the caller can report the truth instead of a blanket success.
 */
export async function restoreFromBaseline(
  deps: DocumentApplyDeps,
  params: { readonly characterId: string; readonly operationId: string; readonly importId: string },
): Promise<{ restored: Record<'profile' | 'prompt' | 'wiki' | 'story' | 'state', boolean>; detail: string }> {
  const { store, profiles, lorebooks } = deps;
  const prompts = deps.memoryOf(params.characterId);
  const characterId = params.characterId;
  const pairing = deps.roles.pairingFor(characterId);
  const baseline = store.journalBaselineOf(params.operationId) as DocumentApplyBaseline | null;
  const restored = { profile: false, prompt: false, wiki: false, story: false, state: false };
  if (!baseline) return { restored, detail: '该操作没有记录回退基线（早于基线记录的旧操作），未做任何写入。' };

  // profile — restore the four author fields as a NEW field revision.
  if (baseline.profile !== undefined) {
    const live = profiles.get(characterId);
    if (live) {
      await profiles.saveAuthorMetadata(characterId, {
        intro: baseline.profile?.intro ?? '',
        ...(baseline.profile?.scenario === undefined ? {} : { scenario: baseline.profile.scenario }),
        ...(baseline.profile?.firstMessage === undefined ? {} : { firstMessage: baseline.profile.firstMessage }),
        ...(baseline.profile?.exampleDialogue === undefined ? {} : { exampleDialogue: baseline.profile.exampleDialogue }),
        expectedFieldRevision: live.fieldRevision ?? 0,
        operationId: `${params.operationId}:restore-profile`,
      });
      restored.profile = true;
    }
  }

  // prompt — restore the previous body as a new revision.
  if (baseline.prompt !== undefined) {
    const live = prompts.prompt(characterId);
    if (live.text !== baseline.prompt.text) {
      prompts.savePrompt({
        characterId, text: baseline.prompt.text, expectedRevision: live.revision,
        operationId: `${params.operationId}:restore-prompt`,
      });
    }
    restored.prompt = true;
  }

  // pack — move the instance pointer back. A null baseline means the apply INSTALLED the pack, so
  // restoring must clear the pointer again (immutable pack versions themselves are never deleted).
  if (baseline.packId !== undefined) {
    const livePackId = store.activePackIdOf(pairing);
    if (baseline.packId === null) {
      if (livePackId !== null) store.clearActivePack({ pairing, operationId: `${params.operationId}:restore-pack` });
    } else if (livePackId !== baseline.packId) {
      store.restoreActivePack({ pairing, targetPackId: baseline.packId, operationId: `${params.operationId}:restore-pack` });
    }
    restored.wiki = true;
  }

  // lorebook — restore aiki-linked entries; user-authored entries are never touched. A null
  // baseline means the apply CREATED the storybook, so it is deleted again.
  if (baseline.lorebook !== undefined) {
    if (baseline.lorebook === null) {
      const created = lorebooks.list(characterId).find(candidate => candidate.title === '角色故事书');
      if (created) lorebooks.deleteBook(created.id, characterId, created.revision, `${params.operationId}:restore-book`);
    } else {
      lorebooks.restoreAikiEntries({
        ownerCharacterId: characterId, bookId: baseline.lorebook.bookId,
        entries: baseline.lorebook.entries.map(entry => ({ ...entry, keywords: [...entry.keywords] })),
      });
    }
    restored.story = true;
  }

  // author state — restore recorded rows and drop rows this operation introduced.
  if (baseline.authorState !== undefined) {
    store.restoreAuthorState({
      characterId, importId: params.importId,
      rows: baseline.authorState.map(row => ({ ...row })),
    });
    restored.state = true;
  }

  const parts = Object.entries(restored).filter(([, value]) => value).map(([key]) => key);
  return { restored, detail: parts.length > 0 ? `已恢复：${parts.join('、')}。` : '没有需要恢复的域。' };
}

/** CB-02: recover a `prepared` journal row left by a crash (rolls owners back, marks aborted). */
export async function recoverPreparedApply(deps: DocumentApplyDeps, operationId: string): Promise<{ recovered: boolean; reason: string }> {
  const journaled = deps.store.journalGet(operationId);
  if (!journaled) return { recovered: false, reason: 'no-journal' };
  if (journaled.state !== 'prepared') return { recovered: false, reason: `already-${journaled.state}` };
  // A `prepared` row means the process died mid-apply: some owners may ALREADY hold new values.
  // Restoring the recorded baseline is therefore mandatory — merely marking the journal aborted
  // would leave exactly the half-applied state the journal exists to prevent.
  const outcome = await restoreFromBaseline(deps, {
    characterId: journaled.characterId, operationId, importId: journaled.importId,
  });
  deps.store.journalFinish(operationId, 'aborted', {
    operationId, recovered: true, restored: outcome.restored, detail: outcome.detail,
  });
  return { recovered: true, reason: `restored-baseline:${outcome.detail}` };
}

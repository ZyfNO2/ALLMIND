/**
 * management/character-distillation-publish.ts
 *
 * CK-08: explicit, confirmed publication of a CK-07 distillation draft to the EXISTING owners.
 *
 * This module owns no storage and never writes a second persona. It composes three real owners:
 *
 *   persona   → `PersonaPort`        (backed by `memory.savePrompt`, the authority CK-00 froze)
 *   pack      → `CharacterPackStore` (activateDraft / instance pointer)
 *   lorebook  → `LorebookStore`      (authored fiction, keyword/always, budgets preserved)
 *
 * The consistency rule that shapes the whole design: a turn must never observe half of a new
 * persona and half of an old pack. So publication is a **prepare → single effective pointer → receipt**
 * sequence, and a failure at any stage leaves the PREVIOUS effective set intact and clearly reported.
 *
 * `saved` is never reported as `applied`. If the running process has not consumed the new version
 * (because a restart is required), the receipt says so with an explicit `applyOn`.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { CharacterPack, CharacterPackDraft } from '../contracts/character-pack.js';

export type PublishDomain = 'persona' | 'pack' | 'lorebook';

/** The minimum each owner must expose. Kept structural so the real stores satisfy it unchanged. */
export interface PersonaPort {
  revision(characterId: string): Promise<number>;
  save(input: {
    readonly characterId: string; readonly expectedRevision: number; readonly text: string;
    readonly operationId: string;
  }): Promise<{ text: string; revision: number }>;
}

export interface PackPublishPort {
  getDraft(draftId: string): CharacterPackDraft | null;
  getPackRevision(pairing: { userId: string; characterId: string; characterInstanceId: string }): number;
  activateDraft(params: {
    readonly characterId: string; readonly draftId: string;
    readonly userId?: string | undefined; readonly instanceId?: string | undefined;
  }): Promise<CharacterPack>;
}

export interface LorebookPort {
  revision(ownerCharacterId: string): number;
  get(id: string, ownerCharacterId: string): { id: string; revision: number } | null;
  commitImport(
    ownerCharacterId: string,
    preview: { title: string; entries: { title: string; content: string; strategy: 'keyword' | 'always'; keywords: string[]; enabled: boolean }[] },
    operationId: string,
  ): { id: string; revision: number };
}

export interface PublicationOwnerSet {
  readonly persona: PersonaPort;
  readonly pack: PackPublishPort;
  readonly lorebook: LorebookPort;
}

export interface PreviewRequest {
  readonly characterId: string;
  readonly draftId: string;
  readonly expectedDraftRevision?: number | undefined;
  /** Which domains the user selected. An unselected domain is never touched. */
  readonly selection: readonly PublishDomain[];
  readonly lorebook?: { readonly title: string; readonly entries: readonly { title: string; content: string; strategy: 'keyword' | 'always'; keywords: string[]; enabled: boolean }[] };
}

export interface PublicationPreview {
  readonly previewRef: string;
  readonly characterId: string;
  readonly draftId: string;
  readonly selection: readonly PublishDomain[];
  readonly current: EffectiveRevisions;
  readonly proposed: {
    readonly personaText: string | null;
    readonly packVersion: string | null;
    readonly lorebookTitle: string | null;
    readonly lorebookEntryCount: number;
  };
  /** Everything that would block publication, so nothing is discovered halfway through. */
  readonly blockers: readonly string[];
  readonly gaps: readonly string[];
}

/** The lorebook payload a preview was built from. Kept outside the preview so it stays a pure diff view. */
export interface PreviewLorebook {
  readonly title: string;
  readonly entries: readonly {
    title: string; content: string; strategy: 'keyword' | 'always'; keywords: string[]; enabled: boolean;
  }[];
}

export interface PublishRequest {
  readonly operationId: string;
  readonly previewRef: string;
  readonly expectedPersonaRevision: number;
  readonly expectedPackRevision: number;
  readonly expectedLorebookRevision?: number | undefined;
  readonly userConfirmed: boolean;
  readonly userId?: string | undefined;
  readonly instanceId?: string | undefined;
}

export interface PublishReceipt {
  readonly operationId: string;
  readonly activationSetId: string;
  readonly saved: Readonly<Record<PublishDomain, boolean>>;
  /**
   * Whether the RUNNING process is already serving the new version. A `saved` domain that needs a
   * restart reports `applyOn:'restart'` and `applied:false` — it is never passed off as live.
   */
  readonly applied: Readonly<Record<PublishDomain, boolean>>;
  readonly applyOn: 'now' | 'restart' | 'unknown';
  readonly effective: EffectiveRevisions & { readonly lorebookId: string | null };
  /** The set that remains effective if this publish fails or is rolled back. */
  readonly previousEffective: EffectiveRevisions;
  readonly failure: string | null;
}

export interface PublicationCoordinatorOptions {
  readonly owners: PublicationOwnerSet;
  readonly pairingOf: (characterId: string) => { userId: string; characterId: string; characterInstanceId: string };
  /** True when the running process already reads the new version without a restart. */
  readonly appliesWithoutRestart?: () => boolean;
  /** Seeds the initial persona revision; the owner remains the authority afterwards. */
  readonly initialPersonaRevision?: (characterId: string) => Promise<number>;
  readonly now?: () => string;
}

/** The revision triple every owner agrees on; the unit of consistency for one character. */
export interface EffectiveRevisions {
  readonly personaRevision: number;
  readonly packRevision: number;
  readonly lorebookRevision: number | null;
}

interface EffectiveSet extends EffectiveRevisions { readonly lorebookId: string | null }

export class PublicationConflictError extends Error {
  constructor(readonly code: 'version_conflict' | 'preview_expired' | 'not_confirmed' | 'blocked', message: string) {
    super(message);
    this.name = 'PublicationConflictError';
  }
}

export class CharacterPublicationCoordinator {
  private readonly previews = new Map<string, PublicationPreview>();
  private readonly lorebookPayloads = new Map<string, PreviewLorebook>();
  private readonly receipts = new Map<string, { readonly signature: string; readonly receipt: PublishReceipt }>();
  /** The single effective pointer. A failure never advances it. */
  private readonly effective = new Map<string, EffectiveSet>();

  constructor(private readonly options: PublicationCoordinatorOptions) {}

  /**
   * Build a preview: current revisions, proposed content, and every blocker — computed BEFORE any
   * write, so a doomed publish fails at preview time rather than halfway.
   */
  async preview(request: PreviewRequest): Promise<PublicationPreview> {
    const draft = this.options.owners.pack.getDraft(request.draftId);
    const blockers: string[] = [];
    const gaps: string[] = [];

    if (!draft) blockers.push('draft_not_found');
    else if (draft.characterId !== request.characterId) blockers.push('draft_character_mismatch');
    else {
      if (!draft.validation.valid) blockers.push('draft_not_validated');
      if (draft.status !== 'validated') blockers.push('draft_not_publishable');
      for (const sourceId of draft.sourceIds) {
        if (this.#isSourceRevoked(request.characterId, sourceId)) blockers.push(`source_revoked:${sourceId}`);
      }
      for (const gap of draft.payload.gaps) gaps.push(gap);
    }

    const selection = [...new Set(request.selection)];
    if (selection.length === 0) blockers.push('empty_selection');
    if (selection.includes('lorebook') && (!request.lorebook || request.lorebook.entries.length === 0)) {
      blockers.push('lorebook_entries_missing');
    }

    const personaRevision = await this.options.owners.persona.revision(request.characterId);
    this.seeded.set(request.characterId, personaRevision);
    const packRevision = this.options.owners.pack.getPackRevision(this.options.pairingOf(request.characterId));
    const lorebookRevision = selection.includes('lorebook')
      ? this.#currentLorebookRevision(request.characterId)
      : null;

    const preview: PublicationPreview = {
      previewRef: `prev-${randomUUID()}`,
      characterId: request.characterId,
      draftId: request.draftId,
      selection,
      current: { personaRevision, packRevision, lorebookRevision },
      proposed: {
        personaText: draft && selection.includes('persona') ? draft.payload.character.soul : null,
        packVersion: draft && selection.includes('pack') ? (draft.packVersion || 'auto') : null,
        lorebookTitle: request.lorebook && selection.includes('lorebook') ? request.lorebook.title : null,
        lorebookEntryCount: request.lorebook?.entries.length ?? 0,
      },
      blockers: Object.freeze(blockers),
      gaps: Object.freeze(gaps),
    };
    this.previews.set(preview.previewRef, preview);
    if (request.lorebook && request.lorebook.entries.length > 0) {
      this.lorebookPayloads.set(preview.previewRef, { title: request.lorebook.title, entries: [...request.lorebook.entries] });
    }
    return preview;
  }

  /**
   * Publish a previewed selection.
   *
   * Ordering is deliberate: persona (its own owner decides its revision) → pack (immutable version)
   * → lorebook → receipt. A failure records the reason and leaves the previous effective set
   * untouched; it never silently reports success.
   */
  async publish(previewRef: string, request: PublishRequest): Promise<PublishReceipt> {
    const signature = createHash('sha256').update(JSON.stringify({
      previewRef, request: {
        expectedPersonaRevision: request.expectedPersonaRevision,
        expectedPackRevision: request.expectedPackRevision,
        expectedLorebookRevision: request.expectedLorebookRevision ?? null,
        userConfirmed: request.userConfirmed,
      },
    })).digest('hex');

    const prior = this.receipts.get(request.operationId);
    if (prior) {
      // A replay returns the first receipt; the same id with different intent is a conflict.
      if (prior.signature !== signature) throw new PublicationConflictError('version_conflict', '同一 operationId 已用于其他发布意图。');
      return prior.receipt;
    }

    const preview = this.previews.get(previewRef);
    if (!preview) throw new PublicationConflictError('preview_expired', '预览已失效，请重新预览。');
    if (!request.userConfirmed) throw new PublicationConflictError('not_confirmed', '发布前必须由用户确认。');
    if (preview.blockers.length > 0) throw new PublicationConflictError('blocked', `草稿不可发布：${preview.blockers.join(',')}`);

    const characterId = preview.characterId;
    const pairing = this.options.pairingOf(characterId);
    const previousEffective = this.#effectiveSet(characterId);
    const saved = { persona: false, pack: false, lorebook: false };
    let lorebookId: string | null = previousEffective.lorebookId;
    let failure: string | null = null;

    if (preview.selection.includes('persona') && preview.proposed.personaText !== null) {
      // The authoritative check is against the OWNER's live revision, not the value remembered in
      // the preview. Comparing against the preview snapshot would let a change made after the
      // preview slip through and be silently overwritten.
      const livePersona = await this.options.owners.persona.revision(characterId);
      if (request.expectedPersonaRevision !== livePersona || preview.current.personaRevision !== livePersona) {
        throw new PublicationConflictError('version_conflict', '人设已被他人修改，请重新预览。');
      }
      try {
        await this.options.owners.persona.save({
          characterId, expectedRevision: livePersona,
          text: preview.proposed.personaText, operationId: `${request.operationId}:persona`,
        });
        saved.persona = true;
      } catch (error) { failure = `persona:${(error as Error).message}`; }
    }

    if (!failure && preview.selection.includes('pack')) {
      const livePack = this.options.owners.pack.getPackRevision(pairing);
      if (request.expectedPackRevision !== livePack || preview.current.packRevision !== livePack) {
        throw new PublicationConflictError('version_conflict', '角色包已被他人修改，请重新预览。');
      }
      try {
        await this.options.owners.pack.activateDraft({
          characterId, draftId: preview.draftId,
          ...(request.userId === undefined ? {} : { userId: request.userId }),
          ...(request.instanceId === undefined ? {} : { instanceId: request.instanceId }),
        });
        saved.pack = true;
      } catch (error) { failure = `pack:${(error as Error).message}`; }
    }

    if (!failure && preview.selection.includes('lorebook')) {
      const book = this.lorebookPayloads.get(previewRef);
      if (book) {
        try {
          const committed = this.options.owners.lorebook.commitImport(characterId, {
            title: book.title, entries: [...book.entries],
          }, `${request.operationId}:lorebook`);
          lorebookId = committed.id;
          saved.lorebook = true;
        } catch (error) { failure = `lorebook:${(error as Error).message}`; }
      }
    }

    const appliesNow = this.options.appliesWithoutRestart?.() ?? false;
    const effective = {
      personaRevision: saved.persona ? request.expectedPersonaRevision + 1 : previousEffective.personaRevision,
      packRevision: this.options.owners.pack.getPackRevision(pairing),
      lorebookId,
      lorebookRevision: saved.lorebook ? this.options.owners.lorebook.revision(characterId) : previousEffective.lorebookRevision,
    };

    // The effective pointer advances only when at least one selected domain was actually saved.
    if (!failure && Object.values(saved).some(Boolean)) {
      this.effective.set(characterId, effective);
    }

    const receipt: PublishReceipt = Object.freeze({
      operationId: request.operationId,
      activationSetId: `act-${randomUUID()}`,
      saved: Object.freeze(saved),
      // `saved` is persistence; `applied` is "the running process serves it now". Never conflate.
      applied: Object.freeze({
        persona: saved.persona && appliesNow,
        pack: saved.pack && appliesNow,
        lorebook: saved.lorebook && appliesNow,
      }),
      applyOn: appliesNow ? 'now' : 'restart',
      effective: Object.freeze(effective),
      previousEffective,
      failure,
    });
    this.receipts.set(request.operationId, { signature, receipt });
    return receipt;
  }

  /** The set currently in force for a character. */
  effectiveSet(characterId: string): EffectiveRevisions {
    const current = this.#effectiveSet(characterId);
    return { personaRevision: current.personaRevision, packRevision: current.packRevision, lorebookRevision: current.lorebookRevision };
  }

  /**
   * Roll back to the previous effective set.
   *
   * Rollback is explicit and version-bound, and it never overwrites a NEWER manual correction: a
   * target older than what is live is refused rather than silently applied.
   */
  rollback(characterId: string, to: EffectiveRevisions): { readonly restored: boolean; readonly effective: EffectiveRevisions; readonly reason: string | null } {
    const current = this.#effectiveSet(characterId);
    if (to.personaRevision > current.personaRevision) {
      return { restored: false, effective: this.effectiveSet(characterId), reason: 'rollback_would_overwrite_newer_persona' };
    }
    this.effective.set(characterId, { ...to, lorebookId: current.lorebookId });
    return { restored: true, effective: to, reason: null };
  }

  #effectiveSet(characterId: string): EffectiveSet {
    const existing = this.effective.get(characterId);
    if (existing) return existing;
    const seeded: EffectiveSet = {
      personaRevision: this.seededPersonaRevision(characterId),
      packRevision: this.options.owners.pack.getPackRevision(this.options.pairingOf(characterId)),
      lorebookRevision: null,
      lorebookId: null,
    };
    this.effective.set(characterId, seeded);
    return seeded;
  }

  /** Seeded synchronously at construction; the owner stays authoritative after the first publish. */
  private seededPersonaRevision(characterId: string): number {
    return this.seeded.get(characterId) ?? 0;
  }

  private readonly seeded = new Map<string, number>();

  /** Record the owner's current persona revision so the first rollback target is meaningful. */
  async seed(characterId: string): Promise<void> {
    const revision = await this.options.owners.persona.revision(characterId);
    this.seeded.set(characterId, revision);
  }

  #currentLorebookRevision(characterId: string): number | null {
    return this.options.owners.lorebook.revision(characterId);
  }

  #isSourceRevoked(characterId: string, sourceId: string): boolean {
    const pack = this.options.owners.pack as Partial<{ isSourceRevoked(c: string, s: string): boolean }>;
    return typeof pack.isSourceRevoked === 'function' ? pack.isSourceRevoked(characterId, sourceId) : false;
  }
}

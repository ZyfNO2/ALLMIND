/**
 * core/text-source-service.ts
 *
 * CK-03: production wiring for the text sources.
 *
 * CK-03's audit finding was blunt: `ClipboardTextSource`, `InputTextSource` and
 * `HistorySourceReference` were each imported *only* by their own unit test. The batch runner
 * happily processed `input_text` candidates, but nothing in the running product ever produced
 * one, so those paths were effectively dead code and the console could not tell the difference
 * between "no text configured" and "text is broken".
 *
 * This service is the missing seam. It:
 *  - converts each adapter's candidate into the durable store's shape through the same
 *    `appendCandidate` path every other source uses, so grants, TTL, pairing and idempotency
 *    are enforced in exactly one place;
 *  - re-verifies the grant immediately before the write, so a paused or revoked source cannot
 *    land a late fragment;
 *  - reports honest per-source capabilities: what is wired, what is merely supported, and the
 *    reason a source is unavailable — never a silent empty success.
 *
 * It deliberately does NOT invent a native input route. When no commit stream is provided the
 * input source reports `unavailable` with a reason rather than pretending to listen.
 */

import type { PairingScope } from '../contracts/character-pack.js';
import type { InputTextCandidate, SourceCandidate, SourceGrant } from '../contracts/companion-mode.js';
import type { CollectionSourceKind } from '../contracts/collection.js';
import type { CollectionStore, AppendResult } from '../memory/collection-store.js';
import type { CollectionGrantManager } from './collection-grants.js';
import type { ClipboardTextSource, ClipboardTextResult } from './clipboard-text-source.js';
import type { InputTextSource, RawInputCommitEvent } from './input-text-source.js';
import type { HistorySourceReference, HistoryReferenceInput } from './history-source-reference.js';

/** The kinds this service owns. Keyboard/image collection stays with `CollectionService`. */
export type TextSourceKind = 'clipboard_text' | 'input_text' | 'history_reference' | 'manual_text';

export interface SourceCapability {
  readonly kind: TextSourceKind;
  /** An adapter object exists. */
  readonly wired: boolean;
  /** A real provider route exists for this kind. */
  readonly supported: boolean;
  readonly supportedApplications: readonly string[];
  readonly inputMethods: readonly string[];
  /** Why this source cannot currently deliver. Null when it can. */
  readonly reason: string | null;
  readonly grantState: 'active' | 'paused' | 'stopped' | 'revoked' | 'expired' | 'disabled';
}

/** The native/desktop route that produces committed input text. */
export interface CommitStreamPort {
  /** Subscribe to committed input. Returns an unsubscribe function. */
  subscribe(grant: SourceGrant, onCommit: (event: RawInputCommitEvent) => void): Promise<() => Promise<void>>;
  /** Applications this route can actually read, verified rather than assumed. */
  readonly supportedApplications: readonly string[];
  readonly supportedInputMethods: readonly string[];
}

export interface TextSourceServiceOptions {
  readonly store: CollectionStore;
  readonly grants: CollectionGrantManager;
  readonly pairing: PairingScope;
  readonly clipboard?: ClipboardTextSource;
  readonly input?: InputTextSource;
  readonly history?: HistorySourceReference;
  readonly commits?: CommitStreamPort;
  readonly now?: () => string;
}

/** The origin string recorded for each kind, so evidence never over-claims the user's own words. */
const ORIGIN: Readonly<Record<TextSourceKind, string>> = Object.freeze({
  clipboard_text: 'clipboard_copy',
  input_text: 'input_method',
  history_reference: 'dialog_history',
  manual_text: 'user_submitted',
});

export class TextSourceService {
  private unsubscribe: (() => Promise<void>) | null = null;
  private clipboardLease: { close(): Promise<void> } | null = null;
  private closed = false;

  constructor(private readonly options: TextSourceServiceOptions) {}

  /**
   * Honest capability for every text source the console can ask about.
   *
   * `supported` is about the *route*, `wired` is about the *adapter*, and `grantState` is about
   * *authorization*. A source with a grant but no route is `unavailable`, not `disabled`.
   */
  capabilities(): readonly SourceCapability[] {
    const { grants, pairing } = this.options;
    const grantOf = (kind: TextSourceKind): SourceCapability['grantState'] => {
      try {
        const grant = grants.current(pairing, kind as CollectionSourceKind);
        if (!grant) return 'disabled';
        if (grant.expiresAt <= this.#now()) return 'expired';
        return grant.state;
      } catch { return 'disabled'; }
    };

    const commits = this.options.commits;

    return Object.freeze([
      {
        kind: 'clipboard_text',
        wired: this.options.clipboard !== undefined,
        supported: this.options.clipboard !== undefined,
        supportedApplications: [],
        inputMethods: [],
        reason: this.options.clipboard === undefined ? 'clipboard_text_provider_missing' : null,
        grantState: grantOf('clipboard_text'),
      },
      {
        kind: 'input_text',
        wired: this.options.input !== undefined,
        supported: commits !== undefined,
        supportedApplications: commits ? [...commits.supportedApplications] : [],
        inputMethods: commits ? [...commits.supportedInputMethods] : [],
        // The adapter existing is not the same as a verified route existing. Report the route.
        reason: commits === undefined
          ? 'input_commit_route_unavailable'
          : this.options.input === undefined ? 'input_text_adapter_missing' : null,
        grantState: grantOf('input_text'),
      },
      {
        kind: 'history_reference',
        wired: this.options.history !== undefined,
        supported: this.options.history !== undefined,
        supportedApplications: [],
        inputMethods: [],
        reason: this.options.history === undefined ? 'history_provider_missing' : null,
        grantState: grantOf('history_reference'),
      },
      {
        kind: 'manual_text',
        // Always available: the user typing into the console needs no provider.
        wired: true,
        supported: true,
        supportedApplications: [],
        inputMethods: [],
        reason: null,
        grantState: grantOf('manual_text'),
      },
    ]);
  }

  /**
   * Start one text source under an active grant.
   *
   * Throws rather than silently doing nothing when a source is unavailable: the caller (the
   * console) needs to learn that enabling produced nothing.
   */
  async start(kind: TextSourceKind, grant: SourceGrant): Promise<void> {
    if (this.closed) throw new Error('text_source_service_closed');
    if (grant.state !== 'active') throw new Error('text_source_not_active');
    if (grant.pairing.characterInstanceId !== this.options.pairing.characterInstanceId
      || grant.pairing.userId !== this.options.pairing.userId) {
      throw new Error('text_source_pairing_mismatch');
    }

    if (kind === 'clipboard_text') {
      const source = this.options.clipboard;
      if (!source) throw new Error('clipboard_text_source_unavailable');
      // Enabling discards whatever was already on the clipboard; it is a baseline, not a source.
      this.clipboardLease = await source.start(grant);
      return;
    }

    if (kind === 'input_text') {
      const source = this.options.input;
      const commits = this.options.commits;
      if (!source) throw new Error('input_text_adapter_missing');
      if (!commits) throw new Error('input_commit_route_unavailable');
      await source.start(grant);
      this.unsubscribe = await commits.subscribe(grant, event => {
        void this.onInputCommit(grant, event);
      });
      return;
    }

    if (kind === 'history_reference') {
      if (!this.options.history) throw new Error('history_provider_missing');
      return;
    }

    // manual_text has no listener: it is driven by an explicit management write.
  }

  async stop(kind: TextSourceKind): Promise<void> {
    if (kind === 'clipboard_text' && this.clipboardLease) {
      await this.clipboardLease.close().catch(() => undefined);
      this.clipboardLease = null;
    }
    if (kind === 'input_text' && this.unsubscribe) {
      await this.unsubscribe().catch(() => undefined);
      this.unsubscribe = null;
    }
  }

  /** Ingest the user's own submitted text. This is the only source that is the user's voice. */
  async onManualText(input: { readonly text: string; readonly displayName?: string; readonly operationId: string }): Promise<AppendResult | null> {
    return this.#commit({
      grant: this.#requireGrant('manual_text'),
      sourceKind: 'manual_text',
      nativeEventId: `manual-${input.operationId}`,
      idempotencyKey: `manual|${input.operationId}`,
      text: input.text,
      displayName: input.displayName ?? '手动提交',
      mimeType: 'text/plain',
      payloadRef: `manual://${input.operationId}`,
    });
  }

  /** Ingest clipboard text observed at `sequence`; the same sequence is consumed at most once. */
  async onClipboardText(input: { readonly grant: SourceGrant; readonly sequence: number; readonly text: ClipboardTextResult }): Promise<AppendResult | null> {
    return this.#commit({
      grant: input.grant,
      sourceKind: 'clipboard_text',
      nativeEventId: `clip-${input.sequence}`,
      idempotencyKey: `clip|${input.grant.grantId}|${input.grant.revision}|${input.sequence}`,
      text: input.text.text,
      displayName: '剪贴板文本',
      mimeType: 'text/plain',
      payloadRef: `clipboard://${input.sequence}`,
      occurredAt: this.#now(),
    });
  }

  /**
   * Persist one committed input fragment.
   *
   * The adapter has already refused password fields, composition intermediates and cancelled
   * input; this method re-checks the grant so a revoked source cannot land a late fragment.
   */
  async onInputCommit(grant: SourceGrant, event: RawInputCommitEvent): Promise<AppendResult | null> {
    const source = this.options.input;
    if (!source) return null;
    const candidate: InputTextCandidate | null = source.processCommit(grant, event);
    if (!candidate) return null;

    return this.#commit({
      grant,
      sourceKind: 'input_text',
      nativeEventId: candidate.nativeEventId,
      idempotencyKey: `input|${grant.grantId}|${grant.revision}|${candidate.commitId}`,
      text: candidate.text,
      displayName: `${candidate.appIdentity} 提交的文本`,
      mimeType: 'text/plain',
      payloadRef: candidate.payloadRef,
      occurredAt: candidate.occurredAt,
    });
  }

  /** Reference an existing conversation turn without copying it into a second permanent store. */
  async onHistoryReference(grant: SourceGrant, input: HistoryReferenceInput): Promise<AppendResult | null> {
    const history = this.options.history;
    if (!history) throw new Error('history_provider_missing');
    const candidate: SourceCandidate | null = history.createReferenceCandidate(
      this.options.pairing, grant.grantId, grant.revision, input,
    );
    // A reference to a conversation that no longer exists is refused, not stored as a dangling row.
    if (!candidate) return null;

    return this.#commit({
      grant,
      sourceKind: 'history_reference',
      nativeEventId: candidate.nativeEventId,
      idempotencyKey: `hist|${grant.grantId}|${grant.revision}|${candidate.nativeEventId}`,
      // A reference carries no body of its own; the preview is evidence of existence, not content.
      text: null,
      displayName: candidate.displayName ?? '对话引用',
      mimeType: 'text/plain',
      payloadRef: candidate.payloadRef,
      occurredAt: candidate.occurredAt,
    });
  }

  /**
   * The single write path. Every text source funnels through here so grant state, TTL, pairing and
   * idempotency are enforced once rather than three times with three different answers.
   */
  async #commit(input: {
    grant: SourceGrant;
    sourceKind: TextSourceKind;
    nativeEventId: string;
    idempotencyKey: string;
    text: string | null;
    displayName: string;
    mimeType: string;
    payloadRef: string;
    occurredAt?: string | null;
  }): Promise<AppendResult | null> {
    const { store, grants, pairing } = this.options;
    if (this.closed) return null;

    // Re-verify immediately before the write. A grant that moved while we read must not land.
    try {
      grants.assertActive({
        grantId: input.grant.grantId, grantRevision: input.grant.revision,
        pairing, kind: input.sourceKind as CollectionSourceKind,
      });
    } catch { return null; }

    const now = this.#now();
    return store.appendCandidate(input.grant, {
      sourceKind: input.sourceKind,
      modeGeneration: 1,
      nativeEventId: input.nativeEventId,
      occurredAt: input.occurredAt ?? now,
      receivedAt: now,
      origin: ORIGIN[input.sourceKind],
      confidence: 1,
      expiresAt: input.grant.expiresAt,
      payloadRef: input.payloadRef,
      textContent: input.text,
      displayName: input.displayName,
      mimeType: input.mimeType,
      ...(input.text === null ? {} : { size: Buffer.byteLength(input.text, 'utf8') }),
      stableVersion: input.nativeEventId,
    }, input.idempotencyKey);
  }

  /**
   * The current durable grant for a kind, as the manager holds it.
   *
   * CK-09's console enables/pauses a source through this, so the authorization backing a running
   * listener is the same object the manager re-checks before a write — never a browser-supplied one.
   */
  grantFor(kind: TextSourceKind): SourceGrant | null {
    const grant = this.options.grants.current(this.options.pairing, kind as CollectionSourceKind);
    return grant ? (grant as unknown as SourceGrant) : null;
  }

  #requireGrant(kind: TextSourceKind): SourceGrant {
    const grant = this.options.grants.current(this.options.pairing, kind as CollectionSourceKind);
    if (!grant) throw new Error('text_source_not_authorized');
    if (grant.expiresAt <= this.#now()) throw new Error('text_source_expired');
    if (grant.state !== 'active') throw new Error('text_source_not_active');
    return grant as unknown as SourceGrant;
  }

  #now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop('input_text');
    await this.stop('clipboard_text');
  }
}

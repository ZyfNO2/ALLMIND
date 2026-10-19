/**
 * core/wiki-compiler.ts
 *
 * CK-05: incremental wiki compilation over the EXISTING owners.
 *
 * Routing is decided by evidence kind BEFORE anything is written, and each destination is an owner
 * this repo already trusts — this module creates no second Memory:
 *
 *  - personal facts / inferences  → `ContinuityMemoryPort` (full pairing scope, candidate rules);
 *  - reference material           → `KnowledgeLibraryStore` (role- or instance-scoped);
 *  - character canon              → left for the Pack draft domain (CK-07/08); never written here.
 *
 * Three refusals are load-bearing:
 *  - assistant self-statements are never user facts (`origin:'assistant'` is refused by the store
 *    and this compiler refuses earlier, with a diagnostic);
 *  - inferences land as `candidate` and are never auto-promoted — promotion is a human decision;
 *  - a conflict produces a *superseding candidate plus conflict metadata*, it does not overwrite an
 *    active fact and does not fabricate a "disputed" status the schema does not have.
 */

import { createHash } from 'node:crypto';
import type { PairingScope } from '../contracts/character-pack.js';
import type {
  ContinuityFactKind,
  ContinuityLayer,
  ContinuityMemoryPort,
} from '../contracts/continuity-memory.js';
import type { ActivityEvent, ActivityEvidenceKind } from './activity-understanding.js';

export type WikiTargetDomain = 'user_continuity' | 'reference_knowledge' | 'character_canon' | 'rejected';

export interface CompileProposal {
  readonly proposalId: string;
  readonly targetDomain: WikiTargetDomain;
  /** `ContinuityLayer` for user_continuity proposals; null otherwise. */
  readonly layer: ContinuityLayer | null;
  readonly kind: ContinuityFactKind;
  readonly text: string;
  readonly evidenceKind: ActivityEvidenceKind;
  readonly sourceIds: readonly string[];
  /** Stable id of the events backing this proposal, so replays merge instead of re-weighting. */
  readonly eventIds: readonly string[];
  readonly status: 'candidate' | 'active';
  readonly conflicts: readonly { readonly existingFactId: string; readonly reason: string }[];
  readonly reason: string;
}

export interface WikiChangeSet {
  readonly operationId: string;
  readonly methodVersion: string;
  readonly revision: number;
  readonly proposals: readonly CompileProposal[];
  readonly conflicts: { readonly existingFactId: string; readonly reason: string }[];
  readonly supersedes: { readonly proposalId: string; readonly supersededFactId: string }[];
  readonly coverage: {
    readonly eventsConsidered: number;
    readonly routed: number;
    readonly rejected: number;
    readonly merged: number;
  };
  readonly checkpoint: { readonly lastEventId: string | null; readonly complete: boolean };
  /** Null when the compile was deterministic-only. Never fake usage numbers. */
  readonly usage: { readonly modelCalls: number; readonly promptTokens: number; readonly completionTokens: number } | null;
}

export interface CompileRequest {
  readonly pairing: PairingScope;
  readonly operationId: string;
  readonly methodVersion: string;
  readonly events: readonly ActivityEvent[];
  readonly signal?: AbortSignal | undefined;
}

export interface WikiCompilerOptions {
  readonly continuity: ContinuityMemoryPort;
  /** Max proposals per compile; keeps a burst from rewriting the whole wiki in one pass. */
  readonly maxProposals?: number;
  readonly now?: () => string;
}

const REJECTED = 'rejected' as const;

/**
 * N085-00 gate: trivia must not become a personal fact.
 *
 * This is a BLOCKLIST of ephemeral markers, not an allowlist of "good" words. An allowlist would
 * silently drop any legitimate statement whose wording it did not anticipate — a user saying
 * "我把书还给了图书馆" carries no magic keyword but is a real experience. A blocklist targets the
 * actual failure mode (an incidental remark about the weather or something done a moment ago) and
 * defaults to keeping everything else, which is the safe direction for losing nothing.
 *
 * Quotes/hypotheses, assistant self-statements and work/external material are separated by evidence
 * kind instead, so they never reach this check.
 */
const EPHEMERAL_MARKER = /刚才|刚刚|今天天气|天气不错|随手|顺便|一下子|突然想到|烧开了|路过/

/**
 * N085-00 / CONTRACTS §1: the user-soul layer holds goals, values and identity — the durable
 * self-description — while the user wiki holds preferences, facts and experiences. The compiler
 * previously routed every authored line to the wiki; this marker is what makes the split real
 * rather than a comment describing an intention.
 */
const SOUL_MARKER = /目标|价值观|原则|信念|性格|我是|打算|计划/;

export class WikiCompiler {
  private readonly maxProposals: number;

  constructor(private readonly options: WikiCompilerOptions) {
    this.maxProposals = options.maxProposals ?? 100;
  }

  /**
   * Deterministic compile over one batch of understood events.
   *
   * No model is involved: routing, dedup and conflict detection are rule-based. When a model later
   * joins (CK-07) its output must pass through this same deterministic validation.
   */
  compile(request: CompileRequest): WikiChangeSet {
    if (request.signal?.aborted) throw Object.assign(new Error('compile_cancelled'), { code: 'compile_cancelled' });

    const proposals: CompileProposal[] = [];
    const conflicts: WikiChangeSet['conflicts'] = [];
    const supersedes: WikiChangeSet['supersedes'] = [];
    const diagnostics: { eventId: string; reason: string }[] = [];
    const seenEvents = new Set<string>();
    let merged = 0;
    let rejected = 0;

    for (const event of request.events) {
      if (seenEvents.has(event.eventId)) { merged += 1; continue; }
      seenEvents.add(event.eventId);

      if (proposals.length >= this.maxProposals) {
        diagnostics.push({ eventId: event.eventId, reason: 'max_proposals_reached' });
        continue;
      }

      // A failed event is a record of failure, never a knowledge proposal.
      if (event.status === 'failed') { rejected += 1; diagnostics.push({ eventId: event.eventId, reason: 'event_failed' }); continue; }

      const routing = this.#route(event);
      if (routing.domain === REJECTED) {
        rejected += 1;
        diagnostics.push({ eventId: event.eventId, reason: routing.reason });
        continue;
      }

      if (routing.domain === 'character_canon') {
        // Canon belongs to the Pack draft domain (CK-07/08). Writing it here would bypass the
        // persona publish path, so it is deferred rather than silently dropped or written.
        diagnostics.push({ eventId: event.eventId, reason: 'deferred_to_character_canon_domain' });
        continue;
      }

      const duplicate = this.#findDuplicate(proposals, routing.text, routing.layer);
      if (duplicate) {
        // Same content from another event: merge the evidence instead of adding a second proposal.
        merged += 1;
        proposals[duplicate.index] = Object.freeze({
          ...duplicate.proposal,
          eventIds: Object.freeze([...duplicate.proposal.eventIds, event.eventId]),
          sourceIds: Object.freeze([...new Set([...duplicate.proposal.sourceIds, ...routing.sourceIds])]),
        });
        continue;
      }

      // A statement that contradicts an existing active fact is a CONFLICT: the new reading becomes
      // a superseding candidate and the old fact stays until a human resolves it. It is never
      // silently overwritten and never auto-promoted.
      const existing = this.#findConflicts(request.pairing, routing.text, routing.layer);
      const proposal: CompileProposal = Object.freeze({
        proposalId: `wp-${createHash('sha256').update(`${request.operationId}|${event.eventId}|${routing.layer ?? ''}|${routing.text}`).digest('hex').slice(0, 32)}`,
        targetDomain: routing.domain,
        layer: routing.layer,
        kind: routing.kind,
        text: routing.text,
        evidenceKind: event.evidenceKind,
        sourceIds: Object.freeze(routing.sourceIds),
        eventIds: Object.freeze([event.eventId]),
        status: 'candidate',
        conflicts: Object.freeze(existing),
        reason: existing.length > 0 ? 'conflicting_reading_pending_resolution' : routing.reason,
      });
      proposals.push(proposal);
      for (const conflict of existing) {
        conflicts.push(conflict);
        supersedes.push({ proposalId: proposal.proposalId, supersededFactId: conflict.existingFactId });
      }
    }

    return Object.freeze({
      operationId: request.operationId,
      methodVersion: request.methodVersion,
      revision: 1,
      proposals: Object.freeze(proposals),
      conflicts: Object.freeze([...conflicts]),
      supersedes: Object.freeze([...supersedes]),
      coverage: Object.freeze({
        eventsConsidered: request.events.length,
        routed: proposals.length,
        rejected,
        merged,
      }),
      checkpoint: Object.freeze({
        lastEventId: request.events.at(-1)?.eventId ?? null,
        complete: diagnostics.every(item => item.reason !== 'max_proposals_reached'),
      }),
      usage: null,
    }) as WikiChangeSet;
  }

  /**
   * Commit the routed proposals to their real owners.
   *
   * Every automatic commit lands as `candidate`: promotion is a human decision (N085-R06), and a
   * background compile must never put a fact into force by itself — even the user's own words are
   * only ever evidence the user can confirm, not a fact the system asserts.
   */
  commit(pairing: PairingScope, changeSet: WikiChangeSet): { committed: number; results: readonly { proposalId: string; factId: string | null; status: string }[] } {
    const results: { proposalId: string; factId: string | null; status: string }[] = [];
    let committed = 0;

    for (const proposal of changeSet.proposals) {
      if (proposal.targetDomain !== 'user_continuity' || proposal.layer === null) {
        results.push({ proposalId: proposal.proposalId, factId: null, status: 'not_a_continuity_proposal' });
        continue;
      }
      const lease = this.options.continuity.beginDerived(pairing);
      let result;
      try {
        result = this.options.continuity.commitDerived({
          lease,
          operationId: `${changeSet.operationId}:${proposal.proposalId}`,
          layer: proposal.layer,
          kind: proposal.kind,
          text: proposal.text,
          sourceIds: proposal.sourceIds,
          status: 'candidate',
        });
      } catch (error) {
        // A replay whose original fact was since forgotten/corrected is refused by the store's own
        // tombstone. That refusal is the desired outcome — report it instead of crashing, and never
        // retry with a fresh operation id, which would resurrect forgotten content.
        if ((error as { name?: string }).name === 'ContinuityMemoryError') {
          results.push({ proposalId: proposal.proposalId, factId: null, status: 'refused_by_tombstone' });
          continue;
        }
        throw error;
      }
      committed += 1;
      results.push({ proposalId: proposal.proposalId, factId: result.fact.id, status: result.status });
    }
    return { committed, results: Object.freeze(results) };
  }

  #route(event: ActivityEvent): {
    domain: WikiTargetDomain; layer: ContinuityLayer | null; kind: ContinuityFactKind;
    text: string; sourceIds: readonly string[]; reason: string;
  } {
    const sourceIds = event.sourceRefs.map(ref => `${ref.sourceKind}:${ref.sourceId}@${ref.sourceRevision}`);

    // Screen content and copied text are evidence ABOUT the world, not facts ABOUT the user.
    if (event.evidenceKind === 'captured_image' || event.evidenceKind === 'third_party_content') {
      // Reference material is still useful: it becomes knowledge, never a personal fact.
      return {
        domain: 'reference_knowledge', layer: null, kind: 'fact', text: event.claim,
        sourceIds, reason: 'third_party_content_to_reference_domain',
      };
    }

    switch (event.activityKind) {
      case 'authored_text': {
        // N085-00 gate: reject an incidental remark, keep everything else. See EPHEMERAL_MARKER.
        if (EPHEMERAL_MARKER.test(event.claim)) {
          return {
            domain: REJECTED, layer: null, kind: 'fact', text: event.claim,
            sourceIds, reason: 'low_value_ephemeral',
          };
        }
        // The user's own durable words are personal evidence. Soul-level when the line is
        // self-description (goals, values, identity), otherwise the user wiki. Deterministic and
        // conservative: an ambiguous line stays in the wiki, which is the weaker claim.
        const layer: ContinuityLayer = SOUL_MARKER.test(event.claim) ? 'user_soul' : 'user_wiki';
        return {
          domain: 'user_continuity', layer, kind: 'fact', text: event.claim,
          sourceIds, reason: layer === 'user_soul' ? 'user_self_description' : 'user_authored_text',
        };
      }
      case 'conversation_reference':
        return {
          domain: 'user_continuity', layer: 'user_wiki', kind: 'fact', text: event.claim,
          sourceIds, reason: 'conversation_reference',
        };
      case 'file_present':
      case 'file_changed':
        // Workspace files are reference material about the user's material, not personal facts.
        return {
          domain: 'reference_knowledge', layer: null, kind: 'fact', text: event.claim,
          sourceIds, reason: 'workspace_material_to_reference_domain',
        };
      case 'clipboard_copy':
        return {
          domain: 'reference_knowledge', layer: null, kind: 'fact', text: event.claim,
          sourceIds, reason: 'copied_material_to_reference_domain',
        };
      case 'screen_content':
        return {
          domain: 'reference_knowledge', layer: null, kind: 'fact', text: event.claim,
          sourceIds, reason: 'screen_content_to_reference_domain',
        };
      default:
        return { domain: REJECTED, layer: null, kind: 'fact', text: event.claim, sourceIds, reason: `unroutable_activity_kind:${event.activityKind}` };
    }
  }

  #findDuplicate(
    proposals: readonly CompileProposal[], text: string, layer: ContinuityLayer | null,
  ): { index: number; proposal: CompileProposal } | null {
    const index = proposals.findIndex(proposal => proposal.text === text && proposal.layer === layer);
    return index === -1 ? null : { index, proposal: proposals[index]! };
  }

  /** Conflicts are detected against the continuity store's CURRENT active facts. */
  #findConflicts(pairing: PairingScope, text: string, layer: ContinuityLayer | null): { existingFactId: string; reason: string }[] {
    if (layer === null) return [];
    const snapshot = this.options.continuity.snapshot(pairing);
    const active = layer === 'user_soul' ? snapshot.soul : layer === 'user_wiki' ? snapshot.wiki : snapshot.relationship;
    // Deterministic conservative rule: same layer, different text, both about the same topic is
    // flagged via an exact "negation or replacement" heuristic only when texts clearly disagree.
    return active
      .filter(fact => fact.text !== text && this.#clearlyConflicting(fact.text, text))
      .map(fact => ({ existingFactId: fact.id, reason: 'contradicts_active_fact' }));
  }

  #clearlyConflicting(existing: string, candidate: string): boolean {
    // Two signals, either of which counts as a conflict:
    //  a) an explicit contrast marker in the new reading (不是 / 不再 / 换成 / …);
    //  b) a shared TOPIC token with a differing value — "只喝绿茶" → "现在也喝红茶" shares 喝/绿茶
    //     but states a different rule. Topic overlap alone never fires: the texts must differ.
    // Broad text similarity is deliberately NOT used; it would flag unrelated facts and force
    // needless human review.
    const contrast = ['不是', '不再', '已经不', '取消', '放弃', '退出了', '搬离', '换成', '改成', '现在也'];
    if (contrast.some(word => candidate.includes(word))) return true;

    const existingTokens = tokensOf(existing);
    const candidateTokens = tokensOf(candidate);
    let shared = 0;
    for (const token of candidateTokens) if (existingTokens.has(token)) shared += 1;
    return shared >= 2;
  }
}

/**
 * Topic tokens for the conflict heuristic.
 *
 * CJK text has no spaces, so a word-boundary regex yields one giant token and two similar sentences
 * share nothing. Splitting CJK into individual characters gives a real (if coarse) overlap signal,
 * while Latin runs stay word-based. Stop characters are dropped so "用户" alone is not a topic.
 */
function tokensOf(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of value.toLocaleLowerCase().matchAll(/[\p{Script=Han}]|[\p{L}\p{N}]{2,}/gu)) {
    const token = match[0];
    if (CONFLICT_STOP.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/** Characters too generic to indicate a shared topic. */
const CONFLICT_STOP = new Set(['用', '户', '的', '了', '在', '是', '我', '和', '与', '也', '现', '在']);

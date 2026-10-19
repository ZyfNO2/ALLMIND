/**
 * memory/continuity-context-kk.ts
 *
 * CK-06: domain-aware bounded recall for "what did I do today / what have I been busy with /
 * what does the character know", projected into the formal next-turn context.
 *
 * This EXTENDS the existing `ContinuityContextComposer` rather than replacing it. The N07 composer
 * remains the base (character_soul, relationship, user_soul, canon_timeline, user_wiki,
 * companion_timeline); this layer adds the CK domains on top and reuses its ranking contract:
 *
 *  - `reference_knowledge` — pairing-filtered private/reference library documents (CK-05 owner);
 *  - `recent_activity`     — CK-04 activity events / daily summaries;
 *  - `character_wiki`      — an INDEPENDENT domain, deliberately left empty until CK-07/08 compile
 *                            canon facts. It is never faked with canon events, because a canon
 *                            event presented as a character wiki fact is exactly the confusion
 *                            AC-06-1 forbids.
 *
 * Every selected/excluded decision carries a reason and a stable key, and the whole result is
 * bound to a revision string (pack + memory + knowledge + activity) so `assertCurrent` can reject
 * a result composed before a correction, forget, pack publish, or instance switch.
 */

import { createHash } from 'node:crypto';
import type { PairingScope, ContinuitySnapshot } from '../contracts/character-pack.js';
import type { ContinuityContextSegment, ContinuityContextSource } from '../contracts/continuity-context.js';
import type { ContinuityMemorySnapshot } from '../contracts/continuity-memory.js';
import type { ContinuityMemoryStore } from './continuity-memory-store.js';
import type { CharacterPackStore } from './character-pack-store.js';
import type { KnowledgeLibraryStore } from './knowledge-library.js';
import type { ActivityEvent } from '../core/activity-understanding.js';
import { estimateKnowledgeTokens } from './knowledge-library.js';

/** A coarse intent derived from the query. Deterministic; no model. */
export type RecallIntent = 'recent_activity' | 'character_knowledge' | 'user_facts' | 'canon' | 'mixed';

export interface DomainRecallRequest {
  readonly pairing: PairingScope;
  readonly query: string;
  readonly tokenBudget: number;
  readonly now?: string;
  /** Local-day / ISO instant lower bound for time-scoped recall. */
  readonly since?: string;
  readonly cutoffPoint?: string;
  readonly maxCanonEvents?: number;
  readonly maxCompanionEvents?: number;
  /** CK-04 activity events for recent-activity recall (already validated, may be empty). */
  readonly recentActivity?: readonly ActivityEvent[];
  readonly includeReferenceKnowledge?: boolean;
  readonly includeCharacterWiki?: boolean;
  /**
   * CK-06/N085-04: domain scoping. A query that names its expected domains must not return
   * segments from outside them — "外部资料里有什么" must not surface a personal fact. Absent
   * filters mean "no restriction", which is the existing behaviour.
   */
  readonly allowedDomains?: readonly ContinuityContextSource[] | undefined;
  readonly forbiddenDomains?: readonly ContinuityContextSource[] | undefined;
}

export interface DomainRecallResult {
  readonly pairing: PairingScope;
  /** Composite revision; any of pack/memory/knowledge/activity changing invalidates the result. */
  readonly revision: string;
  readonly intent: RecallIntent;
  readonly text: string;
  readonly segments: readonly ContinuityContextSegment[];
  readonly selected: readonly ContinuityContextSegment[];
  readonly omitted: readonly ContinuityContextSegment[];
  readonly continuity: ContinuitySnapshot;
  readonly memory: ContinuityMemorySnapshot;
  readonly knowledgeRevision: number;
  /** CK-06/N085-04: how many candidates a forbidden/allowed domain filter excluded. */
  readonly domainExcluded: number;
}

const codePoints = (value: string): number => [...value].length;
const estimateTokens = (value: string): number => Math.ceil(codePoints(value) / 4) + 4;
const terms = (value: string): readonly string[] => [...new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []))];
const overlap = (query: readonly string[], text: string): number => { const set = new Set(terms(text)); return query.reduce((sum, term) => sum + (set.has(term) ? 1 : 0), 0); };
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/** CK-06 priority: instructions and stable user facts outrank canon, which outranks reference. */
const PRIORITY = Object.freeze({
  character_soul: 100, relationship: 90, user_soul: 85, character_wiki: 80,
  canon_timeline: 70, reference_knowledge: 65, user_wiki: 60, recent_activity: 55, companion_timeline: 50,
} as const) as Readonly<Record<ContinuityContextSource, number>>;

function segment(source: ContinuityContextSource, key: string, text: string, evidenceIds: readonly string[], reason: string): ContinuityContextSegment {
  return Object.freeze({ key, source, text, evidenceIds: Object.freeze([...evidenceIds]), tokens: estimateTokens(text), selected: false, reason });
}

/**
 * Deterministic intent classifier. The mapping is intentionally simple and inspectable: a query is
 * classified by which vocabulary it contains, and the classification only affects ranking and the
 * `character_wiki` gate — it never changes what is *allowed* to be recalled.
 */
export function classifyRecallIntent(query: string): RecallIntent {
  const text = query.toLocaleLowerCase();
  if (/(今天|最近|这几天|刚|刚才|昨天|recent|today|lately|now)/u.test(text)) return 'recent_activity';
  if (/(角色|设定|世界观|原作|他知道|她知道|character|canon|lore|who is)/u.test(text)) return 'character_knowledge';
  if (/(我|用户|喜欢|习惯|偏好|资料|wiki|my|i |fact)/u.test(text)) return 'user_facts';
  if (/(剧情|章节|篇|chapter|episode)/u.test(text)) return 'canon';
  return 'mixed';
}

export interface DomainRecallOptions {
  readonly packs: CharacterPackStore;
  readonly memory: ContinuityMemoryStore;
  readonly knowledge: KnowledgeLibraryStore;
  /** Reference library bound to this pairing's instance (CK-05). */
  readonly referenceLibraryId: string | null;
  readonly characterWikiFacts?: readonly { readonly id: string; readonly text: string; readonly evidenceIds: readonly string[] }[];
}

export class DomainAwareRecall {
  constructor(private readonly options: DomainRecallOptions) {}

  async recall(request: DomainRecallRequest): Promise<DomainRecallResult> {
    const intent = classifyRecallIntent(request.query);
    const queryTerms = terms(request.query);
    const since = request.since ? Date.parse(request.since) : null;
    const candidates: { segment: ContinuityContextSegment; priority: number; overlap: number; order: number }[] = [];
    let order = 0;

    const [continuity, memory] = await Promise.all([
      this.options.packs.getSnapshot(request.pairing, {
        ...(request.cutoffPoint === undefined ? {} : { cutoffPoint: request.cutoffPoint }),
        maxCanonEvents: request.maxCanonEvents ?? 50, maxCompanionEvents: request.maxCompanionEvents ?? 50,
      }),
      Promise.resolve(this.options.memory.snapshot(request.pairing, request.now === undefined ? {} : { now: request.now })),
    ]);

    // Base domains (same text as the N07 composer so the two agree on shared facts).
    const pack = continuity.activePack;
    if (pack) {
      const soul = [pack.name, pack.soul, ...(pack.styleHints ?? [])].filter(Boolean).join('\n');
      candidates.push({ segment: segment('character_soul', `pack:${pack.id}:soul`, soul, pack.sourceIds, '活动 Character Soul 核心'), priority: PRIORITY.character_soul, overlap: overlap(queryTerms, soul), order: order++ });
      for (const event of continuity.canonTimeline) {
        const text = event.chapter ? `${event.chapter}：${event.summary}` : event.summary;
        candidates.push({ segment: segment('canon_timeline', `canon:${event.eventId}`, text, event.evidenceIds, event.awareness === 'unknown' ? '原作事件但角色未知' : '截止点内的原作事件'), priority: PRIORITY.canon_timeline, overlap: overlap(queryTerms, text), order: order++ });
      }
    }
    for (const fact of memory.relationship) candidates.push({ segment: this.#fact('relationship', fact.id, fact.text, fact.sourceIds, fact.kind === 'inference' ? '有来源的推断' : '关系适应'), priority: PRIORITY.relationship, overlap: overlap(queryTerms, fact.text), order: order++ });
    for (const fact of memory.soul) candidates.push({ segment: this.#fact('user_soul', fact.id, fact.text, fact.sourceIds, fact.kind === 'inference' ? '有来源的推断' : '用户稳定偏好'), priority: PRIORITY.user_soul, overlap: overlap(queryTerms, fact.text), order: order++ });
    for (const fact of memory.wiki) candidates.push({ segment: this.#fact('user_wiki', fact.id, fact.text, fact.sourceIds, fact.kind === 'inference' ? '有来源的推断' : '用户资料'), priority: PRIORITY.user_wiki, overlap: overlap(queryTerms, fact.text), order: order++ });
    for (const event of continuity.companionTimeline) {
      const text = `用户：${event.userText}\n角色：${event.assistantText}`;
      candidates.push({ segment: segment('companion_timeline', `companion:${event.eventId}`, text, event.sourceIds ?? [], '当前配对的共同经历'), priority: PRIORITY.companion_timeline, overlap: overlap(queryTerms, text), order: order++ });
    }

    // CK-06 domain: character wiki (independent; empty until CK-07/08 compile it — never faked).
    if (request.includeCharacterWiki !== false) {
      for (const fact of this.options.characterWikiFacts ?? []) {
        candidates.push({ segment: segment('character_wiki', `cwiki:${fact.id}`, fact.text, fact.evidenceIds, '角色 Wiki 事实（独立域，非原作事件）'), priority: PRIORITY.character_wiki, overlap: overlap(queryTerms, fact.text), order: order++ });
      }
    }

    // CK-06 domain: pairing-filtered reference knowledge (CK-05 instance-scoped library).
    if (request.includeReferenceKnowledge !== false && this.options.referenceLibraryId) {
      const library = this.options.knowledge.getForInstance(this.options.referenceLibraryId, request.pairing.characterId, request.pairing.characterInstanceId);
      if (library) {
        for (const doc of this.options.knowledge.documents(library.id, request.pairing.characterId)) {
          const content = this.options.knowledge.getDocumentContent(library.id, doc.id, request.pairing.characterId);
          if (!content) continue;
          candidates.push({ segment: segment('reference_knowledge', `kdoc:${doc.id}`, content.text.slice(0, 2000), [`knowledge:${doc.id}`], `私有/资料文档（实例隔离）`), priority: PRIORITY.reference_knowledge, overlap: overlap(queryTerms, content.text), order: order++ });
        }
      }
    }

    // CK-06 domain: recent activity (CK-04). Time-bounded when `since` is provided.
    for (const event of request.recentActivity ?? []) {
      if (since !== null) {
        const at = event.time.occurredAt ?? event.time.receivedAt;
        if (Date.parse(at) < since) continue;
      }
      candidates.push({ segment: segment('recent_activity', `act:${event.eventId}`, event.claim, event.sourceRefs.map(r => `${r.sourceKind}:${r.sourceId}`), event.time.occurredAt ? '近期活动（有发生时间）' : '近期活动（仅记录时间）'), priority: PRIORITY.recent_activity, overlap: overlap(queryTerms, event.claim), order: order++ });
    }

    // CK-06/N085-04: domain scoping happens BEFORE dedup and ranking, so a forbidden domain can
    // never win a slot by priority and can never absorb a legitimate entry. An excluded entry is
    // reported, not silently dropped.
    const forbidden = new Set(request.forbiddenDomains ?? []);
    const allowed = request.allowedDomains ? new Set(request.allowedDomains) : null;
    const scoped = candidates.filter(item => {
      if (forbidden.has(item.segment.source)) return false;
      if (allowed && !allowed.has(item.segment.source)) return false;
      return true;
    });
    const scopedOut = candidates.length - scoped.length;

    // Cross-domain dedup: identical normalized text is only recalled once (highest priority wins).
    // `duplicateOf` records which surviving segment absorbed the copy, so the omitted list can
    // always explain itself.
    const claimed = new Map<string, ContinuityContextSegment>();
    const duplicateOf = new Map<ContinuityContextSegment, ContinuityContextSegment>();
    for (const item of scoped) {
      const key = normalize(item.segment.text);
      const winner = claimed.get(key);
      if (winner) { duplicateOf.set(item.segment, winner); continue; }
      claimed.set(key, item.segment);
    }
    const ranked = scoped
      .filter(item => !duplicateOf.has(item.segment))
      .sort((a, b) => b.priority - a.priority || b.overlap - a.overlap || a.order - b.order);

    let used = 0;
    const selected: ContinuityContextSegment[] = [], omitted: ContinuityContextSegment[] = [];
    for (const item of ranked) {
      if (used + item.segment.tokens <= request.tokenBudget) {
        used += item.segment.tokens;
        selected.push(Object.freeze({ ...item.segment, selected: true }));
      } else {
        omitted.push(Object.freeze({ ...item.segment, reason: '超出本轮 Context 预算' }));
      }
    }
    for (const [segment, winner] of duplicateOf) {
      omitted.push(Object.freeze({ ...segment, reason: `与更高优先级条目重复（已由 ${winner.key} 收录）` }));
    }
    for (const item of candidates) {
      if (forbidden.has(item.segment.source)) {
        omitted.push(Object.freeze({ ...item.segment, reason: `域 ${item.segment.source} 被禁止` }));
      } else if (allowed && !allowed.has(item.segment.source)) {
        omitted.push(Object.freeze({ ...item.segment, reason: `域 ${item.segment.source} 不在允许范围` }));
      }
    }

    const label = (source: ContinuityContextSource): string => (
      source === 'character_soul' ? '角色底色' : source === 'relationship' ? '关系适应'
        : source === 'user_soul' ? '用户稳定偏好' : source === 'character_wiki' ? '角色 Wiki'
          : source === 'canon_timeline' ? '原作时间线' : source === 'reference_knowledge' ? '资料文档'
            : source === 'recent_activity' ? '近期活动' : source === 'user_wiki' ? '用户资料' : '共同经历'
    );
    const text = selected.map(item => `【${label(item.source)}】\n${item.text}`).join('\n\n');

    const knowledgeRevision = this.options.knowledge.revision();
    const activityEpoch = createHash('sha256').update((request.recentActivity ?? []).map(e => e.eventId).join(',')).digest('hex').slice(0, 12);
    const revision = `${continuity.packRevision}:${memory.revision}:${knowledgeRevision}:${activityEpoch}`;

    return Object.freeze({
      pairing: Object.freeze({ ...request.pairing }),
      revision,
      intent,
      text,
      // `segments` is the scoped candidate set: an entry excluded by a forbidden/allowed domain
      // must not appear here, otherwise a caller reading `segments` would see a domain the query
      // explicitly forbade.
      segments: Object.freeze(scoped.map(item => item.segment)),
      selected: Object.freeze(selected),
      omitted: Object.freeze(omitted),
      continuity,
      memory,
      domainExcluded: scopedOut,
      knowledgeRevision,
    });
  }

  #fact(source: 'relationship' | 'user_soul' | 'user_wiki', id: string, text: string, evidenceIds: readonly string[], reason: string): ContinuityContextSegment {
    return segment(source, `fact:${id}`, text, evidenceIds, reason);
  }

  /**
   * Send-time re-verification. Any of pack / memory / knowledge changing after composition makes the
   * result stale; a late result must be refused rather than sent.
   */
  assertCurrent(result: DomainRecallResult, request: DomainRecallRequest): void {
    const memory = this.options.memory.snapshot(result.pairing);
    if (memory.revision !== result.memory.revision) {
      throw Object.assign(new Error('stale_context'), { code: 'stale_context' });
    }
    if (this.options.knowledge.revision() !== result.knowledgeRevision) {
      throw Object.assign(new Error('stale_context'), { code: 'stale_context' });
    }
    void request;
  }
}

export { estimateKnowledgeTokens };

// N07-05: bounded, explainable ContextSource adapter for the continuity package.
// It composes the immutable Character Pack and pair-scoped User Soul/Wiki/relationship data. The
// adapter never calls a model and never becomes a second Dialogue pipeline.
import type { PairingScope, ContinuitySnapshot } from '../contracts/character-pack.js';
import type { ContinuityContextRequest, ContinuityContextResult, ContinuityContextSegment, ContinuityContextSource, ContinuityContextSourceAdapter, AikiContextPort } from '../contracts/continuity-context.js';
import { factSegment } from '../contracts/continuity-context.js';
import type { ContinuityMemorySnapshot } from '../contracts/continuity-memory.js';
import type { ContinuityMemoryStore } from './continuity-memory-store.js';
import { ContinuityMemoryError } from './continuity-memory-store.js';
import type { ContinuityReadPort } from '../contracts/character-pack.js';

interface Ranked { segment: ContinuityContextSegment; priority: number; overlap: number; order: number; aikiEntryId?: string | undefined }
/**
 * Base priorities for the N07 domains. CK-06's `DomainAwareRecall` extends this with the three new
 * domains; the N07 composer never emits them, so this map stays scoped to what it can produce.
 */
const PRIORITY: Readonly<Record<Exclude<ContinuityContextSource, 'reference_knowledge' | 'recent_activity'>, number>> = Object.freeze({ character_soul: 100, relationship: 90, user_soul: 85, character_wiki: 80, author_state: 72, canon_timeline: 70, user_wiki: 60, companion_timeline: 50 });
const codePoints = (value: string): number => [...value].length;
const estimateTokens = (value: string): number => Math.ceil(codePoints(value) / 4) + 4;
const terms = (value: string): readonly string[] => [...new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []))];
const overlap = (query: readonly string[], text: string): number => { const set = new Set(terms(text)); return query.reduce((sum, term) => sum + (set.has(term) ? 1 : 0), 0); };
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

function segment(source: ContinuityContextSource, key: string, text: string, evidenceIds: readonly string[], reason: string): ContinuityContextSegment {
  return Object.freeze({ key, source, text, evidenceIds: Object.freeze([...evidenceIds]), tokens: estimateTokens(text), selected: false, reason });
}

export class ContinuityContextComposer implements ContinuityContextSourceAdapter {
  constructor(
    private readonly continuity: ContinuityReadPort,
    private readonly memory: ContinuityMemoryStore,
    /** CB-03: optional unified-document recall port; absent keeps the pre-CB-03 behaviour. */
    private readonly aiki?: AikiContextPort | undefined,
  ) {}

  async compose(request: ContinuityContextRequest): Promise<ContinuityContextResult> {
    if (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0) throw new ContinuityMemoryError('invalid_request', 'Context token budget 无效。');
    if (typeof request.query !== 'string' || request.query.length > 16_000) throw new ContinuityMemoryError('invalid_request', 'Context query 无效。');
    const [continuity, memory] = await Promise.all([
      this.continuity.getSnapshot(request.pairing, { cutoffPoint: request.cutoffPoint, maxCanonEvents: request.maxCanonEvents ?? 50, maxCompanionEvents: request.maxCompanionEvents ?? 50 }),
      Promise.resolve(this.memory.snapshot(request.pairing, request.now === undefined ? {} : { now: request.now })),
    ]);
    const characterId = request.pairing.characterId;
    const queryTerms = terms(request.query);
    const hints = this.aiki?.entryHints(characterId) ?? new Map<string, { readonly aliases: readonly string[]; readonly keywords: readonly string[] }>();
    const relatedGraph = this.aiki?.related(characterId) ?? new Map<string, readonly string[]>();
    /** CB-03: alias/keyword hits add weight without changing the shared `overlap` contract. */
    const hintBoost = (entryId: string, text: string): number => {
      const hint = hints.get(entryId);
      if (!hint) return 0;
      const needles = [...hint.aliases, ...hint.keywords].map(value => normalize(value)).filter(Boolean);
      if (needles.length === 0) return 0;
      const haystack = normalize(text);
      let hits = 0;
      for (const needle of needles) if (haystack.includes(needle)) hits += 1;
      return hits > 0 ? 2 + Math.min(2, hits - 1) : 0;
    };
    const all: Ranked[] = [];
    let order = 0;
    const pack = continuity.activePack;
    if (pack) {
      const soul = [pack.name, pack.soul, ...(pack.styleHints ?? [])].filter(Boolean).join('\n');
      all.push({ segment: segment('character_soul', `pack:${pack.id}:soul`, soul, pack.sourceIds, '活动 Character Soul 核心'), priority: PRIORITY.character_soul, overlap: overlap(queryTerms, soul), order: order++ });
      for (const event of continuity.canonTimeline) {
        const text = event.chapter ? `${event.chapter}：${event.summary}` : event.summary;
        all.push({ segment: segment('canon_timeline', `canon:${event.eventId}`, text, event.evidenceIds, event.awareness === 'unknown' ? '原作事件但角色未知；仅在显式允许时召回' : '截止点内的原作事件'), priority: PRIORITY.canon_timeline, overlap: overlap(queryTerms, text), order: order++ });
      }
      // WV0-02: canon-only character-Wiki facts are an INDEPENDENT domain (never timeline events).
      // Legacy packs have no wikiFacts → zero segments; budget overflow drops the whole fact with a reason.
      for (const fact of pack.wikiFacts ?? []) {
        all.push({
          segment: segment('character_wiki', `wiki:${fact.id}`, fact.text, fact.evidenceIds, '活动角色 Wiki 事实（canon）'),
          priority: PRIORITY.character_wiki, overlap: overlap(queryTerms, fact.text) + hintBoost(fact.id, request.query), order: order++,
          aikiEntryId: fact.id,
        });
      }
    }
    // CB-03: author initial state (authored setting, never real Continuity). Expired / not-yet-
    // effective rows are filtered here with an explicit omission reason AND are never selectable.
    const nowIso = request.now ?? new Date().toISOString();
    const ineligible = new Set<string>();
    if (this.aiki) {
      for (const row of this.aiki.authorState(characterId)) {
        const expired = (row.expiresAt !== null && row.expiresAt <= nowIso) || (row.validUntil !== null && row.validUntil <= nowIso);
        const notYet = row.validFrom !== null && row.validFrom > nowIso;
        if (expired || notYet) {
          const key = `authorstate:${row.entryId}`;
          ineligible.add(key);
          all.push({
            segment: Object.freeze({
              key, source: 'author_state' as const, text: row.body,
              evidenceIds: Object.freeze([]), tokens: estimateTokens(row.body), selected: false,
              reason: expired ? '作者初始状态已过期' : '作者初始状态尚未生效',
            }),
            priority: PRIORITY.author_state, overlap: 0, order: order++, aikiEntryId: row.entryId,
          });
          continue;
        }
        const text = `【作者初始状态：${row.title}】${row.body}`;
        all.push({
          segment: segment('author_state', `authorstate:${row.entryId}`, text, [], '作者设定的当前初始状态（非真实用户记忆）'),
          priority: PRIORITY.author_state, overlap: overlap(queryTerms, text) + hintBoost(row.entryId, request.query), order: order++,
          aikiEntryId: row.entryId,
        });
      }
      // CB-03: story entries already reach the turn through the lorebook owner. Only their recall
      // metadata is added here (time / participants / importance) — never a second body copy.
      for (const meta of this.aiki.storyMeta(characterId)) {
        const time = meta.time?.start ? `时间 ${meta.time.start}` : '';
        const people = meta.characters.length > 0 ? `参与 ${meta.characters.join('、')}` : '';
        const places = meta.locations.length > 0 ? `地点 ${meta.locations.join('、')}` : '';
        const suffix = [time, people, places].filter(Boolean).join('；');
        const text = suffix ? `${meta.title}（${suffix}）` : meta.title;
        all.push({
          segment: segment('author_state', `storymeta:${meta.entryId}`, text, [], '作者故事条目的召回元数据（正文由故事书提供）'),
          priority: PRIORITY.author_state - 2, overlap: overlap(queryTerms, meta.title) + hintBoost(meta.entryId, request.query), order: order++,
          aikiEntryId: meta.entryId,
        });
      }
    }
    for (const fact of memory.relationship) { const item = factSegment('relationship', fact, estimateTokens); all.push({ segment: item, priority: PRIORITY.relationship, overlap: overlap(queryTerms, item.text), order: order++ }); }
    for (const fact of memory.soul) { const item = factSegment('user_soul', fact, estimateTokens); all.push({ segment: item, priority: PRIORITY.user_soul, overlap: overlap(queryTerms, item.text), order: order++ }); }
    for (const fact of memory.wiki) { const item = factSegment('user_wiki', fact, estimateTokens); all.push({ segment: item, priority: PRIORITY.user_wiki, overlap: overlap(queryTerms, item.text), order: order++ }); }
    for (const event of continuity.companionTimeline) {
      const text = `用户：${event.userText}\n角色：${event.assistantText}`;
      all.push({ segment: segment('companion_timeline', `companion:${event.eventId}`, text, event.sourceIds ?? [], '当前配对的共同经历'), priority: PRIORITY.companion_timeline, overlap: overlap(queryTerms, text), order: order++ });
    }

    // CB-03: one-level `related` expansion. Sources are entries that genuinely participate in this
    // turn's recall: keyword/alias hits, PLUS author-state rows (the "current state" base set per
    // PLAN §9 — a location/relationship is recalled because it IS current, not only by keyword).
    //
    // Expansion does NOT duplicate the neighbour: the same Entry must never be injected twice
    // (cross-domain dedup below would drop the copy anyway). Instead the neighbour's EXISTING
    // segment is boosted so it wins budget competition alongside the entry that referenced it,
    // and its reason records the expansion. A neighbour with no segment yet is added.
    const aikiHits = all.filter(item => item.aikiEntryId !== undefined && (item.overlap > 0 || item.segment.source === 'author_state'));
    const RELATED_BOOST = 3;
    for (const hit of aikiHits) {
      for (const neighbour of relatedGraph.get(hit.aikiEntryId!) ?? []) {
        const target = all.find(item => item.aikiEntryId === neighbour);
        if (target) {
          target.overlap += RELATED_BOOST;
          target.segment = Object.freeze({ ...target.segment, reason: `${target.segment.reason}；related:${hit.aikiEntryId} 一层展开` });
          continue;
        }
        const source = hints.get(neighbour);
        const title = source ? neighbour : neighbour;
        all.push({
          segment: segment('author_state', `related:${neighbour}`, title, [], `related:${hit.aikiEntryId} 一层展开`),
          priority: Math.max(1, hit.priority - 5), overlap: hit.overlap + RELATED_BOOST, order: order++, aikiEntryId: neighbour,
        });
      }
    }

    // Dedup 1 — identical text (pre-existing rule). Dedup 2 — CB-03: the SAME aiki entry reached
    // through several domains (persona/wiki/lorebook/timeline) is injected ONCE at its highest
    // priority; every other copy is omitted with an explicit cross-domain reason.
    const seen = new Set<string>();
    const seenEntryIds = new Map<string, string>();
    const unique = all.map(item => {
      const key = normalize(item.segment.text);
      if (seen.has(key)) return { ...item, duplicate: true, duplicateReason: '与更高优先级条目重复' };
      seen.add(key);
      if (item.aikiEntryId !== undefined) {
        const winner = seenEntryIds.get(item.aikiEntryId);
        if (winner !== undefined) return { ...item, duplicate: true, duplicateReason: `跨域重复（Entry ${item.aikiEntryId} 已在 ${winner} 进入）` };
        seenEntryIds.set(item.aikiEntryId, item.segment.source);
      }
      return { ...item, duplicate: false, duplicateReason: undefined as string | undefined };
    });
    const ranked = unique.filter(item => !item.duplicate).sort((a, b) => b.priority - a.priority || b.overlap - a.overlap || a.order - b.order);
    let used = 0;
    const selected: ContinuityContextSegment[] = [], omitted: ContinuityContextSegment[] = [];
    const selectedKeys = new Set<string>();
    for (const item of ranked) {
      if (ineligible.has(item.segment.key)) { omitted.push(Object.freeze({ ...item.segment, reason: item.segment.reason })); continue; }
      if (used + item.segment.tokens <= request.tokenBudget) {
        used += item.segment.tokens; selectedKeys.add(item.segment.key);
        selected.push(Object.freeze({ ...item.segment, selected: true }));
      } else omitted.push(Object.freeze({ ...item.segment, reason: item.segment.source === 'author_state' && /过期|尚未生效/.test(item.segment.reason) ? item.segment.reason : '超出本轮 Context 预算' }));
    }
    for (const item of unique.filter(item => item.duplicate)) omitted.push(Object.freeze({ ...item.segment, reason: item.duplicateReason ?? '与更高优先级条目重复' }));
    const render = selected.map(item => {
      const label = item.source === 'character_soul' ? '角色底色' : item.source === 'relationship' ? '关系适应' : item.source === 'user_soul' ? '用户稳定偏好' : item.source === 'character_wiki' ? '角色 Wiki 事实' : item.source === 'canon_timeline' ? '原作时间线' : item.source === 'author_state' ? '作者设定（初始状态）' : item.source === 'user_wiki' ? '用户资料' : '共同经历';
      return `【${label}】\n${item.text}`;
    }).join('\n\n');
    const aiki = this.aiki ? {
      documentImportId: this.aiki.documentImportId(characterId),
      selectedEntryIds: Object.freeze(selected.filter(item => item.source === 'character_wiki' || item.source === 'author_state').map(item => item.key.replace(/^(wiki|authorstate|storymeta):/, '').replace(/:related$/, ''))),
      omittedEntryIds: Object.freeze(omitted.filter(item => item.source === 'author_state').map(item => ({ entryId: item.key.replace(/^(authorstate|storymeta):/, '').replace(/:related$/, ''), reason: item.reason }))),
      recall: 'keyword+alias' as const,
    } : undefined;
    return Object.freeze({
      pairing: Object.freeze({ ...request.pairing }), revision: `${continuity.packRevision}:${memory.revision}`, text: render,
      segments: Object.freeze(unique.map(item => item.segment)), selected: Object.freeze(selected), omitted: Object.freeze(omitted),
      continuity, memory, ...(aiki ? { aiki } : {}),
    });
  }

  async assertCurrent(result: ContinuityContextResult): Promise<void> {
    const currentMemory = this.memory.snapshot(result.pairing);
    if (currentMemory.revision !== result.memory.revision) throw new ContinuityMemoryError('version_conflict', '连续性 Context 已失效。');
    const snapshot = await this.continuity.getSnapshot(result.pairing);
    if (snapshot.packRevision !== result.continuity.packRevision) throw new ContinuityMemoryError('version_conflict', '角色包 Context 已失效。');
  }
}

export { ContinuityContextComposer as ContinuityContextSourceAdapterImpl };

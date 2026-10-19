/**
 * tests/companion-knowledge/n085-00-corpus.ts
 *
 * N085-00: the frozen acceptance corpus, as [the 0.85 index §3](docs/next/0.85/SPEC.md §3) requires.
 *
 * Every sample is **self-written synthetic text**. No real user content is committed here — the
 * spec forbids that explicitly. The purpose is a *deterministic* gate: the thresholds below are
 * registered BEFORE any implementation ran, so nobody can lower them after seeing results.
 *
 * Layout, per the frozen requirements:
 *  - 2 user×character pairings, the same character with 2 instances;
 *  - 2 pack versions of the same character, 2 work branches, 1 story cutoff point;
 *  - 12 positive sources — goals / independently-repeated preferences / important experiences /
 *    character facts, at least 3 each;
 *  - 12 negative sources — trivia / quotes-or-hypotheses / assistant self-statements /
 *    work-or-external material, at least 3 each;
 *  - 6 update/conflict groups;
 *  - 12 queries, each naming its expected source domain and its forbidden domains.
 *
 * The registered machine/profile budget is part of the manifest: it is not something an
 * implementation may discover or relax afterwards.
 */

export interface CorpusSource {
  readonly id: string;
  readonly kind: 'manual_text' | 'input_text' | 'clipboard_text' | 'workspace_directory' | 'assistant_statement' | 'work_external' | 'observation_unsaved';
  readonly text: string;
  /** Positive = should become a candidate; negative = must never become a user fact. */
  readonly polarity: 'positive' | 'negative';
  /** Positive samples name the domain they should land in. */
  readonly expectedDomain?: 'user_soul' | 'user_wiki' | 'relationship' | 'reference_knowledge' | 'character_wiki';
  /** The pairing this evidence belongs to. */
  readonly pairing: 'A' | 'B';
  /** Bumped when a sample is deliberately repeated to prove no weight is added. */
  readonly repeat?: number;
  readonly note?: string;
}

export interface CorpusUpdateGroup {
  readonly id: string;
  readonly kind: 'correction' | 'supersession' | 'conflict' | 'state_change' | 'revive_attempt' | 'duplicate_replay';
  readonly before: string;
  readonly after: string;
  /** The expected live state of the target after the group is applied. */
  readonly expect: 'new_active' | 'new_candidate' | 'disputed' | 'revoked' | 'single_entry';
}

export interface CorpusQuery {
  readonly id: string;
  readonly text: string;
  readonly expectedDomains: readonly ('user_soul' | 'user_wiki' | 'relationship' | 'reference_knowledge' | 'character_wiki' | 'recent_activity')[];
  /** Domains that must never appear for this query. */
  readonly forbiddenDomains: readonly ('character_wiki' | 'reference_knowledge' | 'recent_activity' | 'user_soul' | 'user_wiki' | 'relationship')[];
}

/** Reference machine + budget, registered before implementation. Must not be relaxed later. */
export const REGISTERED_ENVIRONMENT = Object.freeze({
  referenceMachine: 'CI (4 vCPU, 8 GiB, Windows 11, node v24)',
  inputSizeLimits: Object.freeze({ maxSourceBytes: 2 * 1024 * 1024, maxQueriesPerRun: 12 }),
  foregroundRecallP95UpperBoundMs: 120,
  backgroundMaxModelCallsPerSourceEvent: 1,
  backgroundMaxTokensPerCall: 4096,
  // CK-13 frozen values, restated so a later change is visible here.
  replyCooldownMs: 3 * 3_600_000,
  observationIntervalMs: 300_000,
  nearDuplicateThreshold: 0.85,
});

export const PAIRINGS = Object.freeze({
  A: productionPairingShim('local-user', 'companion', 'instance-a'),
  B: productionPairingShim('local-user', 'companion', 'instance-b'),
} as const);

export type PairingId = keyof typeof PAIRINGS;

function productionPairingShim(userId: string, characterId: string, characterInstanceId: string) {
  return { userId, characterId, characterInstanceId };
}

export const PACK_VERSIONS = Object.freeze({ v1: 'v1.0', v2: 'v2.0' });
export const WORK_BRANCHES = Object.freeze({ main: 'main', fork: 'pre-cutoff-branch' });
export const STORY_CUTOFF = '第三章 雨夜';

// ----------------------------------------------------------------------------------------------
// 12 positive sources. Goals(3), repeated preferences(3), important experiences(3), character(3).
// ----------------------------------------------------------------------------------------------

export const POSITIVE_SOURCES: readonly CorpusSource[] = Object.freeze([
  { id: 'P-goal-1', kind: 'manual_text', polarity: 'positive', expectedDomain: 'user_soul',
    pairing: 'A', text: '我的目标是在一年内把旧书店的库存整理完。' },
  { id: 'P-goal-2', kind: 'manual_text', polarity: 'positive', expectedDomain: 'user_soul',
    pairing: 'A', text: '我打算今年学会做手冲咖啡。' },
  { id: 'P-goal-3', kind: 'manual_text', polarity: 'positive', expectedDomain: 'user_soul',
    pairing: 'B', text: '我的目标是养成一早整理书桌的习惯。' },

  // Independently repeated: the same preference arrives from two different sources. The dedup rule
  // means the second arrival must not add weight — that is what the gate checks.
  { id: 'P-pref-1a', kind: 'manual_text', polarity: 'positive', expectedDomain: 'user_wiki',
    pairing: 'A', text: '我喜欢简洁的回复。' },
  { id: 'P-pref-1b', kind: 'input_text', polarity: 'positive', expectedDomain: 'user_wiki',
    pairing: 'A', repeat: 2, text: '我喜欢简洁的回复。', note: '独立重复：同偏好来自另一来源' },
  { id: 'P-pref-2', kind: 'manual_text', polarity: 'positive', expectedDomain: 'user_wiki',
    pairing: 'A', text: '我喝茶不喝咖啡。' },
  { id: 'P-pref-3', kind: 'manual_text', polarity: 'positive', expectedDomain: 'user_wiki',
    pairing: 'B', text: '我习惯晚上十点前睡觉。' },

  { id: 'P-exp-1', kind: 'manual_text', polarity: 'positive', expectedDomain: 'user_wiki',
    pairing: 'A', text: '上个月我搬进了临海新居。' },
  { id: 'P-exp-2', kind: 'input_text', polarity: 'positive', expectedDomain: 'user_wiki',
    pairing: 'A', text: '我完成了第一次旧书修复。' },
  { id: 'P-exp-3', kind: 'manual_text', polarity: 'positive', expectedDomain: 'relationship',
    pairing: 'B', text: '我和家人约定每周日一起整理相册。' },

  { id: 'P-char-1', kind: 'workspace_directory', polarity: 'positive', expectedDomain: 'character_wiki',
    pairing: 'A', text: '阿航在旧城区经营一家旧书店。' },
  { id: 'P-char-2', kind: 'workspace_directory', polarity: 'positive', expectedDomain: 'character_wiki',
    pairing: 'A', text: '阿航每天清晨整理昨夜到货的新书。' },
  { id: 'P-char-3', kind: 'workspace_directory', polarity: 'positive', expectedDomain: 'character_wiki',
    pairing: 'B', text: '阿航重视承诺，答应的事一定做到。' },
]);

// ----------------------------------------------------------------------------------------------
// 12 negative sources. Trivia(3), quotes/hypotheses(3), assistant self-statements(3),
// work/external(3).
// ----------------------------------------------------------------------------------------------

export const NEGATIVE_SOURCES: readonly CorpusSource[] = Object.freeze([
  { id: 'N-trivia-1', kind: 'manual_text', polarity: 'negative', pairing: 'A', text: '今天天气不错，出去走了走。' },
  { id: 'N-trivia-2', kind: 'input_text', polarity: 'negative', pairing: 'A', text: '刚才随手查了一下公交站。' },
  { id: 'N-trivia-3', kind: 'manual_text', polarity: 'negative', pairing: 'B', text: '刚才水烧开了。' },

  { id: 'N-quote-1', kind: 'clipboard_text', polarity: 'negative', pairing: 'A', text: '别人说：「临海的秋天最好看。」' },
  { id: 'N-quote-2', kind: 'clipboard_text', polarity: 'negative', pairing: 'A', text: '书里假设：如果阿航搬离旧城区会怎样。' },
  { id: 'N-quote-3', kind: 'clipboard_text', polarity: 'negative', pairing: 'B', text: '网上假设：这类店主通常不同意拆迁。' },

  { id: 'N-assist-1', kind: 'assistant_statement', polarity: 'negative', pairing: 'A', text: '我猜你喜欢科幻小说，所以推荐了几本。' },
  { id: 'N-assist-2', kind: 'assistant_statement', polarity: 'negative', pairing: 'A', text: '我觉得你今天心情很好。' },
  { id: 'N-assist-3', kind: 'assistant_statement', polarity: 'negative', pairing: 'B', text: '我注意到你在整理旧照片，应该很怀念。' },

  { id: 'N-work-1', kind: 'work_external', polarity: 'negative', pairing: 'A', text: '工作任务：整理 2025 年供应商清单。' },
  { id: 'N-work-2', kind: 'work_external', polarity: 'negative', pairing: 'A', text: '外部资料：临海市 2026 年图书行业报告摘要。' },
  { id: 'N-work-3', kind: 'work_external', polarity: 'negative', pairing: 'B', text: '工作任务：下周三前回复合作方邮件。' },
]);

// ----------------------------------------------------------------------------------------------
// 6 update / conflict groups.
// ----------------------------------------------------------------------------------------------

export const UPDATE_GROUPS: readonly CorpusUpdateGroup[] = Object.freeze([
  { id: 'U1-correction', kind: 'correction', before: '用户在跑步。', after: '用户目前暂停跑步。', expect: 'new_active' },
  { id: 'U2-supersession', kind: 'supersession', before: '用户住在临海旧城。', after: '用户搬到临海新居。', expect: 'new_active' },
  { id: 'U3-conflict', kind: 'conflict', before: '用户只喝绿茶。', after: '用户现在也喝红茶。', expect: 'disputed' },
  { id: 'U4-state', kind: 'state_change', before: '旧书店营业中。', after: '旧书店暂停营业。', expect: 'new_candidate' },
  { id: 'U5-revive', kind: 'revive_attempt', before: '用户喜欢手写信。', after: '（用户遗忘该条）', expect: 'revoked' },
  { id: 'U6-duplicate', kind: 'duplicate_replay', before: '我喜欢简洁的回复。', after: '我喜欢简洁的回复。', expect: 'single_entry' },
]);

// ----------------------------------------------------------------------------------------------
// 12 queries, each with expected and forbidden domains.
// ----------------------------------------------------------------------------------------------

export const QUERIES: readonly CorpusQuery[] = Object.freeze([
  { id: 'Q1', text: '我的目标是什么', expectedDomains: ['user_soul'], forbiddenDomains: ['character_wiki'] },
  { id: 'Q2', text: '我喜欢什么样的回复', expectedDomains: ['user_wiki'], forbiddenDomains: ['reference_knowledge'] },
  { id: 'Q3', text: '我最近搬到哪里了', expectedDomains: ['user_wiki'], forbiddenDomains: ['character_wiki'] },
  { id: 'Q4', text: '我和家人有什么约定', expectedDomains: ['relationship'], forbiddenDomains: ['reference_knowledge'] },
  { id: 'Q5', text: '阿航的旧书店在哪里', expectedDomains: ['character_wiki'], forbiddenDomains: [] },
  { id: 'Q6', text: '阿航每天早上做什么', expectedDomains: ['character_wiki'], forbiddenDomains: [] },
  { id: 'Q7', text: '我喝茶还是喝咖啡', expectedDomains: ['user_wiki'], forbiddenDomains: ['reference_knowledge'] },
  { id: 'Q8', text: '我的作息习惯', expectedDomains: ['user_wiki'], forbiddenDomains: [] },
  { id: 'Q9', text: '我完成了什么第一次', expectedDomains: ['user_wiki'], forbiddenDomains: ['reference_knowledge'] },
  { id: 'Q10', text: '阿航重视什么', expectedDomains: ['character_wiki'], forbiddenDomains: [] },
  { id: 'Q11', text: '我最近整理了什么', expectedDomains: ['recent_activity', 'user_wiki'], forbiddenDomains: [] },
  { id: 'Q12', text: '外部资料里有什么', expectedDomains: ['reference_knowledge'], forbiddenDomains: ['user_wiki'] },
]);

/** Same-character second instance: instance-b must not see instance-a's evidence and vice versa. */
export const CROSS_INSTANCE_RULE = 'instance-b 不得召回 instance-a 的私有事实，反之亦然' as const;

/** Counting helpers so the gate can prove the manifest itself meets the frozen minimums. */
export function counts(): { positive: number; negative: number; updates: number; queries: number; byDomain: Record<'user_soul'|'user_wiki'|'relationship'|'character_wiki'|'reference_knowledge', number> } {
  const positive = POSITIVE_SOURCES.length;
  const negative = NEGATIVE_SOURCES.length;
  const byDomain: Record<string, number> = {};
  for (const source of POSITIVE_SOURCES) {
    if (source.expectedDomain) byDomain[source.expectedDomain] = (byDomain[source.expectedDomain] ?? 0) + 1;
  }
  return { positive, negative, updates: UPDATE_GROUPS.length, queries: QUERIES.length, byDomain };
}

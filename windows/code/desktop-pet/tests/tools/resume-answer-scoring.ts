// RPD_RESUME_QUALITY_v1 section 5: offline semantic rescore of the historical answers.
//
// The schemaVersion-1 rule (`required` keyword containment) cannot see a subject error, so it scored
// C-Q11 as correct when the reply said 「深蓝色是我自己喜欢的颜色」 - the user's fact restated as the
// assistant's own preference. This scorer grades semantically: it must be able to fail a reply that
// contains every keyword, and pass a reply that contains none of them but is plainly correct.
//
// Default mode performs no network access and reads no credential. It consumes the frozen raw answers
// plus an independent annotation file, so a human or AI reviewer can override any automated judgement
// and the summary is rebuilt from the raw answers and the grades rather than from either alone.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type Outcome = 'correct' | 'partial' | 'clarify' | 'refuse' | 'incorrect' | 'empty' | 'api_error' | 'unresolved';
export type Judgment = 'pass' | 'fail' | 'unresolved';

export interface Question {
  id: string; kind?: string; type?: string; query: string;
  relevantIds?: string[]; required?: string[];
  acceptable?: string[]; forbidden?: string[];
  subject?: 'user' | 'assistant' | 'other';
  subjectRule?: string;
}

export interface Grade {
  runId: string; questionId: string; rawAnswerHash: string; rubricVersion: string;
  outcome: Outcome;
  requiredPointsSatisfied: boolean | null;
  subjectCorrect: boolean | null;
  unsupportedAssertion: boolean | null;
  forbiddenViolations: { rule: string; excerpt: string }[];
  /** Diagnostic only. Never the basis of a pass. */
  keywordHit: boolean;
  judgment: Judgment;
  reason: string;
  reviewMethod: 'semantic-auto' | 'human' | 'ai-assisted';
  reviewer: string;
}

export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * First-person-assistant-claim markers. Chinese is written without spaces, so a claim is recognised by
 * the possessive construction rather than by a word list the model could paraphrase away.
 */
const ASSISTANT_OWNERSHIP = [
  // A first-person preference claim. The slot between 我 and the predicate is not only an intensifier
  // (「我最喜欢」) but also a reflexive (「我自己喜欢」, the verbatim C-Q11 counterexample) or a plain
  // gap (「我喜欢」). An earlier form allowed only an optional intensifier and therefore missed
  // 「我自己喜欢」 entirely, which is exactly the case this scorer exists to catch.
  /我(?:自己|本人)?(?:最|也|还|挺|比较|特别|更|常|总|一直)?(?:喜欢|讨厌|偏好|习惯)/,
  /我(?:的)?(?:职业|工作|专业|生日|名字|爱好|颜色|口味|饮品)/,
  /我(?:是|叫)(?:一名)?/, /我(?:住|养|用|早上|平时|在读)/,
];
const USER_ATTRIBUTION = ['你', '您'];

export interface Signals { refusal: boolean; clarifies: boolean; assertsValue: boolean; assistantOwnership: boolean; userAttribution: boolean }

/** Splits on the separators Chinese replies actually use, so each assertion is judged on its own clause.
 *  A reply like 「深蓝色是我自己喜欢的颜色……你的颜色是什么？」 mentions the user in a trailing question
 *  while having already claimed the fact; whole-answer matching cannot see that. The comma split matters
 *  for the same reason: 「资料里只写着我喜欢乌龙茶、最喜欢的颜色是深蓝，都是关于我的，没有你喜欢喝什么」
 *  puts the claim and the user mention in one sentence but different clauses. */
const CLAUSE_SPLIT = /[。！？!?，,；;：:\n]+/;

export function analyze(answer: string): Signals {
  // 「没法确认」/「不能替你点头」are denials of a false premise, not assertions. The historical
  // C-N10 reply used exactly this phrasing and was wrongly graded as a definite unsupported claim.
  const refusal = /不知道|没有记录|没说过|没提过|无法回答|答不上来|没有存过|真不知道|不敢(?:乱)?(?:猜|编)|不该(?:随便)?记|没法确认|无法确认|不能替你|没有.{0,6}的记录|没记录|查不到|不确定/.test(answer);
  const clarifies = /你(?:可以|愿意|要不要|直接)?(?:告诉|说)(?:我|我记)|是(?:不是)?(?:想问|要问)|还是(?:说|想问)/.test(answer) || answer.includes('？') || answer.includes('?');
  const userAttribution = USER_ATTRIBUTION.some(token => answer.includes(token));
  // A clause that asserts a first-person fact is a subject error unless that very clause also
  // attributes it to the user. Attribution is decided per clause, never by the whole reply.
  const assistantOwnership = answer.split(CLAUSE_SPLIT).some(clause =>
    ASSISTANT_OWNERSHIP.some(pattern => pattern.test(clause)) && !USER_ATTRIBUTION.some(token => clause.includes(token)));
  return { refusal, clarifies, assertsValue: !refusal, assistantOwnership, userAttribution };
}

/**
 * Grades one answer against one question. The contract is deliberately strict in both directions:
 * a refusal is not a correct answer to an answerable question, and a keyword match is not a pass.
 */
export function grade(question: Question, answer: string, apiError: string | null, rubricVersion: string, runId: string): Grade {
  const base = { runId, questionId: question.id, rawAnswerHash: sha256(answer), rubricVersion, reviewMethod: 'semantic-auto' as const, reviewer: 'offline-scorer-v1' };
  if (apiError !== null) {
    return { ...base, outcome: 'api_error', requiredPointsSatisfied: null, subjectCorrect: null, unsupportedAssertion: null,
      forbiddenViolations: [], keywordHit: false, judgment: 'fail', reason: `provider failure: ${apiError}` };
  }
  if (answer.trim() === '') {
    // An empty answer is never a correct refusal; it only degrades the call-success rate.
    return { ...base, outcome: 'empty', requiredPointsSatisfied: null, subjectCorrect: null, unsupportedAssertion: null,
      forbiddenViolations: [], keywordHit: false, judgment: 'fail', reason: 'empty answer is not a valid response' };
  }
  const signals = analyze(answer);
  const keywordHit = (question.required ?? []).every(term => answer.includes(term));
  const isUnanswerable = !question.required || question.required.length === 0;
  const forbiddenRules = question.forbidden ?? [];

  if (isUnanswerable) {
    // An unanswerable item passes on a bounded, non-asserting answer. A definite unsupported claim fails.
    const supported = signals.refusal || signals.clarifies;
    if (!supported) {
      return { ...base, outcome: 'incorrect', requiredPointsSatisfied: null, subjectCorrect: true,
        unsupportedAssertion: true, forbiddenViolations: forbiddenRules.map(rule => ({ rule, excerpt: answer.slice(0, 120) })),
        keywordHit: false, judgment: 'fail',
        reason: 'no refusal, clarification or bounded answer; treated as a definite unsupported assertion' };
    }
    const bounded = question.id === 'C-N08';
    return { ...base, outcome: 'refuse', requiredPointsSatisfied: null, subjectCorrect: true, unsupportedAssertion: false,
      forbiddenViolations: [], keywordHit: false, judgment: 'pass',
      reason: bounded ? 'refusal or clarification accepted for a bounded-partial item' : 'refused or clarified without asserting a value' };
  }

  // Answerable item.
  //
  // A subject error is checked FIRST and unconditionally. A refusal that still claims the fact as the
  // assistant's own is the exact historical counterexample: the reply contains the keyword, so any
  // keyword-gated check lets it through and it gets scored as a correct answer.
  if (signals.assistantOwnership) {
    return { ...base, outcome: signals.refusal && !keywordHit ? 'refuse' : 'incorrect',
      requiredPointsSatisfied: keywordHit, subjectCorrect: false,
      unsupportedAssertion: signals.refusal,
      forbiddenViolations: [{ rule: 'subject', excerpt: answer.slice(0, 120) }],
      keywordHit, judgment: 'fail',
      reason: signals.refusal && !keywordHit
        ? 'refused, then restated a user fact as the assistant own preference (subject error)'
        : 'user fact restated as the assistant own fact (subject error)' };
  }
  // A plain refusal cannot satisfy required points.
  if (signals.refusal && !keywordHit) {
    return { ...base, outcome: 'refuse', requiredPointsSatisfied: false, subjectCorrect: null,
      unsupportedAssertion: false, forbiddenViolations: [],
      keywordHit: false, judgment: 'fail',
      reason: 'refused an answerable question; the required fact was not asserted' };
  }
  if (!keywordHit) {
    return { ...base, outcome: signals.clarifies && !signals.refusal ? 'clarify' : 'incorrect', requiredPointsSatisfied: false,
      subjectCorrect: null, unsupportedAssertion: null,
      forbiddenViolations: forbiddenRules.map(rule => ({ rule, excerpt: answer.slice(0, 120) })),
      keywordHit: false, judgment: 'fail', reason: 'required fact not asserted' };
  }
  if (forbiddenRules.length > 0) {
    return { ...base, outcome: 'incorrect', requiredPointsSatisfied: true, subjectCorrect: true, unsupportedAssertion: true,
      forbiddenViolations: forbiddenRules.map(rule => ({ rule, excerpt: answer.slice(0, 120) })),
      keywordHit, judgment: 'fail', reason: 'required points present but a forbidden assertion was made' };
  }
  return { ...base, outcome: 'correct', requiredPointsSatisfied: true, subjectCorrect: true, unsupportedAssertion: false,
    forbiddenViolations: [], keywordHit, judgment: 'pass', reason: 'required fact asserted and attributed to the user' };
}

export interface Ratio { numerator: number; denominator: number; value: number | null }
export interface Summary {
  attempted: number; graded: number; unresolved: number; apiError: number; empty: number;
  keywordHitRate: Ratio; semanticAnswerCompletionRate: Ratio; overallTaskPassRate: Ratio;
  unanswerableFalseAnswerRate: Ratio; callSuccessRate: Ratio;
}

const ratio = (numerator: number, denominator: number): Ratio =>
  ({ numerator, denominator, value: denominator === 0 ? null : numerator / denominator });

const isUnanswerableId = (id: string): boolean => id.startsWith('C-N');

/** Every rate carries its own numerator and denominator. Ungraded items are never silently dropped. */
export function summarize(grades: readonly Grade[], totalAttempted: number): Summary {
  const answerable = grades.filter(g => !isUnanswerableId(g.questionId));
  const unanswerable = grades.filter(g => isUnanswerableId(g.questionId));
  const usable = grades.filter(g => g.outcome !== 'api_error' && g.outcome !== 'empty');
  const keywordDenominator = grades.filter(g => g.keywordHit || answerable.includes(g) || unanswerable.includes(g)).length;
  return {
    attempted: totalAttempted, graded: grades.length, unresolved: grades.filter(g => g.judgment === 'unresolved').length,
    apiError: grades.filter(g => g.outcome === 'api_error').length,
    empty: grades.filter(g => g.outcome === 'empty').length,
    keywordHitRate: ratio(grades.filter(g => g.keywordHit).length, keywordDenominator),
    semanticAnswerCompletionRate: ratio(answerable.filter(g => g.judgment === 'pass').length, answerable.length),
    overallTaskPassRate: ratio(grades.filter(g => g.judgment === 'pass').length, totalAttempted),
    unanswerableFalseAnswerRate: ratio(unanswerable.filter(g => g.judgment === 'fail').length, unanswerable.length),
    callSuccessRate: ratio(usable.length, totalAttempted),
  };
}

/** Applies reviewer overrides; an override may not silently flip a pass without a reason. */
export function applyOverrides(grades: readonly Grade[], overrides: readonly Grade[]): Grade[] {
  const byKey = new Map(overrides.map(o => [`${o.runId} ${o.questionId}`, o]));
  return grades.map(g => {
    const override = byKey.get(`${g.runId} ${g.questionId}`);
    return override ? { ...g, ...override, reviewMethod: override.reviewMethod ?? 'human' } : g;
  });
}

export interface RawAnswerItem { id: string; query: string; answer: string; apiError: string | null; requiredHit: boolean; required?: string[]; [k: string]: unknown }
export interface RawAnswerFile { runId?: string; model?: string; questionCount?: number; answers: RawAnswerItem[] }

export function loadRubric(path: string): Record<string, Question> {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { answerable: Question[]; unanswerable: Question[] };
  return Object.fromEntries([...data.answerable, ...data.unanswerable].map(q => [q.id, q]));
}

/** Binds every grade to the exact raw text it judged, so a grade can never be attached to the wrong answer. */
export function rescoreFile(raw: RawAnswerFile, rubric: Record<string, Question>, runId: string, rubricVersion: string): Grade[] {
  return raw.answers.map(item => {
    const question = rubric[item.id];
    if (!question) throw new Error(`rubric missing question ${item.id}; the rubric and the raw answers must match`);
    return grade(question, item.answer, item.apiError, rubricVersion, runId);
  });
}

export const rubricExists = (path: string): boolean => existsSync(path);

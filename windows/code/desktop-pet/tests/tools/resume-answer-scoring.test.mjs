// RPD_RESUME_QUALITY_v1 section 5.3: the scorer's own boundary tests.
//
// The schemaVersion-1 rule could not separate a correct answer from a subject error, because both
// contain the same keywords. These tests pin the boundaries that matter, including the exact
// historical counterexample, so a future change to the scorer cannot silently reintroduce it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade, summarize, sha256, analyze, loadRubric } from '../../dist/tests/tools/resume-answer-scoring.js';

const rubricVersion = 'rubric-v2';
const runId = 'unit';
const q = (over = {}) => ({ id: 'C-Q01', query: '我的职业是什么？', relevantIds: ['m-job'], required: ['产品设计师'], subject: 'user', forbidden: [], ...over });
const base = { runId, rubricVersion, reviewMethod: 'semantic-auto', reviewer: 'unit' };

test('a correct answer that attributes the fact to the user passes', () => {
  const g = grade(q(), '你是产品设计师呀。', null, rubricVersion, runId);
  assert.equal(g.judgment, 'pass');
  assert.equal(g.outcome, 'correct');
  assert.equal(g.subjectCorrect, true);
});

test('the historical C-Q11 counterexample now FAILS: user fact restated as the assistant own preference', () => {
  // Verbatim from reports/RPD-RESUME-v3/answers-baseline.json (C-Q11). The reply uses 「我自己喜欢」,
  // so the detector must recognise a reflexive between 我 and the predicate, not only an intensifier.
  const answer = '这个我确实不知道，你还没跟我说过。深蓝色是我自己喜欢的颜色，别记混啦——你的颜色是什么？';
  assert.equal(analyze(answer).assistantOwnership, true, 'the clause 「深蓝色是我自己喜欢的颜色」 must be seen as an assistant-ownership claim');
  const g = grade(q({ id: 'C-Q11', required: ['深蓝'] }), answer, null, rubricVersion, runId);
  assert.equal(g.keywordHit, true, 'the historical rule would have called this correct');
  assert.equal(g.judgment, 'fail', 'a subject error must fail even with the keyword present');
  assert.equal(g.subjectCorrect, false);
});

test('the historical C-Q04 repeat counterexample also FAILS', () => {
  // Verbatim from reports/RPD-RESUME-v3/answers-repeat.json (C-Q04): 「只写着我喜欢乌龙茶…都是关于我的」.
  const g = grade(q({ id: 'C-Q04', required: ['乌龙茶'] }),
    '你说的这条我还真没有记录。资料里只写着我喜欢乌龙茶、最喜欢的颜色是深蓝，都是关于我的，没有你喜欢喝什么。你要不要直接告诉我？我记着。', null, rubricVersion, runId);
  assert.equal(g.keywordHit, true);
  assert.equal(g.judgment, 'fail');
  assert.equal(g.subjectCorrect, false);
});

test('a refusal of an answerable question is never a pass', () => {
  const g = grade(q(), '这个我还真不知道，你从来没跟我说过你的职业。', null, rubricVersion, runId);
  assert.equal(g.judgment, 'fail');
  assert.equal(g.outcome, 'refuse');
});

test('a refusal that then claims the fact as its own is a subject failure', () => {
  // The user mention is in a different clause from the claim, so per-clause attribution must fail it.
  const g = grade(q(), '我真不知道你的名字。不过我最喜欢的产品设计师，就是你身边的这位朋友。', null, rubricVersion, runId);
  assert.equal(g.judgment, 'fail');
  assert.equal(g.subjectCorrect, false);
});

test('a false-premise denial phrased as 「没法确认」 passes, not a definite unsupported assertion', () => {
  // Verbatim from reports/RPD-RESUME-v3/answers-baseline.json (C-N10). Denying a false premise is a
  // correct outcome; the phrase 「没法确认」/「不能替你点头」 must not be read as asserting a value.
  const g = grade(q({ id: 'C-N10', required: [], forbidden: ['确认用户说过此话'] }),
    '这个我还真没法确认。我这边没有你说过想去火星旅游的记录，所以不能替你点头。不过现在要是想去，那也挺酷的——就是得再等几十年吧。', null, rubricVersion, runId);
  assert.equal(g.judgment, 'pass');
  assert.equal(g.unsupportedAssertion, false);
});

test('an unanswerable item passes on refusal and on clarification', () => {
  for (const text of ['我真不知道，也没有存过。', '你还没跟我说过呢，是最近有什么特别爱喝的吗？']) {
    const g = grade(q({ id: 'C-N07', required: [], forbidden: ['任何具体金额断言'] }), text, null, rubricVersion, runId);
    assert.equal(g.judgment, 'pass', `expected pass for: ${text}`);
    assert.equal(g.unsupportedAssertion, false);
  }
});

test('an unanswerable item that asserts a value fails', () => {
  const g = grade(q({ id: 'C-N07', required: [], forbidden: ['任何具体金额断言'] }), '你的工资是 25000 元一个月。', null, rubricVersion, runId);
  assert.equal(g.judgment, 'fail');
  assert.equal(g.unsupportedAssertion, true);
});

test('C-N08 accepts a bounded partial answer for the pet-count question', () => {
  const g = grade(q({ id: 'C-N08', required: [], acceptable: ['bounded-partial', 'refuse', 'clarify'] }),
    '这个我还真不知道，你之前没跟我提过具体养了几只。想让我记住的话，现在告诉我也行。', null, rubricVersion, runId);
  assert.equal(g.judgment, 'pass');
});

test('api errors and empty answers are counted apart and never count as a correct refusal', () => {
  const api = grade(q(), '', 'Model did not return valid structured data', rubricVersion, runId);
  assert.equal(api.outcome, 'api_error');
  assert.equal(api.judgment, 'fail');
  const empty = grade(q(), '', null, rubricVersion, runId);
  assert.equal(empty.outcome, 'empty');
  assert.equal(empty.judgment, 'fail');
});

test('every rate carries an explicit numerator and denominator, and ungraded items stay visible', () => {
  const grades = [
    grade(q(), '你是产品设计师。', null, rubricVersion, runId),
    grade(q({ id: 'C-N01', required: [], forbidden: ['任何具体数字断言'] }), '我可不知道。', null, rubricVersion, runId),
    grade(q({ id: 'C-Q02', required: ['小林'] }), '', 'timeout', rubricVersion, runId),
  ];
  const s = summarize(grades, 3);
  assert.equal(s.attempted, 3);
  assert.equal(s.graded, 3);
  assert.equal(s.apiError, 1);
  assert.equal(s.semanticAnswerCompletionRate.numerator, 1);
  assert.equal(s.semanticAnswerCompletionRate.denominator, 2, 'the api-error answerable item stays in the denominator');
  assert.equal(s.callSuccessRate.denominator, 3);
});

test('raw answers bind to their hash, so a grade cannot be attached to the wrong text', () => {
  const g = grade(q(), '你是产品设计师。', null, rubricVersion, runId);
  assert.equal(g.rawAnswerHash, sha256('你是产品设计师。'));
  assert.notEqual(g.rawAnswerHash, sha256('你是产品设计师'));
});

test('analyze does not treat a mere question mark as an unsupported assertion', () => {
  const signals = analyze('你还没跟我说过呢，是最近换了工作吗？');
  assert.equal(signals.clarifies, true);
  assert.equal(signals.assistantOwnership, false);
});

test('every recorded human adjudication still matches the scorer it confirmed', () => {
  // The adjudication file is durable input replayed on each rescore. If the scorer later starts
  // disagreeing with a human verdict, that is a real regression and must fail loudly here rather
  // than being silently overwritten in historical-grades.jsonl.
  // Paths are anchored to this module, not process.cwd(), so the guard runs the same from any directory.
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const repoRoot = resolve(projectRoot, '../../..');
  const adjudication = JSON.parse(readFileSync(resolve(projectRoot, 'tests/eval/fixtures/resume-answers.adjudication.json'), 'utf8'));
  const rubric = loadRubric(resolve(projectRoot, 'tests/eval/fixtures/resume-answers.v2.json'));
  const raw = {
    baseline: JSON.parse(readFileSync(resolve(repoRoot, 'docs/next/eval/reports/RPD-RESUME-v3/answers-baseline.json'), 'utf8')).answers,
    repeat: JSON.parse(readFileSync(resolve(repoRoot, 'docs/next/eval/reports/RPD-RESUME-v3/answers-repeat.json'), 'utf8')).samples,
  };
  assert.ok(adjudication.items.length > 0, 'the adjudication record must not be empty');
  for (const item of adjudication.items) {
    const run = item.runId.split('/').pop();
    const answer = raw[run].find(a => a.id === item.questionId);
    assert.ok(answer, `adjudicated question ${item.questionId} is missing from the ${run} raw answers`);
    const graded = grade(rubric[item.questionId], answer.answer, answer.apiError, 'rubric-v2', item.runId);
    assert.equal(graded.judgment, item.expectedJudgment,
      `${item.runId} ${item.questionId}: scorer says ${graded.judgment}, human adjudicated ${item.expectedJudgment}`);
    if (item.expectedSubjectCorrect !== undefined) {
      assert.equal(graded.subjectCorrect, item.expectedSubjectCorrect,
        `${item.runId} ${item.questionId}: subjectCorrect disagrees with the human verdict`);
    }
  }
});

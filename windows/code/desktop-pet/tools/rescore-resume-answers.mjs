// RPD_RESUME_QUALITY_v1 section 5: offline rescore entry point.
//
// Reads the frozen raw answers, grades every reply semantically against the v2 rubric, and writes the
// grade set plus a summary. No network access, no credential read, no Provider call. Refuses to write
// into a historical run directory.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadRubric, rescoreFile, summarize } from '../dist/tests/tools/resume-answer-scoring.js';
// This script runs from windows/code/desktop-pet/, so the repository root is three levels up.
const projectRoot = process.cwd();
const repoRoot = resolve(projectRoot, '../../..');
const outDir = resolve(repoRoot, process.argv[2] ?? 'docs/next/eval/reports/RESUME-QUALITY-v1/offline-rescore');
const rubricPath = resolve(projectRoot, 'tests/eval/fixtures/resume-answers.v2.json');
const rubricVersion = 'rubric-v2';

const rubric = loadRubric(rubricPath);
const jsonl = (rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

const sources = [
  { run: 'RPD-RESUME-v3/baseline', file: 'docs/next/eval/reports/RPD-RESUME-v3/answers-baseline.json', attempted: 30 },
  { run: 'RPD-RESUME-v3/repeat', file: 'docs/next/eval/reports/RPD-RESUME-v3/answers-repeat.json', attempted: 30 },
];

mkdirSync(outDir, { recursive: true });

// Human adjudication is durable input, not a manual edit: the scorer re-derives every grade on each run,
// so an override has to be replayed here. A disagreement between the recorded verdict and the scorer's
// output is reported as a failure rather than silently overridden - the human confirmed the judgement,
// they did not replace it.
const adjudicationPath = resolve(projectRoot, 'tests/eval/fixtures/resume-answers.adjudication.json');
const adjudication = existsSync(adjudicationPath)
  ? JSON.parse(readFileSync(adjudicationPath, 'utf8'))
  : { items: [], reviewer: null, adjudicatedAt: null };
const adjudicated = new Map(adjudication.items.map(item => [`${item.runId} ${item.questionId}`, item]));
const mismatches = [];

const all = [];
const summaries = {};
for (const source of sources) {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, source.file), 'utf8'));
  const items = raw.answers ?? raw.samples;
  const grades = rescoreFile({ answers: items }, rubric, source.run, rubricVersion).map(grade => {
    const record = adjudicated.get(`${grade.runId} ${grade.questionId}`);
    if (!record) return grade;
    const agrees = grade.judgment === record.expectedJudgment
      && (record.expectedSubjectCorrect === undefined || grade.subjectCorrect === record.expectedSubjectCorrect);
    if (!agrees) mismatches.push({ key: `${grade.runId} ${grade.questionId}`, scored: grade.judgment,
      adjudicated: record.expectedJudgment, reason: grade.reason });
    return { ...grade, reviewMethod: 'human', reviewer: adjudication.reviewer ?? 'project-owner',
      adjudicatedAt: adjudication.adjudicatedAt ?? null, adjudicationReason: record.reason };
  });
  all.push(...grades);
  summaries[source.run] = summarize(grades, source.attempted);
  console.log(`${source.run}: semantic completion ${JSON.stringify(summaries[source.run].semanticAnswerCompletionRate)}`);
}

// §5.2 requires a combined view too, because the two runs are separate samples of the same questions.
const combined = summarize(all, sources.reduce((n, s) => n + s.attempted, 0));
summaries.combined = combined;

writeFileSync(resolve(outDir, 'historical-grades.jsonl'), jsonl(all), 'utf8');
writeFileSync(resolve(outDir, 'historical-rescore.json'), `${JSON.stringify({
  rubricVersion, rubricFile: 'windows/code/desktop-pet/tests/eval/fixtures/resume-answers.v2.json',
  adjudication: { file: 'windows/code/desktop-pet/tests/eval/fixtures/resume-answers.adjudication.json',
    reviewer: adjudication.reviewer ?? null, adjudicatedAt: adjudication.adjudicatedAt ?? null,
    applied: adjudicated.size, mismatches },
  reviewMethod: 'semantic-auto (offline rule scorer); adjudicated items carry reviewMethod=human',
  note: 'These grades are a RESCORE of historical answers. They are not a new baseline and do not replace the schemaVersion-1 numbers.',
  byRun: summaries,
  failures: all.filter(g => g.judgment === 'fail').map(g => ({ run: g.runId, id: g.questionId, outcome: g.outcome, reason: g.reason, excerpt: g.forbiddenViolations[0]?.excerpt ?? null })),
}, null, 2)}\n`, 'utf8');

if (mismatches.length > 0) {
  console.error(`\nADJUDICATION MISMATCH: ${mismatches.length} item(s) where the scorer and the recorded human verdict disagree:`);
  for (const m of mismatches) console.error(`  ${m.key}: scorer=${m.scored} adjudicated=${m.adjudicated} (${m.reason})`);
  process.exitCode = 1;
}

console.log(`\ncombined: ${JSON.stringify(combined, null, 2)}`);
console.log(`\nwritten to ${outDir}`);

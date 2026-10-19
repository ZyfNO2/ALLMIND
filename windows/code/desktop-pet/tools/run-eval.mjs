// EVAL-00: the single evaluation entry point.
//
//   node tools/run-eval.mjs --suite memory|retrieval|latency|robustness|all
//                           --mode offline|real
//                           --output <isolated-dir>
//
// It compiles once, runs each requested suite as its own node:test process, and then reduces the
// per-suite envelopes into eval_results.json. A suite that fails, is blocked, or never ran stays
// distinguishable in the summary: a BLOCKED capability is never folded into a PASS, and a suite
// with no evidence is reported NOT_RUN rather than silently omitted. Default mode is offline and
// performs no network call, no device capture, and touches no user database.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(root, '../../..');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const suiteArg = option('suite', 'all');
const mode = option('mode', 'offline');
const outputOption = option('output', null);

if (!['memory', 'retrieval', 'latency', 'robustness', 'all'].includes(suiteArg)) {
  console.error(`Unknown suite "${suiteArg}". Use memory|retrieval|latency|robustness|all.`);
  process.exit(2);
}
if (!['offline', 'real'].includes(mode)) {
  console.error(`Unknown mode "${mode}". Use offline|real.`);
  process.exit(2);
}

const SUITES = {
  memory: ['dist/tests/eval/memory-hygiene.eval.js', 'memory'],
  retrieval: ['dist/tests/eval/retrieval.eval.js', 'retrieval'],
  latency: ['dist/tests/eval/latency.eval.js', 'latency'],
  robustness: ['dist/tests/eval/robustness.eval.js', 'robustness'],
};
const requested = suiteArg === 'all' ? Object.keys(SUITES) : [suiteArg];

// A relative --output is resolved against the repository root so reports land under docs/next/eval
// regardless of which directory the runner was invoked from.
const outputDirectory = outputOption
  ? resolve(repoRoot, outputOption)
  : join(repoRoot, 'docs/next/eval/reports', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outputDirectory, { recursive: true });

/** Compiles once so every suite runs against freshly built dist output. */
function build() {
  const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
  if (!existsSync(tsc)) {
    console.error('TypeScript is not installed; run npm install first.');
    process.exit(2);
  }
  try {
    execFileSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit', windowsHide: true });
  } catch {
    console.error('Build failed; refusing to evaluate against a stale dist.');
    process.exit(2);
  }
}

function runSuite(relativePath) {
  return new Promise(resolveRun => {
    const absolute = resolve(root, relativePath);
    if (!existsSync(absolute)) {
      resolveRun({ status: 'NOT_RUN', reason: `missing compiled suite: ${relativePath}` });
      return;
    }
    const child = spawn(process.execPath, ['--test', absolute], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, EVAL_OUTPUT: outputDirectory, EVAL_LATENCY_MODE: mode === 'real' ? 'real' : 'offline' },
    });
    child.on('error', error => resolveRun({ status: 'FAIL', reason: error.message }));
    child.on('exit', code => resolveRun({ status: code === 0 ? 'PASS' : 'FAIL', exitCode: code ?? 1 }));
  });
}

/** Reads the env files a suite wrote and derives the summary status from real evidence. */
function readSuiteResult(suite) {
  const path = join(outputDirectory, `eval_${suite}.json`);
  if (!existsSync(path)) return { status: 'NOT_RUN', reason: 'no envelope was produced', path: null, metrics: [], cases: 0, failed: 0, blocked: 0 };
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  const failed = envelope.cases.filter(c => c.status === 'FAIL').length;
  const blocked = envelope.cases.filter(c => c.status === 'BLOCKED').length;
  return { status: envelope.status, path, metrics: envelope.metrics, cases: envelope.cases.length, failed, blocked, evidenceLevel: envelope.evidenceLevel, fixtureHash: envelope.fixtureHash, codeRevision: envelope.codeRevision };
}

build();

console.log(`EVAL run: suites=${requested.join(',')} mode=${mode}`);
console.log(`Output:  ${outputDirectory}\n`);

const runOutcomes = {};
for (const suite of requested) {
  console.log(`--- ${suite} ---`);
  runOutcomes[suite] = await runSuite(SUITES[suite][0]);
}

const results = {};
for (const suite of Object.keys(SUITES)) {
  if (!requested.includes(suite)) {
    // A suite that was not requested is explicitly NOT_RUN, never omitted or implied as passing.
    results[suite] = { status: 'NOT_RUN', reason: 'not requested in this run' };
    continue;
  }
  results[suite] = readSuiteResult(suite);
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode,
  outputDirectory,
  suites: results,
};
writeFileSync(join(outputDirectory, 'eval_results.json'), `${JSON.stringify(summary, null, 2)}\n`);

console.log('\n=== summary ===');
for (const [suite, result] of Object.entries(results)) {
  const detail = result.reason ? ` (${result.reason})` : result.cases !== undefined ? ` cases=${result.cases} failed=${result.failed} blocked=${result.blocked}` : '';
  console.log(`  ${suite.padEnd(11)} ${String(result.status).padEnd(8)}${detail}`);
}

// Exit codes: 0 = every requested suite passed; 1 = an assertion failed; 2 = missing prerequisite.
const statuses = requested.map(suite => results[suite].status);
if (statuses.every(status => status === 'PASS')) process.exit(0);
if (requested.some(suite => runOutcomes[suite]?.status === 'NOT_RUN')) process.exit(2);
if (statuses.some(status => status === 'BLOCKED')) process.exit(2);
process.exit(1);

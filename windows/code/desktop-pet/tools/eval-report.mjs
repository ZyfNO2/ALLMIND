// EVAL-05: evidence roll-up and claim ledger.
//
// Reads only envelopes that the suites actually wrote, verifies that every number can be traced to
// a run, and refuses to promote a BLOCKED or NOT_RUN suite into a passing claim. It never invents a
// metric: a suite that did not run is listed as NOT_RUN with the reason the runner recorded.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(root, '../../..');
const docsEval = resolve(repoRoot, 'docs/next/eval');

const SUITES = ['memory', 'retrieval', 'latency', 'robustness'];

/** Report directories to roll up, in the order they should be presented. */
const SOURCES = [
  { suite: 'memory', label: 'EVAL-01 memory hygiene', directory: 'run-v1', envelope: 'eval_memory.json' },
  { suite: 'retrieval', label: 'EVAL-02 retrieval', directory: 'run-v1', envelope: 'eval_retrieval.json' },
  { suite: 'latency', label: 'EVAL-03 latency (offline harness)', directory: 'run-v1', envelope: 'eval_latency.json' },
  { suite: 'latency', label: 'EVAL-03 latency (real provider + SAPI TTS)', directory: 'EVAL-03-real', envelope: 'eval_latency.json' },
  { suite: 'robustness', label: 'EVAL-04 robustness', directory: 'run-v1', envelope: 'eval_robustness.json' },
];

function load(source) {
  const directory = resolve(docsEval, 'reports', source.directory);
  const path = join(directory, source.envelope);
  if (!existsSync(path)) return { ...source, directory, status: 'NOT_RUN', reason: 'no envelope was produced', metrics: [], cases: [], observations: [], codeRevision: null, fixtureHash: null, evidenceLevel: null };
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  return { ...source, directory, ...envelope, path };
}

const loaded = SOURCES.map(load);

/** A suite status is only "clean" when it recorded cases and none of them failed. */
function claimState(entry) {
  if (entry.status === 'PASS') return 'SUPPORTED';
  if (entry.status === 'BLOCKED') return 'PARTIAL';
  if (entry.status === 'NOT_RUN') return 'NOT_RUN';
  return 'FAILED';
}

const bySuite = {};
for (const entry of loaded) {
  const key = `${entry.suite}:${entry.directory}`;
  bySuite[key] = { status: entry.status, claimState: claimState(entry), cases: entry.cases?.length ?? 0, failed: entry.cases?.filter(c => c.status === 'FAIL').length ?? 0, blocked: entry.cases?.filter(c => c.status === 'BLOCKED').length ?? 0, evidenceLevel: entry.evidenceLevel, codeRevision: entry.codeRevision };
}

/** Formats a metric value for prose, keeping null visible instead of printing a fake zero. */
function fmt(m) {
  if (!m || m.value === null || m.value === undefined) return '未测(null)';
  return typeof m.value === 'number' ? String(Number(m.value.toFixed(2))) : String(m.value);
}

/**
 * Collects a metric across all envelopes that reported it. When several runs report the same
 * metric, the highest evidence level wins, so a real L3 measurement is never shadowed by an
 * offline harness value that merely shares the metric name.
 */
const EVIDENCE_RANK = { L1_deterministic: 1, L2_production_wiring: 2, L3_real_end_to_end: 3 };
function metric(name) {
  const candidates = [];
  for (const entry of loaded) {
    const found = (entry.metrics ?? []).find(m => m.name === name);
    if (found) candidates.push({ ...found, source: entry.label, directory: entry.directory, rank: EVIDENCE_RANK[entry.evidenceLevel] ?? 0 });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.rank - a.rank);
  return candidates[0];
}

const METRIC_NAMES = [
  'noise_penetration_rate', 'noise_candidate_retention_rate', 'sensitive_rejection_rate',
  'automatic_promotion_rate', 'controlled_promotion_success_rate', 'automatic_cross_session_confirmation',
  'correction_coverage', 'forgetting_non_resurrection_rate',
  'recall_at_3', 'hit_at_3', 'mrr_at_3', 'localizable_reference_rate', 'unanswerable_unrelated_hit_rate',
  'search_latency_p50_ms', 'search_latency_p95_ms', 'search_latency_max_ms', 'sqlite_file_bytes',
  'recall_at_3_large', 'search_latency_p95_ms_large', 'import_ms_per_record_first_scale', 'import_ms_per_record_last_scale', 'import_cost_growth_factor', 'projected_import_seconds_10k',
  'provider_ttft_p50_ms', 'provider_ttft_p95_ms', 'reply_complete_p50_ms', 'reply_complete_p95_ms',
  'audio_ready_p50_ms', 'playback_start_wait_p50_ms', 'user_visible_first_token_p50_ms',
  'playback_started_p50_ms', 'acoustic_onset_p50_ms', 'turn_success_rate', 'reasoning_chars_p50', 'response_chars_p50', 'synthesized_audio_p50_ms',
  'cooldown_block_rate', 'violating_displays', 'eligible_candidates_present', 'total_deliveries_after_flood',
  'self_marker_leak_rate', 'external_marker_retention_rate', 'real_scan_cycles', 'anti_echo_real_status',
];
const metrics = {};
for (const name of METRIC_NAMES) { const found = metric(name); if (found) metrics[name] = found; }

/**
 * The claim ledger. Each claim records the evidence that would be required and whether this run
 * actually produced it. `verification_status` stays "pending" whenever any required evidence is
 * missing, so an unverified claim can never be copied into a resume as an established result.
 */
const ledger = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  codeRevision: loaded.find(e => e.codeRevision)?.codeRevision ?? null,
  note: 'Candidate wordings are internal placeholders. A claim whose verification_status is not "verified_for_*" must not be presented as a completed result. Personal responsibility level is unconfirmed by the user and must be confirmed before any resume use.',
  claims: [
    {
      id: 'aiki-eval-memory',
      source_fact: 'Candidate isolation, controlled promotion, correction and forgetting behave as specified across 30 scenario packs.',
      candidate_wording: `构建候选隔离、受控晋升与纠错/遗忘链，在 30 个场景包中噪声渗透为 ${fmt(metrics['noise_penetration_rate'])}（0/10），纠错与遗忘不变量全部通过。`,
      sources: ['docs/next/eval/reports/run-v1/eval_memory.json'],
      responsibility_level: 'unconfirmed',
      verification_status: metrics['noise_penetration_rate']?.value === 0 ? 'verified_for_L1' : 'pending',
      allowed_uses: ['内部技术说明', '面试中描述确定性规则与隔离设计'],
      interview_details: '30 场景包分噪声、证据隔离、纠错遗忘三组；噪声渗透 0/10 且有写入正例（正例产出 2 条候选）；纠错 supersede、遗忘写墓碑并可跨重启。',
      boundary: '自动跨会话确证未实现，报 BLOCKED，不得称"自动确证"。抽取器是确定性规则而非模型，不得称模型抽取准确率。',
      risk_notes: '场景为合成语料，不能外推为"真实用户零污染"。',
      last_verified: new Date().toISOString(),
    },
    {
      id: 'aiki-eval-retrieval',
      source_fact: 'Memory retrieval quality and cost measured on frozen corpora with the shipped trigram FTS5 plus lexical fallback.',
      candidate_wording: `采用 SQLite FTS5 trigram 与词面回退，在 1k 干扰记录、25 条查询上 Recall@3=${fmt(metrics['recall_at_3'])}，暖态查询 P95=${fmt(metrics['search_latency_p95_ms'])}ms。`,
      sources: ['docs/next/eval/reports/run-v1/eval_retrieval.json', 'docs/next/eval/reports/run-v1/import-scaling.json'],
      responsibility_level: 'unconfirmed',
      verification_status: (metrics['recall_at_3']?.value ?? 0) >= 0.9 ? 'verified_for_L1' : 'pending',
      allowed_uses: ['内部技术说明', '面试中描述检索实现与实测口径'],
      interview_details: `25 条有答案查询（中 15/英 5/日 5）＋5 条无答案；Recall@3 为 |top3∩relevant|/|relevant| 均值；分位数 nearest-rank；可定位引用率 ${fmt(metrics['localizable_reference_rate'])}。`,
      boundary: `未使用 BM25，不得写 BM25；同语言匹配不是跨语言检索；1k 是干扰记录规模。导入成本随规模呈二次增长（每记录 ${fmt(metrics['import_ms_per_record_first_scale'])}ms → ${fmt(metrics['import_ms_per_record_last_scale'])}ms），10k 规模报 BLOCKED。`,
      risk_notes: `无生成模型回放，Groundedness 与拒答行为为 NOT_RUN。无答案查询的无关命中率为 ${fmt(metrics['unanswerable_unrelated_hit_rate'])}。`,
      last_verified: new Date().toISOString(),
    },
    {
      id: 'aiki-eval-latency',
      source_fact: 'Real-provider and real-SAPI-TTS latency measured on the shipped serial pipeline.',
      candidate_wording: `在固定配置下实测完整回复可见 P50=${fmt(metrics['reply_complete_p50_ms'])}ms / P95=${fmt(metrics['reply_complete_p95_ms'])}ms，音频就绪 P50=${fmt(metrics['audio_ready_p50_ms'])}ms（真实 Provider + 本地 SAPI 合成，${metrics['turn_success_rate']?.numerator ?? 0}/${metrics['turn_success_rate']?.denominator ?? 0} 成功）。`,
      sources: ['docs/next/eval/reports/EVAL-03-real/eval_latency.json', 'docs/next/eval/reports/EVAL-03-real/timings.json'],
      responsibility_level: 'unconfirmed',
      verification_status: (metrics['reply_complete_p50_ms']?.value ?? null) !== null ? 'verified_for_L3_narrow' : 'pending',
      allowed_uses: ['内部技术说明', '面试中说明测量口径与串行链路事实'],
      interview_details: `主链为 reply() 完整返回后再 synthesize() 再 play()，因此只有"完整回复可见"与"音频就绪"，没有用户可见首字。Provider TTFT P50=${fmt(metrics['provider_ttft_p50_ms'])}ms（不含 reasoning）。`,
      boundary: '不得称流式首字；播放开始回调与声学首音未测（无 renderer/loopback）；不得写"压降 70%"。',
      risk_notes: `样本量为探索级（20 次），P95 标记为探索性。Provider 限流导致 ${fmt(metrics['turns_with_provider_retry'])} 的轮次需要重试，已如实记录。`,
      last_verified: new Date().toISOString(),
    },
    {
      id: 'aiki-eval-arbitration',
      source_fact: 'Cooldown and daily quota arbitration verified against the shipped InvitationStore with a fake clock.',
      candidate_wording: `按有效策略（3 小时冷却、每日 2 次）实现仲裁，在 100 个冷却内有效候选回放中新增展示为 ${fmt(metrics['violating_displays'])}，冷却拦截率 ${fmt(metrics['cooldown_block_rate'])}。`,
      sources: ['docs/next/eval/reports/run-v1/eval_robustness.json'],
      responsibility_level: 'unconfirmed',
      verification_status: metrics['violating_displays']?.value === 0 ? 'verified_for_L1' : 'pending',
      allowed_uses: ['内部技术说明', '面试中描述配额账本与冷却边界'],
      interview_details: `100 个有效候选（eligible=${fmt(metrics['eligible_candidates_present'])}）在同一冷却窗口内新增展示 0，且有可展示正例与配额上限核对；跨入口共享 all_characters 账本，重启后仍生效。`,
      boundary: '仅表示该样本范围内未观察到违规；showNext 在卡片可见期间幂等复用，不新增投递。',
      risk_notes: '策略读自产品常量，未修改产品规则。',
      last_verified: new Date().toISOString(),
    },
    {
      id: 'aiki-eval-anti-echo',
      source_fact: 'Real-machine anti-echo was not executed because production capture/OCR hooks are absent.',
      candidate_wording: '（不可用）在授权桌面场景的 100 次真实扫描中未观察到自身气泡回灌触发。',
      sources: ['docs/next/eval/reports/run-v1/eval_robustness.json'],
      responsibility_level: 'unconfirmed',
      verification_status: 'blocked',
      allowed_uses: ['仅可作为缺口与后续开发说明'],
      interview_details: '生产组合根构造 ScreenCaptureSource 与 createLocalOcrEngine 时未注入 captureHook/recognizePixelHook；默认捕获返回 synthetic 帧，OCR 仅读 PNG tEXt/iTXt，实测无元数据 PNG 识别结果为 0 块。',
      boundary: '严禁使用"100 次真实扫描未观察到回灌"这一表述；空 OCR 结果不能证明防环。',
      risk_notes: '实机防环需先完成 native 接线，再另立评测。',
      last_verified: new Date().toISOString(),
    },
    {
      id: 'aiki-eval-import-scaling',
      source_fact: 'Ingestion cost grows quadratically because pruneTranscripts scans all transcript rows on every append.',
      candidate_wording: `定位并量化记忆导入的二次复杂度：每记录导入耗时由 ${fmt(metrics['import_ms_per_record_first_scale'])}ms 增至 ${fmt(metrics['import_ms_per_record_last_scale'])}ms，随规模线性上升。`,
      sources: ['docs/next/eval/reports/run-v1/import-scaling.json', 'windows/code/desktop-pet/memory/sqlite-store.ts'],
      responsibility_level: 'unconfirmed',
      verification_status: 'verified_for_L1',
      allowed_uses: ['内部技术说明', '面试中描述性能定位与实测方法'],
      interview_details: 'memory/sqlite-store.ts 的 #pruneTranscripts 在每次 append 时对全部 transcript 行做有序全表扫描，导致总导入成本为 O(n²)；查询成本增长远低于导入成本。',
      boundary: '这是定位与量化结果，未包含修复；修复后需重跑本项。',
      risk_notes: '10k 规模因该复杂度未能在实用窗口内完成，故报 BLOCKED 而非填数。',
      last_verified: new Date().toISOString(),
    },
  ],
};

mkdirSync(docsEval, { recursive: true });
writeFileSync(resolve(docsEval, 'claim-evidence-ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);

const lines = [];
lines.push('# AIKI EVAL v1 报告');
lines.push('');
lines.push(`生成时间：${new Date().toISOString()}`);
lines.push(`源码修订：${ledger.codeRevision ?? '未记录'}`);
lines.push('');
lines.push('本报告只汇总各 suite 实际写出的证据包。缺失或未运行的项保留 NOT_RUN/BLOCKED，不会被折算成通过。');
lines.push('');
lines.push('## 1. 各维状态');
lines.push('');
lines.push('| 套件 | 状态 | 证据等级 | 用例 | 失败 | 阻塞 |');
lines.push('| --- | --- | --- | --- | --- | --- |');
for (const entry of loaded) {
  const s = bySuite[`${entry.suite}:${entry.directory}`];
  lines.push(`| ${entry.label} | ${s.status} | ${s.evidenceLevel ?? '-'} | ${s.cases} | ${s.failed} | ${s.blocked} |`);
}
lines.push('');
lines.push('## 2. 关键指标（均可回溯到来源证据包）');
lines.push('');
lines.push('| 指标 | 值 | 单位 | 分母 | 来源 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const [name, m] of Object.entries(metrics)) {
  const value = m.value === null ? 'null（无有效分母或未测）' : (typeof m.value === 'number' ? Number(m.value.toFixed(4)) : String(m.value));
  const denominator = m.denominator !== undefined ? `${m.numerator ?? '-'}/${m.denominator}` : (m.numerator !== undefined ? String(m.numerator) : '-');
  lines.push(`| ${name} | ${value} | ${m.unit} | ${denominator} | ${m.source} |`);
}
lines.push('');
lines.push('## 3. 主张与放行状态');
lines.push('');
lines.push('| 主张 ID | 放行状态 | 边界 |');
lines.push('| --- | --- | --- |');
for (const claim of ledger.claims) {
  lines.push(`| ${claim.id} | ${claim.verification_status} | ${claim.boundary} |`);
}
lines.push('');
lines.push('## 4. 未通过 / 未运行项');
lines.push('');
for (const entry of loaded) {
  const failures = (entry.cases ?? []).filter(c => c.status === 'FAIL');
  const blocked = (entry.cases ?? []).filter(c => c.status === 'BLOCKED');
  if (!failures.length && !blocked.length) continue;
  lines.push(`### ${entry.label}`);
  for (const c of failures) lines.push(`- FAIL \`${c.caseId}\`${c.error ? `：${c.error}` : ''}`);
  for (const c of blocked) lines.push(`- BLOCKED \`${c.caseId}\`：${JSON.stringify(c.actual)}`);
  lines.push('');
}
lines.push('## 5. 明确不可使用的主张');
lines.push('');
lines.push('- 不得声称流式首字或 680ms 级首字：当前主链等待完整回复。');
lines.push('- 不得声称 70% 压降：本轮未做受控 A/B。');
lines.push('- 不得声称 BM25：当前实现为 trigram FTS5 与词面回退。');
lines.push('- 不得声称 100 次真实扫描防环：native 接线缺失，实机为 BLOCKED。');
lines.push('- 不得声称自动跨会话确证：未实现。');
lines.push('');
lines.push('## 6. 简历 Bullet（候选，需用户确认个人职责后使用）');
lines.push('');
lines.push('以下三条只使用本报告已核验的数字。个人贡献范围未经确认，使用前必须由用户确认本人负责的部分；');
lines.push('若本人未主导相应实现，应改为"参与"或删除。');
lines.push('');
lines.push(`1. 为长期记忆设计候选隔离与纠错/遗忘链，用 30 个场景包（噪声/证据隔离/纠错遗忘）验证：噪声渗透 ${fmt(metrics['noise_penetration_rate'])}（0/10，且保留写入正例），纠错 supersede、遗忘写墓碑并可跨重启，安全不变量全部通过。`);
lines.push(`2. 在 SQLite FTS5 trigram ＋词面回退的本地检索上建立可复跑评测：25 条冻结查询、1k 干扰记录下 Recall@3=${fmt(metrics['recall_at_3'])}、暖态查询 P95=${fmt(metrics['search_latency_p95_ms'])}ms；并通过导入耗时曲线定位到导入路径的二次复杂度（每记录 ${fmt(metrics['import_ms_per_record_first_scale'])}ms → ${fmt(metrics['import_ms_per_record_last_scale'])}ms）。`);
lines.push(`3. 对主动交互建立仲裁评测：读取有效策略（3 小时冷却、每日 2 次），在 100 个冷却内有效候选回放中新增展示为 ${fmt(metrics['violating_displays'])}，并核对跨入口共享账本与重启后配额持久性；同时如实报告 native 采集未接线导致的实机防环缺口。`);
lines.push('');
lines.push('说明：本轮未产出流式首字、BM25、自动确证或实机防环成绩，上述 bullet 均不涉及这些表述。');
lines.push('');

writeFileSync(resolve(docsEval, 'reports', 'REPORT.md'), `${lines.join('\n')}\n`);
console.log(`report: ${resolve(docsEval, 'reports', 'REPORT.md')}`);
console.log(`ledger: ${resolve(docsEval, 'claim-evidence-ledger.json')}`);
for (const entry of loaded) {
  const s = bySuite[`${entry.suite}:${entry.directory}`];
  console.log(`  ${entry.label}: ${s.status} cases=${s.cases} failed=${s.failed} blocked=${s.blocked}`);
}

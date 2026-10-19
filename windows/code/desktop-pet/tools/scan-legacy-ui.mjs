#!/usr/bin/env node
/**
 * tools/scan-legacy-ui.mjs — LUI-07 退役扫描器。
 *
 * 为什么需要它：LUI-07 的 AC 要求「全仓 import/URL/文件扫描覆盖 Windows/macOS/tests/tools/docs 的
 * 实际分发材料」，并且明确写了「不能只搜 `legacy.html`，还需旧 view/session 名称及旧静态候选兜底」。
 * 手工 rg 很容易漏掉三类引用，所以这里把它们固定成可复跑的检查：
 *
 *   1. **旧 URL/入口**：`legacy.html`、`/app.mjs`、`/style.css` 等旧壳静态候选。
 *   2. **旧模块名**：`*-view.mjs`、`roles-session.mjs`、`dom.mjs`、`envelope.mjs`、`routes.mjs`、
 *      `icons.mjs`、`api.mjs`、`views.mjs` —— 只搜 `legacy.html` 会全部漏掉。
 *   3. **旧静态兜底**：`server.ts` 里「同名 .mjs/.js/.css/.html 文件存在即可提供」的通用回退。
 *
 * 用法：
 *   node tools/scan-legacy-ui.mjs                 # 扫描，打印报告；有命中则 exit 1
 *   node tools/scan-legacy-ui.mjs --json          # 机器可读
 *   node tools/scan-legacy-ui.mjs --allow-missing # 旧目录已删除时不把「文件不存在」当失败
 *   node tools/scan-legacy-ui.mjs --strict        # 保守口径：源码/测试里的旧名注释也计为待处理
 *
 * 口径（与计划 §LUI-07 一致）：
 *  - **负向测试里的旧 URL 字面量**允许保留：它们是「旧页必须 404」的断言，不是隐藏运行引用。
 *    这类命中会标为 `negative-test`，不计入失败。
 *  - **本计划与 LUI 报告里的历史路径**允许保留：文档记录事实，不是可运行引用。标为 `history-doc`。
 *  - **源码/测试里的旧名注释**允许保留：注释既不能 import 也不能发起请求，所以不是引用。标为
 *    `comment`。它是迁移溯源说明；`--strict` 下计入失败，以保留更保守的审查口径。
 *  - 同行有明确拒绝断言（如旧路径 fetch 后要求 404、`toHaveCount(0)`、`assert.ok(!...)`）时，标为
 *    `negative-test`。仅当根据**同文件其他行**的拒绝断言推断纯字面量声明时，才要求该行没有加载动作。
 *  - 其余命中都是 `live`，必须处理。
 *
 * `ACTIVE_REF` 只阻止「同文件上下文」把真正的加载/请求行降为负向命中；它不覆盖同行显式的拒绝断言，
 * 因为「请求旧路径并断言 404」正是计划允许保留的负向测试。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const codeRoot = fileURLToPath(new URL('..', import.meta.url));
const windowsRoot = resolve(codeRoot, '../..');
const repoRoot = resolve(windowsRoot, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.local', '.cache', 'test-results', 'target', '.probe', 'third-party', 'vendor']);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '.html', '.css', '.md', '.mts', '.cts']);

/** 旧壳静态候选：旧 server.ts 的 names 表与通用回退能直接提供的名字。 */
const LEGACY_URLS = [
  'legacy.html',
  '/app.mjs',
  '/aika.html',
  '/aika-view.mjs',
  '/api.mjs',
  '/dom.mjs',
  '/views.mjs',
  '/routes.mjs',
  '/icons.mjs',
  '/envelope.mjs',
  '/style.css',
  '/modern-overview.mjs',
  '/modern-knowledge-view.mjs',
  '/modern-timeline-view.mjs',
  '/pending-memory-view.mjs',
  '/self-setup-view.mjs',
  '/emotion-view.mjs',
  '/memory-import-view.mjs',
  '/memory-dynamics-view.mjs',
  '/balances-view.mjs',
  '/wake-view.mjs',
  '/wechat-view.mjs',
  '/skin-view.mjs',
  '/health-view.mjs',
  '/presentation-view.mjs',
  '/knowledge-view.mjs',
  '/wiki-view.mjs',
  '/roles-view.mjs',
  '/roles-session.mjs',
  '/role-api-view.mjs',
  '/role-appearance-view.mjs',
  '/role-references-view.mjs',
  '/role-knowledge-actions.mjs',
  '/character-preset-view.mjs',
  '/appearance-import-view.mjs',
  '/collection-view.mjs',
  '/companion-knowledge-view.mjs',
  '/companion-preferences-view.mjs',
  '/desktop-host-view.mjs',
  '/developer-view.mjs',
  '/perception-view.mjs',
  '/perception-session.mjs',
  '/playground-view.mjs',
  '/plugins-view.mjs',
  '/proactive-view.mjs',
  '/projects-view.mjs',
  '/tasks-view.mjs',
  '/next65-view.mjs',
  '/work-protocol-view.mjs',
  '/presentation-preview.js',
];

/** 旧 UI 目录里的模块名（不带前导斜杠），用于抓 import/readFile 形式。 */
const LEGACY_MODULES = LEGACY_URLS.filter(url => url.endsWith('.mjs')).map(url => url.slice(1));

/** Source-language full-line comment marker; Markdown prose is excluded separately. */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--)/;
/** Load/request tokens used only to guard file-context reclassification. */
const ACTIVE_REF = /\b(import|require|fetch|readFile|readdir|createReadStream|src\s*=|href\s*=)/;
/** 「旧东西必须不可用」的强断言：404/410、不得/不再/拒绝/never、数量必须为 0。 */
const REJECTION = /(必须|不得|不再|拒绝|should not|must not|\bnever\b|doesNotMatch|doesNotInclude|notEqual|notStrictEqual|\b404\b|\b410\b|toHaveCount\(0\)|assert\.ok\(\s*!|,\s*false\s*[,)]|\.count\(\),\s*0\b)/i;
/** 把「被请求到的旧资源」登记下来的检测器，供同文件后面的断言拒绝。 */
const DETECTOR = /(legacy|retired|forbidden)\w*\s*\.\s*push\s*\(/;

/**
 * 文档里「确实指向旧 UI 文件」的链接目标：Markdown 链接与可打开的 URL。
 *
 * 计划删除边界要求「历史报告保留事实并标记退役，不保留可启动的旧 UI 链接/附件」。因此文档中
 * 只是叙述「当时有 `app.mjs`」属历史事实（history-doc），但 `[api.mjs](../../../…/management/ui/api.mjs)`
 * 这类仍可点击、直接指向已删旧页面的目标必须改掉。
 *
 * 两类不算链接目标，理由与「文档允许保留历史事实」一致：
 *  - 散文里的裸盘符/仓库路径（`management/ui/roles-view.mjs:273`）不被 Markdown 渲染成可点击链接，
 *    它记录的是「当时文件在哪一行」这一事实。
 *  - 形如 `http://127.0.0.1:<port>/aika-view.mjs` 的历史运行说明记录的是当时的启动步骤；它不是仓库文件
 *    链接，且旧路由已 404，不可点击打开旧页面。
 */
function linkTargets(line) {
  const targets = [];
  // Markdown link/embedding targets: clickable, so they can still open a retired page.
  for (const match of line.matchAll(/\]\(\s*<?([^)\s>]+)>?/g)) targets.push(match[1]);
  // URL forms that a reader or renderer can open directly.
  for (const match of line.matchAll(/(?:https?|file):\/\/[^\s)|`]+/g)) targets.push(match[0]);
  return targets.map(target => target.replace(/\\/g, '/'));
}

/**
 * A Markdown link is a genuine retired-UI link only when it targets a file this retirement actually
 * deleted. Two things stay historical facts instead of findings:
 *  - prose that names an old file without a link target (`management/ui/app.mjs` in a code span);
 *  - recorded run instructions such as `http://127.0.0.1:<port>/aika-view.mjs`, which are steps that
 *    were true at the time and whose route is now 404 anyway.
 */
function linkTargetsDeletedFile(line, token) {
  for (const target of linkTargets(line)) {
    if (!target.includes(token)) continue;
    if (target.includes('management/ui/') || target.includes('management%2Fui/')) return true;
  }
  return false;
}

/**
 * 文件被判定为「负向测试/历史文档」而不是可运行引用的规则。
 *
 * 计划原文：「负向测试里的旧 URL 字面量与本计划中的历史路径单独允许，不作为隐藏运行引用。」
 *
 * 分类顺序很重要：先判「文件本身就是要删的旧文件」和「构建产物」，再判负向/历史，
 * 剩下的才是必须处理的 live 引用。
 *
 * `fileRejects`：该文件里是否已存在强拒绝断言（404/不得/数量为 0）。真实测试常把旧 URL 先赋给
 * 一个常量、再在别处断言它不可用；只看单行会把常量声明误判成 live。因此仅在本行没有加载动作时，
 * 文件级上下文才将其归为负向断言。带加载动作的行不会被**文件级推断**降级；但若该行本身明确有
 * 404/零数量等拒绝断言，则由上一条规则归为 `negative-test`。
 */
function classify(relPath, line, token, fileRejects = false, fileMarkedRetired = false) {
  // 扫描器自身的 token 清单不是引用。
  if (/\/tools\/scan-legacy-ui\.mjs$/.test(relPath)) return 'scanner';
  // 旧 UI 目录内的文件自己引用自己：它们整体在 LUI-07 删除清单里，不是「外部消费者」。
  if (/^(windows\/code\/desktop-pet|code\/desktop-pet)\/management\/ui\/(?!character-app\/)/.test(relPath)) return 'legacy-self';
  // 构建产物（gitignore 的 character-app/）：由源码重新生成，重建后应自动消失。
  if (/\/management\/ui\/character-app\//.test(relPath)) return 'build-artifact';
  if (/^docs\/next\/ui-rework\/(LEGACY_UI_RETIREMENT_PLAN|LUI_CONTRACTS|LUI_CONTAINS|RPD|SPEC)/.test(relPath)) return 'history-doc';
  if (/^docs\/next\/ui-rework\/reports\/LUI-/.test(relPath)) return 'history-doc';
  // 文档里仍可点击、且确实指向已删旧 UI 文件的链接：不是历史叙述，必须处理。
  if (/\.md$/i.test(relPath) && linkTargetsDeletedFile(line, token)) return 'live';
  if (/\.md$/i.test(relPath)) {
    // 该行自己记录了退役/删除事实，或所在文档已带 LUI-07 退役标记：历史叙述，非运行引用。
    if (/退役|retire|已删除|历史/.test(line)) return 'history-doc';
    if (fileMarkedRetired) return 'history-doc';
  }
  const active = ACTIVE_REF.test(line);
  // Only classify actual source-language full-line comments here; Markdown `*`/`#` are prose syntax.
  if (!/\.md$/i.test(relPath) && COMMENT_LINE.test(line)) return 'comment';
  // 负向断言：同一行出现「必须 404 / 不得 / must not / toHaveCount(0) / assert.ok(!…)」等。
  if (REJECTION.test(line) || DETECTOR.test(line)) return 'negative-test';
  // 同文件已有强拒绝断言，且本行没有加载动作：这是「旧地址字面量」的声明，不是引用。
  if (fileRejects && !active) return 'negative-test';
  return 'live';
}

/**
 * 命中判定。
 *
 * 关键是**不能用裸 `includes`**：`/presentation-preview.js` 是新路径 `/preview-runtime/presentation-preview.js`
 * 的子串，裸匹配会把已经迁移好的正确引用误报成旧引用。所以每个 token 都要求它前面不是
 * `-`、字母或数字（即不是更长名字的后缀）。
 */
const TOKEN_MATCHERS = [...new Set([...LEGACY_URLS, ...LEGACY_MODULES])].map(token => {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { token, pattern: new RegExp('(?<![\\w-])' + escaped) };
});

function matches(line) {
  for (const { token, pattern } of TOKEN_MATCHERS) if (pattern.test(line)) return token;
  return null;
}

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(extname(entry.name))) {
      yield full;
    }
  }
}

/** 扫描一个根目录，返回命中列表。 */
async function scanRoot(root) {
  const hits = [];
  for await (const file of walk(root)) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    if (!matches(text)) continue;
    const relPath = relative(repoRoot, file).split('\\').join('/');
    const lines = text.split(/\r?\n/);
    // File-level context: a real test often declares the retired URL once and rejects it elsewhere.
    const fileRejects = lines.some(line => REJECTION.test(line) || DETECTOR.test(line));
    // A historical document that carries the LUI-07 retirement banner records deleted names as prose.
    const fileMarkedRetired = lines.some(line => line.includes('LUI-07 退役提示'));
    for (const [index, line] of lines.entries()) {
      const token = matches(line);
      if (!token) continue;
      hits.push({ file: relPath, line: index + 1, token, kind: classify(relPath, line, token, fileRejects, fileMarkedRetired), text: line.trim().slice(0, 200) });
    }
  }
  return hits;
}

/** 旧静态兜底：server.ts 里「文件存在即可提供」的分支。 */
async function checkStaticFallback() {
  const findings = [];
  for (const rel of ['windows/code/desktop-pet/management/server.ts', 'code/desktop-pet/management/server.ts']) {
    const file = resolve(repoRoot, rel);
    if (!existsSync(file)) continue;
    const source = await readFile(file, 'utf8');
    // 旧回退的判别式：形如 `/^\/[a-zA-Z0-9_\-]+\.(mjs|js|css|html)$/` 的路径正则 + existsSync(uiRoot 拼接)。
    if (/\\\/\^\\\/\[a-zA-Z0-9_\\-\]\+\\\.\(mjs\|js\|css\|html\)/.test(source) || /\^\\\/\[a-zA-Z0-9_\\-\]\+\\\.\(mjs\|js\|css\|html\)\$/.test(source)) {
      findings.push({ file: rel, issue: 'generic static fallback: any existing .mjs/.js/.css/.html under uiRoot is served' });
    }
    if (source.includes("'/legacy.html'")) findings.push({ file: rel, issue: "explicit /legacy.html entry still served" });
  }
  return findings;
}

/** 旧 UI 目录是否仍存在。 */
async function directoryState() {
  const state = {};
  for (const rel of ['windows/code/desktop-pet/management/ui', 'code/desktop-pet/management/ui']) {
    const dir = resolve(repoRoot, rel);
    if (!existsSync(dir)) { state[rel] = { exists: false, files: 0 }; continue; }
    let files = 0;
    for await (const _ of walk(dir)) files += 1;
    state[rel] = { exists: true, files };
  }
  return state;
}

const json = process.argv.includes('--json');
const allowMissing = process.argv.includes('--allow-missing');
// Conservative view: a source/test comment naming a retired file is not a reference, but `--strict`
// still reports it so the raw token-mention count stays reproducible for review.
const strict = process.argv.includes('--strict');

// Explicitly include both implementation trees and repository docs; root `docs/` is not nested under either tree.
const hits = [
  ...await scanRoot(windowsRoot),
  ...await scanRoot(resolve(repoRoot, 'code')),
  ...await scanRoot(resolve(repoRoot, 'docs')),
];
const staticFallback = await checkStaticFallback();
const directories = await directoryState();
const live = hits.filter(hit => hit.kind === 'live');
const negative = hits.filter(hit => hit.kind === 'negative-test');
const history = hits.filter(hit => hit.kind === 'history-doc');
const legacySelf = hits.filter(hit => hit.kind === 'legacy-self');
const artifacts = hits.filter(hit => hit.kind === 'build-artifact');
const comments = hits.filter(hit => hit.kind === 'comment');

if (json) {
  console.log(JSON.stringify({ directories, staticFallback, live, negative, history, legacySelf, artifacts, comments }, null, 2));
} else {
  console.log('# LUI-07 旧 UI 退役扫描\n');
  console.log('## 旧 UI 目录状态');
  for (const [dir, info] of Object.entries(directories)) {
    console.log(`- ${dir}: ${info.exists ? `仍存在（${info.files} 个可扫描文件）` : '不存在'}`);
  }
  console.log('\n## 旧静态兜底');
  if (!staticFallback.length) console.log('- 无（已封）');
  for (const finding of staticFallback) console.log(`- ${finding.file}: ${finding.issue}`);
  console.log(`\n## 可运行引用（live）：${live.length}`);
  for (const hit of live) console.log(`- ${hit.file}:${hit.line} [${hit.token}] ${hit.text}`);
  console.log(`\n## 旧目录内部自引用（随目录整体删除）：${legacySelf.length}`);
  console.log(`## 构建产物残留（重建后应消失）：${artifacts.length}`);
  console.log(`## 负向测试断言（允许保留）：${negative.length}`);
  console.log(`## 历史文档（允许保留）：${history.length}`);
  console.log(`## 源码/测试迁移溯源注释（允许保留，无加载动作）：${comments.length}`);
  if (comments.length && strict) {
    console.log('\n溯源注释明细（--strict 视为待处理；默认允许保留）：');
    for (const hit of comments) console.log(`- ${hit.file}:${hit.line} [${hit.token}] ${hit.text}`);
  } else if (comments.length) {
    console.log('   （用 --strict 查看明细）');
  }
  if (negative.length) {
    console.log('\n负向断言明细（确认都是「旧页必须不可用」而不是隐藏引用）：');
    for (const hit of negative) console.log(`- ${hit.file}:${hit.line} [${hit.token}] ${hit.text}`);
  }
}

const missingDirectories = Object.values(directories).filter(info => info.exists);
const failures = live.length + (strict ? comments.length : 0) + staticFallback.length + (allowMissing ? 0 : missingDirectories.length);
if (!json) {
  const verdict = failures === 0 ? 'PASS（无旧 UI 可运行引用，旧目录已清空）' : `FAIL（${failures} 项待处理）`;
  console.log(`\n结论：${verdict}${strict ? '（--strict 口径）' : ''}`);
}
process.exitCode = failures === 0 ? 0 : 1;

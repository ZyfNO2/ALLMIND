#!/usr/bin/env node
/**
 * tools/quick.mjs — 阶段快速入口（本地调试 / 验收专用）
 *
 * 为什么存在：每个阶段收尾都要留下"下次怎么最快跑起来"的入口，而不是让人重新翻文档、猜命令、
 * 猜环境变量。这里只做编排：拼装既有工具（dev-desktop-real / dev-desktop / serve-management /
 * probe-* / refresh-runtime），不复制它们的逻辑，也不绕过生产入口。
 *
 * 诚实边界：
 *  - `real` 走 book-launcher/book-backend（文件后端），文字聊天调用显式保存的模型。
 *  - `preview` 是离线回显；`console` 是新文件后端的管理 UI，共用正式召回链。
 *  - `pin` 会重写 trial config.json/activation.json（自动留 .<uuid>.backup），不迁移数据库。
 *  - `stop` 只结束本仓库目录下的 Electron 与 backend.lock 记录的进程。
 *
 * 用法：node tools/quick.mjs [entry] [--flags]
 *       npm run quick                 # 列出全部入口
 *       npm run quick -- real         # 起真实桌宠 + 控制台
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const pet = resolve(here, '..');
const windowsRoot = resolve(pet, '../..');
const trialDir = resolve(windowsRoot, '.local/model-evaluation/trial/user-trial');
const paths = {
  config: join(trialDir, 'config.json'),
  activation: join(trialDir, 'activation.json'),
  session: join(trialDir, 'management-session.json'),
  lock: resolve(windowsRoot, '.local/model-evaluation/backend.lock'),
  electron: join(pet, 'node_modules/electron/dist/electron.exe'),
  ocrHelper: join(pet, 'dist/ocr/aika-windows-media-ocr.exe'),
  // 可选的 Windows OCR native helper 构建工具链。仓库不内置任何本机绝对路径；
  // 需要时由调用者用 AIKI_VCVARS 指向自己的 vcvars64.bat，未设置则该入口 BLOCKED。
  vcvars: process.env.AIKI_VCVARS ?? '',
};
const node = process.execPath;
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const entry = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'list';

const c = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', off: '\x1b[0m' };
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
const head = t => say(`\n${c.bold}${t}${c.off}`);

/** Run a command in the foreground with inherited stdio; returns its exit code. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: pet, stdio: 'inherit', windowsHide: true, ...options });
  return result.status ?? 1;
}
/** Same, but detached-style background: caller keeps the child handle. */
function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: pet, windowsHide: true, stdio: 'inherit', ...options });
  child.once('error', error => say(`${c.red}启动失败:${c.off} ${error.message}`));
  return child;
}
/**
 * Start the pet so it does NOT belong to this terminal's process tree.
 *
 * Why this exists: a foreground child dies with whatever launched it. When the launcher runs under an
 * agent/terminal that can be interrupted, that kills the WHOLE tree — including Electron — and Windows
 * reports it as exit 1 with no signal marker. That looked like a pet crash but was a launcher-lifecycle
 * artifact. Detached + own process group + log file means the pet keeps running on its own.
 */
function launchDetached(command, args, options = {}) {
  const logFile = join(windowsRoot, '.local/model-evaluation/desktop-pet.log');
  mkdirSync(dirname(logFile), { recursive: true });
  const out = openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd: pet, windowsHide: true, detached: true, stdio: ['ignore', out, out],
    ...options,
  });
  child.unref();
  return { child, logFile };
}
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function portOpen(port, host = '127.0.0.1') {
  return new Promise(done => {
    const socket = net.connect({ port, host });
    const finish = value => { socket.destroy(); done(value); };
    socket.setTimeout(700);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Electron processes that belong to THIS checkout only — never a same-named app elsewhere. */
function ownElectronPids() {
  // PowerShell single-quoted strings treat backslash literally, so the path goes in verbatim.
  // A trailing separator keeps the prefix match from also catching sibling checkouts.
  const prefix = pet.replace(/'/g, "''") + '\\';
  const script = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like '${prefix}*' } | Select-Object -ExpandProperty ProcessId`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return (result.stdout ?? '').split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number);
}

const ENTRIES = {
  real: {
    what: 'Memory Book 桌宠 + 文件后端（真实文字模型；无 SQLite）',
    note: '默认脱离终端启动，不会被中断的终端/agent 连带杀掉；--attach 可改为前台',
    run: runMemoryBook,
  },
  preview: { what: '离线预览桌宠（本地回显，不调模型、不读真实数据）', run: () => run(node, ['tools/dev-desktop.mjs']) },
  console: { what: 'Memory Book 本地管理服务（文件存储；使用已保存模型配置）', run: () => run(node, ['dist/app/book-backend.js'], { env: { ...process.env, AIKI_BOOK_WEB_ONLY: '1' } }) },
  build: { what: '构建：tsc + wechat + 渲染端 bundle（改动 TS/desktop 后必跑）', run: () => run(npm(), ['run', 'build']) || run(npm(), ['run', 'build:desktop']) },
  pin: { what: 'Legacy：把旧 trial 构建登记进 pin（新 Memory Book 不使用）', run: () => run(npm(), ['run', 'refresh:runtime']) },
  status: { what: '查看 Memory Book 文件目录、进程与已保存文字模型', run: runBookStatus },
  stop: { what: '停止本仓库的 Electron 桌宠与后端（不动其他进程）', run: runStop },
  capture: { what: '真实 Electron 屏幕捕获探针（经生产 host bridge，只存 metadata）', run: runCapture },
  ocr: { what: '真实 Windows OCR：中英文 CER + P95 基准（生产 adapter）', run: () => run(node, ['tools/probe-windows-media-ocr-real.mjs']) },
  'ocr:build': { what: '构建 Windows.Media.Ocr native helper（用本地 portable MSVC/SDK）', run: runOcrBuild },
};

function npm() { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }

function list() {
  head('阶段快速入口（tools/quick.mjs）');
  for (const [name, meta] of Object.entries(ENTRIES)) {
    say(`  ${c.green}${name.padEnd(11)}${c.off} ${meta.what}`);
    if (meta.note) say(`  ${' '.repeat(11)} ${c.dim}${meta.note}${c.off}`);
  }
  head('常用组合');
  say(`  npm run quick -- real          ${c.dim}# 起真实桌宠（当前阶段入口）${c.off}`);
  say(`  npm run quick -- status        ${c.dim}# 先看有没有已在跑的${c.off}`);
  say(`  npm run quick -- build && npm run quick -- pin && npm run quick -- real`);
  say(`  npm run quick -- capture       ${c.dim}# 验屏幕捕获通路${c.off}`);
  say(`  npm run quick -- ocr           ${c.dim}# 验 OCR 质量与耗时${c.off}`);
  say('');
}

async function runStatus() {
  head('进程');
  const lock = readJson(paths.lock);
  if (lock && alive(lock.pid)) say(`  backend   ${c.green}alive${c.off} pid=${lock.pid} revision=${String(lock.sourceRevision).slice(0, 8)} startedAt=${lock.startedAt}`);
  else if (lock) say(`  backend   ${c.yellow}stale lock${c.off} pid=${lock.pid}（进程已退出，可安全删除）`);
  else say(`  backend   ${c.dim}not running${c.off}`);
  const pids = ownElectronPids();
  say(`  electron  ${pids.length ? `${c.green}${pids.length} 个${c.off} pid=${pids.join(',')}` : `${c.dim}not running${c.off}`}`);

  head('控制台');
  const session = readJson(paths.session);
  if (session && alive(session.pid)) {
    const origin = new URL(session.url).origin;
    const open = await portOpen(Number(new URL(session.url).port));
    say(`  url       ${session.url}`);
    say(`  port      ${open ? `${c.green}listening${c.off}` : `${c.red}not listening${c.off}`} ${origin} pid=${session.pid}`);
  } else say(`  ${c.dim}no live management session${c.off}`);
  say(`  ${c.dim}whisper.cpp 8080: ${await portOpen(8080) ? 'listening' : 'not listening'}${c.off}`);

  head('runtime pin');
  const plan = await verifyPin();
  if (plan.ok) say(`  ${c.green}consistent${c.off} revision=${plan.version}`);
  else say(`  ${c.red}stale${c.off} ${plan.reason}`);
  say(`  ${c.dim}修复：npm run quick -- pin${c.off}`);

  head('native helper');
  say(`  ${existsSync(paths.ocrHelper) ? `${c.green}built${c.off} ${paths.ocrHelper}` : `${c.yellow}missing${c.off} 跑 npm run quick -- ocr:build`}`);
  say('');
}

/** Verify the pinned runtime matches the working tree, through the real launcher check. */
async function verifyPin() {
  try {
    const { prepareTrialLaunch } = await import(pathToFileURL(join(pet, 'dist/app/trial-launcher.js')).href);
    const plan = await prepareTrialLaunch(windowsRoot, process.execPath, process.env);
    return { ok: true, version: plan.version };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

function runStop() {
  head('停止本仓库桌宠');
  let stopped = 0;
  const lock = readJson(paths.lock);
  if (lock && alive(lock.pid)) {
    say(`  backend pid=${lock.pid} -> terminate`);
    try { process.kill(lock.pid, 'SIGTERM'); stopped++; } catch (error) { say(`  ${c.red}失败:${c.off} ${error.message}`); }
  }
  const pids = ownElectronPids();
  if (pids.length) {
    say(`  electron pid=${pids.join(',')} -> terminate`);
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue`], { windowsHide: true });
    stopped += pids.length;
  }
  if (!stopped) say(`  ${c.dim}没有需要停止的进程${c.off}`);
  else {
    spawnSync(node, ['-e', 'setTimeout(()=>{},1200)'], { windowsHide: true });
    if (existsSync(paths.lock) && !alive(readJson(paths.lock)?.pid ?? 0)) say(`  ${c.dim}提示：backend.lock 是陈旧文件，下次启动会自动覆盖${c.off}`);
  }
  say('');
}

async function runMemoryBook() {
  if (!existsSync(join(pet, 'dist/app/book-launcher.js'))) { say('请先执行 npm run build 和 npm run build:desktop。'); return 1; }
  if (flags.has('--refresh') || flags.has('--pin')) say('Memory Book 不使用旧 trial pin；此参数不再修改旧配置。');
  if (flags.has('--attach')) return run(node, ['dist/app/book-launcher.js']);
  const { child, logFile } = launchDetached(node, ['dist/app/book-launcher.js']);
  say(`Memory Book 已启动（launcher pid=${child.pid}）；日志：${logFile}。从桌宠菜单打开管理。`);
  return 0;
}

function runBookStatus() {
  const directory = resolve(process.env.AIKI_BOOK_DATA ?? join(windowsRoot, '.local/memory-book'));
  const runtimeFile = join(directory, 'runtime.json'), sessionFile = join(directory, 'management-session.json');
  const config = existsSync(runtimeFile) ? JSON.parse(readFileSync(runtimeFile, 'utf8')).data : null;
  const session = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : null;
  say(`Memory Book 数据目录：${directory}`);
  say(`后端：${session?.pid && alive(session.pid) ? '运行中，pid=' + session.pid : '未运行'}`);
  say(`主模型：${config?.mainModel?.model ?? '未绑定'}；Fast LLM：${config?.fastModel?.model ?? '未绑定'}`);
  say('从桌宠「打开管理」进入聊天 / Memory Book / 设置；管理 token 不写入终端。');
  return 0;
}

async function runReal() {
  if (flags.has('--refresh') || flags.has('--pin')) {
    head('先刷新 runtime pin');
    if (run(npm(), ['run', 'refresh:runtime'])) { say(`${c.red}pin 刷新失败，已中止${c.off}`); return 1; }
  }
  const plan = await verifyPin();
  if (!plan.ok) {
    head('无法启动真实桌宠');
    say(`  ${c.red}${plan.reason}${c.off}`);
    say(`  ${c.dim}原因通常是构建后 runtime pin 未同步。修复：${c.off}`);
    say(`  npm run quick -- pin`);
    say(`  ${c.dim}或一步到位：npm run quick -- real --refresh${c.off}`);
    return 1;
  }
  head(`启动真实桌宠 revision=${plan.version.slice(0, 8)}`);
  say(`  ${c.dim}生产后端 dist/app/trial-backend.js；会真实调用已登记 provider 并计费${c.off}`);
  // A session file from a PREVIOUS run can still be on disk with a live-looking pid. Announcing it would
  // print a dead URL, so remember what was there and only report a session this launch actually created.
  const previousSession = readJson(paths.session);
  const launchStartedAt = Date.now();
  // `--attach` keeps the pet in this terminal (handy when you want its live stdout and Ctrl+C semantics).
  // The default is detached, so an interrupted terminal or agent turn can never take the pet down with it.
  const attach = flags.has('--attach');
  const launched = attach
    ? { child: launch(node, ['tools/dev-desktop-real.mjs']), logFile: null }
    : launchDetached(node, ['tools/dev-desktop-real.mjs']);
  const child = launched.child;
  // The console URL only exists once the backend has opened its management server.
  let announced = false;
  const timer = setInterval(() => {
    if (announced) return;
    const session = readJson(paths.session);
    if (!session || !alive(session.pid)) return;
    const isPrevious = previousSession && session.pid === previousSession.pid && session.url === previousSession.url;
    const isStale = (statSync(paths.session)?.mtimeMs ?? 0) < launchStartedAt;
    if (isPrevious || isStale) return;
    announced = true;
    say(`\n${c.green}控制台${c.off} ${session.url}`);
    if (launched.logFile) say(`${c.dim}桌宠已脱离本终端（pid=${session.pid}）；日志：${launched.logFile}${c.off}`);
    say(`${c.dim}停止：npm run quick -- stop${c.off}\n`);
  }, 1000);
  timer.unref?.();
  if (!attach) {
    // Detached: report as soon as we have the URL, then exit — the pet outlives this command.
    // The deadline timer stays REF'd on purpose: it is what keeps this short-lived launcher alive while
    // the pet boots. Unref'ing it would empty the event loop and exit before the URL is ever seen.
    return new Promise(resolve => {
      const deadline = setTimeout(() => { clearInterval(timer); resolve(0); }, 180_000);
      const check = setInterval(() => { if (announced) { clearInterval(check); clearTimeout(deadline); resolve(0); } }, 500);
      check.unref?.();
      child.once('error', () => { clearInterval(timer); clearTimeout(deadline); resolve(1); });
    });
  }
  const finish = code => { clearInterval(timer); process.exit(code ?? 0); };
  child.once('exit', finish);
  child.once('error', () => finish(1));
  return undefined; // foreground: the child owns the terminal until it exits
}

function runCapture() {
  if (!existsSync(paths.electron)) { say(`${c.red}缺少 electron${c.off}`); return 1; }
  say(`${c.dim}真实捕获需要 --allow-capture；像素只用于本地核验，evidence 仅写 metadata${c.off}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return run(paths.electron, ['tools/probe-desktop-capture.mjs', '--no-sandbox', '--allow-capture'], { env });
}

function runOcrBuild() {
  if (!paths.vcvars) {
    say(`${c.yellow}未设置 AIKI_VCVARS：此入口 BLOCKED${c.off}`);
    say(`  ${c.dim}本 helper 需要 MSVC + Windows SDK，请先指向本机的 vcvars64.bat：${c.off}`);
    say(`  ${c.dim}$env:AIKI_VCVARS = '<你的 VS 目录>\\VC\\Auxiliary\\Build\\vcvars64.bat'${c.off}`);
    say(`  ${c.dim}不要改用 clang，也不要把个人路径写回仓库。${c.off}`);
    return 1;
  }
  if (!existsSync(paths.vcvars)) {
    say(`${c.yellow}AIKI_VCVARS 指向的 vcvars64.bat 不存在：${paths.vcvars}${c.off}`);
    say(`  ${c.dim}本机工具链未安装时此项为 BLOCKED；不要改用 clang，本 helper 需要 MSVC + Windows SDK${c.off}`);
    return 1;
  }
  const portableRoot = resolve(paths.vcvars, '../../..');
  say(`${c.dim}VSINSTALLDIR=${portableRoot}${c.off}`);
  return run(node, ['tools/build-windows-media-ocr.mjs'], { env: { ...process.env, VSINSTALLDIR: portableRoot } });
}

if (entry === 'list' || entry === 'help' || entry === '--help') { list(); process.exit(0); }
const chosen = ENTRIES[entry];
if (!chosen) {
  say(`${c.red}未知入口：${entry}${c.off}`);
  list();
  process.exit(2);
}
const code = await chosen.run();
if (typeof code === 'number') process.exit(code);

#!/usr/bin/env node
/**
 * ChatGPT web login/probe entry (RPD_CHAT_WIKI OAuth node, CW-03).
 *
 * Usage (from windows/code/desktop-pet, after `npm run build`):
 *   node tools/chatgpt-web-login.mjs                # relay into the user's running Chrome
 *   node tools/chatgpt-web-login.mjs --launch       # standalone fresh window (first-time login)
 *   node tools/chatgpt-web-login.mjs --status       # print chrome-use status, no page open
 *   Optional: --profile <name> --session <name> --bin-dir <dir> --timeout <seconds>
 *
 * The probe/login logic is the PRODUCTION bridge (dist/providers/chatgpt-web-bridge.js),
 * not a copy: what this script proves is exactly what the backend will use. The user
 * completes the ChatGPT login in their own browser; this script never sees credentials.
 *
 * Exit codes: 0 signed-in; 3 tools missing; 4 timeout; 5 session unavailable.
 */

import { spawn } from 'node:child_process';
import { ChatgptToolMissingError, ChatgptWebBridge, createNodeToolRunner } from '../dist/providers/chatgpt-web-bridge.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../dist/contracts/memory-book.js';

const rawArgs = process.argv.slice(2);
const value = name => {
  const index = rawArgs.indexOf(`--${name}`);
  return index >= 0 && rawArgs[index + 1] && !rawArgs[index + 1].startsWith('--') ? rawArgs[index + 1] : null;
};
const config = {
  ...DEFAULT_CHATGPT_WEB_SOURCE,
  ...(value('profile') ? { profile: value('profile') } : {}),
  ...(value('session') ? { session: value('session') } : {}),
  ...(value('bin-dir') ? { binDir: value('bin-dir') } : {}),
};
const TIMEOUT_SEC = Number(value('timeout') ?? 600);
const LAUNCH = rawArgs.includes('--launch');
const STATUS_ONLY = rawArgs.includes('--status');

const INSTALL_HINT = `
未找到 chrome-use / chatgpt-use。请先安装（官方脚本）：
  Windows PowerShell:
    irm https://raw.githubusercontent.com/leeguooooo/chrome-use/main/install.ps1 | iex
    irm https://raw.githubusercontent.com/leeguooooo/chatgpt-use/main/install.ps1 | iex
  macOS / Linux:
    curl -fsSL https://raw.githubusercontent.com/leeguooooo/chrome-use/main/install.sh | sh
    curl -fsSL https://raw.githubusercontent.com/leeguooooo/chatgpt-use/main/install.sh | sh

安装后重开终端再运行本脚本（或用 --bin-dir 指向安装目录）。`;

function chromeStatus() {
  return new Promise(resolve => {
    const child = spawn('chrome-use', ['status'], { shell: false, windowsHide: true, ...(process.platform === 'win32' ? {} : {}) });
    let out = '';
    child.stdout?.on('data', chunk => { out += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out.trim() || null));
  });
}

const bridge = new ChatgptWebBridge({ runner: createNodeToolRunner(), config: () => config });

async function main() {
  console.log(`[login] ChatGPT 网页来源：profile=${config.profile}，session=${config.session}${config.binDir ? `，binDir=${config.binDir}` : ''}`);
  if (STATUS_ONLY) {
    const status = await chromeStatus();
    console.log(status ?? '（chrome-use status 无输出或不可用）');
    process.exit(0);
  }

  let probe = await bridge.probe();
  if (probe.state === 'tool-missing') {
    console.error(INSTALL_HINT);
    process.exit(3);
  }

  console.log(`[probe] ${probe.state}${probe.detail ? ` — ${probe.detail}` : ''}`);
  console.log(LAUNCH
    ? '[login] 打开独立浏览器窗口；请在其中登录 ChatGPT（账号密码/Google/Apple 均可）。'
    : '[login] 将在你的 Chrome 中打开 chatgpt.com；若未登录，请在浏览器完成登录。');
  try {
    await bridge.openLoginPage({ ...(LAUNCH ? { standalone: true } : {}) });
  } catch (error) {
    console.error(`[login] 打开失败：${error instanceof ChatgptToolMissingError ? 'chrome-use 未安装' : error instanceof Error ? error.message : String(error)}`);
    console.error('[login] 提示：连接现有 Chrome 需先执行一次 `chrome-use extension install`；或改用 --launch 独立窗口。');
    process.exit(5);
  }

  console.log(`[login] 每 2 秒探测登录状态，最长 ${TIMEOUT_SEC} 秒；Ctrl+C 退出。`);
  const deadline = Date.now() + TIMEOUT_SEC * 1000;
  let lastLine = '';
  for (;;) {
    if (Date.now() > deadline) {
      console.error(`[login] 超时（${TIMEOUT_SEC}s）仍未检测到登录态；可用 --timeout <秒> 延长。`);
      process.exit(4);
    }
    probe = await bridge.probe();
    const line = `[probe] ${probe.state}${probe.detail ? ` — ${probe.detail}` : ''}`;
    if (line !== lastLine) { console.log(line); lastLine = line; }
    if (probe.state === 'signed-in') {
      console.log('[login] ✓ ChatGPT 已登录。回到对话继续下一步（真实回复样本/设置授权）。');
      process.exit(0);
    }
    if (probe.state === 'tool-missing') { console.error(INSTALL_HINT); process.exit(3); }
    if (probe.state === 'not-connected') {
      console.error('[login] 会话不可用：先运行 `node tools/chatgpt-web-login.mjs --status` 查看 chrome-use 状态。');
      process.exit(5);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main().catch(error => {
  console.error(`[login] 未预期错误：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});

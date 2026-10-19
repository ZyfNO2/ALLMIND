/**
 * DUX-06 · 清除旧产品命名（目标断言）。
 *
 * 失败证据（DUX-00 §3 第 6 行 + §4 扫描）：app.setName/窗口 title/partition/菜单、index.html
 * title/aria、trial-launcher 提示、MCP serverInfo 与 clientInfo、URL/ACL helper 环境变量
 * 全部仍是 AAAAGENT/AIKI/aaaagent。（RUX-04 后 index.html 不再有 loading 节点：加载期不显示任何文案。）
 *
 * 目标（[DUX-06 SPEC](../../docs/next/ui-rework/specs/DUX-06.md) / [DUX_CONTRACTS §5](../../docs/next/ui-rework/DUX_CONTRACTS.md)）：
 *   产品名 **Aika**；MCP 自报 `aika-confirmed-relay` / clientInfo `aika-windows`；
 *   partition `aika-desktop`；环境变量 `AIKA_OPEN_URL / AIKA_ACL_PATH / AIKA_ACL_ACTION`（双端同改）。
 *
 * 合法例外（保留）：`core/next-namespace.ts` 的 `LEGACY_DATA_ROOT='AAAAGENT'`（旧库隔离保护）、
 * 测试专用 mkdtemp 目录名与 `AIKI_HARU_SOURCE` 测试变量（非产品可见）、`tools/eval-report.mjs`
 * 历史评测报告标题（文档名，见报告例外清单）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = p => readFileSync(resolve(import.meta.dirname, p), 'utf8');

test('DUX-06 主进程/托盘/页面产品名统一 Aika', () => {
  const main = read('../../desktop/electron/main.mjs');
  assert.match(main, /app\.setName\('Aika'\)/, 'app.setName 必须是 Aika');
  assert.match(main, /partition: 'aika-desktop'/, '临时 partition 必须是 aika-desktop');
  assert.match(main, /title: preview \? 'Aika · Offline preview' : 'Aika'/, '窗口标题必须是 Aika');
  assert.doesNotMatch(main, /AAAAGENT/, 'main.mjs 不得再有 AAAAGENT');
  const html = read('../../desktop/index.html');
  assert.match(html, /<title>Aika<\/title>/, '页面 title 必须是 Aika');
  assert.match(html, /aria-label="Aika桌宠/, 'canvas aria-label 必须是 Aika桌宠');
  // RUX-04（用户指令）：加载期不显示任何文案，loading 节点整个移除，不再有 loading 文案命名面。
  assert.doesNotMatch(html, /id="loading"/, 'index.html 不得再有 loading 节点（加载期什么都不显示）');
  assert.doesNotMatch(html, /AAAAGENT/, 'index.html 不得再有 AAAAGENT');
  const launcher = read('../../app/trial-launcher.ts');
  assert.match(launcher, /正在启动Aika /, '启动提示必须是 Aika');
  assert.match(launcher, /「收起到系统托盘」/, '启动提示指引显式收起（DUX-01 后 close=退出）');
  assert.doesNotMatch(launcher, /AAAAGENT|AIKI/, 'trial-launcher 不得再有旧名');
});

test('DUX-06 MCP 自报身份：serverInfo aika-confirmed-relay、clientInfo aika-windows', () => {
  const relay = read('../../tools/harness-relay-mcp.mjs');
  assert.match(relay, /serverInfo: \{ name: 'aika-confirmed-relay'/, 'MCP serverInfo 必须是 aika-confirmed-relay');
  assert.doesNotMatch(relay, /aaaagent/i, 'relay 不得再有 aaaagent 自报');
  const codex = read('../../harness/codex-windows.ts');
  assert.match(codex, /clientInfo: \{ name: 'aika_windows', title: 'Aika Windows'/, 'MCP clientInfo 必须是 aika_windows/Aika Windows');
  assert.doesNotMatch(codex, /aaaagent/i, 'codex-windows 不得再有 aaaagent 自报');
});

test('DUX-06 helper 环境变量双端改 AIKA_*（producer 与 PowerShell 读取方一致）', () => {
  const openUrl = read('../../core/open-url.ts');
  assert.match(openUrl, /\$env:AIKA_OPEN_URL/, 'PowerShell 读取方必须是 AIKA_OPEN_URL');
  assert.match(openUrl, /AIKA_OPEN_URL: url\.href/, 'producer 必须写 AIKA_OPEN_URL');
  assert.doesNotMatch(openUrl, /AAAAGENT/, 'open-url 不得再有旧变量');
  const files = read('../../core/platform-files.ts');
  assert.match(files, /\$env:AIKA_ACL_PATH/, 'PowerShell 读取方必须是 AIKA_ACL_PATH');
  assert.match(files, /\$env:AIKA_ACL_ACTION/, 'PowerShell 读取方必须是 AIKA_ACL_ACTION');
  assert.match(files, /AIKA_ACL_PATH: resolve\(filename\), AIKA_ACL_ACTION: action/, 'producer 必须写 AIKA_*');
  assert.doesNotMatch(files, /AAAAGENT/, 'platform-files 不得再有旧变量');
});

test('DUX-06 合法例外保留：LEGACY_DATA_ROOT 与 userData 根不变', () => {
  const ns = read('../../core/next-namespace.ts');
  assert.match(ns, /LEGACY_DATA_ROOT = 'AAAAGENT'/, '旧库隔离例外必须保留');
  const main = read('../../desktop/electron/main.mjs');
  // userData 根仍是 AikaNext 命名空间（不因 setName 重新搬库）。
  assert.match(main, /nextUserDataDir\(app\.getPath\('appData'\), preview \? 'preview' : 'desktop'\)/, 'userData 设置时序与根不变');
});

test('DUX-06 行为：helper 继续工作（隔离 PowerShell 探针走新变量名）', async t => {
  const { isPrivateFileSync, restrictPrivatePathSync } = await import('../../dist/core/platform-files.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'aika-acl-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'secret.txt');
  await writeFile(file, 'synthetic');
  // 真实 PowerShell 子进程走新 AIKA_* 变量完成 restrict + check（producer 与读取方一致的端到端证据）。
  restrictPrivatePathSync(file);
  assert.equal(isPrivateFileSync(file), true, '新变量名下 ACL 检查必须照常工作');
});

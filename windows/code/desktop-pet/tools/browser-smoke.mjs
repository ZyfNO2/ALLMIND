#!/usr/bin/env node
// RWR-07 infra: minimal Playwright chromium smoke (launch -> newPage -> goto about:blank -> close).
//
// Problem this script exists for:
//   playwright 1.63.0 advertises chromium-1243 (chromium.executablePath()), but this machine only
//   has chromium-1217 / 1223 / 1228 installed. Default launch therefore fails with
//   "Executable doesn't exist at ...chromium-1243...".
//
// Resolution strategy (in order):
//   1. default launch (whatever playwright resolves)
//   2. every chromium-*/chrome-win64/chrome.exe found under %LOCALAPPDATA%/ms-playwright
//   3. every chromium_headless_shell-*/.../headless_shell.exe found under the same root
//
// Usage:
//   node tools/browser-smoke.mjs                 # auto-resolve, print the winner
//   node tools/browser-smoke.mjs --exec "C:\\...\\chrome.exe"
//   node tools/browser-smoke.mjs --list          # only list candidates, do not launch
//
// Env:
//   AIKA_CHROME_EXEC  forces a single executable (equivalent to --exec)
//
// Exit code: 0 = a working launch path was found and smoke passed, 1 = none worked.

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright');

function collect() {
  const out = [];
  if (!existsSync(ROOT)) return out;
  let dirs = [];
  try {
    dirs = readdirSync(ROOT);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const base = path.join(ROOT, dir);
    if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) continue;
    const rel = dir.startsWith('chromium_headless_shell-')
      ? ['chrome-win', 'headless_shell.exe']
      : dir.startsWith('chromium-')
        ? ['chrome-win64', 'chrome.exe']
        : null;
    if (!rel) continue;
    const exe = path.join(base, ...rel);
    if (existsSync(exe)) out.push({ tag: dir, exe, headlessShell: dir.startsWith('chromium_headless_shell-') });
  }
  // newest version first (numeric suffix desc), headless shell after full chromium
  out.sort((a, b) => {
    const na = Number((a.tag.match(/-(\d+)$/) || [0, 0])[1]);
    const nb = Number((b.tag.match(/-(\d+)$/) || [0, 0])[1]);
    if (na !== nb) return nb - na;
    return Number(a.headlessShell) - Number(b.headlessShell);
  });
  return out;
}

async function tryLaunch(exe) {
  const opts = { timeout: 30000 };
  if (exe) opts.executablePath = exe;
  const browser = await chromium.launch(opts);
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const title = await page.title();
    return { ok: true, version: browser.version(), title };
  } finally {
    await browser.close();
  }
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const forced = (() => {
  const i = args.indexOf('--exec');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return process.env.AIKA_CHROME_EXEC || null;
})();

const candidates = forced ? [{ tag: 'forced', exe: forced, headlessShell: false }] : [{ tag: 'default(playwright resolved)', exe: null, headlessShell: false }, ...collect()];

if (listOnly) {
  console.log('candidates:');
  for (const c of candidates) console.log(`  - ${c.tag}: ${c.exe ?? '(playwright default)'}`);
  process.exit(0);
}

console.log(`playwright default executablePath: ${chromium.executablePath()}`);
console.log(`browsers root: ${ROOT}`);
console.log('');

for (const c of candidates) {
  const label = `${c.tag} -> ${c.exe ?? '(default)'}`;
  try {
    const r = await tryLaunch(c.exe);
    console.log(`PASS  ${label}`);
    console.log(`      browser version: ${r.version}`);
    console.log('');
    console.log('WORKING_LAUNCH_JSON=' + JSON.stringify({ executablePath: c.exe, version: r.version, tag: c.tag }));
    process.exit(0);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).split('\n').filter(Boolean);
    console.log(`FAIL  ${label}`);
    for (const line of msg.slice(0, 4)) console.log(`      ${line}`);
    console.log('');
  }
}

console.log('RESULT=NO_WORKING_CHROMIUM');
process.exit(1);

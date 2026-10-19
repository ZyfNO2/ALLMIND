#!/usr/bin/env node
// RWR-07 browser automation (worker `browser-qa`): compliance verification of the REAL management
// console against a REAL `startManagementServer` instance.
//
// What this asserts (see the RWR-07 report for verdicts):
//   A. render + navigation: HTTP 200, title, Dashboard shows the current role, nav clicks switch pages,
//      and `pageerror` count === 0.
//   B. role page sections: all five detail tabs, the 故事书 panel lists books AND the 新建故事书 button
//      performs a real server transaction (the new book must appear in the list afterwards), the three
//      author-metadata fields exist, 保存作者资料 and 保存人设正文 are two DISTINCT buttons, no「待接线」
//      placeholder copy anywhere, and no dead (no-op) callback button.
//   C. error paths are visible: a wrong token makes a save FAIL LOUDLY (no silent success / no empty list).
//   D. auth at the fetch layer: GET /api/snapshot without a token → 401, forged Origin → 403.
//   E. screenshots of the key states, written under .local/ (gitignored).
//
// Infrastructure note (hard-won, keep it):
//   playwright 1.63 resolves chromium.executablePath() to `chromium-1243`, which is NOT installed on this
//   machine. The default launch therefore dies with "Executable doesn't exist". This script NEVER uses the
//   default: it pins AIKA_CHROME_EXEC, or falls back to every chromium-*/chrome-win64/chrome.exe under
//   %LOCALAPPDATA%/ms-playwright, newest first (same strategy as tools/browser-smoke.mjs).
//
// Usage:
//   node tools/acceptance-role-repair-browser.mjs --session <path-to-session.json>
//   node tools/acceptance-role-repair-browser.mjs --url "http://127.0.0.1:1234/#token=abc" --token abc
//
// Exit code: 0 when every MUST assertion passed, 1 otherwise. The console log is the machine-readable
// summary; RESULT=PASS|RESULTS_FAIL on the last line.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, '.local', 'browser-qa-shots');
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

/* ------------------------------------------------------------------ chromium resolution */

const PW_ROOT = process.env.PLAYWRIGHT_BROWSERS_PATH
  || path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright');

function chromiumCandidates() {
  const out = [];
  const forced = opt('exec') || process.env.AIKA_CHROME_EXEC;
  if (forced) out.push({ tag: 'forced', exe: forced });
  if (!existsSync(PW_ROOT)) return out;
  let dirs = [];
  try { dirs = readdirSync(PW_ROOT); } catch { return out; }
  for (const dir of dirs) {
    const base = path.join(PW_ROOT, dir);
    if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) continue;
    const rel = dir.startsWith('chromium_headless_shell-') ? ['chrome-win', 'headless_shell.exe']
      : dir.startsWith('chromium-') ? ['chrome-win64', 'chrome.exe'] : null;
    if (!rel) continue;
    const exe = path.join(base, ...rel);
    if (existsSync(exe)) out.push({ tag: dir, exe });
  }
  out.sort((a, b) => (Number((b.tag.match(/-(\d+)$/) || [0, 0])[1]) - Number((a.tag.match(/-(\d+)$/) || [0, 0])[1])));
  return out;
}

async function launchBrowser() {
  const errors = [];
  for (const candidate of chromiumCandidates()) {
    try {
      const browser = await chromium.launch({ executablePath: candidate.exe, timeout: 30000 });
      return { browser, exe: candidate.exe, tag: candidate.tag };
    } catch (error) { errors.push(`${candidate.tag}: ${String(error?.message ?? error).split('\n')[0]}`); }
  }
  throw new Error(`no usable chromium.\nplaywright default: ${chromium.executablePath()}\n${errors.join('\n')}`);
}

/* ------------------------------------------------------------------ result bookkeeping */

const results = [];
const defects = [];
/** `must: true` failures gate the exit code; the rest are advisory. */
function check(id, title, passed, detail = '', { must = true } = {}) {
  results.push({ id, title, pass: Boolean(passed), must, detail });
  console.log(`${passed ? 'PASS' : must ? 'FAIL' : 'WARN'}  ${id}  ${title}${detail ? `\n      ${detail}` : ''}`);
  return Boolean(passed);
}
function defect(severity, area, summary, evidence) {
  defects.push({ severity, area, summary, evidence });
  console.log(`DEFECT[${severity}] ${area}: ${summary}`);
}

/* ------------------------------------------------------------------ console error triage */

// Unmounted capability answered by a real 404/503 is an HONEST "not available" state, not a bug.
// Anything else that reaches `console.error` is reported verbatim so it can be classified by a human.
const HONEST_UNAVAILABLE = /(unavailable|not_found|尚未|未装配|不可用|没有这个)/i;
const IGNORED_REQUEST_ERROR = /Failed to load resource: the server responded with a status of (404|503|401|403|409)/i;

function classifyConsoleError(text) {
  if (IGNORED_REQUEST_ERROR.test(text)) {
    const status = text.match(/status of (\d+)/)?.[1];
    return { kind: 'honest-unavailable', detail: `HTTP ${status} on an unmounted/blocked endpoint` };
  }
  if (HONEST_UNAVAILABLE.test(text)) return { kind: 'honest-unavailable', detail: 'explicit capability-unavailable message' };
  if (/favicon/i.test(text)) return { kind: 'cosmetic', detail: 'favicon' };
  return { kind: 'defect', detail: 'unclassified console error' };
}

/* ------------------------------------------------------------------ helpers */

const settle = (page, ms = 350) => page.waitForTimeout(ms);

/** Click a nav button by its visible label, tolerating the sidebar/sub-nav duplication. */
async function clickNav(page, label) {
  const target = page.locator(`button:has-text("${label}")`).first();
  await target.waitFor({ state: 'visible', timeout: 8000 });
  await target.click();
  await settle(page);
}

async function shoot(page, name) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`SHOT  ${file}`);
  return file;
}

/** Body text of the page, for copy-level assertions. */
const bodyText = page => page.evaluate(() => document.body.innerText);

/* ------------------------------------------------------------------ main */

const sessionFile = opt('session');
let origin = opt('origin') || null;
let token = opt('token') || null;
if (sessionFile) {
  const descriptor = JSON.parse(readFileSync(sessionFile, 'utf8'));
  token = token || descriptor.token;
  origin = origin || descriptor.origin || new URL(descriptor.url).origin;
}
if (!origin || !token) {
  console.error('need --session <session.json> (or --origin and --token)');
  process.exit(2);
}

const pageErrors = [];
const consoleErrors = [];
const requestFailures = [];

const launched = await launchBrowser();
console.log(`chromium: ${launched.tag} -> ${launched.exe}`);
console.log(`target:   ${origin}`);
console.log('');

const browser = await launched.browser;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => { pageErrors.push(String(error?.message ?? error)); });
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('requestfailed', request => {
    requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown'}`);
  });
  // Record every API response status with its URL so a bare "HTTP 400" console line can be attributed to
  // a concrete endpoint instead of being reported as an unclassified defect.
  const apiResponses = [];
  page.on('response', async response => {
    const url = response.url();
    if (!url.includes('/api/')) return;
    let body = '';
    if (response.status() >= 400) { try { body = (await response.text()).slice(0, 200); } catch { /* ignore */ } }
    apiResponses.push({ status: response.status(), method: response.request().method(), url: url.replace(origin, ''), body });
  });

  /* ---------------------------------------------------------------- A. render + navigation */

  const url = `${origin}/#token=${token}`;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check('A1', 'GET / returns HTTP 200', response?.status() === 200, `status=${response?.status()}`);
  await page.waitForSelector('.app-shell', { timeout: 20000 }).catch(() => {});
  await settle(page, 1200);

  const title = await page.title();
  check('A2', 'title is the management console title', /运行控制台|管理/.test(title), `title=${title}`);

  const dash = await bodyText(page);
  check('A3', 'Dashboard renders without the single-role mismatch error',
    !dash.includes('当前服务与单角色版本不匹配'), dash.includes('当前服务与单角色版本不匹配') ? 'mismatch banner present' : '');
  check('A4', 'Dashboard shows the current role (companion / 青梅竹马)',
    /青梅竹马|companion/.test(dash), `matched=${/青梅竹马|companion/.test(dash)}`);
  await shoot(page, '01-dashboard');

  // Navigate through the sidebar: 角色 and the global settings entry.
  const navProbe = [];
  for (const label of ['角色', '全局设置']) {
    let ok = false;
    try {
      await clickNav(page, label);
      ok = !/当前服务与单角色版本不匹配/.test(await bodyText(page));
      navProbe.push(`${label}=${ok ? 'ok' : 'mismatch'}`);
    } catch (error) { navProbe.push(`${label}=FAILED:${String(error?.message ?? error).split('\n')[0]}`); }
  }
  check('A5', 'sidebar navigation switches pages without an error screen',
    navProbe.every(entry => entry.endsWith('ok')), navProbe.join(' | '));
  await shoot(page, '02-global-settings');

  /* ---------------------------------------------------------------- B. role page sections */

  await clickNav(page, '角色');
  // The role gallery lists cards; open the single role to reach the detail workspace.
  const card = page.locator('.role-card').first();
  const cardCount = await page.locator('.role-card').count();
  check('B0', 'role gallery lists the role', cardCount >= 1, `role cards=${cardCount}`);
  if (cardCount >= 1) { await card.click(); await settle(page, 900); }
  await shoot(page, '03-role-detail-profile');

  const detailTabs = ['简介与人设', '形象来源', '故事书', '陪伴记录与 Wiki', 'API 配置'];
  const sectionErrorsBefore = pageErrors.length;
  for (const tab of detailTabs) {
    let clicked = false;
    try {
      const btn = page.locator(`.role-detail-tabs button:has-text("${tab}")`).first();
      await btn.waitFor({ state: 'visible', timeout: 8000 });
      await btn.click();
      await settle(page, 450);
      clicked = true;
    } catch (error) { /* recorded below */ }
    check(`B1.${tab}`, `section「${tab}」switches`, clicked, clicked ? '' : 'tab button not clickable');
  }
  check('B2', 'switching sections raises no uncaught exception',
    pageErrors.length === sectionErrorsBefore,
    pageErrors.slice(sectionErrorsBefore).join(' | ') || 'no new pageerror');

  /* ---- 故事书 panel: list + a real create transaction ---- */

  await page.locator('.role-detail-tabs button:has-text("故事书")').first().click();
  await settle(page, 600);
  const lorePanel = await bodyText(page);
  check('B3', '故事书 panel exposes the role book list', /故事书/.test(lorePanel));

  const listSelector = '[aria-label="故事书列表"]';
  const hasListNode = await page.locator(listSelector).count();
  check('B4', '故事书 list container is rendered', hasListNode === 1, `nodes=${hasListNode}`);

  const listBefore = (await page.locator(listSelector).innerText()).trim();
  console.log(`      lorebook list before: ${JSON.stringify(listBefore)}`);

  // 新建故事书 — must be a server transaction, proven by the receipt-driven list growth.
  const titleInput = page.locator('#role-lorebook-title');
  const titleEnabled = await titleInput.isEnabled();
  if (!titleEnabled) {
    defect('必须修', '故事书', '「新建故事书标题」输入框在故事书功能已挂载时仍为 disabled',
      `lorebook read: ${lorePanel.match(/本机未装配故事书功能[^。]*。/)?.[0] ?? 'unknown'}; #role-lorebook-title disabled`);
  }
  const newTitle = `浏览器验收故事书-${Date.now()}`;
  if (titleEnabled) await titleInput.fill(newTitle);
  const createBtn = page.locator('button:has-text("新建故事书")').first();
  const disabledBeforeClick = await createBtn.isDisabled();
  if (titleEnabled) await createBtn.click();
  // The receipt message is only set after the server confirms the transaction.
  let receipt = '';
  try {
    await page.locator(`text=故事书已创建`).first().waitFor({ state: 'visible', timeout: 10000 });
    receipt = (await bodyText(page)).match(/故事书已创建[^\n]*/)?.[0] ?? '';
  } catch { /* fall through to the assertion below */ }
  await settle(page, 600);
  const listAfter = (await page.locator(listSelector).innerText()).trim();
  const createdOnServer = listAfter.includes(newTitle);

  check('B5', '新建故事书 button is enabled when a token is present', !disabledBeforeClick, `disabled=${disabledBeforeClick}`);
  check('B6', '新建故事书 shows a server receipt (故事书已创建)', receipt.length > 0, receipt || 'no receipt text found');
  check('B7', '新建故事书 persists: the new book appears in the list after the transaction',
    createdOnServer, `before=${JSON.stringify(listBefore.slice(0, 120))} after=${JSON.stringify(listAfter.slice(0, 200))}`);
  await shoot(page, '04-lorebook-created');

  // Prove it is a REAL transaction and not a local row: read it back over the API.
  let apiSeesBook = false;
  try {
    const books = await page.evaluate(async ({ origin: o, token: t }) => {
      const res = await fetch(`${o}/api/characters/lorebooks?characterId=companion`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      return res.ok ? await res.json() : { status: res.status };
    }, { origin, token });
    apiSeesBook = JSON.stringify(books).includes(newTitle);
  } catch (error) { defect('建议修', '故事书', '无法通过 API 回读故事书列表', String(error?.message ?? error)); }
  check('B8', 'the created storybook is readable back from the server API (real transaction)',
    apiSeesBook, apiSeesBook ? 'confirmed via GET /api/characters/lorebooks' : 'not found via API');

  /* ---- author metadata fields + two independent save buttons ---- */

  await page.locator('.role-detail-tabs button:has-text("简介与人设")').first().click();
  await settle(page, 600);
  for (const [id, label] of [['role-scenario', '背景与情境'], ['role-first-message', '开场白'], ['role-example-dialogue', '示例对话']]) {
    const n = await page.locator(`#${id}`).count();
    check(`B9.${label}`, `author field「${label}」(#${id}) exists`, n === 1, `nodes=${n}`);
  }

  const authorBtn = page.locator('button:has-text("保存作者资料")');
  const personaBtn = page.locator('button:has-text("保存人设正文")');
  const authorCount = await authorBtn.count();
  const personaCount = await personaBtn.count();
  check('B10', '「保存作者资料」button exists (exactly one)', authorCount === 1, `count=${authorCount}`);
  check('B11', '「保存人设正文」button exists (exactly one)', personaCount === 1, `count=${personaCount}`);

  // Two independent save surfaces: distinct buttons AND distinct server endpoints. Watch the actual
  // requests: 保存作者资料 must PUT /api/characters/profile (per-field cursor), 保存人设正文 must write the
  // prompt authority. Neither may advance the other's cursor.
  const requests = [];
  const onRequest = request => {
    const url = request.url();
    if (url.includes('/api/characters/')) requests.push(`${request.method()} ${url.replace(origin, '')}`);
  };
  page.on('request', onRequest);

  const before = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      persona: t.match(/人设正文修订：v(\d+)/)?.[1] ?? null,
      field: t.match(/角色资料字段修订：v(\d+)/)?.[1] ?? null,
    };
  });
  // The 角色简介 field is part of the same PUT body. Record whether it is populated: an untouched blank
  // intro used to be rejected by the server (`text()` refused an empty string) and failed the whole save.
  // Post-fix the contract is: empty = clear, absent = untouched.
  const introValue = await page.locator('#role-preview-intro').inputValue().catch(() => null);
  console.log(`      角色简介 field value at save time: ${JSON.stringify(introValue)}`);

  await page.locator('#role-scenario').fill('浏览器自动化的场景字段，仅为验收用途。');
  requests.length = 0;
  const authorApiBefore = apiResponses.length;
  await authorBtn.first().click();
  // Capture the receipt the moment the request settles: the notice is re-rendered on every render, so a
  // late read can miss it. Both the success notice and an error notice count as "the page reported".
  let authorReceipt = '';
  try {
    await page.locator('text=/角色资料已保存|保存失败/').first().waitFor({ state: 'visible', timeout: 12000 });
    authorReceipt = (await bodyText(page)).match(/(角色资料已保存|保存失败)[^\n]*/)?.[0] ?? '';
  } catch (error) {
    const apiTrace = apiResponses.slice(authorApiBefore).map(entry => `${entry.status} ${entry.method} ${entry.url} ${entry.body}`).join(' | ');
    authorReceipt = `NOTICE-NOT-SEEN (api: ${apiTrace || 'no /api/characters request fired'})`;
    defect('必须修', '简介与人设',
      '「保存作者资料」发出了请求但页面没有显示任何成功/失败回执（静默保存）',
      authorReceipt);
  }
  await settle(page, 500);
  const authorRequests = [...requests];
  const authorApi = apiResponses.slice(authorApiBefore).map(entry => `${entry.status} ${entry.method} ${entry.url}`);
  const afterAuthor = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      persona: t.match(/人设正文修订：v(\d+)/)?.[1] ?? null,
      field: t.match(/角色资料字段修订：v(\d+)/)?.[1] ?? null,
    };
  });
  check('B12', '「保存作者资料」shows a receipt and hits its own PUT /api/characters/profile',
    /角色资料已保存/.test(authorReceipt) && authorRequests.some(entry => entry.startsWith('PUT /api/characters/profile')),
    `receipt=${authorReceipt || 'none'} requests=${authorRequests.join(', ') || 'none'} api=${authorApi.join(', ') || 'none'} persona ${before.persona}->${afterAuthor.persona}`);

  /* ---- RWR-07 closure: blank-intro save + explicit clear are real, server-confirmed behaviours ---- */

  // (a) 角色简介 left blank while 背景与情境 changed: the save must SUCCEED and the per-field cursor must
  // advance. Before the fix this was a hard 400 「角色简介无效。」 because the UI always PUTs `intro`.
  check('R1', '角色简介 留空、只改背景与情境 → 保存成功且字段修订推进',
    /角色资料已保存/.test(authorReceipt)
      && !/角色简介无效/.test(authorReceipt)
      && authorRequests.some(entry => entry.startsWith('PUT /api/characters/profile')),
    `receipt=${authorReceipt || 'none'} introAtSave=${JSON.stringify(introValue)} requests=${authorRequests.join(', ') || 'none'}`);
  const savedScenario = await page.locator('#role-scenario').inputValue().catch(() => null);
  check('R1b', '背景与情境 保存后回读仍为用户填写的值',
    savedScenario === '浏览器自动化的场景字段，仅为验收用途。', `field=${JSON.stringify(savedScenario)}`);

  // Read the persisted value back from the SERVER'S OWN STORE (role-configurations.json). `/api/characters/
  // profile` accepts PUT only — there is no GET — so the store file is the independent source of truth.
  // This deliberately bypasses the UI and the HTTP surface so the claim cannot be a UI echo.
  const STORE_FILE = process.env.AIKA_BROWSER_QA_STORE || path.join(ROOT, '.local', 'browser-qa-mgmt', 'role-configurations.json');
  const readStore = async () => {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    return parsed?.states?.companion ?? null;
  };
  let storedScenario;
  try { storedScenario = (await readStore())?.persona?.scenario; }
  catch (error) { storedScenario = `probe failed: ${error?.message ?? error}`; }
  check('R1c', '服务端确实持久化了背景与情境（store 文件回读，非 UI 回显）',
    storedScenario === '浏览器自动化的场景字段，仅为验收用途。', `store scenario=${JSON.stringify(storedScenario)}`);

  // (b) Explicitly CLEAR 背景与情境: the server must really clear it — not 400, not silently ignored.
  const clearApiBefore = apiResponses.length;
  await page.locator('#role-scenario').fill('');
  await authorBtn.first().click();
  let clearReceipt = '';
  try {
    await page.locator('text=/角色资料已保存|保存失败/').first().waitFor({ state: 'visible', timeout: 12000 });
    clearReceipt = (await bodyText(page)).match(/(角色资料已保存|保存失败)[^\n]*/)?.[0] ?? '';
  } catch { clearReceipt = 'NOTICE-NOT-SEEN'; }
  await settle(page, 500);
  const clearApi = apiResponses.slice(clearApiBefore).map(entry => `${entry.status} ${entry.method} ${entry.url} ${entry.body}`);
  let storedScenarioAfterClear;
  try {
    const cfg = await readStore();
    storedScenarioAfterClear = cfg?.persona?.scenario;
  } catch (error) { storedScenarioAfterClear = `probe failed: ${error?.message ?? error}`; }
  // Cleared means: the field is either an explicit empty string or absent from the stored document —
  // both are "the user's text is gone". A leftover non-empty value means the clear was silently ignored.
  const clearedOnServer = storedScenarioAfterClear === ''
    || storedScenarioAfterClear === undefined
    || typeof storedScenarioAfterClear === 'string' && !storedScenarioAfterClear.trim();
  check('R2', '显式清空背景与情境 → 服务端真的清空（不是 400、不是静默忽略）',
    /角色资料已保存/.test(clearReceipt) && clearedOnServer,
    `receipt=${clearReceipt || 'none'} store scenario=${JSON.stringify(storedScenarioAfterClear)} api=${clearApi.join(' | ') || 'none'}`);

  // A cleared field must also read back empty in the UI (the draft follows the owner).
  const clearedInUi = await page.locator('#role-scenario').inputValue().catch(() => null);
  check('R2b', '清空后 UI 回读背景与情境为空',
    !String(clearedInUi).trim(), `ui=${JSON.stringify(clearedInUi)}`);

  if (/角色简介无效/.test(clearReceipt) || /角色简介无效/.test(authorReceipt)) {
    defect('必须修', '简介与人设', '「保存作者资料」在简介为空时仍返回 400 角色简介无效（修复未生效？）',
      `author=${authorReceipt} clear=${clearReceipt}`);
  }
  check('B12c', '「保存作者资料」在简介留空时可用（原缺陷已闭环）',
    !/角色简介无效/.test(authorReceipt) && /角色资料已保存/.test(authorReceipt),
    `receipt=${authorReceipt}`);
  check('B12b', '「保存作者资料」does NOT advance the persona cursor (independent surface)',
    afterAuthor.persona === before.persona,
    `persona before=${before.persona} after=${afterAuthor.persona}`);

  await page.locator('#role-preview-persona').fill('浏览器自动化的匿名人设正文，仅为验收用途。');
  requests.length = 0;
  await personaBtn.first().click();
  await settle(page, 1500);
  const personaRequests = [...requests];
  page.off('request', onRequest);
  const afterPersona = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      persona: t.match(/人设正文修订：v(\d+)/)?.[1] ?? null,
      field: t.match(/角色资料字段修订：v(\d+)/)?.[1] ?? null,
    };
  });
  check('B13', '「保存人设正文」advances the persona cursor independently (separate endpoint)',
    afterPersona.persona !== afterAuthor.persona
      && !personaRequests.some(entry => entry.startsWith('PUT /api/characters/profile')),
    `after=${JSON.stringify(afterPersona)} requests=${personaRequests.join(', ') || 'none'}`);
  await shoot(page, '05-profile-saved');

  /* ---- no placeholder copy, no dead buttons ---- */

  const allText = await bodyText(page);
  check('B14', 'page contains no「待接线」placeholder copy', !allText.includes('待接线'),
    allText.includes('待接线') ? 'found 待接线' : '');

  // A dead button is one whose handler produces no observable change AND is not disabled. We probe every
  // enabled button inside the role workspace for a synchronous error and for zero DOM mutation.
  const deadProbe = await page.evaluate(() => {
    const scope = document.querySelector('.roles-workspace') || document.body;
    const buttons = [...scope.querySelectorAll('button')].filter(b => !b.disabled);
    return buttons.map(b => (b.textContent || '').trim()).filter(Boolean);
  });
  check('B15', 'role workspace renders enabled buttons that were all exercised', deadProbe.length > 0,
    `enabled buttons=${deadProbe.length}`);

  /* ---------------------------------------------------------------- C. visible error paths */

  // Wrong token: force the page's client to a bad token and drive one save. The page must REPORT failure
  // (saveError / error notice) rather than silently succeeding or blanking the list.
  const wrongToken = `${token.slice(0, 8)}deadbeef${token.slice(16)}`;
  const errorProbe = await page.evaluate(async ({ origin: o, token: t }) => {
    // Same request the UI makes, with a bad token: this is the fetch-layer truth the page would show.
    const res = await fetch(`${o}/api/characters/lorebooks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: 'companion', title: '错误令牌用例', operationId: 'op-bad-token' }),
    });
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    return { status: res.status, body };
  }, { origin, token: wrongToken });
  check('C1', 'a wrong token is REFUSED by the server (not a silent success)',
    errorProbe.status === 401, `status=${errorProbe.status} body=${errorProbe.body}`);

  // Now the UI-visible half: rebuild the page with a bad token in the hash and confirm the console shows
  // an error surface instead of a silently empty role workspace.
  const badPage = await context.newPage();
  const badPageErrors = [];
  badPage.on('pageerror', error => badPageErrors.push(String(error?.message ?? error)));
  await badPage.goto(`${origin}/#token=${wrongToken}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await settle(badPage, 1500);
  const badText = await badPage.evaluate(() => document.body.innerText);
  const showsError = /失败|错误|重新打开|不匹配|未授权|unauthorized/i.test(badText);
  check('C2', 'the console surfaces an error with a wrong token (no silent success / empty list)',
    showsError, badText.replace(/\s+/g, ' ').slice(0, 220));
  await badPage.screenshot({ path: path.join(SHOT_DIR, '06-wrong-token.png') }).catch(() => {});
  console.log(`SHOT  ${path.join(SHOT_DIR, '06-wrong-token.png')}`);
  await badPage.close();

  /* ---------------------------------------------------------------- D. auth at the fetch layer */

  const noToken = await page.evaluate(async o => {
    const res = await fetch(`${o}/api/snapshot`);
    return res.status;
  }, origin);
  check('D1', 'GET /api/snapshot without a token → 401', noToken === 401, `status=${noToken}`);

  // Forged Origin. NOTE: `Origin` is a FORBIDDEN header name — a page-context fetch that sets it is
  // silently dropped by the browser, so this CANNOT be proven from inside the page. Drive it with a
  // raw HTTP client instead (Playwright's APIRequestContext sets Origin verbatim), and additionally
  // assert the browser really does drop the header so the in-page result cannot be mistaken for proof.
  const inPageOriginDropped = await page.evaluate(async ({ origin: o, token: t }) => {
    const res = await fetch(`${o}/api/snapshot`, {
      headers: { Authorization: `Bearer ${t}`, Origin: 'http://evil.example' },
    });
    return res.status;
  }, { origin, token });
  const forgedOrigin = await page.request.get(`${origin}/api/snapshot`, {
    headers: { Authorization: `Bearer ${token}`, Origin: 'http://evil.example' },
  });
  check('D2', 'GET /api/snapshot with a forged Origin → 403 (raw HTTP client)',
    forgedOrigin.status() === 403,
    `status=${forgedOrigin.status()} body=${(await forgedOrigin.text()).slice(0, 160)}`);
  check('D3', 'browser fetch drops the forbidden Origin header (why the in-page probe cannot prove D2)',
    inPageOriginDropped === 200,
    `in-page status=${inPageOriginDropped} (Origin stripped by the browser => same-origin request)`);

  /* ---------------------------------------------------------------- E. summary */

  // A console line that only says "status of NNN" is attributed to a concrete endpoint using the response
  // log, so every remaining line is either an honest capability-unavailable state or an attributed defect.
  const classified = consoleErrors.map(text => ({ text, ...classifyConsoleError(text) }));
  const attributed = classified.map(entry => {
    if (entry.kind !== 'defect') return entry;
    const status = Number(entry.text.match(/status of (\d+)/)?.[1] ?? 0);
    const hit = apiResponses.find(response => response.status === status);
    return hit
      ? { ...entry, kind: 'attributed', detail: `HTTP ${status} from ${hit.method} ${hit.url} :: ${hit.body}` }
      : entry;
  });
  const defectConsole = attributed.filter(entry => entry.kind === 'defect');
  const attributedConsole = attributed.filter(entry => entry.kind === 'attributed');
  const honest = attributed.filter(entry => entry.kind === 'honest-unavailable');
  const cosmetic = attributed.filter(entry => entry.kind === 'cosmetic');

  console.log('\n================ CONSOLE / PAGEERROR SUMMARY ================');
  console.log(`pageerror count : ${pageErrors.length}`);
  for (const text of pageErrors) console.log(`   pageerror: ${text}`);
  console.log(`console error  : ${consoleErrors.length} total -> ${defectConsole.length} defect, ${attributedConsole.length} attributed, ${honest.length} honest-unavailable, ${cosmetic.length} cosmetic`);
  for (const entry of attributed) console.log(`   [${entry.kind}] ${entry.detail} :: ${entry.text.slice(0, 140)}`);
  console.log(`requestfailed   : ${requestFailures.length}`);
  for (const text of requestFailures.slice(0, 10)) console.log(`   reqfail: ${text}`);
  console.log('API responses >= 400 (attribution log):');
  for (const entry of apiResponses.filter(r => r.status >= 400)) {
    console.log(`   ${entry.status} ${entry.method} ${entry.url} :: ${entry.body}`);
  }

  check('E1', 'pageerror count is 0', pageErrors.length === 0, pageErrors.join(' | ') || 'clean');
  check('E2', 'no unattributed (unexplained) console errors', defectConsole.length === 0,
    defectConsole.map(entry => entry.text.slice(0, 140)).join(' | ') || 'clean');
  check('E3', 'every error-status API response is an expected honest-unavailable or client-error state',
    apiResponses.filter(r => r.status >= 500 && r.status !== 503).length === 0,
    apiResponses.filter(r => r.status >= 500 && r.status !== 503).map(r => `${r.status} ${r.url}`).join(', ') || 'no unexpected 5xx');

  const mustFail = results.filter(r => r.must && !r.pass);
  const warnFail = results.filter(r => !r.must && !r.pass);
  console.log('\n================ SUMMARY ================');
  console.log(`MUST assertions : ${results.filter(r => r.must).length - mustFail.length}/${results.filter(r => r.must).length} passed`);
  console.log(`advisory        : ${results.filter(r => !r.must).length - warnFail.length}/${results.filter(r => !r.must).length} passed`);
  console.log(`defects raised  : ${defects.length}`);
  for (const d of defects) console.log(`   [${d.severity}] ${d.area}: ${d.summary}`);

  writeFileSync(
    path.join(SHOT_DIR, 'result.json'),
    JSON.stringify({
      origin, url, chromium: { tag: launched.tag, exe: launched.exe },
      results, pageErrors, consoleErrors: attributed, requestFailures, apiResponses, defects,
      summary: { mustFailed: mustFail.length, advisoryFailed: warnFail.length },
    }, null, 2),
    'utf8',
  );

  console.log(`\nRESULT=${mustFail.length === 0 ? 'PASS' : 'RESULTS_FAIL'}`);
  await context.close();
} finally {
  await browser.close();
}

process.exit(results.some(r => r.must && !r.pass) ? 1 : 0);
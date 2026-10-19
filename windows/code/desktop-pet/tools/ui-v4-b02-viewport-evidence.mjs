// B02 §4 "可见性/可用性" row: five production pages against the real character-app build at
// 1440x1000, 390x844, and Chromium page zoom set/verified at 200% via chrome.tabs.
// The isolated extension/profile never touches the user browser or changes OS display scaling.
// Asserts per page: no horizontal overflow, keyboard focus visible, chat input stays in the
// viewport; captures screenshots into a NEW evidence directory (never the pre-repair baseline).
// Uses the same synthetic fixture data as ui-v4.browser.test.mjs; no user Book is touched.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { FileBookRepository } from '../dist/memory/file-book-repository.js';
import { BookRuntime } from '../dist/app/book-runtime.js';
import { BookCredentials } from '../dist/management/book-credentials.js';
import { startBookServer } from '../dist/management/book-server.js';
import { emptyEntry } from '../dist/contracts/memory-book.js';
import { DEFAULT_COMPANION_SETTINGS } from '../dist/contracts/book-companion.js';

const evidenceDir = resolve(process.env.B02_EVIDENCE_DIR ?? '../../../docs/next/ui-rework/evidence/b02-viewport-20261015');
mkdirSync(evidenceDir, { recursive: true });
mkdirSync('.local/ui-v4/tests', { recursive: true });
const directory = resolve(mkdtempSync('.local/ui-v4/tests/b02-viewport-'));
const repository = new FileBookRepository(directory);
const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'web-chat' };
const config = repository.loadConfig();
repository.commitConfig({ ...config, mainModel: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', credentialId: 'local-no-auth', inputTokens: 8192, outputTokens: 1024 }, companion: { ...DEFAULT_COMPANION_SETTINGS, autoMemory: true } }, config.revision, 'seed-config');
repository.commit(scope, { upsert: Array.from({ length: 31 }, (_, index) => emptyEntry('v4-' + index, 'wiki', '记忆 ' + index, '有据测试内容 ' + index)) }, repository.snapshot(scope).revision, 'seed-book');
let modelCalls=0;const runtime = new BookRuntime(repository, { async complete() { modelCalls++;return '测试回复'; } });
for (const [sessionId, text] of [['web-chat', '第一段记录'], ['searchable', '可搜索的面试记录']]) await runtime.chat({ ...scope, sessionId }, text, new AbortController().signal);
const server = await startBookServer({ runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management') });

const pages = [['chat', '聊天'], ['memory', '我们的回忆'], ['companion', '陪伴'], ['character', '角色'], ['settings', '设置']];
const seedModelCalls=modelCalls;
const extension=join(directory,'zoom-extension');mkdirSync(extension);writeFileSync(join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated UI zoom acceptance',version:'1.0',permissions:['tabs'],background:{service_worker:'background.js'}}));writeFileSync(join(extension,'background.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
const report = { startedAt: new Date().toISOString(), urlOrigin: new URL(server.url).origin, modes: [], notes: ['synthetic fixture Book; setup uses two local model fixture calls, page verification makes no model calls or writes; no user data', 'zoom200 uses chrome.tabs.setZoom/getZoom=2 in an isolated Chromium profile, same outer window before/after and measured CSS viewport/DPR'] };
try {
  for (const mode of [{ name: 'wide', viewport: { width: 1440, height: 1000 }, args: [] }, { name: 'narrow', viewport: { width: 390, height: 844 }, args: [] }, { name: 'zoom200', viewport: { width: 1440, height: 1000 }, args: [] }]) {
    const zoomMode=mode.name==='zoom200';
    const browser = zoomMode?await chromium.launchPersistentContext(join(directory,'zoom-profile'),{channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],viewport:null,args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--window-size=1440,1000']}):await chromium.launch({ headless: true });
    try {
      const page = zoomMode?await browser.newPage():await browser.newPage({ viewport: mode.viewport });
      page.setDefaultTimeout(15000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(server.url);
      let zoomEvidence=null;
      if(zoomMode){const worker=browser.serviceWorkers()[0]??await browser.waitForEvent('serviceworker');const before=await page.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,dpr:devicePixelRatio}));const zoom=await worker.evaluate(async origin=>{const tab=(await chrome.tabs.query({})).find(row=>row.url?.startsWith(origin));if(!tab?.id)throw Error('Acceptance tab missing');await chrome.tabs.setZoom(tab.id,2);return chrome.tabs.getZoom(tab.id)},new URL(server.url).origin);await page.waitForFunction(()=>devicePixelRatio===2);const after=await page.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,dpr:devicePixelRatio}));if(zoom!==2||before.outerWidth!==after.outerWidth||after.innerWidth>before.innerWidth/2+1)throw Error('Actual page zoom not confirmed');zoomEvidence={apiZoom:zoom,before,after};}
      const actualViewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
      const capture=async name=>{const path=join(evidenceDir,name);if(zoomMode){const session=await page.context().newCDPSession(page);try{const {data}=await session.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(path,Buffer.from(data,'base64'));}finally{await session.detach()}}else await page.screenshot({path,fullPage:false})};
      await page.getByRole('link', { name: '陪伴', exact: true }).waitFor();
      const rows = [];
      for (const [id, label] of pages) {
        await page.getByRole('link', { name: label, exact: true }).click();
        await page.getByRole('heading', { name: /.+/ }).first().waitFor();
        const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, innerWidth: window.innerWidth }));
        const row = { page: id, noHorizontalOverflow: overflow.scrollWidth <= overflow.clientWidth + 1, ...overflow };
        if (id === 'chat') {
          const input = page.getByLabel('聊天消息', { exact: true });
          await input.waitFor();
          const box = await input.boundingBox();
          row.chatInputVisible = Boolean(box && box.y + box.height <= actualViewport.height + 1 && box.y >= 0);
        }
        if (id === 'memory') row.graphIsDefault = (await page.getByRole('region', { name: '知识与来源图谱' }).count()) === 1;
        if (id === 'settings') row.groupedNavFound = (await page.getByRole('navigation', { name: '设置分组' }).getByRole('button').count()) === 5;
        await capture(`${mode.name}-${id}.png`);
        rows.push(row);
      }
      // keyboard focus visibility: Tab into the page and require the focused element to match :focus-visible
      await page.getByRole('link', { name: '聊天', exact: true }).click();
      await page.keyboard.press('Tab');
      const focusVisible = await page.evaluate(() => { const node = document.activeElement; return node instanceof HTMLElement && node.matches(':focus-visible'); });
      let darkApplied = false, reducedMotionOk = false;
      if (mode.name === 'wide') {
        // The theme toggle lives in the sidebar, which collapses on narrow viewports: probe dark mode and
        // reduced motion at the wide viewport, then re-verify layout and input visibility in that mode.
        // The sidebar toggle cycles auto -> light -> dark: two clicks land on dark (same as ui-v4.browser.test.mjs).
        await page.getByRole('button', { name: '外观：跟随系统', exact: true }).click();
        await page.getByRole('button', { name: '外观：浅色', exact: true }).click();
        darkApplied = (await page.locator('html').getAttribute('data-theme')) === 'dark';
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.screenshot({ path: join(evidenceDir, 'wide-chat-dark-reduced-motion.png'), fullPage: false });
        reducedMotionOk = (await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)) && (await page.locator('html').getAttribute('data-theme')) === 'dark';
        const darkOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
        if (!darkOverflow) errors.push('dark/reduced-motion chat overflows horizontally');
        const darkRows = [];
        for (const [id, label] of pages) {
          await page.getByRole('link', { name: label, exact: true }).click();
          await page.getByRole('heading', { name: /.+/ }).first().waitFor();
          const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
          const row = { page: id, noHorizontalOverflow: overflow.scrollWidth <= overflow.clientWidth + 1 };
          if (id === 'chat') {
            const input = page.getByLabel('聊天消息', { exact: true });
            await input.waitFor();
            const box = await input.boundingBox();
            row.chatInputVisible = Boolean(box && box.y >= 0 && box.y + box.height <= actualViewport.height + 1);
          }
          darkRows.push(row);
          await page.screenshot({ path: join(evidenceDir, `wide-${id}-dark.png`), fullPage: false });
        }
        if (darkRows.some(row => !row.noHorizontalOverflow)) errors.push('dark/reduced-motion page overflows horizontally');
        report.modes.push({ name: 'wide-dark-reduced-motion', viewport: mode.viewport, rows: darkRows, focusVisible: null, darkApplied, reducedMotionOk, pageErrors: [] });
      }
      report.modes.push({ name: mode.name, viewport: actualViewport, zoomEvidence, rows, focusVisible, darkApplied, reducedMotionOk, pageErrors: errors });
      console.log(`[B02] ${mode.name}: overflow=${rows.every(row => row.noHorizontalOverflow)} chatInput=${rows.find(row => row.page === 'chat')?.chatInputVisible} focusVisible=${focusVisible} errors=${errors.length}`);
    } finally { await browser.close(); }
  }
  const failed = report.modes.flatMap(mode => mode.pageErrors).length > 0
    || report.modes.some(mode => !mode.rows.every(row => row.noHorizontalOverflow))
    || report.modes.some(mode => mode.focusVisible !== null && !mode.focusVisible)
    || report.modes.some(mode => mode.rows.find(row => row.page === 'chat')?.chatInputVisible !== true)
    || report.modes.some(mode => mode.name === 'wide-dark-reduced-motion' && (!mode.darkApplied || !mode.reducedMotionOk));
  report.modelCallsDuringCheck=modelCalls-seedModelCalls;report.seedModelCalls=seedModelCalls;
  report.status = failed||report.modelCallsDuringCheck!==0 ? 'FAIL' : 'PASS';
  report.finishedAt = new Date().toISOString();
  console.log(`[B02] viewport evidence: ${report.status} -> ${evidenceDir}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(evidenceDir, 'viewport.json'), JSON.stringify(report, null, 2) + '\n');
  await server.close(); repository.close();
}

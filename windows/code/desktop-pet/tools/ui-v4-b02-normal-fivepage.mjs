// B02 read-only five-page verification against the LIVE normal instance. Proves the real
// management entry renders all five pages at the two required viewports with no horizontal
// overflow and a reachable chat input. Records only structural booleans/counts — no private
// Book content, no screenshots, no writes, no model calls.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';

const petRoot = resolve(process.cwd());
const dataDir = resolve(process.env.AIKI_BOOK_DATA ?? join(petRoot, '../../.local/memory-book'));
const evidenceDir = resolve(petRoot, '../../../docs/next/ui-rework/evidence/b02-normal-20261015');
mkdirSync(evidenceDir, { recursive: true });
const session = JSON.parse(readFileSync(join(dataDir, 'management-session.json'), 'utf8'));
const token = new URLSearchParams(new URL(session.url).hash.slice(1)).get('token');
const report = { startedAt: new Date().toISOString(), backendPid: session.pid, origin: new URL(session.url).origin, modes: [], notes: ['read-only structural verification of the live normal instance; no private text, screenshots, writes or model calls recorded'] };
const pages = [['chat', '聊天'], ['memory', '我们的回忆'], ['companion', '陪伴'], ['character', '角色'], ['settings', '设置']];
try {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(15000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(value => sessionStorage.setItem('pet-management-session-v1', value), token);
      await page.goto(new URL(session.url).origin);
      const navCount = await page.getByRole('navigation', { name: '主导航' }).getByRole('link').count();
      const rows = [];
      for (const [id, label] of pages) {
        await page.getByRole('link', { name: label, exact: true }).click();
        await page.getByRole('heading', { name: /.+/ }).first().waitFor();
        const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
        const row = { page: id, noHorizontalOverflow: overflow.scrollWidth <= overflow.clientWidth + 1, entryCount: await page.locator('.mb-entry, .mb-graph-node, li').count() };
        if (id === 'chat') {
          const input = page.getByLabel('聊天消息', { exact: true });
          await input.waitFor();
          const box = await input.boundingBox();
          row.chatInputVisible = Boolean(box && box.y >= 0 && box.y + box.height <= viewport.height + 1);
        }
        rows.push(row);
      }
      report.modes.push({ viewport, navCount, rows, pageErrors: errors });
      console.log(`[B02] ${viewport.width}x${viewport.height}: nav=${navCount} overflow=${rows.every(row => row.noHorizontalOverflow)} chatInput=${rows.find(row => row.page === 'chat')?.chatInputVisible} errors=${errors.length}`);
      await page.close();
    }
  } finally { await browser.close(); }
  const failed = report.modes.some(mode => mode.navCount !== 5 || mode.pageErrors.length > 0
    || mode.rows.some(row => !row.noHorizontalOverflow || row.page === 'chat' && row.chatInputVisible !== true));
  report.status = failed ? 'FAIL' : 'PASS';
  report.finishedAt = new Date().toISOString();
  process.exitCode = failed ? 1 : 0;
} finally {
  writeFileSync(join(evidenceDir, 'normal-fivepage.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[B02] normal five-page evidence: ${report.status ?? 'FAIL'} -> ${evidenceDir}`);
}

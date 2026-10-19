import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { isPrivateFileSync } from '../dist/core/platform-files.js';

let lastVerified = null;

/**
 * FIX61-11: budget for the authenticated identity probe.
 *
 * This is NOT a generic HTTP timeout. The probe must hit `/api/snapshot`, because that is the only
 * endpoint carrying `runtime.{pid,instanceId,sourceRevision}` for the stale-session check. Snapshot
 * lists credentials, and each listing re-verifies the Windows DACL through a PowerShell subprocess
 * (`isPrivateFileSync` is deliberately uncached). Measured on the reference machine: ~1.4s per
 * credential, ~5.8-6.3s for the four registered credentials.
 *
 * The previous 4000ms value was below that floor, so the abort fired on every attempt and
 * 「打开控制台」 always reported "暂时无法打开控制台". Kept explicit, below the renderer's 20s
 * management watchdog, so a genuinely dead backend still fails before that guard expires.
 */
export const MANAGEMENT_SESSION_TIMEOUT_MS = 15_000;

export async function managementUrl(configFile, fetcher = fetch) {
  if (!configFile) throw Error('Start the configured desktop first.');
  const file = resolve(dirname(configFile), 'management-session.json');

  let stat;
  try { stat = statSync(file); } catch { throw Error('Start the configured desktop first.'); }

  if (lastVerified && lastVerified.file === file && lastVerified.mtimeMs === stat.mtimeMs && lastVerified.size === stat.size) {
    if (Date.now() - lastVerified.checkedAt < 30000) {
      try {
        process.kill(lastVerified.pid, 0);
        return lastVerified.url;
      } catch {}
    }
  }

  if (!isPrivateFileSync(file)) throw Error('Management session file is not private.');
  const descriptor = JSON.parse(await readFile(file, 'utf8'));
  const url = new URL(descriptor.url);
  if (descriptor.version !== 1 || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || !/^#token=[a-f0-9]{64}$/.test(url.hash)) throw Error('Invalid local management session');
  // FIX61-11: /api/snapshot is the only endpoint that carries runtime identity, so the stale-session
  // check needs it, and it is slow for the reason documented on MANAGEMENT_SESSION_TIMEOUT_MS.
  const response = await fetcher(url.origin + '/api/snapshot', { headers: { authorization: 'Bearer ' + url.hash.slice(7) }, signal: AbortSignal.timeout(MANAGEMENT_SESSION_TIMEOUT_MS), redirect: 'error' });
  if (!response.ok) throw Error('Management backend is unavailable');
  const { runtime } = await response.json();
  if (runtime?.pid !== descriptor.pid || runtime?.instanceId !== descriptor.instanceId || runtime?.sourceRevision !== descriptor.sourceRevision) throw Error('Management session changed');
  lastVerified = { file, mtimeMs: stat.mtimeMs, size: stat.size, pid: descriptor.pid, url: url.href, checkedAt: Date.now() };
  return url.href;
}
// LUI-06: the console URL for one panel entry. The session URL already carries `#token=…` and an entry
// names a ROUTE (`/settings?tab=companion`, `/characters/:id/memory`); the WHATWG URL constructor
// REPLACES the whole fragment — `new URL('/x', session)` returns a token-less URL, so the console
// opened in the locked state. The session fragment keeps its exact bytes and comes first, and a route
// that also named a token can never downgrade the real session. (The token-priority rationale
// previously referenced `management/ui/app.mjs`; the React SPA's `consumeSession` keeps the semantics.)
export function managementTarget(session, route) {
  const base = new URL(session);
  const target = new URL(route ?? '/', base);
  // Merging the session fragment into another origin's URL would hand it to that host instead of keeping
  // it local. A protocol-relative route (`//host/x`) is refused rather than rewritten.
  if (target.origin !== base.origin) throw Error('The console route must stay on the local management origin.');
  const sessionFragment = base.hash.slice(1), routeFragment = target.hash.slice(1);
  if (sessionFragment || routeFragment) target.hash = sessionFragment && routeFragment ? sessionFragment + '&' + routeFragment : sessionFragment || routeFragment;
  return target.href;
}

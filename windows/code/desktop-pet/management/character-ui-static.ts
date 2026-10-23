import { existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
/** CFW-01: bounded SPA/static routing. Never expose project sources or arbitrary nested files. */
export function characterUiAsset(uiRoot: string, pathname: string, mode?: string): { path: string; mime: string } | null {
  // LUI-06: the SPA is the ONLY management shell, in setup mode as well as runtime mode. It used to
  // return null here, which forced first-run setup back onto the retired console.
  // LUI-07: the artifact moved out of the retired `management/ui/` directory to `management/character-app`.
  const root = resolve(uiRoot, 'character-app');
  if (!existsSync(resolve(root, 'index.html'))) return null;
  let name: string;
  if (/^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|mjs|css|png|jpg|jpeg|webp|svg|woff2?|ttf)$/.test(pathname)) name = pathname.slice(1);
  else if (pathname === '/' || pathname === '/index.html' || pathname === '/setup' || pathname === '/memory-book' || pathname === '/home' || pathname === '/companion' || pathname === '/character' || pathname === '/legacy' || /^\/current\/(?:overview|timeline|memory|config|chat|trace|plugins)$/.test(pathname) || /^\/(?:characters(?:\/[a-z][a-z0-9_-]{0,63}(?:\/(?:overview|timeline|memory|config|chat|trace|plugins))?)?|settings|chat|trace|plugins)\/?$/.test(pathname)) name = 'index.html';
  else return null;
  const candidate = resolve(root, name);
  if (!existsSync(candidate)) return null;
  const realRoot = realpathSync(root), realCandidate = realpathSync(candidate);
  const rel = relative(realRoot, realCandidate);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const extension = name.split('.').at(-1)!;
  const mime = ({ html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf' } as Record<string,string>)[extension]!;
  return { path: realCandidate, mime };
}

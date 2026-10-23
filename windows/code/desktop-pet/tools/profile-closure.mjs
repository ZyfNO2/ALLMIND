import {existsSync, readFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';

function resolveSpecifier(from, spec) {
  const base = join(dirname(from), spec);
  if (existsSync(base)) return base;
  if (existsSync(base + '.js')) return base + '.js';
  return null;
}

function specsOf(text) {
  const always = new Set();
  const dynamic = new Set();
  for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) always.add(match[1]);
  for (const match of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) dynamic.add(match[1]);
  for (const match of text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) dynamic.add(match[1]);
  return {always, dynamic};
}

/** Static imports are always followed. Dynamic import/require edges are skipped when the profile omits that file. */
export function moduleClosure(entry, omitDynamic = []) {
  const omit = new Set(omitDynamic);
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    if (!existsSync(file)) throw Error('Missing module entry: '+file);
    seen.add(file);
    const {always, dynamic} = specsOf(readFileSync(file, 'utf8'));
    for (const spec of always) {
      const resolved = resolveSpecifier(file, spec);
      if (!resolved) throw Error('Unresolved static module: '+file+' -> '+spec);
      pending.push(resolved);
    }
    for (const spec of dynamic) {
      if(omit.has(basename(spec)))continue;
      const resolved = resolveSpecifier(file, spec);
      if(!resolved)throw Error('Unresolved dynamic module: '+file+' -> '+spec);
      if (resolved && !omit.has(basename(resolved))) pending.push(resolved);
    }
  }
  return [...seen];
}

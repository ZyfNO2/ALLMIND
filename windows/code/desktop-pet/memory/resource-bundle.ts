import { createHash } from 'node:crypto';
import { fromBuffer } from 'yauzl';
import type { Readable } from 'node:stream';
import { BookError } from '../contracts/memory-book.js';
import {
  BUNDLE_PREVIEW_SCHEMA,
  RESOURCE_BUNDLE_SCHEMA,
  RESOURCE_LIMITS,
  type BundlePreview,
  type BundlePreviewFile,
  type BundlePreviewLink
} from '../contracts/book-resources.js';
import type { BookScope } from '../contracts/memory-book.js';

/**
 * W01 resource-bundle reader (`aiki-resource-bundle/v1`, SPEC §7).
 *
 * This is deliberately a *separate* walker from `memory/book-zip.ts`: that file implements the
 * retired `aiki-delivery/v1` Book importer with its own 1 MiB/64-entry limits and must keep its
 * exact semantics. Nothing here is applied to facts — a bundle is material, and `canOrganize`
 * only means "this is well-formed enough to hand to W02".
 */

function invalid(message: string, code = 'invalid_content'): BookError {
  return new BookError('invalid_input', '资源包：' + message, { cause: Object.assign(new Error(message), { code }) });
}

/** POSIX-relative only: no traversal, drive letters, ADS, backslashes or empty segments. */
export function safeBundlePath(name: string): void {
  if (!name || name.length > 512) throw invalid('包内路径无效。', 'unsafe_path');
  if (/[\\:\0]/u.test(name)) throw invalid('包内路径无效。', 'unsafe_path');
  if (name.startsWith('/')) throw invalid('包内路径无效。', 'unsafe_path');
  const parts = name.replace(/\/$/u, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw invalid('包内路径无效。', 'unsafe_path');
}

export interface BundleArchive { files: Map<string, Buffer>; totalBytes: number }

/**
 * Streams a ZIP into memory with W01 limits. Entries are validated before any byte is kept:
 * encryption, symlinks, oversized members and declared/actual length mismatches all fail closed.
 */
export async function readBundleArchive(bytes: Buffer): Promise<BundleArchive> {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) throw invalid('不是有效的压缩包。', 'corrupt_data');
  if (bytes.length > RESOURCE_LIMITS.bundleBytes) throw invalid('压缩包超过 16 MiB 上限。', 'too_large');
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => {
      if (error) { reject(invalid(error.message, 'corrupt_data')); return; }
      const files = new Map<string, Buffer>();
      const names = new Set<string>();
      let total = 0, settled = false, active: Readable | undefined;
      const fail = (failure: unknown) => {
        if (settled) return;
        settled = true;
        active?.destroy();
        archive.close();
        reject(failure instanceof BookError ? failure : invalid(failure instanceof Error ? failure.message : String(failure)));
      };
      archive.on('error', fail);
      archive.on('end', () => { if (!settled) { settled = true; archive.close(); resolve({ files, totalBytes: total }); } });
      if (archive.entryCount > RESOURCE_LIMITS.bundleEntries) { fail(invalid('包内条目超过 128。', 'too_large')); return; }
      archive.on('entry', entry => { void (async () => {
        safeBundlePath(entry.fileName);
        const lower = entry.fileName.toLowerCase();
        if (names.has(lower)) throw invalid('包内包含重复文件名（大小写不敏感）。', 'invalid_content');
        names.add(lower);
        if (entry.generalPurposeBitFlag & 1 || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) {
          throw invalid('不接受加密文件或符号链接。', 'unsafe_path');
        }
        if (entry.uncompressedSize > RESOURCE_LIMITS.bundleUncompressedBytes || total + entry.uncompressedSize > RESOURCE_LIMITS.bundleUncompressedBytes) {
          throw invalid('解压总量超过 64 MiB 上限。', 'too_large');
        }
        if (entry.fileName.endsWith('/')) {
          if (entry.uncompressedSize !== 0) throw invalid('目录包含异常数据。', 'corrupt_data');
          archive.readEntry();
          return;
        }
        const stream = await new Promise<Readable>((done, failed) => archive.openReadStream(entry, (err, value) => err ? failed(err) : done(value!)));
        active = stream;
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          size += chunk.length;
          total += chunk.length;
          if (total > RESOURCE_LIMITS.bundleUncompressedBytes) throw invalid('实际解压数据超过限额。', 'too_large');
          chunks.push(Buffer.from(chunk));
        }
        active = undefined;
        if (size !== entry.uncompressedSize) throw invalid('解压长度与 ZIP 声明不一致。', 'corrupt_data');
        files.set(entry.fileName, Buffer.concat(chunks));
        archive.readEntry();
      })().catch(fail); });
      archive.readEntry();
    });
  });
}

interface ManifestFile { path: string; role: 'page' | 'source' | 'asset'; mime: string; sha256?: string }
interface Manifest { schemaVersion: string; title?: string; entrypoint?: string; files: ManifestFile[] }

function manifestOf(files: Map<string, Buffer>): { manifest: Manifest | null; manifestPath: string | null; diagnostics: BundlePreview['diagnostics'] } {
  const roots = [...files.keys()].filter(name => name === 'manifest.json' || name.endsWith('/manifest.json'));
  const diagnostics: BundlePreview['diagnostics'] = [];
  if (!roots.length) {
    diagnostics.push({ code: 'missing_manifest', message: '包内没有 manifest.json，保留为普通文件，不进入整理。' });
    return { manifest: null, manifestPath: null, diagnostics };
  }
  if (roots.length > 1) {
    diagnostics.push({ code: 'duplicate_manifest', message: '包内存在多个 manifest.json。' });
    return { manifest: null, manifestPath: null, diagnostics };
  }
  const path = roots[0]!;
  if (path !== 'manifest.json') {
    diagnostics.push({ code: 'invalid_manifest', message: '资源清单必须位于包根目录。', path });
    return { manifest: null, manifestPath: path, diagnostics };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get(path)!));
  } catch {
    diagnostics.push({ code: 'invalid_manifest', message: 'manifest.json 不是有效的 UTF-8 JSON。', path });
    return { manifest: null, manifestPath: path, diagnostics };
  }
  const candidate = parsed as Partial<Manifest>;
  if (!candidate || typeof candidate !== 'object' || candidate.schemaVersion !== RESOURCE_BUNDLE_SCHEMA || !Array.isArray(candidate.files) || !candidate.files.length) {
    diagnostics.push({ code: 'unrecognized_format', message: 'manifest.json 不是 aiki-resource-bundle/v1。', path });
    return { manifest: null, manifestPath: path, diagnostics };
  }
  if (candidate.files.length > RESOURCE_LIMITS.bundleEntries) {
    diagnostics.push({ code: 'too_many_files', message: '清单文件数超过上限。', path });
    return { manifest: null, manifestPath: path, diagnostics };
  }
  const roles = ['page', 'source', 'asset'];
  const seen = new Set<string>();
  for (const item of candidate.files) {
    if (!item || typeof item.path !== 'string' || typeof item.mime !== 'string' || typeof item.role !== 'string' || !roles.includes(item.role)) {
      diagnostics.push({ code: 'invalid_manifest_entry', message: '清单条目缺少 path/role/mime。', path });
      return { manifest: null, manifestPath: path, diagnostics };
    }
    try{safeBundlePath(item.path);}catch(error){if(item.path.includes('\\'))throw error;diagnostics.push({code:'unsafe_path',message:'清单路径不安全。',path:item.path});return {manifest:null,manifestPath:path,diagnostics};}
    if(item.path === 'manifest.json'){diagnostics.push({code:'invalid_manifest_entry',message:'清单不能引用自身。'});return {manifest:null,manifestPath:path,diagnostics};}
    const key = item.path.toLowerCase();
    if (seen.has(key)) {
      diagnostics.push({ code: 'duplicate_path', message: `清单路径重复：${item.path}`, path });
      return { manifest: null, manifestPath: path, diagnostics };
    }
    seen.add(key);
    if (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256))) {
      diagnostics.push({ code: 'invalid_hash', message: `清单哈希无效：${item.path}`, path });
      return { manifest: null, manifestPath: path, diagnostics };
    }
  }
  return { manifest: candidate as Manifest, manifestPath: path, diagnostics };
}

const LINK_PATTERN = /(?:!?\[[^\]]*\]\(([^)\s]+)\))|(?:^|\s)(https?:\/\/[^\s<>()"']+)|\b(?:src|href)\s*=\s*["']([^"']+)["']/gimu;

/** Link class only; unsafe schemes stay `internal` in class but can never resolve (status `broken`). */
function classifyLink(target: string): BundlePreviewLink['kind'] {
  if (/^https?:\/\//iu.test(target)) return 'external';
  return /\.(?:png|jpe?g|webp|gif|svg)(?:[?#].*)?$/iu.test(target) ? 'asset' : 'internal';
}

/** `sandbox:`, `file:`, `javascript:` and `data:` are never resolved to a local member. */
function unsafeTarget(target: string): boolean {
  return /^(?:sandbox:|file:|javascript:|data:|mailto:|tel:)/iu.test(target) || /^[a-z][a-z0-9+.-]*:/iu.test(target) && !/^https?:\/\//iu.test(target);
}

/** Resolves an in-bundle relative link against the linking file's directory, rejecting escapes. */
function resolveRelative(from: string, target: string, present: Set<string>): string | null {
  try { target = decodeURIComponent(target.split(/[?#]/u)[0]!); } catch { return null; }
  if (unsafeTarget(target) || /[\\\0]/u.test(target) || target.startsWith('/')) return null;
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const segments = (base ? `${base}/${target}` : target).split('/');
  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!stack.length) return null; stack.pop(); continue; }
    stack.push(segment);
  }
  const path = stack.join('/');
  return present.has(path) ? path : null;
}

export interface BuildBundlePreviewInput {
  scope: BookScope;
  resourceId: string;
  bundleSha256: string;
  archive: BundleArchive;
}

/**
 * Builds a preview over already-validated members. Repeated previews are pure functions of the
 * archive, so they never create duplicate entries (SPEC §7).
 */
export function buildBundlePreview(input: BuildBundlePreviewInput): BundlePreview {
  const { archive } = input;
  const { manifest, manifestPath, diagnostics } = manifestOf(archive.files);
  if (!manifest || !manifestPath) {
    return {
      schemaVersion: BUNDLE_PREVIEW_SCHEMA,
      resourceId: input.resourceId,
      scope: { ...input.scope },
      bundleSha256: input.bundleSha256,
      format: 'unrecognized',
      title: null,
      entrypoint: null,
      files: [],
      links: [],
      diagnostics,
      canOrganize: false
    };
  }
  const prefix = manifestPath.slice(0, -'manifest.json'.length);
  const files: BundlePreviewFile[] = [];
  const present = new Set<string>();
  const declared = new Set<string>();
  for (const item of manifest.files) {
    const full = prefix + item.path;
    const body = archive.files.get(full);
    declared.add(full);
    if (!body) {
      diagnostics.push({ code: 'missing_member', message: `清单声明的文件不在包内：${item.path}`, path: item.path });
      continue;
    }
    const digest = createHash('sha256').update(body).digest('hex');
    if (item.sha256 && item.sha256 !== digest) {
      diagnostics.push({ code: 'hash_mismatch', message: `清单哈希与实际内容不一致：${item.path}`, path: item.path });
      continue;
    }
    present.add(full);
    files.push({ path: item.path, role: item.role, resourceId: 'member-' + createHash('sha256').update(input.resourceId+'\0'+item.path).digest('hex'), mime: item.mime, bytes: body.length, sha256: digest });
  }
  for (const name of archive.files.keys()) {
    if (name === manifestPath || declared.has(name)) continue;
    diagnostics.push({ code: 'unlisted_member', message: `包内存在未列入清单的文件：${name}`, path: name });
  }
  const entrypoint = typeof manifest.entrypoint === 'string' ? manifest.entrypoint : null;
  if (entrypoint) {
    if (!present.has(prefix + entrypoint)) {
      diagnostics.push({ code: 'missing_entrypoint', message: `声明的入口不在包内：${entrypoint}`, path: entrypoint });
    }
  } else {
    diagnostics.push({ code: 'missing_entrypoint', message: '清单没有声明 entrypoint。' });
  }
  const links: BundlePreviewLink[] = [];
  for (const [name, body] of archive.files) {
    if (!present.has(name) || !/\.(?:md|markdown|html?)$/iu.test(name)) continue;
    const relative = name.slice(prefix.length);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      diagnostics.push({ code: 'not_utf8', message: `成员不是 UTF-8 文本：${relative}`, path: relative });
      continue;
    }
    LINK_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(LINK_PATTERN)) {
      const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (!target || target.startsWith('#')) continue;
      const kind = classifyLink(target);
      if (kind === 'external') {
        links.push({ from: relative, target, kind, status: 'external_unfetched' });
        continue;
      }
      const resolved = unsafeTarget(target) ? null : resolveRelative(name, target, present);
      links.push(resolved
        ? { from: relative, target: resolved.slice(prefix.length), kind, status: 'resolved' }
        : { from: relative, target, kind, status: 'broken' });
    }
  }
  const fatal = diagnostics.some(item => ['missing_member', 'hash_mismatch', 'unsafe_path', 'duplicate_path', 'too_many_files'].includes(item.code));
  const complete = Boolean(entrypoint) && !fatal && diagnostics.length === 0 && links.every(link=>link.status!=='broken');
  return {
    schemaVersion: BUNDLE_PREVIEW_SCHEMA,
    resourceId: input.resourceId,
    scope: { ...input.scope },
    bundleSha256: input.bundleSha256,
    format: RESOURCE_BUNDLE_SCHEMA,
    title: typeof manifest.title === 'string' ? manifest.title.slice(0, 200) : null,
    entrypoint,
    files,
    links,
    diagnostics,
    canOrganize: complete
  };
}

export function bundleSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

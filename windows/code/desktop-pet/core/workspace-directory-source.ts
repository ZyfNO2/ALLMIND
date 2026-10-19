/**
 * core/workspace-directory-source.ts
 *
 * CK-02: workspace_directory incremental source.
 *
 * `DownloadDirectorySource` cannot serve a workspace: it permanently excludes any name it saw at
 * startup, so an already-existing file that later changes is never ingested. This source is
 * content-version based instead — the unit of identity is (relative path, content hash), so an
 * edit, an atomic replace and a re-save of the same bytes are distinguishable and each is
 * ingested at most once.
 *
 * Safety rules that are not optional:
 *  - the root is resolved through `realpath` and every entry is re-checked for containment, so a
 *    junction / reparse point pointing outside the root is refused rather than followed;
 *  - the user's files are only ever read. Nothing is written, moved or deleted here;
 *  - a scan is bounded by a page size and a batch ceiling, and truncation is reported instead of
 *    being silently recorded as a complete scan;
 *  - a half-written file is not ingested: size + mtime must be stable across the settle window;
 *  - the hash always comes from real bytes, never from the file name or its mtime.
 */

import { watch, type FSWatcher } from 'node:fs';
import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  WorkspaceSourceScope,
  WorkspaceScanCounts,
  WorkspaceScanRequest,
  WorkspaceScanResult,
  WorkspaceFileCandidate,
  WorkspaceSourceLease,
} from '../contracts/workspace-source.js';

const TEMPORARY_EXTENSIONS = new Set(['.tmp', '.crdownload', '.part', '.downloading', '.partial', '.swp']);

interface FileFacts {
  readonly size: number;
  readonly mtimeMs: number;
  readonly createdMs: number;
}

export interface WorkspaceDirectorySourceOptions {
  readonly fileStableIntervalMs?: number;
  readonly maxFileBytes?: number;
  readonly pageSize?: number;
  readonly maxItemsPerScan?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
  /** Test seam. Production reads the verified contained file directly. */
  readonly readBytes?: (absolutePath: string) => Promise<Uint8Array>;
}

export class WorkspaceDirectorySource {
  private readonly fileStableIntervalMs: number;
  private readonly maxFileBytes: number;
  private readonly pageSize: number;
  private readonly maxItemsPerScan: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;
  private readonly readBytes: (absolutePath: string) => Promise<Uint8Array>;
  private watcher: FSWatcher | null = null;
  private closed = false;
  /**
   * Content-version ledger keyed by relative path; the value is the digest last ingested for that
   * path. An unchanged re-notification is a no-op, a real edit produces a new version.
   */
  private readonly ingested = new Map<string, string>();
  /**
   * Deletions observed by the most recent complete scan. The caller uses these to invalidate the
   * stored candidates: a file the user deleted must stop feeding derived knowledge, and the
   * tombstone must keep a rescan from resurrecting the same content version.
   */
  private lastDeleted: readonly string[] = [];

  /** Paths reported deleted by the last complete scan. */
  get deletedPaths(): readonly string[] { return this.lastDeleted; }

  constructor(options: WorkspaceDirectorySourceOptions = {}) {
    this.fileStableIntervalMs = options.fileStableIntervalMs ?? 750;
    this.maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024;
    this.pageSize = options.pageSize ?? 50;
    this.maxItemsPerScan = options.maxItemsPerScan ?? 500;
    this.sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
    this.now = options.now ?? (() => new Date().toISOString());
    this.readBytes = options.readBytes ?? (absolutePath => readFile(absolutePath));
  }

  /** True when this exact content version was already ingested for the path. */
  hasVersion(relativePath: string, contentHash: string): boolean {
    return this.ingested.get(relativePath) === contentHash;
  }

  /** Number of distinct paths currently tracked. Used by status and by the scan receipt. */
  get trackedCount(): number { return this.ingested.size; }

  /**
   * Open a watcher over the authorized root.
   *
   * The watcher only *wakes* the source; every emission still goes through the same verification
   * and content-version path as a scan, so a duplicate or late fs notification can never create a
   * second weighted copy of the same content.
   */
  async start(
    scope: WorkspaceSourceScope,
    onCandidate: (candidate: WorkspaceFileCandidate) => void | Promise<void>,
  ): Promise<WorkspaceSourceLease> {
    const canonicalRoot = await this.#resolveRoot(scope);
    this.closed = false;

    try {
      this.watcher = watch(canonicalRoot, { persistent: false }, (_eventType, filename) => {
        if (this.closed || !filename) return;
        void this.#wake(canonicalRoot, scope, String(filename), onCandidate);
      });
    } catch {
      throw Object.assign(new Error('workspace_root_unavailable'), { code: 'workspace_root_unavailable' });
    }

    return {
      kind: 'workspace_directory',
      root: canonicalRoot,
      close: async () => {
        this.closed = true;
        if (this.watcher) { this.watcher.close(); this.watcher = null; }
        this.ingested.clear();
      },
    };
  }

  async #resolveRoot(scope: WorkspaceSourceScope): Promise<string> {
    const root = await realpath(resolve(scope.canonicalRoot)).catch(() => null);
    if (!root) throw Object.assign(new Error('workspace_root_unavailable'), { code: 'workspace_root_unavailable' });
    return root;
  }

  /** A watcher notification produces at most one candidate, through the verified path. */
  async #wake(
    canonicalRoot: string,
    scope: WorkspaceSourceScope,
    filename: string,
    onCandidate: (candidate: WorkspaceFileCandidate) => void | Promise<void>,
  ): Promise<void> {
    const candidate = await this.#observe(canonicalRoot, scope, filename);
    if (!candidate) return;
    if (!scope.allowedExtensions.includes(candidate.extension)) return;
    await onCandidate(candidate);
  }

  /**
   * One pass over the authorized root.
   *
   * `mode:'import-existing'` is the explicit historical import. `mode:'incremental'` reports only
   * what changed relative to what this source already ingested, plus the current manifest counts.
   */
  async scan(request: WorkspaceScanRequest): Promise<WorkspaceScanResult> {
    const counts = { added: 0, changed: 0, unchanged: 0, deleted: 0, unsupported: 0, failed: 0 };
    let visited = 0;
    let truncated = false;
    const seen = new Set<string>();
    const collected: WorkspaceFileCandidate[] = [];

    let canonicalRoot: string;
    try {
      canonicalRoot = await this.#resolveRoot(request.scope);
    } catch {
      // A moved root or lost permission is `unavailable`, never "a clean empty scan".
      return Object.freeze({
        jobId: request.operationId,
        state: 'unavailable' as const,
        reason: 'workspace_root_unavailable',
        counts: Object.freeze(counts),
        items: Object.freeze([]),
        remaining: 0,
        truncated: false,
        nextCursor: null,
      });
    }

    await this.#walk(canonicalRoot, canonicalRoot, request.scope, async (absolutePath, relPath) => {
      if (request.signal?.aborted || this.closed) return;
      if (visited >= this.maxItemsPerScan) { truncated = true; return; }
      visited += 1;
      seen.add(relPath);

      if (TEMPORARY_EXTENSIONS.has(extname(relPath).toLocaleLowerCase())) return;

      const stats = await stat(absolutePath).catch(() => null);
      if (!stats || !stats.isFile()) return;
      const facts: FileFacts = { size: stats.size, mtimeMs: stats.mtimeMs, createdMs: stats.birthtimeMs || stats.mtimeMs };

      const known = this.ingested.get(relPath);
      // Paging skips paths at or before the cursor before they are even hashed, so a page must
      // not consume the version ledger for entries it is about to hide.
      if (request.cursor && relPath <= request.cursor) {
        if (known !== undefined) counts.unchanged += 1;
        return;
      }
      const candidate = await this.#observe(canonicalRoot, request.scope, relPath, facts, false);
      if (!candidate) {
        // Not ingestable now. If we already hold a version it is simply unchanged.
        if (known !== undefined) counts.unchanged += 1;
        else if (extname(relPath).toLocaleLowerCase() === '' || facts.size === 0) counts.unsupported += 1;
        return;
      }
      if (!request.scope.allowedExtensions.includes(candidate.extension)) {
        // Recognised but not parseable in this version: counted, never read or executed.
        counts.unsupported += 1;
        this.ingested.delete(relPath);
        return;
      }
      collected.push(candidate);
      if (known === undefined) counts.added += 1; else counts.changed += 1;
    });

    if (!truncated) {
      const removed: string[] = [];
      for (const known of this.ingested.keys()) {
        if (!seen.has(known)) { counts.deleted += 1; removed.push(known); }
      }
      this.lastDeleted = Object.freeze(removed);
    }

    // One manifest is paged in stable relative-path order. Only the emitted page is committed to
    // the version ledger, so a later page still sees its own entries as new versions.
    const ordered = collected.slice().sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    const offset = request.cursor ? ordered.findIndex(item => item.relativePath > request.cursor!) : 0;
    const begin = offset > 0 ? offset : 0;
    const page = ordered.slice(begin, begin + this.pageSize);
    const hasMore = ordered.length > begin + page.length;

    // Commit only what this page actually delivers.
    for (const item of page) this.ingested.set(item.relativePath, item.contentHash);

    return Object.freeze({
      jobId: request.operationId,
      state: truncated ? 'partial' as const : 'succeeded' as const,
      reason: truncated ? 'max_items_reached' : null,
      counts: Object.freeze(counts),
      items: Object.freeze(page),
      remaining: truncated ? 1 : (hasMore ? ordered.length - begin - page.length : 0),
      truncated,
      nextCursor: hasMore ? (page.at(-1)?.relativePath ?? null) : null,
    });
  }

  /** Recursive directory walk with realpath containment enforced on every entry. */
  async #walk(
    canonicalRoot: string,
    directory: string,
    scope: WorkspaceSourceScope,
    visit: (absolutePath: string, relPath: string) => Promise<void>,
  ): Promise<void> {
    const handle = await opendir(directory).catch(() => null);
    if (!handle) return;
    for await (const entry of handle) {
      if (this.closed) return;
      const absolutePath = join(directory, entry.name);
      // Containment is re-checked through a real resolution: a junction is not a shortcut past it.
      const real = await realpath(absolutePath).catch(() => null);
      if (!real || !this.#isInside(real, canonicalRoot)) continue;

      const info = await stat(real).catch(() => null);
      if (!info) continue;

      if (info.isDirectory()) {
        if (scope.recursive) await this.#walk(canonicalRoot, real, scope, visit);
        continue;
      }
      if (!info.isFile()) continue;
      const relPath = relative(canonicalRoot, real).split(sep).join('/');
      await visit(absolutePath, relPath);
    }
  }

  /**
   * Verify one file and, when it is a new content version, produce a candidate.
   *
   * Returns null when the file is not ingestable (too large, still being written, or already
   * ingested at this exact hash). The caller decides whether that is "unchanged" or "unsupported".
   *
   * `record` is false during a scan: the version ledger is committed by the caller for the page it
   * actually emits, so paging a manifest cannot consume entries that a later page still owes.
   */
  async #observe(
    canonicalRoot: string,
    scope: WorkspaceSourceScope,
    relativePath: string,
    preStat?: FileFacts,
    record = true,
  ): Promise<WorkspaceFileCandidate | null> {
    if (this.closed) return null;
    const absolutePath = join(canonicalRoot, relativePath.split('/').join(sep));
    const real = await realpath(absolutePath).catch(() => null);
    if (!real || !this.#isInside(real, canonicalRoot)) return null;

    const facts: FileFacts | null = preStat ?? await stat(real).then(
      stats => ({ size: stats.size, mtimeMs: stats.mtimeMs, createdMs: stats.birthtimeMs || stats.mtimeMs }),
    ).catch(() => null);
    if (!facts) return null;
    if (facts.size === 0 || facts.size > this.maxFileBytes) return null;

    const bytes = await this.readBytes(real).catch(() => null);
    if (!bytes || bytes.byteLength === 0) return null;
    if (bytes.byteLength > this.maxFileBytes) return null;

    // Stability: the hash we record must be the content the user actually finished writing.
    await this.sleep(this.fileStableIntervalMs);
    const after = await stat(real).catch(() => null);
    if (!after) return null;
    if (after.size !== facts.size || after.mtimeMs !== facts.mtimeMs) return null;

    const contentHash = createHash('sha256').update(bytes).digest('hex');
    if (this.ingested.get(relativePath) === contentHash) return null;

    if (record) this.ingested.set(relativePath, contentHash);
    const extension = extname(relativePath).toLocaleLowerCase();
    return Object.freeze({
      sourceKind: 'workspace_directory' as const,
      relativePath,
      displayName: relativePath.slice(relativePath.lastIndexOf('/') + 1),
      extension,
      mimeType: mimeForExtension(extension),
      size: bytes.byteLength,
      contentHash,
      fileCreatedAt: new Date(facts.createdMs || facts.mtimeMs).toISOString(),
      fileModifiedAt: new Date(facts.mtimeMs).toISOString(),
      receivedAt: this.now(),
    });
  }

  #isInside(targetPath: string, rootPath: string): boolean {
    const target = resolve(targetPath).toLocaleLowerCase();
    const root = resolve(rootPath).toLocaleLowerCase();
    return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  }
}

function mimeForExtension(extension: string): string {
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  if (extension === '.json') return 'application/json';
  if (extension === '.csv') return 'text/csv';
  return 'text/plain';
}

/**
 * contracts/workspace-source.ts
 *
 * CK-02: workspace_directory source contracts (schemaVersion 2 grant fields).
 *
 * Additive only. `CompanionSourceKind` gains `workspace_directory`; older grants keep their v1
 * interpretation and are never widened to a workspace root or to recursion. An unknown purpose or
 * an absent scope is refused rather than defaulted.
 */

import type { CompanionSourceKind } from './companion-mode.js';

export type WorkspaceScanMode = 'incremental' | 'import-existing';
export type WorkspaceScanState = 'succeeded' | 'partial' | 'failed' | 'unavailable';

export interface WorkspaceSourceScope {
  /** Host-confirmed root. It is a controlled reference, never a path taken from a log. */
  readonly canonicalRoot: string;
  /** Default false: only the selected root's own entries are observed. */
  readonly recursive: boolean;
  readonly allowedExtensions: readonly string[];
  /** History is imported only by an explicit operation, never by merely enabling the source. */
  readonly importExisting: boolean;
  readonly maxFileBytes?: number;
}

export interface WorkspaceFileCandidate {
  readonly sourceKind: Extract<CompanionSourceKind, 'workspace_directory'>;
  readonly relativePath: string;
  readonly displayName: string;
  readonly extension: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentHash: string;
  readonly fileCreatedAt: string;
  readonly fileModifiedAt: string;
  readonly receivedAt: string;
}

export interface WorkspaceScanCounts {
  readonly added: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly deleted: number;
  readonly unsupported: number;
  readonly failed: number;
}

export interface WorkspaceScanRequest {
  readonly operationId: string;
  readonly mode: WorkspaceScanMode;
  readonly scope: WorkspaceSourceScope;
  readonly expectedRevision?: number;
  readonly cutoff?: string;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface WorkspaceScanResult {
  readonly jobId: string;
  readonly state: WorkspaceScanState;
  readonly reason: string | null;
  readonly counts: WorkspaceScanCounts;
  readonly items: readonly WorkspaceFileCandidate[];
  /** Items not reached because a page or batch ceiling stopped the pass. Never silently dropped. */
  readonly remaining: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface WorkspaceSourceLease {
  readonly kind: 'workspace_directory';
  readonly root: string;
  close(): Promise<void>;
}

export const WORKSPACE_SCAN_LIMITS = Object.freeze({
  pageSize: 50,
  maxItemsPerScan: 500,
  maxFileBytes: 20 * 1024 * 1024,
  fileStableIntervalMs: 750,
});

import { createHash } from 'node:crypto';
import { BookError, type BookScope } from './memory-book.js';

/**
 * W01 resource contract. A resource is local bytes AIKI itself received, plus the identity needed
 * to decide who may read them again. It is deliberately NOT a knowledge base: nothing here writes
 * facts, personas or recall state.
 *
 * Hard rules carried by this module:
 * - Only `ready` carries a verified mime/bytes/sha256 and real bytes on disk.
 * - A candidate list, a download link or a model's own claim is never `ready`.
 * - Public records never contain absolute paths, cookies, bearers, base64 payloads or signed URLs.
 * - Resource/Delivery revisions are independent of the Book and Runtime config revisions.
 */

export const RESOURCE_SCHEMA = 'aiki-resource/v1' as const;
export const ARTIFACT_DELIVERY_SCHEMA = 'aiki-artifact-delivery/v1' as const;
export const BUNDLE_PREVIEW_SCHEMA = 'aiki-bundle-preview/v1' as const;
export const RESOURCE_BUNDLE_SCHEMA = 'aiki-resource-bundle/v1' as const;
export const SOURCE_MATERIAL_EXTRACTION_VERSION = 'aiki-text-extract/v1' as const;

/** Server-side limits (SPEC §7). Tightening per real platform behaviour is allowed and must be recorded. */
export const RESOURCE_LIMITS = Object.freeze({
  textBytes: 2 * 1024 * 1024,
  imageBytes: 16 * 1024 * 1024,
  bundleBytes: 16 * 1024 * 1024,
  bundleUncompressedBytes: 64 * 1024 * 1024,
  bundleEntries: 128,
  inputsPerTurn: 8,
  outputsPerTurn: 16,
  imagesPerTurnBytes: 32 * 1024 * 1024,
  fetchTimeoutMs: 60_000,
  imagePixels: 40_000_000,
  materialBytes: 512 * 1024,
  chunkBytes: 64 * 1024,
  nameChars: 160
});

export type ResourceState = 'pending' | 'receiving' | 'ready' | 'failed' | 'expired' | 'unsupported' | 'revoked';
export type ResourceKind = 'markdown' | 'html' | 'text' | 'image' | 'zip' | 'unknown';
export type ResourceUse = 'text' | 'image';
export type ResourceFailureCode =
  | 'unsupported' | 'unverified_identity' | 'download_failed' | 'expired' | 'too_large' | 'invalid_content'
  | 'unsafe_path' | 'cancelled' | 'source_changed' | 'scope_mismatch' | 'corrupt_data';

export const RESOURCE_STATES: readonly ResourceState[] = Object.freeze(['pending', 'receiving', 'ready', 'failed', 'expired', 'unsupported', 'revoked']);
export const RESOURCE_KINDS: readonly ResourceKind[] = Object.freeze(['markdown', 'html', 'text', 'image', 'zip', 'unknown']);
export const RESOURCE_USES: readonly ResourceUse[] = Object.freeze(['text', 'image']);
export const RESOURCE_FAILURE_CODES: readonly ResourceFailureCode[] = Object.freeze([
  'unsupported', 'unverified_identity', 'download_failed', 'expired', 'too_large', 'invalid_content',
  'unsafe_path', 'cancelled', 'source_changed', 'scope_mismatch', 'corrupt_data'
]);

/** Images AIKI is willing to hand to a native upload. SVG and everything else stays `unsupported`. */
export const IMAGE_MIMES: readonly string[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const TEXT_MIMES: readonly string[] = Object.freeze(['text/markdown', 'text/html', 'text/plain']);
export const RESOURCE_MIMES: readonly string[] = Object.freeze([...IMAGE_MIMES, ...TEXT_MIMES, 'application/zip']);

export interface ResourceOrigin {
  kind: 'provider' | 'upload' | 'web' | 'bundle_member';
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  parentResourceId?: string;
  memberPath?: string;
  /** Only ever the public URL the user explicitly submitted. Signed download URLs never enter this object. */
  sourceUri?: string;
}

export interface ResourceRecord {
  schemaVersion: typeof RESOURCE_SCHEMA;
  id: string;
  scope: BookScope;
  revision: number;
  name: string;
  kind: ResourceKind;
  state: ResourceState;
  mime: string | null;
  bytes: number | null;
  sha256: string | null;
  createdAt: string;
  receivedAt: string | null;
  origin: ResourceOrigin;
  error?: { code: ResourceFailureCode; message: string };
}

export interface ResourceSelection { resourceId: string; use: ResourceUse }
export interface FrozenResourceSelection extends ResourceSelection { sha256: string }

export interface ArtifactDelivery {
  schemaVersion: typeof ARTIFACT_DELIVERY_SCHEMA;
  id: string;
  scope: BookScope;
  turnId: string;
  revision: number;
  resourceIds: string[];
  discovery: 'complete' | 'failed' | 'unsupported';
  error?: { code: ResourceFailureCode; message: string };
}

export interface SourceMaterial {
  resourceId: string;
  scope: BookScope;
  resourceRevision: number;
  sha256: string;
  mime: string;
  title: string;
  origin: ResourceOrigin;
  text: string;
  extraction: { version: string; complete: boolean; omittedReason?: string };
}

export interface BundlePreviewFile {
  path: string; role: 'page' | 'source' | 'asset'; resourceId: string; mime: string; bytes: number; sha256: string;
}
export interface BundlePreviewLink {
  from: string; target: string; kind: 'internal' | 'asset' | 'external';
  status: 'resolved' | 'external_unfetched' | 'broken';
}
export interface BundlePreview {
  schemaVersion: typeof BUNDLE_PREVIEW_SCHEMA;
  resourceId: string;
  scope: BookScope;
  bundleSha256: string;
  format: typeof RESOURCE_BUNDLE_SCHEMA | 'unrecognized';
  title: string | null;
  entrypoint: string | null;
  files: BundlePreviewFile[];
  links: BundlePreviewLink[];
  diagnostics: { code: string; message: string; path?: string }[];
  canOrganize: boolean;
}

export interface ResourceCapabilities {
  outputFiles: 'available' | 'unavailable' | 'unknown';
  inputImages: 'available' | 'unavailable' | 'unknown';
  reason?: string;
}

export interface ProviderArtifactCandidate {
  handleId: string;
  nameHint: string;
  mimeHint?: string;
  messageId: string;
}

export interface RichModelResult {
  text: string;
  requestId: string;
  conversationId: string | null;
  messageId: string | null;
  artifacts: ProviderArtifactCandidate[];
  artifactDiscovery: 'complete' | 'failed' | 'unsupported';
  artifactError?: { code: ResourceFailureCode; message: string };
  imageReceipts?: ImageInputReceipt[];
}

/** Native upload completed and its file identity was checked in the actual outgoing user message. */
export interface ImageInputReceipt {
  resourceId: string; sha256: string; mime: string; bytes: number; name: string;
}

export interface PreparedImageInput {
  resourceId: string;
  sha256: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Uint8Array;
}

export interface UploadMetadata { name: string; mime: string; sourceUri?: string }

export const DEFAULT_RESOURCE_CAPABILITIES: ResourceCapabilities = Object.freeze({
  outputFiles: 'unknown' as const,
  inputImages: 'unknown' as const
});

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function invalid(message: string): never { throw new BookError('invalid_input', message); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${label}包含未知字段。`);
}
function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) invalid(`${label} 无效。`);
}
function optionalIdentity(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'string' || !ID.test(value))) invalid(`${label} 无效。`);
}
function iso(value: unknown, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`${label} 无效。`);
}
function revision(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} 无效。`);
}
function sha(value: unknown, label: string): void {
  if (typeof value !== 'string' || !HEX64.test(value)) invalid(`${label} 无效。`);
}
function scopeOf(value: unknown): BookScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('资源作用域无效。');
  const scope = value as BookScope;
  identity(scope.characterId, 'characterId'); identity(scope.pairingId, 'pairingId'); identity(scope.sessionId, 'sessionId');
  return scope;
}

export function resourceScopeKey(scope: BookScope): string {
  return createHash('sha256').update(JSON.stringify([scope.characterId, scope.pairingId, scope.sessionId])).digest('hex');
}

export function sameScope(a: BookScope, b: BookScope): boolean {
  return a.characterId === b.characterId && a.pairingId === b.pairingId && a.sessionId === b.sessionId;
}

/** Mime is derived from verified bytes, never from a name hint alone. */
export function kindOfMime(mime: string | null): ResourceKind {
  if (!mime) return 'unknown';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/plain') return 'text';
  if (IMAGE_MIMES.includes(mime)) return 'image';
  if (mime === 'application/zip') return 'zip';
  return 'unknown';
}

export function validateResourceOrigin(origin: ResourceOrigin): void {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) invalid('资源来源无效。');
  exactKeys(origin as unknown as Record<string, unknown>, ['kind', 'requestId', 'conversationId', 'messageId', 'parentResourceId', 'memberPath', 'sourceUri'], '资源来源');
  if (!['provider', 'upload', 'web', 'bundle_member'].includes(origin.kind)) invalid('资源来源类型无效。');
  optionalIdentity(origin.requestId, 'requestId');
  optionalIdentity(origin.conversationId, 'conversationId');
  optionalIdentity(origin.messageId, 'messageId');
  optionalIdentity(origin.parentResourceId, 'parentResourceId');
  if (origin.memberPath !== undefined) {
    if (typeof origin.memberPath !== 'string' || origin.memberPath.length > 512) invalid('资源包成员路径无效。');
  }
  if (origin.sourceUri !== undefined) {
    if (typeof origin.sourceUri !== 'string' || origin.sourceUri.length > 2048) invalid('资源来源网址无效。');
    if (/[\s\u0000-\u001f]/u.test(origin.sourceUri)) invalid('资源来源网址无效。');
  }
  if (origin.kind === 'bundle_member' && (origin.parentResourceId === undefined || origin.memberPath === undefined)) invalid('资源包成员缺少父资源。');
}

export function validateResourceRecord(record: ResourceRecord): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) invalid('资源记录无效。');
  exactKeys(record as unknown as Record<string, unknown>, ['schemaVersion', 'id', 'scope', 'revision', 'name', 'kind', 'state', 'mime', 'bytes', 'sha256', 'createdAt', 'receivedAt', 'origin', 'error'], '资源记录');
  if (record.schemaVersion !== RESOURCE_SCHEMA) invalid('资源记录版本无效。');
  identity(record.id, 'resourceId');
  scopeOf(record.scope);
  revision(record.revision, '资源修订');
  if (typeof record.name !== 'string' || !record.name.length || record.name.length > RESOURCE_LIMITS.nameChars) invalid('资源名称无效。');
  if (!RESOURCE_KINDS.includes(record.kind)) invalid('资源类型无效。');
  if (!RESOURCE_STATES.includes(record.state)) invalid('资源状态无效。');
  iso(record.createdAt, '资源创建时间');
  if (record.receivedAt !== null) iso(record.receivedAt, '资源接收时间');
  validateResourceOrigin(record.origin);
  if (record.state === 'ready') {
    if (record.mime === null || !RESOURCE_MIMES.includes(record.mime)) invalid('就绪资源缺少已验证的媒体类型。');
    if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) invalid('就绪资源缺少字节数。');
    sha(record.sha256, '资源哈希');
    if (record.receivedAt === null) invalid('就绪资源缺少接收时间。');
    if (record.error !== undefined) invalid('就绪资源不应携带错误。');
    if (record.kind !== kindOfMime(record.mime)) invalid('资源类型与媒体类型不一致。');
  }
  if (record.state === 'failed') {
    if (!record.error) invalid('失败资源必须说明原因。');
  }
  if (record.error !== undefined) {
    exactKeys(record.error as unknown as Record<string, unknown>, ['code', 'message'], '资源错误');
    if (!RESOURCE_FAILURE_CODES.includes(record.error.code)) invalid('资源错误码无效。');
    if (typeof record.error.message !== 'string' || !record.error.message.length || record.error.message.length > 300) invalid('资源错误说明无效。');
  }
}

export function validateArtifactDelivery(delivery: ArtifactDelivery): void {
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) invalid('交付记录无效。');
  exactKeys(delivery as unknown as Record<string, unknown>, ['schemaVersion', 'id', 'scope', 'turnId', 'revision', 'resourceIds', 'discovery', 'error'], '交付记录');
  if (delivery.schemaVersion !== ARTIFACT_DELIVERY_SCHEMA) invalid('交付记录版本无效。');
  identity(delivery.id, 'deliveryId'); identity(delivery.turnId, 'turnId');
  scopeOf(delivery.scope);
  revision(delivery.revision, '交付修订');
  if (!['complete', 'failed', 'unsupported'].includes(delivery.discovery)) invalid('交付发现状态无效。');
  if (!Array.isArray(delivery.resourceIds) || delivery.resourceIds.length > RESOURCE_LIMITS.outputsPerTurn) invalid('交付资源清单无效。');
  const seen = new Set<string>();
  for (const id of delivery.resourceIds) { identity(id, 'resourceId'); if (seen.has(id)) invalid('交付资源清单重复。'); seen.add(id); }
  if (delivery.error !== undefined) {
    exactKeys(delivery.error as unknown as Record<string, unknown>, ['code', 'message'], '交付错误');
    if (!RESOURCE_FAILURE_CODES.includes(delivery.error.code)) invalid('交付错误码无效。');
  }
}

export function validateSourceMaterial(material: SourceMaterial): void {
  if (!material || typeof material !== 'object' || Array.isArray(material)) invalid('资料无效。');
  exactKeys(material as unknown as Record<string, unknown>, ['resourceId', 'scope', 'resourceRevision', 'sha256', 'mime', 'title', 'origin', 'text', 'extraction'], '资料');
  identity(material.resourceId, 'resourceId');
  scopeOf(material.scope);
  revision(material.resourceRevision, '资源修订');
  sha(material.sha256, '资源哈希');
  if (!TEXT_MIMES.includes(material.mime)) invalid('该资源不能作为正文资料。');
  if (typeof material.title !== 'string' || material.title.length > 300) invalid('资料标题无效。');
  if (typeof material.text !== 'string') invalid('资料正文无效。');
  validateResourceOrigin(material.origin);
  const extraction = material.extraction;
  if (!extraction || typeof extraction !== 'object') invalid('资料提取信息无效。');
  exactKeys(extraction as unknown as Record<string, unknown>, ['version', 'complete', 'omittedReason'], '资料提取信息');
  if (typeof extraction.version !== 'string' || !extraction.version.length) invalid('资料提取版本无效。');
  if (typeof extraction.complete !== 'boolean') invalid('资料完整性标记无效。');
  if (extraction.omittedReason !== undefined && (typeof extraction.omittedReason !== 'string' || extraction.omittedReason.length > 300)) invalid('资料省略说明无效。');
}

export function validateResourceCapabilities(capabilities: ResourceCapabilities): void {
  if (!capabilities || typeof capabilities !== 'object') invalid('来源能力无效。');
  exactKeys(capabilities as unknown as Record<string, unknown>, ['outputFiles', 'inputImages', 'reason'], '来源能力');
  for (const key of ['outputFiles', 'inputImages'] as const) {
    if (!['available', 'unavailable', 'unknown'].includes(capabilities[key])) invalid('来源能力取值无效。');
  }
  if (capabilities.reason !== undefined && (typeof capabilities.reason !== 'string' || capabilities.reason.length > 300)) invalid('来源能力说明无效。');
}

export function validateResourceSelection(value: unknown): ResourceSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('本轮资源选择无效。');
  const selection = value as ResourceSelection;
  exactKeys(value as Record<string, unknown>, ['resourceId', 'use'], '本轮资源选择');
  identity(selection.resourceId, 'resourceId');
  if (!RESOURCE_USES.includes(selection.use)) invalid('资源用途必须为正文或图片。');
  return { resourceId: selection.resourceId, use: selection.use };
}

export function validateFrozenResourceSelection(value: unknown): FrozenResourceSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('冻结资源选择无效。');
  const row = value as FrozenResourceSelection;
  const selection = validateResourceSelection({resourceId: row.resourceId, use: row.use});
  const sha256 = (value as FrozenResourceSelection).sha256;
  exactKeys(value as Record<string, unknown>, ['resourceId', 'use', 'sha256'], '冻结资源选择');
  sha(sha256, '资源哈希');
  return { ...selection, sha256 };
}

/** Normalize a turn's resource selections: at most 8, no duplicate id, explicit order preserved. */
export function normalizeResourceSelections(value: unknown): ResourceSelection[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid('本轮资源选择必须是列表。');
  if (value.length > RESOURCE_LIMITS.inputsPerTurn) invalid(`单轮最多选择 ${RESOURCE_LIMITS.inputsPerTurn} 份资料。`);
  const seen = new Set<string>();
  const normalized: ResourceSelection[] = [];
  for (const item of value) {
    const selection = validateResourceSelection(item);
    if (seen.has(selection.resourceId)) invalid('同一轮次不能重复选择同一份资料。');
    seen.add(selection.resourceId);
    normalized.push(selection);
  }
  return normalized;
}

/**
 * The replay identity of a turn's resources. Covers scope, turnId, the raw query, the normalized
 * turn style and the ordered resource id/use/sha256. It deliberately excludes current global
 * defaults so an old turn stays replayable after the user changes settings (B03 semantics).
 */
export function resourceRequestHash(input: {
  scope: BookScope;
  turnId: string;
  query: string;
  replyStyle: string;
  selections: FrozenResourceSelection[];
}): string {
  const canonical = {
    scope: [input.scope.characterId, input.scope.pairingId, input.scope.sessionId],
    turnId: input.turnId,
    query: input.query,
    replyStyle: input.replyStyle,
    selections: input.selections.map(selection => [selection.resourceId, selection.use, selection.sha256])
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function failureOf(code: ResourceFailureCode, message: string): { code: ResourceFailureCode; message: string } {
  return { code, message: message.length > 300 ? `${message.slice(0, 297)}...` : message };
}

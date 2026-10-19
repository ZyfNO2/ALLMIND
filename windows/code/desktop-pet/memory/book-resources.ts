import { BookError, type BookScope } from '../contracts/memory-book.js';
import {
  RESOURCE_LIMITS,
  SOURCE_MATERIAL_EXTRACTION_VERSION,
  kindOfMime,
  sameScope,
  validateResourceSelection,
  type ArtifactDelivery,
  type BundlePreview,
  type FrozenResourceSelection,
  type ResourceCapabilities,
  type ResourceFailureCode,
  type ResourceRecord,
  type ResourceSelection,
  type SourceMaterial,
  type UploadMetadata
} from '../contracts/book-resources.js';
import type { FileResourceStore } from './file-resource-store.js';
import { assertImagePixels, assertWithinLimit, detectMedia, extractText } from './resource-bytes.js';
import { buildBundlePreview, bundleSha256, readBundleArchive, safeBundlePath } from './resource-bundle.js';
import { capturePublicDocument, fetchPublicDocument } from './resource-web.js';

/**
 * W01 ResourceService (ARCHITECTURE_CONTRACTS §5).
 *
 * Every read re-validates the *current* owner and revocation state instead of trusting a record
 * handed in by a caller, so a stale record can never widen access. This is the only interface the
 * Runtime, the HTTP routes and (later) W02 use — no consumer needs a UI-private file URL.
 *
 * Nothing in here applies facts: a resource is material, never knowledge.
 */

export interface ResourceServiceOptions {
  /** Injectable for tests; production uses a connection-validated public transport. */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  resolveHost?: (hostname: string) => Promise<string[]>;
  capabilities?: () => ResourceCapabilities;
  now?: () => Date;
  stagingTtlMs?: number;
}

/** A provider that can turn an opaque candidate handle into verified bytes. */
export interface ArtifactCandidate {
  requestId?:string; scope?:BookScope;
  candidateId: string;
  nameHint: string;
  mimeHint?: string;
  messageId: string;
}

export interface ArtifactSource {
  readArtifact(candidate: ArtifactCandidate, signal: AbortSignal): Promise<Uint8Array>;
}

export interface ReceiveResult {
  delivery: ArtifactDelivery;
  resources: ResourceRecord[];
  failures: { resourceId: string; code: ResourceFailureCode; message: string }[];
}

export interface ProviderDeliveryInput {
  scope: BookScope;
  turnId: string; requestId?:string; conversationId?:string;
  discovery: ArtifactDelivery['discovery'];
  candidates: { handleId: string; nameHint: string; mimeHint?: string; messageId: string }[];
  error?: { code: ResourceFailureCode; message: string };
}

function codeOf(cause: unknown): ResourceFailureCode {
  const code = (cause as { cause?: { code?: ResourceFailureCode } } | undefined)?.cause?.code;
  const known: ResourceFailureCode[] = ['unsupported', 'unverified_identity', 'download_failed', 'expired', 'too_large', 'invalid_content', 'unsafe_path', 'cancelled', 'source_changed', 'scope_mismatch', 'corrupt_data'];
  return code && known.includes(code) ? code : 'download_failed';
}

async function collectBytes(source: AsyncIterable<Uint8Array> | Uint8Array, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    if (signal.aborted) throw new BookError('unavailable', '上传已取消。');
    total += chunk.byteLength;
    if (total > limit) throw new BookError('invalid_input', '上传文件超过 16 MiB 上限。');
    chunks.push(chunk);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export class BookResourceService {
  onRevoke?:(scope:BookScope,ids:string[])=>void;
  onEraseMaterials?:(scope:BookScope,ids:string[])=>void;
  readonly store: FileResourceStore;
  readonly limits=RESOURCE_LIMITS;
  private readonly capabilitySource: () => ResourceCapabilities;
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly resolveHost: ((hostname: string) => Promise<string[]>) | undefined;
  private readonly now: () => Date;
  private readonly stagingTtlMs: number;

  constructor(store: FileResourceStore, options: ResourceServiceOptions = {}) {
    this.store = store;
    this.capabilitySource = options.capabilities ?? (() => ({ outputFiles: 'unknown', inputImages: 'unknown' }));
    this.fetchImpl = options.fetch ?? fetchPublicDocument;
    this.resolveHost = options.resolveHost;
    this.now = options.now ?? (() => new Date());
    this.stagingTtlMs = options.stagingTtlMs ?? 24 * 60 * 60 * 1000;
  }

  capabilities(): ResourceCapabilities {
    return this.capabilitySource();
  }

  get(scope: BookScope, resourceId: string): ResourceRecord {
    return this.store.get(scope, resourceId);
  }
  list(scope:BookScope):ResourceRecord[]{return this.store.list(scope);}

  async readBytes(scope: BookScope, resourceId: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) return Promise.reject(new BookError('unavailable', '读取已取消。'));
    return Promise.resolve(this.store.readBytes(scope, resourceId));
  }

  getDelivery(scope: BookScope, deliveryId: string): ArtifactDelivery {
    return this.store.getDelivery(scope, deliveryId);
  }

  listForTurn(scope: BookScope, turnId: string): ResourceRecord[] {
    return this.store.listForTurn(scope, turnId);
  }

  /**
   * Text material for one resource. Images and bundles are not text: asking for material on them is
   * a typed error rather than a fabricated empty document (SPEC §3).
   */
  async readMaterial(scope: BookScope, resourceId: string, signal?: AbortSignal): Promise<SourceMaterial> { return this.readMaterialSnapshot(scope,resourceId,signal); }
  readMaterialSnapshot(scope: BookScope, resourceId: string, signal?: AbortSignal): SourceMaterial {
    if (signal?.aborted) throw new BookError('unavailable', '读取已取消。');
    const record = this.store.get(scope, resourceId);
    if (record.state !== 'ready') throw new BookError('not_found', '该资源当前不可读取。');
    if (record.kind === 'image') throw new BookError('invalid_input', '图片不能作为正文资料读取；请以图片方式用于下一轮。');
    if (record.kind === 'zip') throw new BookError('invalid_input', '资源包请使用预览读取成员，而不是整体作为正文。');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(this.store.readBytes(scope, resourceId));
    } catch (cause) {
      throw new BookError('corrupt_data', '资料不是有效的 UTF-8 文本。', { cause });
    }
    const extracted = extractText(record.kind, text, RESOURCE_LIMITS.materialBytes);
    return {
      resourceId: record.id,
      scope: { ...record.scope },
      resourceRevision: record.revision,
      sha256: record.sha256!,
      mime: record.mime!,
      title: record.name,
      origin: { ...record.origin },
      text: extracted.text,
      extraction: {
        version: SOURCE_MATERIAL_EXTRACTION_VERSION,
        complete: extracted.complete,
        ...(extracted.omittedReason ? { omittedReason: extracted.omittedReason } : {})
      }
    };
  }

  /**
   * Freezes the selections for one turn. The hash recorded here is what makes a replay of the same
   * turnId detect a swapped attachment (contract §4).
   */
  freeze(scope: BookScope, selections: ResourceSelection[]): FrozenResourceSelection[] {
    if (selections.length > RESOURCE_LIMITS.inputsPerTurn) throw new BookError('invalid_input', `每轮最多选择 ${RESOURCE_LIMITS.inputsPerTurn} 个资料。`);
    const seen = new Set<string>();
    let imageBytes = 0;
    const frozen: FrozenResourceSelection[] = [];
    for (const selection of selections) {
      validateResourceSelection(selection);
      if (seen.has(selection.resourceId)) throw new BookError('invalid_input', '同一资料不能在一轮中重复选择。');
      seen.add(selection.resourceId);
      const record = this.store.get(scope, selection.resourceId);
      if (record.state === 'revoked') throw new BookError('conflict', '所选资料已撤销，不能用于本轮。');
      if (record.state !== 'ready' || !record.sha256) throw new BookError('conflict', '所选资料尚未接收完成，不能用于本轮。');
      if (selection.use === 'image') {
        if (record.kind !== 'image') throw new BookError('invalid_input', '只有图片资料能以图片方式使用。');
        imageBytes += this.store.readBytes(scope, record.id).byteLength;
        if (imageBytes > RESOURCE_LIMITS.imagesPerTurnBytes) throw new BookError('invalid_input', '本轮图片总量超过 32 MiB 上限。');
      } else if (record.kind === 'image') {
        throw new BookError('invalid_input', '图片资料必须以图片方式选择，不能当作正文。');
      }
      frozen.push({ resourceId: record.id, use: selection.use, sha256: record.sha256 });
    }
    return frozen;
  }

  /** Verified image bytes for the provider upload; refuses anything not frozen for this turn. */
  imagesFor(scope: BookScope, frozen: FrozenResourceSelection[], signal?: AbortSignal): { resourceId: string; sha256: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Uint8Array }[] {
    const images: { resourceId: string; sha256: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Uint8Array }[] = [];
    for (const selection of frozen) {
      if (selection.use !== 'image') continue;
      if (signal?.aborted) throw new BookError('unavailable', '上传已取消。');
      const record = this.store.get(scope, selection.resourceId);
      if (record.state !== 'ready' || record.sha256 !== selection.sha256) throw new BookError('conflict', '所选图片已变化，请重新选择。');
      if (record.mime !== 'image/png' && record.mime !== 'image/jpeg' && record.mime !== 'image/webp') throw new BookError('invalid_input', '图片类型不受支持。');
      images.push({ resourceId: record.id, sha256: record.sha256, mime: record.mime, bytes: this.store.readBytes(scope, record.id) });
    }
    return images;
  }

  /** Text materials for one turn, in the frozen order, for the shared context builder. */
  materialsFor(scope: BookScope, frozen: FrozenResourceSelection[], signal?: AbortSignal): Promise<SourceMaterial[]> {
    return Promise.all(frozen.filter(item => item.use === 'text').map(item => this.readMaterial(scope, item.resourceId, signal)));
  }

  /** Provider candidates → pending records. Nothing is published before the turn is persisted. */
  prepareDelivery(input: ProviderDeliveryInput, operationId: string): ArtifactDelivery {
    return this.store.createDelivery(input, operationId);
  }

  /**
   * Receives provider bytes for a delivery. Failures are per-resource: a failed file never turns the
   * already-saved text into a failure, and ready items are untouched on retry.
   */
  async receiveFromProvider(input: { scope: BookScope; deliveryId: string; resourceIds?: string[]; signal: AbortSignal }, source: ArtifactSource): Promise<ReceiveResult> {
    const delivery = this.store.getDelivery(input.scope, input.deliveryId);
    const entries = this.store.deliveryEntries(input.deliveryId);
    const wanted = input.resourceIds ? new Set(input.resourceIds) : null;
    const failures: ReceiveResult['failures'] = [];
    const resources: ResourceRecord[] = [];
    for (let index = 0; index < delivery.resourceIds.length; index += 1) {
      const resourceId = delivery.resourceIds[index]!;
      if (wanted && !wanted.has(resourceId)) continue;
      const record = this.store.get(input.scope, resourceId);
      if (record.state === 'ready') { resources.push(record); continue; }
      if (record.state === 'revoked') { failures.push({ resourceId, code: 'cancelled', message: '资源已撤销。' }); continue; }
      const entry = entries[index];
      if (!entry) { failures.push({ resourceId, code: 'corrupt_data', message: '交付记录缺少候选身份。' }); continue; }
      this.store.markReceiving(input.scope, resourceId);
      try {
        const bytes = await source.readArtifact({...entry,scope:input.scope,...(record.origin.requestId?{requestId:record.origin.requestId}:{})}, input.signal);
        input.signal.throwIfAborted();
        const current=this.store.get(input.scope,resourceId);if(current.state!=='receiving')throw new BookError('conflict','文件接收已取消或撤销。');
        const detected = detectMedia(bytes, { mime: entry.mimeHint ?? null, name: entry.nameHint });
        assertWithinLimit(detected.kind, bytes.byteLength);
        if (detected.kind === 'image') assertImagePixels(detected.mime, bytes);
        resources.push(this.store.receiveBytes({ scope: input.scope, resourceId, bytes, mime: detected.mime, kind: detected.kind }));
      } catch (cause) {
        const code = codeOf(cause);
        const message = cause instanceof Error ? cause.message : String(cause);
        failures.push({ resourceId, code, message });
        this.store.failResource(input.scope, resourceId, code, message);
      }
    }
    return { delivery: this.store.bumpDelivery(input.scope, input.deliveryId), resources, failures };
  }

  /**
   * Retries only the named failed resources of an existing delivery. It never calls `ask`, so a
   * download retry can never re-submit the user's message (SPEC §4.2).
   */
  async retryReceive(scope: BookScope, deliveryId: string, resourceIds: string[], expectedRevision: number, operationId: string, signal: AbortSignal, source: ArtifactSource): Promise<ArtifactDelivery> {
    const delivery = this.store.getDelivery(scope, deliveryId);
    if (!resourceIds.length) throw new BookError('invalid_input', '请指定需要重试的文件。');
    const payload = { kind: 'retry', deliveryId, resourceIds: [...resourceIds].sort(), expectedRevision };
    const replayed = this.store.replayDeliveryOperation(scope, 'retry', operationId, payload);
    if (replayed) return replayed;
    if (delivery.revision !== expectedRevision) throw new BookError('conflict', '交付记录已变化，请回读当前状态。');
    for (const resourceId of resourceIds) {
      if (!delivery.resourceIds.includes(resourceId)) throw new BookError('not_found', '交付记录中没有这个文件。');
      const record = this.store.get(scope, resourceId);
      if (record.state === 'ready') continue;
      if (record.state === 'revoked') throw new BookError('conflict', '已撤销的资源不能重试。');
    }
    const result = await this.receiveFromProvider({ scope, deliveryId, resourceIds, signal }, source);
    this.store.commitDeliveryOperation(scope, 'retry', operationId, payload, deliveryId);
    return result.delivery;
  }

  cancelReceive(scope: BookScope, deliveryId: string, expectedRevision: number, operationId: string): ArtifactDelivery {
    return this.store.cancelReceive(scope, deliveryId, expectedRevision, operationId);
  }

  revoke(scope: BookScope, resourceId: string, expectedRevision: number, operationId: string): ResourceRecord {
    const members=this.store.list(scope).filter(row=>row.origin.parentResourceId===resourceId).map(row=>row.id);
    const record=this.store.revoke(scope,resourceId,expectedRevision,operationId);this.onRevoke?.(scope,[resourceId,...members]);return record;
  }

  /** Existing 「清除原始聊天」 path: attachments of an erased turn must not stay reachable (§8). */
  revokeForTurn(scope: BookScope, turnId: string): string[] {
    // The repository's erasure journal owns removal of facts derived from these IDs. Do not
    // re-enter Book commits here (startup replay can run before a new Runtime exists).
    const ids=this.store.revokeForTurn(scope,turnId);this.onEraseMaterials?.(scope,ids);return ids;
  }

  /** User upload. `operationId` makes a retried upload replay instead of duplicating (§5). */
  async receiveUpload(scope: BookScope, metadata: UploadMetadata, byteStream: AsyncIterable<Uint8Array> | Uint8Array, operationId: string, signal: AbortSignal): Promise<ResourceRecord> {
    if (signal.aborted) throw new BookError('unavailable', '上传已取消。');
    if (typeof metadata.name !== 'string' || !metadata.name.length || metadata.name.length > RESOURCE_LIMITS.nameChars) throw new BookError('invalid_input', '文件名无效或超限。');
    const bytes = await collectBytes(byteStream, RESOURCE_LIMITS.imageBytes, signal);
    if (!bytes.byteLength) throw new BookError('invalid_input', '上传内容为空。');
    const payload = { kind: 'upload', name: metadata.name, mime: metadata.mime ?? null, sha256: bundleSha256(Buffer.from(bytes)) };
    const replayed = this.store.replayOperation(scope, 'upload', operationId, payload);
    if (replayed) return replayed;
    const detected = detectMedia(bytes, { mime: metadata.mime ?? null, name: metadata.name });
    assertWithinLimit(detected.kind, bytes.byteLength);
    if (detected.kind === 'image') assertImagePixels(detected.mime, bytes);
    if (detected.kind === 'unknown') throw new BookError('invalid_input', '不支持的文件类型；首版只接收 Markdown/HTML/TXT、PNG/JPEG/WebP 与资源包。');
    const created = this.store.createLocalResource({ scope, name: metadata.name, origin: { kind: 'upload' } });
    const saved = this.store.receiveBytes({ scope, resourceId: created.id, bytes, mime: detected.mime, kind: detected.kind });
    this.store.commitLocalOperation(scope, 'upload', operationId, payload, saved.id);
    return saved;
  }

  /** Explicit user-submitted URL. A failure keeps its reason; no empty document is fabricated. */
  async captureUrl(scope: BookScope, url: string, operationId: string, signal: AbortSignal): Promise<ResourceRecord> {
    const payload = { kind: 'url', url };
    const replayed = this.store.replayOperation(scope, 'url', operationId, payload);
    if (replayed) return replayed;
    const document = await capturePublicDocument(url, signal, {
      fetch: this.fetchImpl,
      ...(this.resolveHost ? { resolveHost: this.resolveHost } : {})
    });
    const detected = detectMedia(document.bytes, { mime: document.mime, name: document.finalUrl });
    assertWithinLimit(detected.kind, document.bytes.byteLength);
    if (detected.kind !== 'text' && detected.kind !== 'markdown' && detected.kind !== 'html') {
      throw new BookError('unavailable', `网址返回的不是可读取的网页正文（${detected.mime}）。`);
    }
    const name = document.finalUrl.split('/').filter(Boolean).at(-1)?.slice(0, RESOURCE_LIMITS.nameChars) || document.finalUrl.slice(0, RESOURCE_LIMITS.nameChars);
    const created = this.store.createLocalResource({ scope, name, origin: { kind: 'web', sourceUri: document.finalUrl } });
    const saved = this.store.receiveBytes({ scope, resourceId: created.id, bytes: document.bytes, mime: detected.mime, kind: detected.kind });
    this.store.commitLocalOperation(scope, 'url', operationId, payload, saved.id);
    return saved;
  }

  /** Bundle preview over already-received bytes; pure and repeatable, with no fact application. */
  async previewBundle(scope: BookScope, resourceId: string, signal: AbortSignal): Promise<BundlePreview> {
    if (signal.aborted) throw new BookError('unavailable', '读取已取消。');
    const record = this.store.get(scope, resourceId);
    if (record.state !== 'ready') throw new BookError('not_found', '该资源当前不可读取。');
    if (record.kind !== 'zip') throw new BookError('invalid_input', '只有资源包可以预览成员。');
    const bytes = Buffer.from(this.store.readBytes(scope, resourceId));
    const archive = await readBundleArchive(bytes);
    const preview = buildBundlePreview({ scope, resourceId, bundleSha256: bundleSha256(bytes), archive });
    if(preview.canOrganize) for(const file of preview.files){
      const existing=this.store.findMember(scope,resourceId,file.path);
      if(existing){file.resourceId=existing.id;continue;}
      const body=archive.files.get(file.path)!;const media=detectMedia(body,{mime:file.mime,name:file.path});if(media.mime!==file.mime)throw new BookError('invalid_input','成员声明类型与内容不一致。');
      assertWithinLimit(media.kind,body.length);if(media.kind==='image')assertImagePixels(media.mime,body);
      const child=this.store.createLocalResource({scope,name:file.path,origin:{kind:'bundle_member',parentResourceId:resourceId,memberPath:file.path}});
      const saved=this.store.receiveBytes({scope,resourceId:child.id,bytes:body,mime:media.mime,kind:media.kind});file.resourceId=saved.id;
    }
    return preview;
  }

  /** Resolves a bundle member to an independently addressable, verified resource record. */
  materializeBundleMember(scope: BookScope, parentId: string, memberPath: string): ResourceRecord {
    const parent = this.store.get(scope, parentId);
    if (parent.state !== 'ready' || parent.kind !== 'zip') throw new BookError('not_found', '该资源包当前不可读取。');
    safeBundlePath(memberPath);
    return this.store.createLocalResource({
      scope,
      name: memberPath.slice(0, RESOURCE_LIMITS.nameChars),
      origin: { kind: 'bundle_member', parentResourceId: parentId, memberPath }
    });
  }

  /** Test/diagnostic store counters; never exposed over HTTP. */
  stats(): { revision: number; resources: number; deliveries: number } {
    return this.store.stats();
  }

  sameOwner(record: ResourceRecord, scope: BookScope): boolean {
    return sameScope(record.scope, scope);
  }

  kindOf(mime: string | null): ReturnType<typeof kindOfMime> {
    return kindOfMime(mime);
  }

  /** Clears unreferenced staging records past the retention window (SPEC §7). */
  sweep(): number {
    return this.store.sweep(this.now(), this.stagingTtlMs);
  }
}

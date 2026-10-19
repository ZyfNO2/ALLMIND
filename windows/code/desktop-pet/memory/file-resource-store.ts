import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {replaceResourceFile} from './resource-atomic-replace.js';
import { BookError, type BookScope, type SavedTurn } from '../contracts/memory-book.js';
import {
  ARTIFACT_DELIVERY_SCHEMA,
  RESOURCE_SCHEMA,
  sameScope,
  validateArtifactDelivery,
  validateResourceRecord,
  type ArtifactDelivery,
  type ResourceFailureCode,
  type ResourceRecord
} from '../contracts/book-resources.js';

/**
 * W01 resource persistence (ARCHITECTURE_CONTRACTS §2/§8).
 *
 * This store owns local bytes and their metadata. It is NOT a knowledge base: nothing here is
 * ever applied to facts, persona or recall. It deliberately keeps a separate file from the Book
 * snapshot and the runtime config so that resource progress never bumps `Book.revision` or the
 * runtime `revision` (contract §2).
 *
 * The process-wide single-writer guarantee comes from the shared `writer.lock` held by
 * FileBookRepository; this store therefore never opens a second lock.
 */

const STORE_SCHEMA = 'aiki-resource-store/v1';
const BLOB_DIR = 'resources';

/** Internal record: the public ResourceRecord plus the opaque local blob name. Never leaves this module. */
interface StoredResource extends ResourceRecord { blob: string | null }
interface StoredDelivery extends ArtifactDelivery { entries: StoredEntry[] }
interface StoredEntry { candidateId: string; nameHint: string; mimeHint?: string; messageId: string }
interface OperationRecord { fingerprint: string; result: { kind: 'resource'; id: string } | { kind: 'delivery'; id: string } }
interface StoreData {
  schemaVersion: typeof STORE_SCHEMA;
  revision: number;
  resources: Record<string, StoredResource>;
  deliveries: Record<string, StoredDelivery>;
  operations: Record<string, OperationRecord>;
  completedTurns?:Record<string,{scope:BookScope;turn:SavedTurn;configRevision:number}>;
}

function resourceKey(scope:BookScope,id:string){return sha256(Buffer.from(JSON.stringify([scope.characterId,scope.pairingId,scope.sessionId,id])));}
function emptyStore(): StoreData {
  return { schemaVersion: STORE_SCHEMA, revision: 0, resources: {}, deliveries: {}, operations: {} };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function failure(code: ResourceFailureCode, message: string): { code: ResourceFailureCode; message: string } {
  return { code, message: message.length > 300 ? `${message.slice(0, 297)}...` : message };
}

function conflict(message: string): BookError {
  return new BookError('conflict', message);
}

/** Public shape: strip every local path before a record leaves the store. */
function publicRecord(stored: StoredResource): ResourceRecord {
  const { blob: _blob, ...record } = stored;
  return structuredClone(record);
}

function publicDelivery(stored: StoredDelivery): ArtifactDelivery {
  const { entries: _entries, ...delivery } = stored;
  return structuredClone(delivery);
}

export interface CreateDeliveryInput {
  scope: BookScope;
  turnId: string; requestId?:string;conversationId?:string;
  discovery: ArtifactDelivery['discovery'];
  candidates: { handleId: string; nameHint: string; mimeHint?: string; messageId: string }[];
  error?: { code: ResourceFailureCode; message: string };
}

export interface ReceiveBytesInput {
  scope: BookScope;
  resourceId: string;
  bytes: Uint8Array;
  mime: string;
  kind: ResourceRecord['kind'];
  expectedSha256?: string;
}

export interface ResourceStoreOptions { directory: string; now?: () => Date }

/**
 * Byte and metadata persistence with content-addressed blobs.
 *
 * Content addressing is what makes §8 safe: two records that legitimately hold the same bytes
 * share one blob, and a revoke only unlinks the blob when no other live record references it.
 */
export class FileResourceStore {
  readonly directory: string;
  private readonly file: string;
  private readonly blobRoot: string;
  private readonly now: () => Date;
  private data: StoreData;

  constructor(options: ResourceStoreOptions) {
    this.directory = resolve(options.directory);
    this.file = join(this.directory, 'resource-store.json');
    this.blobRoot = join(this.directory, BLOB_DIR);
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.directory, { recursive: true });
    mkdirSync(this.blobRoot, { recursive: true });
    this.data = this.read();
  }

  private read(): StoreData {
    if (!existsSync(this.file)) return emptyStore();
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== STORE_SCHEMA) throw new Error('schema');
      if (!parsed.resources || !parsed.deliveries || !parsed.operations) throw new Error('shape');
      for (const record of Object.values(parsed.resources)) validateResourceRecord(publicRecord(record));
      for (const delivery of Object.values(parsed.deliveries)) validateArtifactDelivery(publicDelivery(delivery));
      return parsed;
    } catch (cause) {
      throw new BookError('corrupt_data', `无法读取本地资源索引：${this.file}`, { cause });
    }
  }

  private write(): void {
    const stored = JSON.stringify(this.data);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(fd, `${stored}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    replaceResourceFile(temporary, this.file);
  }

  private blobPath(sha: string): string {
    return join(this.blobRoot, `${sha}.bin`);
  }

  stageTurn(scope:BookScope,turn:SavedTurn,configRevision:number){(this.data.completedTurns??={})[resourceKey(scope,turn.id)]={scope:structuredClone(scope),turn:structuredClone(turn),configRevision};this.write();}
  pendingTurn(scope:BookScope,id:string){const row=this.data.completedTurns?.[resourceKey(scope,id)];return row&&sameScope(row.scope,scope)?structuredClone(row):undefined;}
  acknowledgeTurn(scope:BookScope,id:string){if(this.data.completedTurns?.[resourceKey(scope,id)]){delete this.data.completedTurns[resourceKey(scope,id)];this.write();}}
  /** Owner-validated lookup: a record from another scope is reported as missing, never as forbidden. */
  get(scope: BookScope, resourceId: string): ResourceRecord {
    return publicRecord(this.owned(scope, resourceId));
  }
  list(scope:BookScope):ResourceRecord[]{return Object.values(this.data.resources).filter(row=>sameScope(row.scope,scope)&&(!row.origin.parentResourceId||this.data.resources[row.origin.parentResourceId]?.state==='ready')).slice(-256).reverse().map(publicRecord);}

  private owned(scope: BookScope, resourceId: string, allowUnavailableParent=false): StoredResource {
    const stored = this.data.resources[resourceId];
    if (!stored || !sameScope(stored.scope, scope)) throw new BookError('not_found', '没有这个资源。');
    if(stored.origin.parentResourceId&&!allowUnavailableParent){const parent=this.data.resources[stored.origin.parentResourceId];if(!parent||!sameScope(parent.scope,scope)||parent.state!=='ready')throw new BookError('not_found','资源包已不可用。');}
    return stored;
  }

  readBytes(scope: BookScope, resourceId: string): Uint8Array {
    const stored = this.owned(scope, resourceId);
    if (stored.state !== 'ready' || !stored.sha256) throw new BookError('not_found', '该资源当前不可读取。');
    const path = this.blobPath(stored.sha256);
    if (!existsSync(path)) throw new BookError('corrupt_data', '资源字节已丢失，未返回旧内容。');
    const bytes = readFileSync(path);
    if (sha256(bytes) !== stored.sha256) throw new BookError('corrupt_data', '资源字节与记录哈希不一致，已拒绝返回。');
    return bytes;
  }

  getDelivery(scope: BookScope, deliveryId: string): ArtifactDelivery {
    const stored = this.data.deliveries[deliveryId];
    if (!stored || !sameScope(stored.scope, scope)) throw new BookError('not_found', '没有这个交付记录。');
    return publicDelivery(stored);
  }

  deliveryEntries(deliveryId: string): StoredEntry[] {
    const stored = this.data.deliveries[deliveryId];
    return stored ? stored.entries.map(entry => ({ ...entry })) : [];
  }

  findMember(scope:BookScope,parent:string,path:string):ResourceRecord|undefined{return Object.values(this.data.resources).find(row=>sameScope(row.scope,scope)&&row.origin.parentResourceId===parent&&row.origin.memberPath===path&&row.state==='ready');}
  listForTurn(scope: BookScope, turnId: string): ResourceRecord[] {
    const ids = new Set(Object.values(this.data.deliveries).filter(row => sameScope(row.scope, scope) && row.turnId === turnId).flatMap(row => row.resourceIds));
    return Object.values(this.data.resources)
      .filter(record => sameScope(record.scope, scope) && (ids.has(record.id) || record.origin.requestId === turnId))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(publicRecord);
  }

  private operationKey(scope: BookScope, kind: string, operationId: string): string {
    return sha256(Buffer.from(JSON.stringify([scope.characterId, scope.pairingId, scope.sessionId, kind, operationId]), 'utf8'));
  }

  /**
   * Idempotency (contract §5): the same operationId with the same payload replays the stored result
   * without re-fetching or re-uploading; the same id with a different payload conflicts.
   */
  private beginOperation(scope: BookScope, kind: string, operationId: string, fingerprint: string): OperationRecord | null {
    const key = this.operationKey(scope, kind, operationId);
    const existing = this.data.operations[key];
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) throw conflict('同一操作编号的请求内容发生变化。');
    return existing;
  }

  private commitOperation(scope: BookScope, kind: string, operationId: string, fingerprint: string, result: OperationRecord['result']): void {
    this.data.operations[this.operationKey(scope, kind, operationId)] = { fingerprint, result };
  }

  private static fingerprintOf(value: unknown): string {
    return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
  }

  /** Creates a delivery with its pending resources. Nothing is published to the UI before this. */
  createDelivery(input: CreateDeliveryInput, operationId: string): ArtifactDelivery {
    const fingerprint = FileResourceStore.fingerprintOf({
      kind: 'delivery',
      scope: input.scope,
      turnId: input.turnId,
      discovery: input.discovery,
      candidates: input.candidates.map(candidate => [candidate.handleId, candidate.nameHint, candidate.mimeHint ?? null, candidate.messageId])
    });
    const replayed = this.beginOperation(input.scope, 'delivery', operationId, fingerprint);
    if (replayed) return this.getDelivery(input.scope, replayed.result.id);

    const id = `dlv-${randomUUID()}`;
    const createdAt = this.now().toISOString();
    const entries: StoredEntry[] = [];
    const resourceIds: string[] = [];
    for (const candidate of input.candidates) {
      const resourceId = `res-${randomUUID()}`;
      const record: StoredResource = {
        schemaVersion: RESOURCE_SCHEMA,
        id: resourceId,
        scope: { ...input.scope },
        revision: 0,
        name: candidate.nameHint.slice(0, 160),
        kind: 'unknown',
        state: 'pending',
        mime: null,
        bytes: null,
        sha256: null,
        createdAt,
        receivedAt: null,
        origin: {
          kind: 'provider',
          requestId: input.requestId??input.turnId,
          ...(input.conversationId?{conversationId:input.conversationId}:{}),
          messageId: candidate.messageId
        },
        blob: null
      };
      validateResourceRecord(publicRecord(record));
      this.data.resources[resourceId] = record;
      resourceIds.push(resourceId);
      entries.push({
        candidateId: candidate.handleId,
        nameHint: candidate.nameHint,
        messageId: candidate.messageId,
        ...(candidate.mimeHint ? { mimeHint: candidate.mimeHint } : {})
      });
    }
    const delivery: StoredDelivery = {
      schemaVersion: ARTIFACT_DELIVERY_SCHEMA,
      id,
      scope: { ...input.scope },
      turnId: input.turnId,
      revision: 0,
      resourceIds,
      discovery: input.discovery,
      entries,
      ...(input.error ? { error: failure(input.error.code, input.error.message) } : {})
    };
    validateArtifactDelivery(publicDelivery(delivery));
    this.data.deliveries[id] = delivery;
    this.data.revision += 1;
    this.commitOperation(input.scope, 'delivery', operationId, fingerprint, { kind: 'delivery', id });
    this.write();
    return publicDelivery(delivery);
  }

  /** Marks one delivery resource as actively receiving (no bytes yet). */
  markReceiving(scope: BookScope, resourceId: string): ResourceRecord {
    const stored = this.owned(scope, resourceId);
    if(stored.state==='revoked')throw new BookError('not_found','该资源已撤销。');
    if (stored.state === 'ready') return publicRecord(stored);
    stored.state = 'receiving';
    stored.revision += 1;
    this.data.revision += 1;
    this.write();
    return publicRecord(stored);
  }

  /**
   * Publishes verified bytes. Content addressing deduplicates storage while every record keeps its
   * own identity and scope, so equal hashes never widen access (contract §2).
   */
  receiveBytes(input: ReceiveBytesInput, operationId?: string): ResourceRecord {
    const stored = this.owned(input.scope, input.resourceId);
    const digest = sha256(input.bytes);
    const fingerprint = FileResourceStore.fingerprintOf({ kind: 'bytes', resourceId: input.resourceId, sha256: digest, mime: input.mime });
    if (operationId) {
      const replayed = this.beginOperation(input.scope, 'bytes', operationId, fingerprint);
      if (replayed) return this.get(input.scope, replayed.result.id);
    }
    if (input.expectedSha256 && input.expectedSha256 !== digest) {
      stored.state = 'failed';
      stored.error = failure('corrupt_data', '接收到的字节与声明的哈希不一致。');
      stored.revision += 1;
      this.data.revision += 1;
      this.write();
      throw new BookError('invalid_input', '接收到的字节与声明的哈希不一致，未发布。');
    }
    if (stored.state === 'revoked') throw conflict('资源已撤销，不能再发布内容。');

    const path = this.blobPath(digest);
    if (!existsSync(path)) {
      const temporary = `${path}.${randomUUID()}.part`;
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeSync(fd, input.bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
    }
    stored.kind = input.kind;
    stored.state = 'ready';
    stored.mime = input.mime;
    stored.bytes = input.bytes.byteLength;
    stored.sha256 = digest;
    stored.receivedAt = this.now().toISOString();
    stored.blob = path;
    delete stored.error;
    stored.revision += 1;
    this.data.revision += 1;
    if (operationId) this.commitOperation(input.scope, 'bytes', operationId, fingerprint, { kind: 'resource', id: stored.id });
    this.write();
    return publicRecord(stored);
  }

  /** Records a terminal failure for one resource without touching its delivery's other items. */
  failResource(scope: BookScope, resourceId: string, code: ResourceFailureCode, message: string): ResourceRecord {
    const stored = this.owned(scope, resourceId);
    if (stored.state === 'ready' || stored.state === 'revoked') return publicRecord(stored);
    stored.state = 'failed';
    stored.error = failure(code, message);
    stored.revision += 1;
    this.data.revision += 1;
    this.write();
    return publicRecord(stored);
  }

  /** Rejects a resource as an unsupported type, keeping the reason visible to the UI. */
  markUnsupported(scope: BookScope, resourceId: string, message: string): ResourceRecord {
    const stored = this.owned(scope, resourceId);
    if (stored.state === 'ready' || stored.state === 'revoked') return publicRecord(stored);
    stored.state = 'unsupported';
    stored.error = failure('unsupported', message);
    stored.revision += 1;
    this.data.revision += 1;
    this.write();
    return publicRecord(stored);
  }

  /** Adds a locally received resource (upload or captured URL) directly as pending, then ready. */
  createLocalResource(input: {
    scope: BookScope;
    name: string;
    origin: ResourceRecord['origin'];
  }): ResourceRecord {
    const id = `res-${randomUUID()}`;
    const record: StoredResource = {
      schemaVersion: RESOURCE_SCHEMA,
      id,
      scope: { ...input.scope },
      revision: 0,
      name: input.name.slice(0, 160),
      kind: 'unknown',
      state: 'pending',
      mime: null,
      bytes: null,
      sha256: null,
      createdAt: this.now().toISOString(),
      receivedAt: null,
      origin: input.origin,
      blob: null
    };
    validateResourceRecord(publicRecord(record));
    this.data.resources[id] = record;
    this.data.revision += 1;
    this.write();
    return publicRecord(record);
  }

  /** Replays a local (upload/URL) operation without repeating the network or the upload. */
  replayOperation(scope: BookScope, kind: string, operationId: string, payload: unknown): ResourceRecord | null {
    const fingerprint = FileResourceStore.fingerprintOf(payload);
    const replayed = this.beginOperation(scope, kind, operationId, fingerprint);
    if (!replayed) return null;
    return this.get(scope, replayed.result.id);
  }

  commitLocalOperation(scope: BookScope, kind: string, operationId: string, payload: unknown, resourceId: string): void {
    this.commitOperation(scope, kind, operationId, FileResourceStore.fingerprintOf(payload), { kind: 'resource', id: resourceId });
    this.data.revision += 1;
    this.write();
  }

  /** Replays a delivery-scoped operation (e.g. retry) without repeating provider reads. */
  replayDeliveryOperation(scope: BookScope, kind: string, operationId: string, payload: unknown): ArtifactDelivery | null {
    const replayed = this.beginOperation(scope, kind, operationId, FileResourceStore.fingerprintOf(payload));
    if (!replayed) return null;
    return this.getDelivery(scope, replayed.result.id);
  }

  commitDeliveryOperation(scope: BookScope, kind: string, operationId: string, payload: unknown, deliveryId: string): void {
    this.commitOperation(scope, kind, operationId, FileResourceStore.fingerprintOf(payload), { kind: 'delivery', id: deliveryId });
    this.data.revision += 1;
    this.write();
  }

  bumpDelivery(scope: BookScope, deliveryId: string): ArtifactDelivery {
    const stored = this.data.deliveries[deliveryId];
    if (!stored || !sameScope(stored.scope, scope)) throw new BookError('not_found', '没有这个交付记录。');
    stored.revision += 1;
    this.data.revision += 1;
    this.write();
    return publicDelivery(stored);
  }

  /** Cancels only the pending/receiving members of one delivery; ready items stay intact (§5). */
  cancelReceive(scope: BookScope, deliveryId: string, expectedRevision: number, operationId: string): ArtifactDelivery {
    const stored = this.data.deliveries[deliveryId];
    if (!stored || !sameScope(stored.scope, scope)) throw new BookError('not_found', '没有这个交付记录。');
    const fingerprint = FileResourceStore.fingerprintOf({ kind: 'cancel', deliveryId, expectedRevision });
    const replayed = this.beginOperation(scope, 'cancel', operationId, fingerprint);
    if (replayed) return this.getDelivery(scope, deliveryId);
    if (stored.revision !== expectedRevision) throw conflict('交付记录已变化，请回读当前状态。');
    for (const resourceId of stored.resourceIds) {
      const record = this.data.resources[resourceId];
      if (!record || (record.state !== 'pending' && record.state !== 'receiving')) continue;
      record.state = 'failed';
      record.error = failure('cancelled', '接收已取消。');
      record.revision += 1;
    }
    stored.revision += 1;
    this.data.revision += 1;
    this.commitOperation(scope, 'cancel', operationId, fingerprint, { kind: 'delivery', id: deliveryId });
    this.write();
    return publicDelivery(stored);
  }

  /** True when some other live record still references these bytes. */
  private blobStillReferenced(sha: string, exceptResourceId: string): boolean {
    return Object.values(this.data.resources).some(record => record.id !== exceptResourceId && record.sha256 === sha && record.state === 'ready');
  }

  /**
   * Revocation (§8): stop reads first, keep a bodyless tombstone so a late background receipt can
   * never restore the file, then release the blob only when nothing else references it.
   */
  revoke(scope: BookScope, resourceId: string, expectedRevision: number, operationId: string): ResourceRecord {
    const stored = this.owned(scope, resourceId, true);
    const fingerprint = FileResourceStore.fingerprintOf({ kind: 'revoke', resourceId, expectedRevision });
    const replayed = this.beginOperation(scope, 'revoke', operationId, fingerprint);
    if (replayed) return publicRecord(stored);
    if (stored.revision !== expectedRevision) throw conflict('资源已变化，请回读当前状态。');
    const sha = stored.sha256;
    stored.state = 'revoked';
    stored.mime = null;
    stored.bytes = null;
    stored.sha256 = null;
    stored.blob = null;
    stored.receivedAt = null;
    stored.error = failure('cancelled', '资源已撤销。');
    stored.revision += 1;
    this.data.revision += 1;
    this.commitOperation(scope, 'revoke', operationId, fingerprint, { kind: 'resource', id: resourceId });
    // Persist the read barrier before any physical cleanup; a failed unlink must not restore access.
    this.write();
    for (const child of Object.values(this.data.resources)) {
      if (sameScope(child.scope,scope)&&child.origin.parentResourceId===resourceId&&child.state!=='revoked') this.revoke(scope,child.id,child.revision,sha256(Buffer.from(operationId+'\0'+child.id)));
    }
    if (sha && !this.blobStillReferenced(sha, resourceId)) {
      const path = this.blobPath(sha);
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
    return publicRecord(stored);
  }

  /** Read-only erasure planning, including revoked origins needed by journal replay. */
  resourcesForTurn(scope: BookScope, turnId: string): string[] {
    const originating=new Set(Object.values(this.data.deliveries).filter(row=>sameScope(row.scope,scope)&&row.turnId===turnId).flatMap(row=>row.resourceIds));
    for (const record of Object.values(this.data.resources)) if(sameScope(record.scope,scope)&&record.origin.requestId===turnId)originating.add(record.id);
    let added=true;while(added){added=false;for(const record of Object.values(this.data.resources))if(sameScope(record.scope,scope)&&record.origin.parentResourceId&&originating.has(record.origin.parentResourceId)&&!originating.has(record.id)){originating.add(record.id);added=true;}}
    return [...originating];
  }
  /**
   * Erases every resource that belongs to one conversation turn (the existing 「清除原始聊天」 path).
   * Returns the ids that were affected so the caller can report honestly.
   */
  revokeForTurn(scope: BookScope, turnId: string): string[] {
    const affected: string[] = [];
    const released = new Set<string>();
    const originating=new Set(this.resourcesForTurn(scope,turnId));
    for (const record of Object.values(this.data.resources)) {
      if (!sameScope(record.scope, scope) || !originating.has(record.id) && record.origin.requestId !== turnId || record.state === 'revoked') continue;
      const sha = record.sha256;
      record.state = 'revoked';
      record.mime = null;
      record.bytes = null;
      record.sha256 = null;
      record.blob = null;
      record.receivedAt = null;
      record.error = failure('cancelled', '来源轮次已清除。');
      record.revision += 1;
      affected.push(record.id);
      if (sha) released.add(sha);
    }
    const pendingKey=resourceKey(scope,turnId),hadPending=Boolean(this.data.completedTurns?.[pendingKey]);
    if(hadPending)delete this.data.completedTurns![pendingKey];
    if (affected.length||hadPending) {
      this.data.revision += 1;
      this.write();
      for (const sha of released) {
        if (!this.blobStillReferenced(sha, '')) {
          const path = this.blobPath(sha);
          if (existsSync(path)) unlinkSync(path);
        }
      }
    }
    // Include already revoked origins during erasure-journal replay so derived-source cleanup
    // can recover if its previous commit was interrupted after the bytes were revoked.
    return [...originating];
  }

  /** Removes unreferenced blobs older than the retention window (SPEC §7, 24h). */
  revokeCharacter(characterId: string): void {
    const released = new Set<string>();
    for (const record of Object.values(this.data.resources)) {
      if (record.scope.characterId !== characterId || record.state === 'revoked') continue;
      if (record.sha256) released.add(record.sha256);
      Object.assign(record, {state:'revoked',mime:null,bytes:null,sha256:null,blob:null,receivedAt:null,error:failure('cancelled','角色已移除。'),revision:record.revision+1});
    }
    for (const [id, pending] of Object.entries(this.data.completedTurns ?? {})) {
      if (pending.scope.characterId === characterId) delete this.data.completedTurns![id];
    }
    this.data.revision++; this.write();
    for (const sha of released) {
      if (!this.blobStillReferenced(sha, '')) { const path=this.blobPath(sha); if(existsSync(path))unlinkSync(path); }
    }
  }

  sweep(now: Date = this.now(), retentionMs = 24 * 60 * 60 * 1000): number {
    let removed = 0;
    for (const record of Object.values(this.data.resources)) {
      if (record.state !== 'pending' && record.state !== 'receiving') continue;
      if (now.getTime() - Date.parse(record.createdAt) < retentionMs) continue;
      record.state = 'expired';
      record.error = failure('expired', '未使用的暂存资源已过期。');
      record.revision += 1;
      removed += 1;
    }
    if (removed) {
      this.data.revision += 1;
      this.write();
    }
    const referenced=new Set(Object.values(this.data.resources).filter(row=>row.state==='ready').map(row=>row.sha256));
    for(const root of [this.directory,this.blobRoot])for(const name of readdirSync(root)){
      const temporary=root===this.directory?/^resource-store\.json\.[a-f0-9-]+\.tmp$/.test(name):/^[a-f0-9]{64}\.bin\.[a-f0-9-]+\.part$/.test(name);
      const orphan=root===this.blobRoot&&/^[a-f0-9]{64}\.bin$/.test(name)&&!referenced.has(name.slice(0,64));
      if(!temporary&&!orphan)continue;
      const path=join(root,name),info=lstatSync(path);if(!info.isFile()||now.getTime()-info.mtimeMs<retentionMs)continue;
      unlinkSync(path);removed++;
    }
    return removed;
  }

  /** Diagnostic counter used by tests and the delivery report; never exposed over HTTP. */
  stats(): { revision: number; resources: number; deliveries: number } {
    return { revision: this.data.revision, resources: Object.keys(this.data.resources).length, deliveries: Object.keys(this.data.deliveries).length };
  }
}

export { sha256 as resourceSha256, dirname as resourceDirname };

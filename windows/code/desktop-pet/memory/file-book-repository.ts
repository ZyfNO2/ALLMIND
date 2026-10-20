import {replaceResourceFile} from './resource-atomic-replace.js';
import {validateFrozenResourceSelection,resourceRequestHash} from '../contracts/book-resources.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, unlinkSync, appendFileSync, readdirSync, statSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BookError, DEFAULT_RECALL_CONFIG, DEFAULT_CHATGPT_WEB_SOURCE, type BookRepository, type BookSnapshot, type BookScope, type BookChange, type EntryRef, type CommitReceipt, type FrozenTurn, type RuntimeRepository, type RuntimeConfig, type SavedTurn, type SessionSummary } from '../contracts/memory-book.js';
import { validateEntry, validateIdentity, validateRuntime, validateScope, entryVisible, validateWikiSource, validateFactSources, validateFrozenTurn } from './book-validation.js';
import { validateCompanionLife, type CompanionLifeState } from '../core/companion-behavior.js';
import { emptyCompanionData, validateCompanionData, type CompanionData } from '../contracts/book-companion.js';
import { compilePersonalWiki,validatePersonalWikiPages,usablePersonalWikiPages } from './personal-wiki.js';
import { packBook, unpackBook, archiveCounts, BOOK_RECORD_LIMIT } from './book-archives.js';
import { compileRelationships,validateRelationships } from '../core/companion-relationship.js';
import {measureReplyLength} from '../core/reply-length.js';
import {validateReplyStyleDecision} from '../contracts/reply-length.js';
import {reportedEventIdentity} from './companion-event-progress.js';

function rememberErasedReport(data:CompanionData,entry:BookSnapshot['entries'][number],sources:NonNullable<BookSnapshot['wikiSources']>,timezone:string):void{
  if(!entry.fact?.predicate.startsWith('事件进展 '))return;
  const capturedAt=sources.find(source=>source.id===entry.fact!.sourceId)?.snapshots.find(snapshot=>snapshot.hash===entry.fact!.sourceHash)?.capturedAt;
  if(!capturedAt)throw new BookError('invalid_input','事件报告缺少原始时间来源。');
  const zone=data.events.flatMap(event=>event.reportedTimeline??[]).find(row=>row.entryId===entry.id)?.occurrence?.timezone??timezone;
  const key='report:'+reportedEventIdentity(entry.fact.quote,capturedAt,zone);if(!data.forgottenKeys.includes(key))data.forgottenKeys.push(key);
}

/** Clear derived model prose when its canonical evidence is erased or revoked. */
function pruneWikiDrafts(data:CompanionData,entries:BookSnapshot['entries'],sources:NonNullable<BookSnapshot['wikiSources']>):void{
  for(const job of data.wikiJobs??[]){
    const invalid=new Set(job.targets.filter(target=>target.basisRefs.some(ref=>!entries.some(entry=>entry.id===ref.entryId&&entry.fact&&!sources.find(source=>source.id===entry.fact!.sourceId)?.forgottenKeys.includes(entry.fact!.key)))||target.sources.some(ref=>!sources.some(source=>source.id===ref.id&&source.enabled&&source.snapshots.some(snapshot=>snapshot.hash===ref.hash)))).map(target=>target.pageId));
    if(!invalid.size)continue;
    job.results=job.results.filter(result=>!invalid.has(result.pageId));
    if(job.status!=='applied'||!job.results.length){job.status='cancelled';job.results=[];}
    job.error='依据已遗忘或撤销，相关编纂内容已清理。';job.updatedAt=new Date().toISOString();
  }
}

/** Archived missing refs remain opaque; existing private refs must belong to this owner. */
function validateWikiJobOwnership(data:CompanionData,book:BookSnapshot):void{
  if(!data.wikiJobs?.length)return;
  const entries=new Map(book.entries.map(entry=>[entry.id,entry])),sources=new Map((book.wikiSources??[]).map(source=>[source.id,source])),pages=new Map((book.wikiPages??[]).map(page=>[page.id,page]));
  for(const job of data.wikiJobs){
    if(job.scope.characterId!==book.characterId)throw new BookError('invalid_input','编纂任务属于其他角色。');
    for(const target of job.targets){
      const page=pages.get(target.pageId);
      if(page&&page.pairingId!==data.pairingId||target.basisRefs.some(ref=>entries.has(ref.entryId)&&entries.get(ref.entryId)!.pairingId!==data.pairingId)||target.sources.some(ref=>sources.has(ref.id)&&sources.get(ref.id)!.pairingId!==data.pairingId))throw new BookError('invalid_input','编纂依据属于其他配对，拒绝保存或读取。');
    }
  }
}

/** Validate the final ledger before replacing a readable snapshot. */
function validateCompanionSnapshot(book: BookSnapshot): void {
  if (book.companionData === undefined) return;
  if (!Array.isArray(book.companionData)) throw new BookError('invalid_input', '陪伴账本列表无效。');
  if (book.companionData.length > 64) throw new BookError('budget', '角色陪伴实例已达 64 个上限。');
  const pairs = new Set<string>();
  for (const data of book.companionData) {
    validateCompanionData(data); validateWikiJobOwnership(data, book);
    if (pairs.has(data.pairingId)) throw new BookError('invalid_input', '陪伴账本含重复配对。');
    pairs.add(data.pairingId);
  }
}

// Only absent fields from the older on-disk schema receive defaults. Invalid
// explicit values still fail validation; live PUTs must supply the full schema.
function validateStoredRuntime(config: RuntimeConfig): void {
  if (config?.chatgptWeb && typeof config.chatgptWeb === 'object') {
    if (!Object.hasOwn(config.chatgptWeb, 'temporaryChatTests')) config.chatgptWeb.temporaryChatTests = DEFAULT_CHATGPT_WEB_SOURCE.temporaryChatTests;
    if (!Object.hasOwn(config.chatgptWeb, 'submitMechanism')) config.chatgptWeb.submitMechanism = DEFAULT_CHATGPT_WEB_SOURCE.submitMechanism;
  }
  validateRuntime(config);
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface Envelope<T> { data: T; operations: Record<string, { fingerprint: string; receipt: CommitReceipt }> }
/** Derive the display title of a session from its first user message. Shared derivation, not a stored field. */
export function deriveSessionTitle(text: unknown): string {
  if (typeof text !== 'string') return '未命名会话';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '未命名会话';
  return collapsed.length > 48 ? `${collapsed.slice(0, 48)}…` : collapsed;
}
/** Session listing bounds: whole-file reads up to 8 MiB, head/tail windows of 1 MiB beyond that. */
const SESSION_FULL_READ_LIMIT = 8 * 1024 * 1024, SESSION_EDGE_READ = 1024 * 1024, SESSION_LIST_LIMIT = 256;
/** Durable terminal markers for failed/cancelled/timed-out turn IDs; bodies are never stored. */
const TURN_FREEZE_SCHEMA = 'memory-book-turn-freezes/v1', TURN_FREEZE_LIMIT = 1024;
/** Single-process writer: lock held for lifetime, atomic snapshots and fsynced receipts. */
export class FileBookRepository implements BookRepository, RuntimeRepository {
  readonly directory: string;
  private lockFd: number | null = null;
  constructor(directory: string, private readonly lifecycle: {resourcesForErase?:(scope:BookScope,turnIds:string[])=>string[];onErase?:(scope:BookScope,turnIds:string[])=>void} = {}) {
    this.directory = resolve(directory); mkdirSync(this.directory, { recursive: true });
    try { this.lockFd = openSync(join(this.directory, 'writer.lock'), 'wx'); }
    catch (cause) { throw new BookError('busy', `本地目录已有写者或未清理的锁：${this.directory}。请确认旧进程退出后处理 writer.lock。`, { cause }); }
    writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); fsyncSync(this.lockFd);
    const journal = join(this.directory, 'erasure.json');
    if (existsSync(journal)) { const pending = JSON.parse(readFileSync(journal,'utf8')); this.eraseTurns(pending.scope,pending.turnIds,pending.expectedRevision,true); }
  }
  close(): void {
    if (this.lockFd === null) return;
    closeSync(this.lockFd); this.lockFd = null; unlinkSync(join(this.directory, 'writer.lock'));
  }
  private assertOpen(): void { if (this.lockFd === null) throw new BookError('unavailable', '文件适配已经关闭。'); }
  private readEnvelope<T>(file: string, empty: () => T, validate: (value: T) => void): Envelope<T> {
    this.assertOpen();
    if (!existsSync(file)) return { data: empty(), operations: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Envelope<T>;
      if (!parsed || !parsed.operations || typeof parsed.operations !== 'object' || Array.isArray(parsed.operations)) throw Error('Missing receipt ledger');
      if ((parsed.data as BookSnapshot)?.schemaVersion === 'memory-book/v1') parsed.data = unpackBook(parsed.data as BookSnapshot) as T;
      validate(parsed.data); return parsed;
    } catch (cause) { throw new BookError('corrupt_data', `无法读取本地快照：${file}`, { cause }); }
  }
  private write<T>(file: string, data: Envelope<T>): void {
    this.assertOpen();
    if ((data.data as BookSnapshot)?.schemaVersion === 'memory-book/v1') validateCompanionSnapshot(data.data as BookSnapshot);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { const stored = (data.data as BookSnapshot)?.schemaVersion === 'memory-book/v1' ? { ...data, data: packBook(data.data as BookSnapshot) } : data; writeFileSync(fd, JSON.stringify(stored) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    // Preserve a failed temporary file for diagnosis; never report a failed replace as committed.
    replaceResourceFile(temporary, file);
  }
  private bookFile(scope: BookScope): string { validateScope(scope); return join(this.directory, `book-${digest(scope.characterId)}.json`); }
  private book(scope: BookScope): Envelope<BookSnapshot> {
    return this.readEnvelope<BookSnapshot>(this.bookFile(scope), () => ({ schemaVersion: 'memory-book/v1', characterId: scope.characterId, revision: 0, entries: [] }), value => {
      if (!value || value.schemaVersion !== 'memory-book/v1' || value.characterId !== scope.characterId || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries) || value.entries.length > BOOK_RECORD_LIMIT) throw Error('Invalid Book');
      const seen = new Set<string>();
      for (const entry of value.entries) { validateEntry(entry); if (seen.has(entry.id)) throw Error('Duplicate Entry'); seen.add(entry.id); }
      if (value.wikiSources) {
        if (!Array.isArray(value.wikiSources) || value.wikiSources.length > BOOK_RECORD_LIMIT) throw Error('Invalid Wiki sources');
        const sourceIds = new Set<string>();
        for (const source of value.wikiSources) { validateWikiSource(source); if (sourceIds.has(source.id)) throw Error('Duplicate source'); sourceIds.add(source.id); }
      }
      validateFactSources(value.entries, value.wikiSources ?? []);
      if(value.wikiPages!==undefined)validatePersonalWikiPages(value.wikiPages,value.characterId);
      if(value.relationships!==undefined)validateRelationships(value.relationships);
      validateCompanionSnapshot(value);
      if (value.companionStates !== undefined) {
        if (!Array.isArray(value.companionStates) || value.companionStates.length > 64) throw Error('Invalid companion states');
        const pairings = new Set<string>();
        for (const state of value.companionStates) {
          validateCompanionLife(state);
          if (state.characterId !== scope.characterId || pairings.has(state.pairingId)) throw Error('Invalid companion owner');
          pairings.add(state.pairingId);
        }
      }
    });
  }
  snapshot(scope: BookScope): BookSnapshot {
    const data = this.book(scope).data;
    const scoped = { ...data, entries: data.entries.filter(entry => entry.pairingId === null || entry.pairingId === scope.pairingId),
      ...(data.wikiPages?{wikiPages:data.wikiPages.filter(page=>page.pairingId===scope.pairingId)}:{}),
      ...(data.relationships?{relationships:data.relationships.filter(row=>row.pairingId===scope.pairingId)}:{}),
      ...(data.companionData ? { companionData: data.companionData.filter(state => state.pairingId === scope.pairingId) } : {}),
      ...(data.companionStates ? { companionStates: data.companionStates.filter(state => state.pairingId === scope.pairingId) } : {}),
      ...(data.wikiSources ? { wikiSources: data.wikiSources.filter(source => source.pairingId === null || source.pairingId === scope.pairingId) } : {}) };
    return structuredClone({ ...scoped, archiveCounts: archiveCounts(scoped) });
  }
  loadCompanionLife(scope: BookScope): CompanionLifeState | null {
    return structuredClone(this.book(scope).data.companionStates?.find(state => state.pairingId === scope.pairingId) ?? null);
  }
  loadCompanionData(scope: BookScope): CompanionData {
    return structuredClone(this.book(scope).data.companionData?.find(data => data.pairingId === scope.pairingId) ?? emptyCompanionData(scope.pairingId));
  }
  hasBookOperation(scope:BookScope,operationId:string):boolean {validateIdentity(operationId);return Object.hasOwn(this.book(scope).operations,operationId);}
  saveCompanionData(scope: BookScope, data: CompanionData): CompanionData {
    validateCompanionData(data);
    if(data.wikiJobs?.some(job=>job.scope.characterId!==scope.characterId))throw new BookError('invalid_input','编纂任务属于其他角色。');
    const envelope = this.book(scope), rows = envelope.data.companionData ?? [];
    validateWikiJobOwnership(data,envelope.data);
    if (data.pairingId !== scope.pairingId || (rows.find(row => row.pairingId === scope.pairingId)?.revision ?? 0) !== data.revision) throw new BookError('conflict', '陪伴账本修订冲突。');
    const saved = { ...structuredClone(data), revision: data.revision + 1 };
    const eventsChanged=JSON.stringify(rows.find(row=>row.pairingId===scope.pairingId)?.events??[])!==JSON.stringify(saved.events);
    envelope.data.companionData = [...rows.filter(row => row.pairingId !== scope.pairingId), saved];
    if(eventsChanged||envelope.data.wikiPages===undefined){const pages=compilePersonalWiki(envelope.data);
      if(JSON.stringify(pages)!==JSON.stringify(envelope.data.wikiPages??[])){envelope.data.wikiPages=pages;envelope.data.revision++;}}
    this.write(this.bookFile(scope), envelope); return structuredClone(saved);
  }
  saveCompanionLife(scope: BookScope, proposed: CompanionLifeState, expectedRevision: number): CompanionLifeState {
    const envelope = this.book(scope);
    try { validateCompanionLife(proposed); } catch (cause) { throw new BookError('invalid_input', '桌宠生活状态无效。', { cause }); }
    if (proposed.characterId !== scope.characterId || proposed.pairingId !== scope.pairingId) throw new BookError('invalid_input', '生活状态不属于当前角色实例。');
    const current = envelope.data.companionStates ?? [], previous = current.find(state => state.pairingId === scope.pairingId);
    if ((previous?.revision ?? 0) !== expectedRevision) throw new BookError('conflict', '生活状态版本已变化。');
    if (!previous && current.length >= 64) throw new BookError('budget', '角色生活实例已达上限。');
    const saved = { ...structuredClone(proposed), revision: expectedRevision + 1 };
    envelope.data.companionStates = [...current.filter(state => state.pairingId !== scope.pairingId), saved];
    this.write(this.bookFile(scope), envelope); return structuredClone(saved);
  }
  read(scope: BookScope, refs: EntryRef[]): { entry: import('../contracts/memory-book.js').BookEntry; chunkId: string }[] {
    const snapshot = this.snapshot(scope);
    return refs.map(ref => {
      const entry = snapshot.entries.find(item => item.id === ref.entryId);
      if (!entry || !entryVisible(entry, scope)) throw new BookError('not_found', `条目不存在或不可用：${ref.entryId}`);
      if (entry.revision !== ref.revision) throw new BookError('conflict', `条目已修改：${ref.entryId}`);
      return { entry, chunkId: ref.chunkId };
    });
  }
  commit(scope: BookScope, changes: BookChange, expectedRevision: number, operationId: string): CommitReceipt {
    validateIdentity(operationId, 'operationId');
    const envelope = this.book(scope), fingerprint = digest(JSON.stringify({ scope: { characterId: scope.characterId, pairingId: scope.pairingId }, changes, expectedRevision }));
    const prior = Object.hasOwn(envelope.operations, operationId) ? envelope.operations[operationId] : undefined;
    if (prior) { if (prior.fingerprint !== fingerprint) throw new BookError('conflict', '同一 operationId 的提交内容发生变化。'); return structuredClone(prior.receipt); }
    if (envelope.data.revision !== expectedRevision) throw new BookError('conflict', 'Book 已修改，请回读当前版本。');
    const entries = new Map(envelope.data.entries.map(entry => [entry.id, entry]));
    const data = structuredClone(envelope.data.companionData?.find(row => row.pairingId === scope.pairingId) ?? emptyCompanionData(scope.pairingId));
    const sources = new Map((envelope.data.wikiSources ?? []).map(source => [source.id, structuredClone(source)]));
    const previousSourceIds = new Set(sources.keys());
    const changedIds = new Set<string>();
    if(changes.wikiApproval){
      const approval=changes.wikiApproval;
      if(approval.confirmed!==true||changes.upsert?.length||changes.remove?.length||changes.wikiSources?.length||changes.relearn)throw new BookError('invalid_input','编纂草稿须单独明确确认。');
      const job=data.wikiJobs?.find(row=>row.id===approval.jobId&&row.scope.characterId===scope.characterId&&row.scope.pairingId===scope.pairingId);
      if(!job||job.status!=='review'||job.results.length!==job.targets.length)throw new BookError('conflict','没有完整可应用的编纂草稿。');
      const current=usablePersonalWikiPages(envelope.data,scope);
      if(job.targets.some(target=>!current.some(page=>page.id===target.pageId&&page.compilationInputHash===target.inputHash&&JSON.stringify(page.basisRefs)===JSON.stringify(target.basisRefs)&&JSON.stringify(page.sources)===JSON.stringify(target.sources))))throw new BookError('conflict','编纂来源或固定内容已变化，请重新生成。');
      validateCompanionData(data);
      job.status='applied';job.updatedAt=new Date().toISOString();job.error=null;
      changedIds.add(`wiki-job.${job.id}`);
    }
    const sourceIds = new Set<string>();
    for (const source of changes.wikiSources ?? []) {
      validateWikiSource(source);
      if (sourceIds.has(source.id)) throw new BookError('invalid_input', '重复来源。'); sourceIds.add(source.id);
      const previous = sources.get(source.id);
      if (source.pairingId !== null && source.pairingId !== scope.pairingId || previous && previous.pairingId !== source.pairingId) throw new BookError('conflict', '来源属于其他作用域。');
      if (previous && (!previous.enabled && source.enabled || previous.forgottenKeys.some(key => !source.forgottenKeys.includes(key)) || previous.snapshots.some(old => !source.snapshots.some(snapshot => JSON.stringify(snapshot) === JSON.stringify(old))))) throw new BookError('conflict', '不能覆盖来源快照、撤销或遗忘记录。');
      if (!previous || JSON.stringify(source) !== JSON.stringify(previous)) { sources.set(source.id, structuredClone(source)); changedIds.add(`source.${source.id}`); }
    }
    for (const id of changes.remove ?? []) {
      validateIdentity(id); const entry = entries.get(id);
      if (entry?.pairingId && entry.pairingId !== scope.pairingId) throw new BookError('not_found', '条目不属于当前配对。');
      if (entry?.fact) {
        const source = sources.get(entry.fact.sourceId)!;
        if (!source.forgottenKeys.includes(entry.fact.key)) { source.forgottenKeys.push(entry.fact.key); source.revision++; changedIds.add(`source.${source.id}`); }
      }
      if (entry?.pairingId === scope.pairingId) {
        rememberErasedReport(data,entry,[...sources.values()],this.loadConfig().companion?.timezone??'Asia/Singapore');
        if(data.relearningGrants)data.relearningGrants=data.relearningGrants.filter(grant=>grant.entryId!==id);
        const key = entry.fact ? `fact:${entry.fact.key}` : `body:${digest(entry.body.normalize('NFKC').trim())}`;
        if (!data.forgottenKeys.includes(key)) data.forgottenKeys.push(key);
        for (const job of data.jobs) if (entry.sourceRefs.some(ref => ref.includes(job.turnId))) { job.status = 'cancelled'; job.claims = []; if (!data.erasedTurns.includes(job.id)) data.erasedTurns.push(job.id); }
        data.events = data.events.filter(event => event.entryId !== id && event.progressEntryId !== id && !event.reportedTimeline?.some(row=>row.entryId===id));
        for (const delivery of data.deliveries) if (delivery.basisRefs.some(ref => ref.id === id) && delivery.status !== 'committed') delivery.status = 'cancelled';
        for (const [otherId, other] of entries) if (otherId !== id && (other.state?.eventId === id || other.sourceRefs.includes(id))) { entries.delete(otherId); changedIds.add(otherId); }
      }
      if (entries.delete(id)) changedIds.add(id);
    }
    if(changes.relearn){
      const proposed=changes.upsert?.find(entry=>entry.id===changes.relearn!.entryId);
      if(changes.relearn.confirmed!==true||!proposed||!proposed.fact||proposed.pairingId!==scope.pairingId||entries.has(proposed.id)||previousSourceIds.has(proposed.fact.sourceId)||sources.get(proposed.fact.sourceId)?.uri!=='user:relearn'||!data.forgottenKeys.includes(`fact:${proposed.fact.key}`))throw new BookError('invalid_input','重新记住须明确确认，并限定一个新来源的私有事实。');
      data.relearningGrants??=[];
      data.relearningGrants.push({entryId:proposed.id,sourceId:proposed.fact.sourceId,sourceHash:proposed.fact.sourceHash,valueHash:digest(proposed.fact.value)});
      validateCompanionData(data);
    }
    const upsertIds = new Set<string>();
    for (const proposed of changes.upsert ?? []) {
      validateEntry(proposed);
      const granted=proposed.fact&&data.relearningGrants?.some(grant=>grant.entryId===proposed.id&&grant.sourceId===proposed.fact!.sourceId&&grant.sourceHash===proposed.fact!.sourceHash&&grant.valueHash===digest(proposed.fact!.value));
      if (proposed.pairingId === scope.pairingId && data.forgottenKeys.includes(proposed.fact ? `fact:${proposed.fact.key}` : `body:${digest(proposed.body.normalize('NFKC').trim())}`) && !granted) throw new BookError('conflict', '该实例已遗忘此事实，禁止换 ID 或重导入恢复。');
      if (upsertIds.has(proposed.id)) throw new BookError('invalid_input', '提交含重复条目。'); upsertIds.add(proposed.id);
      if (proposed.pairingId !== null && proposed.pairingId !== scope.pairingId) throw new BookError('invalid_input', '不能写入其他配对。');
      const existing = entries.get(proposed.id);
      if (existing?.pairingId && existing.pairingId !== scope.pairingId) throw new BookError('conflict', '条目 ID 被其他作用域使用。');
      if (existing && existing.revision !== proposed.revision) throw new BookError('conflict', `条目修订冲突：${proposed.id}`);
      entries.set(proposed.id, structuredClone({ ...proposed, revision: (existing?.revision ?? 0) + 1 })); changedIds.add(proposed.id);
    }
    if (entries.size > BOOK_RECORD_LIMIT) throw new BookError('budget', 'Book 条目超过 8192。');
    // Erased/revoked originals must not survive as text in derived Wiki entries.
    for (const [id, entry] of entries) if (entry.synthesis && (entry.synthesis.basis.some(ref => !entries.get(ref.entryId)?.enabled) || entry.synthesis.sources.some(ref => !sources.get(ref.id)?.enabled))) { entries.delete(id); changedIds.add(id); }
    if (sources.size > BOOK_RECORD_LIMIT) throw new BookError('budget', 'Wiki 来源超过 8192。');
    validateFactSources([...entries.values()], [...sources.values()]);
    const beforeDrafts=JSON.stringify(data.wikiJobs);
    pruneWikiDrafts(data,[...entries.values()],[...sources.values()]);
    const draftsChanged=beforeDrafts!==JSON.stringify(data.wikiJobs);
    const next = { ...envelope.data, entries: [...entries.values()],
      ...(changes.remove?.length || changes.relearn || changes.wikiApproval || draftsChanged ? { companionData: [...(envelope.data.companionData ?? []).filter(row => row.pairingId !== scope.pairingId), { ...data, revision: data.revision + 1 }] } : {}),
      ...(sources.size ? { wikiSources: [...sources.values()] } : {}) };
    if(next.companionData)next.companionData=next.companionData.map(row=>{
      if(row.favorites){const retained=row.favorites.filter(id=>entries.has(id));if(retained.length!==row.favorites.length){row.favorites=retained;row.revision++;}}
      if(row.pairingId===scope.pairingId)return row;
      const cleaned=structuredClone(row),before=JSON.stringify(cleaned.wikiJobs);
      pruneWikiDrafts(cleaned,next.entries,next.wikiSources??[]);
      if(before!==JSON.stringify(cleaned.wikiJobs)){cleaned.revision++;changedIds.add(`wiki-maintenance.${cleaned.pairingId}`);}
      return cleaned;
    });
    next.relationships=compileRelationships(next);
    const pages=compilePersonalWiki(next);
    const oldPages=new Map((envelope.data.wikiPages??[]).map(page=>[page.id,page]));
    for(const page of pages)if(JSON.stringify(page)!==JSON.stringify(oldPages.get(page.id)))changedIds.add(page.id);
    for(const id of oldPages.keys())if(!pages.some(page=>page.id===id))changedIds.add(id);
    validatePersonalWikiPages(pages,scope.characterId);
    const receipt = { operationId, revision: envelope.data.revision + (changedIds.size ? 1 : 0), changedIds: [...changedIds] };
    envelope.data = {...next,revision:receipt.revision,...(pages.length||envelope.data.wikiPages?{wikiPages:pages}:{})};
    envelope.operations[operationId] = { fingerprint, receipt };
    this.write(this.bookFile(scope), envelope); return structuredClone(receipt);
  }
  loadConfig(): RuntimeConfig {
    return structuredClone(this.readEnvelope(join(this.directory, 'runtime.json'), () => ({
      schemaVersion: 'memory-runtime/v1', revision: 0, currentCharacterId: 'aika',
      characters: [{ id: 'aika', name: 'ALLMIND', intro: '', appearancePath: null }],
      mainModel: null, fastModel: null, recall: structuredClone(DEFAULT_RECALL_CONFIG), replyLanguage: 'zh-CN',
    } as RuntimeConfig), validateStoredRuntime).data);
  }
  commitConfig(config: RuntimeConfig, expectedRevision: number, operationId: string): CommitReceipt {
    validateIdentity(operationId, 'operationId'); validateRuntime(config);
    const file = join(this.directory, 'runtime.json');
    const envelope = this.readEnvelope(file, () => this.loadConfig(), validateStoredRuntime);
    const fingerprint = digest(JSON.stringify({ config, expectedRevision })), prior = Object.hasOwn(envelope.operations, operationId) ? envelope.operations[operationId] : undefined;
    if (prior) { if (prior.fingerprint !== fingerprint) throw new BookError('conflict', 'operationId 内容冲突。'); return structuredClone(prior.receipt); }
    if (envelope.data.revision !== expectedRevision || config.revision !== expectedRevision) throw new BookError('conflict', '设置已修改。');
    const receipt = { operationId, revision: expectedRevision + 1, changedIds: ['runtime'] };
    envelope.data = structuredClone({ ...config, revision: receipt.revision }); envelope.operations[operationId] = { fingerprint, receipt };
    this.write(file, envelope); return receipt;
  }
  private sessionFile(scope: BookScope): string { validateScope(scope); return join(this.directory, `session-${digest(JSON.stringify(scope))}.jsonl`); }
  readSession(scope: BookScope): SavedTurn[] {
    this.assertOpen(); const file = this.sessionFile(scope); if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    if (raw && !raw.endsWith('\n')) throw new BookError('corrupt_data', `聊天记录包含未完成尾行，请保留原文件后恢复：${file}`);
    try {
      return raw.split('\n').filter(Boolean).map(line => {
        const turn = JSON.parse(line) as SavedTurn;
        this.validateTurn(scope, turn); return turn;
      });
    } catch (cause) { throw new BookError('corrupt_data', `聊天记录无效：${file}`, { cause }); }
  }
  private validateTurn(scope: BookScope, turn: SavedTurn): void {
    validateIdentity(turn.id); validateIdentity(turn.traceId);
    if (turn.characterId !== scope.characterId || turn.pairingId !== scope.pairingId || turn.sessionId !== scope.sessionId || typeof turn.user !== 'string' || typeof turn.assistant !== 'string' || turn.user.length > 16000 || turn.assistant.length > 200000 || !Number.isFinite(Date.parse(turn.timestamp))) throw new BookError('invalid_input', '聊天记录作用域/内容无效。');
    if(turn.artifactDeliveryId!==undefined)validateIdentity(turn.artifactDeliveryId,'artifactDeliveryId');
    if(turn.inputResources!==undefined){if(!Array.isArray(turn.inputResources)||turn.inputResources.length>8)throw new BookError('invalid_input','附件输入无效。');turn.inputResources.forEach(validateFrozenResourceSelection);if(new Set(turn.inputResources.map(row=>row.resourceId)).size!==turn.inputResources.length)throw new BookError('invalid_input','附件重复。');const actual=resourceRequestHash({scope,turnId:turn.id,query:turn.user,replyStyle:turn.replyStyleDecision?.requestedStyle??'inherit',selections:turn.inputResources});if(turn.resourceRequestHash!==actual)throw new BookError('invalid_input','附件身份哈希不一致。');}
    if (turn.inputImageReceipts !== undefined) {
      const images = turn.inputResources?.filter(row => row.use === 'image') ?? [];
      if (!Array.isArray(turn.inputImageReceipts) || turn.inputImageReceipts.length !== images.length) throw new BookError('invalid_input', '图片上传回执数量不一致。');
      const seen = new Set<string>();
      for (const receipt of turn.inputImageReceipts) {
        const input = images.find(row => row.resourceId === receipt.resourceId && row.sha256 === receipt.sha256);
        if (!input || seen.has(receipt.resourceId) || !['image/png','image/jpeg','image/webp'].includes(receipt.mime) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0 || receipt.bytes > 16777216 || typeof receipt.name !== 'string' || !receipt.name.length || receipt.name.length > 160) throw new BookError('invalid_input', '图片上传回执与冻结输入不一致。');
        seen.add(receipt.resourceId);
      }
    }
    if(turn.replyLength!==undefined){
      const result=measureReplyLength(turn.assistant,{minChars:turn.replyLength.minChars,maxChars:turn.replyLength.maxChars});
      if(!result||result.actualChars!==turn.replyLength.actualChars||result.status!==turn.replyLength.status)throw new BookError('invalid_input','回复字数结果与保存的实际正文不一致。');
    }
    // B03: the frozen decision is validated as stored — never re-derived from the current role
    // config (an old turn must stay readable even after defaults change). A decision that claims
    // bounds must carry the matching measured result; an empty range must carry none.
    if(turn.replyStyleDecision!==undefined){
      validateReplyStyleDecision(turn.replyStyleDecision);
      const decisionRange=turn.replyStyleDecision.effectiveRange, rangeEmpty=decisionRange.minChars===null&&decisionRange.maxChars===null;
      if(rangeEmpty&&turn.replyLength!==undefined)throw new BookError('invalid_input','风格决策范围为空却携带字数结果。');
      if(!rangeEmpty&&(turn.replyLength===undefined||turn.replyLength.minChars!==decisionRange.minChars||turn.replyLength.maxChars!==decisionRange.maxChars))throw new BookError('invalid_input','回复字数结果与风格决策的范围不一致。');
    }
  }
  appendTurn(scope: BookScope, turn: SavedTurn): void {
    if(turn.incognito)throw new BookError('invalid_input','无痕轮次不允许持久化。');
    this.assertOpen(); validateScope(scope); this.validateTurn(scope, turn);
    const revoked=digest(JSON.stringify([scope.characterId,scope.pairingId,scope.sessionId,turn.id,'memory-v1']));
    if(this.loadCompanionData(scope).erasedTurns.includes(revoked))throw new BookError('conflict','该聊天来源已撤销，禁止重新写入。');
    const existing = this.readSession(scope).find(item => item.id === turn.id);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(turn)) throw new BookError('conflict', '聊天轮次 ID 内容冲突。'); return; }
    const fd = openSync(this.sessionFile(scope), 'a', 0o600);
    try { appendFileSync(fd, JSON.stringify(turn) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }
  /** Durable terminal marker for an attempted-but-uncommitted turn ID. Never stores turn bodies. */
  private turnFreezeFile(scope: BookScope): string { validateScope(scope); return join(this.directory, `turn-freezes-${digest(scope.characterId)}.json`); }
  private readTurnFreezeLedger(scope: BookScope): { schemaVersion: string; characterId: string; records: FrozenTurn[] } {
    this.assertOpen();
    const file = this.turnFreezeFile(scope);
    if (!existsSync(file)) return { schemaVersion: TURN_FREEZE_SCHEMA, characterId: scope.characterId, records: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: unknown; characterId?: unknown; records?: unknown };
      if (!parsed || parsed.schemaVersion !== TURN_FREEZE_SCHEMA || parsed.characterId !== scope.characterId || !Array.isArray(parsed.records) || parsed.records.length > TURN_FREEZE_LIMIT) throw Error('Invalid turn freeze ledger');
      const records = parsed.records as FrozenTurn[];
      for (const record of records) validateFrozenTurn(record, scope.characterId);
      return { schemaVersion: TURN_FREEZE_SCHEMA, characterId: scope.characterId, records };
    } catch (cause) { throw new BookError('corrupt_data', `无法读取失败轮次冻结记录：${file}`, { cause }); }
  }
  /** Terminal marker of one explicit turnId; records survive restart and carry no message bodies. */
  readTurnFreeze(scope: BookScope, turnId: string): FrozenTurn | null {
    validateIdentity(turnId, 'turnId');
    const found = this.readTurnFreezeLedger(scope).records.find(record => record.turnId === turnId && record.pairingId === scope.pairingId && record.sessionId === scope.sessionId);
    return found ? structuredClone(found) : null;
  }
  freezeTurn(scope: BookScope, record: FrozenTurn): void {
    this.assertOpen(); validateScope(scope); validateFrozenTurn(record, scope.characterId);
    if (record.pairingId !== scope.pairingId || record.sessionId !== scope.sessionId) throw new BookError('invalid_input', '失败轮次冻结标记不属于当前作用域。');
    const ledger = this.readTurnFreezeLedger(scope), same = (row: FrozenTurn) => row.turnId === record.turnId && row.pairingId === record.pairingId && row.sessionId === record.sessionId;
    const prior=ledger.records.find(same);
    // A submitted intent can become terminal, but an existing terminal identity is immutable.
    if(prior&&(prior.state!=='submitted'||record.state==='submitted'))return;
    if(prior&&prior.requestHash!==record.requestHash)throw new BookError('conflict','轮次提交意图与冻结身份不一致。');
    if(!prior&&ledger.records.length>=TURN_FREEZE_LIMIT)throw new BookError('budget','未确认/失败轮次记录已达1024条，未发送；请使用新的隔离数据目录，旧编号保护不会被淘汰。');
    const records = [...ledger.records.filter(row=>!same(row)), structuredClone(record)];
    this.writeTurnFreezeLedger(scope,records);
  }
  completeTurnFreeze(scope:BookScope,turnId:string):void{
    validateIdentity(turnId,'turnId');
    if(!this.readSession(scope).some(turn=>turn.id===turnId))throw new BookError('conflict','原文尚未持久保存，不能清除提交意图。');
    const ledger=this.readTurnFreezeLedger(scope),records=ledger.records.filter(row=>!(row.turnId===turnId&&row.pairingId===scope.pairingId&&row.sessionId===scope.sessionId));
    if(records.length!==ledger.records.length)this.writeTurnFreezeLedger(scope,records);
  }
  private writeTurnFreezeLedger(scope:BookScope,records:FrozenTurn[]):void{
    const file = this.turnFreezeFile(scope), temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ schemaVersion: TURN_FREEZE_SCHEMA, characterId: scope.characterId, records }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    replaceResourceFile(temporary, file);
  }
  /** Explicit source erasure, recoverable across the Book/session replace boundary. */
  eraseTurns(scope: BookScope, turnIds: string[], expectedRevision: number, recovering = false): { revision: number; removedTurns: number; removedSources: number } {
    validateScope(scope); if (!Array.isArray(turnIds) || !turnIds.length || turnIds.length > 256) throw new BookError('invalid_input','请选择 1～256 条原始聊天。');
    turnIds.forEach(id => validateIdentity(id));
    const envelope = this.book(scope), turns = this.readSession(scope), selected = new Set(turnIds);
    if (!recovering && envelope.data.revision !== expectedRevision) throw new BookError('conflict','Book 已修改。');
    const journal = join(this.directory,'erasure.json');
    // Plan derived-source removal without revoking bytes or receipts before validation.
    const erasedResources=this.lifecycle.resourcesForErase?.(scope,turnIds)??[];
    const data = this.loadCompanionData(scope), removedSourceIds = new Set<string>();
    for(const source of envelope.data.wikiSources??[])if((source.pairingId===scope.pairingId||source.pairingId===null)&&erasedResources.some(id=>source.uri==='resource:'+id))removedSourceIds.add(source.id);
    for (const id of selected) {
      const key = digest(JSON.stringify([scope.characterId,scope.pairingId,scope.sessionId,id,'memory-v1']));
      if (!data.erasedTurns.includes(key)) data.erasedTurns.push(key);
      removedSourceIds.add(`auto.${key.slice(0,32)}`);
      for (const source of envelope.data.wikiSources ?? []) if (source.pairingId === scope.pairingId && source.uri === `turn:${scope.sessionId}:${id}`) removedSourceIds.add(source.id);
      for (const source of envelope.data.wikiSources ?? []) if(source.pairingId===scope.pairingId&&source.id===`turn.${id}`&&turns.some(turn=>turn.id===id&&source.snapshots.some(snapshot=>snapshot.text===turn.user)))removedSourceIds.add(source.id);
    }
    // Legacy state events already encode the complete session scope in their ID.
    // referenceId alone is only unique within a session, never across the pairing.
    const stateEventPrefix = `event.${digest(JSON.stringify(scope)).slice(0,24)}.`;
    const removed = new Set(envelope.data.entries.filter(entry => (entry.pairingId === scope.pairingId||entry.pairingId===null&&entry.fact&&removedSourceIds.has(entry.fact.sourceId)) && (entry.fact && removedSourceIds.has(entry.fact.sourceId) || entry.event?.basis==='user_message' && entry.id.startsWith(stateEventPrefix) && selected.has(entry.event.referenceId) || entry.sourceRefs.some(ref => [...selected].some(id => ref === `turn:${scope.sessionId}:${id}` || ref === `turn.${digest(JSON.stringify(scope)).slice(0,24)}.${id}`)))).map(e => e.id));
    let grew = true; while (grew) { grew=false; for (const entry of envelope.data.entries) if (entry.pairingId===scope.pairingId && !removed.has(entry.id) && (entry.state && removed.has(entry.state.eventId) || entry.sourceRefs.some(ref => removed.has(ref)))) { removed.add(entry.id); grew=true; } }
    for (const entry of envelope.data.entries.filter(e => removed.has(e.id))) { rememberErasedReport(data,entry,envelope.data.wikiSources??[],this.loadConfig().companion?.timezone??'Asia/Singapore');const key = entry.fact ? `fact:${entry.fact.key}` : `body:${digest(entry.body.normalize('NFKC').trim())}`; if (!data.forgottenKeys.includes(key)) data.forgottenKeys.push(key); }
    if(data.relearningGrants)data.relearningGrants=data.relearningGrants.filter(grant=>!removed.has(grant.entryId)&&!removedSourceIds.has(grant.sourceId));
    data.jobs = data.jobs.filter(job => !(job.scope.sessionId === scope.sessionId && selected.has(job.turnId)));
    data.events = data.events.filter(event => {
      if(removed.has(event.entryId)||event.progressEntryId&&removed.has(event.progressEntryId)||event.reportedTimeline?.some(row=>removed.has(row.entryId))||event.cancelledBy?.sessionId===scope.sessionId&&selected.has(event.cancelledBy.turnId)){
        const key=`event:${event.id}`;if(!data.forgottenKeys.includes(key))data.forgottenKeys.push(key);return false;
      }return true;
    });
    for (const delivery of data.deliveries) if (delivery.basisRefs.some(ref => removed.has(ref.id))) { delivery.text=null; delivery.reason='依据原文已清除'; delivery.error=null; delivery.status='cancelled'; }
    if(data.favorites)data.favorites=data.favorites.filter(id=>!removed.has(id));
    data.revision++;
    const removedSources = (envelope.data.wikiSources ?? []).filter(source => removedSourceIds.has(source.id)).length;
    envelope.data = { ...envelope.data,revision:envelope.data.revision+1,entries:envelope.data.entries.filter(e => !removed.has(e.id)),
      wikiSources:(envelope.data.wikiSources ?? []).filter(source => !removedSourceIds.has(source.id)),companionData:[...(envelope.data.companionData ?? []).filter(row=>row.pairingId!==scope.pairingId),data] };
    pruneWikiDrafts(data,envelope.data.entries,envelope.data.wikiSources??[]);
    envelope.data.wikiPages=compilePersonalWiki(envelope.data);
    envelope.data.relationships=compileRelationships(envelope.data);
    // Deterministic validation must finish before writing a crash-recovery intent.
    validateCompanionSnapshot(envelope.data); packBook(envelope.data);
    if (!recovering) { const fd = openSync(journal,'wx',0o600); try { writeFileSync(fd,JSON.stringify({ scope,turnIds,expectedRevision })); fsyncSync(fd); } finally { closeSync(fd); } }
    // The durable intent also covers attached bytes and completion receipts, including startup replay.
    this.lifecycle.onErase?.(scope,turnIds);
    this.write(this.bookFile(scope),envelope);
    const kept = turns.filter(turn=>!selected.has(turn.id)), file = this.sessionFile(scope), temporary=`${file}.${randomUUID()}.tmp`, fd=openSync(temporary,'wx',0o600);
    try { writeFileSync(fd,kept.map(turn=>JSON.stringify(turn)+'\n').join('')); fsyncSync(fd); } finally { closeSync(fd); } replaceResourceFile(temporary,file);
    // App-managed backups only, exact instance prefix; external copies are outside this operation.
    const prefix=`private-backup-${digest(JSON.stringify([scope.characterId,scope.pairingId]))}-`;
    for (const name of readdirSync(this.directory)) if (name.startsWith(prefix) && name.endsWith('.json')) unlinkSync(join(this.directory,name));
    unlinkSync(journal); return { revision:this.snapshot(scope).revision,removedTurns:turns.length-kept.length,removedSources };
  }
  exportPrivate(scope: BookScope): { filename: string; text: string } {
    const config = this.loadConfig(), role = config.characters.find(role=>role.id===scope.characterId);
    const snapshot = this.snapshot(scope), sessions=this.listSessions(scope.characterId,scope.pairingId).map(session=>({ sessionId:session.sessionId,turns:this.readSession({...scope,sessionId:session.sessionId}) }));
    const filename=`private-backup-${digest(JSON.stringify([scope.characterId,scope.pairingId]))}-${Date.now()}.json`;
    // Deliberately whitelist private data. Source bindings, credentials and bridge keys are excluded.
    const text=JSON.stringify({ schemaVersion:'private-companion-backup/v1',scope:{characterId:scope.characterId,pairingId:scope.pairingId},role,snapshot,sessions },null,2);
    const fd=openSync(join(this.directory,filename),'wx',0o600); try { writeFileSync(fd,text); fsyncSync(fd); } finally { closeSync(fd); } return { filename,text };
  }
  /** MB sessions v1: summaries derived from persisted session files; only this character/pairing, most recent first. */
  private sessionArchiveFile(characterId: string, pairingId: string): string {
    validateIdentity(characterId, 'characterId'); validateIdentity(pairingId, 'pairingId');
    return join(this.directory, `session-archive-${digest(JSON.stringify([characterId, pairingId]))}.json`);
  }
  private sessionArchives(characterId: string, pairingId: string): Envelope<Record<string, string>> {
    return this.readEnvelope(this.sessionArchiveFile(characterId, pairingId), () => ({}), value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid session archive');
      for (const [id, date] of Object.entries(value)) {
        validateIdentity(id, 'sessionId');
        if (typeof date !== 'string' || !Number.isFinite(Date.parse(date))) throw Error('Invalid archive date');
      }
    });
  }
  setSessionArchived(scope: BookScope, archived: boolean): void {
    this.assertOpen(); validateScope(scope);
    if (typeof archived !== 'boolean') throw new BookError('invalid_input', '缺少归档状态。');
    if (!this.readSession(scope).length) throw new BookError('invalid_input', '只能归档已保存的会话。');
    const ledger = this.sessionArchives(scope.characterId, scope.pairingId);
    if (archived && !Object.hasOwn(ledger.data, scope.sessionId)) ledger.data = { ...ledger.data, [scope.sessionId]: new Date().toISOString() };
    else if (!archived) delete ledger.data[scope.sessionId];
    this.write(this.sessionArchiveFile(scope.characterId, scope.pairingId), ledger);
  }
  listSessions(characterId: string, pairingId: string): SessionSummary[] {
    this.assertOpen();
    validateIdentity(characterId, 'characterId'); validateIdentity(pairingId, 'pairingId');
    const parse = (line: string | undefined): Partial<SavedTurn> | null => {
      if (typeof line !== 'string' || !line) return null;
      try { return JSON.parse(line) as Partial<SavedTurn>; } catch { return null; }
    };
    const summaries: SessionSummary[] = [];
    const archives = this.sessionArchives(characterId, pairingId).data;
    let examined = 0;
    for (const name of readdirSync(this.directory)) {
      if (!name.startsWith('session-') || !name.endsWith('.jsonl')) continue;
      if (++examined > 4096) break;
      const file = join(this.directory, name);
      let size: number; try { size = statSync(file).size; } catch { continue; }
      if (!size) continue;
      // The scope is proven from the file's own first record, never guessed from the hash in its name.
      let lines: string[], turnCount: number;
      if (size <= SESSION_FULL_READ_LIMIT) { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); turnCount = lines.length; }
      else { lines = [this.readEdge(file, 0, size).split('\n')[0]!]; turnCount = -1; }
      const first = parse(lines[0]);
      if (!first || first.characterId !== characterId || first.pairingId !== pairingId) continue;
      if (typeof first.sessionId !== 'string' || typeof first.timestamp !== 'string' || !Number.isFinite(Date.parse(first.timestamp))) continue;
      try { validateIdentity(first.sessionId, 'sessionId'); } catch { continue; }
      let last: Partial<SavedTurn> = first;
      if (turnCount === -1) {
        const tail = this.readEdge(file, Math.max(0, size - SESSION_EDGE_READ), size).split('\n').filter(Boolean);
        last = parse(tail.at(-1)) ?? first;
      } else if (lines.length > 1) last = parse(lines[lines.length - 1]) ?? first;
      const updatedAt = typeof last.timestamp === 'string' && Number.isFinite(Date.parse(last.timestamp)) ? last.timestamp : first.timestamp;
      summaries.push({ characterId, pairingId, sessionId: first.sessionId, title: deriveSessionTitle(first.user),
        createdAt: first.timestamp, updatedAt, turnCount,
        lastTurnId: typeof last.id === 'string' ? last.id : null,
        ...(Object.hasOwn(archives, first.sessionId) ? { archivedAt: archives[first.sessionId] } : {}) });
    }
    return summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.sessionId.localeCompare(b.sessionId)).slice(0, SESSION_LIST_LIMIT);
  }
  /** Bounded head/tail window read for oversized session files; never loads the middle. */
  private readEdge(file: string, start: number, end: number): string {
    const length = Math.min(SESSION_EDGE_READ, end - start), buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try { readSync(fd, buffer, 0, length, start); } finally { closeSync(fd); }
    return buffer.toString('utf8');
  }
}

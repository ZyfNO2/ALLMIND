import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { BookError, emptyEntry, type BookEntry, type BookRepository, type BookScope, type RuntimeRepository, type WikiSource } from '../contracts/memory-book.js';
import type { SynthesisJob, SynthesisTask, WikiDomain } from '../contracts/wiki-synthesis.js';
import type { BookModelPort } from '../providers/book-model.js';
import { bookEntryHash } from './book-entry-hash.js';
import { bookTokenCost } from './local-book-index.js';
import { wikiExclusions } from './fact-wiki.js';
import { validateEntry, validateIdentity, validateScope } from './book-validation.js';
import { replaceResourceFile } from './resource-atomic-replace.js';
import { WIKI_SYNTHESIS_PROMPT, WIKI_SYNTHESIS_SCHEMA, WIKI_SELF_CHECK, assertSynthesisSchema, validateSynthesisResult } from './wiki-synthesis-protocol.js';
import { zipWikiTask } from './wiki-task-zip.js';
import {synthesisBatches,mergeSynthesisBatches} from './wiki-synthesis-batches.js';

const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const same = (a: BookScope, b: BookScope) => a.characterId === b.characterId && a.pairingId === b.pairingId && a.sessionId === b.sessionId;
type Repository = BookRepository & RuntimeRepository & { directory?: string; hasBookOperation?(scope: BookScope, operationId: string): boolean };
export function wikiMaterialDomain(entry: BookEntry): WikiDomain {
  if (entry.tags.includes('simulation') || entry.tags.includes('not-user-history') || entry.authorScope === 'simulation-only' || entry.organization?.domain === 'rp') return 'simulated';
  if (entry.organization?.domain === 'real' || entry.origin === 'observed' && entry.pairingId) return 'real';
  if (entry.organization?.domain === 'external') return 'external';
  if (entry.canon?.level === 'author_defined' || entry.tags.includes('fan-adaptation') || entry.organization?.domain === 'author') return 'author';
  return entry.knowledge || entry.canon?.level === 'canon' || entry.canon?.level.startsWith('game-') ? 'canon' : 'external';
}

export class WikiSynthesisService {
  private jobs: SynthesisJob[] = [];
  private file?: string;
  private active: { id: string; scope: BookScope; controller: AbortController } | undefined;
  get processing(): boolean { return !!this.active; }
  constructor(private repository: Repository, private model: BookModelPort, private changed: (id: string) => void, private busy: (id: string) => boolean) {
    if (repository.directory) this.file = join(repository.directory, 'wiki-synthesis.json');
    if (this.file && existsSync(this.file)) {
      try {
        const jobs = JSON.parse(readFileSync(this.file, 'utf8'));
        if (!Array.isArray(jobs) || jobs.length > 32) throw Error('job limit');
        for (const job of jobs) {
          validateIdentity(job.id); validateScope(job.scope);
          if (!['prepared','running','review','applied','failed','cancelled','stale'].includes(job.status) || !Array.isArray(job.basis) || !job.basis.length || !/^[a-f0-9]{64}$/.test(job.inputHash)) throw Error('job shape');
          if (job.result) assertSynthesisSchema(job.result);
          if (job.status === 'running') { job.status = 'failed'; job.error = '上次提交的完成状态未确认，不会自动重发；请检查来源回执。'; }
        }
        this.jobs = jobs; this.save();
      } catch (cause) { throw new BookError('corrupt_data', 'Wiki编纂任务文件无法读取。', { cause }); }
    }
  }
  private save(): void {
    if (!this.file) return;
    const temporary = this.file + '.' + randomUUID() + '.tmp', fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.jobs) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    replaceResourceFile(temporary, this.file);
  }
  private touch(job: SynthesisJob): void { job.updatedAt = new Date().toISOString(); this.save(); }
  private task(scope: BookScope): SynthesisTask {
    validateScope(scope);
    const book = this.repository.snapshot(scope), config = this.repository.loadConfig();
    const view = config.characters.find(role => role.id === scope.characterId)?.knowledgeView ?? null;
    if (!view && book.entries.some(entry => entry.enabled && !entry.synthesis && entry.knowledge)) throw new BookError('invalid_input', '请先明确确认角色的世界、分支与已知章节；有边界资料不能按空白视图整理。');
    const excluded = new Set(wikiExclusions(book.entries, book.wikiSources ?? [], scope, view ?? undefined).filter(row => row.reason !== 'duplicate_fact').map(row => row.entryId));
    const entries = book.entries.filter(entry => !entry.synthesis && entry.origin !== 'inferred' && !excluded.has(entry.id));
    if (!entries.length || entries.length > 512) throw new BookError('budget', '本次编纂需要1～512条可见资料。');
    const materials = entries.map(entry => ({ id: entry.id, title: entry.title, type: entry.type, body: entry.body, domain: wikiMaterialDomain(entry), knowledge: entry.knowledge ?? null, sourceIds: this.sources(entry, book.wikiSources ?? []).map(row => row.id) }));
    const existingPages = book.entries.filter(entry => entry.synthesis && entry.pairingId === scope.pairingId).map(entry => ({ id: entry.synthesis!.pageId, title: entry.title, domain: entry.synthesis!.domain }));
    const data = { protocol: 'allmind-wiki-task/v1' as const, scope: { ...scope }, view, materials, existingPages };
    return { ...data, inputHash: hash(JSON.stringify(data)) };
  }
  private sources(entry: BookEntry, sources: WikiSource[]) {
    return sources.filter(source => source.enabled && (source.id === entry.fact?.sourceId || entry.sourceRefs.includes(source.id)));
  }
  list(scope: BookScope): SynthesisJob[] {
    this.prune(scope.characterId);
    return structuredClone(this.jobs.filter(job => same(job.scope, scope)));
  }
  get(scope: BookScope, id: string): SynthesisJob {
    validateIdentity(id); this.prune(scope.characterId);
    const job = this.jobs.find(row => row.id === id && same(row.scope, scope));
    if (!job) throw new BookError('not_found', '没有该编纂任务。'); return job;
  }
  /** Remove private derived drafts after erasure, rather than retaining a hidden copy in a job file. */
  prune(characterId: string): void {
    let dirty = false;
    for (const job of this.jobs.filter(row => row.scope.characterId === characterId)) {
      const book = this.repository.snapshot(job.scope);
      if (job.basis.some(ref => {const entry=book.entries.find(entry=>entry.id===ref.entryId);return !entry?.enabled||entry.fact&&!(book.wikiSources??[]).some(source=>source.id===entry.fact!.sourceId&&source.enabled&&source.hash===entry.fact!.sourceHash&&!source.forgottenKeys.includes(entry.fact!.key));})) {
        if (job.result || !['stale','cancelled'].includes(job.status)) { job.result = null; delete job.applyIntent; job.status = 'stale'; job.error = '原始依据已撤销，已清理派生草稿。';
          for(const requestId of new Set([...(job.batchProgress?.requestIds??[]),...(job.preparedReceipt?.requestId?[job.preparedReceipt.requestId]:[])]))this.model.forgetCompletion?.({kind:'chatgpt-web',baseUrl:'chatgpt-web',model:job.model??'current',credentialId:'none',inputTokens:512,outputTokens:1},requestId);
          dirty = true; }
      }
    }
    if (dirty) this.save();
  }
  prepare(scope: BookScope, expectedRevision: number, operationId: string): SynthesisJob {
    validateIdentity(operationId);
    const book = this.repository.snapshot(scope);
    if (book.revision !== expectedRevision) throw new BookError('conflict', '资料版本已变化，请刷新后准备。');
    const task = this.task(scope), prior = this.jobs.find(job => same(job.scope, scope) && job.operationId === operationId);
    if (prior) { if (prior.inputHash !== task.inputHash) throw new BookError('conflict', '同一编纂操作的输入已变化。'); return structuredClone(prior); }
    if (this.jobs.length >= 32) throw new BookError('budget', '编纂任务已达32个，请先导出归档，不自动删除历史。');
    const messages = this.messages(task), config = this.repository.loadConfig(), now = new Date().toISOString();
    const job: SynthesisJob = { id: 'synthesis-' + randomUUID(), scope: { ...scope }, operationId, status: 'prepared', expectedRevision, configRevision: config.revision, inputHash: task.inputHash, promptHash: hash(JSON.stringify(messages)), basis: task.materials.map(row => { const entry = book.entries.find(entry => entry.id === row.id)!; return { entryId: entry.id, revision: entry.revision, hash: bookEntryHash(entry) }; }), view: task.view, createdAt: now, updatedAt: now, error: null, result: null, attempt: 0, model: null, effort: null };
    this.jobs.push(job); this.save(); return structuredClone(job);
  }
  private messages(task: SynthesisTask) {
    return [{ role: 'system' as const, content: WIKI_SYNTHESIS_PROMPT + '\n\n输出控制：这里只处理当前 materials；全量资料由 ALLMIND 分批发送。优先综合成1～3个简洁主题，每段保留必要的短原文证据；不要重复长引文或为凑页数拆分。每批均须完整 coverage，不能漏条。跨批关系未在本批提供证据时不生成。\n\n完整 JSON Schema：\n' + JSON.stringify(WIKI_SYNTHESIS_SCHEMA) }, { role: 'user' as const, content: JSON.stringify(task) }];
  }
  private current(job: SynthesisJob): SynthesisTask {
    if (this.repository.loadConfig().revision !== job.configRevision || this.repository.snapshot(job.scope).revision !== job.expectedRevision) throw new BookError('conflict', '准备后配置或资料已修改，请重新准备任务。');
    const task = this.task(job.scope);
    if (task.inputHash !== job.inputHash || hash(JSON.stringify(this.messages(task))) !== job.promptHash) throw new BookError('conflict', '输入或提示版本已变化，禁止使用旧任务。');
    return task;
  }
  package(scope: BookScope, id: string): { files: Record<string, string>; inputHash: string; promptHash: string } {
    const job = this.get(scope, id), task = this.current(job);
    return {files:this.taskFiles(task),inputHash:job.inputHash,promptHash:job.promptHash};
  }
  private taskFiles(task:SynthesisTask):Record<string,string>{
    const files: Record<string, string> = {
      'materials.json': JSON.stringify(task, null, 2),
      'response.schema.json': JSON.stringify(WIKI_SYNTHESIS_SCHEMA, null, 2),
      'validate.py': WIKI_SELF_CHECK,
      'PROMPT.md': this.messages(task).map(row => row.content).join('\n\n当前任务材料：\n'),
    };
    files['manifest.json'] = JSON.stringify({ schemaVersion: 'allmind-wiki-task-files/v1', inputHash:task.inputHash, promptHash:hash(JSON.stringify(this.messages(task))), files: Object.entries(files).map(([name, text]) => ({ name, bytes: Buffer.byteLength(text), sha256: hash(text) })) }, null, 2);
    return files;
  }
  async run(scope: BookScope, id: string, signal: AbortSignal, budgetMs = 600000, confirmedSend = false): Promise<SynthesisJob> {
    const job = this.get(scope, id);
    if (job.status === 'review' || job.status === 'applied') return structuredClone(job);
    if (job.status !== 'prepared' || job.attempt) throw new BookError('conflict', '该任务已尝试或中断，不会自动重发；核对来源后请显式准备新任务。');
    if (this.active || this.busy(scope.characterId)) throw new BookError('busy', '当前来源或角色已有进行中的操作。');
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 30000 || budgetMs > 2700000) throw new BookError('invalid_input', '编纂时限应为30秒～45分钟。');
    const task = this.current(job), config = this.repository.loadConfig(), binding = config.wikiModel ?? config.fastModel;
    if (!binding) throw new BookError('unavailable', '请先绑定整理模型。');
    if (confirmedSend !== true) throw new BookError('invalid_input', '请明确允许把本次编纂材料发送给所选整理模型。');
    if (binding.kind === 'chatgpt-web' && !config.chatgptWeb?.authorizedPurposes.includes('wiki')) throw new BookError('unavailable', '尚未授权ChatGPT网页用于Wiki整理。');
    const batches=synthesisBatches(task,binding.outputTokens);
    for(const batch of batches)if(this.messages(batch).reduce((sum,row)=>sum+bookTokenCost(row.content),0)>binding.inputTokens-binding.outputTokens)throw new BookError('budget','单批完整材料与规范超过所选模型输入预算；未截断、未发送。请调整模型窗口。');
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(budgetMs)]);
    combined.throwIfAborted(); this.active = { id, scope, controller };
    job.status = 'running'; job.attempt = 1; job.model = binding.model; job.effort = binding.kind === 'chatgpt-web' ? 'high-required-before-submit' : binding.reasoningEffort ?? 'provider-default'; job.budgetMs = budgetMs; this.touch(job);
    try {
      const parts:{task:SynthesisTask;result:import('../contracts/wiki-synthesis.js').SynthesisResult}[]=[];
      job.batchProgress={total:batches.length,completed:0,inputHashes:batches.map(row=>row.inputHash),responseHashes:[],requestIds:[]};this.touch(job);
      for(const batch of batches){
      combined.throwIfAborted();this.current(job);
      const archive = binding.kind === 'chatgpt-web' ? zipWikiTask(this.taskFiles(batch)) : undefined;
      const reply = await this.model.complete(binding, this.messages(batch), combined, { json: true, purpose: 'wiki', scope, budgetMs,
        onPrepared: receipt => {job.preparedReceipt=receipt;job.batchProgress!.requestIds.push(receipt.requestId);this.touch(job);},
        ...(archive ? { requiredThinking: 'high' as const, taskArchive:{bytes:archive,sha256:hash(archive)} } : {}) });
      combined.throwIfAborted(); this.current(job);
      job.responseHash = hash(reply);
      let result: unknown; try { result = JSON.parse(reply); } catch (cause) { throw new BookError('invalid_input', '编纂输出不是完整JSON，未生成审核草稿。', { cause }); }
      parts.push({task:batch,result:validateSynthesisResult(result,batch)});
      job.batchProgress.completed=parts.length;job.batchProgress.responseHashes.push(job.responseHash);this.touch(job);
      }
      job.result = mergeSynthesisBatches(task,parts); job.status = 'review'; job.error = null; this.touch(job); return structuredClone(job);
    } catch (error) {
      job.status = combined.aborted ? 'cancelled' : 'failed'; job.result = null;
      job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      if(job.responseHash)job.validationError=job.error; this.touch(job); throw error;
    } finally { this.active = undefined; }
  }
  cancel(scope: BookScope, id: string): SynthesisJob {
    const job = this.get(scope, id);
    if (job.status === 'applied' || job.applyIntent) throw new BookError('conflict', '已提交或正在提交的版本不能作为草稿取消。');
    if (this.active?.id === id) this.active.controller.abort(new BookError('conflict', '用户取消编纂，未自动重发。'));
    job.status = 'cancelled'; job.result = null; job.error = '用户取消编纂。'; this.touch(job); return structuredClone(job);
  }
  async resume(scope:BookScope,id:string,signal:AbortSignal,confirmed:boolean):Promise<SynthesisJob>{
    const job=this.get(scope,id);
    if(confirmed!==true)throw new BookError('invalid_input','请明确接续读取本次回执。');
    if(job.status==='review'||job.status==='applied')return structuredClone(job);
    if((job.batchProgress?.total??1)>1)throw new BookError('conflict','分批任务中断后不能把单批回执当作完整结果；保留进度，不自动重发。');
    if(!['cancelled','failed'].includes(job.status)||!job.preparedReceipt?.requestId||job.applyIntent)throw new BookError('conflict','没有可接续读取的网页编纂回执。');
    if(this.active||this.busy(scope.characterId))throw new BookError('busy','当前角色或来源忙，请稍后接续读取。');
    const task=this.current(job),binding=this.repository.loadConfig().wikiModel??this.repository.loadConfig().fastModel;
    if(!binding||binding.kind!=='chatgpt-web'||binding.model!==job.model||!this.model.resume)throw new BookError('unavailable','原网页来源不可用，不会改用其他模型或重发。');
    const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(180000)]);this.active={id,scope,controller};
    try{
      const reply=await this.model.resume(binding,job.preparedReceipt.requestId,combined,{json:true,purpose:'wiki',scope,budgetMs:120000});combined.throwIfAborted();this.current(job);job.responseHash=hash(reply);
      let parsed:unknown;try{parsed=JSON.parse(reply);}catch(cause){throw new BookError('invalid_input','接续结果不是完整JSON。',{cause});}
      job.result=validateSynthesisResult(parsed,task);job.status='review';job.error=null;delete job.validationError;this.touch(job);return structuredClone(job);
    }catch(error){job.error=(error instanceof Error?error.message:String(error)).slice(0,2000);this.touch(job);throw error;}finally{this.active=undefined;}
  }
  abort(characterId: string): void { if (this.active?.scope.characterId === characterId) this.active.controller.abort(new BookError('conflict', '配置、资料或对话变化，停止编纂。')); this.prune(characterId); }
  apply(scope: BookScope, id: string, expectedRevision: number, operationId: string, confirmed: boolean) {
    validateIdentity(operationId);
    const job = this.get(scope, id);
    if (confirmed !== true) throw new BookError('invalid_input', '必须明确核对并确认编纂内容。');
    if (job.applyOperationId && job.applyOperationId !== operationId) throw new BookError('conflict', '该任务已绑定另一提交编号。');
    if (job.receipt) return structuredClone(job.receipt);
    if (expectedRevision !== job.expectedRevision) throw new BookError('conflict', '审核版本不匹配。');
    if (!job.applyIntent) {
      if (job.status !== 'review' || !job.result) throw new BookError('conflict', '只有校验通过的待审结果可以应用。');
      const task = this.current(job); validateSynthesisResult(job.result, task);
      const book = this.repository.snapshot(scope), entries = new Map(book.entries.map(row => [row.id, row]));
      const entryId = (pageId: string) => 'synth.' + hash(JSON.stringify([scope.characterId, scope.pairingId, pageId])).slice(0, 32);
      const upsert = job.result.pages.map(page => {
        const id = entryId(page.id), old = entries.get(id);
        if (old && (!old.synthesis || old.importedHash !== bookEntryHash(old))) throw new BookError('conflict', '用户已手改编纂页，保留原文：' + page.title);
        const basisIds = [...new Set(page.paragraphs.flatMap(row => row.evidence.map(ref => ref.entryId)))];
        const basisEntries = basisIds.map(id => entries.get(id)!);
        const body = `[派生Wiki · ${page.domain}；来源陈述的综合，非独立事实认证${page.domain === 'simulated' ? '；以下为模拟陪伴，不是真人经历' : ''}]\n\n` + page.paragraphs.map(row => row.text + ' ' + [...new Set(row.evidence.map(ref => ref.entryId))].map(id => `〔${id}〕`).join('')).join('\n\n');
        const entry = emptyEntry(id, 'wiki', page.title, body);
        entry.origin = 'authored'; entry.pairingId = scope.pairingId; entry.revision = old?.revision ?? 0;
        entry.sourceRefs = basisIds; entry.entities = [page.title]; entry.tags = ['reviewed-wiki', 'domain:' + page.domain];
        if (page.domain === 'simulated') entry.organization = { domain: 'rp', evidenceStatus: 'source_asserted' };
        const boundaries = basisEntries.flatMap(row => row.knowledge ? [row.knowledge] : []);
        if (boundaries.length) {
          if (new Set(boundaries.map(row => row.worldId + '\0' + row.branch)).size !== 1) throw new BookError('invalid_input', '页面混合不同世界或分支。');
          entry.knowledge = { ...boundaries[0]!, chapter: Math.max(...boundaries.map(row => row.chapter)), awareness: 'heard' };
        }
        const relations = job.result!.relations.filter(row => row.from === page.id).map(row => ({ targetId: entryId(row.to), label: row.label, basisEntryIds: [...new Set(row.evidence.map(ref => ref.entryId))] }));
        entry.related = [...new Set(relations.map(row => row.targetId))];
        const sources = [...new Map(basisEntries.flatMap(row => this.sources(row, book.wikiSources ?? [])).map(row => [row.id, { id: row.id, hash: row.hash, revision: row.revision }])).values()];
        entry.synthesis = { version: 'allmind-wiki/v1', pageId: page.id, domain: page.domain, basis: basisIds.map(id => job.basis.find(ref => ref.entryId === id)!), sources, relations };
        validateEntry(entry); entry.importedHash = bookEntryHash(entry); return entry;
      });
      job.applyIntent = { upsert }; job.applyOperationId = operationId; this.touch(job);
    }
    const receipt = this.repository.commit(scope, job.applyIntent, job.expectedRevision, operationId);
    job.receipt = receipt; job.status = 'applied'; job.error = null; delete job.applyIntent; this.touch(job); this.changed(scope.characterId); return receipt;
  }
}

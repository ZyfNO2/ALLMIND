import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, openSync, fsyncSync,closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BookError, type BookScope, type RuntimeConfig } from '../contracts/memory-book.js';
import type { OutfitImageNote, OutfitJob, OutfitPhase, OutfitRequest } from '../contracts/portraits.js';
import type { BookResourceService } from '../memory/book-resources.js';
import {replaceResourceFile} from '../memory/resource-atomic-replace.js';
import {sameScope} from '../contracts/book-resources.js';
import { RESOURCE_LIMITS } from '../contracts/book-resources.js';
import type { PortraitStore } from './portrait-store.js';
import { writeFile } from 'node:fs/promises';

export interface GeneratedImage { name: string; mime: string; bytes: Uint8Array }
export interface OutfitGeneration {
  kind: 'completed';
  requestId: string;
  conversationId: string | null;
  messageId: string | null;
  images: GeneratedImage[];
  submitted: 'yes';
}
export interface OutfitGenerationFailure { kind: 'failed' | 'cancelled'; code: string; submitted: 'no' | 'yes' | 'unknown'; message: string; requestId?: string; conversationId?: string | null; messageId?: string | null }
export interface OutfitGenerator {
  capabilities(): { inputImages: string; outputImages: string; reason?: string };
  sourceFingerprint(): string;
  submit(input: { requestId: string; instruction: string;temporary?:boolean; images: { resourceId: string; sha256: string; mime: string; bytes: Uint8Array }[]; signal: AbortSignal }): Promise<OutfitGeneration | OutfitGenerationFailure>;
  resume(requestId: string, signal: AbortSignal): Promise<OutfitGeneration | OutfitGenerationFailure>;
  cancel(requestId: string): Promise<OutfitGenerationFailure>;
}
export interface ImageInspection { width: number; height: number; minAlpha: number; maxAlpha: number; touchesEdge: boolean }

const fingerprintOf = (scope: BookScope, request: OutfitRequest) => createHash('sha256').update(JSON.stringify({
  scope,
  revision: request.expectedAppearanceRevision,
  references: request.references, instruction: request.instruction,conversationMode:request.conversationMode??null
})).digest('hex');

function phaseOf(result: OutfitGeneration | OutfitGenerationFailure): OutfitPhase {
  if (result.kind === 'cancelled') return 'cancelled';
  if (result.kind === 'completed') return result.images.length ? 'ready' : 'failed';
  if (result.submitted === 'unknown'||['incomplete','timeout','submit_unknown'].includes(result.code)) return 'submission_unknown';
  return 'failed';
}

export class OutfitService {
  private readonly jobs = new Map<string, OutfitJob>();
  private busy = false;
  private readonly controllers=new Map<string,AbortController>();
  constructor(private readonly file: string, private readonly portraits: PortraitStore, private readonly resources: BookResourceService, private readonly generator: OutfitGenerator, private readonly config: () => RuntimeConfig, private readonly inspect: (bytes: Uint8Array, mime: string) => Promise<ImageInspection>, private readonly activate: (scope: BookScope, skinId: string) => Promise<void>) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as OutfitJob[];
      if (!Array.isArray(parsed)) throw new BookError('corrupt_data', '换装回执无法读取。');
      for (const job of parsed) {
        if(['preparing','submitted','receiving'].includes(job.phase)){job.phase='submission_unknown';job.error='进程重启前的提交未确认；只查回执，不重新生成。';}
        this.jobs.set(job.id, job);
      }
    }
  }
  get(scope: BookScope, id: string): OutfitJob {
    const job = this.jobs.get(id);
    if (!job || !sameScope(job.scope,scope)) throw new BookError('not_found', '没有这个换装任务。');
    return structuredClone(job);
  }
  private save() {
    mkdirSync(join(this.file, '..'), { recursive: true });
    const temporary = this.file + '.next';
    const fd=openSync(temporary,'w',0o600);try{writeFileSync(fd,JSON.stringify([...this.jobs.values()])+'\n');fsyncSync(fd);}finally{closeSync(fd);}replaceResourceFile(temporary,this.file);
  }
  private put(job: OutfitJob) { job.revision += 1; this.jobs.set(job.id, job); this.save(); return structuredClone(job); }

  async create(scope: BookScope, request: OutfitRequest, signal: AbortSignal, prepared?:(job:OutfitJob)=>void): Promise<OutfitJob> {
    if(request.conversationMode!==undefined&&!['temporary','regular'].includes(request.conversationMode))throw new BookError('invalid_input','网页会话模式无效。');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.operationId)) throw new BookError('invalid_input', 'operationId 无效。');
    if (typeof request.instruction !== 'string' || !request.instruction.trim() || request.instruction.length > 2000) throw new BookError('invalid_input', '换装要求无效。');
    if (!Array.isArray(request.references) || !request.references.length || request.references.length > 4) throw new BookError('invalid_input', '请选择 1～4 张参考图。');
    const fingerprint = fingerprintOf(scope, request);
    const existing = [...this.jobs.values()].find(job => job.operationId === request.operationId && sameScope(job.scope,scope));
    if (existing) {
      if (existing.inputFingerprint !== fingerprint) throw new BookError('conflict', '同一换装操作的参考图或要求已变化。');
      prepared?.(structuredClone(existing));return structuredClone(existing);
    }
    if (this.portraits.get(scope.characterId).revision !== request.expectedAppearanceRevision) throw new BookError('conflict', '立绘集合已更新，请刷新后重试。');
    const capability = this.generator.capabilities();
    if (capability.inputImages !== 'available') throw new BookError('unavailable', capability.reason ?? '当前来源不支持真实图片输入，未提交。');
    if (capability.outputImages === 'unavailable') throw new BookError('unavailable', capability.reason ?? '当前来源未证明能够返回生成图片，未提交。');
    const config = this.config();
    if (config.mainModel?.kind === 'chatgpt-web' && !config.chatgptWeb?.authorizedPurposes.includes('reply')) throw new BookError('unavailable', 'ChatGPT 网页来源未授权发送参考图，未提交。');
    const records=request.references.map(reference=>{
      const record=this.resources.get(scope,reference.resourceId);
      if(record.state!=='ready'||record.kind!=='image'||record.sha256!==reference.sha256||record.revision!==reference.resourceRevision)throw new BookError('conflict','参考图已变化或不可读取，未提交。');
      if(!record.mime||!['image/png','image/jpeg','image/webp'].includes(record.mime))throw new BookError('invalid_input','参考图类型不受支持。');return record;
    });
    if(new Set(records.map(row=>row.id)).size!==records.length)throw new BookError('invalid_input','参考图不能重复选择。');
    if(records.reduce((sum,row)=>sum+(row.bytes??0),0)>RESOURCE_LIMITS.imagesPerTurnBytes)throw new BookError('budget','参考图总量超过上限。');
    const requestId='outfit-'+createHash('sha256').update(JSON.stringify([scope,request.operationId])).digest('hex').slice(0,40);
    const job:OutfitJob={id:randomUUID(),operationId:request.operationId,scope:{...scope},revision:0,phase:'preparing',inputFingerprint:fingerprint,sourceFingerprint:this.generator.sourceFingerprint(),expectedAppearanceRevision:request.expectedAppearanceRevision,references:structuredClone(request.references),instruction:request.instruction.trim(),requestId,conversationId:null,messageId:null,outputResourceIds:[],images:[],error:null,selectedResourceId:null,appliedVariantId:null,submitted:'no'};
    job.conversationMode=request.conversationMode??config.chatgptWeb?.conversationMode??'temporary';this.put(job);prepared?.(structuredClone(job));
    if(this.busy){job.phase='failed';job.error='已有换装任务占用网页来源，未提交。';return this.put(job);}
    this.busy=true;const controller=new AbortController();this.controllers.set(job.id,controller);const bounded=AbortSignal.any([signal,controller.signal]);
    try{
      const images=[];for(const record of records){bounded.throwIfAborted();const bytes=await this.resources.readBytes(scope,record.id,bounded);images.push({resourceId:record.id,sha256:record.sha256!,mime:record.mime!,bytes});}
      bounded.throwIfAborted();job.phase='submitted';job.submitted='unknown';this.put(job);
      const result=await this.generator.submit({requestId,instruction:job.instruction,temporary:job.conversationMode==='temporary',images,signal:bounded});
      return await this.receive(job,result,scope,bounded);
    }catch(error){
      if(String(job.phase)==='cancelled')return this.put(job);
      job.phase=job.submitted==='unknown'?'submission_unknown':'failed';job.error=error instanceof Error?error.message:String(error);return this.put(job);
    }finally{this.controllers.delete(job.id);this.busy=false;}
  }
  begin(scope:BookScope,request:OutfitRequest):Promise<OutfitJob>{return new Promise((resolve,reject)=>{void this.create(scope,request,new AbortController().signal,resolve).then(resolve,reject);});}
  private assertReferences(job:OutfitJob){for(const ref of job.references){const current=this.resources.get(job.scope,ref.resourceId);if(current.state!=='ready'||current.sha256!==ref.sha256||current.revision!==ref.resourceRevision)throw new BookError('conflict','参考图已撤销或变化，结果未采用。');}}

  private async receive(job: OutfitJob, result: OutfitGeneration | OutfitGenerationFailure, scope: BookScope, signal: AbortSignal): Promise<OutfitJob> {
    if(job.phase==='cancelled')return structuredClone(job);
    job.submitted = result.submitted;
    job.requestId = result.requestId ?? job.requestId;
    job.conversationId = result.conversationId ?? null;
    job.messageId = result.messageId ?? null;
    if (result.kind !== 'completed') {
      job.phase = phaseOf(result); job.error = result.message; return this.put(job);
    }
    signal.throwIfAborted();if (String(job.phase) === 'cancelled') return this.put(job);
    this.assertReferences(job);
    if (this.generator.sourceFingerprint() !== job.sourceFingerprint || this.portraits.get(scope.characterId).revision !== job.expectedAppearanceRevision) {
      job.phase = 'failed'; job.error = '来源或立绘在生成期间已变化，结果未保存、未应用。'; return this.put(job);
    }
    job.phase = 'receiving'; this.put(job);
    const notes: OutfitImageNote[] = [];
    for (const [index, image] of result.images.entries()) {
      const outputHash=createHash('sha256').update(image.bytes).digest('hex');
      if(job.references.some(reference=>reference.sha256===outputHash))continue;
      const record = await this.resources.receiveUpload(scope, { name: image.name || `outfit-${index + 1}.png`, mime: image.mime }, image.bytes, `${job.operationId}-out-${index}`, signal);
      const facts = await this.inspect(image.bytes, image.mime);
      const warning = facts.minAlpha === 255 ? '生成图没有透明像素，预览不会把背景伪装成透明。' : facts.touchesEdge ? '生成图的不透明内容贴着画布边缘，人物可能被裁切。' : null;
      signal.throwIfAborted();this.assertReferences(job);if(String(job.phase)==='cancelled')return this.put(job);
      notes.push({ resourceId: record.id, sha256: record.sha256!, mime: image.mime, width: facts.width, height: facts.height, minAlpha: facts.minAlpha, maxAlpha: facts.maxAlpha, warning });
    }
    job.outputResourceIds = notes.map(note => note.resourceId);
    job.images = notes;
    job.phase = notes.length ? 'ready' : 'failed';
    job.error = notes.length ? null : '网页回复没有可核验的生成图片。';
    return this.put(job);
  }

  async refresh(scope: BookScope, id: string, signal: AbortSignal): Promise<OutfitJob> {
    const job = this.jobs.get(id);
    if (!job || !sameScope(job.scope,scope)) throw new BookError('not_found', '没有这个换装任务。');
    if(this.controllers.has(id))return structuredClone(job);
    if (!['submitted', 'receiving', 'submission_unknown'].includes(job.phase) && !(job.phase==='failed'&&job.submitted==='yes') || !job.requestId) return structuredClone(job);
    if (job.submitted === 'unknown' || job.phase === 'submission_unknown' || job.phase==='failed') {
      let resumed:OutfitGeneration|OutfitGenerationFailure;
      try{resumed=await this.generator.resume(job.requestId, signal);}catch(error){job.error='回执查询失败，未重新提交：'+String(error);return this.put(job);}
      if (resumed.kind === 'failed' && resumed.submitted === 'unknown') return structuredClone(job);
      return this.receive(job, resumed, scope, signal);
    }
    return structuredClone(job);
  }

  async cancel(scope: BookScope, id: string): Promise<OutfitJob> {
    const job = this.jobs.get(id);
    if (!job || !sameScope(job.scope,scope)) throw new BookError('not_found', '没有这个换装任务。');
    if (['applied', 'cancelled', 'failed', 'ready'].includes(job.phase)) return structuredClone(job);
    job.phase = 'cancelled';this.controllers.get(id)?.abort();this.put(job);
    if (job.requestId && job.submitted !== 'no') {
      try{const result = await this.generator.cancel(job.requestId);job.error=result.message;job.submitted=result.submitted;}catch(error){job.error='取消未确认：'+String(error);}
    } else job.error = '已取消，尚未提交。';
    return this.put(job);
  }

  async apply(scope: BookScope, id: string, input: { resourceId: string; sha256: string; expectedAppearanceRevision: number; operationId: string }, fileFor: (bytes: Uint8Array, mime: string) => Promise<string>): Promise<OutfitJob> {
    const job = this.jobs.get(id);
    if (!job || !sameScope(job.scope,scope)) throw new BookError('not_found', '没有这个换装任务。');
    const applyFingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if(job.phase==='applied'){if(job.applyFingerprint!==applyFingerprint)throw new BookError('conflict','该结果已按其他操作应用。');return structuredClone(job);}
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.operationId))throw new BookError('invalid_input','应用操作标识无效。');
    if (job.phase !== 'ready') throw new BookError('conflict', '换装结果还不能应用。');
    this.assertReferences(job);
    if (job.sourceFingerprint !== this.generator.sourceFingerprint()) throw new BookError('conflict', '模型来源已变化，生成图不会自动应用。');
    if (this.portraits.get(scope.characterId).revision !== input.expectedAppearanceRevision || input.expectedAppearanceRevision !== job.expectedAppearanceRevision) throw new BookError('conflict', '立绘修订已变化，请重新预览后再应用。');
    const note = job.images.find(item => item.resourceId === input.resourceId && item.sha256 === input.sha256);
    if (!note) throw new BookError('invalid_input', '请选择本次生成的一张图片。');
    const record = this.resources.get(scope, input.resourceId);
    if (record.state !== 'ready' || record.sha256 !== input.sha256) throw new BookError('conflict', '预览图已撤销或变化，不能应用。');
    const previous = this.portraits.get(scope.characterId);
    const bytes = await this.resources.readBytes(scope, input.resourceId);
    const file = await fileFor(bytes, note.mime);
    try {
      const set = await this.portraits.add({ characterId: scope.characterId, name: '生成衣装', file, origin: 'web_generated', generationId: job.id, operationId: input.operationId, expectedRevision: previous.revision, currentSkinId: previous.fallbackSkinId,contentHash:input.sha256 });
      const variant = set.variants.at(-1)!;
      const selected = await this.portraits.select(scope.characterId, variant.id, set.revision, input.operationId + '-select');
      try { await this.activate(scope, variant.skinId); }
      catch (error) {
        await this.portraits.select(scope.characterId, previous.selectedVariantId, selected.revision, input.operationId + '-revert');
        throw error;
      }
      job.applyFingerprint=applyFingerprint;job.phase = 'applied'; job.selectedResourceId = input.resourceId; job.appliedVariantId = variant.id;
      return this.put(job);
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      this.put(job);
      throw error;
    }finally{if(existsSync(file))unlinkSync(file);}
  }
}

export async function writeTempImage(bytes: Uint8Array, mime: string): Promise<string> {
  const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const file = join(tmpdir(), `allmind-outfit-${randomUUID()}.${extension}`);
  await writeFile(file, bytes);
  return file;
}

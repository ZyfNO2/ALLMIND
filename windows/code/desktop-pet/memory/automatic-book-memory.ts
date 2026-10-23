import { createHash } from 'node:crypto';
import { BookError, type BookRepository, type RuntimeRepository, type BookScope, type SavedTurn } from '../contracts/memory-book.js';
import { DEFAULT_COMPANION_SETTINGS, type CompanionRepository, type MemoryJob, type CompanionData } from '../contracts/book-companion.js';
import { declarationClaims, FactWikiService, type FactClaim } from './fact-wiki.js';
import type { BookModelPort } from '../providers/book-model.js';
import { parseCompanionEvent } from '../core/book-proactive.js';
import { groundedAutomaticClaim } from './automatic-fact-evidence.js';
import { cancellationCandidates } from './companion-event-cancellation.js';
import { eventProgressReport, eventProgressClaim,reportedOccurrence,reportedEventIdentity } from './companion-event-progress.js';
import {reportedResultStatus} from '../core/event-result.js';

export const memoryJobId = (scope: BookScope, turnId: string) => createHash('sha256').update(JSON.stringify([scope.characterId, scope.pairingId, scope.sessionId, turnId, 'memory-v1'])).digest('hex');
const factKey = (claim: FactClaim) => createHash('sha256').update(`${claim.subject}\0${claim.predicate}`).digest('hex');
type Repository = BookRepository & RuntimeRepository & CompanionRepository;
/** Persistent outbox. Source/user quotes pass the same FactWiki validator as reviewed ingest. */
export class AutomaticBookMemory {
  private active = new Map<string, AbortController>();
  private pending = new Set<Promise<void>>();
  private chain:Promise<void>=Promise.resolve();
  get processing():boolean{return this.pending.size>0;}
  constructor(private repository: Repository, private model: BookModelPort, private changed: (characterId: string) => void,
    private failed: (scope:BookScope,error: unknown) => void = (_scope,error) => process.stderr.write(`Automatic memory failed: ${error instanceof Error ? error.stack : String(error)}\n`)) {}
  enqueue(scope: BookScope, turn: SavedTurn): void {
    if((turn.externalDialogue??turn.dialogue)?.mode==='rp'||(turn.externalDialogue??turn.dialogue)?.memoryDomain==='fiction')return;
    const config = this.repository.loadConfig(), settings = config.companion ?? DEFAULT_COMPANION_SETTINGS;
    if (!settings.autoMemory) return;
    const data = this.repository.loadCompanionData(scope), id = memoryJobId(scope, turn.id);
    if (data.jobs.some(job => job.id === id) || data.erasedTurns.includes(id)) return;
    data.jobs.push({ id, scope: structuredClone(scope), turnId: turn.id, strategy: settings.extraction, configRevision: config.revision,
      status: 'pending', attempts: 0, claims: [], error: null });
    this.repository.saveCompanionData(scope, data); this.start(scope, id);
  }
  recover(scope: BookScope): void {
    const data = this.repository.loadCompanionData(scope);
    for (const job of data.jobs) if (job.status === 'running') { job.status = 'failed'; job.error = '整理进程中断；请显式重试。'; }
    this.repository.saveCompanionData(scope, data);
    for (const job of data.jobs.filter(job => job.status === 'pending')) this.start(scope, job.id);
    // Repair a crash between SavedTurn fsync and the outbox write without processing historical opt-out turns.
    const settings = this.repository.loadConfig().companion;
    if (settings?.autoMemory) for (const session of this.repository.listSessions(scope.characterId, scope.pairingId)) {
      const sessionScope = { ...scope, sessionId: session.sessionId };
      for (const turn of this.repository.readSession(sessionScope)) if ((turn as SavedTurn & { automaticMemoryRevision?: number }).automaticMemoryRevision === this.repository.loadConfig().revision) this.enqueue(sessionScope, turn);
    }
  }
  cancel(characterId: string): void { for (const [key, controller] of this.active) if (key.startsWith(`${characterId}:`)) controller.abort(new BookError('conflict', '记忆依据或设置已改变。')); }
  async flush(): Promise<void> { await Promise.all([...this.pending]); }
  async setPaused(scope:BookScope,paused:boolean):Promise<void>{
    if(typeof paused!=='boolean')throw new BookError('invalid_input','请明确暂停或恢复入库。');
    const data=this.repository.loadCompanionData(scope);data.memoryPaused=paused;this.repository.saveCompanionData(scope,data);
    if(paused){
      const prefix=`${scope.characterId}:${scope.pairingId}:`;
      for(const [key,controller] of this.active)if(key.startsWith(prefix))controller.abort(new BookError('busy','用户暂停自动入库。'));
      await this.flush();
    }else for(const job of data.jobs.filter(row=>row.status==='pending'))this.start(job.scope,job.id);
  }
  retry(scope: BookScope, id: string): void {
    const data = this.repository.loadCompanionData(scope), job = data.jobs.find(job => job.id === id);
    if (!job || job.status !== 'failed') throw new BookError('invalid_input', '仅失败任务可以重试。');
    if (data.erasedTurns.includes(id)) throw new BookError('conflict', '原文已撤销。');
    job.status = 'pending'; job.error = null; job.configRevision = this.repository.loadConfig().revision;
    this.repository.saveCompanionData(scope, data); this.start(scope, id);
  }
  approve(scope: BookScope, id: string, eventId?: string): void {
    const job = this.repository.loadCompanionData(scope).jobs.find(job => job.id === id);
    if (!job || job.status !== 'review') throw new BookError('invalid_input', '待审阅任务不存在。');
    if (job.eventCandidates !== undefined) {
      const turn = this.current(scope,job), data=this.repository.loadCompanionData(scope);
      const event=data.events.find(event=>event.id===eventId&&event.status!=='cancelled');
      if (!eventId || !job.eventCandidates.includes(eventId) || !event || !this.repository.snapshot(scope).entries.some(entry=>entry.id===event.entryId&&entry.enabled&&entry.revision===event.revision)) throw new BookError('conflict','请明确选择仍有效的具体事件。');
      if(job.eventProgress){
        const pending=data.jobs.find(row=>row.id===job.id)!;pending.eventProgress={...job.eventProgress,eventId};pending.claims.push({...eventProgressClaim(pending.eventProgress),start:turn.user.indexOf(pending.eventProgress.quote),correction:true});delete pending.eventCandidates;pending.error=null;
        this.repository.saveCompanionData(scope,data);this.apply(scope,pending,true);return;
      }
      this.cancelEvent(data,eventId,turn,job.scope.sessionId);
      const pending=data.jobs.find(row=>row.id===job.id)!;delete pending.eventCandidates;pending.error=null;pending.status=pending.claims.length?'review':'done';
      this.repository.saveCompanionData(scope,data);this.changed(scope.characterId);return;
    }
    this.apply(scope, job, true);
  }
  private cancelEvent(data:CompanionData,id:string,turn:SavedTurn,sessionId:string):void {
    const event=data.events.find(event=>event.id===id)!;event.status='cancelled';
    event.cancelledBy={turnId:turn.id,sessionId,quote:turn.user.slice(0,4000)};
    for(const delivery of data.deliveries)if(['reserved','dispatched'].includes(delivery.status)&&delivery.basisRefs.some(ref=>ref.id===event.entryId))delivery.status='cancelled';
  }
  private processCancellation(scope:BookScope,data:CompanionData,job:MemoryJob,turn:SavedTurn):boolean {
    const candidates=cancellationCandidates(turn.user,turn.timestamp,this.repository.loadConfig().companion!.timezone,data.events);
    if (candidates===null) return false;
    if(candidates.length===1){this.cancelEvent(data,candidates[0]!,turn,job.scope.sessionId);delete job.eventCandidates;return false;}
    job.eventCandidates=candidates;job.status='review';job.error=candidates.length?'请明确选择要取消的具体事件，尚未取消任何候选。':'未找到对应事件，请明确日期、时间或名称。';
    return true;
  }
  private start(scope: BookScope, id: string): void {
    if(this.repository.loadCompanionData(scope).memoryPaused)return;
    const key = `${scope.characterId}:${scope.pairingId}:${id}`;
    if (this.active.has(key)) return;
    const controller = new AbortController(); this.active.set(key, controller);
    const work = this.chain.then(() => {controller.signal.throwIfAborted();return this.process(scope, id, controller.signal);}).catch(error => {
      const data = this.repository.loadCompanionData(scope), job = data.jobs.find(job => job.id === id);
      if (job && job.status !== 'cancelled') {
        job.status = data.memoryPaused&&controller.signal.aborted ? 'pending' : controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = error instanceof Error ? error.message : String(error); this.repository.saveCompanionData(scope, data);
      }
      if(data.memoryPaused&&controller.signal.aborted)return;
      this.failed(scope,error);
    }).finally(() => { this.active.delete(key); this.pending.delete(work); });
    this.pending.add(work);
    this.chain=work;
  }
  private current(scope: BookScope, job: MemoryJob): SavedTurn {
    const config = this.repository.loadConfig(), data = this.repository.loadCompanionData(scope);
    if(data.memoryPaused)throw new BookError('busy','自动入库已暂停。');
    if (!config.companion?.autoMemory || config.revision !== job.configRevision || !config.characters.some(role => role.id === scope.characterId)
      || data.erasedTurns.includes(job.id) || data.jobs.find(row => row.id === job.id)?.status === 'cancelled') throw new BookError('conflict', '自动记忆任务权限、角色或来源已失效。');
    const turn = this.repository.readSession(job.scope).find(turn => turn.id === job.turnId);
    if (!turn) throw new BookError('not_found', '记忆来源聊天已不存在。'); return turn;
  }
  private async process(scope: BookScope, id: string, signal: AbortSignal): Promise<void> {
    let data = this.repository.loadCompanionData(scope), job = data.jobs.find(job => job.id === id)!;
    const turn = this.current(scope, job); job.status = 'running'; job.attempts++; this.repository.saveCompanionData(scope, data);
    if(this.repository.hasBookOperation(scope,`auto.${job.id.slice(0,32)}`)){this.finishCommitted(scope,job,turn);return;}
    let claims: MemoryJob['claims'];
    if (job.strategy === 'declarations') claims = declarationClaims(turn.user, '用户');
    else {
      const config = this.repository.loadConfig(), binding = config.wikiModel ?? config.fastModel;
      if (!binding) throw new BookError('unavailable', '自动提取需绑定 Wiki 或 Fast 模型。');
      if (!config.companion?.cloudMemoryConsent || binding.kind === 'chatgpt-web' && !config.chatgptWeb?.authorizedPurposes.includes('wiki')) throw new BookError('unavailable', '尚未单独授权自动记忆资料发送到所选模型。');
      const attributes=this.repository.snapshot(scope).entries.filter(entry=>entry.enabled&&entry.pairingId===scope.pairingId&&entry.fact).slice(-32).map(entry=>({subject:entry.fact!.subject,predicate:entry.fact!.predicate}));
      const reply = await this.model.complete(binding, [{ role: 'system', content: '仅提取用户明确陈述的现实事实。不要记录提问、假设、角色扮演、助手观点或猜测情绪。返回 JSON {"claims":[{"subject":"用户或原文主体","predicate":"属性","value":"原文中的值","quote":"连续原文引文","correction":false}]}，不确定时 claims=[]。value 必须是 quote 中逐字连续的原文子串，quote 必须是用户消息中逐字连续的片段；不可规范化或改写日期、数字、时间、标点，不可把不连续信息拼成一个 value。用户本人主体使用“用户”；其他主体必须在原文出现。事实片段后的独立提问不要包含在 quote 中。明确更正才设 correction=true。最多 16 条，不添加任何解释。相同属性沿用已有效 subject/predicate，禁止为同一属性随意换名。已有效属性名（仅用于规范名称，不作为新事实依据）：'+JSON.stringify(attributes) }, { role: 'user', content: turn.user }], AbortSignal.any([signal, AbortSignal.timeout(120000)]), { purpose: 'wiki' });
      signal.throwIfAborted(); const result = JSON.parse(reply.trim()) as { claims: MemoryJob['claims'] };
      if (!Array.isArray(result.claims) || result.claims.length > 16) throw new BookError('invalid_input', '自动提取模型未返回有效 claims。');
      claims = result.claims.map(claim => ({ ...claim, start: turn.user.indexOf(claim.quote) }));
    }
    this.current(scope, job); signal.throwIfAborted();
    // Keep an explicit fact before a separate question, while rejecting conditional clauses.
    claims = claims.flatMap(claim => { const grounded = groundedAutomaticClaim(turn.user, claim); return grounded ? [grounded] : []; });
    if(claims.length){
      if(claims.some(claim=>claim.correction!==undefined&&typeof claim.correction!=='boolean'))throw new BookError('invalid_input','事实更正标记无效。');
      new FactWikiService(this.repository).preview(scope,{sourceId:`auto.${job.id.slice(0,32)}`,title:'用户',text:turn.user,private:true,claims});
    }
    data = this.repository.loadCompanionData(scope); job = data.jobs.find(job => job.id === id)!; job.claims = claims;
    job.status = claims.length ? 'review' : 'done';
    const people=(this.repository.snapshot(scope).wikiPages??[]).filter(page=>page.kind==='person').flatMap(page=>[page.subject,...(page.aliases??[])]);
    const progress=eventProgressReport(turn.user,data.events,people,turn.timestamp,this.repository.loadConfig().companion!.timezone);
    if(progress){
      const identity=reportedEventIdentity(progress.quote,turn.timestamp,this.repository.loadConfig().companion!.timezone);
      if(data.forgottenKeys.includes('report:'+identity)){job.status='cancelled';job.claims=[];job.error='该事件报告已遗忘，不能换会话或任务编号恢复旧内容。';this.repository.saveCompanionData(scope,data);return;}
      job.eventProgress={eventId:progress.candidates.length===1?progress.candidates[0]!:progress.candidates.length===0?`event.report.${identity}`:'',status:progress.status,quote:progress.quote,...(progress.candidates.length===0?{create:true}:{})};
      if(progress.candidates.length>1){job.eventCandidates=progress.candidates;job.status='review';job.error='请明确选择所报告进展的事件，尚未更新任何候选。';this.repository.saveCompanionData(scope,data);return;}
      claims.push({...eventProgressClaim(job.eventProgress),start:turn.user.indexOf(progress.quote),correction:true});job.status='review';
    }
    const cancellationReview=this.processCancellation(scope,data,job,turn);this.repository.saveCompanionData(scope, data);
    if (claims.length && !cancellationReview) this.apply(scope, job, false);
  }
  private apply(scope: BookScope, job: MemoryJob, reviewed: boolean): void {
    const turn = this.current(scope, job), snapshot = this.repository.snapshot(scope), data = this.repository.loadCompanionData(scope);
    const claims = job.claims.filter(claim => !data.forgottenKeys.includes(`fact:${factKey(claim)}`));
    if (!claims.length) { data.jobs.find(j => j.id === job.id)!.status = 'cancelled';data.jobs.find(j => j.id === job.id)!.claims=[];
      if(!data.erasedTurns.includes(job.id))data.erasedTurns.push(job.id);this.repository.saveCompanionData(scope, data); return; }
    const service = new FactWikiService(this.repository), preview = service.preview(scope, {
      sourceId: `auto.${job.id.slice(0, 32)}`, title: '用户', text: turn.user, private: true, uri: `turn:${job.scope.sessionId}:${turn.id}`, claims,
    });
    const retire = snapshot.entries.filter(entry => entry.enabled && entry.pairingId === scope.pairingId && entry.fact && claims.some(claim => factKey(claim) === entry.fact!.key && claim.value !== entry.fact!.value));
    const explicitCorrection = !!job.eventProgress || /更正|纠正|改成|现在.*不|不再|其实|取消/.test(turn.user);
    if (!reviewed && retire.some(entry => !claims.some(claim => factKey(claim) === entry.fact!.key && claim.correction === true && explicitCorrection))) return;
    if (!reviewed && retire.some(entry => entry.pinned)) return;
    for (const entry of preview.facts) entry.sourceRefs.push(`turn:${job.scope.sessionId}:${turn.id}`);
    for(const source of preview.source.snapshots)source.capturedAt=turn.timestamp;
    this.repository.commit(scope, { upsert: [...preview.facts, ...retire.map(entry => ({ ...entry, enabled: false }))], wikiSources: [preview.source] }, snapshot.revision, `auto.${job.id.slice(0, 32)}`);
    this.finishCommitted(scope,job,turn);
  }
  private finishCommitted(scope:BookScope,job:MemoryJob,turn:SavedTurn):void {
    const latest = this.repository.loadCompanionData(scope); latest.jobs.find(j => j.id === job.id)!.status = 'done'; latest.jobs.find(j => j.id === job.id)!.error = null;
    const timezone = this.repository.loadConfig().companion!.timezone;
    const snapshot=this.repository.snapshot(scope);
    if(job.eventProgress){
      let event=latest.events.find(row=>row.id===job.eventProgress!.eventId);
      const progressEntry=snapshot.entries.find(entry=>entry.enabled&&entry.fact?.sourceId===`auto.${job.id.slice(0,32)}`&&entry.fact.predicate===`事件进展 ${job.eventProgress!.eventId}`);
      if(!event&&progressEntry&&job.eventProgress.create){event={id:job.eventProgress.eventId,entryId:progressEntry.id,revision:progressEntry.revision,quote:job.eventProgress.quote,timeExpression:'',timezone,date:null,at:null,precision:'unknown',status:job.eventProgress.status,reportedOnly:true};latest.events.push(event);}
      if(event&&progressEntry){event.status=job.eventProgress.status;event.progressEntryId=progressEntry.id;event.progressReportedAt=Date.parse(turn.timestamp);
        if(event.status==='ended')event.resultStatus=reportedResultStatus(job.eventProgress.quote);else delete event.resultStatus;
        if(event.reportedOnly){event.entryId=progressEntry.id;event.revision=progressEntry.revision;}
        const occurrence=reportedOccurrence(job.eventProgress.quote,turn.timestamp,timezone);
        event.reportedTimeline??=[];if(!event.reportedTimeline.some(row=>row.entryId===progressEntry.id))event.reportedTimeline.push({entryId:progressEntry.id,status:job.eventProgress.status,reportedAt:Date.parse(turn.timestamp),occurrence});
        event.reportedTimeline=event.reportedTimeline.slice(-32);}
    }
    for (const entry of snapshot.entries.filter(entry => entry.enabled&&entry.fact?.subject==='用户'&&entry.fact.sourceId===`auto.${job.id.slice(0,32)}`)) {
      if(entry.fact!.predicate.startsWith('事件进展 '))continue;
      if(eventProgressReport(entry.fact!.quote,[]))continue;
      const event = parseCompanionEvent(entry.fact!.quote, turn.timestamp, timezone, entry.id, entry.revision);
      if (event&&!latest.forgottenKeys.includes(`event:${event.id}`)&&!latest.events.some(row=>row.id===event.id&&row.revision===event.revision)) latest.events.push(event);
    }
    latest.events = latest.events.filter(event => snapshot.entries.some(entry=>entry.id===event.entryId&&entry.enabled));
    this.repository.saveCompanionData(scope, latest); this.changed(scope.characterId);
  }
}

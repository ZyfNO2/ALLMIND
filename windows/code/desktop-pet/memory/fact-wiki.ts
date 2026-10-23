import { createHash, randomUUID } from 'node:crypto';
import { BookError, emptyEntry, type BookRepository, type BookScope, type BookEntry, type WikiSource, type KnowledgeView } from '../contracts/memory-book.js';
import { entryVisible, validateIdentity, validateWikiSource } from './book-validation.js';
import { bookEntryHash } from './book-entry-hash.js';
import { usablePersonalWikiPages } from './personal-wiki.js';
import { bookTerms } from './local-book-index.js';
import {filterEntryTime,type EntryTimeFilter} from './book-time-filter.js';
import { staleSynthesis } from './wiki-synthesis-basis.js';
import { classifyBook, type KnowledgeCategory } from './knowledge-category.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface FactClaim { subject: string; predicate: string; value: string; quote: string; start: number }
export interface WikiIngestInput { sourceId: string; title: string; text: string; uri?: string; private?: boolean; claims?: FactClaim[]; distinctValues?:boolean }
export interface WikiPreview {
  id: string; characterId: string; pairingId: string; expectedRevision: number; source: WikiSource;
  facts: BookEntry[]; changes: { id: string; action: 'add' | 'update' | 'noop' | 'conflict' | 'forgotten' | 'retire'; reason: string }[];
  expiresAt: number;
  sourceChanged: boolean;
}
export interface WikiIssue { code: string; entryIds: string[]; message: string }
export interface WikiGraph {
  revision:number;
  nodes:{id:string;title:string;kind:'page'|'source'|'entry';pageType?:'entity'|'topic'|'event'|'source'|'unclassified';entryIds:string[];sourceId?:string;categories:KnowledgeCategory[]}[];
  edges:{from:string;to:string;kind:'source'|'related'|'semantic';label?:string;basisRefs:{entryId:string;revision:number}[]}[];
  omittedNodes:number;omittedEdges:number;
  /** Matches before the display cap. Context nodes are extra and are not included here. */
  matchedCount:number;
  contextCount:number;
  visibleCount:number;
  excluded?:{reason:string;count:number}[];
  range?:'known'|'management';
}

/** Structured declarations become atomic facts, grouped by headings; arbitrary prose needs reviewed claims.
 * No model, network, automatic fact endorsement, or raw chunk indexing masquerading as compilation. */
export function declarationClaims(text: string, title: string): FactClaim[] {
  const claims: FactClaim[] = []; let subject = title, offset = 0;
  for (const line of text.split(/\n/)) {
    const heading = /^\s*#{1,6}\s+(.+?)\s*\r?$/.exec(line);
    if (heading) subject = heading[1]!;
    else {
      const match = /^\s*(?:[-*]\s+)?([^：:\r\n]{1,80})[：:]\s*(\S[^\r\n]*)\r?$/.exec(line);
      if (match) { const quote = line.trim(); claims.push({ subject, predicate: match[1]!.trim(), value: match[2]!.trim(), quote, start: offset + line.indexOf(quote) }); }
    }
    offset += line.length + 1;
  }
  return claims;
}
export function wikiExclusions(entries: BookEntry[], sources: WikiSource[], scope: BookScope, view?: KnowledgeView, management=false): { entryId: string; reason: string }[] {
  const excluded: { entryId: string; reason: string }[] = [], candidates: BookEntry[] = [];
  for (const entry of entries) {
    if (!entryVisible(entry, scope)) { excluded.push({ entryId: entry.id, reason: 'scope_or_validity' }); continue; }
    if (entry.state && !entries.some(event => event.id === entry.state!.eventId && event.enabled && event.event && event.pairingId === entry.pairingId)) { excluded.push({ entryId: entry.id, reason: 'state_event_unavailable' }); continue; }
    if (entry.knowledge && !management) {
      const boundary = entry.knowledge;
      if (boundary.awareness === 'unknown' || !view || boundary.worldId !== view.worldId || boundary.branch !== view.branch || boundary.chapter > view.cutoff) {
        excluded.push({ entryId: entry.id, reason: 'knowledge_boundary' }); continue;
      }
    }
    if (entry.fact) {
      const source = sources.find(item => item.id === entry.fact!.sourceId);
      if (!source?.enabled || source.hash !== entry.fact.sourceHash || source.forgottenKeys.includes(entry.fact.key)) {
        excluded.push({ entryId: entry.id, reason: 'source_revoked_or_superseded' }); continue;
      }
      if (entry.body !== `${entry.fact.subject}的${entry.fact.predicate}：${entry.fact.value}`) { excluded.push({ entryId: entry.id, reason: 'manual_fact_review_required' }); continue; }
      candidates.push(entry);
    }
  }
  const groups = new Map<string, BookEntry[]>();
  for (const entry of candidates) { const key = JSON.stringify([entry.pairingId??'author',entry.organization?.domain??null,entry.knowledge?.worldId??null,entry.knowledge?.branch??null,entry.fact!.subject,entry.fact!.predicate]); const rows = groups.get(key) ?? []; rows.push(entry); groups.set(key, rows); }
  for (const rows of groups.values()) {
    if (new Set(rows.map(entry => entry.fact!.value)).size > 1&&!rows.some(entry=>entry.organization?.coexisting))
      for (const entry of rows) excluded.push({ entryId: entry.id, reason: 'conflicting_fact' });
    else {const values=new Map<string,BookEntry[]>();for(const entry of rows){const group=values.get(entry.fact!.value)??[];group.push(entry);values.set(entry.fact!.value,group);}for(const group of values.values())for(const entry of group.sort((a,b)=>a.id.localeCompare(b.id)).slice(1))excluded.push({entryId:entry.id,reason:'duplicate_fact'});}
  }
  const hidden = new Set(excluded.filter(row => row.reason !== 'duplicate_fact').map(row => row.entryId));
  for (const entry of entries) if (entry.synthesis && (staleSynthesis(entry, entries, sources) || entry.synthesis.basis.some(ref => hidden.has(ref.entryId)))) excluded.push({ entryId: entry.id, reason: 'stale_synthesis' });
  return excluded;
}

/** Persistent source snapshots and atomic facts are the owner. Pages/index/lint are reproducible views. */
export class FactWikiService {
  private previews = new Map<string, WikiPreview>();
  clearPreviews(characterId:string):void{for(const [id,preview] of this.previews)if(preview.characterId===characterId)this.previews.delete(id);}
  constructor(private readonly repository: BookRepository) {}
  validateInput(scope: BookScope, input: WikiIngestInput): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BookError('invalid_input', 'Wiki 来源无效。');
    validateIdentity(input.sourceId, 'sourceId');
    if(input.distinctValues!==undefined&&typeof input.distinctValues!=='boolean')throw new BookError('invalid_input','多值事实选项无效。');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || input.title.includes('\0') || typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > 65536)
      throw new BookError('invalid_input', 'Wiki 来源标题或正文无效（正文最多 64 KiB）。');
    if (input.private !== undefined && typeof input.private !== 'boolean' || input.uri !== undefined && (typeof input.uri !== 'string' || input.uri.length > 2000 || input.uri.includes('\0'))) throw new BookError('invalid_input', 'Wiki 来源选项无效。');
    const book = this.repository.snapshot(scope), old = book.wikiSources?.find(item => item.id === input.sourceId), pairingId = input.private ? scope.pairingId : null;
    if (old && old.pairingId !== pairingId) throw new BookError('conflict', '来源的作用域不能在更新中变更。');
    if (old && !old.enabled) throw new BookError('conflict', '来源已撤销，需使用新的显式来源身份。');
    if (old && old.snapshots.length >= 16 && !old.snapshots.some(snapshot => snapshot.hash === hash(input.text))) throw new BookError('invalid_input', '来源快照已达 16 个上限，需显式归档。');
    if (!old && (book.wikiSources?.length ?? 0) >= 8192) throw new BookError('budget', '当前作用域来源已达 8192 个上限，请先导出并整理。');
  }
  preview(scope: BookScope, input: WikiIngestInput): WikiPreview {
    this.validateInput(scope, input);
    const book = this.repository.snapshot(scope), old = book.wikiSources?.find(item => item.id === input.sourceId), pairingId = input.private ? scope.pairingId : null;
    const sourceHash = hash(input.text), snapshots = structuredClone(old?.snapshots ?? []);
    if (!snapshots.some(item => item.hash === sourceHash)) snapshots.push({ hash: sourceHash, text: input.text, capturedAt: new Date().toISOString() });
    const uri = input.uri ?? old?.uri ?? null;
    const source: WikiSource = { id: input.sourceId, title: input.title, uri, pairingId, enabled: true,
      hash: sourceHash, revision: (old?.revision ?? 0) + (old?.hash === sourceHash && old.title === input.title && old.uri === uri ? 0 : 1), forgottenKeys: [...old?.forgottenKeys ?? []], snapshots };
    validateWikiSource(source);
    const claims = input.claims ?? declarationClaims(input.text, input.title);
    if (!Array.isArray(claims) || !claims.length || claims.length > 64) throw new BookError('invalid_input', '请提供 1～64 条带原文定位的事实；自由正文需在预览中明确事实与证据，不能把整段文本自动认定为事实。');
    const keys = new Set<string>();
    const facts = claims.map(claim => {
      if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new BookError('invalid_input', '事实候选必须是对象。');
      for (const field of ['subject', 'predicate', 'value', 'quote'] as const) if (typeof claim[field] !== 'string' || !claim[field].trim() || claim[field].length > (field === 'quote' ? 4000 : 1000)) throw new BookError('invalid_input', `事实 ${field} 无效。`);
      if (claim.subject.length > 100 || claim.predicate.length > 100 || !Number.isSafeInteger(claim.start) || claim.start < 0 || input.text.slice(claim.start, claim.start + claim.quote.length) !== claim.quote || !claim.quote.includes(claim.value) || claim.subject !== input.title && !input.text.includes(claim.subject))
        throw new BookError('invalid_input', '事实值、主体或 UTF-16 原文位置无法在来源中核验。');
      const key = hash(`${claim.subject}\0${claim.predicate}`), id = `wiki.${hash(`${input.sourceId}\0${pairingId ?? ''}`).slice(0, 16)}.${key.slice(0, 16)}${input.distinctValues?'.'+hash(claim.value).slice(0,12):''}`,unique=input.distinctValues?key+':'+claim.value:key;
      if (keys.has(unique)) throw new BookError('invalid_input', '同来源同主体/属性有重复或矛盾，请先拆清事实。'); keys.add(unique);
      const entry = emptyEntry(id, 'wiki', `${claim.subject} · ${claim.predicate}`, `${claim.subject}的${claim.predicate}：${claim.value}`);
      entry.pairingId = pairingId; entry.origin = pairingId ? 'observed' : 'authored'; entry.entities = [claim.subject]; entry.aliases = [claim.subject]; entry.tags = [claim.predicate];
      entry.sourceRefs = [`wiki-source:${input.sourceId}@${sourceHash}`];
      entry.fact = { sourceId: input.sourceId, sourceHash, subject: claim.subject, predicate: claim.predicate, value: claim.value, quote: claim.quote, start: claim.start, end: claim.start + claim.quote.length, status: 'source_asserted', key };
      const existing = book.entries.find(item => item.id === id); entry.revision = existing?.revision ?? 0; return entry;
    });
    // Relationships between facts are ID references, not duplicated canonical bodies.
    for (const entry of facts) entry.related = facts.filter(other => other.id !== entry.id && other.fact!.subject === entry.fact!.subject).slice(0, 8).map(other => other.id);
    const changes: WikiPreview['changes'] = facts.map(entry => {
      const existing = book.entries.find(item => item.id === entry.id), contentHash = bookEntryHash(entry); entry.importedHash = contentHash;
      if (source.forgottenKeys.includes(entry.fact!.key)) return { id: entry.id, action: 'forgotten', reason: '事实已遗忘，禁止从同来源重新构建' };
      if (!existing) return { id: entry.id, action: 'add', reason: '新事实' };
      if (bookEntryHash(existing) === contentHash) return { id: entry.id, action: 'noop', reason: '来源与事实无变化' };
      if (!existing.importedHash || existing.importedHash !== bookEntryHash(existing)) return { id: entry.id, action: 'conflict', reason: '保留用户手工修改，更新待处理' };
      return { id: entry.id, action: 'update', reason: '来源修订后的有据更新' };
    });
    for (const existing of book.entries.filter(item => item.fact?.sourceId === source.id && item.enabled && !facts.some(entry => entry.id === item.id))) {
      const action = existing.importedHash === bookEntryHash(existing) ? 'retire' as const : 'conflict' as const;
      changes.push({ id: existing.id, action, reason: '新来源不再支持旧事实；手改保留' });
      if (action === 'retire') facts.push({ ...existing, enabled: false });
    }
    const preview: WikiPreview = { id: randomUUID(), characterId: scope.characterId, pairingId: scope.pairingId, expectedRevision: book.revision, source, facts, changes, sourceChanged: !old || JSON.stringify(old) !== JSON.stringify(source), expiresAt: Date.now() + 15 * 60000 };
    for (const [id, p] of this.previews) if (p.expiresAt < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.id, structuredClone(preview)); return structuredClone(preview);
  }
  apply(scope: BookScope, previewId: string, operationId: string) {
    const p = this.previews.get(previewId);
    if (!p || p.expiresAt < Date.now() || p.characterId !== scope.characterId || p.pairingId !== scope.pairingId) throw new BookError('not_found', 'Wiki 预览已失效或不属于当前作用域。');
    const upsert = p.facts.filter(entry => p.changes.some(change => change.id === entry.id && ['add', 'update', 'retire'].includes(change.action)));
    const wikiSources = p.sourceChanged ? [p.source] : [];
    return this.repository.commit(scope, { upsert, wikiSources }, p.expectedRevision, operationId);
  }
  revoke(scope: BookScope, sourceId: string, expectedRevision: number, operationId: string) {
    const source = this.repository.snapshot(scope).wikiSources?.find(item => item.id === sourceId);
    if (!source) throw new BookError('not_found', 'Wiki 来源不存在。');
    return this.repository.commit(scope, { wikiSources: [{ ...source, enabled: false, revision: source.revision + (source.enabled ? 1 : 0) }] }, expectedRevision, operationId);
  }
  pages(scope: BookScope, view?: KnowledgeView, include?: (entry:BookEntry)=>boolean, management=false) {
    const book = this.repository.snapshot(scope), excluded = new Set(wikiExclusions(book.entries, book.wikiSources ?? [], scope, view,management).filter(item => item.reason !== 'duplicate_fact').map(item => item.entryId));
    const groups = new Map<string, BookEntry[]>();
    for (const entry of book.entries.filter(e => e.origin !== 'inferred' && e.sourceRefs.length && !excluded.has(e.id) && (!include || include(e)))) {
      for (const subject of entry.synthesis ? ['synthesis.'+entry.id] : entry.fact ? [entry.fact.subject] : entry.entities.length ? entry.entities : [entry.title]) {
        const groupKey=entry.knowledge?subject+'\0'+JSON.stringify([entry.knowledge.worldId,entry.knowledge.branch,entry.type==='persona'?'persona':'world']):subject;
        const rows = groups.get(groupKey) ?? []; rows.push(entry); groups.set(groupKey, rows);
      }
    }
    const pages = [...groups].map(([subject, facts]) => {
      const lines = new Map<string, BookEntry[]>();
      for (const entry of facts) { const key = entry.fact ? `${entry.pairingId}:${entry.fact.predicate}:${entry.fact.value}` : entry.id; const rows = lines.get(key) ?? []; rows.push(entry); lines.set(key, rows); }
      const synthesized=facts.length===1?facts[0]?.synthesis:undefined,title=synthesized?facts[0]!.title:subject.split('\0')[0]!;
      return { id: `page.${hash(subject).slice(0, 16)}`, subject:title, entryIds: [...new Set(facts.flatMap(e=>[e.id,...(e.synthesis?.basis.map(ref=>ref.entryId)??[])]))],
        body: synthesized ? `# ${title}\n\n${facts[0]!.body}` : `# ${title}\n\n` + [...lines.values()].map(rows => `- [${rows[0]!.type}/${rows[0]!.origin}] ${rows[0]!.body} [${rows.map(e => e.id).join(', ')}]`).join('\n'),
        sourceIds: [...new Set(facts.flatMap(e => e.synthesis ? e.synthesis.sources.map(ref=>ref.id) : e.fact ? [e.fact.sourceId] : e.sourceRefs))] };
    });
    const compiled=usablePersonalWikiPages(book,scope).filter(page=>page.basisRefs.every(ref=>!excluded.has(ref.entryId)&&(!include||Boolean(book.entries.find(row=>row.id===ref.entryId&&include(row)))))),allPages=[...compiled,...pages];
    return { revision: book.revision, pages:allPages, index: allPages.map(page => ({ id: page.id, title: page.subject, factCount: page.entryIds.length })), sourceCount: book.wikiSources?.length ?? 0,compiledCount:compiled.length };
  }
  graph(scope:BookScope,view?:KnowledgeView,includeUnlinked=false,time?:EntryTimeFilter,selection?:{category?:KnowledgeCategory;text?:string;range?:'known'|'management'}):WikiGraph{
    const management=selection?.range==='management';
    const book=this.repository.snapshot(scope),pages=this.pages(scope,view,undefined,management).pages;
    const filtered=time?new Set(filterEntryTime(book,book.entries,time).map(entry=>entry.id)):null;
    if(filtered){for(let index=pages.length-1;index>=0;index--){const page=pages[index]!;page.entryIds=page.entryIds.filter(id=>filtered.has(id));if(!page.entryIds.length)pages.splice(index,1);}}
    const nodes:WikiGraph['nodes']=pages.map(page=>({id:page.id,title:page.subject,kind:'page',entryIds:page.entryIds,categories:[]}));
    const edges:WikiGraph['edges']=[],sources=new Set<string>();
    const refs=(ids:string[])=>ids.flatMap(id=>{const entry=book.entries.find(row=>row.id===id);return entry?[{entryId:id,revision:entry.revision}]:[]});
    for(const page of pages){
      for(const sourceId of page.sourceIds){
        const source=book.wikiSources?.find(row=>(row.id===sourceId||sourceId===`wiki-source:${row.id}@${row.hash}`)&&row.enabled&&(row.pairingId===null||row.pairingId===scope.pairingId));if(!source)continue;
        const id='graph-source.'+hash(source.id).slice(0,24);
        const basis=page.entryIds.flatMap(entryId=>{const entry=book.entries.find(entry=>entry.id===entryId);return entry?.synthesis?.sources.some(ref=>ref.id===source.id)?entry.synthesis.basis.map(ref=>ref.entryId):entry&&(entry.fact?.sourceId===source.id||entry.sourceRefs.some(ref=>ref===source.id||ref===`wiki-source:${source.id}@${source.hash}`))?[entryId]:[];});if(!basis.length)continue;
        if(!sources.has(id)){sources.add(id);nodes.push({id,title:source.title,kind:'source',entryIds:[],sourceId:source.id,categories:[]});}
        edges.push({from:page.id,to:id,kind:'source',basisRefs:refs(basis)});
      }
      for(const target of book.wikiPages?.find(row=>row.id===page.id)?.links??[]){
        if(pages.some(other=>other.id===target))edges.push({from:page.id,to:target,kind:'related',basisRefs:refs(page.entryIds)});
      }
      for(const entry of book.entries.filter(entry=>page.entryIds.includes(entry.id)&&entry.synthesis))for(const relation of entry.synthesis!.relations){
        const target=pages.find(other=>other.entryIds.includes(relation.targetId));
        if(target&&target.id!==page.id)edges.push({from:page.id,to:target.id,kind:'semantic',label:relation.label,basisRefs:refs(relation.basisEntryIds)});
      }
    }
    if(includeUnlinked){
      const excluded=new Set(wikiExclusions(book.entries,book.wikiSources??[],scope,view,management).map(row=>row.entryId)),linked=new Set(pages.flatMap(page=>page.entryIds));
      for(const entry of book.entries)if(!excluded.has(entry.id)&&!linked.has(entry.id)&&(!filtered||filtered.has(entry.id)))nodes.push({id:'graph-entry.'+entry.id,title:entry.title||entry.id,kind:'entry',entryIds:[entry.id],categories:[]});
    }
    // Ordinary entry.related is an explicit authored edge, not a similarity guess.
    const owners=new Map<string,string[]>();
    for(const node of nodes)for(const id of node.entryIds)owners.set(id,[...(owners.get(id)??[]),node.id]);
    for(const entry of book.entries)for(const target of entry.related)for(const from of owners.get(entry.id)??[])for(const to of owners.get(target)??[]){
      if(from!==to)edges.push({from,to,kind:'related',basisRefs:refs([entry.id,target])});
    }
    const uniqueEdges=new Map<string,WikiGraph['edges'][number]>();
    for(const edge of edges){
      const ends=edge.kind==='related'?[edge.from,edge.to].sort():[edge.from,edge.to];
      const key=JSON.stringify([edge.kind,...ends,edge.label??'']);
      const previous=uniqueEdges.get(key);
      if(previous)previous.basisRefs=[...new Map([...previous.basisRefs,...edge.basisRefs].map(ref=>[ref.entryId,ref])).values()];else uniqueEdges.set(key,edge);
    }
    const decisions=classifyBook(book.entries);
    for(const node of nodes){
      node.categories=[...new Set(node.entryIds.flatMap(id=>{const category=decisions.get(id)?.category;return category?[category]:[];}))];
      const entries=book.entries.filter(entry=>node.entryIds.includes(entry.id));
      // A synthesis title was historically copied into entities; it is not evidence of an entity.
      const synthesized=entries.find(entry=>entry.synthesis&&entry.title===node.title)?.synthesis;
      node.pageType=node.kind==='source'?'source':synthesized?(synthesized.pageType??'topic'):entries.some(entry=>entry.event)?'event':entries.some(entry=>entry.entities.includes(node.title)||entry.fact?.subject===node.title)?'entity':'unclassified';
    }
    const selected=selectGraph(nodes,[...uniqueEdges.values()],selection);
    const visible=selected.nodes.slice(0,128),ids=new Set(visible.map(node=>node.id)),connected=selected.edges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to));
    const shown=connected.slice(0,2048);
    const counts=new Map<string,number>();for(const row of wikiExclusions(book.entries,book.wikiSources??[],scope,view,management))counts.set(row.reason,(counts.get(row.reason)??0)+1);
    return {revision:book.revision,nodes:visible,edges:shown,omittedNodes:selected.nodes.length-visible.length,omittedEdges:selected.edges.length-shown.length,matchedCount:selected.matchedCount,contextCount:selected.contextCount,visibleCount:visible.length,range:management?'management':'known',excluded:[...counts].map(([reason,count])=>({reason,count}))};
  }
  query(scope:BookScope,query:string,view?:KnowledgeView){
    if(typeof query!=='string'||!query.trim()||query.length>4000)throw new BookError('invalid_input','请输入有界 Wiki 查询。');
    const terms=[...new Set(bookTerms(query))],result=this.pages(scope,view);
    const pages=result.pages.map(page=>({page,score:terms.filter(term=>bookTerms(`${page.subject}\n${page.body}`).includes(term)).length})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.page.id.localeCompare(b.page.id)).slice(0,20).map(row=>row.page);
    return {...result,query,pages};
  }
  lint(scope: BookScope, view?: KnowledgeView) {
    const book = this.repository.snapshot(scope), issues: WikiIssue[] = [], exclusions = wikiExclusions(book.entries, book.wikiSources ?? [], scope, view);
    const usable=new Set(usablePersonalWikiPages(book,scope).map(page=>page.id));
    for(const page of book.wikiPages??[]){
      if(!usable.has(page.id))issues.push({code:'stale_compiled_page',entryIds:page.entryIds,message:`编纂页 ${page.subject} 的依据已过期或修订，需要刷新。`});
      if(page.links.some(id=>!(book.wikiPages??[]).some(other=>other.id===id)))issues.push({code:'broken_page_link',entryIds:page.entryIds,message:`编纂页 ${page.subject} 的关联页缺失。`});
    }
    for (const item of exclusions) if (!['scope_or_validity', 'duplicate_fact'].includes(item.reason)) issues.push({ code: item.reason, entryIds: [item.entryId], message: '该事实目前不可消费；请检查来源、冲突或知识视角。' });
    for (const entry of book.entries) {
      for (const related of entry.related) if (!book.entries.some(e => e.id === related)) issues.push({ code: 'broken_link', entryIds: [entry.id], message: `缺少关联：${related}` });
      if (entry.enabled && !entry.sourceRefs.length) issues.push({ code: 'missing_source', entryIds: [entry.id], message: '手工条目尚无来源引用。' });
      if (entry.validUntil && Date.parse(entry.validUntil) <= Date.now()) issues.push({ code: 'expired', entryIds: [entry.id], message: '条目有效期已结束。' });
    }
    for (const source of book.wikiSources ?? []) if (source.enabled) {
      const snapshot = source.snapshots.find(item => item.hash === source.hash)!;
      for (const claim of declarationClaims(snapshot.text, source.title)) {
        const key = hash(`${claim.subject}\0${claim.predicate}`);
        if (!source.forgottenKeys.includes(key) && !book.entries.some(entry => entry.enabled && entry.fact?.sourceId === source.id && entry.fact.key === key && entry.fact.sourceHash === source.hash))
          issues.push({ code: 'uncompiled_declaration', entryIds: [], message: `来源 ${source.id} 的声明尚未整理：${claim.subject} / ${claim.predicate}` });
      }
    }
    return { revision: book.revision, issues };
  }
}

function selectGraph(nodes:WikiGraph['nodes'],edges:WikiGraph['edges'],selection?:{category?:KnowledgeCategory;text?:string}){
  const text=selection?.text?.trim().toLocaleLowerCase()??'';
  const category=selection?.category;
  if(!category&&!text)return {nodes,edges,matchedCount:nodes.length,contextCount:0};
  const matchesCategory=(node:WikiGraph['nodes'][number])=>!category||(node.kind!=='source'&&node.categories.includes(category));
  const pool=category?nodes.filter(node=>matchesCategory(node)||(node.kind==='source'&&edges.some(edge=>{const otherId=edge.from===node.id?edge.to:edge.to===node.id?edge.from:'';return Boolean(otherId)&&nodes.some(other=>other.id===otherId&&matchesCategory(other));}))):nodes;
  const poolIds=new Set(pool.map(node=>node.id));
  const poolEdges=edges.filter(edge=>poolIds.has(edge.from)&&poolIds.has(edge.to));
  const matched=pool.filter(node=>matchesCategory(node)&&(!text||node.title.toLocaleLowerCase().includes(text)));
  const matchedIds=new Set(matched.map(node=>node.id));
  const contextIds=new Set<string>();
  for(const edge of poolEdges){
    if(matchedIds.has(edge.from)&&!matchedIds.has(edge.to))contextIds.add(edge.to);
    if(matchedIds.has(edge.to)&&!matchedIds.has(edge.from))contextIds.add(edge.from);
  }
  if(!text)for(const node of pool)if(node.kind==='source'&&!matchedIds.has(node.id))contextIds.add(node.id);
  const context=pool.filter(node=>contextIds.has(node.id));
  const ordered=[...matched,...context];
  const ids=new Set(ordered.map(node=>node.id));
  return {nodes:ordered,edges:poolEdges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to)),matchedCount:matched.length,contextCount:context.length};
}

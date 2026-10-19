import { BookError, type BookEntry, type BookRepository, type BookScope, type KnowledgeView } from '../contracts/memory-book.js';
import type { BookResourceService } from './book-resources.js';
import type { ResourceRecord } from '../contracts/book-resources.js';
import type { FactWikiService } from './fact-wiki.js';
import { organizationExclusion } from './wiki-organization.js';
import { bookTerms } from './local-book-index.js';
import { wikiExclusions } from './fact-wiki.js';
import { posix } from 'node:path';
import type { ReaderAsset, ReaderDocument, ReaderEdge, ReaderTimelineItem, WikiReaderResult } from '../contracts/wiki-reader.js';

type Listed = { id: string; subject: string; body: string; entryIds: string[]; sourceIds: string[]; links?: string[]; revision?:number; history?:{revision:number}[]; state?:'stale' };

function readableHtml(raw:string):string{
  const attr=(tag:string,key:string)=>new RegExp('\\b'+key+'\\s*=\\s*(?:"([^"<>]*)"|\'([^\'<>]*)\'|([^\\s<>]+))','i').exec(tag)?.slice(1).find(Boolean)??'';
  const safe=(target:string)=>!!target&&!/[\s<>\[\]()\\]/.test(target)&&! /^(?:javascript|data|file|vbscript):/i.test(target);
  return raw.replace(/<(script|style|iframe|object|svg)\b[^]*?<\/\1\s*>/gi,'').replace(/<img\b[^>]*>/gi,tag=>{const target=attr(tag,'src');return safe(target)?`![${attr(tag,'alt').replace(/[\[\]]/g,'')||'图片'}](${target})`:'';}).replace(/<a\b([^>]*)>([^]*?)<\/a\s*>/gi,(_all,tag:string,label:string)=>{const target=attr(tag,'href'),text=readableText(label);return safe(target)?`[${text}](${target})`:text;}).replace(/<h([1-6])\b[^>]*>([^]*?)<\/h\1\s*>/gi,(_all,level:string,text:string)=>`\n${'#'.repeat(Number(level))} ${readableText(text)}\n`).replace(/<\/?(?:p|div|br|li|ul|ol)\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
}

/** HTML is reduced to text. Scripts, handlers and javascript URLs never reach the reader. */
export function readableText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export class WikiReader {
  private denied=new Set<string>();
  private protectedSources=new Set<string>();
  constructor(private readonly repository: BookRepository, private readonly wiki: FactWikiService, private readonly resources?: BookResourceService) {}

  read(scope: BookScope, input: { pageId?: string; query?: string; view?: KnowledgeView; cursor?: string; limit?: number }): WikiReaderResult {
    const book = this.repository.snapshot(scope);
    const view = input.view;
    const hidden = new Set([...book.entries.filter(entry => this.hidden(entry, view)).map(entry => entry.id),...wikiExclusions(book.entries,book.wikiSources??[],scope,view).filter(row=>row.reason!=='duplicate_fact').map(row=>row.entryId)]);
    this.denied=new Set();this.protectedSources=new Set();for(const entry of book.entries.filter(row=>hidden.has(row.id))){for(const ref of entry.organization?.resourceRefs??[])this.denied.add(ref.resourceId);for(const id of new Set([...entry.sourceRefs,...(entry.fact?[entry.fact.sourceId]:[])])){this.protectedSources.add(id);const uri=book.wikiSources?.find(source=>source.id===id)?.uri;if(uri?.startsWith('resource:'))this.denied.add(uri.slice(9));}}
    const listed = (this.wiki.pages(scope, view,entry=>!hidden.has(entry.id)).pages as Listed[]);
    for(const page of book.wikiPages??[])if(page.characterId===scope.characterId&&page.pairingId===scope.pairingId&&!listed.some(row=>row.id===page.id)&&page.basisRefs.length&&page.basisRefs.every(ref=>book.entries.some(entry=>entry.id===ref.entryId&&!hidden.has(entry.id)))&&page.sources.every(ref=>book.wikiSources?.some(source=>source.id===ref.id&&source.enabled)))listed.push({...page,body:'',links:[],state:'stale'});
    const terms = input.query?.trim() ? new Set(bookTerms(input.query)) : null;
    const matched = listed.filter(page => !terms || bookTerms(`${page.subject}\n${page.body}`).some(term => terms.has(term)));
    const ordered = [...matched].sort((a, b) => a.id.localeCompare(b.id));
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new BookError('invalid_input', '阅读目录每页 1～30 条。');
    const start = input.cursor ? ordered.findIndex(page => page.id === input.cursor) + 1 : 0;
    if (input.cursor && start <= 0) throw new BookError('invalid_input', '阅读目录游标无效。');
    const slice = ordered.slice(start, start + limit);
    const pages = slice.map(page => ({ id: page.id, title: page.subject, state: page.state??'current' as const }));
    const selected = input.pageId ? listed.find(page => page.id === input.pageId) ?? null : slice[0] ?? null;
    if (input.pageId && !selected && !input.pageId.startsWith('resource:')) throw new BookError('not_found', '这篇资料不在当前角色、配对或阅读范围里。');
    const document = selected ? this.document(scope, book.revision, selected, book.entries, hidden) : input.pageId?.startsWith('resource:') ? this.resourceDocument(scope, book.revision, input.pageId.slice('resource:'.length)) : null;
    if(document)for(const link of document.links)if(link.state==='page'&&!listed.some(page=>page.id===link.target.slice(5)))link.state='missing';
    const visible=book.entries.filter(entry=>!hidden.has(entry.id));
    const graph = document?.id.startsWith('resource:')?this.resourceGraph(document):this.graph(listed, selected, visible, book.wikiSources ?? []);
    const timeline = this.timeline(book.entries.filter(entry => !hidden.has(entry.id)));
    const forNextTurn = (document?.assets ?? []).filter(asset => asset.state === 'ready' && asset.sha256).map(asset => ({ resourceId: asset.resourceId, sha256: asset.sha256!, revision: asset.revision, use: asset.kind === 'image' ? 'image' as const : 'text' as const }));
    const materials=(this.resources?.list(scope)??[]).filter(record=>!!this.resource(scope,record.id)).map(record=>({id:record.id,title:record.name,state:record.state}));
    return { scope: { ...scope }, view: view ?? null, bookRevision: book.revision, pages, nextCursor: start + limit < ordered.length ? slice.at(-1)?.id ?? null : null, materials,document, graph, timeline, forNextTurn };
  }

  private hidden(entry: BookEntry, view?: KnowledgeView): boolean {
    if (organizationExclusion(entry, view ? 'story-rp' : 'smart')) return true;
    if (!view || !entry.knowledge) return false;
    const boundary = entry.knowledge;
    return boundary.awareness === 'unknown' || boundary.worldId !== view.worldId || boundary.branch !== view.branch || boundary.chapter > view.cutoff;
  }

  private resourceGraph(document:ReaderDocument):WikiReaderResult['graph']{
    const nodes:WikiReaderResult['graph']['nodes']=[{id:document.id,title:document.title,kind:'page'}],edges:ReaderEdge[]=[];
    for(const link of document.links.filter(row=>row.state==='asset')){const asset=document.assets.find(row=>row.resourceId===link.target);if(asset?.state&&asset.state!=='ready')continue;const target='resource:'+link.target;if(target===document.id)continue;if(!nodes.some(row=>row.id===target))nodes.push({id:target,title:link.label,kind:'source'});edges.push({from:document.id,to:target,kind:'source_citation',experience:false,basis:[{ownerId:document.id,revision:document.revision,field:'document.links'}]});}
    const visible=nodes.slice(0,100),ids=new Set(visible.map(row=>row.id)),selected=edges.filter(row=>ids.has(row.from)&&ids.has(row.to)).slice(0,200);if(!selected.length)visible[0]!.isolated='没有可核验的关联';return{nodes:visible,edges:selected,omittedNodes:nodes.length-visible.length,omittedEdges:edges.length-selected.length};
  }

  private document(scope: BookScope, bookRevision: number, page: Listed, entries: BookEntry[], hidden: Set<string>): ReaderDocument {
    const visible = page.entryIds.filter(id => !hidden.has(id));
    const body = page.body;
    const sources = page.sourceIds.flatMap(id => {
      if(this.protectedSources.has(id))return [];
      const source = this.repository.snapshot(scope).wikiSources?.find(item => item.id === id && item.enabled);
      if (!source) return [];
      const nature = source.uri?.startsWith('resource:') ? 'material' as const : 'user_statement' as const;
      const resourceId=source.uri?.startsWith('resource:')?source.uri.slice(9):undefined;
      return [{ id: source.id, title: source.title, revision: source.revision, hash: source.hash, nature, ...(resourceId&&this.resource(scope,resourceId)?{resourceId}:{}),excerpts:entries.filter(entry=>visible.includes(entry.id)&&entry.fact?.sourceId===id).map(entry=>({quote:entry.fact!.quote,start:entry.fact!.start,end:entry.fact!.end})) }];
    });
    const contexts=sources.flatMap(source=>source.resourceId?[source.resourceId]:[]);
    const {assets,links}=this.links(scope,body,contexts.length===1?this.resource(scope,contexts[0]!):null);
    return {
      id: page.id, revision: page.revision??1, bookRevision, title: page.subject, body, format: 'markdown', state: page.state??'current',
      basisRefs: visible.flatMap(id => { const entry = entries.find(item => item.id === id); return entry ? [{ entryId: id, revision: entry.revision }] : []; }),
      sources, assets, links,...(page.history?{history:page.history.map(row=>({revision:row.revision}))}:{})
    };
  }

  private resourceDocument(scope: BookScope, bookRevision: number, resourceId: string): ReaderDocument {
    const record = this.resource(scope, resourceId);
    const state = !record ? 'unavailable' as const : record.state === 'revoked' ? 'unavailable' as const : record.state === 'ready' ? 'current' as const : 'unavailable' as const;
    let body = '';
    if (record?.state === 'ready' && record.kind !== 'image' && record.kind !== 'zip' && this.resources) {
      body = this.resources.readMaterialSnapshot(scope, resourceId).text;
      if(record.kind==='html')body=readableHtml(new TextDecoder('utf-8',{fatal:true}).decode(this.resources.store.readBytes(scope,resourceId))).slice(0,65536);
    }
    const asset = this.asset(record, record?.name ?? resourceId);
    const resolved=this.links(scope,body,record),members=record?.kind==='zip'?this.resources?.list(scope).filter(row=>row.origin.parentResourceId===record.id)??[]:[];
    return { id: `resource:${resourceId}`, revision: record?.revision ?? 0, bookRevision, title: record?.name ?? '资料不可用', body, format: record?.kind==='text'?'text':'markdown', state, basisRefs: [], sources: [], assets: [...new Map([...(asset&&record?.kind!=='zip'?[asset]:[]),...resolved.assets].map(row=>[row.resourceId,row])).values()], links: [...resolved.links,...members.map(row=>({label:row.origin.memberPath??row.name,target:row.id,state:'asset' as const}))] };
  }

  private links(scope: BookScope, body: string,context:ResourceRecord|null=null): { assets: ReaderAsset[]; links: ReaderDocument['links'] } {
    const assets: ReaderAsset[] = [];
    const links: ReaderDocument['links'] = [];
    const pattern = /!?\[([^\]]*)\]\(([^)\s]+)\)/g;
    for (const match of body.matchAll(pattern)) {
      const label = match[1] || '链接';
      let target = match[2]??'';
      try{target=decodeURIComponent(target);}catch{links.push({label,target,state:'missing'});continue;}
      if (/^https?:\/\//i.test(target)) { links.push({ label, target, state: 'external' }); continue; }
      if (target.startsWith('page:')) { links.push({ label, target, state: 'page' }); continue; }
      const id = target.startsWith('resource:') ? target.slice('resource:'.length) : null;
      const records = this.resources ? this.resources.list(scope).filter(item => item.scope.characterId === scope.characterId && item.scope.pairingId === scope.pairingId) : [];
      const member=context?.origin.parentResourceId?posix.normalize(posix.join(posix.dirname(context.origin.memberPath??context.name),target)):null;
      const matches = (id ? [this.resource(scope,id)].filter((row):row is ResourceRecord=>!!row) : /[:\\\0]/.test(target)||target.startsWith('/')?[]:member?records.filter(item=>!member.startsWith('../')&&item.origin.parentResourceId===context!.origin.parentResourceId&&item.origin.memberPath===member):records.filter(item=>!item.origin.parentResourceId&&item.name===target)).filter(record=>!!this.resource(scope,record.id));
      if (matches.length > 1) { links.push({ label, target, state: 'duplicate' }); continue; }
      const record = matches[0];
      if (!record) { links.push({ label, target, state: 'missing' }); continue; }
      const asset = this.asset(record, label);
      if (asset) assets.push(asset);
      links.push({ label, target: record.id, state: record.state === 'ready' ? 'asset' : 'missing' });
    }
    return { assets:[...new Map(assets.map(row=>[row.resourceId,row])).values()], links };
  }

  private asset(record: ResourceRecord | null, label: string): ReaderAsset | null {
    if (!record) return { resourceId: '', revision: 0, sha256: null, kind: 'document', label, state: 'unresolved', reason: '未找到同源资料' };
    const kind = record.kind === 'image' ? 'image' as const : 'document' as const;
    if (record.state === 'ready') return { resourceId: record.id, revision: record.revision, sha256: record.sha256, kind, label, state: 'ready',nature:record.origin.kind==='provider'&&kind==='image'?'generated_image':'material' };
    if (record.state === 'revoked') return { resourceId: record.id, revision: record.revision, sha256: record.sha256, kind, label, state: 'revoked', reason: '资料已撤销' };
    return { resourceId: record.id, revision: record.revision, sha256: record.sha256, kind, label, state: 'unavailable', reason: record.error?.message ?? '资料不可读' };
  }

  private resource(scope: BookScope, id: string): ResourceRecord | null {
    if (!this.resources||this.denied.has(id)) return null;
    try { const record=this.resources.get(scope, id);return record.origin.parentResourceId&&this.denied.has(record.origin.parentResourceId)?null:record; } catch(error) { if(error instanceof BookError&&error.code==='not_found')return null;throw error; }
  }

  private graph(pages: Listed[], selected: Listed | null, entries: BookEntry[], sources: { id: string; title: string; enabled: boolean; revision: number }[]): WikiReaderResult['graph'] {
    const nodes: WikiReaderResult['graph']['nodes'] = [];
    const edges: ReaderEdge[] = [];
    const related=new Set(entries.filter(entry=>selected?.entryIds.includes(entry.id)).flatMap(entry=>entry.related));
    const focus = selected ? [selected, ...pages.filter(page => page.id !== selected.id&&((selected.links??[]).includes(page.id)||(page.links??[]).includes(selected.id)||page.sourceIds.some(id=>selected.sourceIds.includes(id))||page.entryIds.some(id=>related.has(id))))] : pages;
    for (const page of focus) {
      nodes.push({ id: page.id, title: page.subject, kind: 'page' });
      for (const sourceId of page.sourceIds) {
        if(this.protectedSources.has(sourceId))continue;
        const source = sources.find(item => item.id === sourceId && item.enabled);
        if (!source) continue;
        const id = `source:${source.id}`;
        if (!nodes.some(node => node.id === id)) nodes.push({ id, title: source.title, kind: 'source' });
        const owner = entries.find(entry => page.entryIds.includes(entry.id) && (entry.fact?.sourceId === source.id||entry.sourceRefs.includes(source.id)));
        if (owner) edges.push({ from: page.id, to: id, kind: 'source_citation', basis: [{ ownerId: owner.id, revision: owner.revision, field: owner.fact?'fact.sourceId':'sourceRefs' }], experience: false });
      }
      for (const target of page.links ?? []) {
        if (!pages.some(page => page.id === target)) continue;
        edges.push({ from: page.id, to: target, kind: 'page_link', basis: [{ ownerId: page.id, revision: page.revision??1, field: 'links' }], experience: false });
      }
    }
    for (const entry of entries) {
      if (!focus.some(page => page.entryIds.includes(entry.id))) continue;
      for (const related of entry.related) {
        const target = entries.find(item => item.id === related && pages.some(page => page.entryIds.includes(item.id)));
        if (!target) continue;
        if (!nodes.some(node => node.id === entry.id)) nodes.push({ id: entry.id, title: entry.title || entry.id, kind: 'entry' });
        if (!nodes.some(node => node.id === target.id)) nodes.push({ id: target.id, title: target.title || target.id, kind: 'entry' });
        edges.push({ from: entry.id, to: related, kind: 'entry_related', basis: [{ ownerId: entry.id, revision: entry.revision, field: 'related' }], experience: false });
      }
    }
    const visibleNodes = nodes.slice(0, 100);
    const ids = new Set(visibleNodes.map(node => node.id));
    const visibleEdges = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).slice(0, 200);
    for(const node of visibleNodes)if(!visibleEdges.some(edge=>edge.from===node.id||edge.to===node.id))node.isolated='没有可核验的关联';
    return { nodes: visibleNodes, edges: visibleEdges, omittedNodes: Math.max(0, nodes.length - visibleNodes.length), omittedEdges: Math.max(0, edges.length - visibleEdges.length) };
  }

  private timeline(entries: BookEntry[]): ReaderTimelineItem[] {
    return entries.filter(entry => entry.enabled && (entry.event || /键盘|按键/.test(entry.body))).sort((a,b)=>(b.timeStart??'').localeCompare(a.timeStart??'')||a.id.localeCompare(b.id)).slice(0, 50).map(entry => {
      const input = /键盘|按键|检测到键盘/.test(entry.body);
      const domain = entry.organization?.domain ?? null;
      const reference = domain === 'external' || domain === 'author' || domain === 'rp';
      return { id: entry.id, label: input ? '输入活动' : reference ? '资料记录' : '已记录', activity: input ? 'input' as const : reference ? 'reference' as const : 'recorded' as const, quote: input?'检测到输入活动；具体用途未知。':entry.event?.quote ?? entry.body.slice(0, 240), domain,time:entry.timeStart };
    });
  }
}

import { createHash } from 'node:crypto';
import type { BookEntry,BookSnapshot,BookScope,PersonalWikiPage,PersonalWikiRevision } from '../contracts/memory-book.js';
import { entryVisible,validateIdentity } from './book-validation.js';
import { wikiExclusions } from './fact-wiki.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const labels={profile:'个人资料',person:'人物',preference:'偏好',event:'事件',relationship:'关系记录',topic:'进行中的话题',experience:'共同经历'};
const narrativeLabels={profile:'身份与称呼',person:'人物资料',preference:'兴趣与相处偏好',event:'安排与进展',relationship:'人物联系',topic:'当前话题',experience:'已陈述的经历'};
const theme=(entry:BookEntry):PersonalWikiPage['kind']=>{
  const predicate=entry.fact!.predicate;
  if(/经历|一起|共同|回忆|见面|看展|展览/.test(predicate))return 'experience';
  if(/事件|面试|考试|答辩|演出|比赛|安排|约会|日程/.test(predicate))return 'event';
  if(/朋友|同事|家人|父母|伴侣|关系/.test(predicate))return 'relationship';
  if(/喜欢|偏好|爱好|饮品|咖啡|茶|称呼|希望|沟通/.test(predicate))return 'preference';
  return 'topic';
};
/** Deterministic compilation of already validated claims. No new facts, model calls or second owner.
 * Model-based extraction remains the existing consented pipeline; this layer compiles facets and links. */
export function compilePersonalWiki(book:BookSnapshot,stats?:{compiled:number;reused:number;removed:number}):PersonalWikiPage[]{
  if(stats)Object.assign(stats,{compiled:0,reused:0,removed:0});
  const previous=new Map((book.wikiPages??[]).map(page=>[page.id,page]));
  const pairs=[...new Set(book.entries.filter(entry=>entry.pairingId&&entry.fact&&entry.origin==='observed'&&!entry.knowledge).map(entry=>entry.pairingId!))];
  const pages:PersonalWikiPage[]=[];
  for(const pairingId of pairs){
    const scope={characterId:book.characterId,pairingId,sessionId:'wiki-compiler'};
    const excluded=new Set(wikiExclusions(book.entries,book.wikiSources??[],scope).map(row=>row.entryId));
    const facts=book.entries.filter(entry=>entry.pairingId===pairingId&&entry.fact&&entry.origin==='observed'&&!entry.knowledge&&!excluded.has(entry.id));
    const normalized=(name:string)=>name.normalize('NFKC').toLowerCase().trim();
    const aliasClaims=facts.filter(entry=>/别名|昵称|英文名/.test(entry.fact!.predicate)&&entry.fact!.subject!=='用户'&&entry.fact!.value.length<=100);
    const aliasMap=new Map<string,{name:string;entry:BookEntry}>(),ambiguous=new Set<string>();
    for(const entry of aliasClaims){const key=normalized(entry.fact!.value),old=aliasMap.get(key);if(old&&normalized(old.name)!==normalized(entry.fact!.subject)){ambiguous.add(key);aliasMap.delete(key);}else if(!ambiguous.has(key))aliasMap.set(key,{name:entry.fact!.subject,entry});}
    const groups=new Map<string,{subject:string;kind:PersonalWikiPage['kind'];facts:BookEntry[];layer?:PersonalWikiPage['layer']}>();
    const add=(subject:string,kind:PersonalWikiPage['kind'],entry:BookEntry)=>{const alias=kind==='person'?aliasMap.get(normalized(subject)):undefined;subject=alias?.name??subject;const key=`${kind}:${subject}`,group=groups.get(key)??{subject,kind,facts:[]};for(const row of alias?[entry,alias.entry]:[entry])if(!group.facts.some(old=>old.id===row.id))group.facts.push(row);groups.set(key,group)};
    for(const entry of facts){
      add(entry.fact!.subject,entry.fact!.subject==='用户'?'profile':'person',entry);
      const kind=theme(entry);add(`${entry.fact!.subject} · ${labels[kind]}`,kind,entry);
      if(kind==='relationship'&&entry.fact!.value.length<=100)add(entry.fact!.value,'person',entry);
    }
    const experiences=facts.filter(entry=>entry.fact!.subject==='用户'&&(theme(entry)==='experience'||entry.fact!.predicate.startsWith('事件进展 ')));
    const captured=(entry:BookEntry)=>book.wikiSources?.find(source=>source.id===entry.fact!.sourceId)?.snapshots.at(-1)?.capturedAt??'';
    const chronological=[...experiences].sort((a,b)=>captured(b).localeCompare(captured(a))||a.id.localeCompare(b.id));
    const addLayer=(subject:string,kind:PersonalWikiPage['kind'],layer:NonNullable<PersonalWikiPage['layer']>,rows:BookEntry[])=>{if(rows.length)groups.set(`${kind}:${subject}`,{subject,kind,layer,facts:rows.slice(0,8)})};
    addLayer('用户 · 近期经历摘要','experience','recent',chronological);
    addLayer('用户 · 长期重要经历','experience','important',chronological.filter(entry=>entry.pinned||entry.importance>=70));
    const activeEvents=book.companionData?.find(data=>data.pairingId===pairingId)?.events.filter(event=>['scheduled','ongoing'].includes(event.status))??[];
    addLayer('用户 · 进行中话题','topic','ongoing',facts.filter(entry=>entry.fact!.subject==='用户'&&(/当前|正在|进行中/.test(entry.fact!.predicate)||activeEvents.some(event=>event.entryId===entry.id||event.progressEntryId===entry.id))));
    for(const group of groups.values()){
      const id=`personal.${hash([book.characterId,pairingId,group.kind,group.subject]).slice(0,28)}`;
      const groupEvents=(book.companionData?.find(data=>data.pairingId===pairingId)?.events??[]).filter(event=>group.facts.some(entry=>entry.id===event.entryId));
      const sourceInputs=[...new Set(group.facts.map(entry=>entry.fact!.sourceId))].sort().map(id=>{const source=book.wikiSources!.find(source=>source.id===id)!;return [id,source.hash,source.revision,source.snapshots.at(-1)?.capturedAt]});
      const organized=group.facts.some(entry=>entry.organization);
      const compilationInputHash=hash([organized?'personal-wiki/v5':'personal-wiki/v4',group.kind,group.subject,group.layer??null,group.facts.map(entry=>organized?[entry.id,entry.revision,entry.pinned,entry.organization?.domain??null,entry.organization?.evidenceStatus??null]:[entry.id,entry.revision,entry.pinned]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),sourceInputs,
        groupEvents.map(event=>[event,event.progressEntryId?facts.find(entry=>entry.id===event.progressEntryId)?.revision??null:null])]);
      const old=previous.get(id);
      const approved=[...(book.companionData?.find(data=>data.pairingId===pairingId)?.wikiJobs??[])].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id)).find(job=>job.status==='applied'&&job.scope.characterId===book.characterId&&job.targets.some(target=>target.pageId===id&&target.inputHash===compilationInputHash)&&job.results.some(result=>result.pageId===id));
      const result=approved?.results.find(result=>result.pageId===id);
      const compilation=approved&&result?{jobId:approved.id,resultHash:hash(result)}:undefined;
      if(old?.compilationInputHash===compilationInputHash&&JSON.stringify(old.compilation)===JSON.stringify(compilation)){pages.push(structuredClone(old));if(stats)stats.reused++;continue;}
      if(stats)stats.compiled++;
      // Identity/pinned material stays in the profile; other details rotate by source capture time.
      const ordered=group.facts.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||Number(/称呼|姓名|名字/.test(b.fact!.predicate))-Number(/称呼|姓名|名字/.test(a.fact!.predicate))||
        (book.wikiSources?.find(source=>source.id===b.fact!.sourceId)?.snapshots.at(-1)?.capturedAt??'').localeCompare(book.wikiSources?.find(source=>source.id===a.fact!.sourceId)?.snapshots.at(-1)?.capturedAt??'')||a.id.localeCompare(b.id));
      const included:BookEntry[]=[];let narrativeBytes=0;
      for(const entry of ordered){const cost=Buffer.byteLength(`目前有据记录为「${entry.body}」〔${entry.id}〕。`,'utf8');if(included.length>=32||narrativeBytes+cost>48000)break;included.push(entry);narrativeBytes+=cost;}
      const basisRefs=included.map(entry=>({entryId:entry.id,revision:entry.revision}));
      const sourceIds=[...new Set(included.map(entry=>entry.fact!.sourceId))];
      const sources=sourceIds.map(id=>{const source=book.wikiSources!.find(source=>source.id===id)!;return {id,hash:source.hash,revision:source.revision}});
      const narrativeGroups=new Map<string,BookEntry[]>();
      for(const entry of included){const kind=/称呼|姓名|名字/.test(entry.fact!.predicate)?'profile':theme(entry),key=`${entry.fact!.subject}\0${kind}`;const rows=narrativeGroups.get(key)??[];rows.push(entry);narrativeGroups.set(key,rows);}
      const narrative=result?result.paragraphs.map(paragraph=>`${paragraph.text} ${paragraph.entryIds.map(id=>`〔${id}〕`).join('')}`).join('\n\n')+[...included.filter(entry=>entry.pinned)].map(entry=>`\n\n固定原文：「${entry.body}」〔${entry.id}〕`).join(''):[...narrativeGroups].map(([key,rows])=>{
        const [subject,kind]=key.split('\0') as [string,PersonalWikiPage['kind']];
        const descriptions=rows.map(entry=>`${group.layer?`记录于 ${captured(entry)} 的`:''}「${entry.body}」〔${entry.id}〕`);
        return `关于${subject}的${narrativeLabels[kind]}，有效资料${rows.length>1?'共同形成以下当前理解':'目前明确记录'}：${descriptions.join('；')}。`;
      }).join('');
      const events=groupEvents.filter(event=>included.some(entry=>entry.id===event.entryId));
      let eventBytes=0;
      const eventText=events.flatMap(event=>{
        const progress=event.progressEntryId?included.find(entry=>entry.id===event.progressEntryId):undefined;
        const status=event.status==='cancelled'?'已取消':progress&&event.status==='ongoing'?'用户报告正在进行':progress&&event.status==='ended'?'用户报告已结束':'已记录的安排';
        const occurrence=[...(event.reportedTimeline??[])].reverse().find(row=>row.entryId===event.progressEntryId)?.occurrence;
        const text=`「${event.quote.slice(0,400)}${event.quote.length>400?'…（原文节选）':''}」目前为${status}，${event.reportedOnly?'没有先前安排，不补造计划时间':`原安排 ${event.date??'日期未知'} ${event.timeExpression||'时间尚未明确'}（${event.timezone}）`}${event.plannedEndAt!==undefined?`，用户明确的计划结束时间为 ${new Date(event.plannedEndAt).toISOString()}（UTC；不证明实际结束）`:''}；${progress?`进展原文「${progress.fact!.quote}」〔${progress.id}〕，报告时间 ${event.progressReportedAt===undefined?'未提供':new Date(event.progressReportedAt).toISOString()}；`:''}${occurrence?`用户报告的发生时间 ${occurrence.at===null?occurrence.date??'未知':new Date(occurrence.at).toISOString()}，时区 ${occurrence.timezone}，精度 ${occurrence.precision}，原表达 ${occurrence.timeExpression||'未提供'}；这不是独立核实。`:''}仅以上报告为据，其余未提供的实际起止时间和结果保持未知。`;
        const cost=Buffer.byteLength(text);if(eventBytes+cost>8000)return [];eventBytes+=cost;return [text];
      }).join('');
      const layerRule=group.layer==='recent'?'最近记录的最多 8 项用户陈述经历；记录时间不是事件发生时间。':group.layer==='important'?'仅保留用户固定或明确设为高重要性的最多 8 项经历；不自动推断重要性。':group.layer==='ongoing'?'当前话题与尚未明确结束的安排；不将原安排时间当作已发生证明。':'';
      const domains=[...new Set(included.flatMap(entry=>entry.organization?[`domain:${entry.organization.domain} / evidence:${entry.organization.evidenceStatus}`]:[]))];
      const body=`# ${group.subject}\n\n## 当前理解\n\n${layerRule}${narrative}\n\n${eventText?`## 事件与进展\n\n${eventText}\n\n`:''}## 依据与维护\n\n本页合并 ${sourceIds.length} 个有效来源，记录类别为${labels[group.kind]}。${domains.length?`领域与认识：${domains.join('、')}。`:''}${ordered.length>included.length?'摘要受 32 项与文本预算限制；其余原始事实仍保留并可检索。':''}新信息明确更正后更新当前理解；矛盾内容不作为当前结论。`;
      const aliases=group.kind==='person'?[group.subject,...included.filter(entry=>/别名|昵称|英文名/.test(entry.fact!.predicate)&&normalized(entry.fact!.subject)===normalized(group.subject)).map(entry=>entry.fact!.value)]:[group.subject];
      const page:PersonalWikiPage={id,characterId:book.characterId,pairingId,subject:group.subject,aliases:[...new Set(aliases)],compilationInputHash,...(group.layer?{layer:group.layer}:{}),kind:group.kind,body,basisRefs,sources,entryIds:included.map(entry=>entry.id),sourceIds,revision:0,fingerprint:'',links:[],backlinks:[],history:[]};
      pages.push(page);
      if(compilation)page.compilation=compilation;
    }
  }
  for(const page of pages){
    page.links=pages.filter(other=>other.id!==page.id&&other.pairingId===page.pairingId&&other.entryIds.some(id=>page.entryIds.includes(id))).map(other=>other.id);
    page.backlinks=[...page.links];
    const fingerprintParts:unknown[]=[page.body,page.basisRefs,page.sources,page.links,page.aliases,page.compilationInputHash];if(page.layer)fingerprintParts.push(page.layer);
    if(page.compilation)fingerprintParts.push(page.compilation);
    page.fingerprint=hash(fingerprintParts);
    const old=previous.get(page.id);
    if(old?.fingerprint===page.fingerprint){page.revision=old.revision;page.history=old.history.filter(history=>historyAvailable(history,book));continue;}
    page.revision=(old?.revision??0)+1;
    const history=old?[...old.history,{revision:old.revision,body:old.body,fingerprint:old.fingerprint,basisRefs:old.basisRefs,sources:old.sources,...(old.compilation?{compilation:old.compilation}:{})}]:[];
    page.history=history.filter(history=>historyAvailable(history,book)).slice(-8);
  }
  if(stats)stats.removed=[...previous.keys()].filter(id=>!pages.some(page=>page.id===id)).length;
  return pages;
}
function historyAvailable(history:PersonalWikiRevision,book:BookSnapshot):boolean{
  return history.basisRefs.every(ref=>book.entries.some(entry=>entry.id===ref.entryId&&entry.fact&&!book.wikiSources?.find(source=>source.id===entry.fact!.sourceId)?.forgottenKeys.includes(entry.fact!.key)))&&
    history.sources.every(ref=>book.wikiSources?.some(source=>source.id===ref.id&&source.enabled&&source.snapshots.some(snapshot=>snapshot.hash===ref.hash)));
}
export function usablePersonalWikiPages(book:BookSnapshot,scope:BookScope):PersonalWikiPage[]{
  const excluded=new Set(wikiExclusions(book.entries,book.wikiSources??[],scope).map(row=>row.entryId));
  return (book.wikiPages??[]).filter(page=>page.characterId===scope.characterId&&page.pairingId===scope.pairingId&&page.basisRefs.every(ref=>book.entries.some(entry=>entry.id===ref.entryId&&entry.revision===ref.revision&&entryVisible(entry,scope)&&!excluded.has(entry.id)))&&page.sources.every(ref=>book.wikiSources?.some(source=>source.id===ref.id&&source.enabled&&source.hash===ref.hash&&source.revision===ref.revision)));
}
export function validatePersonalWikiPages(pages:PersonalWikiPage[],characterId:string):void{
  if(!Array.isArray(pages)||pages.length>4096)throw Error('Invalid personal Wiki page collection');
  const ids=new Set<string>();
  for(const page of pages){
    validateIdentity(page.id);validateIdentity(page.pairingId);
    if(ids.has(page.id)||page.characterId!==characterId||!Object.hasOwn(labels,page.kind)||typeof page.subject!=='string'||page.subject.length>200||typeof page.body!=='string'||Buffer.byteLength(page.body)>65536||!Number.isSafeInteger(page.revision)||page.revision<1||!Array.isArray(page.history)||page.history.length>8)throw Error('Invalid personal Wiki page');
    ids.add(page.id);
    for(const list of [page.basisRefs,page.sources,page.entryIds,page.sourceIds,page.links,page.backlinks])if(!Array.isArray(list)||list.length>4096)throw Error('Invalid personal Wiki references');
    for(const ref of page.basisRefs){validateIdentity(ref.entryId);if(!Number.isSafeInteger(ref.revision)||ref.revision<1)throw Error('Invalid personal Wiki basis');}
    for(const ref of page.sources){validateIdentity(ref.id);if(!/^[a-f0-9]{64}$/.test(ref.hash)||!Number.isSafeInteger(ref.revision)||ref.revision<1)throw Error('Invalid personal Wiki source');}
    if(page.aliases!==undefined&&(!Array.isArray(page.aliases)||page.aliases.length>64||page.aliases.some(alias=>typeof alias!=='string'||alias.length>200)))throw Error('Invalid personal Wiki aliases');
    const fingerprintParts:unknown[]=[page.body,page.basisRefs,page.sources,page.links];if(page.aliases!==undefined)fingerprintParts.push(page.aliases);
    if(page.compilationInputHash!==undefined){if(!/^[a-f0-9]{64}$/.test(page.compilationInputHash))throw Error('Invalid personal Wiki compilation input');fingerprintParts.push(page.compilationInputHash);}
    if(page.layer!==undefined){if(!['recent','important','ongoing'].includes(page.layer))throw Error('Invalid personal Wiki layer');fingerprintParts.push(page.layer);}
    if(page.compilation){validateIdentity(page.compilation.jobId);if(!/^[a-f0-9]{64}$/.test(page.compilation.resultHash))throw Error('Invalid personal Wiki compilation result');fingerprintParts.push(page.compilation);}
    if(page.fingerprint!==hash(fingerprintParts))throw Error('Personal Wiki fingerprint mismatch');
    for(const revision of page.history)if(typeof revision.body!=='string'||Buffer.byteLength(revision.body)>65536||!Number.isSafeInteger(revision.revision)||revision.revision<1||!Array.isArray(revision.basisRefs)||!Array.isArray(revision.sources)||!/^[a-f0-9]{64}$/.test(revision.fingerprint))throw Error('Invalid personal Wiki revision');
  }
}

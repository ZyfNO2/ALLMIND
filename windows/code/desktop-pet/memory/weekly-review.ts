import {BookError,type BookRepository,type RuntimeRepository,type BookScope,type BookEntry} from '../contracts/memory-book.js';
import {zonedParts,addDays} from '../core/book-proactive.js';
import {wikiExclusions} from './fact-wiki.js';
import {usablePersonalWikiPages} from './personal-wiki.js';
import type {WeeklyReviewResult} from '../contracts/weekly-review.js';

/** A fresh local projection, not another memory store or inferred account of the week. */
export function weeklyReview(repository:BookRepository&RuntimeRepository,scope:BookScope,now=Date.now()):WeeklyReviewResult{
  const config=repository.loadConfig(),timezone=config.companion?.timezone??'Asia/Singapore',to=zonedParts(now,timezone).date,from=addDays(to,-6);
  const days=Array.from({length:7},(_,index)=>({date:addDays(from,index),turns:0})),sessions=repository.listSessions(scope.characterId,scope.pairingId);
  if(sessions.length>256)throw new BookError('budget','本地周回顾暂支持最多256个会话；未省略会话或生成不完整统计。');
  const seen=new Set<string>();let scanned=0;
  for(const session of sessions)for(const turn of repository.readSession({...scope,sessionId:session.sessionId})){
    if(++scanned>50000)throw new BookError('budget','本地周回顾扫描超过50000轮；未省略旧记录或生成不完整统计。');
    const key=JSON.stringify([turn.sessionId,turn.id]);if(turn.incognito||seen.has(key)||Date.parse(turn.timestamp)>now)continue;seen.add(key);
    const day=days.find(day=>day.date===zonedParts(Date.parse(turn.timestamp),timezone).date);if(day)day.turns++;
  }
  const book=repository.snapshot(scope),view=config.characters.find(role=>role.id===scope.characterId)?.knowledgeView;
  const excluded=new Set(wikiExclusions(book.entries,book.wikiSources??[],scope,view).filter(row=>row.reason!=='duplicate_fact').map(row=>row.entryId));
  const groups=new Map<string,{entry:BookEntry;at:number}>();
  for(const entry of book.entries){
    if(!entry.fact||entry.pairingId!==scope.pairingId||excluded.has(entry.id))continue;
    const source=book.wikiSources?.find(source=>source.id===entry.fact!.sourceId),snapshot=source?.snapshots.find(snapshot=>snapshot.hash===entry.fact!.sourceHash);
    if(!snapshot)continue;const at=Date.parse(snapshot.capturedAt);if(!Number.isFinite(at))throw new BookError('corrupt_data','周回顾来源记录时间无效。');
    const key=JSON.stringify([entry.fact.key,entry.fact.value.normalize('NFKC').trim()]),prior=groups.get(key);
    if(!prior||at<prior.at)groups.set(key,{entry,at});
  }
  const memories=[...groups.values()].filter(row=>row.at<=now&&zonedParts(row.at,timezone).date>=from&&zonedParts(row.at,timezone).date<=to).sort((a,b)=>b.at-a.at||a.entry.id.localeCompare(b.entry.id));
  const recentIds=new Set(memories.map(row=>row.entry.id)),eligibleIds=new Set(book.entries.filter(entry=>!excluded.has(entry.id)).map(entry=>entry.id));
  const pages=usablePersonalWikiPages(book,scope).filter(page=>page.entryIds.every(id=>eligibleIds.has(id))),links=new Set<string>();
  for(const page of pages)for(const id of page.links){const other=pages.find(other=>other.id===id);if(other&&(page.entryIds.some(id=>recentIds.has(id))||other.entryIds.some(id=>recentIds.has(id))))links.add([page.id,other.id].sort().join('|'));}
  return {from,to,timezone,revision:book.revision,generatedAt:new Date(now).toISOString(),days,chatDays:days.filter(day=>day.turns>0).length,turns:days.reduce((count,day)=>count+day.turns,0),newMemories:memories.length,relatedPageLinks:links.size,topics:[...new Set(memories.map(row=>row.entry.fact!.predicate))].slice(0,24),omittedMemories:Math.max(0,memories.length-24),memories:memories.slice(0,24).map(({entry,at})=>({entryId:entry.id,revision:entry.revision,sourceId:entry.fact!.sourceId,recordedAt:new Date(at).toISOString(),subject:entry.fact!.subject,predicate:entry.fact!.predicate,value:entry.fact!.value,quote:entry.fact!.quote}))};
}

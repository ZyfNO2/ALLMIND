import { createHash } from 'node:crypto';
import type { BookSnapshot, BookScope, BookEntry } from '../contracts/memory-book.js';
import { wikiExclusions } from '../memory/fact-wiki.js';

export interface CompanionRelationship {
  pairingId: string; revision: number; fingerprint: string;
  familiarity: number; trust: number | null; commonExperiences: number;
  preferences: { entryId: string; revision: number; predicate: string; value: string }[];
  interests: { entryId: string; revision: number; value: string }[];
  basisRefs: { entryId: string; revision: number }[];
  emotion: { kind: 'happy' | 'concerned'; reportedAt: number; entryId: string; revision: number } | null;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Inspectable rules over effective evidence. No inferred trust and no absence penalty. */
export function compileRelationships(book:BookSnapshot):CompanionRelationship[]{
  const pairs=[...new Set(book.entries.flatMap(entry=>entry.pairingId&&entry.fact&&entry.fact.subject==='用户'&&entry.origin==='observed'&&!entry.knowledge?[entry.pairingId]:[]))];
  return pairs.map(pairingId=>{
    const scope={characterId:book.characterId,pairingId,sessionId:'relationship-compiler'};
    const excluded=new Set(wikiExclusions(book.entries,book.wikiSources??[],scope).filter(row=>row.reason!=='duplicate_fact').map(row=>row.entryId));
    const evidence=book.entries.filter(entry=>entry.pairingId===pairingId&&entry.origin==='observed'&&!entry.knowledge&&entry.fact?.subject==='用户'&&!excluded.has(entry.id));
    // Retain every valid source for inspection, count each supported statement once.
    const unique=new Map<string,BookEntry>();
    for(const entry of evidence){const key=JSON.stringify([entry.fact!.predicate.normalize('NFKC').trim(),entry.fact!.value.normalize('NFKC').trim()]);if(!unique.has(key))unique.set(key,entry);}
    const facts=[...unique.values()];
    const sources=[...new Set(facts.map(entry=>entry.fact!.sourceId))];
    const communication=facts.filter(entry=>/称呼|叫我|沟通|表达|回复长度|安静|关心方式/.test(entry.fact!.predicate));
    const interests=facts.filter(entry=>/爱好|兴趣|喜欢/.test(entry.fact!.predicate));
    const trust=facts.filter(entry=>/信任|反馈/.test(entry.fact!.predicate)&&/信任你|信任角色|记对了|记得很准/.test(entry.fact!.value)&&!/不信任|没信任|不再信任|没(?:有)?记对|记错|不准|假如|如果|吗|[?？]/.test(entry.fact!.value));
    const shared=facts.filter(entry=>/共同|一起|经历/.test(entry.fact!.predicate)&&/你|角色|AIKI|Aika/i.test(entry.fact!.value));
    const outcomes=facts.filter(entry=>entry.fact!.predicate.startsWith('事件进展 ')&&/通过了|成功了|没(?:有)?通过|未通过|失败了/.test(entry.fact!.value)&&!/尚未|还未|暂未|不知道|未知|是否|不确定|可能/.test(entry.fact!.value));
    const captured=(entry:BookEntry)=>Date.parse(book.wikiSources?.find(source=>source.id===entry.fact!.sourceId)?.snapshots.at(-1)?.capturedAt??'');
    outcomes.sort((a,b)=>captured(b)-captured(a)||a.id.localeCompare(b.id));
    const outcome=outcomes[0];
    const emotion=outcome&&Number.isFinite(captured(outcome))?{kind:/没(?:有)?通过|未通过|失败了/.test(outcome.fact!.value)?'concerned' as const:'happy' as const,reportedAt:captured(outcome),entryId:outcome.id,revision:outcome.revision}:null;
    const row={pairingId,familiarity:Math.min(100,sources.length*2),trust:trust.length?Math.min(100,50+trust.length*5):null,commonExperiences:Math.min(100,shared.length),
      preferences:communication.slice(-16).map(entry=>({entryId:entry.id,revision:entry.revision,predicate:entry.fact!.predicate,value:entry.fact!.value})),
      interests:interests.slice(-8).map(entry=>({entryId:entry.id,revision:entry.revision,value:entry.fact!.value})),
      basisRefs:evidence.map(entry=>({entryId:entry.id,revision:entry.revision})),emotion};
    const fingerprint=digest(row),old=book.relationships?.find(row=>row.pairingId===pairingId);
    return {...row,fingerprint,revision:old?.fingerprint===fingerprint?old.revision:(old?.revision??0)+1};
  });
}
export function relationshipFor(book:BookSnapshot,scope:BookScope,now=Date.now()){
  // Revalidate at consumption so an expired source cannot continue changing expression.
  const relationship=compileRelationships(book).find(row=>row.pairingId===scope.pairingId);
  if(!relationship)return null;
  const elapsed=relationship.emotion?Math.max(0,now-relationship.emotion.reportedAt):0;
  const intensity=relationship.emotion?Math.max(0,.45*(1-Math.min(1,elapsed/(2*3600000)))):0;
  return {...relationship,emotion:relationship.emotion&&intensity>0?{...relationship.emotion,intensity}:null};
}
export function relationshipInstruction(book:BookSnapshot,scope:BookScope):string{
  const row=relationshipFor(book,scope);if(!row?.basisRefs.length)return '';
  const preferences=row.preferences.slice(-8).map(pref=>`${pref.predicate}：${pref.value.slice(0,160)}${pref.value.length>160?'（节选）':''}〔${pref.entryId}@r${pref.revision}〕`).join('；');
  return `【本实例相处依据】熟悉程度由 ${row.familiarity/2} 组去重的有效用户依据形成；${row.trust===null?'没有明确的信任反馈，不自行断言信任。':'已有明确正向反馈，但不据此声称依赖或排他关系。'}共同经历只按明确来源记录 ${row.commonExperiences} 项。${preferences?`用户沟通偏好：${preferences}。`:''}${row.emotion?`最近有据事件回应基调：${row.emotion.kind==='happy'?'温和庆祝':'温和关心'}，强度 ${row.emotion.intensity.toFixed(2)}〔${row.emotion.entryId}@r${row.emotion.revision}〕。不猜测用户情绪。`:''}维持核心角色人格和自主兴趣，不因离线、未回应或拒绝改变信任，不反复提及同一经历。`;
}
export function validateRelationships(rows:CompanionRelationship[]):void{
  if(!Array.isArray(rows)||rows.length>64)throw Error('Invalid relationship collection');
  const pairs=new Set<string>();
  for(const row of rows){
    if(!row||typeof row.pairingId!=='string'||pairs.has(row.pairingId)||!Number.isSafeInteger(row.revision)||row.revision<1||![row.familiarity,row.commonExperiences,...(row.trust===null?[]:[row.trust])].every(value=>Number.isFinite(value)&&value>=0&&value<=100)||!Array.isArray(row.preferences)||row.preferences.length>16||!Array.isArray(row.interests)||row.interests.length>8||!Array.isArray(row.basisRefs)||row.basisRefs.length>8192)throw Error('Invalid relationship state');
    const {revision:_revision,fingerprint,...content}=row;if(fingerprint!==digest(content))throw Error('Invalid relationship fingerprint');pairs.add(row.pairingId);
  }
}

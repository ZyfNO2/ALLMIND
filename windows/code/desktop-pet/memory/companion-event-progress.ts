import type { CompanionEvent, MemoryJob, ReportedOccurrence } from '../contracts/book-companion.js';
import type { FactClaim } from './fact-wiki.js';
import { groundedAutomaticClaim } from './automatic-fact-evidence.js';
import {parseCompanionEvent,zonedParts,addDays} from '../core/book-proactive.js';
import {createHash} from 'node:crypto';

export function reportedEventIdentity(quote:string,timestamp:string,timezone:string):string{
  const occurrence=reportedOccurrence(quote,timestamp,timezone);
  return createHash('sha256').update(JSON.stringify([['面试','考试','答辩','演出','比赛'].filter(kind=>quote.includes(kind)),(quote.match(/[A-Za-z0-9_-]+公司|[\p{Script=Han}]{2,6}公司/gu)??[]).map(name=>name.normalize('NFKC').toLowerCase()).sort(),['模拟','资格审查','资格审核','报名','培训','笔试','初试','复试','终面'].filter(stage=>quote.includes(stage)),occurrence.date])).digest('hex').slice(0,32);
}

export function reportedOccurrence(quote:string,timestamp:string,timezone:string):ReportedOccurrence{
  const zone=/(?:Asia|America|Europe|Africa|Australia|Pacific|Atlantic|Indian|Etc)\/[A-Za-z0-9_+/-]+/.exec(quote)?.[0]??timezone;
  const relative=/前天|昨天|今天/.exec(quote)?.[0];
  const date=relative?addDays(zonedParts(Date.parse(timestamp),zone).date,relative==='昨天'?-1:relative==='前天'?-2:0):null;
  const dateMentions=[...quote.matchAll(/前天|昨天|今天|\d{4}[-年]\d{1,2}[-月]\d{1,2}日?/g)];
  if(dateMentions.length>1)return {date:null,at:null,precision:'unknown',timeExpression:dateMentions.map(match=>match[0]).join(' / ').slice(0,200),timezone:zone};
  const parsed=parseCompanionEvent(date?quote.replace(relative!,date):quote,timestamp,zone,'reported-time',1);
  return {date:parsed?.date??null,at:parsed?.at??null,precision:parsed?.precision??'unknown',timeExpression:date?(parsed?.timeExpression??'').replace(date,relative!):parsed?.timeExpression??'',timezone:zone};
}

/** Explicit present/past reports only. Ambiguous event identity remains a review. */
export function eventProgressReport(text: string, events: CompanionEvent[], knownPeople:string[]=[],reportedAt?:string,timezone='Asia/Singapore'): { candidates: string[]; status: 'ongoing' | 'ended'; quote: string } | null {
  const grounded=(quote:string)=>groundedAutomaticClaim(text,{subject:'用户',predicate:'事件进展',value:quote,quote,start:0});
  for(const sentence of text.matchAll(/[^。！？!?；;\n]+/g)){
    const clauses=[...sentence[0].matchAll(/[^，,]+/g)];
    for(let index=0;index<clauses.length;index++){
      const clause=clauses[index]!,first=clause[0].trim();
      if(!/已经结束|结束了|通过了|没通过|没有通过|未通过|失败了|成功了|正在参加|正在进行|开始了/.test(first)||/明天|后天|将|如果|假如|还没|尚未|还未|暂未|不知道|未知|是否|没有结束|没开始/.test(first))continue;
      const actorPrefix=first.slice(0,Math.max(0,first.search(/面试|考试|答辩|演出|比赛/)));
      if(/面试官|(?:朋友|同事|同学|家人|他|她|他们|她们|别人)(?:的|在|正在)/.test(first)||knownPeople.some(name=>name&&actorPrefix.includes(name+'的')))continue;
      const possessor=/([\p{Script=Han}A-Za-z]{1,20})的/u.exec(actorPrefix)?.[1];
      if(possessor&&!/^(?:我|我们|今天|昨天|前天|刚才|这次|这场|本次)$/.test(possessor)&&!/公司$|学校$|大学$|月$|日$|^星期/.test(possessor))continue;
      const kinds=['面试','考试','答辩','演出','比赛'].filter(kind=>first.includes(kind));if(!kinds.length||!grounded(first))continue;
      let quote=first;
      // Adjacent explicit outcomes belong to this report; future plans/questions do not.
      for(let next=index+1;next<clauses.length;next++){
        const outcome=clauses[next]![0].trim();
        if(!/^(?:但|但是|不过)?(?:结果[是：:]?|我|已经|最终)?\s*(?:通过了|没通过|没有通过|未通过|成功了|失败了|还没出来|还没有出来|未知)$/.test(outcome)||!grounded(outcome))break;
        quote=sentence[0].slice(clause.index,clauses[next]!.index!+clauses[next]![0].length).trim();
      }
      const companies=quote.match(/[A-Za-z0-9_-]+公司|[\p{Script=Han}]{2,6}公司/gu)??[];
      const stages=['模拟','资格审查','资格审核','报名','培训','笔试','初试','复试','终面'].filter(stage=>quote.includes(stage));
      const occurrence=reportedAt?reportedOccurrence(quote,reportedAt,timezone):null;
      return {candidates:events.filter(event=>{
        if(event.status==='cancelled'||!kinds.some(kind=>event.quote.includes(kind))||!companies.every(company=>event.quote.includes(company))||!stages.every(stage=>event.quote.includes(stage)))return false;
        const dates=[event.date,...(event.reportedTimeline??[]).map(report=>report.occurrence?.date)].filter(Boolean);
        return !occurrence?.date||!dates.length||dates.includes(occurrence.date);
      }).map(event=>event.id),status:/结束|通过|失败|成功/.test(quote)?'ended':'ongoing',quote};
    }
  }
  return null;
}
export function eventProgressClaim(progress: NonNullable<MemoryJob['eventProgress']>): FactClaim {
  return { subject: '用户', predicate: `事件进展 ${progress.eventId}`, value: progress.quote, quote: progress.quote, start: 0 };
}

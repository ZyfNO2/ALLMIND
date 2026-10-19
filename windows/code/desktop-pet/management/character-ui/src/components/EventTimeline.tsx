import type { CompanionData } from '../../../../contracts/book-companion'
import type { BookSnapshot } from '../../../../contracts/memory-book'
import {reportedResultStatus} from '../../../../core/event-result'
export default function EventTimeline({events,book}:{events:CompanionData['events'];book:BookSnapshot|null}){
  return <details><summary>事件时间线与报告来源</summary>{events.map(event=><article key={event.id}>
    <b>{event.quote}</b><p>原表达：{event.timeExpression||'时间未知'} · {event.timezone} · 状态 {event.status}</p>
    {event.status==='ended'&&<p>结果：{(event.resultStatus??reportedResultStatus(book?.entries.find(entry=>entry.id===event.progressEntryId)?.fact?.quote??''))==='user_reported'?'用户已明确报告（见原文）':'未知，结束不等于通过或失败'}</p>}
    <small>{event.reportedOnly?'没有先前安排，不从报告补造计划时间。':<>计划开始：{event.at===null?'精确时间未知':new Date(event.at).toISOString()}；计划结束：{event.plannedEndAt===undefined?'未知':new Date(event.plannedEndAt).toISOString()}。UTC 展示；计划时间不证明事件实际发生或结束。</>}</small>
    <ol>{(event.reportedTimeline??[]).flatMap(row=>{
      const entry=book?.entries.find(entry=>entry.id===row.entryId),source=book?.wikiSources?.find(source=>source.id===entry?.fact?.sourceId);
      if(!entry?.fact||!source?.enabled||source.forgottenKeys.includes(entry.fact.key)||!source.snapshots.some(snapshot=>snapshot.hash===entry.fact!.sourceHash))return [];
      return [<li key={row.entryId}>报告于 {new Date(row.reportedAt).toISOString()} · {row.status==='ongoing'?'用户报告进行中':'用户报告已结束'}<blockquote>{entry.fact.quote}</blockquote>{row.occurrence&&<p>用户报告的发生时间：{row.occurrence.at!==null?new Date(row.occurrence.at).toISOString():row.occurrence.date??'未提供'} · {row.occurrence.timezone} · 精度 {row.occurrence.precision}；原表达 {row.occurrence.timeExpression||'未提供'}。来自用户报告，尚未独立核实。</p>}<small>{entry.id} · 来源 {source.id}；历史报告不替代当前状态，也不推断实际起止时刻。</small></li>]
    })}</ol>
    {event.cancelledBy&&<p>取消原文：{event.cancelledBy.quote} · 轮次 {event.cancelledBy.turnId}</p>}
  </article>)}</details>
}

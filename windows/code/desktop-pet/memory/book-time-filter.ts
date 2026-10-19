import {BookError,type BookSnapshot,type BookEntry} from '../contracts/memory-book.js';

export interface EntryTimeFilter {basis:'all'|'recorded'|'occurred'|'planned';from:string;to:string;timezone:string}
function validDay(value:string){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
export function filterEntryTime(book:BookSnapshot,entries:BookEntry[],filter:EntryTimeFilter):BookEntry[]{
  if(!['all','recorded','occurred','planned'].includes(filter.basis)||[filter.from,filter.to].some(value=>typeof value!=='string'||value!==''&&!validDay(value))||filter.from&&filter.to&&filter.from>filter.to)throw new BookError('invalid_input','时间筛选日期无效或区间倒置。');
  let format:Intl.DateTimeFormat;try{format=new Intl.DateTimeFormat('sv-SE',{timeZone:filter.timezone,year:'numeric',month:'2-digit',day:'2-digit'});}catch{throw new BookError('invalid_input','时间筛选时区无效。');}
  if(filter.basis==='all')return entries;
  const events=book.companionData?.flatMap(data=>data.events)??[];
  return entries.filter(entry=>{
    const days:string[]=[];
    if(filter.basis==='recorded'&&entry.fact){const snapshot=book.wikiSources?.find(source=>source.id===entry.fact!.sourceId)?.snapshots.find(row=>row.hash===entry.fact!.sourceHash);if(snapshot)days.push(format.format(new Date(snapshot.capturedAt)));}
    if(filter.basis==='occurred')for(const event of events)for(const report of event.reportedTimeline??[])if(report.entryId===entry.id&&report.occurrence?.date)days.push(report.occurrence.date);
    if(filter.basis==='planned')for(const event of events)if(event.entryId===entry.id&&!event.reportedOnly&&event.date)days.push(event.date);
    return days.some(day=>(!filter.from||day>=filter.from)&&(!filter.to||day<=filter.to));
  });
}

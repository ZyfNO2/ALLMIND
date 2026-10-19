import {BookError,type BookScope} from '../contracts/memory-book.js';
import type {CompanionRepository,CompanionData} from '../contracts/book-companion.js';
import {validateReminder,validReminderDate,type CompanionReminder,type ReminderInput} from '../contracts/book-reminders.js';
import {zonedParts,zonedTime} from './book-time.js';

function invalidateDeliveries(data:CompanionData,id:string):void{
  for(const delivery of data.deliveries)if(delivery.reminderRef?.id===id){
    delivery.text=null;delivery.reason='提醒设置已变更或删除';delivery.error=null;
    if(['reserved','dispatched'].includes(delivery.status))delivery.status='cancelled';
  }
}
export function saveReminder(repository:CompanionRepository,scope:BookScope,input:ReminderInput,expectedRevision:number,now=Date.now()):CompanionData{
  if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['id','title','enabled','timezone','schedule'].includes(key))||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Number.isSafeInteger(now)||now<0)throw new BookError('invalid_input','提醒输入或修订无效。');
  const data=repository.loadCompanionData(scope),previous=data.reminders?.find(row=>row.id===input.id);
  if(data.retiredReminderIds?.includes(input.id))throw new BookError('conflict','已删除的提醒ID不能复用，请新建提醒。');
  if(!previous&&expectedRevision!==0)throw new BookError('conflict','提醒不存在，请刷新列表。');
  if(!previous&&(data.reminders?.length??0)>=64)throw new BookError('budget','当前实例最多保存64项提醒。');
  if(input.schedule?.kind==='interval'&&Object.hasOwn(input.schedule,'anchorAt'))throw new BookError('invalid_input','间隔起点由服务器记录，不能手动回填。');
  const proposed:CompanionReminder={...input,revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??now,updatedAt:now,schedule:input.schedule?.kind==='interval'?{...input.schedule,anchorAt:now}:input.schedule};
  try{validateReminder(proposed)}catch(cause){throw new BookError('invalid_input','提醒字段无效：名称1～80字、有效时区、15～1440分钟或明确日期/时刻。',{cause})}
  const comparable=(row:CompanionReminder)=>JSON.stringify([row.title,row.enabled,row.timezone,row.schedule.kind==='interval'?[row.schedule.kind,row.schedule.minutes]:row.schedule.kind==='daily'?[row.schedule.kind,row.schedule.time]:[row.schedule.kind,row.schedule.date,row.schedule.time,row.schedule.leapDay]]);
  if(previous&&comparable(previous)===comparable(proposed))return data;
  if(previous&&previous.revision!==expectedRevision)throw new BookError('conflict','提醒已被修改；草稿保留，请刷新后核对。');
  data.reminders=[...(data.reminders??[]).filter(row=>row.id!==input.id),proposed];invalidateDeliveries(data,input.id);
  return repository.saveCompanionData(scope,data);
}
export function deleteReminder(repository:CompanionRepository,scope:BookScope,id:string,expectedRevision:number):CompanionData{
  if(typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw new BookError('invalid_input','提醒ID或修订无效。');
  const data=repository.loadCompanionData(scope),previous=data.reminders?.find(row=>row.id===id);
  if(!previous){if(data.retiredReminderIds?.includes(id))return data;throw new BookError('not_found','提醒不存在。');}
  if(previous.revision!==expectedRevision)throw new BookError('conflict','提醒已变更，未删除，请刷新后核对。');
  if((data.retiredReminderIds?.length??0)>=4096)throw new BookError('budget','提醒删除记录已达4096条上限，未执行不完整删除。');
  data.reminders=data.reminders!.filter(row=>row.id!==id);data.retiredReminderIds=[...(data.retiredReminderIds??[]),id];invalidateDeliveries(data,id);
  return repository.saveCompanionData(scope,data);
}
export interface ReminderOccurrence {reminder:CompanionReminder;at:number;key:string;until:number}
/** Only the current two-minute occurrence window; never replay a missed date or interval. */
export function reminderOccurrence(reminder:CompanionReminder,now:number,notBefore:number):ReminderOccurrence|null{
  if(!reminder.enabled)return null;
  const plan=reminder.schedule;let at:number;
  if(plan.kind==='interval'){
    const duration=plan.minutes*60000,slot=Math.floor((now-plan.anchorAt)/duration);if(slot<1)return null;at=plan.anchorAt+slot*duration;
  }else{
    let date=zonedParts(now,reminder.timezone).date;
    if(plan.kind==='anniversary'){
      if(date<plan.date)return null;
      let target=date.slice(0,4)+plan.date.slice(4);
      if(!validReminderDate(target)){if(plan.leapDay!=='feb28')return null;target=date.slice(0,4)+'-02-28';}
      if(date!==target)return null;
    }
    const [hour,minute]=plan.time.split(':').map(Number);
    // Explicit recurrence policy: a local time skipped by DST has no occurrence that day.
    try{at=zonedTime(date,hour!,minute!,reminder.timezone)}catch(error){if(error instanceof BookError&&error.code==='invalid_input')return null;throw error}
  }
  if(at<Math.max(notBefore,reminder.createdAt,reminder.updatedAt)||now<at||now>=at+120000)return null;
  return {reminder,at,key:`reminder:${reminder.id}:${reminder.revision}:${at}`,until:at+120000};
}
export function validReminderDelivery(data:CompanionData,ref:{id:string;revision:number}|undefined,now:number,key:string):boolean{
  if(!ref)return true;const reminder=data.reminders?.find(row=>row.id===ref.id&&row.revision===ref.revision);
  return !!reminder&&reminderOccurrence(reminder,now,0)?.key===key;
}

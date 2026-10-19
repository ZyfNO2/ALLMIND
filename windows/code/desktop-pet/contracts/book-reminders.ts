export type ReminderSchedule = {kind:'interval';minutes:number;anchorAt:number}
  | {kind:'daily';time:string}
  | {kind:'anniversary';date:string;time:string;leapDay:'skip'|'feb28'};
export interface CompanionReminder {
  id:string;revision:number;title:string;timezone:string;enabled:boolean;
  createdAt:number;updatedAt:number;schedule:ReminderSchedule;
}
export type ReminderInput = Pick<CompanionReminder,'id'|'title'|'timezone'|'enabled'> & {
  schedule:Exclude<ReminderSchedule,{kind:'interval'}>|{kind:'interval';minutes:number};
};
export function validReminderDate(date:unknown):date is string{
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<'0001-01-01')return false;
  const at=Date.parse(date+'T12:00:00Z');return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===date;
}
/** Shared disk/API validation; malformed persisted plans fail, never silently disappear. */
export function validateReminder(value:CompanionReminder):void{
  if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['id','revision','title','timezone','enabled','createdAt','updatedAt','schedule'].includes(key))
    ||typeof value.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.id)||!Number.isSafeInteger(value.revision)||value.revision<1
    ||typeof value.title!=='string'||!value.title.trim()||value.title.length>80||/[\r\n\0]/.test(value.title)||typeof value.enabled!=='boolean'
    ||typeof value.timezone!=='string'||value.timezone.length>100||![value.createdAt,value.updatedAt].every(at=>Number.isSafeInteger(at)&&at>=0)||value.updatedAt<value.createdAt)throw Error('Invalid companion reminder');
  new Intl.DateTimeFormat('en',{timeZone:value.timezone});
  const plan=value.schedule;
  if(!plan||typeof plan!=='object')throw Error('Invalid reminder schedule');
  if(plan.kind==='interval'){
    if(Object.keys(plan).some(key=>!['kind','minutes','anchorAt'].includes(key))||!Number.isSafeInteger(plan.minutes)||plan.minutes<15||plan.minutes>1440||!Number.isSafeInteger(plan.anchorAt)||plan.anchorAt<0)throw Error('Invalid reminder interval');
  }else{
    if(!['daily','anniversary'].includes(plan.kind)||typeof plan.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(plan.time))throw Error('Invalid reminder local time');
    if(plan.kind==='daily'&&Object.keys(plan).some(key=>!['kind','time'].includes(key)))throw Error('Invalid daily reminder');
    if(plan.kind==='anniversary'&&(Object.keys(plan).some(key=>!['kind','date','time','leapDay'].includes(key))||!validReminderDate(plan.date)||!['skip','feb28'].includes(plan.leapDay)))throw Error('Invalid anniversary');
  }
}

import {BookError} from '../contracts/memory-book.js';
export function zonedParts(at:number,timezone:string):{date:string;hour:number;minute:number}{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at));
  const get=(type:string)=>parts.find(p=>p.type===type)!.value;
  return {date:`${get('year')}-${get('month')}-${get('day')}`,hour:Number(get('hour')),minute:Number(get('minute'))};
}
export function addDays(date:string,days:number):string{return new Date(Date.parse(`${date}T12:00:00Z`)+days*86400000).toISOString().slice(0,10)}
export function zonedTime(date:string,hour:number,minute:number,timezone:string):number{
  const target=Date.parse(`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`);let result=target;
  for(let i=0;i<3;i++){const p=zonedParts(result,timezone);result+=target-Date.parse(`${p.date}T${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}:00Z`)}
  const checked=zonedParts(result,timezone);
  if(checked.date!==date||checked.hour!==hour||checked.minute!==minute)throw new BookError('invalid_input','当地时间不存在或时区变更，请明确时间。');return result;
}

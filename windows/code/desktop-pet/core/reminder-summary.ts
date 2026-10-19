import type {CompanionReminder} from '../contracts/book-reminders.js';
import {validReminderDate} from '../contracts/book-reminders.js';
/** Calendar-day distance in the reminder's own zone; never an elapsed-hours/DST guess. */
export function anniversarySummary(reminder:CompanionReminder,now=Date.now()):string{
  const plan=reminder.schedule;if(plan.kind!=='anniversary')return '';
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:reminder.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const get=(type:string)=>parts.find(part=>part.type===type)!.value;
  const today=`${get('year')}-${get('month')}-${get('day')}`,year=Math.max(Number(get('year')),Number(plan.date.slice(0,4)));
  for(let offset=0;offset<=8;offset++){
    let date=(year+offset)+plan.date.slice(4);
    if(!validReminderDate(date)){if(plan.leapDay==='skip')continue;date=(year+offset)+'-02-28';}
    if(date<today||date<plan.date)continue;
    const days=Math.round((Date.parse(date+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000);
    return `${date} · ${days===0?'就是今天':`还有 ${days} 天（当地日历）`}`;
  }
  throw Error('无法确定下一次纪念日，请检查日期与闰日规则。');
}

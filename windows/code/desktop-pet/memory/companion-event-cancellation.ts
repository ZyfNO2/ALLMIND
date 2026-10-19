import type { CompanionEvent } from '../contracts/book-companion.js';
import { parseCompanionEvent } from '../core/book-proactive.js';
import { groundedAutomaticClaim } from './automatic-fact-evidence.js';

export function cancellationCandidates(text: string, timestamp: string, timezone: string, events: CompanionEvent[]): string[] | null {
  const action = /[^，,。！？!?；;\n]*(?:取消|不参加|不去了)[^，,。！？!?；;\n]*/.exec(text);
  if (!action || /不要取消|不取消|没(?:有)?取消|未取消|不想取消/.test(action[0])) return null;
  const quote = action[0].trim();
  if (!quote || !groundedAutomaticClaim(text,{ subject:'用户',predicate:'取消事件',value:quote,quote,start:action.index })) return null;
  const kinds = ['面试','考试','答辩','演出','比赛'].filter(kind=>quote.includes(kind));
  if (!kinds.length) return null;
  const time = parseCompanionEvent(quote,timestamp,timezone,'cancel-request',0);
  const companies = quote.match(/[A-Za-z0-9_-]+公司|[\p{Script=Han}]{2,6}公司/gu) ?? [];
  return events.filter(event=>['scheduled','ongoing'].includes(event.status) && kinds.some(kind=>event.quote.includes(kind))
    && (!time?.date || event.date===time.date) && (time?.at===null || time?.at===undefined || event.at===time.at)
    && (!companies.length || companies.every(company=>event.quote.includes(company)))).map(event=>event.id);
}

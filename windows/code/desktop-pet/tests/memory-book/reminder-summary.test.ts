import test from 'node:test';
import assert from 'node:assert/strict';
import {anniversarySummary} from '../../core/reminder-summary.js';
import type {CompanionReminder} from '../../contracts/book-reminders.js';
const leap:CompanionReminder={id:'leap',revision:1,title:'纪念日',timezone:'Asia/Singapore',enabled:true,createdAt:1,updatedAt:1,schedule:{kind:'anniversary',date:'2024-02-29',time:'09:00',leapDay:'skip'}};
test('anniversary countdown uses local calendar days and explicit leap-day policy',()=>{
 const now=Date.parse('2025-02-27T16:30:00Z');
 assert.equal(anniversarySummary(leap,now),'2028-02-29 · 还有 1096 天（当地日历）');
 assert.equal(anniversarySummary({...leap,schedule:{...leap.schedule,kind:'anniversary',date:'2024-02-29',time:'09:00',leapDay:'feb28'}},now),'2025-02-28 · 就是今天');
 const dst:CompanionReminder={...leap,timezone:'America/New_York',schedule:{kind:'anniversary',date:'2020-03-09',time:'09:00',leapDay:'skip'}};
 assert.equal(anniversarySummary(dst,Date.parse('2026-03-08T04:30:00Z')),'2026-03-09 · 还有 2 天（当地日历）');
 assert.equal(anniversarySummary(dst,Date.parse('2026-03-08T16:00:00Z')),'2026-03-09 · 还有 1 天（当地日历）');
 assert.throws(()=>anniversarySummary({...dst,timezone:'Invalid/Zone'},now));
});

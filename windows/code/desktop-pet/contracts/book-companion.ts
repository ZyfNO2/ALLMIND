import type { BookScope } from './memory-book.js';
import type { FactClaim } from '../memory/fact-wiki.js';
import {validateWikiCompileJobs,type WikiCompileJob} from './wiki-maintenance.js';
import {validateReminder,type CompanionReminder} from './book-reminders.js';
import {validateInteractionSettings,type InteractionSettings} from './companion-interactions.js';

/** Additive private Book data. Old snapshots default to empty; never author-exported. */
export interface CompanionSettings {
  autoMemory: boolean; extraction: 'declarations' | 'model'; cloudMemoryConsent: boolean;
  proactive: boolean; timezone: string; quietStart: number; quietEnd: number;
  /** Explicit hour for date-only events; null means ask for a time, never infer an end. */
  followUpHour: number | null;
}
export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  autoMemory: false, extraction: 'declarations', cloudMemoryConsent: false,
  proactive: false, timezone: 'Asia/Singapore', quietStart: 22, quietEnd: 8, followUpHour: null,
};
export interface MemoryJob {
  id: string; scope: BookScope; turnId: string; strategy: 'declarations' | 'model'; configRevision: number;
  status: 'pending' | 'running' | 'review' | 'done' | 'failed' | 'cancelled'; attempts: number;
  claims: (FactClaim & { correction?: boolean })[]; error: string | null;
  /** Ambiguous user cancellation: one event must be explicitly selected, never cancel all. */
  eventCandidates?: string[];
  eventProgress?: { eventId: string; status: 'ongoing' | 'ended'; quote: string; create?: boolean };
}
export interface ReportedOccurrence { date:string|null; at:number|null; precision:'day'|'minute'|'unknown'; timeExpression:string; timezone:string }
export interface CompanionEvent {
  id: string; entryId: string; revision: number; quote: string; timeExpression: string;
  timezone: string; date: string | null; at: number | null; precision: 'day' | 'minute' | 'unknown';
  status: 'scheduled' | 'ongoing' | 'ended' | 'cancelled';
  resultStatus?:'unknown'|'user_reported';
  progressEntryId?: string;
  progressReportedAt?: number;
  /** Explicit planned end, never proof of actual completion. */
  plannedEndAt?: number;
  reportedOnly?:boolean;
  reportedTimeline?: { entryId: string; status: 'ongoing' | 'ended'; reportedAt: number; occurrence?:ReportedOccurrence }[];
  cancelledBy?:{turnId:string;sessionId:string;quote:string};
}
export interface CompanionDelivery {
  id: string; dedupKey: string; basisRefs: { id: string; revision: number }[];
  reason: string; day: string; timezone: string; reservedAt: number; expiresAt: number;
  status: 'reserved' | 'dispatched' | 'committed' | 'failed' | 'unknown' | 'cancelled';
  text: string | null; error: string | null; acknowledgedAt: number | null; respondedAt: number | null;
  dispatchedAt?:number;
  /** Old ledgers may lack this; new offers are invalidated by any settings revision. */
  configRevision?:number;
  reminderRef?:{id:string;revision:number};
}
export interface CompanionData {
  pairingId: string; revision: number; jobs: MemoryJob[]; events: CompanionEvent[];
  deliveries: CompanionDelivery[]; forgottenKeys: string[]; erasedTurns: string[];
  takeover: 'waiting' | 'ready'; inheritedGreetingAt: number | null;
  inheritedGreetingEnabled?:boolean;
  relearningGrants?: { entryId: string; sourceId: string; sourceHash: string; valueHash: string }[];
  focus?: boolean;
  focusTimer?: {id:string;startedAt:number;until:number;completedAt?:number;pausedRemainingMs?:number};
  memoryPaused?: boolean;
  favorites?: string[];
  lastInteractionAt?: number;
  wikiJobs?: WikiCompileJob[];
  reminders?:CompanionReminder[];
  retiredReminderIds?:string[];
  interactionSettings?:InteractionSettings;
}
export const emptyCompanionData = (pairingId: string): CompanionData => ({ pairingId, revision: 0,
  jobs: [], events: [], deliveries: [], forgottenKeys: [], erasedTurns: [], takeover: 'waiting', inheritedGreetingAt: null });
export interface CompanionRepository {
  hasBookOperation(scope: BookScope, operationId:string):boolean;
  loadCompanionData(scope: BookScope): CompanionData;
  saveCompanionData(scope: BookScope, data: CompanionData): CompanionData;
}
export function validateCompanionSettings(value: CompanionSettings): void {
  if (!value || ['autoMemory', 'cloudMemoryConsent', 'proactive'].some(key => typeof value[key as keyof CompanionSettings] !== 'boolean')
    || !['declarations', 'model'].includes(value.extraction) || typeof value.timezone !== 'string' || value.timezone.length>100 || value.quietStart===null || value.quietEnd===null) throw Error('Invalid companion settings');
  new Intl.DateTimeFormat('en', { timeZone: value.timezone });
  for (const hour of [value.quietStart, value.quietEnd, value.followUpHour]) if (hour !== null && (!Number.isInteger(hour) || hour < 0 || hour > 23)) throw Error('Invalid companion hour');
}
export function validateCompanionData(data: CompanionData): void {
  if(data?.interactionSettings!==undefined)validateInteractionSettings(data.interactionSettings);
  if(data?.reminders!==undefined){
    if(!Array.isArray(data.reminders)||data.reminders.length>64||new Set(data.reminders.map(row=>row?.id)).size!==data.reminders.length)throw Error('Invalid reminder list');
    data.reminders.forEach(validateReminder);
  }
  if(data?.retiredReminderIds!==undefined&&(!Array.isArray(data.retiredReminderIds)||data.retiredReminderIds.length>4096||new Set(data.retiredReminderIds).size!==data.retiredReminderIds.length||data.retiredReminderIds.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)||data.reminders?.some(row=>row.id===id))))throw Error('Invalid retired reminder identities');
  if(data?.deliveries?.some(row=>row.reminderRef&&(!row.reminderRef.id||!Number.isSafeInteger(row.reminderRef.revision)||row.reminderRef.revision<1)))throw Error('Invalid reminder delivery reference');
  if(data?.jobs?.some(job=>job.eventProgress?.create!==undefined&&(typeof job.eventProgress.create!=='boolean'||job.eventProgress.create&&!job.eventProgress.eventId.startsWith('event.report.'))))throw Error('Invalid newly reported event');
  for(const event of data?.events??[]){
    if(event.resultStatus!==undefined&&!['unknown','user_reported'].includes(event.resultStatus))throw Error('Invalid event result status');
    if(event.reportedOnly!==undefined&&typeof event.reportedOnly!=='boolean'||event.reportedOnly&&(event.date!==null||event.at!==null||event.plannedEndAt!==undefined))throw Error('Reported event cannot invent a plan');
    for(const row of event.reportedTimeline??[])if(row.occurrence){const occurrence=row.occurrence;
      if(!['day','minute','unknown'].includes(occurrence.precision)||typeof occurrence.timeExpression!=='string'||occurrence.timeExpression.length>200||typeof occurrence.timezone!=='string'||occurrence.timezone.length>100||occurrence.date!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(occurrence.date)||occurrence.at!==null&&!Number.isSafeInteger(occurrence.at)||occurrence.precision==='minute'&&(occurrence.at===null||occurrence.date===null)||occurrence.precision!=='minute'&&occurrence.at!==null||occurrence.precision==='day'&&occurrence.date===null)throw Error('Invalid reported occurrence');
      new Intl.DateTimeFormat('en',{timeZone:occurrence.timezone});
    }
  }
  if(data?.wikiJobs!==undefined)validateWikiCompileJobs(data.wikiJobs,data.pairingId);
  if(data?.events?.some(event=>event.plannedEndAt!==undefined&&(!Number.isFinite(event.plannedEndAt)||event.at===null||event.plannedEndAt<=event.at)||event.reportedTimeline!==undefined&&(!Array.isArray(event.reportedTimeline)||event.reportedTimeline.length>32||event.reportedTimeline.some(row=>typeof row.entryId!=='string'||!['ongoing','ended'].includes(row.status)||!Number.isFinite(row.reportedAt)))))throw Error('Invalid companion event interval or timeline');
  if(data?.focus!==undefined&&typeof data.focus!=='boolean')throw Error('Invalid companion focus mode');
  if(data?.focusTimer){const timer=data.focusTimer;if(typeof timer.id!=='string'||timer.id.length>128||![timer.startedAt,timer.until].every(value=>Number.isSafeInteger(value)&&value>=0)||timer.until<=timer.startedAt||timer.until-timer.startedAt>45*60000||timer.completedAt!==undefined&&(!Number.isSafeInteger(timer.completedAt)||timer.completedAt<timer.until))throw Error('Invalid focus timer');}
  if(data?.focusTimer?.pausedRemainingMs!==undefined&&(!Number.isSafeInteger(data.focusTimer.pausedRemainingMs)||data.focusTimer.pausedRemainingMs<=0||data.focusTimer.pausedRemainingMs>45*60000||data.focus||data.focusTimer.completedAt!==undefined))throw Error('Invalid paused focus timer');
  if(data?.memoryPaused!==undefined&&typeof data.memoryPaused!=='boolean')throw Error('Invalid memory queue pause');
  if(data?.favorites!==undefined&&(!Array.isArray(data.favorites)||data.favorites.length>8192||new Set(data.favorites).size!==data.favorites.length||data.favorites.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))))throw Error('Invalid private favorites');
  if(data?.lastInteractionAt!==undefined&&(!Number.isSafeInteger(data.lastInteractionAt)||data.lastInteractionAt<0))throw Error('Invalid companion interaction timestamp');
  if(data?.events?.some(event=>!['scheduled','ongoing','ended','cancelled'].includes(event.status)||event.progressEntryId!==undefined&&typeof event.progressEntryId!=='string'||event.progressReportedAt!==undefined&&!Number.isFinite(event.progressReportedAt)))throw Error('Invalid companion event progress');
  if (!data || typeof data.pairingId !== 'string' || !Number.isSafeInteger(data.revision) || data.revision < 0
    || !['waiting', 'ready'].includes(data.takeover)) throw Error('Invalid companion ledger');
  for (const rows of [data.jobs, data.events, data.deliveries, data.forgottenKeys, data.erasedTurns]) if (!Array.isArray(rows) || rows.length > 4096) throw Error('Invalid companion ledger rows');
  if(data.relearningGrants!==undefined&&(!Array.isArray(data.relearningGrants)||data.relearningGrants.length>4096||data.relearningGrants.some(grant=>!grant||typeof grant.entryId!=='string'||typeof grant.sourceId!=='string'||![grant.sourceHash,grant.valueHash].every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)))))throw Error('Invalid explicit re-learning grants');
  if (data.jobs.some(j => !j.scope || j.scope.pairingId !== data.pairingId || !['pending','running','review','done','failed','cancelled'].includes(j.status) || !Array.isArray(j.claims) || j.eventCandidates !== undefined && (!Array.isArray(j.eventCandidates) || j.eventCandidates.length > 64 || j.eventCandidates.some(id=>typeof id!=='string')))
    || data.deliveries.some(d => !['reserved','dispatched','committed','failed','unknown','cancelled'].includes(d.status) || !Number.isFinite(d.reservedAt) || !Number.isFinite(d.expiresAt))) throw Error('Invalid companion ledger record');
}

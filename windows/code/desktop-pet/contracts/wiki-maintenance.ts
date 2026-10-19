import type { BookScope, PersonalWikiPage } from './memory-book.js';

/** Private compilation outbox in the existing Book ledger. No raw source copies. */
export interface WikiCompileTarget {
  pageId:string; inputHash:string; pageRevision:number;
  basisRefs:PersonalWikiPage['basisRefs']; sources:PersonalWikiPage['sources'];
}
export interface WikiCompileParagraph { text:string; entryIds:string[] }
export interface WikiCompileResult { pageId:string; paragraphs:WikiCompileParagraph[] }
export interface WikiCompileJob {
  id:string; scope:BookScope; configRevision:number;
  status:'pending'|'running'|'review'|'applied'|'failed'|'cancelled';
  attempts:number; createdAt:string; updatedAt:string; error:string|null;
  targets:WikiCompileTarget[]; results:WikiCompileResult[];
  operations:{id:string;fingerprint:string}[];
}
export const WIKI_JOB_LIMIT=64, WIKI_BATCH_LIMIT=4;
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const revision=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=1;
export function validateWikiCompileJobs(jobs:WikiCompileJob[],pairingId:string):void {
  if(!Array.isArray(jobs)||jobs.length>WIKI_JOB_LIMIT)throw Error('Invalid Wiki maintenance ledger');
  const ids=new Set<string>(),operations=new Set<string>();
  for(const job of jobs){
    if(!id(job?.id)||ids.has(job.id)||!job.scope||!id(job.scope.characterId)||job.scope.pairingId!==pairingId||!id(job.scope.sessionId)||!Number.isSafeInteger(job.configRevision)||job.configRevision<0||!['pending','running','review','applied','failed','cancelled'].includes(job.status)||!Number.isSafeInteger(job.attempts)||job.attempts<0||job.attempts>3||![job.createdAt,job.updatedAt].every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)))||job.error!==null&&(typeof job.error!=='string'||job.error.length>2000))throw Error('Invalid Wiki maintenance job');
    ids.add(job.id);
    if(!Array.isArray(job.targets)||!job.targets.length||job.targets.length>WIKI_BATCH_LIMIT||new Set(job.targets.map(row=>row.pageId)).size!==job.targets.length||!Array.isArray(job.results)||job.results.length>WIKI_BATCH_LIMIT||new Set(job.results.map(row=>row.pageId)).size!==job.results.length||!Array.isArray(job.operations)||job.operations.length>32)throw Error('Invalid Wiki maintenance batch');
    if(['pending','running','failed','cancelled'].includes(job.status)&&job.results.length||job.status==='review'&&job.results.length!==job.targets.length||job.status==='applied'&&!job.results.length)throw Error('Invalid Wiki maintenance result state');
    for(const target of job.targets){
      if(!id(target.pageId)||!digest(target.inputHash)||!revision(target.pageRevision)||!Array.isArray(target.basisRefs)||!target.basisRefs.length||target.basisRefs.length>32||!Array.isArray(target.sources)||!target.sources.length||target.sources.length>32)throw Error('Invalid Wiki maintenance target');
      if(new Set(target.basisRefs.map(ref=>ref.entryId)).size!==target.basisRefs.length||new Set(target.sources.map(ref=>ref.id)).size!==target.sources.length)throw Error('Duplicate Wiki maintenance basis');
      for(const ref of target.basisRefs)if(!id(ref.entryId)||!revision(ref.revision))throw Error('Invalid Wiki maintenance basis');
      for(const ref of target.sources)if(!id(ref.id)||!digest(ref.hash)||!revision(ref.revision))throw Error('Invalid Wiki maintenance source');
    }
    for(const result of job.results){
      const target=job.targets.find(row=>row.pageId===result.pageId);
      if(!target||!Array.isArray(result.paragraphs)||!result.paragraphs.length||result.paragraphs.length>12)throw Error('Invalid Wiki maintenance result');
      for(const paragraph of result.paragraphs)if(typeof paragraph.text!=='string'||!paragraph.text.trim()||paragraph.text.length>2000||!Array.isArray(paragraph.entryIds)||!paragraph.entryIds.length||paragraph.entryIds.length>32||new Set(paragraph.entryIds).size!==paragraph.entryIds.length||paragraph.entryIds.some(entryId=>!target.basisRefs.some(ref=>ref.entryId===entryId)))throw Error('Invalid Wiki maintenance paragraph');
      if(target.basisRefs.some(ref=>!result.paragraphs.some(row=>row.entryIds.includes(ref.entryId))))throw Error('Wiki maintenance result omitted its stated basis');
    }
    for(const operation of job.operations){if(!id(operation.id)||operations.has(operation.id)||!digest(operation.fingerprint))throw Error('Invalid Wiki maintenance operation');operations.add(operation.id);}
  }
}

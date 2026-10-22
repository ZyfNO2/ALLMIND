import type {BookEntry} from '../contracts/memory-book.js';

/** Author-imported simulation and its derived pages share the same experience boundary. */
export function isSimulatedEntry(entry:BookEntry):boolean{
  return entry.synthesis?.domain==='simulated'||entry.organization?.domain==='rp'||entry.authorScope==='simulation-only'||entry.tags.includes('simulation')||entry.tags.includes('not-user-history');
}

export function isCorePersona(entry:BookEntry):boolean{return entry.type==='persona'||entry.corePersona===true;}

import type { BookEntry, EntryType } from '../contracts/memory-book.js';
import {isSimulatedEntry} from '../core/entry-domain.js';

/** Browse-only shelves. They do not rewrite entry type, origin, or pairing. */
export type KnowledgeCategory = 'world' | 'persona' | 'knowledge' | 'companion';

export const knowledgeCategoryOrder: KnowledgeCategory[] = ['world', 'persona', 'knowledge', 'companion'];

export const knowledgeCategoryLabels: Record<KnowledgeCategory, string> = {
  world: '世界设定',
  persona: '人设',
  knowledge: '客观知识',
  companion: '陪伴记录',
};

export interface CategoryDecision {
  category: KnowledgeCategory;
  /** Basis entries span more than one shelf. The page stays one record. */
  crossClass: boolean;
  /** Simulated companion prose must stay marked even when the shelf follows its basis. */
  simulated: boolean;
}

export function defaultEntryType(category: KnowledgeCategory): EntryType {
  if (category === 'world') return 'story';
  if (category === 'persona') return 'persona';
  if (category === 'companion') return 'memory';
  return 'wiki';
}

function baseDecision(entry: BookEntry): CategoryDecision {
  const simulated = isSimulatedEntry(entry);
  if(entry.knowledgeCategory)return {category:entry.knowledgeCategory,crossClass:false,simulated};
  if(entry.knowledge&&entry.type==='wiki')return {category:'world',crossClass:false,simulated};
  if (entry.type === 'story' || entry.type === 'lore') return { category: 'world', crossClass: false, simulated };
  if (entry.type === 'persona') return { category: 'persona', crossClass: false, simulated };
  if (entry.type === 'memory' || entry.type === 'state') return { category: 'companion', crossClass: false, simulated };
  const realRecord = entry.organization?.domain === 'real' || entry.synthesis?.domain === 'real' || (entry.origin === 'observed' && Boolean(entry.pairingId));
  return { category: realRecord ? 'companion' : 'knowledge', crossClass: false, simulated };
}

/** Same rule for lists, Wiki, and the graph. Titles are never used as a classifier. */
export function classifyBook(entries: readonly BookEntry[]): Map<string, CategoryDecision> {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const cache = new Map<string, CategoryDecision>();
  const visiting = new Set<string>();
  const visit = (entry: BookEntry): CategoryDecision => {
    const cached = cache.get(entry.id);
    if (cached) return cached;
    if (visiting.has(entry.id)) return baseDecision(entry);
    visiting.add(entry.id);
    let decision = baseDecision(entry);
    const basis = entry.synthesis?.basis ?? [];
    const resolved = basis.map(ref => byId.get(ref.entryId)).filter((row): row is BookEntry => Boolean(row));
    if (entry.synthesis && resolved.length && !entry.knowledgeCategory) {
      const parts = resolved.map(visit);
      const categories = new Set(parts.map(part => part.category));
      const simulated = entry.synthesis.domain === 'simulated' || parts.some(part => part.simulated);
      decision = categories.size === 1
        ? { category: parts[0]!.category, crossClass: false, simulated }
        : { category: 'knowledge', crossClass: true, simulated };
    }
    visiting.delete(entry.id);
    cache.set(entry.id, decision);
    return decision;
  };
  for (const entry of entries) visit(entry);
  return cache;
}

export function classifyEntry(entry: BookEntry, entries: readonly BookEntry[]): CategoryDecision {
  return classifyBook(entries).get(entry.id) ?? baseDecision(entry);
}

/** Model suggestions are browse categories, not permission to inject a core persona. */
export function synthesisPageCategory(page:import('../contracts/wiki-synthesis.js').SynthesisPage,entries:readonly BookEntry[]):KnowledgeCategory{
  if(page.category)return page.category;
  const ids=new Set(page.paragraphs.flatMap(row=>row.evidence.map(ref=>ref.entryId)));
  const categories=new Set(entries.filter(entry=>ids.has(entry.id)).map(entry=>classifyEntry(entry,entries).category));
  return categories.size===1?[...categories][0]!:page.domain==='real'?'companion':'knowledge';
}

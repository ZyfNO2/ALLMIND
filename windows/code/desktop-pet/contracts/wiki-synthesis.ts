import type { BookScope, KnowledgeBoundary, KnowledgeView } from './memory-book.js';

export type WikiDomain = 'canon' | 'author' | 'simulated' | 'real' | 'external';
export interface WikiEvidence { entryId: string; quote: string }
export type SynthesisPageType = 'entity' | 'topic' | 'event';
export interface SynthesisPage {
  pageType?: SynthesisPageType;
  id: string; title: string; domain: WikiDomain;
  category?:import('../memory/knowledge-category.js').KnowledgeCategory;
  paragraphs: { text: string; evidence: WikiEvidence[] }[];
}
export interface SynthesisRelation { from: string; to: string; label: string; evidence: WikiEvidence[] }
export interface SynthesisResult {
  schemaVersion: 'allmind-wiki/v1'; inputHash: string;
  pages: SynthesisPage[]; relations: SynthesisRelation[];
  coverage: { entryId: string; pageIds: string[]; reason: string }[];
}
export interface SynthesisBasis { entryId: string; revision: number; hash: string }
/** Derived prose is not a new original source or a confirmed shared experience. */
export interface SynthesisMetadata {
  version: 'allmind-wiki/v1'; pageId: string; domain: WikiDomain;
  pageType?: SynthesisPageType;
  basis: SynthesisBasis[];
  sources: { id: string; hash: string; revision: number }[];
  relations: { targetId: string; label: string; basisEntryIds: string[] }[];
}
export interface SynthesisMaterial {
  id: string; title: string; type: string; body: string; domain: WikiDomain;
  category?:import('../memory/knowledge-category.js').KnowledgeCategory;
  knowledge: KnowledgeBoundary | null; sourceIds: string[];
}
export interface SynthesisTask {
  protocol: 'allmind-wiki-task/v1'; inputHash: string; scope: BookScope;
  view: KnowledgeView | null; materials: SynthesisMaterial[];
  existingPages: { id: string; title: string; domain: WikiDomain }[];
}
export interface SynthesisJob {
  id: string; scope: BookScope; operationId: string;
  status: 'prepared' | 'running' | 'review' | 'applied' | 'failed' | 'cancelled' | 'stale';
  expectedRevision: number; configRevision: number; inputHash: string; promptHash: string;
  basis: SynthesisBasis[]; view: KnowledgeView | null;
  createdAt: string; updatedAt: string; error: string | null;
  result: SynthesisResult | null;
  attempt: number; model: string | null; effort: string | null;
  budgetMs?: number;
  preparedReceipt?: {thinking?:{level:number;label:string};taskArchiveSha256?:string;requestId:string};
  responseHash?: string; validationError?: string;
  batchProgress?: {total:number;completed:number;inputHashes:string[];responseHashes:string[];requestIds:string[]};
  /** Durable checkpoints; only individually validated batches can participate in the final merge. */
  checkpoints?: {inputHash:string;attempted:boolean;receipt?:NonNullable<SynthesisJob['preparedReceipt']>;result?:SynthesisResult;attempts:{response:string|null;error:string|null;messageHash?:string}[]}[];
  applyOperationId?: string; receipt?: import('./memory-book.js').CommitReceipt;
  applyIntent?: import('./memory-book.js').BookChange;
  review?: SynthesisPageReview[];
}
export interface SynthesisPageReview {pageId:string;category:import('../memory/knowledge-category.js').KnowledgeCategory;corePersona:boolean}

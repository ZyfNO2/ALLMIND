import type { BookScope, KnowledgeView } from './memory-book.js';

export interface ReaderAsset {
  resourceId: string; revision: number; sha256: string | null;
  kind: 'image' | 'document'; label: string;
  state: 'ready' | 'revoked' | 'unavailable' | 'unresolved' | 'external';
  reason?: string;
  nature?: 'material' | 'generated_image';
}
export interface ReaderEdge {
  from: string; to: string;
  kind: 'page_link' | 'source_citation' | 'entry_related';
  basis: { ownerId: string; revision: number; field: string }[];
  /** entry_related 只表示条目里写下的关联，不是现实共同经历。 */
  experience: false;
}
export interface ReaderDocument {
  id: string; revision: number; bookRevision: number;
  title: string; body: string; format: 'markdown' | 'text';
  state: 'current' | 'stale' | 'unavailable';
  basisRefs: { entryId: string; revision: number }[];
  sources: { id: string; title: string; revision: number; hash: string; nature: 'material' | 'user_statement' | 'generated_image'; resourceId?: string; excerpts?: {quote:string;start:number;end:number}[] }[];
  assets: ReaderAsset[];
  links: { label: string; target: string; state: 'page' | 'asset' | 'external' | 'missing' | 'duplicate' }[];
  reason?: string;
  history?: {revision:number}[];
}
export interface ReaderTimelineItem {
  id: string; label: string; activity: 'recorded' | 'input' | 'reference';
  quote: string; domain: string | null;
  time?: string | null;
}
export interface WikiReaderResult {
  scope: BookScope; view: KnowledgeView | null; bookRevision: number;
  pages: { id: string; title: string; state: ReaderDocument['state'] }[];
  nextCursor: string | null;
  materials: {id:string;title:string;state:string}[];
  document: ReaderDocument | null;
  graph: { nodes: { id: string; title: string; kind: 'page' | 'source' | 'entry'; isolated?: string }[]; edges: ReaderEdge[]; omittedNodes: number; omittedEdges: number };
  timeline: ReaderTimelineItem[];
  forNextTurn: { resourceId: string; sha256: string; revision: number; use: 'text' | 'image' }[];
}

import type { BookScope, KnowledgeView } from './memory-book.js';

export type KnowledgeDomain = 'real' | 'rp' | 'external' | 'author';
export type EvidenceStatus = 'observation' | 'user_reported' | 'source_asserted' | 'hypothesis' | 'user_confirmed';
export type MergeAction = 'duplicate' | 'supplement' | 'time_change' | 'supersede' | 'conflict' | 'new' | 'unknown';
export interface OrganizationMaterialRef { resourceId: string; sha256: string; resourceRevision: number }
export interface OrganizationInput {
  operationId: string;
  expectedBookRevision: number;
  materials: OrganizationMaterialRef[];
  domain: KnowledgeDomain;
  view?: KnowledgeView;
}
export interface EvidenceSpan {
  sourceId: string;
  sourceHash: string;
  quote: string;
  start: number;
  end: number;
  extractionVersion: string;
}
export interface OrganizationCandidate {
  id: string;
  domain: KnowledgeDomain;
  evidenceStatus: EvidenceStatus;
  subject: string;
  predicate: string;
  value: string;
  evidence: EvidenceSpan[];
  existingEntryIds: string[];
  action: MergeAction;
  reason: string;
  /** Local rule: this candidate cannot be accepted as a real shared experience. */
  blocked: boolean;
  validFrom?:string;
  validUntil?:string;
}
export interface OrganizationChapter { title: string; candidateIds: string[] }
export interface OrganizationPreview {
  id: string;
  scope: BookScope;
  revision: number;
  operationId: string;
  inputFingerprint: string;
  expectedBookRevision: number;
  domain: KnowledgeDomain;
  view?: KnowledgeView;
  complete: boolean;
  incompleteReason: string | null;
  candidates: OrganizationCandidate[];
  chapters: OrganizationChapter[];
  phase: 'preparing' | 'submission_unknown' | 'failed' | 'review' | 'applied' | 'expired';
  materials?: OrganizationMaterialRef[];
  createdAt?: number;
  configRevision?: number;
  error?: string;
  decisions: OrganizationDecision[] | null;
  appliedEntryIds: string[];
}
export interface OrganizationDecision {
  candidateId: string;
  accept: boolean;
  /** Required when accepting a conflict. */
  resolution?: 'keep_existing' | 'use_candidate';
}

// WV0-00: character Wiki v0 import contract — frozen v0.1 format, deterministic parse results.
// This module is PURE TYPES + LIMITS: no network, no model, no persistence. The parser
// (management/character-wiki-import-parser.ts) owns the actual semantics.

export const WIKI_SCHEMA_VERSION = 'aika-wiki-v0.1' as const;
export const WIKI_FENCE_TAG = 'aika-wiki-v0' as const;

/** Transport limits (WV0-00 §传输). Enforced on the raw submitted text and per-source text. */
export const WIKI_LIMITS = Object.freeze({
  /** Maximum UTF-8 bytes of the submitted document. */
  maxDocumentBytes: 128 * 1024,
  /** Maximum UTF-8 bytes of a single source.text. */
  maxSourceBytes: 64 * 1024,
  maxSources: 16,
  maxWikiFacts: 100,
  maxStoryEvents: 100,
  maxGaps: 32,
  maxTitleCodePoints: 100,
  maxNameCodePoints: 100,
  maxSoulCodePoints: 4000,
  maxStyleHints: 16,
  maxStyleHintCodePoints: 200,
  maxFactTextCodePoints: 1000,
  maxSummaryCodePoints: 1000,
  maxParticipants: 16,
  maxEvidencePerItem: 16,
});

export type WikiSourceKind = 'authored' | 'reference';
export type WikiFactStatus = 'canon' | 'soft_canon' | 'inferred' | 'draft';
export type WikiAwareness = 'experienced' | 'heard' | 'unknown';

export interface WikiSourceInput {
  readonly id: string;
  readonly title: string;
  readonly kind: WikiSourceKind;
  readonly text: string;
  readonly uri?: string | undefined;
}

export interface WikiEvidenceInput {
  readonly sourceId: string;
  readonly quote: string;
  readonly occurrence?: number | undefined;
}

/** A located evidence citation: the quote plus its exact code-point range in the source text. */
export interface WikiEvidenceLocated extends WikiEvidenceInput {
  readonly location: { readonly start: number; readonly end: number };
}

export interface WikiBibleInput {
  readonly name: string;
  readonly soul: string;
  readonly styleHints: readonly string[];
  readonly evidence: readonly WikiEvidenceLocated[];
}

export interface WikiFactInput {
  readonly id: string;
  readonly text: string;
  readonly status: WikiFactStatus;
  readonly evidence: readonly WikiEvidenceLocated[];
}

export interface WikiStoryEventInput {
  readonly id: string;
  readonly ordinal: number;
  readonly title: string;
  readonly summary: string;
  readonly participants: readonly string[];
  readonly awareness: WikiAwareness;
  readonly status: WikiFactStatus;
  readonly evidence: readonly WikiEvidenceLocated[];
  readonly chapter?: string | undefined;
  readonly storyTime?: string | undefined;
}

/** The full normalized document (structured mode only). */
export interface WikiNormalizedDocument {
  readonly schemaVersion: typeof WIKI_SCHEMA_VERSION;
  readonly title: string;
  readonly sources: readonly WikiSourceInput[];
  readonly bible: WikiBibleInput;
  readonly wikiFacts: readonly WikiFactInput[];
  readonly storyEvents: readonly WikiStoryEventInput[];
  readonly gaps: readonly string[];
}

/** One parse diagnostic: a stable reason plus the JSON path when known. */
export interface WikiDiagnostic {
  readonly path?: string | undefined;
  readonly message: string;
}

/** A source as carried in the parse result: the normalized source plus its decoded document text. */
export interface WikiParsedSource {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly kind: WikiSourceKind;
  readonly text: string;
}

export interface WikiParseResult {
  /** 'structured' when a valid-version fenced block or bare JSON object was found; 'source_only' for plain Markdown. */
  readonly mode: 'structured' | 'source_only';
  /** SHA-256 of the actual submitted text (UTF-8). */
  readonly documentHash: string;
  /** Present only in structured mode. */
  readonly normalized: WikiNormalizedDocument | undefined;
  /** The document's own sources (structured mode) or the whole document as one source (source_only). */
  readonly sources: readonly WikiParsedSource[];
  readonly diagnostics: readonly WikiDiagnostic[];
}

export interface WikiParseInput {
  readonly text: string;
  readonly sourceName: string;
  readonly inputKind: 'file' | 'paste';
}

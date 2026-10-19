// CB-00: unified character document (.aiki.md) contract — frozen `aiki.character/v0.1` shape.
//
// This module is PURE TYPES + LIMITS: no network, no model, no persistence. The parser
// (core/character-document-parser.ts) owns the actual semantics. Test-pinned against the frozen
// fixture docs/next/aiki-character-book/fixtures/allmind.aiki.md (12 entries).

export const AIKI_SCHEMA_VERSION = 'aiki.character/v0.1' as const;

/** Transport + structural limits (CB-00 §大小). Enforced on the raw submitted text. */
export const AIKI_LIMITS = Object.freeze({
  /** Maximum UTF-8 bytes of the submitted document. */
  maxDocumentBytes: 128 * 1024,
  /** Maximum Unicode code points of a single entry body. */
  maxEntryBodyCodePoints: 16 * 1024,
  maxEntries: 256,
  maxListItems: 64,
  maxListItemCodePoints: 128,
  maxIdLength: 128,
  maxTitleCodePoints: 200,
});

export type AikiEntryType = 'persona' | 'wiki' | 'story' | 'state';

export type AikiConfidence = 'explicit' | 'inferred' | 'temporary';

export type AikiCanonLevel =
  | 'author_defined'
  | 'user_defined'
  | 'canon'
  | 'soft_canon'
  | 'inferred'
  | 'draft';

export interface AikiCanon {
  readonly level: AikiCanonLevel;
}

export interface AikiSourceRef {
  readonly type: string;
  readonly ref?: string | undefined;
}

export interface AikiAuthoring {
  readonly intro?: string | undefined;
  readonly scenario?: string | undefined;
  readonly firstMessage?: string | undefined;
  readonly exampleDialogue?: string | undefined;
}

export interface AikiFrontmatter {
  readonly schema: typeof AIKI_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly source: Readonly<Record<string, string>> | undefined;
  readonly version: string | undefined;
  readonly defaultScope: string | undefined;
  readonly authoring: AikiAuthoring;
}

export interface AikiStoryTime {
  readonly start?: string | undefined;
  readonly end?: string | undefined;
}

export interface AikiEntryMeta {
  readonly id: string;
  readonly type: AikiEntryType;
  readonly subtype: string | undefined;
  readonly title: string | undefined;
  readonly scope: string | undefined;
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
  readonly tags: readonly string[];
  readonly priority: number;
  readonly always: boolean;
  readonly canon: AikiCanon | undefined;
  readonly confidence: AikiConfidence;
  readonly source: AikiSourceRef | undefined;
  readonly related: readonly string[];
  readonly validFrom: string | undefined;
  readonly validUntil: string | undefined;
  /** Story-only. */
  readonly time: AikiStoryTime | undefined;
  readonly characters: readonly string[];
  readonly locations: readonly string[];
  readonly entities: readonly string[];
  readonly importance: number | undefined;
  /** State-only. */
  readonly updatedAt: string | undefined;
  readonly expiresAt: string | undefined;
  /** State-only machine-readable payload, carried as a JSON string (never interpreted here). */
  readonly data: string | undefined;
}

export interface AikiEntry {
  readonly meta: AikiEntryMeta;
  /** Raw Markdown body, verbatim (code-point sliced). */
  readonly body: string;
  /** 1-based line number of the opening `:::entry` line. */
  readonly line: number;
}

/** A structured character document: frontmatter + entries + preserved prose. */
export interface AikiDocument {
  readonly schemaVersion: typeof AIKI_SCHEMA_VERSION;
  readonly frontmatter: AikiFrontmatter;
  readonly entries: readonly AikiEntry[];
  /** Markdown outside entries (between frontmatter/first entry, between entries, after last close). */
  readonly prose: readonly string[];
}

export type AikiDiagnosticCode =
  | 'missing_frontmatter_delimiter'
  | 'unknown_schema'
  | 'missing_required_field'
  | 'duplicate_entry_id'
  | 'unknown_field'
  | 'duplicate_yaml_key'
  | 'unterminated_entry'
  | 'nested_entry'
  | 'bad_time'
  | 'bad_enum'
  | 'related_not_found'
  | 'over_limit'
  | 'nul_byte'
  | 'bad_yaml'
  | 'empty_document';

export interface AikiDiagnostic {
  readonly code: AikiDiagnosticCode;
  readonly message: string;
  readonly line?: number | undefined;
  readonly entryId?: string | undefined;
  readonly field?: string | undefined;
}

export interface AikiParseResult {
  /** 'aiki-character' when valid frontmatter + entries parsed; 'source_only' for plain Markdown. */
  readonly mode: 'aiki-character' | 'source_only';
  readonly schemaVersion: typeof AIKI_SCHEMA_VERSION | undefined;
  /** SHA-256 of the actual submitted text (UTF-8). */
  readonly documentHash: string;
  /** Present only in aiki-character mode with zero fatal diagnostics. */
  readonly document: AikiDocument | undefined;
  /** Diagnostics; fatal ones leave `document` undefined (except related_not_found: entry-level block). */
  readonly diagnostics: readonly AikiDiagnostic[];
  /** Entry ids blocked from apply by entry-level diagnostics (dangling related/source refs). */
  readonly blockedEntryIds: readonly string[];
  /** Raw text from `# Import Test Notes` (exact level-1 heading) to end of file; never knowledge. */
  readonly trailingNotes: string | undefined;
}

export interface AikiParseInput {
  readonly text: string;
  readonly sourceName: string;
  readonly inputKind: 'file' | 'paste';
}

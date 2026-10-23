/** MB-MVP public data/ports. Adapters own persistence; recall owns no mutable bodies. */
export type EntryType = 'persona' | 'wiki' | 'story' | 'lore' | 'memory' | 'state';
export type RecallMode = 'off' | 'smart' | 'deep' | 'story-rp';
export interface BookScope { characterId: string; pairingId: string; sessionId: string }
export interface EntryTrigger {
  strategy: 'always' | 'keyword' | 'regex' | 'search';
  keys: string[]; secondaryKeys: string[]; operator: 'and' | 'or';
  priority: number; stickyTurns: number; cooldownTurns: number;
}
export interface BookEntry {
  knowledgeCategory?:import('../memory/knowledge-category.js').KnowledgeCategory;
  /** Explicitly reviewed derived persona; never set directly by model output. */
  corePersona?:boolean;
  id: string; type: EntryType; title: string; body: string; enabled: boolean;
  origin: 'authored' | 'observed' | 'inferred'; revision: number;
  pairingId: string | null; sourceRefs: string[]; aliases: string[]; tags: string[];
  entities: string[]; locations: string[]; related: string[];
  timeStart: string | null; timeEnd: string | null;
  validFrom: string | null; validUntil: string | null; importance: number;
  pinned: boolean; trigger: EntryTrigger;
  /** Imported content digest; detects hand edits on reimport. */
  importedHash: string | null;
  /** CIR additive metadata. Wiki facts remain in the original owner; views contain references. */
  fact?: WikiFact;
  knowledge?: KnowledgeBoundary;
  canon?: { level: string; confidence: string };
  /** Legacy authoring scope label; never an instance authorization grant. */
  authorScope?: string;
  event?: InstanceEvent;
  state?: { key: string; value: string; eventId: string };
  /** W02 optional review metadata. Absent entries keep their historical meaning. */
  organization?: { domain: import('./wiki-organization.js').KnowledgeDomain; evidenceStatus: import('./wiki-organization.js').EvidenceStatus; coexisting?:boolean; resourceRefs?: { resourceId: string; sha256: string; resourceRevision: number }[] };
  /** Reviewed derived Wiki, retaining original entry/source identities rather than replacing them. */
  synthesis?: import('./wiki-synthesis.js').SynthesisMetadata;
}
export interface InstanceEvent {
  basis: 'user_message' | 'author_initialization'; referenceId: string; quote: string;
  changes: { key: string; before: string | null; after: string; stateId: string }[];
}
export interface StateProposal { turnId: string; quote: string; changes: { key: string; value: string; validUntil?: string }[] }
export interface StatePreview {
  id: string; characterId: string; pairingId: string; sessionId: string;
  expectedRevision: number; event: BookEntry; states: BookEntry[]; expiresAt: number;
}
export interface KnowledgeBoundary { worldId: string; branch: string; chapter: number; awareness: 'experienced' | 'heard' | 'unknown' }
export interface KnowledgeView { worldId: string; branch: string; cutoff: number }
export interface WikiFact { sourceId: string; sourceHash: string; subject: string; predicate: string; value: string; quote: string; start: number; end: number; status: 'source_asserted' | 'confirmed'; key: string }
export interface WikiSource {
  id: string; title: string; uri: string | null; pairingId: string | null; enabled: boolean;
  revision: number; hash: string; forgottenKeys: string[];
  snapshots: { hash: string; text: string; capturedAt: string }[];
}
export interface PersonalWikiRevision {
  compilation?: {jobId:string;resultHash:string};
  revision:number; body:string; fingerprint:string;
  basisRefs:{entryId:string;revision:number}[];
  sources:{id:string;hash:string;revision:number}[];
}
export interface PersonalWikiPage extends PersonalWikiRevision {
  id:string; characterId:string; pairingId:string; subject:string;
  aliases?:string[];
  compilationInputHash?:string;
  layer?:'recent'|'important'|'ongoing';
  kind:'profile'|'person'|'preference'|'event'|'relationship'|'topic'|'experience';
  entryIds:string[];sourceIds:string[];links:string[];backlinks:string[];
  history:PersonalWikiRevision[];
}
export interface BookSnapshot { schemaVersion: 'memory-book/v1'; characterId: string; revision: number; entries: BookEntry[]; wikiSources?: WikiSource[];
  /** Private compiled, source-backed views; canonical facts remain entries/wikiSources. */
  wikiPages?: PersonalWikiPage[];
  archiveCounts?: { entries: number; sources: number; segments: number };
  relationships?: import('../core/companion-relationship.js').CompanionRelationship[];
  companionData?: import('./book-companion.js').CompanionData[];
  /** Private instance life, not authored entries. Its own revision does not invalidate dialogue. */
  companionStates?: import('../core/companion-behavior.js').CompanionLifeState[] }
export interface BookImportPreview {
  id: string; characterId: string; pairingId: string; expectedRevision: number; documentHash: string;
  name: string; entries: BookEntry[]; changes: { id: string; action: 'add' | 'update' | 'noop' | 'conflict'; reason: string }[];
  diagnostics: string[]; expiresAt: number;
  wikiSources?: WikiSource[];
  /** Preview-only ZIP metadata. Recommended view is displayed, never silently applied. */
  archive?: { bookFile: string; excludedFiles: string[]; knowledgeView?: KnowledgeView };
}
export interface EntryRef { entryId: string; chunkId: string; revision: number }
export interface BookChunk { ref: EntryRef; text: string; heading: string; contentHash: string; start: number; end: number; splitterVersion: string }
export interface Candidate {
  ref: EntryRef; routes: string[]; rawScores: Record<string, number>;
  fusionScore: number; matchReasons: string[];
  /** Conservative body token estimate, filled when the current body is read. */
  tokenCost?: number;
}
export interface QueryPlan {
  action: 'NO_RETRIEVAL' | 'RETRIEVE'; intent: string[]; queries: string[];
  entities: string[]; sources: EntryType[];
  timeRange: { from: string | null; to: string | null };
}
export interface RecallLimits { perRoute: number; candidates: number; selected: number; related: number; plannerMs: number }
export interface RecallConfig { mode: RecallMode; continueLocalOnError: boolean; regexEnabled: boolean; limits: RecallLimits;memoryDomain?:import('./book-dialogue.js').DialogueMemoryDomain }
export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  mode: 'smart', continueLocalOnError: false, regexEnabled: false,
  limits: { perRoute: 10, candidates: 40, selected: 8, related: 8, plannerMs: 2000 },
};
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
/**
 * How a binding reaches its model. Absent `kind` is the legacy OpenAI-compatible HTTP
 * binding and keeps its exact behavior; `chatgpt-web` routes through the controlled
 * ChatGPT web adapter (RPD_CHAT_WIKI §2.2: the binding is the five-layer's purpose
 * selector — the browser account itself is declared by `RuntimeConfig.chatgptWeb`).
 */
export type ModelBindingKind = 'http' | 'chatgpt-web';
export interface ModelBinding { name?: string; kind?: ModelBindingKind; baseUrl: string; model: string; credentialId: string; inputTokens: number; outputTokens: number; imageInput?: boolean; reasoningEffort?: 'low' | 'medium' | 'high';structuredOutput?:'json-object'|'json-schema'|'prompt' }
/**
 * ChatGPT web source instance (RPD_CHAT_WIKI §2.2/§6): the user's own logged-in browser
 * context. AIKI only launches the two allowlisted tools against it and never owns or kills
 * the browser. Consent is recorded per purpose; enabling one purpose never grants the other.
 */
/**
 * How a web chat message is submitted against the logged-in session. Both consume the
 * same chat quota; this is a user-facing switch (settings), not an internal detail.
 * - 'auto': MVP selects the validated background page path; no cross-mechanism resend.
 * - 'token': experimental internal POST, unavailable in the MVP production composition.
 * - 'page': browser-owned background submission and exact conversation readback.
 */
export type ChatgptWebSubmitMechanism = 'auto' | 'token' | 'page';

export interface ChatgptWebSourceConfig {
  /** Missing on legacy configs means bridge. CLI remains an explicitly selected fallback. */
  transport?: 'bridge' | 'cli' | 'embedded';
  /** chrome-use browser context: 'auto' | 'relay' | a Chrome profile name. */
  profile: string;
  /** chrome-use session (tab group) shared with chatgpt-use. */
  session: string;
  /** Optional explicit directory containing the chatgpt-use/chrome-use executables; null = PATH only. */
  binDir: string | null;
  /** Whole-turn budget for web chat replies (RPD D7: proposal until measured). */
  replyBudgetMs: number;
  /** Budget for web wiki compilation calls. */
  wikiBudgetMs: number;
  /** Purposes this machine explicitly authorized to send material to ChatGPT. */
  authorizedPurposes: ('reply' | 'wiki')[];
  /**
   * Test/debug requests use temporary chats (`?temporary-chat=true` / history_and_training_disabled)
   * so they never land in the account's chat history. Default true; user opt-out recorded here.
   */
  temporaryChatTests: boolean;
  /** Formal calls default to temporary; local Book memory remains independent. */
  conversationMode?: 'temporary' | 'regular';
  /** Explicit native reasoning slider choice; omitted keeps the account's current setting. */
  thinkingLevel?: number;
  /** Which submit mechanism to use (user-facing switch; see ChatgptWebSubmitMechanism). */
  submitMechanism: ChatgptWebSubmitMechanism;
}
/** Defaults used before the user saves a source config (management probe/login still work). */
export const DEFAULT_CHATGPT_WEB_SOURCE: ChatgptWebSourceConfig = {
  transport: 'bridge',
  profile: 'auto', session: 'chatgpt-web', binDir: null,
  replyBudgetMs: 300_000, wikiBudgetMs: 300_000,
  temporaryChatTests: true, conversationMode: 'regular', submitMechanism: 'auto', authorizedPurposes: [],
};
export interface RuntimeCharacter { id: string; name: string; intro: string; appearancePath: string | null; appearanceSkinId?: string | null; knowledgeView?: KnowledgeView; replyLength?:import('./reply-length.js').ReplyLengthSettings; promptPresetId?:string|null;userName?:string;voice?:import('./book-voice.js').BookVoiceSettings;screen?:import('./book-screen.js').BookScreenSettings; /** B03 default reply style; absent keeps legacy natural. */ replyStyle?:import('./reply-length.js').ReplyStyle }
export type ReplyLanguage = 'zh-CN' | 'ja-JP' | 'en' | 'zh-ja-ruby';
export interface RuntimeConfig {
  dialogueRouting?:import('./book-dialogue.js').DialogueRoutingSettings;
  /** Archived role configurations retain their data and can be restored explicitly. */
  archivedCharacters?: RuntimeCharacter[];
  /** One-time starter installation; retained after the user edits/removes the role. */
  gptNiangStarterVersion?: 1;
  promptPresets?:import('./prompt-preset.js').StoredPromptPreset[];
  incognitoDefault?: boolean;
  companion?: import('./book-companion.js').CompanionSettings;
  schemaVersion: 'memory-runtime/v1'; revision: number; currentCharacterId: string;
  characters: RuntimeCharacter[]; mainModel: ModelBinding | null; fastModel: ModelBinding | null;
  /** Optional dedicated wiki compilation binding (RPD §4.2). Absent → legacy fastModel behavior. */
  wikiModel?: ModelBinding | null;
  /** Optional ChatGPT web source instance. Absent → no web source is configured. */
  chatgptWeb?: ChatgptWebSourceConfig;
  /** Explicit private project bindings. Absent preserves the legacy temporary default. */
  chatgptProjects?: import('./chatgpt-project.js').ChatgptProjectBinding[];
  recall: RecallConfig;
  /** Omitted legacy settings use Chinese. Applies to final dialogue, not retrieval or source text. */
  replyLanguage?: ReplyLanguage;
}
export interface SavedTurn {screenObservation?:import('./book-screen.js').BookScreenReceipt; id: string; characterId: string; pairingId: string; sessionId: string; timestamp: string; user: string; assistant: string; traceId: string; incognito?: true;replyLength?:import('./reply-length.js').ReplyLengthResult; /** B03: the frozen style decision that governed this turn. */ replyStyleDecision?:import('./reply-length.js').ReplyStyleDecision;
  dialogue?:import('./book-dialogue.js').DialogueReceipt;
  contents?:import('./book-message.js').MessageContent[];
  transcript?:import('./book-message.js').TextTranscriptReceipt;
  promptPreset?:{id:string;revision:number;documentHash:string};
  replySurface?:'bubble';
  bubbleReplyLength?:import('./reply-length.js').ReplyLengthResult;
  /** W01: the attachment selections this turn consumed, frozen with their content hashes at submit. */
  inputResources?:import('./book-resources.js').FrozenResourceSelection[];
  inputImageReceipts?:import('./book-resources.js').ImageInputReceipt[];
  /** W01: replay identity of the attachment list (scope+turnId+query+style+ordered ids/use/sha256). */
  resourceRequestHash?:string;
  /** W01: the delivery whose files belong to this turn's assistant message. Absent = no files offered. */
  artifactDeliveryId?:string }
/**
 * A turn identity whose submission was attempted and did not commit (failed/cancelled/timed out).
 * The marker is durable so a restart cannot silently recompile it under another preset/config and
 * submit again. It deliberately carries NO message body: only the idempotency identity and a hash
 * of the frozen submit inputs.
 */
export type FrozenTurnState = 'submitted' | 'failed' | 'cancelled' | 'timeout';
export interface FrozenTurn {
  turnId: string; characterId: string; pairingId: string; sessionId: string;
  state: FrozenTurnState;
  /** SHA-256 over the frozen submit identity (config revision, query, style, attachment ids/use). */
  requestHash: string;
  at: string;
}
/**
 * Derived from persisted session records only; no second index is maintained. `turnCount` is `-1`
 * when the underlying file was too large for an exact count and only head/tail were read.
 */
export interface SessionSummary {
  characterId: string; pairingId: string; sessionId: string;
  title: string; createdAt: string; updatedAt: string;
  turnCount: number; lastTurnId: string | null;
  /** Hidden from recent sessions, still readable and eligible for memory processing. */
  archivedAt?: string;
}
/** One explicit, minimal real chat request against a draft or saved binding. Never persists anything. */
export interface ModelTestResult {
  ok: boolean; testedAt: string; durationMs: number; model: string;
  reply?: string; error?: { code: string; message: string };
}
export interface BookChange { upsert?: BookEntry[]; remove?: string[]; wikiSources?: WikiSource[];
  wikiApproval?: {jobId:string;confirmed:true};
  /** Explicit user re-learning binds a grant to one new private fact/source, preserving tombstones. */
  relearn?: { entryId: string; confirmed: true } }
export interface CommitReceipt { operationId: string; revision: number; changedIds: string[] }
export interface BookRepository {
  snapshot(scope: BookScope): BookSnapshot;
  read(scope: BookScope, refs: EntryRef[]): { entry: BookEntry; chunkId: string }[];
  commit(scope: BookScope, changes: BookChange, expectedRevision: number, operationId: string): CommitReceipt;
}
export interface RuntimeRepository {
  loadConfig(): RuntimeConfig;
  commitConfig(config: RuntimeConfig, expectedRevision: number, operationId: string): CommitReceipt;
  readSession(scope: BookScope): SavedTurn[];
  readSessionPage?(scope:BookScope,before:number|null,limit:number):{turns:SavedTurn[];before:number|null};
  appendTurn(scope: BookScope, turn: SavedTurn): void;
  /** Additive (MB sessions v1): summaries of persisted sessions for one character/pairing, most recent first. */
  listSessions(characterId: string, pairingId: string, options?: { all?: boolean; query?: string;strict?:boolean }): SessionSummary[];
  renameSession?(scope: BookScope, title: string): void;
  setSessionArchived?(scope: BookScope, archived: boolean): void;
  /**
   * Durable pre-submit intent and terminal marker for an explicit turnId.
   * Implementations persist no message bodies. Optional so read-only/fake repositories degrade to
   * process-local dedupe only.
   */
  freezeTurn?(scope: BookScope, record: FrozenTurn): void;
  readTurnFreeze?(scope: BookScope, turnId: string): FrozenTurn | null;
  /** Remove an intent only after the matching SavedTurn is durable. */
  completeTurnFreeze?(scope: BookScope, turnId: string): void;
}
export interface SearchIndexPort {
  rebuild(snapshot: BookSnapshot): void;
  search(scope: BookScope, plan: QueryPlan, config: RecallConfig, signal: AbortSignal): Candidate[];
  invalidate(characterId: string): void;
}
export interface RecallPlannerPort {
  plan(input: { query: string; recentMessages: ChatMessage[]; entities: string[] }, signal: AbortSignal): Promise<QueryPlan>;
  rerank(input: { query: string; candidates: { id: string; title: string; text: string }[] }, signal: AbortSignal): Promise<{ id: string; rank: number; reason: string }[]>;
}
export interface SemanticSearchPort {
  search(scope: BookScope, query: string, limits: RecallLimits, signal: AbortSignal): Promise<Candidate[]>;
}
export class BookError extends Error {
  constructor(public code: 'invalid_input' | 'conflict' | 'corrupt_data' | 'not_found' | 'budget' | 'unavailable' | 'busy', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'BookError';
  }
}
export const emptyEntry = (id: string, type: EntryType, title: string, body: string): BookEntry => ({
  id, type, title, body, enabled: true, origin: 'authored', revision: 0, pairingId: null,
  sourceRefs: [], aliases: [], tags: [], entities: [], locations: [], related: [],
  timeStart: null, timeEnd: null, validFrom: null, validUntil: null, importance: 50,
  pinned: false, importedHash: null,
  trigger: { strategy: type === 'persona' ? 'always' : type === 'lore' ? 'keyword' : 'search',
    keys: [], secondaryKeys: [], operator: 'or', priority: 50, stickyTurns: 2, cooldownTurns: 0 },
});

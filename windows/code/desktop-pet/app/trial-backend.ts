import { EmotionTurns } from '../core/emotion-state.js';
import { homedir } from 'node:os';
import { SqliteMemoryImportManagement } from '../memory/import-management.js';
import { HistoricalMemoryTransport, historicalMemoryInputBytes, memoryImportConfiguration, observedImportEndpoint } from './memory-import.js';
import { WakeManager } from './wake-manager.js';
import { wechatTranscriber } from '../wechat/asr.js';
import { wechatAudioFileSender } from '../wechat/output.js';
import { WeChatService } from '../wechat/service.js';
import { WeChatApi } from '../wechat/api.js';
import { WeChatStore } from '../wechat/store.js';
import { WeChatTextConversation } from '../wechat/conversation.js';
import { WorkPlanner } from '../providers/work-plan.js';
import { DesktopWork } from '../harness/desktop-work.js';
import { WorkIntentClassifier } from '../providers/work-intent.js';
import { QwenAsrProvider } from '../providers/qwen-asr.js';
import { QwenVisualEmotionProvider, VISUAL_EMOTION_PROMPT } from '../providers/qwen-visual-emotion.js';
import { SplitPerceptionProvider } from '../providers/split-perception.js';
import { SherpaStreamingAsr } from '../providers/sherpa-streaming-asr.js';
import { streamingAsrConfiguration } from './backend-session.js';
import { StrictManagementForget, withStrictManagementForget } from './management-forget.js';
import { assertCompanionDataConfiguration } from './companion-data.js';
import { isOutside, isPrivateFileSync } from '../core/platform-files.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, unlink, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {pendingMemoryManagement} from '../management/pending-memory.js';
import { fileURLToPath } from 'node:url';
import type { MemoryTurnInput, MemoryTurnPlan, MemoryTurnProvider, MemoryTurnOutcome } from '../contracts/memory-lifecycle.js';
import type { TurnScope, TtsProvider, MediaStorePort } from '../contracts/index.js';
import type { ProviderSelection } from '../contracts/management.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import { ProactiveInvitationRuntime } from '../companion/proactive-invitation-runtime.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../memory/sqlite-lifecycle-port.js';
import { SqliteManagementMemoryPort } from '../memory/management-port.js';
import { ManagementSettingsStore } from '../management/settings-store.js';
import { effectiveTrialConfiguration } from '../management/settings.js';
import { RoleConfigurationStore, applyRoleConfigurationToTrial, loadEffectiveRoleConfiguration } from '../management/role-configuration.js';
import { COMPANION_ID } from '../contracts/character.js';
import { LorebookStore } from '../memory/lorebook-store.js';
import { ManagementRuntime } from '../management/runtime.js';
import { PresentationSettingsStore, readPresentationCatalog } from '../management/presentation.js';
import { startRuntimeManagement } from '../management/bootstrap.js';
import { characterWikiImportManagement } from '../management/character-wiki-import-routes.js';
import { characterDocumentManagement, lorebookFingerprintOf } from '../management/character-document-routes.js';
import { desktopHostManagement } from '../management/desktop-host-routes.js';
import { ProductionPlaygroundPort } from '../management/playground-port.js';
import type { MemoryRecord } from '../memory/ledger.js';
import { abortable } from '../media/scope.js';
import { MemoryMediaStore } from '../media/store.js';
import { JsonDialogueProvider } from '../providers/qwen-dialogue.js';
import { JsonSummaryProvider } from '../providers/qwen-memory-lifecycle.js';
import { QwenPerceptionProvider } from '../providers/qwen-perception.js';
import { QwenTtsProvider, billedCharacters } from '../providers/qwen-tts.js';
import { SapiTtsProvider } from '../providers/sapi-tts.js';
import { QwenAudioTtsProvider, isQwenAudioTtsModel } from '../providers/qwen-audio-tts.js';
import { MiniMaxTtsProvider, MINIMAX_TTS_MODEL, MINIMAX_TTS_ENDPOINT } from '../providers/minimax-tts.js';
import { RegisteredVoiceStore } from '../providers/registered-voices.js';
import { ProviderTransport, type EndpointConfig, type JsonRecord, type ProviderOperation } from '../providers/transport.js';
import { BackendSession, type BackendPorts } from './backend-session.js';
import { TrialAuthorizer } from './trial-authorizer.js';
import { readActiveTrialConfiguration, type TrialConfiguration, type TrialOperation } from './trial-config.js';
import { verifyTrialRuntime } from './trial-launcher.js';
import { contextInputUpperBound, summaryInputUpperBound } from './input-budgets.js';
import { inspectPcmWav } from '../media/wav.js';
import { prototypeSnapshot } from './memory-planning-prototype.js';
import { runMemorySemanticAttempt, type SemanticAttemptEvent } from './memory-semantic-adapter.js';
import { buildMemorySemanticFormat } from './memory-semantic-format.js';
import { TrialAdmission } from './trial-admission.js';
import { AikaProfileStore, applyAikaProfile } from '../management/aika-profile.js';
import { AikaTimelineStore } from '../management/aika-timeline.js';
import { KnowledgeLibraryStore } from '../memory/knowledge-library.js';
import { knowledgeManagement } from '../management/knowledge-routes.js';
import { MicrophonePreferenceStore } from '../media/microphone-preference.js';
import { SkinStore } from '../management/skin-store.js';
import { CharacterPackStore } from '../memory/character-pack-store.js';
import { ContinuityMemoryStore } from '../memory/continuity-memory-store.js';
import { ConversationCandidateWriter } from '../memory/conversation-candidate-writer.js';
import { readTraceContentFromHistory } from '../memory/trace-history-content.js';
import { ProductionContinuityContext, productionPairingResolver } from '../memory/continuity-production.js';
import { AikiContextStore } from '../memory/aiki-context-port.js';
import { productionPairing, type PairingScope } from '../contracts/character-pack.js';
import { continuityManagement } from '../management/continuity-routes.js';
import { proactiveInvitationManagement } from '../management/proactive-invitation-routes.js';
import { RuntimeTraceStore } from '../core/trace-store.js';
import { LegacyProviderRuntimeAdapter, resolveOpenAiCallUrl } from '../plugins/legacy-provider-adapter.js';
import { Next65Management } from '../management/next65-management.js';
import { FlowAwareDialogueProvider } from '../providers/flow-aware-dialogue.js';
import { CompanionEventHub } from '../core/companion-event-hub.js';
import { UnifiedTimelineService } from '../memory/unified-timeline.js';
import { WorkProtocolRuntime } from '../management/work-protocol-runtime.js';
import { CaptureGrantManager } from '../core/perception-grant.js';
import { ScreenPerceptionService } from '../core/screen-perception.js';
import { ObservationContextAdapter, ObservationTurnInbox, ObservationAwareDialogueProvider } from '../core/observation-context.js';
import { PerceptionManagementRuntime } from '../management/perception-runtime.js';
import { ScreenGrantRuntime } from '../management/screen-grant-runtime.js';
import { CompanionTriggerRuntime } from '../management/companion-trigger-runtime.js';
import { CollectionStore } from '../memory/collection-store.js';
import { CollectionGrantManager } from '../core/collection-grants.js';
import { CollectionService } from '../core/collection-service.js';
import { CollectionManagement } from '../management/collection-management.js';
import { CollectionHelperClient, collectionHelperPaths, resolveHelperPackageRoot, loadCollectionHelperManifest, sweepStaleStaging } from '../core/collection-helper-client.js';
import { ScreenshotDirectorySource } from '../core/screenshot-directory-source.js';
import { ClipboardImageSource } from '../core/clipboard-image-source.js';
import { loadCollectionPolicy } from '../contracts/collection.js';
import { createLocalOcrEngine } from '../core/local-ocr-engine.js';
import { createWindowsMediaOcrEngine, windowsMediaOcrHelperPaths } from '../core/windows-media-ocr-engine.js';
import { CompanionModeRuntime } from '../core/companion-mode-runtime.js';
import { CollectionBatchRunner } from '../core/collection-batch-runner.js';
import { CollectionSourceReader } from '../core/collection-source-reader.js';
import { WorkspaceDirectorySource } from '../core/workspace-directory-source.js';
import { WindowsScreenCapture, captureAvailability } from '../core/windows-screen-capture.js';
import { ActivityUnderstanding } from '../core/activity-understanding.js';
import { DailyActivitySummary } from '../core/daily-activity-summary.js';
import { WikiCompiler } from '../core/wiki-compiler.js';
import { LocalDeliveryCoordinator } from '../core/trigger-delivery.js';
import { CompanionAutomationScheduler } from '../core/companion-automation-scheduler.js';
import { TextSourceService, type TextSourceKind } from '../core/text-source-service.js';
import { ClipboardTextSource } from '../core/clipboard-text-source.js';
import { InputTextSource } from '../core/input-text-source.js';
import { HistorySourceReference } from '../core/history-source-reference.js';
import type { CollectionSourceKind, ContinuousCaptureSourceKind } from '../contracts/collection.js';

/** CK-03: the only source kinds with an OS listener in this process. */
const isContinuousCaptureKind = (kind: CollectionSourceKind): kind is ContinuousCaptureSourceKind =>
  kind === 'keyboard' || kind === 'screenshot_directory' || kind === 'clipboard_image';
import { ObservationScheduler } from '../core/observation-scheduler.js';
import { ScreenCaptureSource } from '../core/screen-capture-source.js';
import { DocumentParser } from '../core/document-parser.js';
import { qwenCloudScreenObservation, SCREEN_OBSERVATION_PROMPT } from '../providers/qwen-screen-observation.js';
// Health is derived from the runtime's own observations, so no extra probe is started here.

/**
 * N081-06: decode PNG/JPEG/WebP intrinsic dimensions from the header only.
 *
 * Used as the collection store's pixel probe. It reads no pixels, performs no decoding work beyond
 * the header, and returns null for anything it cannot confidently interpret — so a malformed image
 * is refused rather than stored with a guessed size.
 */
export function probeImageDimensions(bytes: Uint8Array, mimeType?: string): { readonly width: number; readonly height: number } | null {
  const detected = mimeType ?? (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 ? 'image/webp'
    : bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d ? 'image/bmp' : '');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (detected === 'image/bmp') {
    // BMP carries signed 32-bit width/height at offsets 18 and 22; a negative height means the rows
    // are stored top-down, which is still a valid image of that absolute size.
    if (bytes.length < 26) return null;
    const width = view.getInt32(18, true);
    const height = Math.abs(view.getInt32(22, true));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (detected === 'image/png') {
    if (bytes.length < 24) return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (detected === 'image/webp') {
    if (bytes.length < 30) return null;
    // Only the lossy (`VP8 `) variant carries plain 14-bit dimensions at a fixed offset.
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    return null;
  }
  if (detected === 'image/jpeg') {
    // Walk the segment chain to the SOF marker, which carries the real frame dimensions.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) {
        const height = view.getUint16(offset + 5);
        const width = view.getUint16(offset + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += 2 + length;
    }
    return null;
  }
  return null;
}

/** Keep production trial calls within the reviewed text bounds without truncating user content or replies. */
export class TrialTransport extends ProviderTransport {  constructor(private readonly configuration: TrialConfiguration, private readonly providerFetch: typeof fetch = fetch,
    private readonly runtime?: ManagementRuntime, private readonly dialogueTemperature?: number) { super(providerFetch); }
  override async request(config: EndpointConfig, scope: TurnScope, operation: ProviderOperation, body: JsonRecord,
    signal: AbortSignal, textCharacters?: number, audioSeconds?: number): Promise<JsonRecord> {
    const model = this.configuration.models[operation as TrialOperation];
    if (!model || operation === 'memory_maintenance') throw new Error('Unregistered trial operation');
    if (operation !== 'tts' && operation !== 'perception' && operation !== 'asr') {
      const upper = Buffer.byteLength(JSON.stringify(body.messages), 'utf8') + 2048;
      if (upper > model.inputTokenLimit) throw new Error('Trial request exceeds its reviewed input bound');
    }
    if (operation === 'perception' && this.configuration.models.asr) {
      const messages = body.messages as {role?:string;content?:Record<string,unknown>[]}[] | undefined;
      const content=messages?.[0]?.content;
      if(messages?.length!==1 || messages[0]?.role!=='user' || !Array.isArray(content) || content.length<2 || content.length>4
        || ![{type:'text',text:VISUAL_EMOTION_PROMPT},{type:'text',text:SCREEN_OBSERVATION_PROMPT}].some(prompt=>JSON.stringify(content.at(-1))===JSON.stringify(prompt))
        || content.slice(0,-1).some(part=>part.type!=='image_url' || Object.keys(part).some(k=>!['type','image_url'].includes(k))
          || !/^data:image\/(jpeg|png);base64,/.test(String((part.image_url as {url?:string})?.url)))
        || JSON.stringify(body.modalities)!=='["text"]' || body.stream!==true
        || Object.keys(body).some(k=>!['messages','stream','stream_options','modalities'].includes(k)))
        throw new Error('Visual request must contain only current images and the fixed visual prompt');
    }
    if (operation === 'asr') {
      const messages=body.messages as {role?:string;content?:{type?:string;input_audio?:{data?:string}}[]}[]|undefined;
      const content=messages?.[0]?.content,data=content?.[0]?.input_audio?.data;
      if (messages?.length!==1 || messages[0]?.role!=='user' || content?.length!==1 || content[0]?.type!=='input_audio' || typeof data!=='string' || !data.startsWith('data:audio/wav;base64,')) throw new Error('ASR audio request is invalid');
      const bytes=Buffer.from(data.slice('data:audio/wav;base64,'.length),'base64');
      try { const actualSeconds=inspectPcmWav(bytes).durationMs/1000; if(typeof audioSeconds!=='number'||!Number.isFinite(audioSeconds)||Math.abs(actualSeconds-audioSeconds)>0.000001)throw new Error('ASR audio duration mismatch'); } finally {bytes.fill(0);}
    }
    if (operation === 'tts') {
      const input = body.input as Record<string, unknown> | undefined;
      if (!input || typeof input.text !== 'string' || (this.configuration.purpose !== 'user-trial' && [...input.text].length > 600)) throw new Error('Trial speech request exceeds its reviewed bounds');
      if (model.model === MINIMAX_TTS_MODEL || model.model === 'MiniMax/speech-2.8-hd') {
        const voice = input.voice_setting as Record<string, unknown> | undefined;
        const audio = input.audio_setting as Record<string, unknown> | undefined;
        if (config.endpoint !== MINIMAX_TTS_ENDPOINT || Buffer.byteLength(input.text, 'utf8') !== textCharacters
          || !voice || typeof voice.voice_id !== 'string' || !voice.voice_id || voice.speed !== 1 || voice.vol !== 1 || voice.pitch !== 0
          || !audio || audio.sample_rate !== 24000 || audio.format !== 'wav' || audio.channel !== 1
          || input.output_format !== 'hex' || input.language_boost !== 'Chinese'
          || Object.keys(input).some(key => !['text', 'voice_setting', 'audio_setting', 'output_format', 'language_boost'].includes(key))
          || Object.keys(voice).some(key => !['voice_id', 'speed', 'vol', 'pitch'].includes(key))
          || Object.keys(audio).some(key => !['sample_rate', 'format', 'channel'].includes(key)))
          throw new Error('Trial MiniMax speech request exceeds its reviewed bounds');
      } else {
        const instruction = input[isQwenAudioTtsModel(model.model) ? 'instruction' : 'instructions'];
        if (billedCharacters(input.text) !== textCharacters || typeof instruction !== 'string'
          || Buffer.byteLength(instruction, 'utf8') > 1600) throw new Error('Trial speech request exceeds its reviewed bounds');
      }
    }
    const timeout = AbortSignal.timeout(this.configuration.memory.timeoutMs);
    const boundedSignal = AbortSignal.any([signal, timeout]);
    // RUX-01: the guard pins every call to the REGISTERED configuration, but a stored endpoint may be
    // an apiBase (`…/v1`) while the provider's EndpointConfig carries the derived call URL
    // (`…/v1/chat/completions`, see resolveOpenAiCallUrl). Compare like-for-like: the endpoint in use
    // must still be DERIVED from the registered one — any other origin stays a hard mismatch.
    if (config.model !== model.model || config.endpoint !== resolveOpenAiCallUrl(model.endpoint, operation as TrialOperation, model.protocol)) throw new Error('Trial transport provider mismatch');
    const boundedBody = model.provider === 'deepseek' && operation !== 'memory_turn' ? { ...body, max_tokens: operation === 'admission' && Number.isSafeInteger(body.max_tokens) && Number(body.max_tokens) > 0 && Number(body.max_tokens) <= 4096 ? Math.min(Number(body.max_tokens), model.outputTokenLimit) : model.outputTokenLimit } : body;
    const requestBody = operation === 'dialogue' && this.dialogueTemperature !== undefined ? { ...boundedBody, temperature: this.dialogueTemperature } : boundedBody;
    const call = (sent: () => void = () => {}) => new ProviderTransport((...args) => {
      sent(); return this.providerFetch(...args);
    }).request(config, scope, operation, requestBody, boundedSignal, textCharacters, audioSeconds);
    return this.runtime ? this.runtime.observeCall(operation as TrialOperation, scope.characterId, call, boundedSignal) : call();
  }
}

export function createTrialTtsProvider(selection: ProviderSelection, endpoint: EndpointConfig,
  store: MediaStorePort, transport: ProviderTransport, voices?: RegisteredVoiceStore): TtsProvider {
  // RWR-08 (实机轮): a resolved role capability carries voice/language inside its frozen
  // `parameters` record, while `settings.effective` carries them at the top level. Normalize BOTH
  // shapes here so the factory contract is independent of which authority the caller consumed.
  const params = (selection as { parameters?: Readonly<Record<string, string | number | boolean>> }).parameters;
  const normalized: ProviderSelection = {
    ...selection,
    ...(selection.voice === undefined && typeof params?.voice === 'string' ? { voice: params.voice } : {}),
    ...(selection.language === undefined && typeof params?.language === 'string' ? { language: params.language } : {}),
  };
  if (normalized.adapterId === 'minimax-tts') {
    if (!voices || !normalized.voice || endpoint.model !== normalized.model || endpoint.endpoint !== normalized.endpoint) throw new Error('Registered MiniMax voice required');
    const registeredVoice = voices.resolve({ voiceId: normalized.voice, provider: 'dashscope', targetModel: normalized.model,
      endpoint: normalized.endpoint, credentialRef: normalized.credentialRef });
    return new MiniMaxTtsProvider({ ...endpoint, voice: normalized.voice, credentialRef: normalized.credentialRef, registeredVoice }, store, transport);
  }
  if (normalized.adapterId === 'qwen-audio-tts') {
    const registeredVoice = voices?.snapshot().voices.some(voice => voice.voiceId === normalized.voice)
      ? voices.resolve({ voiceId: normalized.voice!, provider: 'dashscope', targetModel: normalized.model,
        endpoint: normalized.endpoint, credentialRef: normalized.credentialRef }) : undefined;
    return new QwenAudioTtsProvider({ ...endpoint, voice: normalized.voice!, credentialRef: normalized.credentialRef,
      ...(registeredVoice ? { registeredVoice, languageHints: ['zh'] as const } : {}) }, store, transport);
  }
  if (normalized.adapterId === 'qwen-tts-instruct') return new QwenTtsProvider({ ...endpoint, voice: normalized.voice!, language: normalized.language! }, store, transport);
  // RWR-08 (F04/实机轮): `TrialModel` (the validator's product) does NOT carry `adapterId`, so a
  // resolved role binding converted through `applyRoleConfigurationToTrial` reaches this factory
  // without one. The old code never noticed because it read `settings.effective` directly (which
  // still has adapterId). Identify the implemented INSTRUCTION protocol by its wire shape instead —
  // the QwenTtsProvider constructor remains the authority that the model/voice/language triple is
  // actually servable; anything else is still refused, no silent fallback.
  if (!normalized.adapterId) {
    if (normalized.voice && normalized.language) return new QwenTtsProvider({ ...endpoint, voice: normalized.voice, language: normalized.language }, store, transport);
    if (normalized.voice) return new QwenAudioTtsProvider({ ...endpoint, voice: normalized.voice, credentialRef: normalized.credentialRef }, store, transport);
  }
  throw new Error('Unregistered speech adapter');
}

/** Real semantic adapter and compiler; the SQLite port still owns tickets, source expansion and atomic commit. */
export class StrictTrialMemoryProvider implements MemoryTurnProvider {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly store: SqliteMemoryStore, private readonly config: EndpointConfig,
    private readonly transport: ProviderTransport, private readonly runId: string,
    private readonly evidence: (event: SemanticAttemptEvent) => Promise<void>, private readonly thinking?: 'high',
    private readonly provenanceKind: 'real_provider' | 'controlled_stub' = 'real_provider') {}
  plan(input: MemoryTurnInput, signal: AbortSignal): Promise<MemoryTurnPlan> {
    return this.planWithMode(input,signal);
  }
  /** Called only with the storage-issued virtual management ticket. */
  planManagement(input:MemoryTurnInput,signal:AbortSignal,managementTarget:import('../contracts/memory-lifecycle.js').SourceVersion):Promise<MemoryTurnPlan>{
    return this.planWithMode(input,signal,managementTarget);
  }
  private planWithMode(input:MemoryTurnInput,signal:AbortSignal,managementTarget?:import('../contracts/memory-lifecycle.js').SourceVersion):Promise<MemoryTurnPlan>{
    const captured = structuredClone(input);
    managementTarget=managementTarget?structuredClone(managementTarget):undefined;
    const work = this.pending.then(async () => {
      signal.throwIfAborted();
      // Include inactive parents as metadata so unread/deleted support is never silently invented.
      const records = new Map<string, MemoryRecord>();
      const visit = (record: MemoryRecord) => {
        if (records.has(record.id)) return;
        records.set(record.id, record);
        for (const ref of record.sources) { const parent = this.store.inspect(captured.scope, ref.id); if (parent) visit(parent); }
      };
      for (const kind of ['transcript', 'summary', 'memory', 'keyword_index', 'vector_index', 'context_cache', 'emotion'] as const)
        for (const record of this.store.visible(captured.scope, kind)) visit(record);
      let snapshot=prototypeSnapshot(captured,[...records.values()]);
      if(managementTarget){
        const current=captured.sources.find(s=>s.id===captured.currentMessageId);
        if(!current||current.kind!=='transcript'||current.messageRole!=='user'||current.origin!=='manual'||records.has(current.id))throw Error('Invalid virtual management request');
        snapshot={...snapshot,graph:[...snapshot.graph,{id:current.id,version:current.version,characterId:captured.scope.characterId,kind:'transcript',state:'active',eligible:true,parents:[]}]};
      }
      const result = await runMemorySemanticAttempt({ snapshot,
        config: this.config, transport: this.transport, provenance: { kind: this.provenanceKind, runId: this.runId, attemptId: randomUUID() },
        signal, evidence: this.evidence, dynamics:true, ...(managementTarget?{managementTarget}:{}), ...(this.thinking ? { reasoningEffort: this.thinking } : {}) });
      if (result.compiled.status === 'ready') return result.compiled.plan;
      if (result.compiled.status === 'needs_sources' && result.compiled.readProbe) return result.compiled.readProbe;
      throw new Error('Strict memory semantics are incomplete; no update was committed');
    });
    // Across both characters only one strict model request can reserve the large peak budget.
    this.pending = work.then(() => {}, () => {});
    return abortable(work, signal);
  }
}

export function keyReader(filename: string, configuration: TrialConfiguration, configFile: string, activationFile: string): () => string {
  return () => {
    // The generic transport requests its key before its async budget permit. Recheck metadata here first.
    const raw = readFileSync(configFile, 'utf8'), activation = JSON.parse(readFileSync(activationFile, 'utf8'));
    if (activation?.version !== 1 || activation.status !== 'active' || activation.phaseId !== configuration.phaseId
      || activation.configSha256 !== createHash('sha256').update(raw).digest('hex')
      || JSON.stringify(JSON.parse(raw)) !== JSON.stringify(configuration)) throw new Error('Trial is not active');
    const actual = realpathSync(filename), local = relative(realpathSync(configuration.projectRoot), actual), info = statSync(actual);
    if (!isAbsolute(filename) || !isOutside(realpathSync(configuration.projectRoot), actual) || !isPrivateFileSync(actual, info)) throw new Error('Restricted external trial credential file required');
    const key = readFileSync(actual, 'utf8').trim();
    if (!/^\S{1,4096}$/.test(key)||/[\u0000-\u001f\u007f]/.test(key)) throw new Error('Trial credential must contain exactly one key');
    return key;
  };
}

export async function startTrialBackend(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configFile = environment.PET_TRIAL_CONFIG, activationFile = environment.PET_TRIAL_ACTIVATION;
  if (!configFile || !activationFile || !isAbsolute(configFile) || !isAbsolute(activationFile)) throw new Error('Explicit trial configuration required');
  // FIX61-03: typed backend_startup progress ahead of backend_ready, so the shell renews its stall
  // window on real work instead of blind waiting. Only counters and the frozen phase names go on
  // stdout — never paths, credential material or diagnostics. The phase set mirrors the shell's
  // STARTUP_PHASES (desktop/electron/transport.mjs); this plain-protocol backend cannot import it.
  const STARTUP_PHASES = ['starting', 'verifying', 'initializing', 'ready'] as const;
  type StartupPhase = (typeof STARTUP_PHASES)[number];
  let startupSequence = 0;
  const emitStartup = (phase: StartupPhase, completed: number, total = 4) => {
    if (!STARTUP_PHASES.includes(phase)) throw new Error('Unknown startup phase');
    process.stdout.write(JSON.stringify({ channel: 'backend_startup', sequence: ++startupSequence,
      phase, completed, total, elapsedMs: Math.round(process.uptime() * 1000) }) + '\n');
  };
  const registeredConfiguration = await readActiveTrialConfiguration(configFile, activationFile);
  emitStartup('verifying', 1);
  if (registeredConfiguration.purpose === 'user-trial') assertCompanionDataConfiguration(registeredConfiguration);
  await verifyTrialRuntime(registeredConfiguration);
  emitStartup('initializing', 2);
  const voices = await RegisteredVoiceStore.open(resolve(registeredConfiguration.projectRoot, '.local/data/registered-voices.json'));
  const settings = await ManagementSettingsStore.open(resolve(dirname(configFile), 'management-settings.json'), registeredConfiguration, voices);
  /**
   * RWR-03 / CONTRACTS §2: the runtime consumes the three role-scoped capabilities through the SINGLE
   * effective-role resolver, never by reading the global projection directly.
   *
   * The resolver needs the role's saved configuration v2, which lives beside the preset file. It is read
   * here (before the SQLite store is constructed) because the effective model set is an INPUT to the
   * store's configuration, not a product of it. `loadEffectiveRoleConfiguration` seeds an inherit-default
   * configuration when the running role has no saved v2 config, so a first run still resolves through the
   * one resolver and stays traceable instead of silently consuming the global settings as a shadow record.
   *
   * RWR-08 (F01): the effective role is read from the PERSISTED registry instead of being hardcoded to
   * companion. The registry lives in the same SQLite database the memory store owns, and that store has
   * no dependency on the resolved model set, so it is opened BEFORE role resolution — this breaks the
   * "resolver needs the role, the role needs the store" cycle the review flagged. `CharacterRegistry
   * .open()` performs the restart-boundary transition (saved → effective), so the id read here is the
   * role this process actually runs, and a boot failure never promotes an unrun selection.
   */
  const roleConfigurationFile = resolve(dirname(configFile), 'role-configurations.json');
  const globalConfiguration = effectiveTrialConfiguration(registeredConfiguration, settings.effective);
  const roleStore = await RoleConfigurationStore.open({ file: roleConfigurationFile });
  // RWR-08 (F01): the store is opened BEFORE role resolution (the registry owns the running role) and
  // BEFORE the lock file, so a boot failure never leaves a half-registered process holding the lock.
  // A failure here is a startup failure: the process never claims another role is running. If the
  // outer try/catch below is not yet entered, close the store directly before rethrowing.
  let store: SqliteMemoryStore | undefined;
  try {
    store = new SqliteMemoryStore({ filename: globalConfiguration.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  } catch (storeError) { throw storeError; }
  const effectiveRoleId = store.registry.effectiveRole();
  const effectiveRole = loadEffectiveRoleConfiguration({
    base: registeredConfiguration, settings: settings.effective, store: roleStore, characterId: effectiveRoleId, voices,
  });
  const configuration = applyRoleConfigurationToTrial(globalConfiguration, effectiveRole);
  process.stdout.write(JSON.stringify({ channel: 'role_configuration', characterId: effectiveRoleId, configRevision: effectiveRole.configRevision, dialogue: effectiveRole.capabilities.dialogue.model, asr: effectiveRole.capabilities.asr.model, tts: effectiveRole.capabilities.tts.model }) + '\n');
  const evidenceRoot = resolve(configuration.projectRoot, '.local/model-evaluation/trial');
  await mkdir(evidenceRoot, { recursive: true });
  const runtime = new ManagementRuntime(configuration.sourceRevision, async diagnostic => {
    await appendFile(resolve(evidenceRoot, 'voice-failures.jsonl'), JSON.stringify({sourceRevision:configuration.sourceRevision,
      instanceId:runtime.instanceId, ...diagnostic}) + '\n', {mode:0o600});
  }, effectiveRole.configRevision);
  const lockPath = resolve(evidenceRoot, '../backend.lock');
  let lock: import('node:fs/promises').FileHandle;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (lockError) {
    if ((lockError as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const rawLock = await readFile(lockPath, 'utf8');
        const parsed = JSON.parse(rawLock);
        if (typeof parsed?.pid === 'number') {
          try {
            process.kill(parsed.pid, 0);
            throw Error('Another backend instance is currently running.');
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === 'ESRCH') {
              await unlink(lockPath).catch(() => {});
              lock = await open(lockPath, 'wx', 0o600);
            } else throw killError;
          }
        } else {
          await unlink(lockPath).catch(() => {});
          lock = await open(lockPath, 'wx', 0o600);
        }
      } catch (checkError) {
        throw lockError;
      }
    } else throw lockError;
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, phaseId: configuration.phaseId, sourceRevision: configuration.sourceRevision, startedAt: new Date().toISOString() }) + '\n');
  let session: BackendSession | undefined;
  let wechat: WeChatService | undefined;
  let wake: WakeManager | undefined;
  let managementForget: StrictManagementForget | undefined;
  let memoryImport: SqliteMemoryImportManagement | undefined;
  let desktopWork: import('../contracts/desktop-work.js').DesktopWorkPort | undefined;
  let management: Awaited<ReturnType<typeof startRuntimeManagement>> | undefined;
  let applyStartupAppearance: (() => Promise<void>) | undefined;
  let perceptionManagement: PerceptionManagementRuntime | undefined;
  let companionScreenManagement: ScreenGrantRuntime | undefined;
  let companionTriggerManagement: CompanionTriggerRuntime | undefined;
  // N081-06: declared here so the outer failure path can also stop collection listeners.
  let collectionService: CollectionService | undefined;
  let protocolWork: WorkProtocolRuntime | undefined;
  let liveHost: import('../plugins/host-runtime.js').PackageHost | undefined;
  let next65Runtime: Next65Management | undefined;
  const release = async () => { await lock.close(); await unlink(lockPath); };
  try {
    const authorizer = new TrialAuthorizer(configuration, configFile, activationFile, registeredConfiguration);
    const transport = new TrialTransport(configuration, fetch, runtime, settings.effective.providers.dialogue.temperature);
    // N075-01/R7: adapt the legacy TrialConfiguration onto the frozen ProviderRuntime.
    // Callers requesting endpoint(operation) resolve through ProviderRuntime.resolveBinding.
    const legacyProviderAdapter = new LegacyProviderRuntimeAdapter(
      configuration,
      authorizer,
      ref => keyReader(ref ?? '', registeredConfiguration, configFile, activationFile),
    );
    const endpoint = (operation: TrialOperation): EndpointConfig => legacyProviderAdapter.getEndpointConfig(operation);
    // RWR-08 (F01): the store was already opened before role resolution (the registry owns the running
    // role); a second open here would take a second SQLite connection to the same file.
    const diagnostic = async (value: object) => appendFile(resolve(evidenceRoot, 'events.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
    const evidence = async (event: SemanticAttemptEvent) => {
      if (event.type === 'failure' && configuration.purpose === 'smoke-text') await authorizer.stop('semantic_failure');
      const data = event.data as Record<string, unknown>;
      // Persist trace identity and statuses only; avoid duplicating personal conversation bodies in diagnostics.
      await diagnostic({ type: event.type, provenance: event.provenance, scope: event.scope, elapsedMs: event.elapsedMs,
        digest: createHash('sha256').update(JSON.stringify(event.data)).digest('hex'),
        ...(event.type === 'failure' ? { stage: data.stage, name: data.name, ...(data.transport ? {transport:data.transport} : {}) } : {}),
        ...(event.type === 'compiled' ? { status: (data.compiled as { status: string }).status } : {}) });
      if (configuration.purpose === 'smoke-text' && event.type === 'declaration')
        await diagnostic({ type: 'smoke_memory_declaration', provenance: event.provenance, scope: event.scope, declaration: data.declaration });
      if (configuration.purpose === 'smoke-text' && event.type === 'response') {
        const raw = data.raw as Record<string, unknown>, usage = raw.usage as Record<string, unknown> | undefined;
        await diagnostic({ type: 'smoke_memory_final', provenance: event.provenance, scope: event.scope,
          finalContent: data.content, usage: { prompt_tokens: usage?.prompt_tokens ?? null, completion_tokens: usage?.completion_tokens ?? null,
            total_tokens: usage?.total_tokens ?? null } });
      }
    };
    class ObservedTrialMemory extends SqliteLifecycleMemoryPort {
      private async report(outcome: MemoryTurnOutcome, currentMessageId: string, text: string, signal: AbortSignal) {
        if (outcome.status === 'rejected' && configuration.purpose === 'smoke-text') await authorizer.stop('memory_commit_rejected');
        if (configuration.purpose === 'smoke-text' && outcome.status === 'applied') {
          const context = await this.context(outcome.scope, text, null, signal);
          this.assertContextCurrent(context);
          await diagnostic({ type: 'smoke_postcommit_context', scope: outcome.scope, context,
            purpose: 'Actual post-commit context assembly; not the earlier foreground reply input' });
        }
        await diagnostic({ type: 'memory_outcome', scope: outcome.scope, currentMessageId, outcome });
        return outcome;
      }
      override async prepareTurn(scope: TurnScope, id: string, text: string, signal: AbortSignal) {
        return this.report(await super.prepareTurn(scope, id, text, signal), id, text, signal);
      }
      override async prepareBackgroundTurn(scope: TurnScope, id: string, text: string, signal: AbortSignal) {
        return this.report(await super.prepareBackgroundTurn(scope, id, text, signal), id, text, signal);
      }
    }
    const strictProvider=new StrictTrialMemoryProvider(store, endpoint('memory_turn'), transport, configuration.phaseId, evidence, configuration.models.memory_turn.thinking);
    // FIX61-06: the knowledge library lives in the SAME companion database and reaches the turn only
    // through the context assembly, so switching a library is visible to the next turn immediately.
    const knowledgeStore = await KnowledgeLibraryStore.open(store, resolve(configuration.projectRoot, '.local/data/knowledge'));
    const knowledge = knowledgeManagement(knowledgeStore);
    // RWR-06: authored Lorebook lives in the same database and reaches the turn ONLY through the one
    // bounded Context assembly. It is the character's world setting — never a user fact.
    const lorebookStore = LorebookStore.open(store);
    // N07: continuity tables live beside History/Knowledge in the same companion database. N075-01/R1:
    // both stores are retained as formal runtime dependencies — the pack store feeds the dialogue
    // context composer below, the continuity store feeds both the composer and the management API.
    // Neither instance is dropped after open; they are composition-root dependencies, not side effects.
    const characterPacks = await CharacterPackStore.open(store);
    const continuityStore = await ContinuityMemoryStore.open(store);
    // RWR-08 (F01): ONE startup pairing convention. The running role comes from the registry read at
    // boot; the canonical instance id derives from that role, so companion keeps its historical
    // 'companion-default' namespace and a promoted role-b gets its own ('role-b-default') instead of
    // silently sharing companion's pairing. Every consumer below (candidate writer, continuity
    // resolver, projections, invitations, collection) reads THIS snapshot, never a re-derived one.
    const roleInstanceId = configuration.purpose === 'user-trial' ? `${effectiveRoleId}-default` : 'smoke-default';
    const candidatePairing = productionPairing(effectiveRoleId, roleInstanceId);
    const captureGrantManager = new CaptureGrantManager();
    let cloudObservationEngine: ReturnType<typeof qwenCloudScreenObservation> | undefined;
    try {
      if (configuration.purpose === 'user-trial' && settings.effective.providers.perception?.credentialRef) {
        cloudObservationEngine = qwenCloudScreenObservation(transport, endpoint('perception'));
      }
    } catch { /* The authenticated route remains unavailable without a registered provider binding. */ }
    const windowsOcr = configuration.purpose === 'user-trial'
      ? await createWindowsMediaOcrEngine({ paths: windowsMediaOcrHelperPaths(resolveHelperPackageRoot(configuration.projectRoot)) })
      : undefined;
    const localOcr = windowsOcr?.recognize ?? createLocalOcrEngine();
    const screenPerception = new ScreenPerceptionService(captureGrantManager, {
      localOcrEngine: localOcr,
      ...(cloudObservationEngine ? { cloudVlmEngine: cloudObservationEngine } : {})
    });
    const observationContext = new ObservationContextAdapter(screenPerception);
    const observationInbox = new ObservationTurnInbox(screenPerception, observationContext);
    perceptionManagement = configuration.purpose === 'user-trial'
      ? new PerceptionManagementRuntime(captureGrantManager, screenPerception, observationInbox, candidatePairing,
        runtime.instanceId, { local: windowsOcr?.available ?? false, cloud: !!cloudObservationEngine }) : undefined;
    // --- N081-06: controlled collection composition root -----------------------------------------
    // Only a real product launch wires a collection service. A preview script or a fixture run must
    // never carry this, so the whole block is fenced behind the same user-trial purpose.
    let collectionManagement: CollectionManagement | undefined;
    let collectionGrants: CollectionGrantManager | undefined;
    let companionModeRuntime: CompanionModeRuntime | undefined;
    let batchRunner: CollectionBatchRunner | undefined;
    let observationScheduler: ObservationScheduler | undefined;
    let screenCaptureSource: ScreenCaptureSource | undefined;
    // CK-11: the real capture capability, computed from whether a desktop host bridge exists.
    let captureWired: { available: boolean; reason: string | null; detail: string | null } | undefined;
    // CK-04/CK-12: deterministic owners, constructed inside the trial wiring block.
    let activityUnderstanding: ActivityUnderstanding | undefined;
    let activitySummary: DailyActivitySummary | undefined;
    let wikiCompiler: WikiCompiler | undefined;
    let deliveryCoordinator: LocalDeliveryCoordinator | undefined;
    // CK-02: the workspace source is constructed here so the console gets a real adapter rather
    // than an "unavailable" placeholder. Opening a watcher still requires an explicit grant.
    let workspaceSource: WorkspaceDirectorySource | undefined;
    // CK-03: production owner for manual / clipboard / input / history text sources.
    let textSourceService: TextSourceService | undefined;
    if (configuration.purpose === 'user-trial') {
      // The `smoke` profile is only ever selected explicitly at launch and never inherited by the
      // normal product entry; `loadCollectionPolicy` additionally refuses a shared data root.
      const collectionProfile = process.env.Aika_COLLECTION_PROFILE === 'smoke' ? 'smoke' : 'normal';
      const collectionDataRoot = process.env.Aika_COLLECTION_DATA_ROOT
        ?? resolve(configuration.projectRoot, '..', '.local', 'data');
      try {
        const collectionPolicy = loadCollectionPolicy(collectionProfile, collectionDataRoot,
          collectionProfile === 'smoke' ? resolve(configuration.projectRoot, '..', '.local', 'data') : undefined);
        const collectionStore = await CollectionStore.open(store, {
          collectionDirectory: resolve(collectionDataRoot, 'collection'),
          policy: collectionPolicy,
          probeImage: probeImageDimensions,
        });
        const grants = new CollectionGrantManager({ store: collectionStore, policy: collectionPolicy });
        collectionGrants = grants;
        const helperPaths = {
          // The trial configuration's projectRoot is the WORKSPACE, but the helper builds into the
          // desktop-pet package's dist/. Resolving from the workspace would look in windows/dist.
          ...collectionHelperPaths(resolveHelperPackageRoot(configuration.projectRoot)),
          ...(process.env.Aika_COLLECTION_STAGING_ROOT ? { stagingRoot: process.env.Aika_COLLECTION_STAGING_ROOT } : {}),
        };
        // A crashed helper can leave staged files behind; sweep them before wiring the client.
        sweepStaleStaging(helperPaths.stagingRoot);
        const helperAvailable = loadCollectionHelperManifest(helperPaths) !== null;
        const helper = helperAvailable
          ? new CollectionHelperClient({
            paths: helperPaths,
            instanceId: runtime.instanceId,
            // The routing closure reads the manager variable, so declaration order does not matter.
            onEvent: event => routeCollectionEvent(event),
          })
          : undefined;
        const screenshotDirectory = new ScreenshotDirectorySource({
          fileStableIntervalMs: collectionPolicy.fileStableIntervalMs,
          maxImageBytes: collectionPolicy.maxImageBytes,
          maxImagePixels: collectionPolicy.maxImagePixels,
          probeImage: probeImageDimensions,
        });
        collectionService = new CollectionService({
          grants, store: collectionStore, pairing: candidatePairing, instanceId: runtime.instanceId,
          ...(helper ? { helper } : {}),
          screenshotDirectory,
        });
        collectionManagement = new CollectionManagement({
          service: collectionService, grants, store: collectionStore, pairing: candidatePairing,
          // P1-1: A source is started or stopped independently without affecting other sources.
          // CK-03: only the three continuous-capture kinds have an OS listener here. Text sources
          // are driven by their own service; routing them at `startSource` would throw, so the
          // boundary is explicit rather than an implicit cast.
          syncSource: async (kind, active) => {
            if (!isContinuousCaptureKind(kind)) return;
            if (active) await collectionService!.startSource(kind);
            else await collectionService!.stopSource(kind);
          },
        });
        // P1-2: Restore listeners for any active, unexpired sources after startup/restart.
        for (const kind of ['keyboard', 'screenshot_directory', 'clipboard_image'] as const) {
          const current = grants.current(candidatePairing, kind);
          if (current && current.state === 'active') {
            if (Date.parse(current.expiresAt) > Date.now()) {
              void collectionService.startSource(kind).catch(() => undefined);
            }
          }
        }
        // N082-08: companion mode runtime, batch runner, and observation scheduler
        companionModeRuntime = new CompanionModeRuntime({
          db: store.rawDatabaseForKnowledge(),
          pairing: candidatePairing,
          onContextUseGrantChange: () => companionTriggerManagement?.cancelAll('context_use_changed'),
          onAutomationPreferencesChange: async () => {
            await observationScheduler?.cancel();
            await companionTriggerManagement?.cancelAll('preferences_changed');
          },
          onSourceSync: async (kind, active) => {
            if (active) await collectionService!.startSource(kind as any);
            else await collectionService!.stopSource(kind as any);
          },
        });
        batchRunner = new CollectionBatchRunner({
          db: store.rawDatabaseForKnowledge(),
          store: collectionStore,
          pairing: candidatePairing,
          parser: new DocumentParser(),
          // CK-01: the reader is wired here, from the real store. HTTP callers can never
          // inject a read function or a filesystem path.
          reader: new CollectionSourceReader(collectionStore),
        });
        workspaceSource = new WorkspaceDirectorySource();
        // The adapter exists but stays idle: it opens nothing until a workspace grant names a root,
        // so construction alone never widens what this process can read.
        runtime.observeModuleState('collection', 'ready',
          '工作区增量来源已装配；需在控制台显式选择目录、扩展名与是否递归后才启用。');
        // CK-11: the production capture route. The hook is only attached when a desktop host
        // bridge is actually present; without one the source reports `capture_unavailable`
        // honestly rather than pretending a screen path exists.
        const hostBridge = session?.hostBridge;
        const windowsCapture = new WindowsScreenCapture({
          ...(hostBridge === undefined ? {} : { bridge: hostBridge }),
        });
        screenCaptureSource = new ScreenCaptureSource({
          ...(hostBridge === undefined ? {} : { captureHook: windowsCapture.hook() }),
        });
        // CK-11: the capability bit follows the real wiring, not a hard-coded false.
        captureWired = captureAvailability({ ...(hostBridge === undefined ? {} : { bridge: hostBridge }) });
        const nativeOcr = localOcr;
        observationScheduler = new ObservationScheduler({
          pairing: candidatePairing,
          captureSource: screenCaptureSource,
          ocrEngine: nativeOcr,
        });

        // CK-03: the text adapters now have a real owner. Adapters without a native route are
        // still constructed so the console can report an honest reason instead of "not wired";
        // `commits` is deliberately absent here because this build ships no verified commit route,
        // and inventing one would be worse than reporting `input_commit_route_unavailable`.
        textSourceService = new TextSourceService({
          store: collectionStore,
          grants,
          pairing: candidatePairing,
          clipboard: new ClipboardTextSource({
            // Reads nothing until a clipboard grant is active and the helper reports a sequence.
            currentSequence: () => Number(process.env.Aika_CLIPBOARD_SEQUENCE ?? '0'),
            readClipboardText: async () => null,
          }),
          input: new InputTextSource(),
          history: new HistorySourceReference(store.rawDatabaseForKnowledge()),
        });

        // CK-04: the deterministic activity/summary owners. They are model-free by construction, so
        // wiring them here cannot spend budget or call a provider.
        activityUnderstanding = new ActivityUnderstanding();
        activitySummary = new DailyActivitySummary();
        wikiCompiler = new WikiCompiler({ continuity: continuityStore });

        // CK-12: the public local-delivery owner. It needs no screen and no model, which is what
        // lets a greeting survive a build with `capture:false`.
        const deliveryOperations = new Map<string, { signature: string; triggerId: string }>();
        const automaticDeliveries: string[] = [];
        deliveryCoordinator = new LocalDeliveryCoordinator({
          ledger: {
            async countAutomatic(input) {
              const key = `${input.pairingKey}|${input.ruleId}|${input.localDate}`;
              if (automaticDeliveries.includes(key)) return false;
              automaticDeliveries.push(key);
              return true;
            },
            readOperation(input) { return deliveryOperations.get(`${input.pairingKey}|${input.operationId}`) ?? null; },
            writeOperation(input) { deliveryOperations.set(`${input.pairingKey}|${input.operationId}`, { signature: input.signature, triggerId: input.triggerId }); },
          },
          now: () => Date.now(),
        });

        // The console reads the true wiring, so an absent helper reports unavailable rather than healthy.
        runtime.observeModuleState('collection', helperAvailable ? 'ready' : 'unknown',
          helperAvailable
            ? `本地采集已接线（${collectionProfile} 档）；默认关闭，需在控制台为每个来源选择范围并启用。`
            : '本地采集存储与授权已就绪，但采集 helper 未构建；来源将显示为不可用，基础对话不受影响。');
      } catch {
        // A collection failure must never stop companion chat.
        process.stderr.write('Local collection unavailable; companion chat continues.\n');
      }
    }
    /**
     * N081-06: dispatch one helper event to the service that owns its grant.
     * The grant is re-read here so a late event can never be written under a superseded revision.
     */
    function routeCollectionEvent(event: { op: string; kind: string; grantRevision: number; payload: Record<string, unknown> }): void {
      const service = collectionService;
      const grants = collectionGrants;
      if (!service || !grants) return;
      if (event.kind === 'keyboard' && event.op === 'activity') {
        const grant = grants.current(candidatePairing, 'keyboard');
        if (!grant) return;
        void service.onKeyboardActivity({
          grantId: grant.grantId, grantRevision: event.grantRevision || grant.revision,
          bucketStart: String(event.payload.bucketStart ?? ''),
          bucketEnd: String(event.payload.bucketEnd ?? ''),
          activityCount: Number(event.payload.activityCount ?? 0),
          foregroundAppId: event.payload.foregroundAppId === null || event.payload.foregroundAppId === undefined
            ? null : String(event.payload.foregroundAppId),
          afkBoundary: event.payload.afkBoundary === true,
        });
        return;
      }
      if (event.kind === 'clipboard_image' && event.op === 'clipboard_seq') {
        const grant = grants.current(candidatePairing, 'clipboard_image');
        if (!grant) return;
        void service.onClipboardChange({
          grantId: grant.grantId, grantRevision: event.grantRevision || grant.revision,
          clipboardSequence: Number(event.payload.clipboardSequence ?? 0),
          observedAt: String(event.payload.observedAt ?? new Date().toISOString()),
        });
        return;
      }
      if (event.kind === 'system' && event.op === 'session_locked') {
        void grants.suspendAll('session_locked', candidatePairing);
        return;
      }
    }
    const unifiedTimeline = new UnifiedTimelineService(store.rawDatabaseForKnowledge(), characterPacks);
    const companionEventHub = new CompanionEventHub();
    let timelineDispatchError: unknown;
    companionEventHub.subscribeDomain(['canon', 'companion', 'work'], envelope => {
      try { unifiedTimeline.recordEventSync(envelope); }
      catch (error) { timelineDispatchError = error; throw error; }
    }, candidatePairing);
    // N081-06: collection is an explicit opt-in domain. It is NOT added to the default subscriber
    // above, so an old client's three-domain result set is unchanged; the collection projection is
    // read from the Collection store by the management layer instead.
    companionEventHub.subscribeDomain(['collection'], envelope => {
      try { unifiedTimeline.recordEventSync(envelope); }
      catch (error) { timelineDispatchError = error; throw error; }
    }, candidatePairing);
    const publishUnifiedTimelineEvent = (envelope: import('../contracts/perception.js').CompanionEventEnvelope): void => {
      timelineDispatchError = undefined;
      companionEventHub.publishEnvelope(envelope);
      if (timelineDispatchError !== undefined) throw timelineDispatchError;
    };
    const proactiveInvitations = configuration.purpose === 'user-trial'
      ? new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuityStore, store.invitations, companionEventHub)
      : undefined;
    if (proactiveInvitations) {
      const active = proactiveInvitations.policy(candidatePairing).enabled;
      runtime.observeModuleState('invitations', active ? 'ready' : 'unknown', active
        ? '主动陪伴已启用；来源限策略开启后新确认且证据有效的连续性事实/里程碑，展示受忙闲、勿扰与共享配额仲裁。'
        : '正式候选、持久仲裁与桌面展示已接线；策略默认关闭，可在控制台启用。');
    }
    const conversationCandidates = configuration.purpose === 'user-trial'
      ? new ConversationCandidateWriter(store, continuityStore, characterId => productionPairing(characterId, `${characterId}-default`))
      : undefined;
    if (conversationCandidates) {
      conversationCandidates.initialize(candidatePairing);
      conversationCandidates.recover(candidatePairing);
    }
    const syncProactiveInvitations = (pairing: PairingScope) => {
      if (!proactiveInvitations) return;
      const previous = proactiveInvitations.shown(pairing);
      proactiveInvitations.sync(pairing);
      if (previous && !proactiveInvitations.shown(pairing)) session?.withdrawInvitation(previous);
      session?.requestProactiveEvaluation();
    };
    if (proactiveInvitations) proactiveInvitations.sync(candidatePairing);
    const continuity = continuityManagement(continuityStore, syncProactiveInvitations);
    // N075-01/R5: open persistent trace store in the companion SQLite database and wire to both the
    // production turn pipeline and the management server.
    const traceStore = RuntimeTraceStore.open(store.rawDatabaseForKnowledge());
    // N075-01/R2: the continuity context source composes the pack store and the continuity memory
    // store into ONE production dialogue context. It is a read-only projection: no second pipeline,
    // no second store, one dialogue call. A compose failure fails the turn visibly; capability-off
    // (no pairing) keeps the ordinary text path byte-identical.
    const continuityContext = new ProductionContinuityContext({
      packs: characterPacks, memory: continuityStore,
      pairing: productionPairingResolver(roleInstanceId),
      dialogueInputTokenBudget: configuration.models.dialogue.inputTokenLimit,
      // CB-03: unified-document recall metadata (author state / aliases / related). Bodies stay
      // with their real owners (pack wikiFacts + lorebook); this only adds recall signals.
      aiki: new AikiContextStore({ packs: characterPacks, lorebooks: lorebookStore }),
    });
    // The active library is read fresh per turn; the port never caches a selection across a switch.
    // A library read failure must never take the whole conversation store down with it.
    const knowledgeSelection = async () => {
      try { return await knowledgeStore.selection(undefined, candidatePairing.characterId); } catch { return null; }
    };
    const memory = new ObservedTrialMemory(store, {
      context: { knowledge: knowledgeSelection, inputTokenBudget: configuration.models.dialogue.inputTokenLimit, maxRecentMessages: settings.effective.context.maxRecentMessages, maxMemories: settings.effective.context.maxMemories,
        summaryLimit: settings.effective.context.summaryLimit, countTokens: contextInputUpperBound, relevance: () => 1,
        // N075-01/R2: the continuity projection is read fresh per turn, scoped by the production
        // pairing resolver. Character soul, relationship, user soul, user wiki, canon timeline and
        // companion timeline now reach the ONE production DialogueContext.
        continuity: (scope: { readonly characterId: string }) => continuityContext.contextFor(scope.characterId, ''),
        // RWR-06: the authored Lorebook for this turn, keyword-matched on the current text and bounded by
        // the REAL remaining budget. It is fiction the author wrote about the character's world.
        lorebook: (scope: { readonly characterId: string }, currentText: string, remaining: number) => lorebookStore.select(scope.characterId, currentText, remaining),
        // RWR-06: the role's author metadata (scenario / example dialogue) that may inform the character
        // prompt. `firstMessage` is presentation-only and is deliberately NOT projected here.
        roleAuthor: (scope: { readonly characterId: string }) => {
          const configuration = roleStore.get(scope.characterId);
          if (!configuration) return null;
          const { persona } = configuration;
          if (!persona.scenario && !persona.exampleDialogue) return null;
          return {
            ...(persona.scenario === undefined ? {} : { scenario: persona.scenario }),
            ...(persona.exampleDialogue === undefined ? {} : { exampleDialogue: persona.exampleDialogue }),
            fieldRevision: configuration.fieldRevision ?? 0,
          };
        },
        // RP75-02: synchronous continuity validation in assertContextCurrent against live mutations
        assertContinuityCurrent: (result: import('../contracts/continuity-context.js').ContinuityContextResult) => continuityContext.assertCurrent(result) },
      turn: { inputTokenBudget: configuration.models.memory_turn.inputTokenLimit,
        countTokens: input => buildMemorySemanticFormat(input,true).inputUpperBound, maxSupplementaryPlans: 1,
        provider: strictProvider },
      summary: { inputTokenBudget: configuration.models.summary.inputTokenLimit, minMessages: settings.effective.context.summaryMinMessages, maxMessages: settings.effective.context.summaryMaxMessages,
        countTokens: summaryInputUpperBound, provider: new JsonSummaryProvider(endpoint('summary'), transport) },
    });
    const pendingCompanionProjections: Array<{
      readonly pairing: PairingScope;
      readonly sessionId: string;
      readonly turnId: string;
      readonly createdAt: string;
    }> = [];

    const drainCompanionProjection = () => {
      if (pendingCompanionProjections.length > 0) {
        const toRetry = [...pendingCompanionProjections];
        pendingCompanionProjections.length = 0;
        for (const item of toRetry) {
          try {
            characterPacks.stageCompanionProjection(item);
          } catch {
            pendingCompanionProjections.push(item);
          }
        }
      }
      return characterPacks.projectPendingCompanionEvents((scope, messageId) => {
        const historyScope = { ...scope, generation: 0 } as TurnScope;
        const record = store!.inspect(historyScope, messageId);
        return record ? { state: record.state, role: record.message?.role, text: record.message?.text } : null;
      }, publishUnifiedTimelineEvent);
    };
    // Recover turns staged immediately before a previous process exited.
    drainCompanionProjection();
    if(configuration.purpose==='user-trial' && typeof (memory as import('../contracts/memory-lifecycle.js').BackgroundMemoryPort).beginPendingMutation!=='function')throw Error('Background privacy capability is required');
    const mediaStore = new MemoryMediaStore();
    const admission = new TrialAdmission(endpoint('admission'), transport,
      (scope, text, signal) => configuration.purpose==='user-trial' ? memory.foregroundContext(scope,`${scope.turnId}:user`,text,null,signal) : memory.context(scope, text, null, signal), async value => {
        if (value.rejected && configuration.purpose === 'smoke-text') await authorizer.stop('admission_rejected');
        await diagnostic({ type: 'admission', ...value });
      },
      context => memory.assertContextCurrent(context), async event => {
        if (configuration.purpose === 'smoke-text') await diagnostic({ ...event, phaseId: configuration.phaseId });
      });
    const presentation = await PresentationSettingsStore.open(resolve(configuration.projectRoot, '.local/data/presentation-settings.json'),
      await readPresentationCatalog(configuration.projectRoot), policy => process.stdout.write(JSON.stringify({ channel: 'presentation_policy', policy }) + '\n'));
    const streamingModels = streamingAsrConfiguration();
    const sessionPorts: BackendPorts = { memory, backgroundMemory: memory, mediaStore,
      onConversationSaved: scope => {
        // RWR-08 (F01): the projection uses the SAME startup pairing convention, not a re-derived
        // companion pairing (the review's third hardcoded site).
        const pairing = candidatePairing;
        const projectionItem = {
          pairing,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          createdAt: new Date().toISOString(),
        };
        try {
          characterPacks.stageCompanionProjection(projectionItem);
        } catch (error) {
          /* Staging failure is recoverable and must not undo a delivered reply. */
          pendingCompanionProjections.push(projectionItem);
          void diagnostic({
            type: 'companion_projection_error',
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {});
        }
        try {
          conversationCandidates?.afterConversationSaved(scope);
        } catch (error) {
          /* Candidate persistence is recoverable from its ID-only outbox and never delays the reply. */
          void diagnostic({
            type: 'conversation_candidate_error',
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {});
        }
      },
      // Invitation clicks are consumed by the existing durable store; the returned command goes
      // through DesktopRuntime so the explicit click, turn scope and microphone gate stay singular.
      acceptInvitation: invitationId => {
        const proactiveAccepted = proactiveInvitations?.accept(candidatePairing, invitationId);
        if (proactiveAccepted) return { type: 'submit_text' as const, text: proactiveAccepted.text };
        const accepted = store!.invitations.clickForCharacter(candidatePairing.characterId, invitationId);
        if (!accepted) return null;
        const occurredAt = new Date().toISOString();
        companionEventHub.publishEnvelope({
          eventId: `invitation-accepted-${accepted.invitationId}`,
          schemaVersion: 1,
          domain: 'companion',
          type: 'companion.invitation.accepted',
          pairing: candidatePairing,
          sourceRef: { id: accepted.eventId, version: accepted.sourceVersion },
          occurredAt,
          receivedAt: occurredAt,
          payload: { invitationId: accepted.invitationId, actionKind: accepted.type, status: 'accepted' },
          summary: '接受了一条主动陪伴邀请',
        });
        return { type: 'start_voice' as const };
      },
      ignoreInvitation: invitationId => {
        const proactiveDismissed = proactiveInvitations?.ignore(candidatePairing, invitationId);
        if (proactiveDismissed) return true;
        const dismissed = store!.invitations.ignoreForCharacter(candidatePairing.characterId, invitationId);
        if (!dismissed) return false;
        const occurredAt = new Date().toISOString();
        companionEventHub.publishEnvelope({
          eventId: `invitation-dismissed-${dismissed.invitationId}`,
          schemaVersion: 1,
          domain: 'companion',
          type: 'companion.invitation.dismissed',
          pairing: candidatePairing,
          sourceRef: { id: dismissed.eventId, version: dismissed.sourceVersion },
          occurredAt,
          receivedAt: occurredAt,
          payload: { invitationId: dismissed.invitationId, actionKind: 'start_voice', status: 'dismissed' },
          summary: '暂不接受这条主动陪伴邀请',
        });
        return true;
      },
      onConversationIdle: () => {
        try {
          const result = drainCompanionProjection();
          if (result.pending > 0) void diagnostic({ type: 'companion_projection_pending', pending: result.pending }).catch(() => {});
        } catch (error) {
          void diagnostic({ type: 'companion_projection_error', error: error instanceof Error ? error.message : String(error) }).catch(() => {});
        }
      },
      onProactiveOpportunity: busy => {
        if (!proactiveInvitations || store!.invitations.shownForCharacter(candidatePairing.characterId)) return;
        const invitation = proactiveInvitations.showNext(candidatePairing, busy);
        if (invitation) session?.presentInvitation(invitation);
      },
      createEmotion:()=>new EmotionTurns(store!.emotion,store!),
      consumeWakeHit: hit => wake?.consumeHit(hit),
      companionProfile: store,
      ...(configuration.purpose==='user-trial' ? {classifyMemoryRequest:admission.foregroundRequest.bind(admission)} : {isMemoryIndependent:admission.isIndependent.bind(admission)}),
      dialogue: new FlowAwareDialogueProvider(new ObservationAwareDialogueProvider(
        new JsonDialogueProvider(endpoint('dialogue'), transport, () => presentation.allowedIntent()), observationInbox, candidatePairing,
        projection => {
          const grant = companionModeRuntime?.getContextUseGrant();
          const source = projection.targetId ? `screen:${projection.targetId}` : '';
          return !!grant && grant.state === 'active' && Date.parse(grant.expiry) > Date.now()
            && grant.modelBinding === `${settings.effective.providers.dialogue.provider}:${settings.effective.providers.dialogue.model}`
            && (!!source && grant.observationSourceScopes.some(scope => scope === source || scope === 'screen:*'));
        }), {
        runActiveConversationFlow: (scope, query, signal) => next65Runtime?.runActiveConversationFlow(scope, query, signal) ?? Promise.resolve(null),
      }),
      perception: configuration.models.asr
        ? new SplitPerceptionProvider(new QwenAsrProvider(endpoint('asr'), mediaStore, transport),
          new QwenVisualEmotionProvider(endpoint('perception'), mediaStore, transport), { visualTimeoutMs: 1500 })
        : new QwenPerceptionProvider({ ...endpoint('perception'), cueLifetimeMs: 5 * 60_000 }, mediaStore, transport),
      tts: createTrialTtsProvider(effectiveRole.capabilities.tts, endpoint('tts'), mediaStore, transport, voices),
      // FIX61-08: the local streaming recognizer is optional. When its model package is configured the
      // voice turn streams partials and commits the verified transcript; otherwise the batch ASR above
      // still transcribes the whole clip after release.
      ...(streamingModels ? { createStreamingAsr: () => new SherpaStreamingAsr(streamingModels) } : {}),
      // N075-01/R5: real production trace store wired to dialogue pipeline and memory lifecycle queue
      traceStore,
      onCompanionTriggerFinished: (input, status, reason) => companionTriggerManagement?.turnFinished(input, status, reason),
      onCompanionReplyDisplayed: (triggerId, scope) => companionTriggerManagement?.replyDisplayed(triggerId, scope),
    };
    const playgroundPort = new ProductionPlaygroundPort({
      sendCommand: command => session!.receiveLine(JSON.stringify({ channel: 'command', command })),
      cancelCurrent: () => session!.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'cancel' } })),
      pairing: candidatePairing,
      // RUX-01: the Playground reports the RUNNING ROLE's applied configuration revision, not the
      // global settings projection. The role configuration is what `applyRoleConfigurationToTrial`
      // actually consumed, so this is the number a "did my save take effect?" check must compare
      // against the saved revision shown in the model panel.
      getConfigRevision: () => effectiveRole.configRevision,
      hasStt: () => !!streamingModels || !!configuration.models.asr,
      hasTts: () => !!settings.effective.providers.tts?.voice,
      traceStore,
      isBusy: () => session ? session.pendingMemoryJobs().some(x => x.queued + x.running > 0) : false,
    });
    session = new BackendSession(sessionPorts, message => {
      runtime.observeDesktop(message);
      playgroundPort.observeDesktopMessage(message);
      if (message.channel === 'event' && message.event.type === 'error' && configuration.purpose === 'smoke-text') void authorizer.stop('backend_error').catch(() => {});
      process.stdout.write(JSON.stringify(message) + '\n');
    }, () => store!.close(), (scope, kind) => {
      runtime.record(kind === 'summary' ? 'summary' : 'memory_turn', 'failed', scope.characterId, '后台维护未完成；未记录对话正文。');
      if (configuration.purpose === 'smoke-text') void authorizer.stop(`${kind}_failure`).catch(() => {});
      void diagnostic({ type: 'background_failure', scope, kind }).catch(() => {});
    }, effectiveRoleId);
    process.stdout.write(JSON.stringify({ channel: 'presentation_policy', policy: presentation.snapshot() }) + '\n');
    const shownInvitation = store!.invitations.shownForCharacter(candidatePairing.characterId)
      ?? proactiveInvitations?.shown(candidatePairing);
    if (shownInvitation) session.presentInvitation(shownInvitation);
    emitStartup('initializing', 3);
    runtime.observeMemoryQueue(() => session!.pendingMemoryJobs());
    if (configuration.purpose === 'user-trial') {
      try {
        const channelStore=new WeChatStore(resolve(configuration.projectRoot,'.local/data/wechat/channel.sqlite'));
        const voiceMedia=new MemoryMediaStore();
        const replyMedia=new MemoryMediaStore(),channelApi=new WeChatApi();
        const replyTts=createTrialTtsProvider(effectiveRole.capabilities.tts,endpoint('tts'),replyMedia,transport,voices);
        wechat=new WeChatService(channelStore,channelApi,async(key,send)=>{
          if(!management)throw Error('Management not ready');
          const workChannel=management.createWorkChannel(resolve(configuration.projectRoot,'.local/data/wechat/work',key));
          const conversation=new WeChatTextConversation({key,store:channelStore,send,ports:sessionPorts,...workChannel,
            classifier:new WorkIntentClassifier(endpoint('admission'),transport),planner:new WorkPlanner(endpoint('admission'),transport)});
          try{return await conversation.start();}catch(error){await conversation.close();throw error;}
        },{transcribe:wechatTranscriber(voiceMedia,new QwenAsrProvider(endpoint('asr'),voiceMedia,transport)),
          sendVoice:wechatAudioFileSender(replyMedia,replyTts,channelApi)});
      } catch { process.stderr.write('WeChat channel storage unavailable; companion data unchanged.\n'); }
      const wakeModels=resolve(configuration.projectRoot,'.local/data/wake-models');
      let wakeAvailable=false;
      try { const {verifyWakeModels}=await import('../media/wake/models.js');await verifyWakeModels(wakeModels);wakeAvailable=true; } catch { /* Off until a verified model package is installed. */ }
      try { wake=await WakeManager.open({instanceId:runtime.instanceId,file:resolve(configuration.projectRoot,'.local/data/wake-settings.json'),available:wakeAvailable,
        createDetector:async settings=>{const {openWakeDetector}=await import('../media/wake/detector.js');return openWakeDetector({modelDirectory:wakeModels,settings});},
        send:message=>process.stdout.write(JSON.stringify(message)+'\n')});
      } catch { process.stderr.write('Local wake settings unavailable; existing settings preserved.\n'); }
      managementForget=new StrictManagementForget(store,store.lifecycle,{inputTokenBudget:configuration.models.memory_turn.inputTokenLimit,
        countTokens:input=>buildMemorySemanticFormat(input,true).inputUpperBound+1024},
        (input,signal,action)=>strictProvider.planManagement(input,signal,{id:action.id,version:action.expectedVersion}));
      const importConfiguration = memoryImportConfiguration(configuration);
      try { memoryImport = new SqliteMemoryImportManagement({
        filename: resolve(configuration.projectRoot,'.local/data/memory-import.sqlite'),
        codexHome: resolve(process.env.CODEX_HOME || resolve(homedir(),'.codex')), instanceId: runtime.instanceId, store,
        configuration: importConfiguration,
        countTokens: historicalMemoryInputBytes,
        processor: { async plan(input,signal,settle) {
          const importEndpoint = observedImportEndpoint(endpoint('memory_turn'),configuration.models.memory_turn,settle);
          const provider = new StrictTrialMemoryProvider(store!,importEndpoint,
            new HistoricalMemoryTransport(transport,importConfiguration),configuration.phaseId,
            async () => {}, configuration.models.memory_turn.thinking);
          return provider.plan(input,signal);
        } },
      });
      } catch { process.stderr.write('Historical memory import unavailable; companion chat remains available.\n'); }
      const aikaProfile = await AikaProfileStore.open(resolve(configuration.projectRoot, '.local/data/aika-profile.json'));
      const aikaTimeline = await AikaTimelineStore.open(resolve(configuration.projectRoot, '.local/data/aika-timeline.sqlite'));
      // FIX61-11: the skin registry is opened over the real pack directories so 换肤 is reachable from the
      // console. A registry failure must never take the console down: the section then reports unavailable.
      // The built-in rig stays bound to desktop/assets/local-model, the same directory tools/configure-model
      // validates, so the skin path never becomes a second configuration authority.
      let skins: SkinStore | undefined;
      try { skins = await SkinStore.open(resolve(configuration.projectRoot, '.local/data/skins.json'),
        resolve(configuration.projectRoot, '.local/data/skin-packs'), resolve(configuration.projectRoot, 'code/desktop-pet/desktop')); }
      catch (error) { process.stderr.write(`Skin registry unavailable: ${error instanceof Error ? error.message : String(error)}\n`); }
      if (skins) {
        skins.onActivate = async (manifest, routes) => {
          const previousId = skins!.state().activeSkinId;
          await session!.applyAppearance(manifest, routes);
          try {
            if (roleStore.get(effectiveRoleId)?.appearance.resourceId !== manifest.skinId) await roleStore.saveAppearance(effectiveRoleId, { resourceId: manifest.skinId, type: manifest.type || 'live2d' });
          } catch (error) { await session!.applyAppearance(skins!.manifest(previousId), skins!.routes(previousId)); throw error; }
        };
        // A device reply cannot be consumed until the stdin listener below is installed.
        // Waiting here deadlocks every startup appearance until the 60-second control timeout.
        const appearanceStore = skins;
        applyStartupAppearance = async () => {
          const savedSkin = roleStore.get(effectiveRoleId)?.appearance.resourceId;
          if (savedSkin && savedSkin !== 'builtin' && savedSkin !== appearanceStore.state().activeSkinId) {
            try { await appearanceStore.activate(appearanceStore.state().revision, savedSkin); } catch (error) { process.stderr.write(`Saved appearance failed: ${String(error)}\n`); }
          } else {
            try { await appearanceStore.onActivate!(appearanceStore.manifest(appearanceStore.state().activeSkinId), appearanceStore.routes(appearanceStore.state().activeSkinId)); } catch (error) { process.stderr.write(`Appearance failed: ${String(error)}\n`); }
          }
        };
      }
      const next65HostRoot = resolve(configuration.projectRoot, '.local/next65-host');
      await mkdir(next65HostRoot, { recursive: true });
      try {
        const { createPackageHost } = await import('../plugins/host-runtime.js');
        const { secretStore } = await import('../plugins/secret-store.js');
        liveHost = createPackageHost({
          hostRoot: next65HostRoot,
          secrets: secretStore(configuration),
        });
      } catch { /* Host stays unavailable if creation fails */ }
      next65Runtime = new Next65Management({
        hostRoot: next65HostRoot,
        host: liveHost,
        providerRuntime: legacyProviderAdapter.runtime,
      });

      if (configuration.purpose === 'user-trial') try {
        protocolWork = await WorkProtocolRuntime.open({ profileFile: resolve(configuration.projectRoot, '.local/data/work-protocol-profiles.json'),
          journalFile: resolve(configuration.projectRoot, '.local/data/work-protocol.sqlite'), eventHub: companionEventHub,
          pairing: candidatePairing, characterPacks });
      } catch { process.stderr.write('ACP/MCP work protocol unavailable; native work and companion chat remain available.\n'); }

      // The console reads and writes the same profile the composition root applies; nothing is duplicated.
      companionScreenManagement = configuration.purpose === 'user-trial'
        ? new ScreenGrantRuntime({
          bridge: session?.hostBridge,
          grants: captureGrantManager,
          ...(screenCaptureSource ? { captureSource: screenCaptureSource } : {}),
          ...(observationScheduler ? { scheduler: observationScheduler } : {}),
          ...(companionModeRuntime ? { companionMode: companionModeRuntime } : {}),
          pairing: candidatePairing,
          runtimeSessionId: runtime.instanceId,
          // CK-11: `capture` now follows the real wiring instead of a hard-coded false. It stays
          // false whenever no desktop host bridge is present, which is the honest answer for a
          // build without a screen path. OCR is healthy only after the Windows helper passes
          // manifest/probe checks; cloudVlm requires an explicitly configured observation engine.
          capabilities: {
            capture: captureWired?.available ?? false,
            localOcr: windowsOcr?.available ?? false,
            cloudVlm: !!cloudObservationEngine,
          },
        })
        : undefined;
      if (companionModeRuntime && companionScreenManagement && session) {
        companionScreenManagement.setOnGrantsInvalidated(() => companionTriggerManagement?.cancelAll('grant_revoked'));
         companionTriggerManagement = new CompanionTriggerRuntime({
          pairing: candidatePairing, mode: companionModeRuntime, screenGrants: companionScreenManagement, perception: screenPerception,
          session: {
            identity: () => session!.companionIdentity(),
            readiness: () => session!.companionTriggerReadiness(),
            dispatch: (triggerId, observationId) => session!.dispatchCompanionTrigger(triggerId, observationId),
            cancel: triggerId => session!.cancelCompanionTrigger(triggerId),
          },
          requiresContextUseGrant: true,
          dialogueModelBinding: `${settings.effective.providers.dialogue.provider}:${settings.effective.providers.dialogue.model}`,
          onState: record => session?.publishCompanionTriggerState(record),
        });
      }
      management = await startRuntimeManagement(registeredConfiguration, configFile, settings, runtime,
        withStrictManagementForget(new SqliteManagementMemoryPort(store,memory),managementForget),presentation,
        pendingMemoryManagement(runtime.instanceId,memory,(scope,id)=>{const source=store!.inspect(scope,id);return source?.state==='active'&&source.message?.role==='user'?{text:source.text,createdAt:source.message.createdAt}:undefined;},
          (scope,id,text)=>session!.retryPendingMemory(scope,id,text),()=>session!.pendingMemoryJobs().some(x=>x.queued+x.running>0)),wechat,wake,memoryImport,store.emotion,
        { store: aikaProfile, timeline: aikaTimeline }, knowledge,
        // The preference is per-machine app data; the console only reads and writes it.
        continuity,
        // RWR-06: the authored Lorebook store, over the same database the turn already reads.
        lorebookStore,
        // RWR-05: read-only local voice capability probe. The Sherpa model directory is derived from the
        // SAME controlled configuration (`streamingAsrConfiguration`) the runtime already uses for the
        // streaming recognizer, so the console can never make the backend read a path the runtime itself
        // would not use. Absent configuration simply reports the capability as unavailable.
        { sherpaDirectory: streamingModels?.encoder ? dirname(streamingModels.encoder) : undefined },
        // RWR-06: the same role configuration store the runtime resolved from, so the console edits the
        // configuration that is actually in effect rather than a second copy.
        roleStore,
        await MicrophonePreferenceStore.open(resolve(configuration.projectRoot, '.local/data/microphone.json')),
        skins,
        traceStore,
        trace => readTraceContentFromHistory(store!, trace),
        next65Runtime,
        { service: unifiedTimeline, pairing: candidatePairing }, protocolWork,
        proactiveInvitations ? proactiveInvitationManagement(proactiveInvitations, (pairing, policy, previouslyShown) => {
          runtime.observeModuleState('invitations', policy.enabled ? 'ready' : 'unknown', policy.enabled
            ? '主动陪伴已启用；来源限策略开启后新确认且证据有效的连续性事实/里程碑，展示受忙闲、勿扰与共享配额仲裁。'
            : '正式候选、持久仲裁与桌面展示已接线；策略默认关闭，可在控制台启用。');
          if (!policy.enabled && previouslyShown) session?.withdrawInvitation(previouslyShown);
          if (policy.enabled) syncProactiveInvitations(pairing);
          session?.requestProactiveEvaluation();
        }) : undefined, perceptionManagement, playgroundPort, collectionManagement,
        companionModeRuntime, batchRunner, observationScheduler,
        // CK-13: the periodic policy layer. It is constructed only when observation is genuinely
        // wired, so `schedulerAvailable` in the preferences view reflects real capability.
        observationScheduler && companionScreenManagement
          ? new CompanionAutomationScheduler({
            now: () => Date.now(),
            // The scheduler observes ONCE. When content is recognised, the completed observation is
            // handed to the internal admission entry, which goes straight to generating. Without
            // this the reply path would capture and recognise a second time (CK-12 GAP-06), doubling
            // both the resource cost and the chance of replying to a different frame.
            observe: async signal => {
              const outcome = await observationScheduler!.tick(signal);
              if (outcome?.status !== 'recognized') return outcome;
              const readiness = companionScreenManagement!.triggerReadiness(candidatePairing);
              const target = readiness.target;
              if (!target || !companionTriggerManagement) return outcome;
              const identity = session?.companionIdentity();
              if (!identity) return outcome;
              await companionTriggerManagement.admitObservation({
                operationId: `auto:${outcome.observation.observationId}`,
                observationId: outcome.observation.observationId,
                targetId: target.targetId,
                targetRevision: target.targetRevision,
                text: outcome.observation.text,
                sourceLease: {
                  grantId: outcome.observation.grantId ?? '',
                  grantRevision: outcome.observation.grantRevision ?? 1,
                },
                scope: { characterId: identity.characterId, sessionId: identity.sessionId, generation: identity.generation },
              }).catch(() => undefined);
              return outcome;
            },
            capabilities: () => {
              const grants = companionScreenManagement!.getGrants(candidatePairing) as { capabilities?: Record<string, boolean> } | undefined;
              return {
                capture: captureWired?.available ?? false,
                route: !!(grants?.capabilities?.localOcr || grants?.capabilities?.cloudVlm),
                grant: !!companionScreenManagement!.triggerReadiness(candidatePairing).grantId,
                authorizer: true,
              };
            },
            busy: () => {
              const readiness = session?.companionTriggerReadiness() ?? { ready: false, reason: 'desktop_unavailable' };
              return { busy: !readiness.ready, ...(readiness.reason ? { reason: readiness.reason } : {}) };
            },
            // CK-13: automatic observations share the invitation ledger that CK-12 also writes.
            reserve: async () => companionModeRuntime !== undefined,
            commitDisplayed: () => {},
          })
          : undefined,
        // RWR-10-01: host preferences live in the Electron process. The console reaches them through this
        // bridge, which rides the same stdio pipe the device channel already uses. RWR-10-04: the same
        // bridge carries the native resource chooser, and its selection tickets are bound to THIS backend
        // instance, so a ticket cannot survive a restart.
        desktopHostManagement(session?.hostBridge, { instanceId: runtime.instanceId, ...(skins ? { skins } : {}) }),
        companionScreenManagement, companionTriggerManagement,
        // CK-09: the companion knowledge console surface. It is passed only when at least one of
        // its owners exists, so the console reports `unavailable` instead of a blank success.
        textSourceService || activityUnderstanding || deliveryCoordinator
          ? {
            textSources: textSourceService,
            workspace: workspaceSource,
            understanding: activityUnderstanding,
            summary: activitySummary,
            wiki: wikiCompiler,
            pairing: candidatePairing,
          }
          : undefined,
        // WV0-01/02: the character Wiki import surface rides the same real Pack owner; role existence
        // comes from the live role configuration store and the pairing follows the ONE startup
        // convention (`<roleId>-default`) — never a client-sent identity.
        characterWikiImportManagement(characterPacks, {
          exists: characterId => roleStore.list().some(entry => entry.characterId === characterId),
          allowsConfiguration: () => true,
          pairingFor: characterId => productionPairing(characterId, `${characterId}-default`),
        }),
        // CB-01: the unified character document surface rides the same real Pack owner; the
        // profile/prompt/lorebook ports are READ-ONLY here (preview baselines only, never writes).
        characterDocumentManagement(characterPacks, {
          exists: characterId => roleStore.list().some(entry => entry.characterId === characterId),
          allowsConfiguration: () => true,
          pairingFor: characterId => productionPairing(characterId, `${characterId}-default`),
        }, {
          profileOf: characterId => {
            const configuration = roleStore.get(characterId);
            if (!configuration) return null;
            return {
              intro: configuration.identity.intro,
              ...(configuration.persona.scenario === undefined ? {} : { scenario: configuration.persona.scenario }),
              ...(configuration.persona.firstMessage === undefined ? {} : { firstMessage: configuration.persona.firstMessage }),
              ...(configuration.persona.exampleDialogue === undefined ? {} : { exampleDialogue: configuration.persona.exampleDialogue }),
              fieldRevision: configuration.fieldRevision ?? 0,
            };
          },
          promptOf: characterId => {
            try {
              const snapshot = store.promptSnapshot({ characterId, sessionId: 'preview', turnId: 'preview', generation: 0 });
              return { revision: snapshot.revision, textHash: createHash('sha256').update(snapshot.text, 'utf8').digest('hex') };
            } catch { return null; }
          },
          lorebookFingerprint: characterId => lorebookFingerprintOf(lorebookStore.list(characterId).map(book => ({ id: book.id, revision: book.revision }))),
        }, {
          // CB-02: the SAME owners the console edits (never a second copy). The memory port is
          // resolved lazily because it is built later in this composition root.
          profiles: roleStore,
          memoryOf: () => new SqliteManagementMemoryPort(store, memory),
          lorebooks: lorebookStore,
        }, {
          // CB-06: export reads the same owners back out (read-only projection).
          packs: characterPacks,
          lorebooks: lorebookStore,
          profiles: roleStore,
          activePackIdOf: characterId => characterPacks.getInstance('local-user', characterId, `${characterId}-default`)?.activePackId ?? null,
          // The registry owns the display name; the role configuration has no label field.
          labelOf: characterId => store.registry.list().find(entry => entry.id === characterId)?.label ?? null,
        }));
    }
    if (configuration.purpose === 'user-trial') {
      const classifier = new WorkIntentClassifier(endpoint('admission'), transport);
      if (management?.tasks && management.projects && management.receipts) {
        const work = new DesktopWork({ receipts: management.receipts, projects: management.projects, forwarding: management.tasks,
          classify: classifier.classify.bind(classifier), interpret: classifier.interpret.bind(classifier),
          plan: (scope,text,catalog,signal)=>new WorkPlanner(endpoint('admission'),transport).plan(scope,text,catalog,signal),
          onReceipt: row => {
            if (!row.confirmedAt) return;
            const status = row.phase === 'completed' || row.nativeStatus === 'completed' ? 'succeeded'
              : row.phase === 'unknown' || row.nativeStatus === 'unknown' ? 'uncertain'
              : row.phase === 'unavailable' || row.nativeStatus === 'failed' ? 'failed'
              : row.phase === 'forwarding' ? 'dispatched'
              : row.phase === 'accepted' ? 'running'
              : undefined;
            if (!status) return;
            const title = row.plan?.title?.trim() || row.target?.title?.trim() || '工程任务';
            const occurredAt = row.confirmedAt || row.createdAt;
            publishUnifiedTimelineEvent({
              eventId: `work-receipt-${row.id}-v${row.version}`,
              schemaVersion: 1,
              domain: 'work',
              type: 'work.task.receipt',
              pairing: candidatePairing,
              turnId: row.appTurnId ?? row.harnessSessionId ?? row.id,
              sourceRef: { id: `work-request:${row.id}`, version: row.version },
              occurredAt,
              receivedAt: new Date().toISOString(),
              payload: { executorId: row.executor ?? 'codex', taskId: row.id, status, title, instruction: '', resultSummary: '' },
              summary: `${title} (${status})`,
            });
          },
          emit: state => process.stdout.write(JSON.stringify({ channel: 'work_state', state }) + '\n'), notify: notice => session!.notifyWork(notice) });
        // Simple chat: the desktop text entry no longer routes input through the task classifier.
        // DesktopWork is kept for receipt observation/timeline only; it is deliberately NOT attached to
        // the session, so `ports.work` stays undefined and every input goes straight to the LLM with its
        // normal recalled context (recent turns, memories, knowledge/Wiki entries, role prompt).
        desktopWork = work; await work.start();
      } else {
        // Failed independent storage must not stop unrelated companion chat or leak engineering input into it.
        let sequence = 0;
        const unavailable = () => process.stdout.write(JSON.stringify({ channel: 'work_state', state: { sequence: ++sequence,
          focus: 'work', stage: 'failed', requests: [], detail: '工作记录暂不可用；这次任务没有保存或发送，陪伴聊天仍可继续。' } }) + '\n');
        desktopWork = { onInput() {}, async route() { return 'companion'; }, async action() { unavailable(); }, async close() {} };
      }
    }
    await wechat?.restore().catch(()=>{process.stderr.write('WeChat restore deferred; use connection page.\n');});
    const cleanupTimer = setInterval(() => { try { store!.cleanup(); } catch { process.stderr.write('Local memory cleanup did not complete\n'); } }, 60_000);
    cleanupTimer.unref();
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let stopping = false;
    const close = async () => {
      if (stopping) return; stopping = true; clearInterval(cleanupTimer); lines.close(); process.stdin.pause();
      managementForget?.close();
     await companionTriggerManagement?.cancelAll('backend_shutdown');
      await companionScreenManagement?.close();
      // Stop collection listeners before the memory store closes, so no late event writes into a
      // closing database. `collectionService.close()` also terminates the helper process.
      try { await collectionService?.close(); } catch { process.stderr.write('Collection shutdown did not complete\n'); }
      try { await wake?.close(); await wechat?.close(); await desktopWork?.close(); await liveHost?.close(); await management?.close(); await managementForget?.drain(); await settings.drain(); await presentation.drain(); }
      finally { try { await session!.close(); } finally { await release(); } }
    };
    let submitted = false;
    lines.on('line', line => {
      if (configuration.purpose === 'smoke-text') {
        try {
          const message = JSON.parse(line);
          if (message.channel === 'command') {
            if (submitted || message.command?.type !== 'submit_text' || message.command.text !== configuration.smokeInput) throw new Error('Unregistered smoke input');
            submitted = true;
          }
        } catch { void authorizer.stop('unregistered_smoke_input').finally(close); return; }
      }
      try { if(wake?.receive(JSON.parse(line)))return; } catch { /* Original protocol validator owns non-wake input. */ }
      void session!.receiveLine(line);
    });
    lines.on('close', () => { void close(); });
    process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
    await applyStartupAppearance?.();
    emitStartup('ready', 4);
  } catch (error) {
    managementForget?.close();
     await companionTriggerManagement?.cancelAll('backend_shutdown');
    perceptionManagement?.close();
    await companionScreenManagement?.close();
    try { await collectionService?.close(); } catch { /* best-effort collection teardown */ }
    await wake?.close(); await wechat?.close(); await liveHost?.close(); await management?.close(); await managementForget?.drain();
    await memoryImport?.close();
    if (session) await session.close(); else store?.close();
    await release(); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startTrialBackend().catch(() => { process.stderr.write('试用后端未启动，请检查已登记的配置与程序版本。\n'); process.exitCode = 1; });
}

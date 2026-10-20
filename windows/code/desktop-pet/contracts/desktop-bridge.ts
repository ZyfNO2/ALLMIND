import type { CompanionIntroduction } from './character.js';
import type { CharacterId, DesktopCommand, DesktopEvent, PlaybackEvent, TtsResult, TurnScope } from './index.js';

/** NDJSON over local child-process stdio, forwarded by the native shell. Never contains credentials. */
export const DESKTOP_BRIDGE_VERSION = '0.8.0' as const;
/** Additive safe diagnostics; arbitrary device/provider messages are never user-facing protocol data. */
export const DEVICE_FAILURE_CODES = ['permission_denied', 'device_unavailable', 'capture_module_failed',
  'capture_start_failed', 'capture_finish_failed', 'device_operation_failed'] as const;
export const DEVICE_FAILURE_STAGES = ['get_user_media', 'audio_worklet', 'audio_resume', 'camera_preview',
  'capture_finish', 'unknown'] as const;
export interface DeviceFailure {
  readonly code: typeof DEVICE_FAILURE_CODES[number];
  readonly stage: typeof DEVICE_FAILURE_STAGES[number];
}
export interface BridgeMedia { readonly id: string; readonly mimeType: string; readonly base64: string }
/** FIX61-08: one live PCM16 mono frame from the authorized capture. At most 200 ms at 16 kHz. */
export interface BridgeVoiceChunk {
  readonly channel: 'voice_chunk';
  /** Echoed from the voice_frame request that asked for this frame. */
  readonly requestId?: string;
  /** The authorized input session this frame belongs to. */
  readonly inputSessionId: string;
  /** Turn generation echoed from the request; a stale generation is refused. */
  readonly generation: number;
  /** Monotonic frame index; a repeat is ignored and a gap is an error, never a silent hole. */
  readonly index: number;
  /** The rate the device actually produced; the receiver resamples when it differs. */
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly pcm: string;
}
// Production capture returns required audio and zero to three actual images.
// Capture readiness and finish never wait for the camera; historical evaluation has its own frame policy.
export type BackendToDesktop =
  | {readonly channel:'book_chat_notice';readonly state:'pending'|'completed'|'failed';readonly scope:import('./memory-book.js').BookScope;readonly text?:string;readonly incognito?:boolean}
  | {readonly channel:'book_reply_style';readonly requestId:string;readonly characterId:string;readonly sessionId:string;readonly decision?:import('./reply-length.js').ReplyStyleDecision;readonly error?:string}
  | {readonly channel:'book_activity';readonly characterId:string;readonly view:import('../core/book-activity.js').ActivityView}
  | {readonly channel:'book_activity_pulse';readonly characterId:string}
  | { readonly channel:'book_erased'; readonly characterId:string; readonly sessionId:string; readonly turnIds:string[] }
  | { readonly channel:'book_privacy'; readonly characterId:string; readonly sessionId:string; readonly incognito:boolean; readonly error?:string }
  | { readonly channel:'book_thinking'; readonly requestId:string; readonly characterId:string; readonly sessionId:string; readonly data?:{level:number;label:string;revision:number;options?:{level:number;label:string}[]}; readonly error?:string }
  | { readonly channel: 'book_turn_state'; readonly attachmentCount?:number; readonly clientRequestId: string; readonly scope: TurnScope; readonly state: 'pending' | 'completed' | 'failed'; readonly text?: string; readonly message?: string;readonly replyLength?:import('./reply-length.js').ReplyLengthResult; readonly replyStyleDecision?:import('./reply-length.js').ReplyStyleDecision }
  | { readonly channel:'companion_takeover'; readonly phase:'prepare' | 'ready' | 'failed' }
  | { readonly channel:'companion_offer'; readonly characterId:string; readonly sessionId:string; readonly id:string }
  | { readonly channel:'companion_message'; readonly characterId:string; readonly sessionId:string; readonly delivery:import('./book-companion.js').CompanionDelivery }
  | { readonly channel: 'companion_state'; readonly sequence: number; readonly state: import('../core/companion-behavior.js').CompanionLifeState; readonly interactionRevision?:number;readonly focus?: boolean; readonly focusTimer?: import('./book-companion.js').CompanionData['focusTimer']; readonly relationship?: {emotion:'happy'|'neutral';intensity:number;until:number} }
  | { readonly channel: 'companion_error'; readonly message: string }
  | { readonly channel: 'appearance'; readonly requestId: string; readonly manifest: import('./skin.js').SkinManifest; readonly routes: readonly (readonly [string, import('./skin.js').SkinRoute])[] }
  | import('./wake.js').WakeToDesktop
  | { readonly channel: 'work_speech'; readonly event: import('./desktop-work.js').WorkSpeechEvent }
  | { readonly channel: 'input_route'; readonly scope: TurnScope; readonly route: 'companion' | 'work' }
  | { readonly channel: 'work_state'; readonly state: import('./desktop-work.js').DesktopWorkState }
  | { readonly channel: 'presentation_policy'; readonly policy: import('./presentation-presets.js').PresentationPolicy }
  | { readonly channel: 'backend_ready'; readonly bridgeVersion: typeof DESKTOP_BRIDGE_VERSION; readonly characterId: CharacterId; readonly characterLabel: string; readonly sessionId: string; readonly introduction?: CompanionIntroduction;
      /** RUX-04: true when this backend will never push an `appearance` (offline preview). The renderer
       * must then dismiss the loading cover for the OFFLINE DEFAULT model instead of waiting forever —
       * but it labels that state as the offline default, never as the selected character. */
      readonly appearanceless?: true;
      /** MB-MVP: text-only product; dormant legacy UI cannot request voice/work capabilities. */
      readonly incognito?:boolean; readonly productMode?: 'memory-book'; readonly replyBudgetMs?: number; readonly backendInstanceId?: string }
  | { readonly channel: 'event'; readonly event: DesktopEvent }
  | { readonly channel: 'capture_start' | 'capture_finish' | 'capture_stop'; readonly requestId: string; readonly scope: TurnScope }
  // FIX61-08: ack-based backpressure for the live leg. One acknowledgement per accepted voice_chunk;
  // once 20 frames are unacknowledged the renderer stops recording and shows the reason.
  | { readonly channel: 'voice_chunk_ack'; readonly inputSessionId: string; readonly generation: number; readonly index: number }
  | { readonly channel: 'play'; readonly requestId: string; readonly tts: TtsResult; readonly audioBase64: string }
  | { readonly channel: 'stop'; readonly requestId: string; readonly scope: TurnScope }
  /**
   * FIX61-08 pull leg: the backend requests exactly the next frame it wants and the renderer answers
   * with a `voice_chunk` carrying that `requestId`. One request in flight keeps the recognizer fed
   * without letting the renderer buffer unbounded audio ahead of it.
   */
  | { readonly channel: 'voice_frame'; readonly requestId: string; readonly inputSessionId: string;
      readonly generation: number; readonly index: number; readonly sampleRate: number; readonly sampleCount: number };
export type DesktopToBackend =
  | {readonly channel:'book_reply_style';readonly requestId:string;readonly characterId:string;readonly sessionId:string;readonly text:string;readonly replyStyle?:import('./reply-length.js').TurnReplyStyle}
  | {readonly channel:'book_activity_control';readonly characterId:string;readonly action:'enable'|'delete'|'view';readonly enabled?:boolean;readonly day?:string}
  | {readonly channel:'book_activity_session';readonly paused:boolean}
  | {readonly channel:'local_pet_complete';readonly characterId:string;readonly pairingId:string;readonly id:string;readonly kind:import('../core/local-pet-action.js').PetActionKind;readonly presentation:import('../core/local-pet-action.js').PetPresentation;readonly skinId:string;readonly assetFingerprint:string;readonly appearanceRequestId:string}
  | { readonly channel:'book_privacy'; readonly characterId:string; readonly sessionId:string; readonly incognito:boolean }
  | { readonly channel:'book_thinking'; readonly requestId:string; readonly characterId:string; readonly sessionId:string; readonly level?:number; readonly expectedRevision?:number; readonly operationId?:string }
  | { readonly channel: 'book_turn_status'; readonly clientRequestId: string; readonly characterId: string; readonly sessionId: string }
  | { readonly channel:'companion_takeover'; readonly characterId:string; readonly stopped:true; readonly lastShownAt:number | null; readonly previouslyEnabled?:boolean }
  | { readonly channel:'companion_ack'; readonly characterId:string; readonly id:string }
  | { readonly channel:'companion_claim'; readonly characterId:string; readonly sessionId:string; readonly id:string }
  | { readonly channel:'companion_presence'; readonly hidden:boolean; readonly dnd:boolean }
  | { readonly channel: 'companion_action'; readonly characterId: string; readonly pairingId: string;
      readonly action: 'touch' | 'clear_history' | 'set_enabled' | 'set_quiet' | 'set_focus'; readonly enabled?: boolean }
  | import('./wake.js').WakeFromDesktop
  | { readonly channel: 'presence'; readonly isTyping: boolean; readonly isSpeaking: boolean; readonly isTurnActive: boolean; readonly isWorkPendingConfirmation: boolean }
  | { readonly channel: 'work_action'; readonly action: import('./desktop-work.js').DesktopWorkAction }
  | { readonly channel: 'command'; readonly command: DesktopCommand }
  | BridgeVoiceChunk
  | { readonly channel: 'ack'; readonly requestId: string }
  | { readonly channel: 'capture'; readonly requestId: string; readonly result: {
    readonly scope: TurnScope; readonly audio: BridgeMedia; readonly images: readonly BridgeMedia[];
    readonly inputEndedAt: string; readonly captureStoppedAt: string;
  } }
  | { readonly channel: 'playback'; readonly requestId: string; readonly event: PlaybackEvent }
  | { readonly channel: 'rpc_error'; readonly requestId: string; readonly message: string;
    readonly scope?: TurnScope; readonly error?: DeviceFailure };

// Acks: capture_start after audio is ready, independent of camera; capture_stop/stop after tracks/output stop.
// capture_finish returns capture, never ack. play completes on one terminal PlaybackEvent.
// FIX61-08 live audio: while one voice turn is authorized, the renderer frames its captured mono PCM
// into 100 ms chunks and pushes each one as voice_chunk. The backend answers voice_chunk_ack once the
// frame entered the recognizer; more than 20 unacknowledged frames stop the capture (backpressure).
// Native EOF/window close stops all renderer devices and cancels the backend process.
// Base64 values are ephemeral copies; discard after transfer/use. Local pet-media/blob URIs
// are identifiers only: each receiving process must create its own scoped media-store entry.

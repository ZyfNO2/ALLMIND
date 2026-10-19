import { userFacingError } from './user-facing-error.js';
import type { CapturePort, CapturedInput, CharacterId, DesktopCommand, DesktopEvent, TurnInput, TurnScope } from '../contracts/index.js';
import { DialoguePipeline, type DialoguePorts } from './dialogue-pipeline.js';
import type { LiveVoiceTurn } from './live-voice-turn.js';
import { sameScope, TurnController } from './turn-controller.js';

type Active = { input: TurnInput; signal: AbortSignal; ready?: Promise<void>; finishing: boolean; live?: LiveVoiceTurn | undefined };
/**
 * FIX61-08 live voice leg. When present, one authorized voice turn opens a streaming recognizer
 * session and the release commits the verified transcript instead of transcribing the whole clip
 * again. A construction failure falls back to the batch capture path for that turn only.
 */
export interface LiveVoiceFactory { open(scope: TurnScope): LiveVoiceTurn }
export interface RuntimePorts extends DialoguePorts {
  capture: CapturePort;
  liveVoice?: LiveVoiceFactory;
  onForegroundIdle?(): void;
  onCompanionTurnStarted?: ((input: TurnInput) => void | Promise<void>) | undefined;
  onCompanionTriggerFinished?: ((input: TurnInput, status: 'cancelled' | 'failed', reason?: string) => void | Promise<void>) | undefined;
  onCompanionReplyDisplayed?: ((triggerId: string, scope: TurnScope) => void | Promise<void>) | undefined;
}
/** Serializes short UI commands; device permission and model waits never block cancellation. */
export class DesktopRuntime {
  private readonly controller: TurnController;
  private readonly pipeline: DialoguePipeline;
  private active: Active | undefined;
  private lastEmotionScope: TurnScope | undefined;
  private cleanupPending: TurnScope | undefined;
  private commands = Promise.resolve();
  private readonly jobs = new Set<Promise<void>>();
  private readonly triggerReplies = new Map<string, TurnScope>();
  private closed = false;
  attachWork(work: import('../contracts/desktop-work.js').DesktopWorkPort) { this.ports.work = work; }
  identity() { return this.controller.identity(); }
  get currentGeneration(): number { return this.controller.currentGeneration; }
  isBusy(): boolean { return !!this.active || !!this.cleanupPending; }
  async cancelCompanionTrigger(triggerId: string): Promise<boolean> {
    if (this.active?.input.provenance?.triggerId !== triggerId) return false;
    await this.dispatch({ type: 'cancel' });
    return true;
  }
  // RWR-02 (D1): same contract as TurnController — the running role is set once, at composition.
  // The production roots (`app/backend-session.ts`, `app/trial-backend.ts`) construct this without a
  // character, which keeps today's companion behaviour until a boot path passes the registry's
  // recorded `effectiveCharacterId`. No runtime call can change it afterwards.
  constructor(private readonly ports: RuntimePorts, private readonly emit: (event: DesktopEvent) => void, afterConversationSaved?: (scope: TurnScope, userText: string, assistantText: string) => void, characterId?: CharacterId) {
    this.controller = new TurnController(characterId);
    this.pipeline = new DialoguePipeline(ports, this.controller, event => {
      emit(event);
      if (event.type === 'reply' && event.provenance) this.triggerReplies.set(event.provenance.triggerId, event.reply.scope);
    }, afterConversationSaved);
  }
  private presentation(): void {
    const presentation = this.controller.snapshot();
    if (presentation) this.emit({ type: 'presentation', presentation });
  }
  private track(job: Promise<void>): void {
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
  }
  private async stopCurrent(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    this.ports.work?.onInput();
    this.controller.cancel();
    this.presentation();
    if (active?.live) void active.live.cancel().catch(() => {});
    const scope = active?.input.scope ?? this.cleanupPending;
    const emotionScope=scope??this.lastEmotionScope;
    if(emotionScope)this.ports.emotion?.cancel(emotionScope);
    this.lastEmotionScope=undefined;
    if (!scope) return;
    this.cleanupPending = scope;
    const results = await Promise.allSettled([
      this.ports.capture.stop(scope),
      this.ports.playback.stop(scope),
      this.ports.mediaStore.releaseScope(scope),
    ]);
    if (active?.input.provenance) {
      this.triggerReplies.delete(active.input.provenance.triggerId);
      await this.ports.onCompanionTriggerFinished?.(active.input, 'cancelled', 'turn_cancelled');
    }
    if (results.some(result => result.status === 'rejected')) {
      this.emit({ type: 'error', scope, message: '这一轮的清理尚未完成，请稍后再试。' });
      throw new Error('Unable to complete turn cleanup');
    }
    if (this.cleanupPending === scope) this.cleanupPending = undefined;
  }
  private async fail(active: Active, error: unknown): Promise<void> {
    if (this.active !== active || active.signal.aborted) return;
    const message = error instanceof Error ? error.message : 'Turn failed';
    this.controller.playback({ type: 'error', scope: active.input.scope, at: new Date().toISOString(), message });
    this.emit({ type: 'error', scope: active.input.scope, message });
    this.presentation();
    this.active = undefined;
    this.cleanupPending = active.input.scope;
    const cleanup = await Promise.allSettled([this.ports.capture.stop(active.input.scope), this.ports.playback.stop(active.input.scope), this.ports.mediaStore.releaseScope(active.input.scope)]);
    if (cleanup.every(result => result.status === 'fulfilled') && this.cleanupPending === active.input.scope) this.cleanupPending = undefined;
  }
  private run(active: Active, captured?: CapturedInput): void {
    this.track((async () => {
      try {
        const outcome = await this.pipeline.run(active.input, active.signal, captured);
        const provenance = active.input.provenance;
        if (provenance && (outcome.status === 'cancelled' || outcome.status === 'failed')) {
          this.triggerReplies.delete(provenance.triggerId);
          await this.ports.onCompanionTriggerFinished?.(active.input, outcome.status, outcome.error);
        }
      } catch (error) { await this.fail(active, error); }
      finally { if (this.active === active) this.active = undefined; this.ports.onForegroundIdle?.(); }
    })());
  }
  dispatch(command: DesktopCommand): Promise<void> {
    const commandJob = this.commands.then(async () => {
      if (this.closed) throw new Error('Desktop runtime is closed');
      switch (command.type) {
        case 'cancel': await this.stopCurrent(); return;
        case 'acknowledge_introduction':
          throw new Error('Introduction acknowledgements belong to the profile boundary');
        case 'click_invitation':
          // Invitation ownership, expiry and quota must be resolved by the persisted invitation service.
          throw new Error('Invitation service is not connected');
        case 'ignore_invitation':
          // Invitation dismissal ownership and source audit belong to the persisted invitation service.
          throw new Error('Invitation service is not connected');
        case 'companion_trigger': {
          if (!command.triggerId.trim() || command.triggerId.length > 512 || !command.observationId.trim() || command.observationId.length > 200) {
            throw new Error('Invalid companion trigger reference');
          }
          if (this.isBusy()) throw new Error('companion_turn_busy');
          const turn = this.controller.begin('text');
          const provenance = Object.freeze({ kind: 'companion-trigger' as const, triggerId: command.triggerId, observationId: command.observationId });
          const input: TurnInput = Object.freeze({ ...turn.input, provenance });
          const active: Active = { input, signal: turn.signal, finishing: false };
          this.active = active;
          this.lastEmotionScope = input.scope;
          this.emit({ type: 'turn', input }); this.presentation();
          this.run(active);
          return;
        }
        case 'acknowledge_companion_reply': {
          const expectedScope = this.triggerReplies.get(command.triggerId);
          if (!expectedScope || !sameScope(expectedScope, command.scope)) throw new Error('Invalid companion reply acknowledgement');
          this.triggerReplies.delete(command.triggerId);
          await this.ports.onCompanionReplyDisplayed?.(command.triggerId, command.scope);
          return;
        }
        case 'finish_voice': {
          const active = this.active;
          if (!active || active.input.kind !== 'voice' || active.finishing) return;
          active.finishing = true;
          this.track((async () => {
            try {
              await active.ready;
              if (this.active !== active || active.signal.aborted) return;
              // The live leg runs first: the release flush and the bounded final result happen while
              // the capture is still draining, and the verified transcript rides on the turn input.
              const live = active.live?.release(active.signal);
              const captured = await this.ports.capture.finish(active.input.scope);
              if (this.active !== active || active.signal.aborted) { await this.ports.mediaStore.releaseScope(active.input.scope); return; }
              const spoken = live ? await live : undefined;
              if (this.active !== active || active.signal.aborted) { await this.ports.mediaStore.releaseScope(active.input.scope); return; }
              if (spoken?.type === 'finished') {
                this.run({ ...active, input: Object.freeze({ ...active.input, transcript: spoken.transcript }) }, captured);
                return;
              }
              this.run(active, captured);
            } catch (error) { await this.fail(active, error); }
          })());
          return;
        }
        case 'submit_text': case 'start_voice': {
          if (command.type === 'submit_text' && !command.text.trim()) throw new Error('Text must not be empty');
          await this.stopCurrent();
          const turn = this.controller.begin(command.type === 'start_voice' ? 'voice' : 'text', command.type === 'submit_text' ? command.text : undefined);
          const input: TurnInput = { ...turn.input, ...(command.clientRequestId !== undefined ? { clientRequestId: command.clientRequestId } : {}), ...(command.type==='start_voice'&&command.wakeKeyword?{wakeKeyword:command.wakeKeyword}:{}) };
          const active: Active = { input, signal: turn.signal, finishing: false };
          this.active = active;
          this.lastEmotionScope=input.scope;
          this.ports.work?.beginInput?.(input.scope, command.workBinding);
          this.emit({ type: 'turn', input }); this.presentation();
          if (turn.input.kind === 'text') { this.run(active); return; }
          const live = this.ports.liveVoice;
          if (live) {
            // The live recognizer streams the same authorized capture; a failure here is reported and
            // the turn continues on the batch path instead of losing the user's speech.
            try { active.live = live.open(input.scope); await active.live.start(); }
            catch (error) { active.live = undefined; this.emit({ type: 'error', scope: input.scope, message: userFacingError(error) }); }
          }
          active.ready = this.ports.capture.start(turn.input.scope, turn.signal);
          this.track(active.ready.catch(error => this.fail(active, error)));
          return;
        }
      }
    });
    // A rejected command must not poison later cancellation or recovery commands.
    this.commands = commandJob.catch(() => {});
    return commandJob;
  }
  async drain(): Promise<void> {
    await this.commands;
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
  async close(): Promise<void> {
    await this.commands;
    this.closed = true;
    await this.stopCurrent();
    await this.ports.emotion?.close();
  }
}

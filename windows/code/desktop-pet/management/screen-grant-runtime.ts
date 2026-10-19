import type { PairingScope } from '../contracts/character-pack.js';
import {
  validateContextUseGrant,
  validateContinuousPerceptionGrant,
  type ContextUseGrant,
  type RuntimeContinuousPerceptionGrant,
} from '../contracts/companion-mode.js';
import type { CaptureGrant, GrantScopeType, ProcessingDestination } from '../contracts/perception.js';
import { operationSignature, type HostScreenTarget, type HostScreenTargetSelection } from '../contracts/desktop-host.js';
import { DesktopHostError, selectHostScreenTarget, type DesktopHostBridge } from '../app/desktop-host-bridge.js';
import type { CaptureGrantManager } from '../core/perception-grant.js';
import type { ObservationScheduler } from '../core/observation-scheduler.js';
import type { CompanionModeRuntime } from '../core/companion-mode-runtime.js';
import type { CapturedFrame, ScreenCaptureSource, ScreenTarget } from '../core/screen-capture-source.js';

export type ScreenGrantPurpose = 'capture-single' | 'capture-continuous' | 'context-use';
export type ScreenGrantCapability = 'screenTargets' | 'capture' | 'localOcr' | 'cloudVlm';

export class ScreenGrantRuntimeError extends Error {
  constructor(readonly code: 'invalid_request' | 'forbidden' | 'version_conflict' | 'not_found' | 'unavailable', message: string) {
    super(message);
    this.name = 'ScreenGrantRuntimeError';
  }
}

interface GrantRecord {
  readonly id: string;
  readonly purpose: ScreenGrantPurpose;
  readonly revision: number;
  readonly captureGrant?: CaptureGrant;
  readonly runtimeGrant?: RuntimeContinuousPerceptionGrant;
  readonly contextGrant?: ContextUseGrant;
}

interface OperationEntry { readonly signature: string; readonly result: unknown }

export interface ScreenGrantRuntimeOptions {
  readonly bridge?: DesktopHostBridge;
  readonly grants: CaptureGrantManager;
  readonly captureSource?: ScreenCaptureSource;
  readonly scheduler?: ObservationScheduler;
  readonly companionMode?: CompanionModeRuntime;
  readonly pairing: PairingScope;
  readonly runtimeSessionId: string;
  readonly capabilities: { readonly capture: boolean; readonly localOcr: boolean; readonly cloudVlm: boolean };
  readonly now?: () => number;
}

/** Pair-scoped management adapter. CaptureGrantManager remains the owner of single/session capture grants. */
export class ScreenGrantRuntime {
  private readonly bridge: DesktopHostBridge | undefined;
  private readonly grants: CaptureGrantManager;
  private readonly captureSource: ScreenCaptureSource | undefined;
  private readonly scheduler: ObservationScheduler | undefined;
  private readonly companionMode: CompanionModeRuntime | undefined;
  private readonly pairing: PairingScope;
  private readonly runtimeSessionId: string;
  private readonly capabilities: ScreenGrantRuntimeOptions['capabilities'];
  private readonly now: () => number;
  private readonly records = new Map<string, GrantRecord>();
  private readonly operations = new Map<string, OperationEntry>();
  private onGrantsInvalidated?: (() => void | Promise<void>) | undefined;
  private selectedTarget: HostScreenTarget | null = null;
  private revision = 0;

  constructor(options: ScreenGrantRuntimeOptions) {
    this.bridge = options.bridge;
    this.grants = options.grants;
    this.captureSource = options.captureSource;
    this.scheduler = options.scheduler;
    this.companionMode = options.companionMode;
    this.pairing = options.pairing;
    this.runtimeSessionId = options.runtimeSessionId;
    this.capabilities = options.capabilities;
    this.now = options.now ?? Date.now;
  }

  setOnGrantsInvalidated(callback: () => void | Promise<void>): void { this.onGrantsInvalidated = callback; }

  async selectTarget(input: { pairing: PairingScope; operationId: string }): Promise<unknown> {
    this.#assertPairing(input.pairing);
    this.#validateOperationId(input.operationId);
    const signature = operationSignature({ action: 'select-target', pairing: input.pairing });
    const replay = this.#replay(input.operationId, signature);
    if (replay !== undefined) return replay;
    if (!this.bridge) throw new ScreenGrantRuntimeError('unavailable', '当前没有可用的桌宠宿主目标选择器。');

    let result: HostScreenTargetSelection;
    try { result = await selectHostScreenTarget(this.bridge, { operationId: input.operationId, pairing: input.pairing }); }
    catch (error) { throw this.#hostError(error); }
    if (result?.outcome === 'cancelled') {
      const cancelled = { outcome: 'cancelled' as const };
      this.#recordOperation(input.operationId, signature, cancelled);
      return cancelled;
    }
    const target = result?.target;
    if (result?.outcome !== 'selected' || !this.#validHostTarget(target)) {
      throw new ScreenGrantRuntimeError('unavailable', '宿主未返回有效的屏幕目标。');
    }

    const changed = !this.selectedTarget || this.selectedTarget.targetId !== target.targetId
      || this.selectedTarget.targetRevision !== target.targetRevision;
    if (changed) {
      await this.#revokeContextGrantForTargetChange();
      await this.#invalidateAllGrants();
    }
    this.selectedTarget = freezeTarget(target);
    if (changed) this.revision++;
    const selected = { outcome: 'selected' as const, target: this.selectedTarget, revision: this.revision };
    this.#recordOperation(input.operationId, signature, selected);
    return selected;
  }

  getGrants(pairing: PairingScope): unknown {
    this.#assertPairing(pairing);
    const grants = [...this.records.values()].map(record => this.#recordView(record));
    const contextGrant = this.companionMode?.getContextUseGrant();
    if (contextGrant && !this.records.has(contextGrant.grantId)) grants.push({ purpose: 'context-use', grant: contextGrant });
    return {
      revision: this.revision,
      pairing: this.pairing,
      target: this.selectedTarget,
      grants,
      capabilities: {
        screenTargets: !!this.bridge,
        capture: this.capabilities.capture,
        localOcr: this.capabilities.localOcr,
        cloudVlm: this.capabilities.cloudVlm,
      },
      missingReasons: [
        ...(!this.bridge ? ['screen_target_picker_unavailable'] : []),
        ...(!this.capabilities.capture ? ['real_screen_capture_unavailable'] : []),
        ...(!this.capabilities.localOcr ? ['pixel_ocr_unavailable'] : []),
        ...(!this.capabilities.cloudVlm ? ['cloud_vlm_unavailable'] : []),
      ],
    };
  }

  triggerReadiness(pairing: PairingScope): { readonly targetSelected: boolean; readonly grantId: string | null; readonly destination?: ProcessingDestination; readonly capture: boolean; readonly localOcr: boolean; readonly cloudVlm: boolean; readonly target: HostScreenTarget | null } {
    this.#assertPairing(pairing);
    const grantId = this.activeSingleGrantId();
    const grant = grantId ? this.grants.getGrant(grantId) : null;
    return { targetSelected: !!this.selectedTarget, grantId, ...(grant ? { destination: grant.destination } : {}),
      capture: this.capabilities.capture && !!this.captureSource,
      localOcr: this.capabilities.localOcr, cloudVlm: this.capabilities.cloudVlm,
      target: this.selectedTarget };
  }

  activeSingleGrantId(): string | null {
    if (!this.selectedTarget) return null;
    for (const record of this.records.values()) {
      if (record.purpose !== 'capture-single' || !record.captureGrant) continue;
      const grant = this.grants.getGrant(record.captureGrant.grantId);
      if (grant?.status === 'active' && grant.duration === 'single' && grant.sessionId === this.runtimeSessionId
        && grant.targetId === this.selectedTarget.targetId && Date.parse(grant.expiresAt) > this.now()) return grant.grantId;
    }
    return null;
  }

  async captureSingleFrame(grantId: string, signal?: AbortSignal): Promise<{ readonly grant: CaptureGrant; readonly frame: CapturedFrame }> {
    const record = this.records.get(grantId);
    const grant = this.grants.getGrant(grantId);
    const target = this.selectedTarget;
    if (!record || record.purpose !== 'capture-single' || !grant || grant.status !== 'active' || grant.duration !== 'single'
      || grant.sessionId !== this.runtimeSessionId || !target || grant.targetId !== target.targetId) {
      throw new ScreenGrantRuntimeError('forbidden', '没有匹配当前目标的有效单次授权。');
    }
    if (!this.captureSource) throw new ScreenGrantRuntimeError('unavailable', '真实屏幕捕获能力尚未装配。');
    const combined = combineSignals(signal, this.grants.getSignal(grantId) ?? undefined);
    try {
      const frame = await this.captureSource.captureSingle(toScreenTarget(target), grant, combined.signal);
      if (!frame) throw new ScreenGrantRuntimeError('unavailable', '宿主没有返回屏幕帧。');
      return { grant, frame };
    } finally { combined.dispose(); }
  }

  async issue(input: {
    pairing: PairingScope;
    expectedRevision: number;
    operationId: string;
    purpose: ScreenGrantPurpose;
    destination: ProcessingDestination;
    targetId: string;
    targetRevision: number;
    ttlMs?: number;
    minPollIntervalMs?: number;
    userConfirmed: boolean;
    modelBinding?: string;
    observationSourceScopes?: readonly string[];
  }): Promise<unknown> {
    this.#assertPairing(input.pairing);
    this.#validateOperationId(input.operationId);
    const signature = operationSignature({ action: 'issue-grant', ...input });
    const replay = this.#replay(input.operationId, signature);
    if (replay !== undefined) return replay;
    if (input.expectedRevision !== this.revision) throw new ScreenGrantRuntimeError('version_conflict', '屏幕授权已更新，请刷新后重试。');
    if (input.userConfirmed !== true) throw new ScreenGrantRuntimeError('forbidden', '需要明确确认屏幕观察授权。');
    if (!['capture-single', 'capture-continuous', 'context-use'].includes(input.purpose)) throw new ScreenGrantRuntimeError('invalid_request', '授权用途无效。');
    if (input.destination !== 'local' && input.destination !== 'cloud') throw new ScreenGrantRuntimeError('invalid_request', '处理目的地无效。');
    const target = this.selectedTarget;
    if (!target || input.targetId !== target.targetId || input.targetRevision !== target.targetRevision) {
      throw new ScreenGrantRuntimeError('forbidden', '目标不存在、已变化或不属于当前配对。');
    }
    if (input.purpose === 'capture-continuous' && input.destination !== 'local') {
      throw new ScreenGrantRuntimeError('forbidden', '旧版持续授权仅允许本地处理。');
    }

    const ttlMs = input.ttlMs ?? (input.purpose === 'capture-single' ? 60_000 : 3_600_000);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1000) {
      throw new ScreenGrantRuntimeError('invalid_request', '授权期限无效。');
    }
    const bounds = { ...target.bounds };
    const minPollIntervalMs = input.minPollIntervalMs ?? 300_000;
    if (input.purpose === 'capture-continuous'
      && (!Number.isSafeInteger(minPollIntervalMs) || minPollIntervalMs < 1000)) {
      throw new ScreenGrantRuntimeError('invalid_request', '持续观察间隔不得短于 1000ms。');
    }
    let record: GrantRecord;
    if (input.purpose === 'capture-single' || input.purpose === 'capture-continuous') {
      const captureGrant = this.grants.issueGrant({
        sessionId: this.runtimeSessionId,
        scopeType: 'screen' satisfies GrantScopeType,
        targetId: target.targetId,
        bounds,
        purpose: input.purpose === 'capture-single' ? '用户明确请求的单次屏幕观察' : '用户明确授权的本地持续观察',
        destination: input.destination,
        duration: input.purpose === 'capture-single' ? 'single' : 'session',
        ttlMs,
      });
      if (input.purpose === 'capture-single') {
        record = { id: captureGrant.grantId, purpose: input.purpose, revision: captureGrant.revision, captureGrant };
      } else {
        const runtimeGrant: RuntimeContinuousPerceptionGrant = {
          schemaVersion: 1,
          grantId: captureGrant.grantId,
          revision: captureGrant.revision,
          pairing: this.pairing,
          targetId: target.targetId,
          targetRevision: target.targetRevision,
          bounds,
          runtimeSessionId: this.runtimeSessionId,
          minPollIntervalMs,
          expiry: captureGrant.expiresAt,
          destination: 'local',
          state: 'active',
        };
        validateContinuousPerceptionGrant(runtimeGrant);
        if (this.captureSource && this.scheduler) {
          await this.captureSource.attachContinuousGrant(runtimeGrant);
          this.scheduler.setContext(runtimeGrant, toScreenTarget(target));
        }
        record = { id: captureGrant.grantId, purpose: input.purpose, revision: captureGrant.revision, captureGrant, runtimeGrant };
      }
    } else {
      if (!this.companionMode) throw new ScreenGrantRuntimeError('unavailable', '文本用途授权 owner 未装配。');
      const observationSourceScopes = input.observationSourceScopes ?? [`screen:${target.targetId}`];
      try { validateContextUseGrant({
        schemaVersion: 1, grantId: 'context-validation', revision: 1, pairing: this.pairing,
        observationSourceScopes, modelBinding: input.modelBinding ?? '', destination: input.destination,
        expiry: new Date(this.now() + ttlMs).toISOString(), state: 'active',
      }); }
      catch { throw new ScreenGrantRuntimeError('invalid_request', '文本用途授权需要模型绑定和至少一个观察来源。'); }
      const previous = this.companionMode.getContextUseGrant();
      let contextGrant: ContextUseGrant;
      try {
        contextGrant = await this.companionMode.issueContextUseGrant({
          operationId: `rwr10:context-use:${input.operationId}`,
          expectedRevision: previous?.revision ?? 0,
          observationSourceScopes,
          modelBinding: input.modelBinding ?? '',
          destination: input.destination,
          ttlMs,
        });
      } catch (error) {
        if ((error as { code?: string })?.code === 'version_conflict') throw new ScreenGrantRuntimeError('version_conflict', '文本用途授权已更新，请刷新后重试。');
        throw new ScreenGrantRuntimeError('invalid_request', '文本用途授权未通过 owner 校验。');
      }
      for (const [id, existing] of this.records) if (existing.purpose === 'context-use') this.records.delete(id);
      record = { id: contextGrant.grantId, purpose: input.purpose, revision: contextGrant.revision, contextGrant };
    }
    this.records.set(record.id, record);
    this.revision++;
    const receipt = { revision: this.revision, grant: this.#recordView(record) };
    this.#recordOperation(input.operationId, signature, receipt);
    return receipt;
  }

  async revoke(input: { pairing: PairingScope; grantId: string; expectedRevision: number; operationId: string }): Promise<unknown> {
    this.#assertPairing(input.pairing);
    this.#validateOperationId(input.operationId);
    const signature = operationSignature({ action: 'revoke-grant', ...input });
    const replay = this.#replay(input.operationId, signature);
    if (replay !== undefined) return replay;
    if (input.expectedRevision !== this.revision) throw new ScreenGrantRuntimeError('version_conflict', '屏幕授权已更新，请刷新后重试。');
    const record = this.records.get(input.grantId);
    const persistentContextGrant = this.companionMode?.getContextUseGrant();
    const contextGrant = record?.contextGrant ?? (persistentContextGrant?.grantId === input.grantId ? persistentContextGrant : undefined);
    if (!record && !contextGrant) throw new ScreenGrantRuntimeError('not_found', '屏幕授权不存在。');
    await this.onGrantsInvalidated?.();
    if (record?.captureGrant) this.grants.revokeGrant(record.captureGrant.grantId);
    if (record?.runtimeGrant) {
      await this.scheduler?.cancel();
      this.captureSource?.detachGrant();
      this.scheduler?.setContext(null, null);
    }
    if (contextGrant && this.companionMode) {
      try {
        await this.companionMode.revokeContextUseGrant({ grantId: input.grantId,
          expectedRevision: contextGrant.revision, operationId: `rwr10:context-revoke:${input.operationId}` });
      } catch (error) {
        if ((error as { code?: string })?.code === 'version_conflict') throw new ScreenGrantRuntimeError('version_conflict', '文本用途授权已更新，请刷新后重试。');
        throw new ScreenGrantRuntimeError('unavailable', '文本用途授权撤销未完成。');
      }
    }
    this.records.delete(input.grantId);
    this.revision++;
    const result = { revoked: true, grantId: input.grantId, revision: this.revision };
    this.#recordOperation(input.operationId, signature, result);
    return result;
  }

  async close(): Promise<void> {
    await this.#invalidateAllGrants();
  }

  async #revokeContextGrantForTargetChange(): Promise<void> {
    const grant = this.companionMode?.getContextUseGrant();
    if (!grant || grant.state !== 'active' || !this.companionMode) return;
    try {
      await this.companionMode.revokeContextUseGrant({ grantId: grant.grantId, expectedRevision: grant.revision,
        operationId: `rwr10:target-change:${this.revision}:${grant.grantId}` });
      this.records.delete(grant.grantId);
    } catch {
      throw new ScreenGrantRuntimeError('unavailable', '目标变化时未能撤销旧的文本用途授权。');
    }
  }

  async #invalidateAllGrants(): Promise<void> {
    await this.onGrantsInvalidated?.();
    await this.scheduler?.cancel();
    for (const record of this.records.values()) if (record.captureGrant) this.grants.revokeGrant(record.captureGrant.grantId);
    this.records.clear();
    this.captureSource?.detachGrant();
    this.scheduler?.setContext(null, null);
  }

  #recordView(record: GrantRecord): unknown {
    if (record.runtimeGrant) return { purpose: record.purpose, grant: record.runtimeGrant };
    if (record.captureGrant) return { purpose: record.purpose, grant: this.grants.getGrant(record.captureGrant.grantId) };
    return { purpose: record.purpose, grant: record.contextGrant };
  }

  #assertPairing(pairing: PairingScope): void {
    if (!pairing || pairing.userId !== this.pairing.userId || pairing.characterId !== this.pairing.characterId
      || pairing.characterInstanceId !== this.pairing.characterInstanceId) {
      throw new ScreenGrantRuntimeError('forbidden', '陪伴配对不属于当前运行角色。');
    }
  }

  #validateOperationId(value: string): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) {
      throw new ScreenGrantRuntimeError('invalid_request', '操作编号无效。');
    }
  }

  #replay(operationId: string, signature: string): unknown | undefined {
    const prior = this.operations.get(operationId);
    if (!prior) return undefined;
    if (prior.signature !== signature) throw new ScreenGrantRuntimeError('version_conflict', '操作编号已用于不同请求。');
    return structuredClone(prior.result);
  }

  #recordOperation(operationId: string, signature: string, result: unknown): void {
    this.operations.set(operationId, { signature, result: structuredClone(result) });
    while (this.operations.size > 128) this.operations.delete(this.operations.keys().next().value!);
  }

  #validHostTarget(target: HostScreenTarget | undefined): target is HostScreenTarget {
    return !!target && typeof target.targetId === 'string' && target.targetId.length > 0 && target.targetId.length <= 200
      && Number.isSafeInteger(target.targetRevision) && target.targetRevision >= 1 && target.kind === 'screen'
      && typeof target.displayName === 'string' && target.displayName.length > 0 && target.displayName.length <= 120
      && Number.isFinite(target.scaleFactor) && target.scaleFactor > 0
      && [target.bounds?.x, target.bounds?.y, target.bounds?.width, target.bounds?.height].every(Number.isFinite)
      && target.bounds.width > 0 && target.bounds.height > 0;
  }

  #hostError(error: unknown): ScreenGrantRuntimeError {
    if (error instanceof DesktopHostError) {
      if (error.code === 'invalid_request') return new ScreenGrantRuntimeError('invalid_request', error.message);
      if (error.code === 'operation_conflict' || error.code === 'stale_revision') return new ScreenGrantRuntimeError('version_conflict', error.message);
    }
    return new ScreenGrantRuntimeError('unavailable', '桌宠宿主没有完成屏幕目标选择。');
  }
}

function combineSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose: () => void } {
  const active = signals.filter((signal): signal is AbortSignal => !!signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of active) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, dispose: () => active.forEach(signal => signal.removeEventListener('abort', abort)) };
}

function freezeTarget(target: HostScreenTarget): HostScreenTarget {
  return Object.freeze({ ...target, bounds: Object.freeze({ ...target.bounds }) });
}
function toScreenTarget(target: HostScreenTarget): ScreenTarget {
  return { targetId: target.targetId, targetRevision: target.targetRevision, kind: 'screen',
    displayName: target.displayName, bounds: { ...target.bounds }, isValid: true };
}

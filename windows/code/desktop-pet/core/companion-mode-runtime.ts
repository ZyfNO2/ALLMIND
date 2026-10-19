/**
 * core/companion-mode-runtime.ts
 *
 * N082-01: Companion Mode & Grant State Machine Runtime.
 * Manages active/passive mode policies, source grant lifecycles, run generation,
 * session lock/suspend invalidation, and idempotent operation persistence.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { PairingScope } from '../contracts/character-pack.js';
import type {
  CompanionMode,
  CompanionRunState,
  CompanionModePolicy,
  ModeStatus,
  CompanionSourceKind,
  SourceGrant,
  SourceGrantState,
  SourceGrantScope,
  SourceGrantPurpose,
  SourceGrantDestination,
  ContextUseGrant,
  CompanionAutomationPreferences,
  CompanionAutomationPreferencesRecord,
} from '../contracts/companion-mode.js';
import { validateCompanionModePolicy, validateContextUseGrant, validateCompanionAutomationPreferences } from '../contracts/companion-mode.js';

export interface CompanionModeRuntimeOptions {
  readonly db: Database;
  readonly pairing: PairingScope;
  readonly now?: (() => string) | undefined;
  readonly onSourceSync?: ((kind: CompanionSourceKind, active: boolean) => Promise<void>) | undefined;
  readonly onGenerationChange?: ((generation: number) => void) | undefined;
  readonly onContextUseGrantChange?: ((grant: ContextUseGrant | null) => void | Promise<void>) | undefined;
  readonly onAutomationPreferencesChange?: ((record: CompanionAutomationPreferencesRecord) => void | Promise<void>) | undefined;
}

export type CompanionTriggerKind = 'screen' | 'greeting';
export type CompanionTriggerOutcome = 'accepted' | 'busy' | 'needs-authorization' | 'unavailable';
export type CompanionTriggerState = 'accepted' | 'captured' | 'recognized' | 'generating' | 'delivered' | 'no-content' | 'cancelled' | 'failed';
export interface CompanionTriggerRecord {
  readonly triggerId: string;
  readonly pairing: PairingScope;
  readonly runtimeSessionId: string;
  readonly generation: number;
  readonly kind: CompanionTriggerKind;
  readonly outcome: CompanionTriggerOutcome;
  readonly status: CompanionTriggerState;
  readonly reason?: string;
  readonly observationId?: string;
  readonly turnScope?: import('../contracts/index.js').TurnScope;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class CompanionModeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CompanionModeError';
  }
}

export class CompanionModeRuntime {
  private readonly db: Database;
  private readonly pairing: PairingScope;
  private readonly now: () => string;
  private readonly onSourceSync?: ((kind: CompanionSourceKind, active: boolean) => Promise<void>) | undefined;
  private readonly onGenerationChange?: ((generation: number) => void) | undefined;
  private readonly onContextUseGrantChange?: ((grant: ContextUseGrant | null) => void | Promise<void>) | undefined;
  private readonly onAutomationPreferencesChange?: ((record: CompanionAutomationPreferencesRecord) => void | Promise<void>) | undefined;
  private generation = 1;
  private runState: CompanionRunState = 'paused';
  private leases = new Set<CompanionSourceKind>();

  constructor(options: CompanionModeRuntimeOptions) {
    this.db = options.db;
    this.pairing = options.pairing;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onSourceSync = options.onSourceSync;
    this.onGenerationChange = options.onGenerationChange;
    this.onContextUseGrantChange = options.onContextUseGrantChange;
    this.onAutomationPreferencesChange = options.onAutomationPreferencesChange;
    this.#initSchema();
  }

  #initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_mode_policy(
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        mode TEXT NOT NULL, observation_interval_ms INTEGER NOT NULL,
        daily_local_time TEXT NOT NULL, timezone TEXT NOT NULL,
        policy_version INTEGER NOT NULL, revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, character_id, character_instance_id));
      CREATE TABLE IF NOT EXISTS companion_automation_preferences(
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        revision INTEGER NOT NULL, preferences_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, character_id, character_instance_id));
      CREATE TABLE IF NOT EXISTS companion_mode_grants(
        grant_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL, scope_json TEXT NOT NULL, purposes_json TEXT NOT NULL,
        destination TEXT NOT NULL, profile TEXT NOT NULL, state TEXT NOT NULL,
        revision INTEGER NOT NULL, granted_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        UNIQUE(user_id, character_id, character_instance_id, kind));
      CREATE TABLE IF NOT EXISTS companion_mode_operations(
        operation_id TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_context_use_grants(
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        grant_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
        observation_source_scopes_json TEXT NOT NULL, model_binding TEXT NOT NULL,
        destination TEXT NOT NULL, expiry TEXT NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY(user_id, character_id, character_instance_id));
    `);
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get currentRunState(): CompanionRunState {
    return this.runState;
  }

  getPolicy(): CompanionModePolicy {
    const row = this.db.prepare(`
      SELECT * FROM companion_mode_policy
      WHERE user_id=? AND character_id=? AND character_instance_id=?
    `).get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId) as Record<string, unknown> | undefined;

    if (!row) {
      // Default policy: passive mode, 5min observation, 20:00, Asia/Shanghai, revision 1
      return {
        schemaVersion: 1,
        revision: 1,
        pairing: this.pairing,
        mode: 'passive',
        observationIntervalMs: 300_000,
        dailyLocalTime: '20:00',
        timezone: 'Asia/Shanghai',
        policyVersion: 1,
      };
    }

    return {
      schemaVersion: 1,
      revision: Number(row.revision),
      pairing: this.pairing,
      mode: row.mode as CompanionMode,
      observationIntervalMs: Number(row.observation_interval_ms),
      dailyLocalTime: String(row.daily_local_time),
      timezone: String(row.timezone),
      policyVersion: Number(row.policy_version),
    };
  }

  getAutomationPreferences(): CompanionAutomationPreferencesRecord {
    const row = this.db.prepare(`SELECT revision, preferences_json FROM companion_automation_preferences
      WHERE user_id=? AND character_id=? AND character_instance_id=?`)
      .get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId) as { revision: number; preferences_json: string } | undefined;
    if (!row) {
      const timezone = this.getPolicy().timezone;
      return { revision: 0, saved: {
        screen: { enabled: false, targetId: null, targetRevision: null, recognitionRoute: 'local-ocr', destination: 'local' },
        observationIntervalMs: 300_000, replyCooldownMs: 1_800_000, dailyMax: 8, timezone,
        dndStartHour: 0, dndEndHour: 8,
        greetingRules: [{ id: 'sleep', enabled: false, localTime: '23:30', timezone }],
      } };
    }
    const stored = JSON.parse(row.preferences_json) as CompanionAutomationPreferences;
    const timezone = this.getPolicy().timezone;
    const saved: CompanionAutomationPreferences = {
      ...stored, timezone,
      greetingRules: stored.greetingRules.map(rule => ({ ...rule, timezone })),
    };
    validateCompanionAutomationPreferences(saved);
    return { revision: Number(row.revision), saved };
  }

  /** Persist one automation preference revision; this never issues or broadens a capture grant. */
  async setAutomationPreferences(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly patch: Partial<Omit<CompanionAutomationPreferences, 'screen'>> & { readonly screen?: Partial<CompanionAutomationPreferences['screen']> };
  }, validateTarget?: () => void): Promise<CompanionAutomationPreferencesRecord> {
    return this.#idempotent(input.operationId, ['setAutomationPreferences', JSON.stringify(this.pairing), JSON.stringify(input)], async () => {
      const current = this.getAutomationPreferences();
      if (current.revision !== input.expectedRevision) throw new CompanionModeError('version_conflict', 'Automation preference revision is stale.');
      validateTarget?.();
      const saved: CompanionAutomationPreferences = {
        ...current.saved,
        ...input.patch,
        screen: { ...current.saved.screen, ...input.patch.screen,
          ...(input.patch.screen?.targetId === null && input.patch.screen.targetRevision === undefined ? { targetRevision: null } : {}) },
        greetingRules: input.patch.greetingRules ? structuredClone(input.patch.greetingRules) : current.saved.greetingRules,
      };
      validateCompanionAutomationPreferences(saved);
      if (saved.timezone !== this.getPolicy().timezone) throw new CompanionModeError('invalid_request', 'Timezone remains owned by the existing CompanionMode policy.');
      const next = { revision: current.revision + 1, saved };
      await this.onAutomationPreferencesChange?.(next);
      this.db.prepare(`INSERT INTO companion_automation_preferences(user_id, character_id, character_instance_id, revision, preferences_json, updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(user_id, character_id, character_instance_id) DO UPDATE SET
        revision=excluded.revision, preferences_json=excluded.preferences_json, updated_at=excluded.updated_at`)
        .run(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId, next.revision, JSON.stringify(saved), this.now());
      return next;
    });
  }

  /** Idempotent update of Companion Mode Policy. Does NOT issue or modify source grants. */
  async setPolicy(input: {
    readonly mode: CompanionMode;
    readonly observationIntervalMs: number;
    readonly dailyLocalTime: string;
    readonly timezone: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CompanionModePolicy> {
    return this.#idempotent(input.operationId, ['setPolicy', JSON.stringify(input)], async () => {
      const current = this.getPolicy();
      if (current.revision !== input.expectedRevision) {
        throw new CompanionModeError('version_conflict', 'Policy revision is stale.');
      }

      const next: CompanionModePolicy = {
        schemaVersion: 1,
        revision: current.revision + 1,
        pairing: this.pairing,
        mode: input.mode,
        observationIntervalMs: input.observationIntervalMs,
        dailyLocalTime: input.dailyLocalTime,
        timezone: input.timezone,
        policyVersion: current.policyVersion + 1,
      };
      validateCompanionModePolicy(next);

      this.db.prepare(`
        INSERT INTO companion_mode_policy(
          user_id, character_id, character_instance_id, mode, observation_interval_ms,
          daily_local_time, timezone, policy_version, revision, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, character_id, character_instance_id) DO UPDATE SET
          mode=excluded.mode,
          observation_interval_ms=excluded.observation_interval_ms,
          daily_local_time=excluded.daily_local_time,
          timezone=excluded.timezone,
          policy_version=excluded.policy_version,
          revision=excluded.revision,
          updated_at=excluded.updated_at
      `).run(
        this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId,
        next.mode, next.observationIntervalMs, next.dailyLocalTime, next.timezone,
        next.policyVersion, next.revision, this.now(),
      );

      // If switched from active to passive: bump generation to cancel active screen observations
      if (current.mode === 'active' && next.mode === 'passive') {
        this.#bumpGeneration();
      }

      return next;
    });
  }

  /** Pause all collection and observation tasks across all sources. */
  async pauseAll(reason: string, operationId: string = randomUUID()): Promise<ModeStatus> {
    return this.#idempotent(operationId, ['pauseAll', reason], async () => {
      this.runState = 'paused';
      this.#bumpGeneration();
      for (const kind of [...this.leases]) {
        this.leases.delete(kind);
        await this.onSourceSync?.(kind, false).catch(() => undefined);
      }
      return this.getStatus(reason);
    });
  }

  /** Resume collection and observation tasks for still-valid active grants. */
  async resume(operationId: string = randomUUID()): Promise<ModeStatus> {
    return this.#idempotent(operationId, ['resume'], async () => {
      this.runState = 'running';
      this.#bumpGeneration();
      const sources = this.listGrants();
      for (const source of sources) {
        if (source.state === 'active' && Date.parse(source.expiresAt) > Date.parse(this.now())) {
          this.leases.add(source.kind);
          await this.onSourceSync?.(source.kind, true).catch(() => {
            this.leases.delete(source.kind);
          });
        }
      }
      return this.getStatus();
    });
  }

  /** Handle OS session lock or system sleep: automatically pauses collection. */
  async onSessionLock(): Promise<void> {
    await this.pauseAll('session_locked');
  }

  /** Issue or re-authorize an individual source grant. */
  async activateSource(input: {
    readonly kind: CompanionSourceKind;
    readonly scope?: SourceGrantScope;
    readonly purposes?: readonly SourceGrantPurpose[];
    readonly destination?: SourceGrantDestination;
    readonly expiresAt: string;
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly userConfirmed: boolean;
  }): Promise<SourceGrant> {
    if (!input.userConfirmed) {
      throw new CompanionModeError('forbidden', 'Explicit confirmation required to activate source.');
    }
    return this.#idempotent(input.operationId, ['activateSource', JSON.stringify(input)], async () => {
      const existing = this.getGrant(input.kind);
      if (!existing) {
        if (input.expectedRevision !== 0) {
          throw new CompanionModeError('version_conflict', 'expectedRevision must be 0 for new grant.');
        }
        const grant: SourceGrant = {
          schemaVersion: 1,
          grantId: randomUUID(),
          revision: 1,
          pairing: this.pairing,
          kind: input.kind,
          scope: input.scope ?? {},
          purposes: input.purposes ?? ['receive'],
          destination: input.destination ?? 'local',
          grantedAt: this.now(),
          expiresAt: input.expiresAt,
          profile: 'normal',
          state: 'active',
        };
        this.#insertGrant(grant);
        if (this.runState === 'running') {
          this.leases.add(input.kind);
          await this.onSourceSync?.(input.kind, true).catch(() => {
            this.leases.delete(input.kind);
          });
        }
        return grant;
      }

      if (existing.revision !== input.expectedRevision) {
        throw new CompanionModeError('version_conflict', 'Grant revision is stale.');
      }

      const nextGrant: SourceGrant = {
        ...existing,
        revision: existing.revision + 1,
        scope: input.scope ?? existing.scope,
        purposes: input.purposes ?? existing.purposes,
        destination: input.destination ?? existing.destination,
        expiresAt: input.expiresAt,
        state: 'active',
      };
      this.#updateGrant(nextGrant);
      if (this.runState === 'running') {
        this.leases.add(input.kind);
        await this.onSourceSync?.(input.kind, true).catch(() => {
          this.leases.delete(input.kind);
        });
      }
      return nextGrant;
    });
  }

  /** Transition single source grant (pause, resume, stop, revoke) without affecting other sources. */
  async transitionSource(input: {
    readonly kind: CompanionSourceKind;
    readonly action: 'pause' | 'resume' | 'stop' | 'revoke';
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<SourceGrant> {
    return this.#idempotent(input.operationId, ['transitionSource', JSON.stringify(input)], async () => {
      const existing = this.getGrant(input.kind);
      if (!existing) {
        throw new CompanionModeError('not_found', 'Source grant not found.');
      }
      if (existing.revision !== input.expectedRevision) {
        throw new CompanionModeError('version_conflict', 'Grant revision is stale.');
      }

      let nextState: SourceGrantState;
      switch (input.action) {
        case 'pause':
          nextState = 'paused';
          break;
        case 'resume':
          if (Date.parse(existing.expiresAt) <= Date.parse(this.now())) {
            throw new CompanionModeError('expired', 'Grant expired while paused.');
          }
          nextState = 'active';
          break;
        case 'stop':
          nextState = 'stopped';
          break;
        case 'revoke':
          nextState = 'revoked';
          break;
      }

      const nextGrant: SourceGrant = {
        ...existing,
        revision: existing.revision + 1,
        state: nextState,
      };
      this.#updateGrant(nextGrant);

      // Single source lease control: never call suspendAll here!
      if (nextState === 'active' && this.runState === 'running') {
        this.leases.add(input.kind);
        await this.onSourceSync?.(input.kind, true).catch(() => {
          this.leases.delete(input.kind);
        });
      } else {
        this.leases.delete(input.kind);
        await this.onSourceSync?.(input.kind, false).catch(() => undefined);
      }

      return nextGrant;
    });
  }

  getGrant(kind: CompanionSourceKind): SourceGrant | null {
    const row = this.db.prepare(`
      SELECT * FROM companion_mode_grants
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND kind=?
    `).get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId, kind) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.#rowToGrant(row);
  }

  listGrants(): readonly SourceGrant[] {
    const rows = this.db.prepare(`
      SELECT * FROM companion_mode_grants
      WHERE user_id=? AND character_id=? AND character_instance_id=?
    `).all(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId) as Record<string, unknown>[];
    return rows.map(r => this.#rowToGrant(r));
  }

  getContextUseGrant(): ContextUseGrant | null {
    const row = this.db.prepare(`SELECT * FROM companion_context_use_grants
      WHERE user_id=? AND character_id=? AND character_instance_id=?`)
      .get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const grant: ContextUseGrant = {
      schemaVersion: 1,
      grantId: String(row.grant_id),
      revision: Number(row.revision),
      pairing: this.pairing,
      observationSourceScopes: JSON.parse(String(row.observation_source_scopes_json)) as string[],
      modelBinding: String(row.model_binding),
      destination: row.destination as SourceGrantDestination,
      expiry: String(row.expiry),
      state: row.state as SourceGrantState,
    };
    if (grant.state === 'active' && Date.parse(grant.expiry) <= Date.parse(this.now())) return { ...grant, state: 'expired' };
    return grant;
  }

  async issueContextUseGrant(input: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly observationSourceScopes: readonly string[];
    readonly modelBinding: string;
    readonly destination: ContextUseGrant['destination'];
    readonly ttlMs: number;
  }): Promise<ContextUseGrant> {
    const signature = JSON.stringify({ observationSourceScopes: input.observationSourceScopes,
      modelBinding: input.modelBinding, destination: input.destination, ttlMs: input.ttlMs });
    return this.#idempotent(input.operationId, ['issueContextUseGrant', signature], async () => {
      if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 24 * 60 * 60 * 1000) {
        throw new CompanionModeError('invalid_request', 'Context grant duration is invalid.');
      }
      const current = this.getContextUseGrant();
      const currentRevision = current?.revision ?? 0;
      if (input.expectedRevision !== currentRevision) throw new CompanionModeError('version_conflict', 'Context grant revision is stale.');
      const grant: ContextUseGrant = {
        schemaVersion: 1,
        grantId: `context-${randomUUID()}`,
        revision: currentRevision + 1,
        pairing: this.pairing,
        observationSourceScopes: [...input.observationSourceScopes],
        modelBinding: input.modelBinding,
        destination: input.destination,
        expiry: new Date(Date.parse(this.now()) + input.ttlMs).toISOString(),
        state: 'active',
      };
      validateContextUseGrant(grant);
      this.db.prepare(`INSERT INTO companion_context_use_grants(
        user_id, character_id, character_instance_id, grant_id, revision,
        observation_source_scopes_json, model_binding, destination, expiry, state)
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, character_id, character_instance_id) DO UPDATE SET
        grant_id=excluded.grant_id, revision=excluded.revision,
        observation_source_scopes_json=excluded.observation_source_scopes_json,
        model_binding=excluded.model_binding, destination=excluded.destination,
        expiry=excluded.expiry, state=excluded.state`)
        .run(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId,
          grant.grantId, grant.revision, JSON.stringify(grant.observationSourceScopes), grant.modelBinding,
          grant.destination, grant.expiry, grant.state);
      try { await this.onContextUseGrantChange?.(grant); } catch { /* Persisted grant remains authoritative; cancellation is best-effort. */ }
      return grant;
    });
  }

  async revokeContextUseGrant(input: { readonly grantId: string; readonly expectedRevision: number; readonly operationId: string }): Promise<ContextUseGrant> {
    return this.#idempotent(input.operationId, ['revokeContextUseGrant', JSON.stringify(input)], async () => {
      const current = this.getContextUseGrant();
      if (!current || current.grantId !== input.grantId) throw new CompanionModeError('not_found', 'Context grant not found.');
      if (current.revision !== input.expectedRevision) throw new CompanionModeError('version_conflict', 'Context grant revision is stale.');
      const revoked: ContextUseGrant = { ...current, revision: current.revision + 1, state: 'revoked' };
      this.db.prepare(`UPDATE companion_context_use_grants SET revision=?, state=?
        WHERE user_id=? AND character_id=? AND character_instance_id=? AND grant_id=?`)
        .run(revoked.revision, revoked.state, this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId, revoked.grantId);
       try { await this.onContextUseGrantChange?.(null); } catch { /* Revoke is durable even if best-effort cancellation fails. */ }
      return revoked;
    });
  }

  registerCompanionTrigger(input: {
    readonly operationId: string;
    readonly kind: CompanionTriggerKind;
    readonly outcome: CompanionTriggerOutcome;
    readonly reason?: string;
    readonly runtimeSessionId: string;
    readonly generation: number;
  }): CompanionTriggerRecord {
    if (!input.operationId.trim() || input.operationId.length > 200 || !input.runtimeSessionId.trim()
      || (input.reason !== undefined && !/^[a-z0-9_-]{1,100}$/i.test(input.reason))
      || !Number.isSafeInteger(input.generation) || input.generation < 0
      || !['screen', 'greeting'].includes(input.kind)
      || !['accepted', 'busy', 'needs-authorization', 'unavailable'].includes(input.outcome)) {
      throw new CompanionModeError('invalid_request', 'Invalid companion trigger registration.');
    }
    const triggerId = `rwr10-trigger-${Buffer.from(input.operationId, 'utf8').toString('base64url')}`;
    const signature = JSON.stringify({ pairing: this.pairing, kind: input.kind });
    const existing = this.db.prepare('SELECT signature,result_json FROM companion_mode_operations WHERE operation_id=?')
      .get(triggerId) as Record<string, unknown> | undefined;
    if (existing) {
      if (String(existing.signature) !== signature) throw new CompanionModeError('operation_conflict', 'Trigger operation ID conflicts with a different request.');
      return JSON.parse(String(existing.result_json)) as CompanionTriggerRecord;
    }
    const now = this.now();
    const record: CompanionTriggerRecord = {
      triggerId, pairing: this.pairing, runtimeSessionId: input.runtimeSessionId, generation: input.generation,
      kind: input.kind, outcome: input.outcome, status: input.outcome === 'accepted' ? 'accepted' : 'failed',
      ...(input.reason ? { reason: input.reason } : {}), createdAt: now, updatedAt: now,
    };
    this.db.prepare('INSERT INTO companion_mode_operations(operation_id,signature,result_json,created_at) VALUES(?,?,?,?)')
      .run(triggerId, signature, JSON.stringify(record), now);
    return record;
  }

  getCompanionTrigger(triggerId: string, pairing: PairingScope): CompanionTriggerRecord | null {
    const row = this.db.prepare('SELECT result_json FROM companion_mode_operations WHERE operation_id=?')
      .get(triggerId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const record = JSON.parse(String(row.result_json)) as CompanionTriggerRecord;
    this.#assertTriggerPairing(record.pairing, pairing);
    return record;
  }

  transitionCompanionTrigger(input: {
    readonly triggerId: string;
    readonly pairing: PairingScope;
    readonly runtimeSessionId: string;
    readonly generation: number;
    readonly status: CompanionTriggerState;
    readonly reason?: string;
    readonly observationId?: string;
    readonly turnScope?: import('../contracts/index.js').TurnScope;
  }): CompanionTriggerRecord {
    const current = this.getCompanionTrigger(input.triggerId, input.pairing);
    if (!current) throw new CompanionModeError('not_found', 'Companion trigger not found.');
    if (current.runtimeSessionId !== input.runtimeSessionId || current.generation !== input.generation) {
      throw new CompanionModeError('forbidden', 'Trigger belongs to a stale session or generation.');
    }
    if (current.status === input.status) {
      const enriched: CompanionTriggerRecord = { ...current,
        ...(input.observationId ? { observationId: input.observationId } : {}),
        ...(input.turnScope ? { turnScope: input.turnScope } : {}),
        ...((input.observationId && input.observationId !== current.observationId) || (input.turnScope && !current.turnScope)
          ? { updatedAt: this.now() } : {}) };
      if (enriched !== current && (enriched.observationId !== current.observationId || enriched.turnScope !== current.turnScope)) {
        this.db.prepare('UPDATE companion_mode_operations SET result_json=? WHERE operation_id=?').run(JSON.stringify(enriched), input.triggerId);
      }
      return enriched;
    }
    const terminal = ['delivered', 'no-content', 'cancelled', 'failed'].includes(current.status);
    if (terminal) throw new CompanionModeError('version_conflict', 'Trigger is already terminal.');
    const allowed: Record<CompanionTriggerState, readonly CompanionTriggerState[]> = {
      accepted: ['captured', 'no-content', 'cancelled', 'failed'],
      captured: ['recognized', 'no-content', 'cancelled', 'failed'],
      recognized: ['generating', 'no-content', 'cancelled', 'failed'],
      generating: ['delivered', 'cancelled', 'failed'],
      delivered: [], 'no-content': [], cancelled: [], failed: [],
    };
    if (!allowed[current.status].includes(input.status)) throw new CompanionModeError('version_conflict', 'Invalid trigger state transition.');
    if (input.reason !== undefined && !/^[a-z0-9_-]{1,100}$/i.test(input.reason)) throw new CompanionModeError('invalid_request', 'Invalid trigger reason.');
    const next: CompanionTriggerRecord = {
      ...current, status: input.status, updatedAt: this.now(),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.observationId ? { observationId: input.observationId } : {}),
      ...(input.turnScope ? { turnScope: input.turnScope } : {}),
    };
    this.db.prepare('UPDATE companion_mode_operations SET result_json=? WHERE operation_id=?')
      .run(JSON.stringify(next), input.triggerId);
    return next;
  }

  recoverInterruptedCompanionTriggers(runtimeSessionId: string): number {
    const rows = this.db.prepare("SELECT operation_id,result_json FROM companion_mode_operations WHERE operation_id LIKE 'rwr10-trigger-%'")
      .all() as Record<string, unknown>[];
    let recovered = 0;
    for (const row of rows) {
      const record = JSON.parse(String(row.result_json)) as CompanionTriggerRecord;
      if (record.runtimeSessionId === runtimeSessionId || ['delivered', 'no-content', 'cancelled', 'failed'].includes(record.status)) continue;
      const failed: CompanionTriggerRecord = { ...record, status: 'failed', reason: 'backend_restarted', updatedAt: this.now() };
      this.db.prepare('UPDATE companion_mode_operations SET result_json=? WHERE operation_id=?')
        .run(JSON.stringify(failed), String(row.operation_id));
      recovered++;
    }
    return recovered;
  }

  #assertTriggerPairing(actual: PairingScope, expected: PairingScope): void {
    if (actual.userId !== expected.userId || actual.characterId !== expected.characterId
      || actual.characterInstanceId !== expected.characterInstanceId) {
      throw new CompanionModeError('forbidden', 'Trigger pairing does not match this runtime.');
    }
  }

  getStatus(reasonCode: string | null = null): ModeStatus {
    const policy = this.getPolicy();
    const grants = this.listGrants();
    const effectiveSources = grants.map(grant => ({
      kind: grant.kind,
      state: grant.state,
      hasLease: this.leases.has(grant.kind),
      lastSuccessAt: null,
      lastErrorCode: null,
    }));

    return {
      policy,
      runState: this.runState,
      generation: this.generation,
      reasonCode,
      effectiveSources,
      observationState: {
        lastRunAt: null,
        nextRunAt: null,
        activeJobId: null,
      },
      batchState: {
        lastSuccessDay: null,
        activeJobId: null,
      },
    };
  }

  #bumpGeneration(): void {
    this.generation++;
    this.onGenerationChange?.(this.generation);
  }

  #insertGrant(grant: SourceGrant): void {
    this.db.prepare(`
      INSERT INTO companion_mode_grants(
        grant_id, user_id, character_id, character_instance_id, kind,
        scope_json, purposes_json, destination, profile, state,
        revision, granted_at, expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      grant.grantId, this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId,
      grant.kind, JSON.stringify(grant.scope), JSON.stringify(grant.purposes),
      grant.destination, grant.profile, grant.state, grant.revision,
      grant.grantedAt, grant.expiresAt,
    );
  }

  #updateGrant(grant: SourceGrant): void {
    this.db.prepare(`
      UPDATE companion_mode_grants SET
        scope_json=?, purposes_json=?, destination=?, profile=?, state=?,
        revision=?, expires_at=?
      WHERE grant_id=? AND user_id=? AND character_id=? AND character_instance_id=?
    `).run(
      JSON.stringify(grant.scope), JSON.stringify(grant.purposes),
      grant.destination, grant.profile, grant.state, grant.revision,
      grant.expiresAt, grant.grantId, this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId,
    );
  }

  #rowToGrant(row: Record<string, unknown>): SourceGrant {
    return {
      schemaVersion: 1,
      grantId: String(row.grant_id),
      revision: Number(row.revision),
      pairing: this.pairing,
      kind: row.kind as CompanionSourceKind,
      scope: JSON.parse(String(row.scope_json)) as SourceGrantScope,
      purposes: JSON.parse(String(row.purposes_json)) as SourceGrantPurpose[],
      destination: row.destination as SourceGrantDestination,
      profile: row.profile as 'normal' | 'smoke',
      state: row.state as SourceGrantState,
      grantedAt: String(row.granted_at),
      expiresAt: String(row.expires_at),
    };
  }

  async #idempotent<T>(operationId: string, signatureParts: readonly string[], act: () => Promise<T>): Promise<T> {
    const signature = signatureParts.join('\u0000');
    const existing = this.db.prepare('SELECT signature, result_json FROM companion_mode_operations WHERE operation_id=?').get(operationId) as { signature: string; result_json: string } | undefined;
    if (existing) {
      if (existing.signature !== signature) {
        throw new CompanionModeError('invalid_request', 'Operation ID reused with conflicting body.');
      }
      return JSON.parse(existing.result_json) as T;
    }
    const result = await act();
    this.db.prepare('INSERT INTO companion_mode_operations(operation_id, signature, result_json, created_at) VALUES(?,?,?,?)')
      .run(operationId, signature, JSON.stringify(result), this.now());
    return result;
  }
}

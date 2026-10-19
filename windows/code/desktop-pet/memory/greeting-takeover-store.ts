/**
 * memory/greeting-takeover-store.ts
 *
 * CK-14: durable takeover state for the old->new greeting handover.
 *
 * The handshake (`legacy-active → legacy-stopped → ready`) decides which component is allowed to
 * speak. If that state lives only in memory, a crash between "old timer stopped" and "new path
 * ready" restarts the process in `legacy-active` and **speaks twice** once the new path also
 * becomes live — exactly the double-timer failure the handshake exists to prevent.
 *
 * So the phase, the migrated legacy values and the migration version are persisted. The store is
 * deliberately tiny: it records *consent provenance*, not greetings, and it joins the same SQLite
 * the companion already uses rather than opening a second database.
 */

import type Database from 'better-sqlite3';

export type TakeoverPhase = 'legacy-active' | 'legacy-stopped' | 'ready' | 'failed';

export interface StoredTakeoverState {
  readonly pairingKey: string;
  readonly phase: TakeoverPhase;
  readonly migrationVersion: number;
  /** The legacy `localGreeting` value carried across, so a user who turned it off stays off. */
  readonly migratedEnabled: boolean;
  readonly migratedLastShownAt: number | null;
  /** Set when the takeover failed, so the reason survives the restart for diagnosis. */
  readonly reason: string | null;
  readonly updatedAt: string;
}

function pairKeyOf(pairing: { userId: string; characterId: string; characterInstanceId: string }): string {
  return `${pairing.userId}|${pairing.characterId}|${pairing.characterInstanceId}`;
}

export class GreetingTakeoverStore {
  private constructor(private readonly db: Database.Database, private readonly now: () => string) {}

  static open(
    db: Database.Database | { rawDatabaseForKnowledge(): Database.Database },
    now: () => string = () => new Date().toISOString(),
  ): GreetingTakeoverStore {
    const handle = 'rawDatabaseForKnowledge' in db ? db.rawDatabaseForKnowledge() : db;
    handle.exec(`
      CREATE TABLE IF NOT EXISTS companion_greeting_takeover (
        pairing_key TEXT PRIMARY KEY,
        phase TEXT NOT NULL CHECK(phase IN ('legacy-active','legacy-stopped','ready','failed')),
        migration_version INTEGER NOT NULL,
        migrated_enabled INTEGER NOT NULL CHECK(migrated_enabled IN (0,1)),
        migrated_last_shown_at INTEGER,
        reason TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    return new GreetingTakeoverStore(handle, now);
  }

  /**
   * Read the stored state.
   *
   * An absent row means this pairing has never run the handshake, which is `legacy-active` at
   * version 0 — the old behaviour, not the new one. Defaulting to `ready` would silently start the
   * new greeter on a fresh install.
   */
  read(pairing: { userId: string; characterId: string; characterInstanceId: string }): StoredTakeoverState {
    const row = this.db.prepare('SELECT * FROM companion_greeting_takeover WHERE pairing_key=?')
      .get(pairKeyOf(pairing)) as Record<string, unknown> | undefined;
    if (!row) {
      return Object.freeze({
        pairingKey: pairKeyOf(pairing), phase: 'legacy-active' as TakeoverPhase, migrationVersion: 0,
        migratedEnabled: true, migratedLastShownAt: null, reason: null, updatedAt: this.now(),
      });
    }
    return Object.freeze({
      pairingKey: String(row.pairing_key),
      phase: row.phase as TakeoverPhase,
      migrationVersion: Number(row.migration_version),
      migratedEnabled: Number(row.migrated_enabled) === 1,
      migratedLastShownAt: row.migrated_last_shown_at === null ? null : Number(row.migrated_last_shown_at),
      reason: row.reason === null ? null : String(row.reason),
      updatedAt: String(row.updated_at),
    });
  }

  /**
   * Advance the handshake, refusing to move backwards.
   *
   * Monotonic on purpose: a stale caller that still believes the legacy timer is running must not
   * be able to demote a `ready` pairing back to `legacy-active`, which would re-open the
   * double-speak window.
   */
  write(pairing: { userId: string; characterId: string; characterInstanceId: string }, state: {
    readonly phase: TakeoverPhase;
    readonly migrationVersion: number;
    readonly migratedEnabled: boolean;
    readonly migratedLastShownAt: number | null;
    readonly reason?: string | null;
  }): StoredTakeoverState {
    const current = this.read(pairing);
    // `failed` is a diagnostic marker, not a position in the sequence, so it is always writable and
    // always overwritable. The monotonic rule applies only to the three real phases.
    const order: readonly TakeoverPhase[] = ['legacy-active', 'legacy-stopped', 'ready'];
    const rank = (phase: TakeoverPhase): number => order.indexOf(phase);
    if (state.phase !== 'failed' && current.phase !== 'failed' && rank(state.phase) < rank(current.phase)) {
      // Refuse the regression but keep the newer state intact.
      return current;
    }
    this.db.prepare(`
      INSERT INTO companion_greeting_takeover(pairing_key,phase,migration_version,migrated_enabled,migrated_last_shown_at,reason,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(pairing_key) DO UPDATE SET
        phase=excluded.phase, migration_version=excluded.migration_version,
        migrated_enabled=excluded.migrated_enabled, migrated_last_shown_at=excluded.migrated_last_shown_at,
        reason=excluded.reason, updated_at=excluded.updated_at
    `).run(
      pairKeyOf(pairing), state.phase, state.migrationVersion,
      state.migratedEnabled ? 1 : 0, state.migratedLastShownAt,
      state.reason ?? null, this.now(),
    );
    return this.read(pairing);
  }

  /**
   * A crash during the handshake comes back as `legacy-active`.
   *
   * That is the safe direction: the OLD greeter keeps working (the user still gets greetings) while
   * the new one stays silent, instead of neither speaking or both speaking.
   */
  recoverAfterCrash(pairing: { userId: string; characterId: string; characterInstanceId: string }): StoredTakeoverState {
    const current = this.read(pairing);
    if (current.phase !== 'ready') return current;
    // A `ready` pairing whose runtime died before confirming stays ready: the legacy timer is
    // already stopped, so demoting would leave nobody speaking.
    return current;
  }
}
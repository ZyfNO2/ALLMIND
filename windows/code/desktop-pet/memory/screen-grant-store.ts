/**
 * memory/screen-grant-store.ts
 *
 * CK-10: durable screen-grant consent.
 *
 * CK-00's audit found the gap this closes: `CaptureGrantManager` and `ScreenGrantRuntime` kept
 * every grant, target and operation receipt in **in-process Maps**. A restart therefore forgot
 * both the consent and the fact that a chooser had already been shown, and a "persistent" grant was
 * really only a grant for the lifetime of the process.
 *
 * This store is the minimum durable authority the runtime consumes. It is deliberately thin — the
 * schema is added to the SAME SQLite the companion already uses (no new database, no second
 * account), and it stores only consent state: scope, target, purpose, destination, consent
 * revision, expiry and status.
 *
 * The rule that shapes the whole design: **a persisted grant is history, not a live capability.**
 * On rebuild, a record that was `active` comes back as `paused` with `needsValidation`, because the
 * old session, HWND and screen geometry no longer exist. Nothing resumes capturing until the new
 * runtime re-selects a target and issues a fresh grant revision.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PairingScope } from '../contracts/character-pack.js';

/** The versioned purposes CK-10 separates. `local-continuous` v1 never implies any cloud purpose. */
export type ScreenGrantPurposeV2 =
  | 'capture-single'
  | 'capture-continuous-local'
  | 'capture-continuous-cloud-image'
  | 'context-use-cloud-text'
  | 'long-term-retention';

export type PersistedGrantStatus = 'active' | 'paused' | 'revoked' | 'expired' | 'consumed';

export interface PersistedScreenGrant {
  readonly id: string;
  readonly pairing: PairingScope;
  readonly purpose: ScreenGrantPurposeV2;
  readonly targetKind: 'screen' | 'window' | 'region';
  readonly targetId: string;
  readonly targetRevision: number;
  readonly destination: 'local' | 'cloud';
  readonly consentRevision: number;
  readonly consentGrantedAt: string;
  readonly expiresAt: string;
  readonly status: PersistedGrantStatus;
  /**
   * True when this record is known consent but is NOT currently usable — a restart, a changed
   * target, or a re-authorization still owed. The runtime must not capture under such a grant.
   */
  readonly needsValidation: boolean;
  readonly sessionIdAtGrant: string;
}

export interface PersistedScreenTarget {
  readonly pairingKey: string;
  readonly targetKind: 'screen' | 'window' | 'region';
  readonly targetId: string;
  readonly targetRevision: number;
  readonly displayName: string;
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly scaleFactor: number;
  readonly selectedAt: string;
}

function pairKey(pairing: PairingScope): string {
  return `${pairing.userId} ${pairing.characterId} ${pairing.characterInstanceId}`;
}

/** A stored grant this runtime may NOT use. Kept for history and for an explicit re-grant. */
export function isUsable(grant: PersistedScreenGrant, nowIso: string): boolean {
  if (grant.status !== 'active') return false;
  if (grant.needsValidation) return false;
  return Date.parse(grant.expiresAt) > Date.parse(nowIso);
}

export class ScreenGrantStore {
  private constructor(private readonly db: Database.Database) {}

  static open(db: Database.Database | { rawDatabaseForKnowledge(): Database.Database }): ScreenGrantStore {
    const handle = 'rawDatabaseForKnowledge' in db ? db.rawDatabaseForKnowledge() : db;
    handle.exec(`
      CREATE TABLE IF NOT EXISTS companion_screen_targets (
        pairing_key TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('screen','window','region')),
        target_id TEXT NOT NULL,
        target_revision INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        bounds_json TEXT NOT NULL,
        scale_factor REAL NOT NULL,
        selected_at TEXT NOT NULL,
        PRIMARY KEY(pairing_key, target_id)
      );
      CREATE TABLE IF NOT EXISTS companion_screen_grants (
        id TEXT PRIMARY KEY,
        pairing_key TEXT NOT NULL,
        purpose TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('screen','window','region')),
        target_id TEXT NOT NULL,
        target_revision INTEGER NOT NULL,
        destination TEXT NOT NULL CHECK(destination IN ('local','cloud')),
        consent_revision INTEGER NOT NULL,
        consent_granted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused','revoked','expired','consumed')),
        needs_validation INTEGER NOT NULL CHECK(needs_validation IN (0,1)),
        session_id_at_grant TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS companion_screen_grants_by_pairing
        ON companion_screen_grants(pairing_key, status);
    `);
    return new ScreenGrantStore(handle);
  }

  /** Remember a target the host actually selected. Only metadata, never pixels. */
  saveTarget(pairing: PairingScope, target: PersistedScreenTarget): void {
    this.db.prepare(`
      INSERT INTO companion_screen_targets(pairing_key,target_kind,target_id,target_revision,display_name,bounds_json,scale_factor,selected_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(pairing_key,target_id) DO UPDATE SET
        target_revision=excluded.target_revision, display_name=excluded.display_name,
        bounds_json=excluded.bounds_json, scale_factor=excluded.scale_factor, selected_at=excluded.selected_at
    `).run(
      pairKey(pairing), target.targetKind, target.targetId, target.targetRevision, target.displayName,
      JSON.stringify(target.bounds), target.scaleFactor, target.selectedAt,
    );
  }

  loadTarget(pairing: PairingScope, targetId: string): PersistedScreenTarget | null {
    const row = this.db.prepare('SELECT * FROM companion_screen_targets WHERE pairing_key=? AND target_id=?')
      .get(pairKey(pairing), targetId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return Object.freeze({
      pairingKey: String(row.pairing_key),
      targetKind: row.target_kind as PersistedScreenTarget['targetKind'],
      targetId: String(row.target_id),
      targetRevision: Number(row.target_revision),
      displayName: String(row.display_name),
      bounds: JSON.parse(String(row.bounds_json)) as PersistedScreenTarget['bounds'],
      scaleFactor: Number(row.scale_factor),
      selectedAt: String(row.selected_at),
    });
  }

  /** The most recent target this pairing selected, if any. */
  latestTarget(pairing: PairingScope): PersistedScreenTarget | null {
    const row = this.db.prepare('SELECT target_id FROM companion_screen_targets WHERE pairing_key=? ORDER BY selected_at DESC LIMIT 1')
      .get(pairKey(pairing)) as { target_id: string } | undefined;
    return row ? this.loadTarget(pairing, row.target_id) : null;
  }

  /** The caller supplies every field except `id`; `pairing` comes from the argument. */
  saveGrant(
    pairing: PairingScope,
    grant: Omit<PersistedScreenGrant, 'id' | 'pairing'> & { readonly id?: string },
  ): PersistedScreenGrant {
    const id = grant.id ?? `sgr-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO companion_screen_grants(id,pairing_key,purpose,target_kind,target_id,target_revision,destination,consent_revision,consent_granted_at,expires_at,status,needs_validation,session_id_at_grant)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, needs_validation=excluded.needs_validation, expires_at=excluded.expires_at
    `).run(
      id, pairKey(pairing), grant.purpose, grant.targetKind, grant.targetId, grant.targetRevision,
      grant.destination, grant.consentRevision, grant.consentGrantedAt, grant.expiresAt,
      grant.status, grant.needsValidation ? 1 : 0, grant.sessionIdAtGrant,
    );
    return { ...grant, id, pairing: Object.freeze({ ...pairing }) };
  }

  listGrants(pairing: PairingScope): readonly PersistedScreenGrant[] {
    const rows = this.db.prepare('SELECT * FROM companion_screen_grants WHERE pairing_key=? ORDER BY consent_granted_at ASC, id ASC')
      .all(pairKey(pairing)) as Record<string, unknown>[];
    return Object.freeze(rows.map(row => this.#hydrate(pairing, row)));
  }

  grant(pairing: PairingScope, id: string): PersistedScreenGrant | null {
    const row = this.db.prepare('SELECT * FROM companion_screen_grants WHERE pairing_key=? AND id=?')
      .get(pairKey(pairing), id) as Record<string, unknown> | undefined;
    return row ? this.#hydrate(pairing, row) : null;
  }

  setStatus(pairing: PairingScope, id: string, status: PersistedGrantStatus, needsValidation: boolean): boolean {
    const result = this.db.prepare('UPDATE companion_screen_grants SET status=?, needs_validation=? WHERE pairing_key=? AND id=?')
      .run(status, needsValidation ? 1 : 0, pairKey(pairing), id);
    return result.changes > 0;
  }

  /**
   * CK-10: on startup every `active` grant becomes `paused` + `needsValidation`.
   *
   * The consent is still visible to the user, but the old session, window handle and screen
   * geometry are gone — resuming capture under them would be capturing something nobody consented
   * to *this* time. Recovery requires an explicit re-selection and a new consent revision.
   */
  pauseAllOnStartup(pairing: PairingScope): number {
    const result = this.db.prepare(`
      UPDATE companion_screen_grants SET status='paused', needs_validation=1
      WHERE pairing_key=? AND status='active'
    `).run(pairKey(pairing));
    return result.changes;
  }

  /** Invalidate every active grant for a target (window handle reused, display unplugged, ...). */
  invalidateForTarget(pairing: PairingScope, targetId: string, targetRevision?: number): number {
    const sql = targetRevision === undefined
      ? `UPDATE companion_screen_grants SET status='paused', needs_validation=1 WHERE pairing_key=? AND target_id=? AND status='active'`
      : `UPDATE companion_screen_grants SET status='paused', needs_validation=1 WHERE pairing_key=? AND target_id=? AND target_revision=? AND status='active'`;
    const params = targetRevision === undefined
      ? [pairKey(pairing), targetId]
      : [pairKey(pairing), targetId, targetRevision];
    return this.db.prepare(sql).run(...params).changes;
  }

  #hydrate(pairing: PairingScope, row: Record<string, unknown>): PersistedScreenGrant {
    return Object.freeze({
      id: String(row.id),
      pairing: Object.freeze({ ...pairing }),
      purpose: row.purpose as ScreenGrantPurposeV2,
      targetKind: row.target_kind as PersistedScreenGrant['targetKind'],
      targetId: String(row.target_id),
      targetRevision: Number(row.target_revision),
      destination: row.destination as PersistedScreenGrant['destination'],
      consentRevision: Number(row.consent_revision),
      consentGrantedAt: String(row.consent_granted_at),
      expiresAt: String(row.expires_at),
      status: row.status as PersistedGrantStatus,
      needsValidation: Number(row.needs_validation) === 1,
      sessionIdAtGrant: String(row.session_id_at_grant),
    });
  }
}

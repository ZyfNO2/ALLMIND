import { openSync, readSync, closeSync } from 'node:fs';

/** Distinct product identity: PET1 databases are never an input to the new store. */
export const COMPANION_DATABASE_ID = 0x50455432;
/**
 * RWR-02 bumped the schema: `characters` no longer carries `CHECK(character_id = 'companion')`, and the
 * persisted `character_registry` / `role_selection` tables were added. The bump is what stops an older
 * build from writing back into an upgraded database — it rejects any version it does not know.
 */
export const COMPANION_SCHEMA_VERSION = 5;
/**
 * Versions this build upgrades in place, oldest first. A database outside this set is refused before
 * any table is touched, so a half-understood file is never migrated by guesswork.
 */
export const COMPANION_UPGRADABLE_VERSIONS: readonly number[] = Object.freeze([4]);
/** Every version this build can open: the upgradable ones plus the current one. */
export const COMPANION_SUPPORTED_VERSIONS: readonly number[] = Object.freeze([...COMPANION_UPGRADABLE_VERSIONS, COMPANION_SCHEMA_VERSION]);

/** Read only the file header before opening SQLite: even WAL/SHM creation is too late for old data. */
export function assertDatabaseFileIdentity(filename: string): void {
  let fd: number;
  try { fd = openSync(filename, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    const header = Buffer.alloc(100);
    const length = readSync(fd, header, 0, 100, 0);
    if (length === 0) return;
    if (length < 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error('foreign_database');
    const appId = header.readUInt32BE(68);
    if (appId === 0x50455431) throw new Error('legacy_database_requires_new_path');
    if (appId !== COMPANION_DATABASE_ID) throw new Error('foreign_database');
    if (!COMPANION_SUPPORTED_VERSIONS.includes(header.readUInt32BE(60))) throw new Error('unsupported_database_schema');
  } finally { closeSync(fd); }
}

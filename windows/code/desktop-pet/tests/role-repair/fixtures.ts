// RWR-00: shared anonymous fixtures for the role-repair round.
//
// These fixtures carry NO real user content: every string here is invented for the test. The
// "legacy copy" fixture reproduces the *shape* of a pre-migration installation (global knowledge
// library, singleton activation, stale preset models, a divergent settings.saved) so RWR-04 and
// RWR-03 can rehearse migration without ever touching the real `.local` database.
//
// RWR-00 rule: thresholds and limits are registered here BEFORE the implementing step runs, so a
// later step cannot widen a limit to make its own acceptance pass.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { KnowledgeLibraryStore } from '../../memory/knowledge-library.js';

/** Anonymous stand-ins. Never real personal data. */
export const ANON = Object.freeze({
  roleA: 'companion',
  roleB: 'role-b',
  userA: 'anon-user-a',
  userB: 'anon-user-b',
  instanceA: 'anon-instance-a',
  instanceB: 'anon-instance-b',
  libraryTitle: '匿名资料库',
  documentTitle: 'anon-doc.md',
  documentBody: '# 匿名标题\n\n这是测试用的匿名正文，不含任何真实个人资料。\n',
  personaA: '匿名角色A的设定正文。',
  personaB: '匿名角色B的设定正文。',
  forgottenFact: '匿名待遗忘事实：测试用户喜欢匿名颜色。',
});

/**
 * RWR-00 §5: registered limits. Frozen here; an implementing step may TIGHTEN after measurement
 * but must not relax them to reach PASS.
 */
export const RWR_LIMITS = Object.freeze({
  /** CONTRACTS §5 Lorebook ceilings. */
  lorebook: Object.freeze({
    booksPerCharacter: 16,
    entriesPerBook: 256,
    entryBodyBytes: 16 * 1024,
    keywordsPerEntry: 64,
    keywordChars: 128,
    bookSerializedBytes: 1024 * 1024,
    importTotalBytes: 1024 * 1024,
    /** Per-turn Lorebook token ceiling; must also fit the real remaining Context budget. */
    contextTokensPerTurn: 2048,
  }),
  /** CONTRACTS §4: local capability detection must terminate. */
  localCapabilityProbeMs: 10_000,
  /** CONTRACTS §4: releasing a host-managed worker must be bounded. */
  localWorkerReleaseMs: 5_000,
  /** RWR-00 §6 failure-injection points that later steps must exercise. */
  failureInjections: Object.freeze([
    'preset.memory.savePrompt',
    'preset.skins.activate',
    'preset.disk.write',
    'knowledge.migration.transaction',
  ]),
});

export interface RoleRepairFixture {
  readonly dir: string;
  readonly store: SqliteMemoryStore;
  readonly filename: string;
  track(store: SqliteMemoryStore): SqliteMemoryStore;
}

/** Temp SQLite store with guaranteed cleanup (mirrors the FIX61-06 pattern). */
export async function tempStore(t: { after(fn: () => Promise<void> | void): void }, prefix = 'rwr-00-'): Promise<RoleRepairFixture> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const filename = join(dir, 'companion.sqlite');
  const handles: SqliteMemoryStore[] = [
    new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') }),
  ];
  t.after(async () => {
    for (const handle of handles) { try { handle.close(); } catch { /* already closed */ } }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store: handles[0]!, filename, track: store => { handles.push(store); return store; } };
}

/**
 * Builds the legacy-shaped knowledge state: ONE global library with NO owner column, activated
 * through the `singleton=1` row. This is exactly what the shipped schema produces, so a migration
 * test can prove it upgrades that shape rather than a shape invented by the test.
 */
export async function seedLegacyGlobalKnowledge(fixture: RoleRepairFixture): Promise<{ libraryId: string; documentId: string }> {
  const library = await KnowledgeLibraryStore.open(fixture.store, join(fixture.dir, 'knowledge'));
  const created = await library.create(ANON.libraryTitle);
  const imported = await library.importDocuments(created.id, [{ sourceName: ANON.documentTitle, text: ANON.documentBody }]);
  await library.activate(library.revision(), created.id);
  const documentId = imported.imported[0]?.id ?? library.documents(created.id)[0]!.id;
  return { libraryId: created.id, documentId };
}

/** Writes a legacy settings file whose `saved` differs from `effective` (a pending restart). */
export async function writeLegacySettings(dir: string, value: Record<string, unknown>): Promise<string> {
  const file = join(dir, 'management-settings.json');
  await writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
  return file;
}

export async function ensureDir(path: string): Promise<string> { await mkdir(path, { recursive: true }); return path; }

// CB-06: unified character document export — reads the CURRENT committed author content and
// emits a `.aiki.md` that the CB-00 parser accepts again (round-trip).
//
// Boundary (PLAN §7 / ADR-004): author settings ONLY. Real user memory, Companion Timeline,
// private relationship state, credentials, tokens/embeddings/hashes are never emitted — the
// export is a read projection of author owners, not a backup of the running instance.
import type { CharacterPackStore } from '../memory/character-pack-store.js';
import type { LorebookStore } from '../memory/lorebook-store.js';
import type { RoleConfigurationStore } from '../management/role-configuration.js';
import { AIKI_SCHEMA_VERSION } from '../contracts/character-document.js';

export interface CharacterDocumentExportDeps {
  readonly packs: CharacterPackStore;
  readonly lorebooks: LorebookStore;
  readonly profiles: RoleConfigurationStore;
  /** Active pack id for this character (the instance pointer), or null. */
  readonly activePackIdOf: (characterId: string) => string | null;
  /** Current character label (registry display name); falls back to the document id. */
  readonly labelOf: (characterId: string) => string | null;
}

export interface CharacterDocumentExportResult {
  readonly text: string;
  readonly filename: string;
  readonly entryCount: number;
  readonly counts: { persona: number; wiki: number; story: number; state: number };
  readonly warnings: readonly string[];
}

interface SnapshotMeta {
  id: string;
  type: string;
  subtype?: string;
  title?: string;
  scope?: string;
  priority?: number;
  always?: boolean;
  keywords?: string[];
  aliases?: string[];
  tags?: string[];
  related?: string[];
  confidence?: string;
  canon?: { level?: string };
  source?: { type?: string; ref?: string };
  validFrom?: string;
  validUntil?: string;
  time?: { start?: string; end?: string };
  characters?: string[];
  locations?: string[];
  entities?: string[];
  importance?: number;
  updatedAt?: string;
  expiresAt?: string;
}

interface ExportedEntry {
  readonly id: string;
  readonly type: 'persona' | 'wiki' | 'story' | 'state';
  readonly meta: SnapshotMeta;
  readonly body: string;
  readonly keywords?: readonly string[] | undefined;
  readonly always?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly title?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly expiresAt?: string | undefined;
}

const yamlScalar = (value: string): string =>
  /^[A-Za-z0-9\u4e00-\u9fff][^:\n#]*$/.test(value) && value === value.trim() ? value : JSON.stringify(value);
const listBlock = (key: string, items: readonly string[] | undefined): string[] =>
  items && items.length > 0 ? [`${key}:`, ...items.map(item => `  - ${yamlScalar(item)}`)] : [];

/** Renders one entry with the frozen `:::entry` three-part delimiter (CB-00 §4.2). */
function renderEntry(entry: ExportedEntry): string {
  const head: string[] = [`id: ${entry.id}`, `type: ${entry.type}`];
  const meta = entry.meta;
  if (meta.subtype) head.push(`subtype: ${yamlScalar(meta.subtype)}`);
  const title = entry.title ?? meta.title;
  if (title) head.push(`title: ${yamlScalar(title)}`);
  if (meta.scope) head.push(`scope: ${yamlScalar(meta.scope)}`);
  const priority = entry.priority ?? meta.priority;
  if (priority !== undefined) head.push(`priority: ${priority}`);
  const always = entry.always ?? meta.always;
  if (always !== undefined) head.push(`always: ${always ? 'true' : 'false'}`);
  head.push(...listBlock('aliases', meta.aliases));
  head.push(...listBlock('keywords', entry.keywords ?? meta.keywords));
  head.push(...listBlock('tags', meta.tags));
  head.push(...listBlock('related', meta.related));
  if (meta.canon?.level) head.push('canon:', `  level: ${yamlScalar(meta.canon.level)}`);
  // `confidence` / `source` / `valid_from` / `valid_until` are part of the frozen meta contract:
  // dropping them would change the entry hash and turn a round-trip into a spurious update.
  if (meta.confidence) head.push(`confidence: ${yamlScalar(meta.confidence)}`);
  if (meta.source && (meta.source.type || meta.source.ref)) {
    head.push('source:');
    if (meta.source.type) head.push(`  type: ${yamlScalar(meta.source.type)}`);
    if (meta.source.ref) head.push(`  ref: ${yamlScalar(meta.source.ref)}`);
  }
  if (meta.validFrom) head.push(`valid_from: ${yamlScalar(meta.validFrom)}`);
  if (meta.validUntil) head.push(`valid_until: ${yamlScalar(meta.validUntil)}`);
  if (meta.time && (meta.time.start || meta.time.end)) {
    head.push('time:');
    if (meta.time.start) head.push(`  start: ${yamlScalar(meta.time.start)}`);
    if (meta.time.end) head.push(`  end: ${yamlScalar(meta.time.end)}`);
  }
  head.push(...listBlock('characters', meta.characters));
  head.push(...listBlock('locations', meta.locations));
  head.push(...listBlock('entities', meta.entities));
  if (meta.importance !== undefined) head.push(`importance: ${meta.importance}`);
  if (entry.updatedAt) head.push(`updated_at: ${yamlScalar(entry.updatedAt)}`);
  if (entry.expiresAt) head.push(`expires_at: ${yamlScalar(entry.expiresAt)}`);
  // The parser keeps entry bodies VERBATIM (CB-00 §4.2), so the exported body is emitted without
  // trimming: a trimmed body would re-parse to a different string and read as a spurious update.
  return `:::entry\n${head.join('\n')}\n:::\n${entry.body}\n:::`;
}

/**
 * Chooses the body to export for an owner-backed entry.
 *
 * Pristine (owner content still equals what the import wrote) → the snapshot's VERBATIM body, so a
 * round-trip is byte-stable. Hand-edited → the live owner content, so the edit is never lost.
 */
function bodyFor(live: string, snapshotBody: string | undefined): string {
  if (snapshotBody === undefined) return live;
  return live.trim() === snapshotBody.trim() ? snapshotBody : live;
}

/**
 * Exports the current committed author content as a `.aiki.md` document.
 *
 * Persona bodies come from the import snapshot in effect (a hand-edited prompt is exported as an
 * explicit extra entry so the edit is never lost); wiki facts come from the active pack; story
 * entries come from lorebook rows linked to an aiki entry id; state comes from
 * `character_author_state`.
 */
export function exportCharacterDocument(deps: CharacterDocumentExportDeps, characterId: string): CharacterDocumentExportResult {
  const warnings: string[] = [];
  const importId = deps.packs.latestCommittedAikiImport(characterId);
  const record = importId ? deps.packs.aikiImportRecord(importId) : null;
  let documentId = characterId;
  let language = 'zh-CN';
  let snapshotEntries: { meta: SnapshotMeta; body: string }[] = [];
  let snapshotAuthoring: { intro?: string; scenario?: string; first_message?: string; example_dialogue?: string } = {};
  if (record?.normalizedJson) {
    try {
      const parsed = JSON.parse(record.normalizedJson) as {
        frontmatter?: { id?: string; language?: string; authoring?: Record<string, string> };
        entries?: { meta: SnapshotMeta; body: string }[];
      };
      if (parsed.frontmatter?.id) documentId = parsed.frontmatter.id;
      if (parsed.frontmatter?.language) language = parsed.frontmatter.language;
      snapshotEntries = parsed.entries ?? [];
      snapshotAuthoring = parsed.frontmatter?.authoring ?? {};
    } catch { warnings.push('导入快照不可读：仅导出当前 owner 内容。'); }
  } else {
    warnings.push('没有已提交的导入记录：文档 id 使用角色 id。');
  }
  const byId = new Map(snapshotEntries.map(entry => [entry.meta.id, entry]));
  const entries: ExportedEntry[] = [];

  // --- persona: snapshot bodies (never reverse-split a hand-edited prompt) ---
  for (const entry of snapshotEntries) {
    if (entry.meta.type !== 'persona') continue;
    entries.push({ id: entry.meta.id, type: 'persona', meta: entry.meta, body: entry.body });
  }

  // --- wiki: the ACTIVE pack's facts (they carry the live content + import linkage) ---
  const activePackId = deps.activePackIdOf(characterId);
  const activePack = (activePackId ? deps.packs.getPack(activePackId) : null) ?? deps.packs.listPacks(characterId)[0] ?? null;
  for (const fact of activePack?.wikiFacts ?? []) {
    const source = byId.get(fact.id);
    // Strip the `## title` wrapper the apply step added, so a round-trip is byte-stable.
    const wrapped = /^##\s+(.+?)\n\n([\s\S]*)$/.exec(fact.text);
    const meta: SnapshotMeta = source?.meta ?? { id: fact.id, type: 'wiki' };
    entries.push({
      id: fact.id, type: 'wiki', meta,
      title: meta.title ?? wrapped?.[1],
      body: bodyFor(wrapped ? wrapped[2]! : fact.text, source?.body),
    });
  }

  // --- story: lorebook rows carrying an aiki entry id ---
  for (const book of deps.lorebooks.list(characterId)) {
    for (const loreEntry of book.entries) {
      const aikiId = loreEntry.aikiEntryId;
      if (!aikiId) continue;
      const source = byId.get(aikiId);
      const meta: SnapshotMeta = source?.meta ?? { id: aikiId, type: 'story' };
      entries.push({
        id: aikiId, type: 'story', meta,
        title: meta.title ?? loreEntry.title,
        keywords: loreEntry.keywords.length > 0 ? [...loreEntry.keywords] : meta.keywords,
        always: loreEntry.strategy === 'always',
        body: bodyFor(loreEntry.content, source?.body),
      });
    }
  }

  // --- state: the current author initial state ---
  for (const row of deps.packs.authorStateOf(characterId)) {
    const source = byId.get(row.entryId);
    const meta: SnapshotMeta = source?.meta ?? { id: row.entryId, type: 'state', subtype: row.subtype };
    entries.push({
      id: row.entryId, type: 'state', meta,
      title: meta.title ?? row.title,
      priority: meta.priority ?? row.priority,
      always: row.always,
      body: bodyFor(row.body, source?.body),
      ...(row.updatedAtClient ? { updatedAt: row.updatedAtClient } : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    });
  }

  // --- local prompt edits: never lost, never silently reverse-engineered ---
  const profile = deps.profiles.get(characterId);
  const label = deps.labelOf(characterId) ?? documentId;
  if (profile) {
    const authored = snapshotEntries
      .filter(entry => entry.meta.type === 'persona')
      .map(entry => `## ${entry.meta.title ?? entry.meta.id}\n\n${entry.body.trim()}`)
      .join('\n\n');
    const live = (profile as unknown as { persona?: { text?: string } }).persona?.text ?? '';
    if (live.trim() && authored.trim() && live.trim() !== authored.trim()) {
      warnings.push('人设正文有本地修改：已作为额外 persona 条目导出，原条目保持原貌。');
      entries.push({
        id: 'persona.local.edits', type: 'persona',
        meta: { id: 'persona.local.edits', type: 'persona', subtype: 'personality', title: '本地修改后的人设正文', priority: 60 },
        body: live.trim(),
      });
    }
  }

  const counts = {
    persona: entries.filter(entry => entry.type === 'persona').length,
    wiki: entries.filter(entry => entry.type === 'wiki').length,
    story: entries.filter(entry => entry.type === 'story').length,
    state: entries.filter(entry => entry.type === 'state').length,
  };
  const frontmatter: string[] = [
    '---',
    `schema: ${AIKI_SCHEMA_VERSION}`,
    `id: ${yamlScalar(documentId)}`,
    `name: ${yamlScalar(label)}`,
    `language: ${yamlScalar(language)}`,
  ];
  // Authoring block: live profile values win over the import snapshot (author edits must survive).
  const authoring: Record<string, string> = {};
  const intro = profile?.identity.intro ?? snapshotAuthoring.intro;
  const scenario = profile?.persona.scenario ?? snapshotAuthoring.scenario;
  const firstMessage = profile?.persona.firstMessage ?? snapshotAuthoring.first_message;
  const exampleDialogue = profile?.persona.exampleDialogue ?? snapshotAuthoring.example_dialogue;
  if (intro) authoring['intro'] = intro;
  if (scenario) authoring['scenario'] = scenario;
  if (firstMessage) authoring['first_message'] = firstMessage;
  if (exampleDialogue) authoring['example_dialogue'] = exampleDialogue;
  if (Object.keys(authoring).length > 0) {
    frontmatter.push('authoring:');
    for (const [key, value] of Object.entries(authoring)) frontmatter.push(`  ${key}: ${yamlScalar(value)}`);
  }
  frontmatter.push('---');
  const text = `${frontmatter.join('\n')}\n\n# ${label}\n\n${entries.map(renderEntry).join('\n\n')}\n`;
  return {
    text, filename: `${documentId}.aiki.md`, entryCount: entries.length, counts,
    warnings: Object.freeze(warnings),
  };
}

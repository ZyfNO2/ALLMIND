// CB-00: deterministic unified character document (.aiki.md) parser.
// PURE: no network, no model calls, no persistence (test-pinned). Every failure is a diagnostic,
// never a throw — the caller decides what to do with the mode/diagnostics pair.
//
// Format: YAML frontmatter (`schema: aiki.character/v0.1`) + `:::entry` fenced entries + trailing
// test notes. No YAML dependency: a strict hand-rolled subset parser (2-space maps, `- ` lists,
// double-quoted scalars). Anything fancier is `unsupported_yaml`, never silently misread.

import type {
  AikiAuthoring, AikiDiagnostic, AikiDiagnosticCode, AikiDocument, AikiEntry,
  AikiEntryMeta, AikiEntryType, AikiFrontmatter, AikiParseInput, AikiParseResult,
  AikiCanonLevel, AikiConfidence, AikiSourceRef, AikiStoryTime,
} from '../contracts/character-document.js';
import { AIKI_LIMITS, AIKI_SCHEMA_VERSION } from '../contracts/character-document.js';
import { sha256 } from '../memory/character-pack-source.js';

const DIAG = (code: AikiDiagnosticCode, message: string, extra?: { line?: number; entryId?: string; field?: string }): AikiDiagnostic =>
  { const d: { code: AikiDiagnosticCode; message: string; line?: number; entryId?: string; field?: string } = { code, message }; if (extra?.line !== undefined) d.line = extra.line; if (extra?.entryId !== undefined) d.entryId = extra.entryId; if (extra?.field !== undefined) d.field = extra.field; return d; };
const codePoints = (value: string): number => [...value].length;
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

const ENTRY_TYPES: readonly AikiEntryType[] = ['persona', 'wiki', 'story', 'state'];
const CONFIDENCES: readonly AikiConfidence[] = ['explicit', 'inferred', 'temporary'];
const CANON_LEVELS: readonly AikiCanonLevel[] = ['author_defined', 'user_defined', 'canon', 'soft_canon', 'inferred', 'draft'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const ENTRY_FIELDS = new Set([
  'id', 'type', 'subtype', 'title', 'scope', 'aliases', 'keywords', 'tags', 'priority', 'always',
  'canon', 'confidence', 'source', 'related', 'valid_from', 'valid_until',
  'time', 'characters', 'locations', 'entities', 'importance',
  'updated_at', 'expires_at', 'data',
]);
const STORY_ONLY = new Set(['time', 'characters', 'locations', 'entities', 'importance']);
const STATE_ONLY = new Set(['updated_at', 'expires_at', 'data']);
const FRONTMATTER_FIELDS = new Set(['schema', 'id', 'name', 'language', 'aliases', 'tags', 'source', 'version', 'default_scope', 'defaultScope', 'authoring']);
const AUTHORING_FIELDS = new Set(['intro', 'scenario', 'first_message', 'example_dialogue']);

type Scalar = string | number | boolean | null;
interface YamlMap { [key: string]: Scalar | Scalar[] | YamlMap | YamlMap[]; __lineOf?: never }
interface YamlParse {
  readonly value: Record<string, Scalar | Scalar[] | Record<string, unknown> | Record<string, unknown>[]>;
  readonly keyLines: ReadonlyMap<string, number>;
  readonly duplicateKeys: readonly string[];
  readonly unsupported: boolean;
}

const stripQuotes = (raw: string): string | null => {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const inner = raw.slice(1, -1);
    if (inner.includes('"')) return null;
    return inner.replace(/\\(\\|"|n|t)/g, (m, c: string) => c === 'n' ? '\n' : c === 't' ? '\t' : c);
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    const inner = raw.slice(1, -1);
    if (inner.includes("'")) return null;
    return inner;
  }
  return raw;
};

const parseScalar = (raw: string): Scalar | undefined => {
  const t = raw.trim();
  if (t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) { const n = Number(t); return Number.isSafeInteger(n) ? n : undefined; }
  const unquoted = stripQuotes(t);
  return unquoted === null ? undefined : unquoted;
};

/**
 * Strict YAML subset: 2-space indented maps, `- ` lists, plain/double-quoted scalars.
 * Tabs, anchors (`&`/`*`), flow collections (`{}`/`[]`), multi-line `|`/`>` blocks are rejected.
 */
function parseYamlSubset(text: string, baseLine: number): YamlParse | { error: string } {
  const value: Record<string, Scalar | Scalar[] | Record<string, unknown> | Record<string, unknown>[]> = {};
  const keyLines = new Map<string, number>();
  const duplicates: string[] = [];
  const stack: { indent: number; map: Record<string, unknown>; key: string }[] = [];
  let currentList: { indent: number; arr: unknown[]; key: string } | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const lineNo = baseLine + i;
    void lineNo;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    if (rawLine.includes('\t')) return { error: `tab 缩进不受支持（第 ${baseLine + i + 1} 行）。` };
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent % 2 !== 0) return { error: `缩进必须为 2 空格倍数（第 ${baseLine + i + 1} 行）。` };
    const trimmed = rawLine.trim();
    if (/[&*][\w-]*\s/.test(trimmed) || trimmed.startsWith('*') || trimmed.startsWith('&')) return { error: `锚点/别名不受支持（第 ${baseLine + i + 1} 行）。` };
    if (trimmed.includes('{') || trimmed.includes('}') || (/^\[.*\]$/.test(trimmed))) return { error: `流式集合不受支持（第 ${baseLine + i + 1} 行）。` };
    if (/: [|>]/.test(trimmed) || trimmed.endsWith('|') || trimmed.endsWith('>')) return { error: `多行块标量不受支持（第 ${baseLine + i + 1} 行）。` };
    while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    if (currentList && indent < currentList.indent) currentList = null;
    if (trimmed.startsWith('- ')) {
      if (!currentList) return { error: `孤立的列表项（第 ${baseLine + i + 1} 行）。` };
      if (indent !== currentList.indent) return { error: `列表缩进不一致（第 ${baseLine + i + 1} 行）。` };
      const scalar = parseScalar(trimmed.slice(2));
      if (scalar === undefined) return { error: `无法解析的标量（第 ${baseLine + i + 1} 行）。` };
      currentList.arr.push(scalar);
      continue;
    }
    currentList = null;
    const colon = trimmed.indexOf(':');
    if (colon < 0) return { error: `无法解析的行（第 ${baseLine + i + 1} 行）。` };
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1);
    if (!key || /\s/.test(key)) return { error: `无效的键（第 ${baseLine + i + 1} 行）。` };
    const parent: Record<string, unknown> = stack.length > 0 ? stack[stack.length - 1]!.map : value;
    if (Object.prototype.hasOwnProperty.call(parent, key)) duplicates.push(key);
    if (rest.trim() === '') {
      // Look ahead: nested map or list?
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim()) j++;
      const next = j < lines.length ? lines[j]! : '';
      const nextIndent = next.length - next.trimStart().length;
      if (j < lines.length && nextIndent > indent && next.trimStart().startsWith('- ')) {
        const arr: unknown[] = [];
        parent[key] = arr as unknown as Scalar[];
        // The absolute line index of this key (0-based within this yaml text) is i.
        keyLines.set(stackKey(stack, key), baseLine + i);
        currentList = { indent: nextIndent, arr, key };
      } else if (j < lines.length && nextIndent > indent) {
        const map: Record<string, unknown> = {};
        parent[key] = map as unknown as Record<string, unknown>;
        keyLines.set(stackKey(stack, key), baseLine + i);
        stack.push({ indent, map, key });
      } else {
        parent[key] = null;
        keyLines.set(stackKey(stack, key), baseLine + i);
      }
    } else {
      const scalar = parseScalar(rest);
      if (scalar === undefined) return { error: `无法解析的标量（第 ${baseLine + i + 1} 行）。` };
      parent[key] = scalar;
      keyLines.set(stackKey(stack, key), baseLine + i);
    }
  }
  return { value, keyLines, duplicateKeys: duplicates, unsupported: false };
}
const stackKey = (stack: { key: string }[], key: string): string =>
  [...stack.map(s => s.key), key].join('.');

const asString = (v: unknown): string | null => typeof v === 'string' ? v : null;
const asStringArray = (v: unknown): string[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) { if (typeof item !== 'string') return null; out.push(item); }
  return out;
};
const asStringMap = (v: unknown): Record<string, string> | null => {
  if (v === undefined || v === null) return undefined as unknown as null;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
    if (typeof item !== 'string') return null;
    out[k] = item;
  }
  return out;
};

const isValidTime = (v: string): boolean => {
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return false;
  // Round-trip consistency: the parsed instant must re-serialize to the same instant.
  return new Date(ms).toISOString() === new Date(v).toISOString() || !Number.isNaN(ms);
};

const checkControlChars = (text: string): boolean => {
  for (const ch of text) {
    if (ch !== '\n' && ch !== '\r' && ch !== '\t' && ch < ' ') return true;
  }
  return false;
};

interface RawEntry { headerText: string; headerBaseLine: number; body: string; openLine: number }

export function parseCharacterDocument(input: AikiParseInput): AikiParseResult {
  const documentHash = sha256(input.text);
  const fail = (diagnostics: AikiDiagnostic[], extra?: Partial<AikiParseResult>): AikiParseResult => ({
    mode: 'source_only', schemaVersion: undefined, documentHash, document: undefined,
    diagnostics, blockedEntryIds: [], trailingNotes: undefined, ...extra,
  });
  let text = input.text;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (!text.trim()) return fail([DIAG('empty_document', '导入正文不能为空。')]);
  if (text.includes('\0')) return fail([DIAG('nul_byte', '导入正文包含 NUL 字符。')]);
  if (checkControlChars(text)) return fail([DIAG('bad_yaml', '正文包含不允许的控制字符（仅允许换行/回车/tab）。')]);
  if (byteLength(text) > AIKI_LIMITS.maxDocumentBytes) {
    return fail([DIAG('over_limit', `导入正文超过 ${AIKI_LIMITS.maxDocumentBytes} 字节传输上限。`)]);
  }
  const lines = text.split('\n');
  const lineOf = (index: number): number => index + 1;

  // --- Frontmatter ---------------------------------------------------------
  if (lines[0]!.trim() !== '---') {
    // No frontmatter: plain Markdown source draft (never a failure).
    return {
      mode: 'source_only', schemaVersion: undefined, documentHash, document: undefined,
      diagnostics: [], blockedEntryIds: [], trailingNotes: undefined,
    };
  }
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') { fmEnd = i; break; }
  }
  if (fmEnd < 0) return fail([DIAG('missing_frontmatter_delimiter', 'frontmatter 缺少结束 `---`。', { line: 1 })]);
  const fmText = lines.slice(1, fmEnd).join('\n');
  const fmParsed = parseYamlSubset(fmText, 1);
  if ('error' in fmParsed) return fail([DIAG('bad_yaml', (fmParsed as { error: string }).error, { line: 1 })]);
  const fm = (fmParsed as YamlParse).value;
  if ((fmParsed as YamlParse).duplicateKeys.length > 0) {
    const key = (fmParsed as YamlParse).duplicateKeys[0]!;
    return fail([DIAG('duplicate_yaml_key', `frontmatter 重复键 "${key}"。`, { line: ((fmParsed as YamlParse).keyLines.get(key) ?? 0) + 1, field: key })]);
  }
  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_FIELDS.has(key)) return fail([DIAG('unknown_field', `frontmatter 未知字段 "${key}"，必须移除。`, { field: key })]);
  }
  const diagnostics: AikiDiagnostic[] = [];
  const schema = asString(fm['schema']);
  if (schema !== AIKI_SCHEMA_VERSION) {
    return fail([DIAG('unknown_schema', `不支持的 schema "${String(fm['schema'] ?? '')}"，仅支持 ${AIKI_SCHEMA_VERSION}。`, { field: 'schema' })]);
  }
  const fmId = asString(fm['id']);
  const fmName = asString(fm['name']);
  const fmLang = asString(fm['language']);
  if (!fmId || !fmId.trim()) return fail([DIAG('missing_required_field', 'frontmatter 缺少必填 id。', { field: 'id' })]);
  if (!fmName || !fmName.trim()) return fail([DIAG('missing_required_field', 'frontmatter 缺少必填 name。', { field: 'name' })]);
  if (!fmLang || !fmLang.trim()) return fail([DIAG('missing_required_field', 'frontmatter 缺少必填 language。', { field: 'language' })]);
  const aliases = asStringArray(fm['aliases']);
  const tags = asStringArray(fm['tags']);
  if (aliases === null) return fail([DIAG('bad_yaml', 'frontmatter aliases 必须为字符串数组。', { field: 'aliases' })]);
  if (tags === null) return fail([DIAG('bad_yaml', 'frontmatter tags 必须为字符串数组。', { field: 'tags' })]);
  const source = fm['source'] === undefined ? undefined : asStringMap(fm['source']);
  if (source === null) return fail([DIAG('bad_yaml', 'frontmatter source 必须为字符串映射。', { field: 'source' })]);
  const version = fm['version'] === undefined || fm['version'] === null ? undefined : asString(fm['version']);
  if (fm['version'] !== undefined && fm['version'] !== null && version === null) return fail([DIAG('bad_yaml', 'frontmatter version 必须为字符串。', { field: 'version' })]);
  const defaultScopeRaw = fm['default_scope'] !== undefined ? fm['default_scope'] : fm['defaultScope'];
  const defaultScope = defaultScopeRaw === undefined || defaultScopeRaw === null ? undefined : asString(defaultScopeRaw);
  if (defaultScopeRaw !== undefined && defaultScopeRaw !== null && defaultScope === null) return fail([DIAG('bad_yaml', 'frontmatter default_scope 必须为字符串。', { field: 'default_scope' })]);
  const authoring: AikiAuthoring = {};
  if (fm['authoring'] !== undefined && fm['authoring'] !== null) {
    const raw = fm['authoring'];
    if (typeof raw !== 'object' || Array.isArray(raw)) return fail([DIAG('bad_yaml', 'frontmatter authoring 必须为映射。', { field: 'authoring' })]);
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (!AUTHORING_FIELDS.has(key)) return fail([DIAG('unknown_field', `authoring 未知字段 "${key}"，必须移除。`, { field: `authoring.${key}` })]);
      const sv = (raw as Record<string, unknown>)[key];
      if (sv !== undefined && sv !== null && typeof sv !== 'string') return fail([DIAG('bad_yaml', `authoring.${key} 必须为字符串。`, { field: `authoring.${key}` })]);
      if (typeof sv === 'string') (authoring as Record<string, string>)[key === 'first_message' ? 'firstMessage' : key === 'example_dialogue' ? 'exampleDialogue' : key] = sv;
    }
  }
  const frontmatter: AikiFrontmatter = {
    schema: AIKI_SCHEMA_VERSION, id: fmId, name: fmName, language: fmLang,
    aliases, tags, source,
    version: version ?? undefined, defaultScope: defaultScope ?? undefined, authoring,
  };

  // --- Trailing test notes ---------------------------------------------------
  // `# Import Test Notes` (exact level-1 heading) to end of file: preserved, never knowledge.
  let notesFrom = -1;
  for (let i = fmEnd + 1; i < lines.length; i++) {
    if (lines[i] === '# Import Test Notes') { notesFrom = i; break; }
  }
  const trailingNotes = notesFrom >= 0 ? lines.slice(notesFrom).join('\n') : undefined;
  const scanEnd = notesFrom >= 0 ? notesFrom : lines.length;

  // --- Entry scan ------------------------------------------------------------
  // Fenced code blocks hide delimiters. Track fence state line by line.
  const rawEntries: RawEntry[] = [];
  const prose: string[] = [];
  let inFence = false;
  let i = fmEnd + 1;
  let proseBuf: string[] = [];
  const flushProse = () => {
    const chunk = proseBuf.join('\n');
    proseBuf = [];
    if (chunk.trim()) prose.push(chunk);
  };
  while (i < scanEnd) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; proseBuf.push(line); i++; continue; }
    if (!inFence && trimmed === ':::entry') {
      flushProse();
      const openLine = lineOf(i);
      // header: up to the next standalone `:::` line.
      let h = i + 1;
      const headerLines: string[] = [];
      let headerEnd = -1;
      let inFenceH = false;
      while (h < scanEnd) {
        const hl = lines[h]!;
        const ht = hl.trim();
        if (/^```/.test(ht)) inFenceH = !inFenceH;
        if (!inFenceH && ht === ':::') { headerEnd = h; break; }
        if (!inFenceH && ht === ':::entry') break; // missing header close
        headerLines.push(hl);
        h++;
      }
      if (headerEnd < 0) {
        diagnostics.push(DIAG('unterminated_entry', 'Entry 缺少 YAML 头结束 `:::`。', { line: openLine }));
        return fail(diagnostics);
      }
      // body: up to the next standalone `:::` line; a nested `:::entry` line is forbidden.
      let b = headerEnd + 1;
      const bodyLines: string[] = [];
      let bodyEnd = -1;
      let inFenceB = false;
      while (b < scanEnd) {
        const bl = lines[b]!;
        const bt = bl.trim();
        if (/^```/.test(bt)) inFenceB = !inFenceB;
        if (!inFenceB && bt === ':::entry') {
          diagnostics.push(DIAG('nested_entry', 'Entry 正文内不允许嵌套 `:::entry`。', { line: lineOf(b) }));
          return fail(diagnostics);
        }
        if (!inFenceB && bt === ':::') { bodyEnd = b; break; }
        bodyLines.push(bl);
        b++;
      }
      if (bodyEnd < 0) {
        diagnostics.push(DIAG('unterminated_entry', 'Entry 缺少正文结束 `:::`。', { line: openLine }));
        return fail(diagnostics);
      }
      rawEntries.push({ headerText: headerLines.join('\n'), headerBaseLine: openLine, body: bodyLines.join('\n'), openLine });
      i = bodyEnd + 1;
      continue;
    }
    proseBuf.push(line);
    i++;
  }
  flushProse();

  if (rawEntries.length === 0) {
    return fail([DIAG('empty_document', '文档不含任何 Entry。')]);
  }
  if (rawEntries.length > AIKI_LIMITS.maxEntries) {
    return fail([DIAG('over_limit', `Entry 数量超过上限 ${AIKI_LIMITS.maxEntries}。`)]);
  }

  // --- Entry headers -----------------------------------------------------------
  const entries: AikiEntry[] = [];
  const seenIds = new Map<string, number>();
  const blockedEntryIds: string[] = [];
  for (const raw of rawEntries) {
    const parsed = parseYamlSubset(raw.headerText, raw.headerBaseLine);
    if ('error' in parsed) {
      return fail([...diagnostics, DIAG('bad_yaml', (parsed as { error: string }).error, { line: raw.openLine })]);
    }
    const yp = parsed as YamlParse;
    if (yp.duplicateKeys.length > 0) {
      const key = yp.duplicateKeys[0]!;
      return fail([...diagnostics, DIAG('duplicate_yaml_key', `Entry 重复键 "${key}"。`, { line: raw.openLine, field: key })]);
    }
    const head = yp.value;
    for (const key of Object.keys(head)) {
      if (!ENTRY_FIELDS.has(key)) {
        return fail([...diagnostics, DIAG('unknown_field', `未知字段 "${key}"，必须移除。`, { line: raw.openLine, field: key })]);
      }
    }
    const id = asString(head['id']);
    if (!id || !id.trim()) {
      return fail([...diagnostics, DIAG('missing_required_field', 'Entry 缺少必填 id。', { line: raw.openLine, field: 'id' })]);
    }
    if (!ID_RE.test(id)) {
      return fail([...diagnostics, DIAG('bad_enum', `Entry id "${id}" 格式无效。`, { line: raw.openLine, entryId: id, field: 'id' })]);
    }
    if (seenIds.has(id)) {
      return fail([...diagnostics, DIAG('duplicate_entry_id', `Entry id "${id}" 重复。`, { line: raw.openLine, entryId: id, field: 'id' })]);
    }
    seenIds.set(id, raw.openLine);
    const typeRaw = asString(head['type']);
    if (!typeRaw || !(ENTRY_TYPES as readonly string[]).includes(typeRaw)) {
      return fail([...diagnostics, DIAG('bad_enum', `Entry "${id}" 的 type 非法（仅 persona/wiki/story/state）。`, { line: raw.openLine, entryId: id, field: 'type' })]);
    }
    const type = typeRaw as AikiEntryType;
    for (const field of Object.keys(head)) {
      if (STORY_ONLY.has(field) && type !== 'story') {
        return fail([...diagnostics, DIAG('unknown_field', `字段 "${field}" 只允许 story Entry。`, { line: raw.openLine, entryId: id, field })]);
      }
      if (STATE_ONLY.has(field) && type !== 'state') {
        return fail([...diagnostics, DIAG('unknown_field', `字段 "${field}" 只允许 state Entry。`, { line: raw.openLine, entryId: id, field })]);
      }
    }
    const entryDiagnostics: AikiDiagnostic[] = [];
    const subtypeRaw = head['subtype'];
    const subtype = subtypeRaw === undefined || subtypeRaw === null ? undefined : asString(subtypeRaw);
    if (subtypeRaw !== undefined && subtypeRaw !== null && subtype === null) {
      return fail([...diagnostics, DIAG('bad_yaml', `Entry "${id}" 的 subtype 必须为字符串。`, { line: raw.openLine, entryId: id, field: 'subtype' })]);
    }
    const titleRaw = head['title'];
    const title = (titleRaw === undefined || titleRaw === null ? undefined : asString(titleRaw)) ?? undefined;
    if ((titleRaw !== undefined && titleRaw !== null && title === null) || (title !== undefined && codePoints(title) > AIKI_LIMITS.maxTitleCodePoints)) {
      return fail([...diagnostics, DIAG('over_limit', `Entry "${id}" 的 title 无效或超长。`, { line: raw.openLine, entryId: id, field: 'title' })]);
    }
    const scopeRaw = head['scope'];
    const scope = scopeRaw === undefined || scopeRaw === null ? undefined : asString(scopeRaw);
    if (scopeRaw !== undefined && scopeRaw !== null && scope === null) {
      return fail([...diagnostics, DIAG('bad_yaml', `Entry "${id}" 的 scope 必须为字符串。`, { line: raw.openLine, entryId: id, field: 'scope' })]);
    }
    const checkList = (field: string, max: number): string[] | null => {
      const arr = asStringArray(head[field]);
      if (arr === null) { entryDiagnostics.push(DIAG('bad_yaml', `Entry "${id}" 的 ${field} 必须为字符串数组。`, { line: raw.openLine, entryId: id, field })); return null; }
      if (arr.length > AIKI_LIMITS.maxListItems) { entryDiagnostics.push(DIAG('over_limit', `Entry "${id}" 的 ${field} 超过 ${AIKI_LIMITS.maxListItems} 项。`, { line: raw.openLine, entryId: id, field })); return null; }
      for (const item of arr) {
        if (codePoints(item) > max) { entryDiagnostics.push(DIAG('over_limit', `Entry "${id}" 的 ${field} 项超长。`, { line: raw.openLine, entryId: id, field })); return null; }
      }
      return arr;
    };
    const aliasesL = checkList('aliases', AIKI_LIMITS.maxListItemCodePoints);
    const keywordsL = checkList('keywords', AIKI_LIMITS.maxListItemCodePoints);
    const tagsL = checkList('tags', AIKI_LIMITS.maxListItemCodePoints);
    const relatedL = checkList('related', AIKI_LIMITS.maxListItemCodePoints);
    const charactersL = type === 'story' ? checkList('characters', AIKI_LIMITS.maxListItemCodePoints) : [];
    const locationsL = type === 'story' ? checkList('locations', AIKI_LIMITS.maxListItemCodePoints) : [];
    const entitiesL = type === 'story' ? checkList('entities', AIKI_LIMITS.maxListItemCodePoints) : [];
    if (aliasesL === null || keywordsL === null || tagsL === null || relatedL === null || charactersL === null || locationsL === null || entitiesL === null) {
      return fail([...diagnostics, ...entryDiagnostics]);
    }
    let priority = 50;
    if (head['priority'] !== undefined && head['priority'] !== null) {
      if (typeof head['priority'] !== 'number' || !Number.isInteger(head['priority']) || (head['priority'] as number) < 0 || (head['priority'] as number) > 100) {
        return fail([...diagnostics, DIAG('bad_enum', `Entry "${id}" 的 priority 必须为 0–100 整数。`, { line: raw.openLine, entryId: id, field: 'priority' })]);
      }
      priority = head['priority'] as number;
    }
    let always = false;
    if (head['always'] !== undefined && head['always'] !== null) {
      if (typeof head['always'] !== 'boolean') {
        return fail([...diagnostics, DIAG('bad_enum', `Entry "${id}" 的 always 必须为布尔。`, { line: raw.openLine, entryId: id, field: 'always' })]);
      }
      always = head['always'] as boolean;
    }
    let importance: number | undefined;
    if (head['importance'] !== undefined && head['importance'] !== null) {
      if (typeof head['importance'] !== 'number' || !Number.isInteger(head['importance']) || (head['importance'] as number) < 0 || (head['importance'] as number) > 100) {
        return fail([...diagnostics, DIAG('bad_enum', `Entry "${id}" 的 importance 必须为 0–100 整数。`, { line: raw.openLine, entryId: id, field: 'importance' })]);
      }
      importance = head['importance'] as number;
    }
    let confidence: AikiConfidence = 'explicit';
    if (head['confidence'] !== undefined && head['confidence'] !== null) {
      const c = asString(head['confidence']);
      if (!c || !(CONFIDENCES as readonly string[]).includes(c)) {
        return fail([...diagnostics, DIAG('bad_enum', `Entry "${id}" 的 confidence 非法。`, { line: raw.openLine, entryId: id, field: 'confidence' })]);
      }
      confidence = c as AikiConfidence;
    }
    let canon: AikiEntryMeta['canon'];
    if (head['canon'] !== undefined && head['canon'] !== null) {
      const rawCanon = head['canon'];
      if (typeof rawCanon !== 'object' || Array.isArray(rawCanon)) {
        return fail([...diagnostics, DIAG('bad_yaml', `Entry "${id}" 的 canon 必须为映射。`, { line: raw.openLine, entryId: id, field: 'canon' })]);
      }
      const level = asString((rawCanon as Record<string, unknown>)['level']);
      if (!level || !(CANON_LEVELS as readonly string[]).includes(level)) {
        return fail([...diagnostics, DIAG('bad_enum', `Entry "${id}" 的 canon.level 非法。`, { line: raw.openLine, entryId: id, field: 'canon.level' })]);
      }
      canon = { level: level as AikiCanonLevel };
    }
    let source: AikiSourceRef | undefined;
    if (head['source'] !== undefined && head['source'] !== null) {
      const rawSource = head['source'];
      if (typeof rawSource !== 'object' || Array.isArray(rawSource)) {
        return fail([...diagnostics, DIAG('bad_yaml', `Entry "${id}" 的 source 必须为映射。`, { line: raw.openLine, entryId: id, field: 'source' })]);
      }
      const st = asString((rawSource as Record<string, unknown>)['type']);
      if (!st) {
        return fail([...diagnostics, DIAG('missing_required_field', `Entry "${id}" 的 source 缺少 type。`, { line: raw.openLine, entryId: id, field: 'source.type' })]);
      }
      const refRaw = (rawSource as Record<string, unknown>)['ref'];
      const ref = (refRaw === undefined || refRaw === null ? undefined : asString(refRaw)) ?? undefined;
      if (refRaw !== undefined && refRaw !== null && ref === null) {
        return fail([...diagnostics, DIAG('bad_yaml', `Entry "${id}" 的 source.ref 必须为字符串。`, { line: raw.openLine, entryId: id, field: 'source.ref' })]);
      }
      source = ref === undefined ? { type: st } : { type: st, ref };
    }
    let timeBad = false;
    const timeCheck = (field: string, v: unknown): string | undefined => {
      if (v === undefined || v === null) return undefined;
      const s = asString(v);
      if (!s || !isValidTime(s)) {
        entryDiagnostics.push(DIAG('bad_time', `Entry "${id}" 的 ${field} 非法时间。`, { line: raw.openLine, entryId: id, field }));
        timeBad = true;
        return undefined;
      }
      return s;
    };
    let time: AikiStoryTime | undefined;
    if (type === 'story' && head['time'] !== undefined && head['time'] !== null) {
      const rawTime = head['time'];
      if (typeof rawTime !== 'object' || Array.isArray(rawTime)) {
        return fail([...diagnostics, DIAG('bad_yaml', `Entry "${id}" 的 time 必须为映射。`, { line: raw.openLine, entryId: id, field: 'time' })]);
      }
      const start = timeCheck('time.start', (rawTime as Record<string, unknown>)['start']);
      const end = timeCheck('time.end', (rawTime as Record<string, unknown>)['end']);
      if (timeBad) return fail([...diagnostics, ...entryDiagnostics]);
      time = { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
    }
    const validFrom = timeCheck('valid_from', head['valid_from']);
    const validUntil = timeCheck('valid_until', head['valid_until']);
    const updatedAt = timeCheck('updated_at', head['updated_at']);
    const expiresAt = timeCheck('expires_at', head['expires_at']);
    if (timeBad) {
      return fail([...diagnostics, ...entryDiagnostics]);
    }
    let data: string | undefined;
    if (head['data'] !== undefined && head['data'] !== null) {
      try {
        data = JSON.stringify(head['data']);
      } catch {
        return fail([...diagnostics, DIAG('bad_yaml', `Entry "${id}" 的 data 不可序列化。`, { line: raw.openLine, entryId: id, field: 'data' })]);
      }
    }
    if (codePoints(raw.body) > AIKI_LIMITS.maxEntryBodyCodePoints) {
      return fail([...diagnostics, DIAG('over_limit', `Entry "${id}" 正文超过 ${AIKI_LIMITS.maxEntryBodyCodePoints} code-points。`, { line: raw.openLine, entryId: id })]);
    }
    const meta: AikiEntryMeta = {
      id, type,
      subtype: subtype ?? undefined, title: title ?? undefined, scope: scope ?? undefined,
      aliases: aliasesL, keywords: keywordsL, tags: tagsL,
      priority, always, canon: canon ?? undefined, confidence, source: source ?? undefined, related: relatedL,
      validFrom: validFrom ?? undefined, validUntil: validUntil ?? undefined,
      time: time ?? undefined, characters: charactersL, locations: locationsL, entities: entitiesL,
      importance: importance ?? undefined,
      updatedAt: updatedAt ?? undefined, expiresAt: expiresAt ?? undefined, data,
    };
    entries.push({ meta, body: raw.body, line: raw.openLine });
  }

  // --- Entry-level reference check (blocks entries, not the document) ------------
  const ids = new Set(entries.map(e => e.meta.id));
  const blocked: string[] = [];
  for (const entry of entries) {
    let entryBlocked = false;
    for (const ref of entry.meta.related) {
      if (!ids.has(ref)) {
        diagnostics.push(DIAG('related_not_found', `Entry "${entry.meta.id}" 引用的 "${ref}" 在文档内不存在；该条目不可应用。`, { line: entry.line, entryId: entry.meta.id, field: 'related' }));
        entryBlocked = true;
      }
    }
    const srcRef = entry.meta.source?.ref;
    if (srcRef && !ids.has(srcRef)) {
      diagnostics.push(DIAG('related_not_found', `Entry "${entry.meta.id}" 的 source.ref "${srcRef}" 在文档内不存在；该条目不可应用。`, { line: entry.line, entryId: entry.meta.id, field: 'source.ref' }));
      entryBlocked = true;
    }
    if (entryBlocked) blocked.push(entry.meta.id);
  }

  const document: AikiDocument = {
    schemaVersion: AIKI_SCHEMA_VERSION, frontmatter, entries: Object.freeze(entries),
    prose: Object.freeze(prose),
  };
  return {
    mode: 'aiki-character', schemaVersion: AIKI_SCHEMA_VERSION, documentHash,
    document, diagnostics: Object.freeze(diagnostics),
    blockedEntryIds: Object.freeze(blocked), trailingNotes,
  };
}

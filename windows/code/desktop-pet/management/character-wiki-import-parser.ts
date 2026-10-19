// WV0-00: deterministic character Wiki v0 import parser.
// PURE: no network, no model calls, no persistence (test-pinned). Every failure is a diagnostic,
// never a throw — the caller decides what to do with the mode/diagnostics pair.

import type {
  WikiParseInput, WikiParseResult, WikiDiagnostic, WikiNormalizedDocument,
  WikiSourceInput, WikiEvidenceLocated, WikiSourceKind, WikiFactStatus, WikiAwareness,
} from '../contracts/character-wiki-import.js';
import { WIKI_SCHEMA_VERSION, WIKI_FENCE_TAG, WIKI_LIMITS } from '../contracts/character-wiki-import.js';
import { sha256 } from '../memory/character-pack-source.js';

const DIAG = (message: string, path?: string): WikiDiagnostic => (path ? { path, message } : { message });
const codePoints = (value: string): number => [...value].length;

/** Byte length helpers on the raw submitted text. */
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Extracts the fenced `aika-wiki-v0` blocks (exact tag) with their inner JSON text. */
function extractFencedBlocks(text: string): { readonly json: string; readonly start: number; readonly end: number }[] {
  const blocks: { json: string; start: number; end: number }[] = [];
  const re = new RegExp('```' + WIKI_FENCE_TAG + '\\r?\\n([\\s\\S]*?)```', 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) blocks.push({ json: match[1]!, start: match.index, end: match.index + match[0].length });
  return blocks;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates that `quote` appears in `sourceText` and returns the requested occurrence location. */
function locateQuote(sourceText: string, quote: string, occurrence: number | undefined): { location: { start: number; end: number } } | { error: string } {
  if (!quote) return { error: '引用 quote 不能为空。' };
  const needle = [...quote];
  const haystack = [...sourceText];
  const first = needle[0]!;
  const occurrences: { start: number; end: number }[] = [];
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (haystack[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) { ok = false; break; }
    if (ok) occurrences.push({ start: i, end: i + needle.length });
  }
  if (occurrences.length === 0) return { error: `引用在来源原文中逐字找不到："${quote.slice(0, 40)}${quote.length > 40 ? '…' : ''}"。不做模糊匹配。` };
  const requested = occurrence ?? 1;
  if (!Number.isInteger(requested) || requested < 1) return { error: `occurrence 必须为从 1 开始的整数。` };
  if (requested > occurrences.length) {
    return { error: `occurrence=${requested} 超出实际出现次数 ${occurrences.length}；引用重复出现时必须给出 occurrence。` };
  }
  if (occurrence === undefined && occurrences.length > 1) {
    return { error: `该引用在来源中出现 ${occurrences.length} 次；重复出现必须提供 occurrence（从 1 开始）。` };
  }
  return { location: occurrences[requested - 1]! };
}

interface EvidenceCarrier { readonly evidence: unknown; readonly label: string }

/** Validates one evidence array in place, returning located citations or diagnostics. */
function checkEvidence(carrier: EvidenceCarrier, sourcesById: Map<string, WikiSourceInput>): { evidence: WikiEvidenceLocated[]; diagnostics: WikiDiagnostic[] } {
  const diagnostics: WikiDiagnostic[] = [], located: WikiEvidenceLocated[] = [];
  const list = carrier.evidence;
  if (!Array.isArray(list) || list.length === 0) {
    diagnostics.push(DIAG(`${carrier.label}.evidence 必须为非空数组（核心与每条事实/事件都需要真实原文引用）。`, `${carrier.label}.evidence`));
    return { evidence: located, diagnostics };
  }
  if (list.length > WIKI_LIMITS.maxEvidencePerItem) {
    diagnostics.push(DIAG(`${carrier.label}.evidence 数量超过上限 ${WIKI_LIMITS.maxEvidencePerItem}。`, `${carrier.label}.evidence`));
  }
  for (const [index, raw] of list.entries()) {
    const path = `${carrier.label}.evidence[${index}]`;
    if (!isPlainObject(raw)) { diagnostics.push(DIAG('引用必须为对象。', path)); continue; }
    const sourceId = raw['sourceId'], quote = raw['quote'], occurrence = raw['occurrence'];
    if (typeof sourceId !== 'string' || !sourceId.trim()) { diagnostics.push(DIAG('引用缺少有效 sourceId。', `${path}.sourceId`)); continue; }
    const source = sourcesById.get(sourceId);
    if (!source) { diagnostics.push(DIAG(`引用的来源 "${sourceId}" 不在 sources 中。`, `${path}.sourceId`)); continue; }
    if (typeof quote !== 'string' || !quote) { diagnostics.push(DIAG('引用缺少有效 quote。', `${path}.quote`)); continue; }
    const found = locateQuote(source.text, quote, occurrence as number | undefined);
    if ('error' in found) { diagnostics.push(DIAG(found.error, path)); continue; }
    located.push({ sourceId, quote, ...(occurrence !== undefined ? { occurrence: occurrence as number } : {}), location: found.location });
  }
  return { evidence: located, diagnostics };
}

const FACT_STATUSES: readonly WikiFactStatus[] = ['canon', 'soft_canon', 'inferred', 'draft'];
const AWARENESS: readonly WikiAwareness[] = ['experienced', 'heard', 'unknown'];
const SOURCE_KINDS: readonly WikiSourceKind[] = ['authored', 'reference'];

/** Parses one structured document object into the normalized form; collects every violation. */
function normalizeDocument(raw: unknown, documentText: string): { normalized?: WikiNormalizedDocument; diagnostics: WikiDiagnostic[] } {
  const diagnostics: WikiDiagnostic[] = [];
  if (!isPlainObject(raw)) { return { diagnostics: [DIAG('结构化内容必须是 JSON 对象。')] }; }
  const version = raw['schemaVersion'];
  if (version !== WIKI_SCHEMA_VERSION) {
    diagnostics.push(DIAG(`不支持的 schemaVersion "${String(version)}"，仅支持 ${WIKI_SCHEMA_VERSION}。`, 'schemaVersion'));
    return { diagnostics };
  }
  // Unknown top-level fields — exact path reporting.
  const allowed = new Set(['schemaVersion', 'title', 'sources', 'bible', 'wikiFacts', 'storyEvents', 'gaps']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) diagnostics.push(DIAG(`未知字段，必须移除。`, key));

  // sources
  const rawSources = raw['sources'];
  if (!Array.isArray(rawSources) || rawSources.length === 0) diagnostics.push(DIAG('sources 必须为非空数组（1～16）。', 'sources'));
  else if (rawSources.length > WIKI_LIMITS.maxSources) diagnostics.push(DIAG(`sources 数量超过上限 ${WIKI_LIMITS.maxSources}。`, 'sources'));
  const sources: WikiSourceInput[] = [];
  const sourcesById = new Map<string, WikiSourceInput>();
  const seenSourceIds = new Set<string>();
  for (const [index, entry] of (Array.isArray(rawSources) ? rawSources : []).entries()) {
    const path = `sources[${index}]`;
    if (!isPlainObject(entry)) { diagnostics.push(DIAG('来源必须为对象。', path)); continue; }
    const id = entry['id'], title = entry['title'], kind = entry['kind'], text = entry['text'], uri = entry['uri'];
    if (typeof id !== 'string' || !id.trim()) { diagnostics.push(DIAG('来源 id 必须为非空字符串。', `${path}.id`)); continue; }
    if (seenSourceIds.has(id)) { diagnostics.push(DIAG(`来源 id "${id}" 重复。`, `${path}.id`)); continue; }
    seenSourceIds.add(id);
    if (typeof title !== 'string' || !title.trim()) diagnostics.push(DIAG('来源 title 必须为非空字符串。', `${path}.title`));
    if (!SOURCE_KINDS.includes(kind as WikiSourceKind)) diagnostics.push(DIAG(`kind 必须为 authored 或 reference。`, `${path}.kind`));
    if (typeof text !== 'string' || !text) diagnostics.push(DIAG('来源正文 text 必须为非空字符串。', `${path}.text`));
    else if (byteLength(text) > WIKI_LIMITS.maxSourceBytes) diagnostics.push(DIAG(`单个来源正文超过 64KiB 上限。`, `${path}.text`));
    for (const ch of (typeof text === 'string' ? text : '')) if (ch !== '\n' && ch !== '\r' && ch !== '\t' && ch < ' ') { diagnostics.push(DIAG('正文包含不允许的控制字符（仅允许换行/回车/tab）。', `${path}.text`)); break; }
    if (uri !== undefined && (typeof uri !== 'string' || !/^https?:\/\//i.test(uri))) diagnostics.push(DIAG('uri 仅允许 http(s) 来源标签。', `${path}.uri`));
    const source: WikiSourceInput = { id, title: typeof title === 'string' ? title : '', kind: SOURCE_KINDS.includes(kind as WikiSourceKind) ? kind as WikiSourceKind : 'authored', text: typeof text === 'string' ? text : '', ...(typeof uri === 'string' ? { uri } : {}) };
    sources.push(source); sourcesById.set(id, source);
  }
  // NOTE: no early return here — unknown-field and other diagnostics must still be collected below.

  // bible
  const bibleRaw = raw['bible'];
  if (!isPlainObject(bibleRaw)) { diagnostics.push(DIAG('bible 必须为对象。', 'bible')); return { diagnostics }; }
  const bibleAllowed = new Set(['name', 'soul', 'styleHints', 'evidence']);
  for (const key of Object.keys(bibleRaw)) if (!bibleAllowed.has(key)) diagnostics.push(DIAG('未知字段，必须移除。', `bible.${key}`));
  const name = bibleRaw['name'], soul = bibleRaw['soul'], styleHints = bibleRaw['styleHints'];
  if (typeof name !== 'string' || !name.trim()) diagnostics.push(DIAG('bible.name 必须为非空字符串。', 'bible.name'));
  else if (codePoints(name) > WIKI_LIMITS.maxNameCodePoints) diagnostics.push(DIAG(`bible.name 超过 ${WIKI_LIMITS.maxNameCodePoints} code points。`, 'bible.name'));
  if (typeof soul !== 'string' || !soul.trim()) diagnostics.push(DIAG('bible.soul 必须为非空字符串。', 'bible.soul'));
  else if (codePoints(soul) > WIKI_LIMITS.maxSoulCodePoints) diagnostics.push(DIAG(`bible.soul 超过 ${WIKI_LIMITS.maxSoulCodePoints} code points。`, 'bible.soul'));
  if (!Array.isArray(styleHints) || styleHints.length > WIKI_LIMITS.maxStyleHints) diagnostics.push(DIAG(`styleHints 必须为数组且最多 ${WIKI_LIMITS.maxStyleHints} 条。`, 'bible.styleHints'));
  else for (const [i, hint] of styleHints.entries()) if (typeof hint !== 'string' || !hint.trim() || codePoints(hint) > WIKI_LIMITS.maxStyleHintCodePoints) diagnostics.push(DIAG(`styleHints[${i}] 必须为非空字符串且 ≤200 code points。`, `bible.styleHints[${i}]`));
  const bibleEvidence = checkEvidence({ evidence: bibleRaw['evidence'], label: 'bible' }, sourcesById);
  diagnostics.push(...bibleEvidence.diagnostics);

  // wikiFacts
  const rawFacts = raw['wikiFacts'];
  const wikiFacts: import('../contracts/character-wiki-import.js').WikiFactInput[] = [];
  if (rawFacts !== undefined) {
    if (!Array.isArray(rawFacts)) diagnostics.push(DIAG('wikiFacts 必须为数组。', 'wikiFacts'));
    else if (rawFacts.length > WIKI_LIMITS.maxWikiFacts) diagnostics.push(DIAG(`wikiFacts 数量超过上限 ${WIKI_LIMITS.maxWikiFacts}。`, 'wikiFacts'));
    const seenFactIds = new Set<string>();
    for (const [index, entry] of (Array.isArray(rawFacts) ? rawFacts : []).entries()) {
      const path = `wikiFacts[${index}]`;
      if (!isPlainObject(entry)) { diagnostics.push(DIAG('事实必须为对象。', path)); continue; }
      const id = entry['id'], text = entry['text'], status = entry['status'];
      if (typeof id !== 'string' || !id.trim()) { diagnostics.push(DIAG('事实 id 必须为非空字符串。', `${path}.id`)); continue; }
      if (seenFactIds.has(id)) diagnostics.push(DIAG(`事实 id "${id}" 重复。`, `${path}.id`));
      seenFactIds.add(id);
      if (typeof text !== 'string' || !text.trim()) diagnostics.push(DIAG('事实 text 必须为非空字符串。', `${path}.text`));
      else if (codePoints(text) > WIKI_LIMITS.maxFactTextCodePoints) diagnostics.push(DIAG(`事实 text 超过 ${WIKI_LIMITS.maxFactTextCodePoints} code points。`, `${path}.text`));
      if (!FACT_STATUSES.includes(status as WikiFactStatus)) diagnostics.push(DIAG(`status 必须为 ${FACT_STATUSES.join('/')}。`, `${path}.status`));
      const ev = checkEvidence({ evidence: entry['evidence'], label: path }, sourcesById);
      diagnostics.push(...ev.diagnostics);
      if (id && typeof text === 'string' && FACT_STATUSES.includes(status as WikiFactStatus)) {
        wikiFacts.push({ id, text, status: status as WikiFactStatus, evidence: ev.evidence });
      }
    }
  }

  // storyEvents
  const rawEvents = raw['storyEvents'];
  const storyEvents: import('../contracts/character-wiki-import.js').WikiStoryEventInput[] = [];
  if (rawEvents !== undefined) {
    if (!Array.isArray(rawEvents)) diagnostics.push(DIAG('storyEvents 必须为数组。', 'storyEvents'));
    else if (rawEvents.length > WIKI_LIMITS.maxStoryEvents) diagnostics.push(DIAG(`storyEvents 数量超过上限 ${WIKI_LIMITS.maxStoryEvents}。`, 'storyEvents'));
    const seenEventIds = new Set<string>(); const seenOrdinals = new Set<number>();
    for (const [index, entry] of (Array.isArray(rawEvents) ? rawEvents : []).entries()) {
      const path = `storyEvents[${index}]`;
      if (!isPlainObject(entry)) { diagnostics.push(DIAG('事件必须为对象。', path)); continue; }
      const id = entry['id'], ordinal = entry['ordinal'], title = entry['title'], summary = entry['summary'],
        participants = entry['participants'], awareness = entry['awareness'], status = entry['status'],
        chapter = entry['chapter'], storyTime = entry['storyTime'];
      if (typeof id !== 'string' || !id.trim()) { diagnostics.push(DIAG('事件 id 必须为非空字符串。', `${path}.id`)); continue; }
      if (seenEventIds.has(id)) diagnostics.push(DIAG(`事件 id "${id}" 重复。`, `${path}.id`));
      seenEventIds.add(id);
      if (!Number.isInteger(ordinal) || (ordinal as number) < 0) diagnostics.push(DIAG('ordinal 必须为非负整数。', `${path}.ordinal`));
      else if (seenOrdinals.has(ordinal as number)) diagnostics.push(DIAG(`ordinal ${ordinal} 重复。`, `${path}.ordinal`));
      else seenOrdinals.add(ordinal as number);
      if (typeof title !== 'string' || !title.trim()) diagnostics.push(DIAG('事件 title 必须为非空字符串。', `${path}.title`));
      if (typeof summary !== 'string' || !summary.trim()) diagnostics.push(DIAG('事件 summary 必须为非空字符串。', `${path}.summary`));
      else if (codePoints(summary) > WIKI_LIMITS.maxSummaryCodePoints) diagnostics.push(DIAG(`summary 超过 ${WIKI_LIMITS.maxSummaryCodePoints} code points。`, `${path}.summary`));
      if (!Array.isArray(participants) || participants.length === 0 || participants.length > WIKI_LIMITS.maxParticipants
        || !participants.every(p => typeof p === 'string' && p.trim())) diagnostics.push(DIAG(`participants 必须为 1～${WIKI_LIMITS.maxParticipants} 个非空名称。`, `${path}.participants`));
      if (!AWARENESS.includes(awareness as WikiAwareness)) diagnostics.push(DIAG(`awareness 必须为 ${AWARENESS.join('/')}。`, `${path}.awareness`));
      if (!FACT_STATUSES.includes(status as WikiFactStatus)) diagnostics.push(DIAG(`status 必须为 ${FACT_STATUSES.join('/')}。`, `${path}.status`));
      if (storyTime !== undefined && (typeof storyTime !== 'string' || !storyTime.trim())) diagnostics.push(DIAG('storyTime 必须为作者文本。', `${path}.storyTime`));
      const ev = checkEvidence({ evidence: entry['evidence'], label: path }, sourcesById);
      diagnostics.push(...ev.diagnostics);
      if (id && typeof summary === 'string' && Number.isInteger(ordinal) && AWARENESS.includes(awareness as WikiAwareness) && FACT_STATUSES.includes(status as WikiFactStatus) && Array.isArray(participants)) {
        storyEvents.push({
          id, ordinal: ordinal as number, title: typeof title === 'string' ? title : '', summary,
          participants: participants.filter(p => typeof p === 'string'), awareness: awareness as WikiAwareness,
          status: status as WikiFactStatus, evidence: ev.evidence,
          ...(chapter !== undefined ? { chapter: chapter as string } : {}), ...(storyTime !== undefined ? { storyTime: storyTime as string } : {}),
        });
      }
    }
    // canonical order: by ordinal ascending.
    (storyEvents as import('../contracts/character-wiki-import.js').WikiStoryEventInput[]).sort((a, b) => a.ordinal - b.ordinal);
  }

  // gaps
  const rawGaps = raw['gaps'];
  const gaps: string[] = [];
  if (rawGaps !== undefined) {
    if (!Array.isArray(rawGaps)) diagnostics.push(DIAG('gaps 必须为字符串数组。', 'gaps'));
    else if (rawGaps.length > WIKI_LIMITS.maxGaps) diagnostics.push(DIAG(`gaps 数量超过上限 ${WIKI_LIMITS.maxGaps}。`, 'gaps'));
    else for (const [index, gap] of rawGaps.entries()) if (typeof gap !== 'string' || !gap.trim()) diagnostics.push(DIAG(`gaps[${index}] 必须为非空字符串。`, `gaps[${index}]`));
    else gaps.push(gap);
  }

  const title = raw['title'];
  if (typeof title !== 'string' || !title.trim()) diagnostics.push(DIAG('title 必须为非空字符串。', 'title'));
  else if (codePoints(title) > WIKI_LIMITS.maxTitleCodePoints) diagnostics.push(DIAG(`title 超过 ${WIKI_LIMITS.maxTitleCodePoints} code points。`, 'title'));

  if (diagnostics.length > 0) return { diagnostics };
  return {
    normalized: {
      schemaVersion: WIKI_SCHEMA_VERSION, title: title as string, sources,
      bible: { name: name as string, soul: soul as string, styleHints: (styleHints as string[]) ?? [], evidence: bibleEvidence.evidence },
      wikiFacts, storyEvents, gaps,
    },
    diagnostics,
  };
}

/**
 * Deterministic Wiki v0 import parser.
 * Structured = exactly one `aika-wiki-v0` fenced block (strict JSON inside) OR a bare JSON object of
 * the frozen version. Anything else that is not valid structured content is `source_only` — except
 * content that DECLARES the format (fenced tag present or looks like the versioned JSON) but is
 * broken/duplicated/unknown-version: those are structured mode with diagnostics, never silently
 * demoted to a plain source draft.
 */
export function parseWikiImport(input: WikiParseInput): WikiParseResult {
  const text = typeof input?.text === 'string' ? input.text : '';
  const diagnostics: WikiDiagnostic[] = [];
  const documentHash = sha256(text);
  const pushLimits = () => {
    if (!text.trim()) diagnostics.push(DIAG('导入内容为空。'));
    else if (text.includes('\0')) diagnostics.push(DIAG('内容包含 NUL 字符，拒绝导入。'));
    else if (byteLength(text) > WIKI_LIMITS.maxDocumentBytes) diagnostics.push(DIAG(`导入内容超过 128KiB 传输上限（${byteLength(text)} 字节）。`));
  };

  const blocks = extractFencedBlocks(text);
  const trimmed = text.trim();
  const looksLikeJson = trimmed.startsWith('{') && trimmed.endsWith('}');
  // An OPENING fence tag without a closing one still DECLARES the format — treat it as structured
  // with a diagnostic (never silently demote declared-format content to a plain source draft).
  const opensWithoutClose = new RegExp('```' + WIKI_FENCE_TAG + '\\r?\\n').test(text) && blocks.length === 0;
  let rawJson: string | undefined;
  if (blocks.length > 1) {
    pushLimits();
    diagnostics.push(DIAG(`发现 ${blocks.length} 个 ${WIKI_FENCE_TAG} 标记块；必须恰好一个。`));
    rawJson = blocks[0]!.json;
  } else if (blocks.length === 1) {
    pushLimits();
    rawJson = blocks[0]!.json;
  } else if (opensWithoutClose) {
    pushLimits();
    diagnostics.push(DIAG(`${WIKI_FENCE_TAG} 标记块未闭合；结构化内容必须以 \`\`\` 结束。`));
    rawJson = new RegExp('```' + WIKI_FENCE_TAG + '\\r?\\n([\\s\\S]*)').exec(text)![1]!;
  } else if (looksLikeJson) {
    pushLimits();
    rawJson = trimmed;
  }

  if (rawJson !== undefined) {
    // Structured path: declared format must parse; broken JSON is an error, not a demotion.
    let parsed: unknown;
    try { parsed = JSON.parse(rawJson); } catch (error) {
      diagnostics.push(DIAG(`结构化内容不是有效 JSON：${(error as Error).message}`));
      return { mode: 'structured', documentHash, normalized: undefined, sources: [], diagnostics };
    }
    const { normalized, diagnostics: docDiags } = normalizeDocument(parsed, text);
    if (!normalized) return { mode: 'structured', documentHash, normalized: undefined, sources: [], diagnostics: [...diagnostics, ...docDiags] };
    return {
      mode: 'structured', documentHash, normalized,
      sources: normalized.sources.map(source => ({ sourceId: source.id, sourceName: input.sourceName, kind: source.kind, text: source.text })),
      diagnostics: [...diagnostics, ...docDiags],
    };
  }

  // source_only: plain Markdown draft — kept verbatim as one source; never projected as a pack.
  pushLimits();
  return {
    mode: 'source_only', documentHash, normalized: undefined,
    sources: text.trim() ? [{ sourceId: 'document', sourceName: input.sourceName, kind: 'reference', text }] : [],
    diagnostics,
  };
}

import { createHash } from 'node:crypto';
import { BookError, type BookSnapshot, type BookEntry, type WikiSource } from '../contracts/memory-book.js';

export const BOOK_RECORD_LIMIT = 8192;
const SEGMENT_SIZE = 512;
type Segment = { entries: BookEntry[]; sources: WikiSource[]; hash: string };
type StoredBook = BookSnapshot & { archives?: Segment[]; entryOrder?: string[]; sourceOrder?: string[] };
const hash = (entries: BookEntry[], sources: WikiSource[]) => createHash('sha256').update(JSON.stringify({ entries, sources })).digest('hex');

/** Segments share the owner's atomic snapshot; they never become a second writer. */
export function packBook(book: BookSnapshot): StoredBook {
  if (book.entries.length > BOOK_RECORD_LIMIT || (book.wikiSources?.length ?? 0) > BOOK_RECORD_LIMIT) throw new BookError('budget', 'Book 已达 8192 条目或来源的存储上限，请先导出并整理。');
  const permanent = book.entries.filter(entry => entry.pinned || entry.pairingId === null);
  if (permanent.length > SEGMENT_SIZE) throw new BookError('budget', '常驻条目超过 512，请先减少置顶或角色资料。');
  const permanentIds = new Set(permanent.map(entry => entry.id));
  const room = SEGMENT_SIZE - permanent.length;
  const recent = room ? book.entries.filter(entry => !permanentIds.has(entry.id)).slice(-room) : [];
  const activeIds = new Set([...permanent, ...recent].map(entry => entry.id));
  const entries = book.entries.filter(entry => activeIds.has(entry.id));
  const sources = book.wikiSources ?? [];
  const activeSourceIds = new Set(entries.flatMap(entry => entry.fact ? [entry.fact.sourceId] : []));
  for (const source of [...sources].reverse()) if (activeSourceIds.size < SEGMENT_SIZE) activeSourceIds.add(source.id);
  const coldEntries = book.entries.filter(entry => !activeIds.has(entry.id));
  const coldSources = sources.filter(source => !activeSourceIds.has(source.id));
  const archives: Segment[] = [];
  for (let offset = 0; offset < Math.max(coldEntries.length, coldSources.length); offset += SEGMENT_SIZE) {
    const segmentEntries = coldEntries.slice(offset, offset + SEGMENT_SIZE), segmentSources = coldSources.slice(offset, offset + SEGMENT_SIZE);
    archives.push({ entries: segmentEntries, sources: segmentSources, hash: hash(segmentEntries, segmentSources) });
  }
  const { archiveCounts: _counts, ...rest } = book;
  return { ...rest, entries, ...(book.wikiSources ? { wikiSources: sources.filter(source => activeSourceIds.has(source.id)) } : {}),
    ...(archives.length ? { archives, entryOrder: book.entries.map(entry => entry.id), sourceOrder: sources.map(source => source.id) } : {}) };
}

/** Validate the segment envelope before the normal full Book validation. */
export function unpackBook(value: StoredBook): BookSnapshot {
  if (value?.archives === undefined) return value;
  if (!Array.isArray(value.archives) || value.archives.length > 15 || !Array.isArray(value.entries) || value.entries.length > SEGMENT_SIZE || (value.wikiSources?.length ?? 0) > SEGMENT_SIZE) throw Error('Invalid Book archive envelope');
  for (const segment of value.archives) if (!segment || !Array.isArray(segment.entries) || !Array.isArray(segment.sources) || segment.entries.length > SEGMENT_SIZE || segment.sources.length > SEGMENT_SIZE || segment.hash !== hash(segment.entries, segment.sources)) throw Error('Invalid Book archive segment');
  const order = <T extends { id: string }>(rows: T[], ids: string[] | undefined): T[] => {
    if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== ids.length) throw Error('Invalid Book archive order');
    const byId = new Map(rows.map(row => [row.id, row]));
    if (byId.size !== rows.length || ids.some(id => !byId.has(id))) throw Error('Invalid Book archive identities');
    return ids.map(id => byId.get(id)!);
  };
  const { archives, entryOrder, sourceOrder, ...rest } = value;
  return { ...rest, entries: order([...value.entries, ...archives.flatMap(segment => segment.entries)], entryOrder),
    wikiSources: order([...(value.wikiSources ?? []), ...archives.flatMap(segment => segment.sources)], sourceOrder) };
}

export function archiveCounts(book: BookSnapshot): { entries: number; sources: number; segments: number } {
  const packed = packBook(book), segments = packed.archives ?? [];
  return { entries: segments.reduce((sum, segment) => sum + segment.entries.length, 0), sources: segments.reduce((sum, segment) => sum + segment.sources.length, 0), segments: segments.length };
}

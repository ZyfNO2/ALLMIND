import { createHash } from 'node:crypto';
import { BookError, type BookChunk, type BookEntry, type BookSnapshot, type BookScope, type Candidate, type QueryPlan, type RecallConfig, type SearchIndexPort } from '../contracts/memory-book.js';
import { entryVisible } from './book-validation.js';
import { explicitBookNames, localLanguageTerms, supportsLocalQuestion } from './book-local-language.js';

export const normalizeBookText = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/初次|首次/g, '第一次');
export function bookTerms(text: string): string[] {
  const normalized = normalizeBookText(text), terms: string[] = [];
  for (const word of normalized.match(/[a-z0-9_-]{2,}|[\p{Script=Han}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word]; for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i]! + chars[i + 1]!);
    } else terms.push(word);
  }
  return [...terms.filter(term => !['我们', '什么', '这个', '那个', '你们', '他们', '的是','一起'].includes(term)),...localLanguageTerms(normalized)];
}
/** UTF-8 byte upper estimate for byte-based tokenizers, plus message framing. */
export const bookTokenCost = (text: string): number => Buffer.byteLength(text, 'utf8') + 8;
export const BOOK_SPLITTER_VERSION = 'utf8-bounded/v1';
export function episodeInRange(entry: BookEntry, range: QueryPlan['timeRange']): boolean {
  if (!range.from && !range.to) return true;
  if (entry.type !== 'story' && entry.type !== 'memory') return true;
  const from = entry.timeStart ?? entry.timeEnd, to = entry.timeEnd ?? entry.timeStart;
  if (!from || !to) return false;
  return (!range.to || Date.parse(from) <= Date.parse(range.to)) && (!range.from || Date.parse(to) >= Date.parse(range.from));
}
export function chunkEntry(entry: BookEntry): BookChunk[] {
  const chunks: BookChunk[] = [], paragraphs = entry.body.split(/(?<=\n)\n/);
  let cursor = 0, start = 0, text = '', heading = entry.title;
  const emit = () => {
    if (!text) return;
    chunks.push({ ref: { entryId: entry.id, chunkId: `${entry.id}-${chunks.length}`, revision: entry.revision }, text, heading,
      contentHash: createHash('sha256').update(text).digest('hex'), start, end: start + text.length, splitterVersion: BOOK_SPLITTER_VERSION }); text = '';
  };
  for (const paragraph of paragraphs) {
    if (Buffer.byteLength(text + paragraph, 'utf8') > 590) emit();
    if (!text) start = cursor;
    if (/^#{1,6}\s/.test(paragraph)) heading = paragraph.split('\n')[0]!.replace(/^#+\s*/, '');
    const chars = [...paragraph];
    if (Buffer.byteLength(paragraph, 'utf8') > 590) {
      emit(); let offset = cursor;
      for (let i = 0; i < chars.length;) {
        let end = i, bytes = 0;
        while (end < chars.length && bytes + Buffer.byteLength(chars[end]!, 'utf8') <= 590) bytes += Buffer.byteLength(chars[end++]!, 'utf8');
        start = offset; text = chars.slice(i, end).join(''); emit();
        if (end === chars.length) break;
        let next = end, overlap = 0;
        while (next > i + 1 && overlap + Buffer.byteLength(chars[next - 1]!, 'utf8') <= 50) overlap += Buffer.byteLength(chars[--next]!, 'utf8');
        offset += chars.slice(i, next).join('').length; i = next;
      }
    } else text += paragraph;
    cursor += paragraph.length;
  }
  emit();
  return chunks;
}
interface IndexedChunk { entry: BookEntry; chunk: BookChunk; frequencies: Map<string, number>; length: number }
export class LocalBookIndex implements SearchIndexPort {
  private snapshot: BookSnapshot | null = null;
  private rows: IndexedChunk[] = [];
  private postings = new Map<string, Set<number>>();
  private averageLength = 1;
  rebuild(snapshot: BookSnapshot): void {
    this.snapshot = structuredClone(snapshot); this.rows = []; this.postings.clear();
    for (const entry of snapshot.entries) for (const chunk of chunkEntry(entry)) {
      const aliases=(snapshot.wikiPages??[]).filter(page=>page.kind==='person'&&page.pairingId===entry.pairingId&&page.basisRefs.some(ref=>ref.entryId===entry.id&&ref.revision===entry.revision)&&page.basisRefs.every(ref=>snapshot.entries.some(basis=>basis.id===ref.entryId&&basis.revision===ref.revision&&entryVisible(basis,{characterId:snapshot.characterId,pairingId:page.pairingId,sessionId:'wiki-index'})))&&page.sources.every(ref=>snapshot.wikiSources?.some(source=>source.id===ref.id&&source.enabled&&source.hash===ref.hash&&source.revision===ref.revision))).flatMap(page=>page.aliases??[]);
      const terms = bookTerms(`${entry.title}\n${entry.aliases.join(' ')}\n${aliases.join(' ')}\n${entry.tags.join(' ')}\n${entry.entities.join(' ')}\n${chunk.text}`);
      const frequencies = new Map<string, number>(); for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      const index = this.rows.length;
      this.rows.push({ entry, chunk, frequencies, length: terms.length });
      for (const term of frequencies.keys()) { const posting = this.postings.get(term) ?? new Set<number>(); posting.add(index); this.postings.set(term, posting); }
    }
    this.averageLength = this.rows.reduce((sum, row) => sum + row.length, 0) / Math.max(1, this.rows.length) || 1;
  }
  invalidate(characterId: string): void { if (this.snapshot?.characterId === characterId) { this.snapshot = null; this.rows = []; this.postings.clear(); } }
  search(scope: BookScope, plan: QueryPlan, config: RecallConfig, signal: AbortSignal): Candidate[] {
    signal.throwIfAborted();
    if (!this.snapshot || this.snapshot.characterId !== scope.characterId) throw new BookError('unavailable', '当前角色索引未构建。');
    if (plan.action === 'NO_RETRIEVAL') return [];
    const queries = plan.queries.map(normalizeBookText), queryText = queries.join('\n'), queryTerms = [...new Set(bookTerms(queryText))];
    const rowScores = new Map<number, number>();
    for (const term of queryTerms) {
      signal.throwIfAborted(); const posting = this.postings.get(term); if (!posting) continue;
      const idf = Math.log(1 + (this.rows.length - posting.size + 0.5) / (posting.size + 0.5));
      for (const index of posting) {
        const row = this.rows[index]!, frequency = row.frequencies.get(term)!;
        const score = idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * row.length / this.averageLength));
        rowScores.set(index, (rowScores.get(index) ?? 0) + score);
      }
    }
    const routes = new Map<string, { row: IndexedChunk; score: number; reasons: string[] }[]>();
    this.rows.forEach((row, index) => {
      const entry = row.entry;
      const explicitNames=explicitBookNames(entry.body).map(normalizeBookText),explicitName=explicitNames.some(name=>queryText.includes(name));
      if(!supportsLocalQuestion(queryText,`${entry.title}\n${row.chunk.text}`,entry.origin,entry.type,explicitName))return;
      if (!entryVisible(entry, scope) || entry.type === 'persona' || entry.trigger.strategy === 'always' || entry.pinned || !plan.sources.includes(entry.type)) return;
      if (!episodeInRange(entry, plan.timeRange)) return;
      if (entry.type === 'story' && /第一次.*见面/.test(queryText)) {
        const evidence = normalizeBookText([entry.title, ...entry.aliases, ...entry.tags, ...entry.trigger.keys, entry.body].join(' '));
        if (!evidence.includes('第一次') || !evidence.includes('见面')) return;
      }
      let score = rowScores.get(index) ?? 0; const reasons: string[] = [];
      if(score>0&&entry.origin==='observed'&&entry.fact?.subject==='用户'&&(entry.pinned||entry.importance>=70)&&/重要/.test(queryText)&&localLanguageTerms(queryText).includes('topic:experience')){score+=4;reasons.push('explicit_important_experience');}
      const needles = [entry.title, ...entry.aliases, ...entry.entities, ...entry.tags, ...entry.locations,...explicitNames].filter(Boolean).map(normalizeBookText);
      for (const needle of needles) if (queryText.includes(needle)) { score += 4; reasons.push(`metadata:${needle}`); }
      if (entry.trigger.strategy === 'keyword') {
        const primary = entry.trigger.keys.filter(Boolean).some(key => queryText.includes(normalizeBookText(key)));
        const secondary = !entry.trigger.secondaryKeys.length || (entry.trigger.operator === 'and'
          ? entry.trigger.secondaryKeys.every(key => queryText.includes(normalizeBookText(key)))
          : entry.trigger.secondaryKeys.some(key => queryText.includes(normalizeBookText(key))));
        if (!primary || !secondary) return;
        score += 8; reasons.push('keyword_trigger');
      }
      if (entry.trigger.strategy === 'regex') return;
      if (score <= 0) return;
      // Metadata may boost a relevant hit, but never create one from priority/importance alone.
      score *= 1 + entry.importance / 1000;
      if (entry.type === 'story' && config.mode === 'story-rp') { score *= 1.15; reasons.push('story-rp'); }
      if (rowScores.has(index)) reasons.push('bm25');
      const routeNames: string[] = [entry.type];
      if (entry.trigger.strategy === 'keyword') routeNames.push('trigger');
      if (reasons.some(reason => reason.startsWith('metadata:'))) routeNames.push('metadata');
      for (const route of routeNames) {
        const rows = routes.get(route) ?? []; rows.push({ row, score, reasons }); routes.set(route, rows);
      }
    });
    const candidates = new Map<string, Candidate>();
    for (const [route, rows] of routes) {
      rows.sort((a, b) => b.score - a.score || a.row.entry.id.localeCompare(b.row.entry.id));
      for (const [rank, item] of rows.slice(0, config.limits.perRoute).entries()) {
        const ref = item.row.chunk.ref, candidate = candidates.get(ref.chunkId) ?? { ref, routes: [], rawScores: {}, fusionScore: 0, matchReasons: [] };
        candidate.routes.push(route); candidate.rawScores[route] = item.score; candidate.fusionScore += 1 / (60 + rank + 1); candidate.matchReasons.push(...item.reasons); candidates.set(ref.chunkId, candidate);
      }
    }
    return [...candidates.values()].map(candidate => ({ ...candidate, matchReasons: [...new Set(candidate.matchReasons)] })).sort((a, b) => b.fusionScore - a.fusionScore || a.ref.chunkId.localeCompare(b.ref.chunkId)).slice(0, config.limits.candidates);
  }
}

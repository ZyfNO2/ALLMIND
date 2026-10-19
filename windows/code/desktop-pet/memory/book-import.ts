import { createHash, randomUUID } from 'node:crypto';
import { parseCharacterDocument } from '../core/character-document-parser.js';
import { emptyEntry, BookError, type BookRepository, type BookScope, type BookEntry, type BookChange, type BookImportPreview, type WikiSource } from '../contracts/memory-book.js';
import { validateEntry, validateWikiSource, validateFactSources } from './book-validation.js';

import { bookEntryHash } from './book-entry-hash.js';
import { unpackBookZip } from './book-zip.js';
export { bookEntryHash } from './book-entry-hash.js';
export type { BookImportPreview } from '../contracts/memory-book.js';
export class BookImportService {
  private previews = new Map<string, BookImportPreview>();
  clearPreviews(characterId:string):void{for(const [id,preview] of this.previews)if(preview.characterId===characterId)this.previews.delete(id);}
  constructor(private readonly repository: BookRepository) {}
  async previewZip(scope: BookScope, bytes: Buffer, sourceName: string): Promise<BookImportPreview> {
    const unpacked = await unpackBookZip(bytes);
    const preview = this.preview(scope, unpacked.text, sourceName);
    return { ...preview, archive: { bookFile: unpacked.bookFile, excludedFiles: unpacked.excludedFiles, ...(unpacked.knowledgeView ? { knowledgeView: unpacked.knowledgeView } : {}) } };
  }
  preview(scope: BookScope, text: string, sourceName: string): BookImportPreview {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024 || typeof sourceName !== 'string' || sourceName.length > 200) throw new BookError('invalid_input', '导入内容超限或来源名称无效。');
    const book = this.repository.snapshot(scope), diagnostics: string[] = [];
    let entries: BookEntry[] = [], name = sourceName;
    let wikiSources: WikiSource[] | undefined;
    // Lossless native Markdown envelope; .aiki.md remains accepted by the frozen existing parser.
    const markdownBook = /^# AIKI Memory Book\r?\n\r?\n```memory-book\/v1\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text);
    if (markdownBook) text = markdownBook[1]!;
    if (text.trim().startsWith('{')) {
      let parsed: { schemaVersion: string; entries: BookEntry[]; name?: string; wikiSources?: WikiSource[] };
      try { parsed = JSON.parse(text); } catch (cause) { throw new BookError('invalid_input', '导入 JSON 无效。', { cause }); }
      if (parsed.schemaVersion !== 'memory-book/v1' || !Array.isArray(parsed.entries)) throw new BookError('invalid_input', '导入 Book schema 无效。');
      entries = parsed.entries.map(entry => structuredClone({ ...entry, revision: 0, importedHash: null }));
      if (parsed.wikiSources !== undefined) {
        if (!Array.isArray(parsed.wikiSources) || parsed.wikiSources.length > 32) throw new BookError('invalid_input', 'Wiki 来源列表无效。');
        wikiSources = structuredClone(parsed.wikiSources); for (const source of wikiSources) { validateWikiSource(source); if (source.pairingId !== null) throw new BookError('invalid_input', '作者包不能导入私人来源。'); }
        validateFactSources(entries, wikiSources);
      } else validateFactSources(entries, book.wikiSources ?? []);
      if (typeof parsed.name === 'string') name = parsed.name;
    } else {
      const parsed = parseCharacterDocument({ text, sourceName, inputKind: 'file' });
      diagnostics.push(...parsed.diagnostics.map(item => `${item.code}: ${item.message}`));
      if (parsed.document && !parsed.blockedEntryIds.length && !parsed.diagnostics.length) {
        name = parsed.document.frontmatter.name;
        entries = parsed.document.entries.map(({ meta, body }) => {
          const entry = emptyEntry(meta.id, meta.type, meta.title ?? meta.id, body);
          entry.aliases = [...meta.aliases]; entry.tags = [...meta.tags]; entry.related = [...meta.related];
          entry.entities = [...new Set([...meta.characters, ...meta.entities])]; entry.locations = [...meta.locations];
          entry.timeStart = meta.time?.start ?? null; entry.timeEnd = meta.time?.end ?? null;
          entry.validFrom = meta.validFrom ?? null; entry.validUntil = meta.expiresAt ?? meta.validUntil ?? null;
          entry.importance = Math.min(100, Math.max(0, meta.importance ?? 50));
          entry.sourceRefs = [meta.source?.ref ?? `import:${parsed.documentHash}`];
          entry.trigger.keys = [...new Set([...meta.keywords, ...meta.aliases])];
          entry.trigger.priority = Math.min(100, Math.max(0, meta.priority));
          entry.trigger.strategy = meta.type === 'persona' || meta.always ? 'always' : meta.type === 'story' && entry.trigger.keys.length ? 'keyword' : 'search';
          if (meta.canon || meta.confidence) entry.canon = { level: meta.canon?.level ?? 'draft', confidence: meta.confidence ?? 'explicit' };
          const authorScope = meta.scope ?? parsed.document!.frontmatter.defaultScope;
          if (authorScope) entry.authorScope = authorScope;
          return entry;
        });
      } else if (!diagnostics.length) diagnostics.push('只接受结构化 .aiki.md 或 memory-book/v1 JSON，不把普通 Markdown 整体当成角色设定。');
    }
    if (entries.length > 512) throw new BookError('invalid_input', '导入条目超过 512。');
    const ids = new Set<string>();
    for (const entry of entries) {
      validateEntry(entry);
      if (entry.pairingId && entry.pairingId !== scope.pairingId) throw new BookError('invalid_input', '导入条目属于其他用户配对。');
      if (ids.has(entry.id)) throw new BookError('invalid_input', '导入包含重复 Entry ID。'); ids.add(entry.id);
    }
    const changes: BookImportPreview['changes'] = entries.map(entry => {
      const existing = book.entries.find(item => item.id === entry.id);
      const incomingHash = bookEntryHash(entry);
      entry.importedHash = incomingHash;
      if (!existing) return { id: entry.id, action: 'add', reason: '新条目' };
      entry.revision = existing.revision;
      if (bookEntryHash(existing) === incomingHash) return { id: entry.id, action: 'noop', reason: '内容相同' };
      if (!existing.importedHash || existing.importedHash !== bookEntryHash(existing)) return { id: entry.id, action: 'conflict', reason: '现有条目有手动修改，保留现有内容' };
      return { id: entry.id, action: 'update', reason: '更新未被手工修改的导入条目' };
    });
    const preview = { id: randomUUID(), characterId: scope.characterId, pairingId: scope.pairingId, expectedRevision: book.revision,
      documentHash: createHash('sha256').update(text).digest('hex'), name, entries, changes, diagnostics, expiresAt: Date.now() + 15 * 60000, ...(wikiSources ? { wikiSources } : {}) };
    this.previews.set(preview.id, structuredClone(preview));
    for (const [id, value] of this.previews) if (value.expiresAt < Date.now()) this.previews.delete(id);
    if (this.previews.size > 64) this.previews.delete(this.previews.keys().next().value!);
    return structuredClone(preview);
  }
  apply(scope: BookScope, previewId: string, operationId: string, skippedIds: string[] = []) {
    const preview = this.previews.get(previewId);
    if (!preview || preview.expiresAt <= Date.now()) throw new BookError('not_found', '导入预览已过期，请重新预览。');
    if (preview.characterId !== scope.characterId || preview.pairingId !== scope.pairingId) throw new BookError('not_found', '导入预览不属于当前角色/配对。');
    if (preview.diagnostics.length) throw new BookError('invalid_input', '导入有诊断错误，禁止应用。');
    if (!Array.isArray(skippedIds) || skippedIds.some(id => !preview.entries.some(entry => entry.id === id))) throw new BookError('invalid_input', '跳过条目无效。');
    const allowed = new Set(preview.changes.filter(change => ['add', 'update'].includes(change.action) && !skippedIds.includes(change.id)).map(change => change.id));
    const changes: BookChange = { upsert: preview.entries.filter(entry => allowed.has(entry.id)), ...(preview.wikiSources ? { wikiSources: preview.wikiSources } : {}) };
    return this.repository.commit(scope, changes, preview.expectedRevision, operationId);
  }
  export(scope: BookScope, format: 'json' | 'markdown' = 'json') {
    if (!['json', 'markdown'].includes(format)) throw new BookError('invalid_input', '导出格式无效。');
    const book = this.repository.snapshot(scope);
    const entries = book.entries.filter(entry => entry.origin === 'authored' && entry.type !== 'memory' && entry.pairingId === null);
    const sourceIds = new Set(entries.flatMap(entry => entry.fact ? [entry.fact.sourceId] : []));
    const wikiSources = book.wikiSources?.filter(source => source.pairingId === null && sourceIds.has(source.id));
    const serialized = JSON.stringify({ schemaVersion: 'memory-book/v1', name: scope.characterId, entries, ...(wikiSources?.length ? { wikiSources } : {}) }, null, 2);
    return { filename: `${scope.characterId}.book.${format === 'json' ? 'json' : 'md'}`, text: format === 'json' ? serialized : `# AIKI Memory Book\n\n\`\`\`memory-book/v1\n${serialized}\n\`\`\`\n`,
      entryCount: entries.length, omittedPrivateCount: book.entries.length - entries.length };
  }
}

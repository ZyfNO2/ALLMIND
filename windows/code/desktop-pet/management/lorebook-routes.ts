// RWR-06 / CONTRACTS §5: the management HTTP surface for authored Lorebooks.
//
//  GET    /api/characters/lorebooks?characterId=         list that role's books
//  POST   /api/characters/lorebooks                      create a book (transactional, idempotent)
//  PUT    /api/characters/lorebooks/{id}                 append a WHOLE validated batch in one transaction
//  DELETE /api/characters/lorebooks/{id}                 delete one owned book (revision-checked, idempotent)
//  PUT    /api/characters/lorebooks/{id}/entries/{entry}  replace ONE entry in place (revision-checked)
//  DELETE /api/characters/lorebooks/{id}/entries/{entry}  remove ONE entry
//
// Every write carries `characterId` and is checked against the book's OWNER: a book owned by another
// role is `not_found`, so ids cannot be probed across roles. `operationId` makes creation and deletion
// replay-safe (RWR-08 / AC-A): the same id with the same payload replays the original receipt, the same
// id with a different payload is a conflict. A shared book is NOT offered (D5: per-character only).
import { ManagementError, type CharacterRegistryPort } from '../contracts/management.js';
import { KnowledgeError } from '../contracts/knowledge.js';
import type { LorebookStore } from '../memory/lorebook-store.js';
import type { Lorebook } from '../contracts/lorebook.js';

const text = (value: unknown, max: number, message: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', message);
  return value.trim();
};
const operationId = (value: unknown): string => text(value, 160, '操作编号无效。');
const characterId = (registry: CharacterRegistryPort | undefined, value: unknown): string => {
  if (typeof value !== 'string' || !registry?.get(value)) throw new ManagementError('not_found', '没有这个角色。');
  return value;
};

/** 409 when a book was edited since the caller last read it. */
const expectRevision = (value: unknown, book: Lorebook): void => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed !== book.revision) throw new ManagementError('version_conflict', '故事书已更新，请刷新后重试。');
};
const revisionInput = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ManagementError('invalid_request', '修订号无效。');
  return parsed;
};

/**
 * Store errors surface through the documented HTTP codes instead of a 500: the store's domain errors map
 * 1:1 (not_found / version_conflict / invalid_request), everything else stays an internal error.
 */
function translate(error: unknown): never {
  if (error instanceof ManagementError) throw error;
  if (error instanceof KnowledgeError) throw new ManagementError(error.code === 'not_found' || error.code === 'version_conflict' ? error.code : 'invalid_request', error.message);
  throw new ManagementError('internal_error', '这次故事书操作未完成，原始内容未对外输出。');
}

/** /api/characters/lorebooks* — per-character authored lorebooks. */
export async function lorebookRoute(
  method: string | undefined,
  store: LorebookStore | undefined,
  registry: CharacterRegistryPort | undefined,
  pathname: string,
  body: () => Promise<Record<string, unknown>>,
  query: URLSearchParams,
): Promise<unknown> {
  if (!pathname.startsWith('/api/characters/lorebooks')) return undefined;
  if (!store) throw new ManagementError('unavailable', '当前实例尚未接入故事书。');

  const one = /^\/api\/characters\/lorebooks\/([A-Za-z0-9][A-Za-z0-9-]{1,80})$/.exec(pathname);
  // RWR-07: a single entry inside an owned book. Splitting this out keeps "edit one entry" from being
  // expressed as "delete everything and re-add", which would silently lose the other entries.
  const entry = /^\/api\/characters\/lorebooks\/([A-Za-z0-9][A-Za-z0-9-]{1,80})\/entries\/([A-Za-z0-9][A-Za-z0-9-]{1,80})$/.exec(pathname);

  try {
    if (entry) {
      const [, bookId, entryId] = entry as unknown as [string, string, string];
      const payload = await body();
      const owner = characterId(registry, payload.characterId);
      if (method === 'PUT') {
        const book = store.get(bookId, owner);
        if (!book) throw new ManagementError('not_found', '没有这个故事书。');
        expectRevision(payload.expectedRevision, book);
        const patch = (payload.entry ?? {}) as Record<string, unknown>;
        if (typeof patch !== 'object' || patch === null) throw new ManagementError('invalid_request', '故事书条目无效。');
        // Keywords accept a string too (comma separated) so the editor can post exactly what the user typed.
        const keywords = Array.isArray(patch.keywords) ? patch.keywords
          : typeof patch.keywords === 'string' ? patch.keywords.split(/[,，]/).map(s => s.trim()).filter(Boolean)
          : undefined;
        return { lorebook: store.updateEntry(bookId, owner, entryId, { title: patch.title, content: patch.content, strategy: patch.strategy, keywords, enabled: patch.enabled }) };
      }
      if (method === 'DELETE') {
        const book = store.get(bookId, owner);
        if (!book) throw new ManagementError('not_found', '没有这个故事书。');
        expectRevision(payload.expectedRevision, book);
        return { lorebook: store.removeEntry(bookId, owner, entryId) };
      }
      throw new ManagementError('not_found', '没有这个故事书条目操作。');
    }

    // RWR-08 (E2 / CONTRACTS §5): v1 authored Lorebook import — validate → diff preview → explicit
    // confirm. The preview never writes; the confirm commits ONE transaction and is replay-safe.
    // Checked BEFORE the single-book regex, which would otherwise read "import" as a book id.
    if (pathname === '/api/characters/lorebooks/import' && method === 'POST') {
      const payload = await body();
      const owner = characterId(registry, payload.characterId);
      try {
        const preview = store.previewImport(owner, payload.book);
        return { preview, entryCount: preview.entries.length };
      } catch (error) { return translate(error); }
    }
    if (pathname === '/api/characters/lorebooks/import/confirm' && method === 'POST') {
      const payload = await body();
      const owner = characterId(registry, payload.characterId);
      const opId = operationId(payload.operationId);
      try {
        const preview = store.previewImport(owner, payload.book);
        const lorebook = store.commitImport(owner, preview, opId);
        return { operationId: opId, imported: true, lorebook };
      } catch (error) { return translate(error); }
    }

    if (pathname === '/api/characters/lorebooks' && method === 'POST') {
      // RWR-08: validate EVERYTHING first; only then touch the store. A missing operationId must not
      // leave a book behind (the review's R10 finding: create-then-validate).
      const payload = await body();
      const owner = characterId(registry, payload.characterId);
      const title = text(payload.title, 80, '故事书标题无效。');
      const opId = operationId(payload.operationId);
      try {
        const result = store.createIdempotent(owner, title, opId);
        return { operationId: opId, created: result.created, lorebook: result.book };
      } catch (error) { return translate(error); }
    }

    if (pathname === '/api/characters/lorebooks' && method === 'POST') {
      // RWR-08: validate EVERYTHING first; only then touch the store. A missing operationId must not
      // leave a book behind (the review's R10 finding: create-then-validate).
      const payload = await body();
      const owner = characterId(registry, payload.characterId);
      const title = text(payload.title, 80, '故事书标题无效。');
      const opId = operationId(payload.operationId);
      try {
        const result = store.createIdempotent(owner, title, opId);
        return { operationId: opId, created: result.created, lorebook: result.book };
      } catch (error) { return translate(error); }
    }

    if (!one) {
      if (method === 'GET') {
        const owner = characterId(registry, query.get('characterId'));
        return { apiVersion: 1, characterId: owner, books: store.list(owner) };
      }
      throw new ManagementError('not_found', '没有这个故事书接口。');
    }

    const bookId = one[1]!;
    if (method === 'PUT') {
      const payload = await body();
      const owner = characterId(registry, payload.characterId);
      const book = store.get(bookId, owner);
      if (!book) throw new ManagementError('not_found', '没有这个故事书。');
      expectRevision(payload.expectedRevision, book);
      // `entries` APPENDS authored entries. RWR-08: the WHOLE batch is validated first and committed in
      // ONE transaction — an invalid second entry leaves the first unwritten and the revision unmoved.
      const raw = payload.entries;
      if (!Array.isArray(raw)) throw new ManagementError('invalid_request', '故事书条目无效。');
      const normalized = raw.map(item => {
        if (!item || typeof item !== 'object') throw new ManagementError('invalid_request', '故事书条目无效。');
        const e = item as Record<string, unknown>;
        return {
          title: e.title, content: e.content, strategy: e.strategy,
          keywords: Array.isArray(e.keywords) ? e.keywords : (typeof e.keywords === 'string' ? e.keywords.split(/[,，]/).map(s => s.trim()).filter(Boolean) : []),
          enabled: e.enabled,
        };
      });
      return { lorebook: store.addEntries(bookId, owner, book.revision, normalized) };
    }
    if (method === 'DELETE') {
      // `body()` may be called ONLY ONCE: it consumes the request stream, so a second call would yield an
      // empty body and every delete would 404 on a missing `characterId`.
      const payload = await body();
      const owner = characterId(registry, payload.characterId);
      const opId = operationId(payload.operationId);
      const expected = revisionInput(payload.expectedRevision);
      try {
        return { ...store.deleteBook(bookId, owner, expected, opId), operationId: opId };
      } catch (error) { return translate(error); }
    }
    throw new ManagementError('not_found', '没有这个故事书操作。');
  } catch (error) {
    // The read/validate paths above can also surface store errors (a get on a closed store, etc.);
    // translate them the same way so no Lorebook error ever reaches the client as a 500.
    if (error instanceof ManagementError) throw error;
    if (error instanceof KnowledgeError) throw new ManagementError(error.code === 'not_found' || error.code === 'version_conflict' ? error.code : 'invalid_request', error.message);
    throw error;
  }
}

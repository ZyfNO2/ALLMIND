// RWR-07 acceptance: the Lorebook entry editor is a REAL surface, not a placeholder.
//
// The Lorebook backend landed in RWR-06 with create/list/append/delete of whole books, but the console
// could not edit an entry at all — the RWR-07 exit criteria forbid leaving a target-required surface as
// a "to be wired" control. This file locks the behaviour that makes an entry editor honest:
//
//   * editing ONE entry replaces it in place and never disturbs its siblings (the alternative — delete
//     everything and re-add — would silently drop the entries the author did not touch);
//   * a partial patch (the common "just toggle this" action) keeps the fields the caller omitted,
//     so a toggle can never blank an authored body;
//   * every entry write re-validates against the RWR-00 ceilings, so an edit cannot smuggle in a body
//     the writer would have refused;
//   * the book revision advances, so a stale editor is rejected with 409 rather than overwriting;
//   * an entry of ANOTHER role's book is not_found, so entry ids cannot be probed across roles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { LorebookStore, LOREBOOK_LIMITS } from '../../memory/lorebook-store.js';
import { lorebookRoute } from '../../management/lorebook-routes.js';
import { ManagementError, type CharacterRegistryPort } from '../../contracts/management.js';
import { ANON, tempStore } from './fixtures.js';

const COMPANION = 'companion';
const ROLE_B = ANON.roleB;
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{1,80}$/;

async function lorebooks(t: { after(fn: () => Promise<void> | void): void }, prefix = 'rwr-07-lore-') {
  const ts = await tempStore(t, prefix);
  ts.store.registry.create({ id: ROLE_B, label: '角色B', operationId: `${prefix}create-b` });
  return { ts, books: LorebookStore.open(ts.store) };
}

const registryOf = (ts: { store: { registry: CharacterRegistryPort } }) => ts.store.registry;

type Store = Awaited<ReturnType<typeof lorebooks>>['ts'];

/**
 * Mirror the real server's split: `url.pathname` never contains the query string, and the route receives
 * `url.searchParams` separately. Building the path by hand here is how a test would accidentally pass
 * while the production path 404s, so the helper does the split instead of trusting the caller.
 */
async function call(
  ts: Store,
  method: string,
  target: string,
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(target, 'http://management.invalid');
  return lorebookRoute(method, LorebookStore.open(ts.store), registryOf(ts), url.pathname, async () => payload, url.searchParams);
}

const statusOf = (error: unknown): string => (error instanceof ManagementError ? error.code : `not-a-management-error: ${String(error)}`);

// In-place editing ------------------------------------------------------------------------------
test('RWR-07: editing one entry replaces it and leaves every sibling entry untouched', async t => {
  const { books } = await lorebooks(t);
  const book = books.create(COMPANION, '世界设定');
  const withFirst = books.addEntry(book.id, COMPANION, { title: '背景', content: '角色在海边长大。', strategy: 'always' });
  const withBoth = books.addEntry(withFirst.id, COMPANION, { title: '初遇', content: '两人在图书馆相遇。', strategy: 'keyword', keywords: ['图书馆'] });
  const before = withBoth.entries[1]!;

  const after = books.updateEntry(book.id, COMPANION, before.id, { content: '两人在旧书店相遇，那天下雨。' });

  assert.equal(after.entries.length, 2, 'editing one entry must not add or drop entries');
  assert.equal(after.entries[0]!.content, '角色在海边长大。', 'the untouched sibling is byte-identical');
  const edited = after.entries[1]!;
  assert.equal(edited.content, '两人在旧书店相遇，那天下雨。');
  assert.equal(edited.id, before.id, 'the entry keeps its identity, so its revision history is continuous');
  assert.equal(edited.revision, before.revision + 1, 'the edited entry advances its own revision');
  assert.equal(edited.keywords.length, 1, 'keywords survive an edit that did not mention them');
});

test('RWR-07: a partial patch keeps the fields the caller omitted, so a toggle cannot blank a body', async t => {
  const { books } = await lorebooks(t);
  const book = books.create(COMPANION, '世界设定');
  const withEntry = books.addEntry(book.id, COMPANION, { title: '恒定背景', content: '角色害怕打雷。', strategy: 'always' });
  const entry = withEntry.entries[0]!;

  // Only `enabled` is sent — the console's toggle sends exactly this much.
  const disabled = books.updateEntry(book.id, COMPANION, entry.id, { enabled: false });
  const after = disabled.entries[0]!;
  assert.equal(after.enabled, false, 'the toggle applied');
  assert.equal(after.content, '角色害怕打雷。', 'the authored body was NOT blanked by a one-field patch');
  assert.equal(after.title, '恒定背景');
  assert.equal(after.strategy, 'always');

  // A disabled entry must actually stop being selected — otherwise the toggle is a lie.
  assert.equal(books.select(COMPANION, '随便说点什么', 4096).text, '', 'a disabled entry is not injected');
});

// Ceilings and conflicts -------------------------------------------------------------------------
test('RWR-07: an entry edit is re-validated against the frozen ceilings, exactly like an append', async t => {
  const { books } = await lorebooks(t);
  const book = books.create(COMPANION, '世界设定');
  const withEntry = books.addEntry(book.id, COMPANION, { title: '背景', content: '短正文', strategy: 'always' });
  const entry = withEntry.entries[0]!;

  assert.throws(() => books.updateEntry(book.id, COMPANION, entry.id, { strategy: 'always', content: '' }),
    /条目正文无效/, 'an empty body is refused on edit, not only on append');

  const oversize = 'x'.repeat(LOREBOOK_LIMITS.entryBodyBytes + 1);
  assert.throws(() => books.updateEntry(book.id, COMPANION, entry.id, { content: oversize }),
    /条目正文/, 'the entryBodyBytes ceiling still binds an edit');

  // Dropping the last keyword of a keyword entry must be refused: an untriggerable entry is a lie.
  const keyed = books.addEntry(books.get(book.id, COMPANION)!.id, COMPANION, { title: '初遇', content: '在图书馆相遇。', strategy: 'keyword', keywords: ['图书馆'] });
  assert.throws(() => books.updateEntry(book.id, COMPANION, keyed.entries[1]!.id, { keywords: [] }),
    /至少需要一个关键词/, 'a keyword entry may not be edited into something that can never trigger');

  const survived = books.get(book.id, COMPANION)!;
  assert.equal(survived.entries[0]!.content, '短正文', 'a rejected edit leaves the stored entry untouched');
  assert.equal(survived.revision, keyed.revision, 'a rejected edit does not advance the book revision');
});

test('RWR-07: the book revision advances on edit and removal, so a stale editor is caught', async t => {
  const { books } = await lorebooks(t);
  const book = books.create(COMPANION, '世界设定');
  const withA = books.addEntry(book.id, COMPANION, { title: 'A', content: '正文A', strategy: 'always' });
  const withB = books.addEntry(withA.id, COMPANION, { title: 'B', content: '正文B', strategy: 'always' });

  const afterEdit = books.updateEntry(book.id, COMPANION, withB.entries[0]!.id, { content: '正文B2' });
  assert.ok(afterEdit.revision > withB.revision, 'editing advances the book revision');

  const afterRemove = books.removeEntry(book.id, COMPANION, afterEdit.entries[0]!.id);
  assert.ok(afterRemove.revision > afterEdit.revision, 'removing advances the book revision too');
  assert.equal(afterRemove.entries.length, 1);
  assert.equal(afterRemove.entries[0]!.title, 'B');
});

// HTTP surface -----------------------------------------------------------------------------------
test('RWR-07: the HTTP entry routes work, and a stale expectedRevision is a 409', async t => {
  const { ts } = await lorebooks(t);
  const created = await call(ts, 'POST', '/api/characters/lorebooks', { characterId: COMPANION, title: '世界设定', operationId: 'op-1' }) as { lorebook: { id: string; revision: number } };
  const bookId = created.lorebook.id;
  const appended = await call(ts, 'PUT', `/api/characters/lorebooks/${bookId}`, {
    characterId: COMPANION, expectedRevision: created.lorebook.revision,
    entries: [{ title: '背景', content: '角色在海边长大。', strategy: 'always' }],
  }) as { lorebook: { revision: number; entries: { id: string }[] } };
  const entryId = appended.lorebook.entries[0]!.id;

  const patched = await call(ts, 'PUT', `/api/characters/lorebooks/${bookId}/entries/${entryId}`, {
    characterId: COMPANION, expectedRevision: appended.lorebook.revision,
    entry: { content: '角色在山中长大。' },
  }) as { lorebook: { entries: { content: string; title: string }[] } };
  assert.equal(patched.lorebook.entries.length, 1);
  assert.equal(patched.lorebook.entries[0]!.content, '角色在山中长大。');
  assert.equal(patched.lorebook.entries[0]!.title, '背景', 'the omitted title is kept over HTTP too');

  // A second writer holding the OLD revision must be refused, not silently overwrite.
  await assert.rejects(
    call(ts, 'PUT', `/api/characters/lorebooks/${bookId}/entries/${entryId}`, {
      characterId: COMPANION, expectedRevision: appended.lorebook.revision, entry: { content: '覆盖' },
    }),
    error => statusOf(error) === 'version_conflict',
  );

  // A destructive delete must also carry a fresh revision: a missing one is a 409, never a silent loss.
  const refused = await call(ts, 'DELETE', `/api/characters/lorebooks/${bookId}/entries/${entryId}`, {
    characterId: COMPANION,
  }).catch(error => error);
  assert.equal(statusOf(refused), 'version_conflict');

  const current = (await call(ts, 'GET', `/api/characters/lorebooks?characterId=${COMPANION}`, {})) as { books: { revision: number; entries: unknown[] }[] };
  const deleted = await call(ts, 'DELETE', `/api/characters/lorebooks/${bookId}/entries/${entryId}`, {
    characterId: COMPANION, expectedRevision: current.books[0]!.revision,
  }) as { lorebook: { entries: unknown[] } };
  assert.equal(deleted.lorebook.entries.length, 0, 'a fresh-revision delete removes exactly that entry');
});

test('RWR-07: an entry of another role’s book is not_found — entry ids cannot be probed across roles', async t => {
  const { ts } = await lorebooks(t);
  const mine = await call(ts, 'POST', '/api/characters/lorebooks', { characterId: COMPANION, title: '我的', operationId: 'op-mine' }) as { lorebook: { id: string; revision: number } };
  const withEntry = await call(ts, 'PUT', `/api/characters/lorebooks/${mine.lorebook.id}`, {
    characterId: COMPANION, expectedRevision: mine.lorebook.revision, entries: [{ title: 'A', content: '正文', strategy: 'always' }],
  }) as { lorebook: { entries: { id: string }[] } };
  const entryId = withEntry.lorebook.entries[0]!.id;

  for (const [method, pathname] of [['PUT', `/api/characters/lorebooks/${mine.lorebook.id}/entries/${entryId}`], ['DELETE', `/api/characters/lorebooks/${mine.lorebook.id}/entries/${entryId}`]] as const) {
    await assert.rejects(
      call(ts, method, pathname, { characterId: ROLE_B, expectedRevision: 999, entry: { content: '越权' } }),
      error => statusOf(error) === 'not_found',
      `${method} by another role must be not_found, not a version or validation error`,
    );
  }
});

test('RWR-07: entry ids are only accepted in the documented shape, and a bad book path is not_found', async t => {
  const { ts } = await lorebooks(t);
  for (const pathname of [
    '/api/characters/lorebooks//entries/le-1',
    '/api/characters/lorebooks/lb-1/entries/',
    '/api/characters/lorebooks/lb-1/entries/../etc',
  ]) {
    await assert.rejects(
      call(ts, 'PUT', pathname, { characterId: COMPANION, expectedRevision: 1, entry: { content: 'x' } }),
      error => statusOf(error) === 'not_found' || statusOf(error) === 'unavailable',
      `${pathname} must not be treated as a book id`,
    );
  }
});

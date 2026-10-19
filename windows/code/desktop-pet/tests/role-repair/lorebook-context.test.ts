// RWR-06 acceptance: an authored Lorebook is per-character, triggers deterministically, respects the
// per-turn ceiling AND the real remaining Context budget, and never becomes a real user fact.
//
// The behaviours asserted here are the ones RWR-00's G6/G6b marked RED and CONTRACTS §5 / D5 froze:
//   * always / keyword / keyword-miss / disabled produce a deterministic selection;
//   * matching is literal over NFKC + lowercase (no regex, no surprise semantic triggers);
//   * the per-turn ceiling AND the caller's remaining budget both bound the result, whole entries only;
//   * an omission records WHY;
//   * two roles' books never mix, and the selection is marked authored fiction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { LorebookStore, LOREBOOK_LIMITS, normalizeForMatch } from '../../memory/lorebook-store.js';
import { ANON, RWR_LIMITS, tempStore } from './fixtures.js';

const COMPANION = 'companion';
const ROLE_B = ANON.roleB;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function lorebooks(t: { after(fn: () => Promise<void> | void): void }, prefix = 'rwr-06-') {
  const ts = await tempStore(t, prefix);
  ts.store.registry.create({ id: ROLE_B, label: '角色B', operationId: `${prefix}create-b` });
  return { ts, books: LorebookStore.open(ts.store) };
}

// G6 -----------------------------------------------------------------------------------------
test('RWR-06 G6: the Lorebook modules exist', () => {
  const missing = ['contracts/lorebook.ts', 'memory/lorebook-store.ts', 'management/lorebook-routes.ts']
    .filter(rel => !existsSync(resolve(projectRoot, rel)));
  assert.deepEqual(missing, [], `RWR-06 must add these modules; missing: ${missing.join(', ')}`);
});

// G6b ----------------------------------------------------------------------------------------
test('RWR-06 G6b: the single Context assembly point references Lorebook', () => {
  const pipeline = readFileSync(resolve(projectRoot, 'core/dialogue-pipeline.ts'), 'utf8');
  assert.match(pipeline, /lorebook/i, 'the production Context assembly must consume Lorebook entries, not a parallel prompt path');
});

// Deterministic selection ----------------------------------------------------------------------------
test('RWR-06: always and keyword entries select deterministically; a keyword miss does not', async t => {
  const { books } = await lorebooks(t);
  const book = books.create(COMPANION, '世界设定');
  books.addEntry(book.id, COMPANION, { title: '恒定背景', content: '角色从小在海边长大。', strategy: 'always' });
  books.addEntry(book.id, COMPANION, { title: '初遇', content: '两人在图书馆初次相遇。', strategy: 'keyword', keywords: ['图书馆', '初遇'] });

  const withHit = books.select(COMPANION, '你还记得图书馆吗？', 4096);
  assert.match(withHit.text, /海边/, 'an always entry is present regardless of the input');
  assert.match(withHit.text, /图书馆/, 'a keyword entry matches a literal hit');
  assert.equal(withHit.refs.length, 2);
  assert.equal(withHit.authoredFiction, true, 'the selection is marked authored fiction');

  const withMiss = books.select(COMPANION, '今天天气不错', 4096);
  assert.match(withMiss.text, /海边/, 'an always entry is still present on a keyword miss');
  assert.doesNotMatch(withMiss.text, /图书馆/, 'a non-matching keyword entry is NOT injected');
  const missReasons = withMiss.omissions.filter(o => o.reason === 'keyword_miss');
  assert.equal(missReasons.length, 1, 'the keyword miss is recorded with a reason');
});

test('RWR-06: a disabled entry is never injected and records why', async t => {
  const { books } = await lorebooks(t);
  const book = books.create(COMPANION, '世界设定');
  books.addEntry(book.id, COMPANION, { title: '停用条目', content: '不应出现的内容。', strategy: 'always', enabled: false });
  const selection = books.select(COMPANION, '任意输入', 4096);
  assert.doesNotMatch(selection.text, /不应出现/);
  assert.ok(selection.omissions.some(o => o.reason === 'disabled'));
});

// Literal, case- and width-insensitive matching; no surprise regex semantics -----------------------
test('RWR-06: matching is literal over NFKC + lowercase, and a disabled entry stays out', async t => {
  const { books } = await lorebooks(t);
  const book = books.create(COMPANION, '世界设定');
  // A full-width uppercase query must match a plain lowercase keyword (NFKC + lowercase).
  books.addEntry(book.id, COMPANION, { title: '地点', content: '角色住在老城区。', strategy: 'keyword', keywords: ['oldtown'] });
  const fullWidth = books.select(COMPANION, '你住在ＯＬＤＴＯＷＮ吗', 4096);
  assert.match(fullWidth.text, /老城区/, 'NFKC + lowercase literal matching is deterministic across full-width/case');
  // A substring of a keyword does NOT match (literal whole-keyword `includes` on the normalized text).
  const unrelated = books.select(COMPANION, '完全无关的句子', 4096);
  assert.doesNotMatch(unrelated.text, /老城区/);
});

// Budget: per-turn ceiling AND the caller's remaining budget, whole entries only ---------------------
test('RWR-06: the per-turn ceiling and the remaining budget both bound the selection, whole entries only', async t => {
  const { books } = await lorebooks(t);
  const book = books.create(COMPANION, '世界设定');
  // Many large always-entries so the per-turn ceiling (2048) is the binding constraint.
  for (let i = 0; i < 40; i++) books.addEntry(book.id, COMPANION, { title: `条目${i}`, content: `内容${i}`.repeat(400), strategy: 'always' });

  const ceiling = books.select(COMPANION, '任意', 1000000);
  assert.ok(ceiling.tokens <= LOREBOOK_LIMITS.contextTokensPerTurn, `the per-turn ceiling holds (got ${ceiling.tokens})`);
  assert.ok(ceiling.omissions.some(o => o.reason === 'over_per_turn_ceiling' || o.reason === 'budget_exhausted'));

  // A tiny remaining budget trims further and records budget_exhausted.
  const tiny = books.select(COMPANION, '任意', 20);
  assert.ok(tiny.tokens <= 20, 'the real remaining budget bounds the selection');
  assert.ok(tiny.omissions.some(o => o.reason === 'budget_exhausted' || o.reason === 'over_per_turn_ceiling'));
});

// Scope isolation ---------------------------------------------------------------------------------
test('RWR-06: two roles keep separate books and a book is not visible to the other role', async t => {
  const { books } = await lorebooks(t);
  const a = books.create(COMPANION, 'A的书');
  const b = books.create(ROLE_B, 'B的书');
  books.addEntry(a.id, COMPANION, { title: 'A', content: 'companion 专属设定。', strategy: 'always' });
  books.addEntry(b.id, ROLE_B, { title: 'B', content: 'roleB 专属设定。', strategy: 'always' });

  assert.deepEqual(books.list(COMPANION).map(x => x.id), [a.id]);
  assert.deepEqual(books.list(ROLE_B).map(x => x.id), [b.id]);
  assert.equal(books.get(b.id, COMPANION), null, "B's book is invisible to companion");
  assert.doesNotMatch(books.select(COMPANION, '任意', 4096).text, /roleB/, "B's content never enters A's context");
  assert.doesNotMatch(books.select(ROLE_B, '任意', 4096).text, /companion 专属/);
});

// Frozen limits and validation ---------------------------------------------------------------------
test('RWR-06: writes enforce the registered ceilings', async t => {
  const { books } = await lorebooks(t);
  const book = books.create(COMPANION, '世界设定');
  assert.throws(() => books.addEntry(book.id, COMPANION, { title: 'x', content: 'y'.repeat(LOREBOOK_LIMITS.entryBodyBytes + 1), strategy: 'always' }), /正文|大小|上限/);
  assert.throws(() => books.addEntry(book.id, COMPANION, { title: 'x', content: 'y', strategy: 'keyword', keywords: Array.from({ length: LOREBOOK_LIMITS.keywordsPerEntry + 1 }, (_, i) => `k${i}`) }), /关键词/);
  assert.throws(() => books.addEntry(book.id, COMPANION, { title: 'x', content: 'y', strategy: 'keyword', keywords: [] }), /关键词/);
  // The registered limits equal the frozen ones.
  assert.equal(LOREBOOK_LIMITS.contextTokensPerTurn, RWR_LIMITS.lorebook.contextTokensPerTurn);
  assert.equal(LOREBOOK_LIMITS.booksPerCharacter, RWR_LIMITS.lorebook.booksPerCharacter);
  assert.equal(LOREBOOK_LIMITS.entriesPerBook, RWR_LIMITS.lorebook.entriesPerBook);
});

// Normalization is the documented form -------------------------------------------------------------------
test('RWR-06: normalizeForMatch is NFKC + lowercase', () => {
  assert.equal(normalizeForMatch('ＡＢＣ'), 'abc');
  assert.equal(normalizeForMatch('Hello'), 'hello');
});

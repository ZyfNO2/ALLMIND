import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyEntry, type BookEntry } from '../../contracts/memory-book.js';
import { classifyBook, defaultEntryType } from '../../memory/knowledge-category.js';

function entry(patch: Partial<BookEntry> & Pick<BookEntry, 'id' | 'type'>): BookEntry {
  return { ...emptyEntry(patch.id, patch.type, patch.title ?? patch.id, patch.body ?? '正文'), ...patch };
}

test('four shelves follow type, real records, and synthesis basis without reading titles', () => {
  const story = entry({ id: 'story', type: 'story', title: '人设关键词不应决定分类' });
  const lore = entry({ id: 'lore', type: 'lore' });
  const persona = entry({ id: 'persona', type: 'persona', title: '客观知识' });
  const fact = entry({ id: 'fact', type: 'wiki', origin: 'authored', organization: { domain: 'author', evidenceStatus: 'source_asserted' } });
  const real = entry({ id: 'real', type: 'wiki', origin: 'authored', organization: { domain: 'real', evidenceStatus: 'observation' } });
  const observed = entry({ id: 'observed', type: 'wiki', origin: 'observed', pairingId: 'local-user' });
  const memory = entry({ id: 'memory', type: 'memory' });
  const state = entry({ id: 'state', type: 'state' });
  const same = entry({ id: 'same', type: 'wiki', synthesis: { version: 'allmind-wiki/v1', pageId: 'p', domain: 'simulated', basis: [{ entryId: 'memory', revision: 1, hash: 'a' }], sources: [], relations: [] } });
  const mixed = entry({ id: 'mixed', type: 'wiki', synthesis: { version: 'allmind-wiki/v1', pageId: 'q', domain: 'author', basis: [{ entryId: 'story', revision: 1, hash: 'b' }, { entryId: 'memory', revision: 1, hash: 'c' }], sources: [], relations: [] } });
  const before = JSON.stringify([story, memory]);
  const decisions = classifyBook([story, lore, persona, fact, observed, real, memory, state, same, mixed]);
  assert.equal(JSON.stringify([story, memory]), before);
  assert.equal(decisions.get('story')?.category, 'world');
  assert.equal(decisions.get('lore')?.category, 'world');
  assert.equal(decisions.get('persona')?.category, 'persona');
  assert.equal(decisions.get('fact')?.category, 'knowledge');
  assert.equal(decisions.get('real')?.category, 'companion');
  assert.equal(decisions.get('observed')?.category, 'companion');
  assert.equal(decisions.get('memory')?.category, 'companion');
  assert.equal(decisions.get('state')?.category, 'companion');
  assert.equal(decisions.get('same')?.category, 'companion');
  assert.equal(decisions.get('same')?.simulated, true);
  assert.equal(decisions.get('same')?.crossClass, false);
  assert.equal(decisions.get('mixed')?.category, 'knowledge');
  assert.equal(decisions.get('mixed')?.crossClass, true);
  assert.deepEqual((['world', 'persona', 'knowledge', 'companion'] as const).map(defaultEntryType), ['story', 'persona', 'wiki', 'memory']);
});

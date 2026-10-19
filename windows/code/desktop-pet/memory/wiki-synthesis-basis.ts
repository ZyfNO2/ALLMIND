import type { BookEntry, WikiSource } from '../contracts/memory-book.js';
import { bookEntryHash } from './book-entry-hash.js';
/** No recursive generated-on-generated evidence; originals remain the only basis. */
export function staleSynthesis(entry: BookEntry, entries: BookEntry[], sources: WikiSource[]): boolean {
  const meta = entry.synthesis;
  if (!meta) return false;
  return meta.basis.some(ref => {
    const basis = entries.find(row => row.id === ref.entryId);
    return !basis || !!basis.synthesis || !basis.enabled || basis.revision !== ref.revision || bookEntryHash(basis) !== ref.hash || basis.pairingId !== null && basis.pairingId !== entry.pairingId;
  }) || meta.sources.some(ref => !sources.some(source => source.id === ref.id && source.enabled && source.hash === ref.hash && source.revision === ref.revision && (source.pairingId === null || source.pairingId === entry.pairingId)));
}

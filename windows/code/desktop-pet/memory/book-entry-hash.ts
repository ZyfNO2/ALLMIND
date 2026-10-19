import { createHash } from 'node:crypto';
import type { BookEntry } from '../contracts/memory-book.js';

/** Content identity, independent of persistence revision and prior import marker. */
export const bookEntryHash = (entry: BookEntry): string => {
  const { revision: _revision, importedHash: _importedHash, ...content } = entry;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
};

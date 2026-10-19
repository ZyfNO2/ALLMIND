import { BookError } from '../contracts/memory-book.js';
import type { FactClaim } from './fact-wiki.js';

/** Resolve a quoted fact inside a declarative clause, rather than rejecting the whole turn.
 * A conditional governs its following comma clauses until a sentence boundary. */
export function groundedAutomaticClaim<T extends FactClaim>(text: string, claim: T): T | null {
  if (typeof claim.quote !== 'string' || !claim.quote.trim()) throw new BookError('invalid_input', '事实 quote 无效。');
  let start = text.indexOf(claim.quote);
  if (start < 0) throw new BookError('invalid_input', '事实引文不在用户原文中。');
  while (start >= 0) {
    const before = text.slice(0, start), end = start + claim.quote.length;
    const sentenceStart = Math.max(...[...before.matchAll(/[。！？!?；;\n]/g)].map(match => match.index! + 1), 0);
    const prefix = text.slice(sentenceStart, end);
    const clauseStart = Math.max(before.lastIndexOf('，') + 1, before.lastIndexOf(',') + 1, sentenceStart);
    const nextBoundary = /[，,。！？!?；;\n]/.exec(text.slice(end));
    const clauseEnd = nextBoundary ? end + nextBoundary.index : text.length;
    const clause = text.slice(clauseStart, clauseEnd);
    const speculative = /假如|假设|如果|扮演|设定|也许|可能|不确定/.test(prefix);
    const questioned = /[？?]/.test(claim.quote) || /[？?]/.test(nextBoundary?.[0] ?? '') || /(?:吗|么|呢)\s*$/.test(clause);
    if (!speculative && !questioned) return { ...claim, start };
    start = text.indexOf(claim.quote, start + 1);
  }
  return null;
}

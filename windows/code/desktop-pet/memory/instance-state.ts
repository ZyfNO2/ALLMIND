import { createHash, randomUUID } from 'node:crypto';
import { BookError, emptyEntry, type BookRepository, type RuntimeRepository, type BookScope, type StateProposal, type StatePreview, type BookEntry } from '../contracts/memory-book.js';
import { validateEntry, validateIdentity } from './book-validation.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
/** Explicit reviewed SET operations only. One atomic Book commit owns event and resulting state. */
export class InstanceStateService {
  private previews = new Map<string, StatePreview>();
  clearPreviews(characterId:string):void{for(const [id,preview] of this.previews)if(preview.characterId===characterId)this.previews.delete(id);}
  constructor(private readonly repository: BookRepository & RuntimeRepository) {}
  preview(scope: BookScope, proposal: StateProposal): StatePreview {
    if (!proposal || typeof proposal !== 'object') throw new BookError('invalid_input', '状态候选无效。');
    validateIdentity(proposal.turnId, 'turnId');
    const turn = this.repository.readSession(scope).find(item => item.id === proposal.turnId);
    if (!turn) throw new BookError('not_found', '状态依据必须是当前会话已提交的用户消息。');
    if (typeof proposal.quote !== 'string' || !proposal.quote.trim() || proposal.quote.length > 4000 || !turn.user.includes(proposal.quote)) throw new BookError('invalid_input', '状态依据必须逐字引用用户消息；助手回答不能作为事实依据。');
    return this.prepare(scope, 'user_message', turn.id, turn.timestamp, proposal.quote, proposal.changes);
  }
  initialize(scope: BookScope, templateId: string): StatePreview {
    validateIdentity(templateId, 'templateId');
    const template = this.repository.snapshot(scope).entries.find(entry => entry.id === templateId);
    if (!template || template.type !== 'state' || template.origin !== 'authored' || template.pairingId !== null || !template.enabled || !template.body.trim() || template.body.length > 1000) throw new BookError('invalid_input', '请选择有效的作者初始 State；正文最多 1000 字。');
    // Author initialization is recorded as such, not as a user experience or observed fact.
    return this.prepare(scope, 'author_initialization', template.id, null, template.body, [{ key: template.title, value: template.body }]);
  }
  private prepare(scope: BookScope, basis: 'user_message' | 'author_initialization', referenceId: string, timestamp: string | null, quote: string, changes: StateProposal['changes']): StatePreview {
    if (!Array.isArray(changes) || !changes.length || changes.length > 8) throw new BookError('invalid_input', '一次状态候选须含 1～8 个明确的新值。');
    const book = this.repository.snapshot(scope), eventId = `event.${digest(JSON.stringify(scope))}.${digest(`${basis}:${referenceId}`)}`;
    if (book.entries.some(entry => entry.id === eventId)) throw new BookError('conflict', '此消息或模板已提交过状态事件；不会重复初始化或变更。');
    const seen = new Set<string>(), states: BookEntry[] = [], event = emptyEntry(eventId, 'memory', basis === 'user_message' ? '用户消息状态事件' : '作者初始状态应用', quote);
    event.origin = 'observed'; event.pairingId = scope.pairingId; event.timeStart = timestamp;
    event.entities = ['当前实例']; event.sourceRefs = [`${basis}:${referenceId}`];
    event.event = { basis, referenceId, quote, changes: [] };
    for (const change of changes) {
      if (!change || typeof change.key !== 'string' || !change.key.trim() || change.key.length > 100 || typeof change.value !== 'string' || !change.value.trim() || change.value.length > 1000 || !quote.includes(change.value) || seen.has(change.key)) throw new BookError('invalid_input', '状态键/新值无效、重复或无法在依据中核验。');
      seen.add(change.key);
      const stateId = `state.${digest(scope.pairingId)}.${digest(change.key)}`, current = book.entries.find(entry => entry.id === stateId);
      if (basis === 'author_initialization' && current) throw new BookError('conflict', '实例状态已经存在，初始化不能覆盖。');
      const state = emptyEntry(stateId, 'state', change.key, `${change.key}：${change.value}`);
      state.pairingId = scope.pairingId; state.origin = 'observed'; state.entities = ['当前实例'];
      state.sourceRefs = [eventId]; state.related = [eventId]; state.revision = current?.revision ?? 0;
      state.state = { key: change.key, value: change.value, eventId }; state.timeStart = timestamp;
      state.validUntil = change.validUntil ?? null;
      if (state.validUntil && Date.parse(state.validUntil) <= Date.now()) throw new BookError('invalid_input', '状态有效期必须在未来。');
      validateEntry(state); states.push(state);
      event.event.changes.push({ key: change.key, before: current?.state?.value ?? null, after: change.value, stateId });
    }
    event.related = states.map(state => state.id); validateEntry(event);
    const preview: StatePreview = { id: randomUUID(), ...scope, expectedRevision: book.revision, event, states, expiresAt: Date.now() + 15 * 60000 };
    for (const [id, value] of this.previews) if (value.expiresAt < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.id, structuredClone(preview)); return preview;
  }
  apply(scope: BookScope, previewId: string, operationId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const preview = this.previews.get(previewId);
    if (!preview || preview.expiresAt < Date.now() || preview.characterId !== scope.characterId || preview.pairingId !== scope.pairingId || preview.sessionId !== scope.sessionId) throw new BookError('not_found', '状态预览失效或作用域不同。');
    return this.repository.commit(scope, { upsert: [preview.event, ...preview.states] }, preview.expectedRevision, operationId);
  }
  view(scope: BookScope) {
    const entries = this.repository.snapshot(scope).entries;
    return { states: entries.filter(entry => entry.state && entry.enabled && entries.some(event => event.id === entry.state!.eventId && event.enabled) && (!entry.validUntil || Date.parse(entry.validUntil) > Date.now())),
      events: entries.filter(entry => entry.event && entry.enabled).sort((a, b) => (b.timeStart ?? '').localeCompare(a.timeStart ?? '')) };
  }
}

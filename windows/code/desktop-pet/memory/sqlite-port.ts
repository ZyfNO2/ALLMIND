import type { ConversationMessage, DialogueContext, MemoryChangeResult, MemoryMaintenanceInput, MemoryMaintenanceProvider, MemoryPort, PerceptionResult, TurnScope } from '../contracts/index.js';
import { assembleContext, type ContextOptions, type ContextSnapshot } from './context.js';
import { bindScope, sameScope } from './scope.js';
import { SqliteMemoryStore } from './sqlite-store.js';
import { EMPTY_PERSONA_PROMPT } from '../companion/prompts.js';

export interface SqliteContextOptions extends Omit<ContextOptions, 'prompts' | 'knowledge' | 'continuity' | 'lorebook' | 'roleAuthor'> { readonly summaryLimit: number;
  /**
   * FIX61-06: the active knowledge library, read fresh on every turn so a switch or a document removal
   * is visible immediately. Absent means no library is selected.
   */
  readonly knowledge?: () => import('../contracts/knowledge.js').KnowledgeSelection | null | Promise<import('../contracts/knowledge.js').KnowledgeSelection | null>
  /**
   * N075-01/R2: the continuity projection for this scope's turn, read fresh per turn from the same
   * stores the management API reads. Absent (or a null resolution) means the runtime has no active
   * continuity pairing; a thrown error would fail the turn visibly instead of faking an empty one.
   */
  readonly continuity?: (scope: { readonly characterId: string }) => import('../contracts/continuity-context.js').ContinuityContextResult | null | Promise<import('../contracts/continuity-context.js').ContinuityContextResult | null>;
  /**
   * RWR-06: the authored Lorebook selection for this turn. It receives the CURRENT user text so the
   * store can apply its literal keyword trigger, and the REAL remaining budget so the per-turn ceiling
   * can never overfill a turn. It returns already-bounded authored fiction, never a Memory record.
   */
  readonly lorebook?: (scope: { readonly characterId: string }, text: string, remainingTokenBudget: number) => import('../contracts/lorebook.js').LorebookSelection | null | Promise<import('../contracts/lorebook.js').LorebookSelection | null>;
  /**
   * RWR-06: the role's author metadata (scenario / example dialogue) that may inform the character
   * prompt. Read fresh per turn so a saved edit is visible on the next turn. `firstMessage` is
   * presentation-only and is deliberately not projected here.
   */
  readonly roleAuthor?: (scope: { readonly characterId: string }) => import('../contracts/role-configuration.js').RoleAuthorPrompt | null | Promise<import('../contracts/role-configuration.js').RoleAuthorPrompt | null>;
  /**
   * RP75-02: synchronous continuity context validator to detect in-flight forget/correct/revocation.
   */
  readonly assertContinuityCurrent?: (continuity: import('../contracts/continuity-context.js').ContinuityContextResult) => void;
}
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error('memory_cancelled'); }
/** A privacy-excluded turn never carries the pair-scoped continuity projection, like knowledge. */
function privacySafeContinuity(continuity: import('../contracts/continuity-context.js').ContinuityContextResult | null, privacyExcluded: boolean): import('../contracts/continuity-context.js').ContinuityContextResult | null {
  return privacyExcluded ? null : continuity;
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('memory_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Scheduling belongs to the application: exactly one caller queues maintenance after append commits. */
export class SqliteMemoryPort implements MemoryPort {
  constructor(readonly store: SqliteMemoryStore, private readonly options: SqliteContextOptions, private readonly provider?: MemoryMaintenanceProvider) {}
  async append(scope: TurnScope, messages: readonly ConversationMessage[]): Promise<void> { this.store.append(scope, messages); }
  async context(scope: TurnScope, text: string, perception: PerceptionResult | null, signal: AbortSignal): Promise<DialogueContext> {
    return (await this.contextSnapshot(scope, text, perception, signal)).context;
  }
  /** Same assembly as context(), with the snapshot metadata the knowledge/privacy paths need. */
  async contextSnapshot(scope: TurnScope, text: string, perception: PerceptionResult | null, signal: AbortSignal, excludePersonal = false): Promise<ContextSnapshot> {
    const knowledge = this.options.knowledge ? await this.options.knowledge() : null;
    const continuity = privacySafeContinuity(this.options.continuity ? await this.options.continuity(scope) : null, excludePersonal || this.store.pending.has(scope.characterId));
    // RWR-06: the authored Lorebook is read fresh per turn, keyword-matched on THIS text, and bounded by
    // the real remaining budget. It is authored fiction about the character, so a privacy exclusion does
    // not drop it (it carries no user data) — but it is never promoted to user memory.
    const lorebookBudget = Math.max(0, (this.options.inputTokenBudget ?? 0)
      - (knowledge ? knowledge.blocks.reduce((sum, block) => sum + Math.ceil([...block.text].length / 2) + 8, 0) : 0));
    const lorebook = this.options.lorebook
      ? await this.options.lorebook(scope, text, lorebookBudget)
      : null;
    // RWR-06: the role's author metadata, read fresh so a saved edit reaches the next turn.
    const roleAuthor = this.options.roleAuthor ? await this.options.roleAuthor(scope) : null;
    checkAbort(signal);
    return this.createContext(scope, text, perception, signal, excludePersonal, knowledge ?? null, continuity, lorebook, roleAuthor);
  }
  protected createContext(scope: TurnScope, text: string, perception: PerceptionResult | null, signal: AbortSignal, excludePersonal=false, knowledge: import('../contracts/knowledge.js').KnowledgeSelection | null = null, continuity: import('../contracts/continuity-context.js').ContinuityContextResult | null = null, lorebook: import('../contracts/lorebook.js').LorebookSelection | null = null, roleAuthor: import('../contracts/role-configuration.js').RoleAuthorPrompt | null = null): ContextSnapshot {
    checkAbort(signal); const owned = bindScope(scope, scope.characterId);
    if (perception && !sameScope(owned, perception.scope)) throw new Error('perception_scope_mismatch');
    if (perception) {
      const source = this.store.inspect(owned, `${owned.turnId}:user`);
      if (source?.state === 'active') this.store.recordPerception(owned, perception, [source.id]);
    }
    const privacyExcluded=excludePersonal||this.store.pending.has(owned.characterId);
    const data = privacyExcluded?this.store.protectedRecent(owned,excludePersonal?0:this.options.maxRecentMessages):this.store.contextRecords(owned, text, this.options.maxRecentMessages, this.options.maxMemories, this.options.summaryLimit);
    const evaluatedAt=this.store.now(),policyRevision=this.store.dynamics.policy().revision;
    const candidates=privacyExcluded?[]:this.store.recall.rank(owned,text,evaluatedAt);
    const scores=new Map(candidates.map(candidate=>[candidate.source.id,candidate.priority]));
    const snapshot = assembleContext({ characterId: owned.characterId, contextRecords: requested => {
      bindScope(requested, owned.characterId); return {...data,memories:this.store.recall.references(owned,candidates)};
    }, assertContextCurrent: (requested, revision) => this.store.assertContextCurrent(requested, revision) }, owned, text, privacyExcluded?null:perception, this.store.now(), {
      ...this.options, ...(!privacyExcluded?{emotionBackground:this.store.emotion.background(owned),messageEmotions:data.recent.flatMap(m=>{const value=this.store.emotion.message(owned,m.id);return value?[value]:[]})}:{}),
      // RUX (2026-10-10): same honest no-persona prompt as the lifecycle port — an empty stored persona
      // means "no persona inserted"; it must not crash the turn, and it must not invent a persona either.
      memoryTieBreak:(a,b)=>candidates.findIndex(x=>x.source.id===a.id)-candidates.findIndex(x=>x.source.id===b.id), maxMemories:Math.min(6,this.options.maxMemories), relevance:memory=>scores.get(memory.id)??0, prompts: { [owned.characterId]: this.store.prompt(owned) || EMPTY_PERSONA_PROMPT },
      // A privacy exclusion drops knowledge too: an excluded turn must not carry reference text either.
      knowledge: privacyExcluded ? null : knowledge,
      // N075-01/R2: the same boundary applies to the continuity projection - a pending privacy hold
      // or an explicitly excluded turn never carries pair-scoped personal continuity data.
      continuity: privacyExcluded ? null : continuity,
      // RWR-06: the authored Lorebook is the character's world setting, not user data, so a privacy
      // exclusion does not drop it. It still goes through the same budget and can be omitted whole.
      lorebook,
      // RWR-06: author metadata (scenario / example dialogue) describes the character, so it also
      // survives a privacy exclusion and remains budget-bounded like everything else here.
      roleAuthor,
    });
    checkAbort(signal); return {...snapshot,privacyExcluded,recall:{candidates,policyRevision,evaluatedAt,dataRevision:data.revision}};
  }
  maintenanceInput(scope: TurnScope, text: string): MemoryMaintenanceInput {
    const owned = bindScope(scope, scope.characterId);
    const data = this.store.contextRecords(owned, text, this.options.maxRecentMessages, this.options.maxMemories, this.options.summaryLimit,'maintenance');
    return { scope: owned, messages: data.recent, relevantMemories: data.memories };
  }
  async maintain(input: MemoryMaintenanceInput, signal: AbortSignal): Promise<readonly MemoryChangeResult[]> {
    checkAbort(signal);
    if (!this.provider) throw new Error('memory_maintenance_provider_not_configured');
    const task = this.store.prepareMaintenance(input);
    try {
      const changes = await abortable(this.provider.propose(structuredClone(task.input), signal), signal);
      checkAbort(signal);
      return this.store.finishMaintenance(task, changes);
    } catch (error) {
      if (!this.store.closed) this.store.cancelMaintenance(task);
      throw error;
    }
  }
}

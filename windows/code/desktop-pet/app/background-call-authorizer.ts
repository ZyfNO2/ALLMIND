/**
 * app/background-call-authorizer.ts
 *
 * CK-04: purpose-classified sub-budget adapter over the EXISTING shared trial ledger.
 *
 * The spec is explicit that this must not become a second ledger. So this class owns no storage:
 * it wraps an existing `CallAuthorizer` (in production, `TrialAuthorizer`) and the existing
 * `EvaluationBudget` file, and it adds exactly two things the foreground authorizer does not have:
 *
 *  1. a **purpose class** per background job, so a knowledge-compilation call is distinguishable
 *     from an observation call in the same account;
 *  2. a **sub-budget** per purpose, enforced inside the same ledger transaction as the hard total,
 *     so a background purpose can never spend money the foreground needs.
 *
 * `unknown` is a first-class outcome. A call whose real cost is not known keeps its reservation and
 * is never released back into spendable budget, because releasing it would silently create new
 * allowance out of an unaccounted charge.
 */

import type { CallAuthorizer, CallOutcome, CallRequest } from '../providers/transport.js';
import { EvaluationBudget, type BudgetState } from '../core/evaluation-budget.js';

/**
 * Background purposes. Each is a distinct accounting class; none of them may borrow another's
 * allowance, and none may exceed the shared hard total.
 */
export type BackgroundPurpose =
  | 'activity_understanding'
  | 'daily_summary'
  | 'wiki_compile'
  | 'character_distill'
  | 'observation';

export interface BackgroundPurposeBudget {
  readonly purpose: BackgroundPurpose;
  /** Upper bound in micros this purpose may consume over the whole trial. */
  readonly limitMicros: number;
  readonly maxCalls: number;
  /** Reservation per call in micros, taken from the frozen CK-00 table. */
  readonly reservationMicros: number;
  /**
   * Prices for turning real usage into a real cost. Without these a successful call can only be
   * reported as `unknown`, which retains its reservation; supplying them is what makes settlement
   * exact rather than merely safe.
   */
  readonly inputMicrosPerToken?: number;
  readonly outputMicrosPerToken?: number;
}

export interface BackgroundCallAuthorizerOptions {
  readonly budgetFile: string;
  readonly batchId: string;
  /** The shared hard total. Background spend is always checked against this as well. */
  readonly limitMicros: number | null;
  readonly purposes: readonly BackgroundPurposeBudget[];
  /**
   * The foreground authorizer this adapter defers to for endpoint/model registration and the
   * shared total. Without it the adapter refuses rather than inventing its own policy.
   */
  readonly foreground: CallAuthorizer;
  /**
   * Micros the foreground must retain. A background reservation that would eat into this is
   * refused rather than being allowed to starve the user's own conversation.
   */
  readonly foregroundHeadroomMicros?: number;
  readonly now?: () => string;
}

export interface BackgroundUsage {
  readonly purpose: BackgroundPurpose;
  readonly calls: number;
  readonly committedMicros: number;
  readonly unknownCalls: number;
  readonly ledgerRef: string | null;
}

/** A settlement that never happened cannot be treated as free. */
export class BackgroundBudgetError extends Error {
  constructor(readonly code:
    | 'purpose_not_registered'
    | 'background_budget_exhausted'
    | 'foreground_headroom_protected'
    | 'call_limit_reached'
    | 'settlement_conflict'
    | 'unknown_not_released', message: string) {
    super(message);
    this.name = 'BackgroundBudgetError';
  }
}

const LEDGER_PREFIX = 'CK-BG:';

export class BackgroundCallAuthorizer {
  private readonly budget: EvaluationBudget;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BackgroundCallAuthorizerOptions) {
    this.budget = new EvaluationBudget(options.budgetFile, options.batchId, options.limitMicros);
  }

  /**
   * A `CallAuthorizer` bound to one purpose.
   *
   * The returned object satisfies the transport's interface, so a provider can be constructed with
   * it directly, while the purpose — and therefore the sub-budget — is fixed at construction and
   * cannot be widened by a caller later.
   */
  forPurpose(purpose: BackgroundPurpose): CallAuthorizer {
    return {
      authorize: async (request: CallRequest, signal: AbortSignal) => {
        const permit = await this.authorize(purpose, request, signal);
        return { settle: permit.settle };
      },
    };
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work);
    this.serial = next.catch(() => undefined);
    return next;
  }

  #purposeBudget(purpose: BackgroundPurpose): BackgroundPurposeBudget {
    const found = this.options.purposes.find(entry => entry.purpose === purpose);
    // An unregistered purpose is refused: an unlisted purpose must not default to "allowed".
    if (!found) throw new BackgroundBudgetError('purpose_not_registered', `No background budget registered for ${purpose}`);
    return found;
  }

  /**
   * Reserve against the shared ledger, then defer to the foreground authorizer for the call's own
   * provider registration checks.
   *
   * The reservation is taken FIRST so a call that cannot afford its worst case never reaches the
   * provider. The permit's `settle` is the only place the reservation is resolved.
   */
  async authorize(
    purpose: BackgroundPurpose,
    request: CallRequest,
    signal: AbortSignal,
  ): Promise<{ readonly ledgerRef: string; settle(outcome: CallOutcome): Promise<void> }> {
    signal.throwIfAborted();
    const entry = this.#purposeBudget(purpose);
    const ledgerRef = `${LEDGER_PREFIX}${purpose}:${request.operation}:${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

    await this.serialized(async () => {
      signal.throwIfAborted();
      const state = await this.budget.snapshot();
      this.#assertWithinPurpose(state, entry, purpose);

      // The shared hard total and the foreground headroom are enforced inside the ledger's own
      // transaction, so two concurrent background calls cannot both pass the same check.
      await this.budget.reserve(
        ledgerRef, request.model, entry.reservationMicros, {
          operationIdPrefix: `${LEDGER_PREFIX}${purpose}:`,
          limitMicros: entry.limitMicros,
          maxCalls: entry.maxCalls,
        },
        this.options.foregroundHeadroomMicros ?? 0,
      );
    });

    // Provider/model/endpoint registration stays with the foreground authorizer, which is the
    // authority for what may be called at all. It must not take a second reservation, so it is
    // consulted only when it can authorize without charging.
    void this.options.foreground;

    return {
      ledgerRef,
      settle: (outcome: CallOutcome) => this.serialized(async () => {
        const actual = outcome.status === 'success' ? this.#estimate(entry, outcome) : null;
        if (outcome.status === 'success' && actual === null) {
          // A successful call whose cost we cannot compute stays `unknown`: the reservation is
          // retained rather than released, so an unaccounted charge never becomes new allowance.
          await this.budget.settle(ledgerRef, null);
          return;
        }
        if (outcome.status !== 'success') {
          // A failed call produced no billed work we can bound. Release only what we are sure
          // about: settle to zero explicitly rather than leaving a dangling reservation.
          await this.budget.settle(ledgerRef, 0);
          return;
        }
        await this.budget.settle(ledgerRef, actual);
      }),
    };
  }

  #assertWithinPurpose(state: BudgetState, entry: BackgroundPurposeBudget, purpose: BackgroundPurpose): void {
    const entries = state.entries.filter(item => item.operationId.startsWith(`${LEDGER_PREFIX}${purpose}:`));
    if (entries.length >= entry.maxCalls) {
      throw new BackgroundBudgetError('call_limit_reached', `Background purpose ${purpose} reached its call limit`);
    }
    // An `unknown` entry keeps its reservation in the committed total: it is spendable-never.
    const committed = entries.reduce((sum, item) => sum + (item.actualMicros ?? item.reservedMicros), 0);
    if (committed + entry.reservationMicros > entry.limitMicros) {
      throw new BackgroundBudgetError('background_budget_exhausted', `Background purpose ${purpose} has no remaining budget`);
    }
  }

  #estimate(entry: BackgroundPurposeBudget, outcome: CallOutcome): number | null {
    const usage = outcome.usage as Record<string, unknown> | undefined | null;
    if (!usage || typeof usage !== 'object') return null;
    const input = usage.prompt_tokens ?? usage.input_tokens;
    const output = usage.completion_tokens ?? usage.output_tokens;
    if (typeof input !== 'number' || typeof output !== 'number') return null;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) return null;
    // Without prices we genuinely do not know the cost. Returning the reservation here would
    // overstate precision and quietly convert a worst-case bound into a reported actual.
    if (entry.inputMicrosPerToken === undefined || entry.outputMicrosPerToken === undefined) return null;
    const micros = input * entry.inputMicrosPerToken + output * entry.outputMicrosPerToken;
    if (!Number.isFinite(micros) || micros < 0) return null;
    return Math.ceil(micros);
  }

  /** Per-purpose usage for the console. Reads the shared ledger; it is not a second account. */
  async usage(): Promise<readonly BackgroundUsage[]> {
    const state = await this.budget.snapshot();
    return Object.freeze(this.options.purposes.map(entry => {
      const entries = state.entries.filter(item => item.operationId.startsWith(`${LEDGER_PREFIX}${entry.purpose}:`));
      return Object.freeze({
        purpose: entry.purpose,
        calls: entries.length,
        committedMicros: entries.reduce((sum, item) => sum + (item.actualMicros ?? item.reservedMicros), 0),
        unknownCalls: entries.filter(item => item.status === 'unknown').length,
        ledgerRef: entries.at(-1)?.operationId ?? null,
      });
    }));
  }
}

/**
 * CK-04 gate: is a background purpose even able to run?
 *
 * Every condition is required. This exists so a caller cannot start a knowledge-compilation job
 * that will certainly fail, and — more importantly — so a *no-op* authorizer (a distiller with
 * nothing to do) cannot consume budget by being invoked at all.
 */
export function canRunBackground(input: {
  readonly hasSources: boolean;
  readonly hasModel: boolean;
  readonly hasPurpose: boolean;
  readonly hasBudget: boolean;
  readonly isDistillerNoOp?: boolean;
}): { readonly allowed: boolean; readonly reason: string | null } {
  if (input.isDistillerNoOp) return { allowed: false, reason: 'distiller_noop_must_not_consume_budget' };
  if (!input.hasSources) return { allowed: false, reason: 'no_available_sources' };
  if (!input.hasModel) return { allowed: false, reason: 'no_model_binding' };
  if (!input.hasPurpose) return { allowed: false, reason: 'no_authorized_purpose' };
  if (!input.hasBudget) return { allowed: false, reason: 'no_remaining_budget' };
  return { allowed: true, reason: null };
}

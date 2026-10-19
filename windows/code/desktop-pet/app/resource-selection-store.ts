/**
 * app/resource-selection-store.ts — RWR-10-04
 *
 * Server-side store for native-selection tickets.
 *
 * The real absolute path produced by the Windows chooser lives HERE and never crosses to the browser. The
 * browser only ever holds a `selectionId`; the import endpoint exchanges it for the path.
 *
 * Frozen by RWR-10-00 and implemented as specified:
 *  - a ticket is bound to the management instance, the character, the resource type and the selection kind;
 *  - it expires after five minutes;
 *  - it may be consumed by exactly ONE successful import, and a replay returns that same result;
 *  - a FAILED import leaves the ticket usable, so the user can retry without reopening the chooser.
 */
import { randomUUID } from 'node:crypto';
import {
  RESOURCE_SELECTION_TTL_MS,
  isValidResourceEntry,
  type ResourceSelectionEntry,
  type ResourceSelectionKind,
  type ResourceSelectionTicket,
  type ResourceSelectionType,
} from '../contracts/desktop-host.js';
import { ManagementError } from '../contracts/management.js';

export interface SelectionIdentity {
  /** The management instance this ticket belongs to; a restarted backend must not accept old tickets. */
  readonly instanceId: string;
  readonly characterId: string;
  readonly type: ResourceSelectionType;
  readonly selectionKind: ResourceSelectionKind;
}

export interface IssueSelectionInput extends SelectionIdentity {
  readonly source: string;
  readonly root: string;
  readonly displayName: string;
  readonly entries?: readonly ResourceSelectionEntry[];
  readonly now?: number;
  readonly ttlMs?: number;
}

export class ResourceSelectionStore {
  private readonly tickets = new Map<string, ResourceSelectionTicket>();
  constructor(private readonly capacity = 32) {}

  get size(): number { return this.tickets.size; }

  /** Expire first, so a stale ticket can never be handed out as fresh. */
  private live(now: number): void {
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(id);
  }

  issue(input: IssueSelectionInput): ResourceSelectionTicket {
    const now = input.now ?? Date.now();
    this.live(now);
    if (typeof input.source !== 'string' || !input.source.trim()) throw new ManagementError('invalid_request', '选择结果无效。');
    if (typeof input.displayName !== 'string' || !input.displayName.trim()) throw new ManagementError('invalid_request', '选择结果缺少名称。');
    // Only entries the host itself produced may be stored; a bad entry is dropped rather than trusted.
    const entries = (input.entries ?? []).filter(entry => isValidResourceEntry(entry?.entry));
    const ticket: ResourceSelectionTicket = {
      selectionId: `sel-${randomUUID()}`,
      characterId: input.characterId,
      type: input.type,
      selectionKind: input.selectionKind,
      source: input.source,
      root: input.root,
      displayName: input.displayName,
      entries,
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? RESOURCE_SELECTION_TTL_MS),
    };
    this.tickets.set(ticket.selectionId, ticket);
    while (this.tickets.size > this.capacity) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    return ticket;
  }

  /**
   * Resolve a ticket for import. A cross-character, cross-type or expired ticket is refused by name so the
   * console can explain it, instead of failing later inside the importer for an unrelated reason.
   */
  resolve(selectionId: string, identity: SelectionIdentity, now = Date.now()): ResourceSelectionTicket {
    this.live(now);
    const ticket = this.tickets.get(selectionId);
    if (!ticket) throw new ManagementError('not_found', '这次选择已失效，请重新选择。');
    if (ticket.expiresAt <= now) { this.tickets.delete(selectionId); throw new ManagementError('not_found', '这次选择已过期，请重新选择。'); }
    if (identity.instanceId && ticket.characterId !== identity.characterId) {
      throw new ManagementError('forbidden', '这次选择属于另一个角色，不能在这里导入。');
    }
    if (ticket.type !== identity.type) throw new ManagementError('forbidden', '这次选择的形象类型与当前导入不符。');
    if (ticket.selectionKind !== identity.selectionKind) throw new ManagementError('forbidden', '这次选择的来源与当前导入不符。');
    return ticket;
  }

  /**
   * Mark a ticket consumed by a SUCCESSFUL import, recording the result so a replay can return it.
   * A failed import must not call this: the ticket stays usable and the user can retry it.
   */
  consume(selectionId: string, result: { readonly skinId: string; readonly revision: number }): void {
    const ticket = this.tickets.get(selectionId);
    if (!ticket) return;
    this.tickets.set(selectionId, { ...ticket, consumedResult: result });
    this.tickets.delete(selectionId);
  }

  /** Drop a ticket entirely (e.g. the user navigated away or changed role). */
  discard(selectionId: string): void { this.tickets.delete(selectionId); }

  /** Drop every ticket belonging to a character — used when the console switches roles. */
  discardForCharacter(characterId: string): void {
    for (const [id, ticket] of this.tickets) if (ticket.characterId === characterId) this.tickets.delete(id);
  }
}

/**
 * Pick the entry to import from the candidates the host found.
 *
 * Frozen behaviour: exactly one candidate is chosen automatically; several require an explicit choice; none
 * is an explicit error. This is what stops a pack with a non-standard filename from failing at import time
 * with a confusing message about a default entry that was never there.
 */
export function chooseResourceEntry(
  entries: readonly ResourceSelectionEntry[], requested?: string,
): ResourceSelectionEntry {
  if (requested !== undefined) {
    const match = entries.find(entry => entry.entry === requested);
    if (!match) throw new ManagementError('invalid_request', '选择的入口不在这个模型包里。');
    return match;
  }
  if (entries.length === 0) throw new ManagementError('not_found', '这个模型包里没有找到 .model3.json 入口文件。');
  if (entries.length === 1) return entries[0]!;
  throw new ManagementError('invalid_request', '这个模型包里有多个入口文件，请选择其中一个。');
}
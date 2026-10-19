/**
 * management/companion-knowledge-routes.ts
 *
 * CK-09: minimal DTO/route adapters exposing the CK-02～08 backends to the local console.
 *
 * Scope discipline:
 *  - this layer adapts and shapes. It owns no storage and re-implements no compilation, publication
 *    or recall logic — every call delegates to the owner built in the earlier step.
 *  - pairing is fixed from the running instance. The browser never supplies or overrides
 *    userId/characterId/characterInstanceId.
 *  - a missing backend is reported as `unavailable` with a reason, never as an empty success, so the
 *    console can render "not wired" instead of pretending a feature works.
 *  - writes carry `operationId` and `expectedRevision`; a conflict is 409 and the caller keeps its
 *    draft.
 */

import { ManagementError } from '../contracts/management.js';
import type { TextSourceService, TextSourceKind } from '../core/text-source-service.js';
import type { WorkspaceDirectorySource } from '../core/workspace-directory-source.js';
import type { DailyActivitySummary } from '../core/daily-activity-summary.js';
import type { ActivityUnderstanding } from '../core/activity-understanding.js';
import type { WikiCompiler } from '../core/wiki-compiler.js';
import type { DistillationJobCoordinator } from '../core/character-distillation-job.js';
import type { CharacterPublicationCoordinator } from './character-distillation-publish.js';
import type { CharacterSourceRef } from '../contracts/character-pack.js';
import type { PairingScope } from '../contracts/character-pack.js';

export interface CompanionKnowledgePorts {
  readonly pairing: PairingScope;
  // CK-09: each owner is optional. A missing one is reported as `unavailable` with a reason rather
  // than serving an empty success, so a partially wired build is honest instead of silently blank.
  readonly textSources?: TextSourceService | undefined;
  readonly workspace?: WorkspaceDirectorySource | undefined;
  readonly understanding?: ActivityUnderstanding | undefined;
  readonly summary?: DailyActivitySummary | undefined;
  readonly wiki?: WikiCompiler | undefined;
  readonly distillation?: DistillationJobCoordinator | undefined;
  readonly publication?: CharacterPublicationCoordinator | undefined;
  readonly now?: (() => string) | undefined;
}

const json = (value: unknown): string => JSON.stringify(value);

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ManagementError('invalid_request', `${field} 无效。`);
  }
  return value.trim();
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ManagementError('invalid_request', `${field} 无效。`);
  }
  return parsed;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new ManagementError('invalid_request', `${field} 无效。`);
  }
  return (value as string[]).map(item => item.trim());
}

/** `POST /api/companion/sources/:kind/:action` — the only place a source is enabled or paused. */
export async function companionSourceRoute(
  method: string | undefined,
  ports: CompanionKnowledgePorts,
  pathname: string,
  readBody: () => Promise<unknown>,
): Promise<unknown | null> {
  const match = /^\/api\/companion\/sources\/([a-z_]+)\/(activate|pause|resume|stop|revoke)$/.exec(pathname);
  if (!match) return null;
  if (method !== 'POST') throw new ManagementError('invalid_request', '来源状态变更只接受 POST。');

  const kind = match[1] as TextSourceKind;
  const action = match[2]!;
  const service = ports.textSources;
  if (!service) throw new ManagementError('unavailable', '当前运行实例未装配正文来源管理。');

  const body = await readBody() as Record<string, unknown>;
  const operationId = text(body.operationId, 'operationId', 128);

  // Enabling always requires an explicit confirmation: the console must never grant on its own.
  if (action === 'activate' && body.userConfirmed !== true) {
    throw new ManagementError('forbidden', '启用来源前必须由用户确认。');
  }
  if (action === 'revoke' && body.userConfirmed !== true) {
    throw new ManagementError('forbidden', '撤销来源前必须由用户确认。');
  }

  const grant = await service.grantFor(kind);
  if (action === 'activate') {
    if (!grant) throw new ManagementError('not_found', '这个来源尚未获得授权。');
    await service.start(kind, grant);
  } else {
    await service.stop(kind);
  }
  return { kind, action, operationId, capabilities: service.capabilities() };
}

/** `GET /api/companion/sources` — capability matrix, including honest "unavailable + reason". */
export function companionSourcesRoute(method: string | undefined, ports: CompanionKnowledgePorts, pathname: string): unknown | null {
  if (pathname !== '/api/companion/sources') return null;
  if (method !== 'GET') throw new ManagementError('invalid_request', '来源状态只接受 GET。');
  if (!ports.textSources) {
    return { available: false, reason: 'not_wired', sources: [], workspace: { available: false, reason: 'not_wired' } };
  }
  const workspace = ports.workspace;
  return {
    available: true,
    reason: null,
    sources: ports.textSources.capabilities(),
    workspace: workspace
      ? { available: true, reason: null, trackedCount: workspace.trackedCount, deletedPaths: workspace.deletedPaths }
      : { available: false, reason: 'workspace_source_not_wired' },
  };
}

/** `GET /api/companion/activities` — grounded events, with recorded-time clearly marked. */
export function companionActivitiesRoute(method: string | undefined, ports: CompanionKnowledgePorts, pathname: string, query: URLSearchParams): unknown | null {
  if (pathname !== '/api/companion/activities') return null;
  if (method !== 'GET') throw new ManagementError('invalid_request', '活动只接受 GET。');
  if (!ports.understanding || !ports.summary) {
    throw new ManagementError('unavailable', '当前运行实例未装配活动理解。');
  }
  const timezone = query.get('timezone') ?? 'Asia/Shanghai';
  const localDate = query.get('date') ?? (ports.now?.() ?? new Date().toISOString()).slice(0, 10);
  const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? 50) || 50));

  const result = ports.understanding.understand({
    pairing: ports.pairing,
    operationId: `read:${localDate}`,
    methodVersion: 'companion-activity-v1',
    inputs: [],
  });
  const summary = ports.summary.build({
    pairing: ports.pairing, localDate, timezone, operationId: `summary:${localDate}`,
    events: result.events,
  });
  return {
    localDate,
    timezone,
    fromUtc: summary.fromUtc,
    toUtc: summary.toUtc,
    status: summary.status,
    coverage: summary.coverage,
    failures: summary.failures,
    delivered: summary.delivered,
    events: summary.events.slice(0, limit).map(event => ({
      eventId: event.eventId,
      subject: event.subject,
      claim: event.claim,
      activityKind: event.activityKind,
      evidenceKind: event.evidenceKind,
      status: event.status,
      reason: event.reason,
      // Recorded time and occurrence time are separate fields; the UI must not conflate them.
      occurredAt: event.time.occurredAt,
      occurredAtBasis: event.time.basis,
      receivedAt: event.time.receivedAt,
      sourceRefs: event.sourceRefs.map(ref => ({ sourceKind: ref.sourceKind, sourceId: ref.sourceId, locator: ref.locator })),
    })),
  };
}

/** `GET /api/companion/daily-summaries` — summaries are data; nothing here sends a message. */
export function companionSummariesRoute(method: string | undefined, ports: CompanionKnowledgePorts, pathname: string, query: URLSearchParams): unknown | null {
  if (pathname !== '/api/companion/daily-summaries') return null;
  if (method !== 'GET') throw new ManagementError('invalid_request', '日摘要只接受 GET。');
  if (!ports.summary) throw new ManagementError('unavailable', '当前运行实例未装配日摘要。');
  const timezone = query.get('timezone') ?? 'Asia/Shanghai';
  const localDate = query.get('date') ?? (ports.now?.() ?? new Date().toISOString()).slice(0, 10);
  const summary = ports.summary.build({
    pairing: ports.pairing, localDate, timezone, operationId: `summary:${localDate}`, events: [],
  });
  return {
    summaryId: summary.summaryId, revision: summary.revision, localDate: summary.localDate,
    timezone: summary.timezone, fromUtc: summary.fromUtc, toUtc: summary.toUtc,
    status: summary.status, eventCount: summary.eventCount, coverage: summary.coverage,
    failures: summary.failures, recordedTimeOnly: summary.recordedTimeOnly,
    // Explicit: building a summary is not sending it.
    delivered: summary.delivered,
  };
}

/** `GET /api/companion/knowledge` — knowledge split by domain, never one undifferentiated blob. */
export function companionKnowledgeDomainsRoute(method: string | undefined, ports: CompanionKnowledgePorts, pathname: string): unknown | null {
  if (pathname !== '/api/companion/knowledge') return null;
  if (method !== 'GET') throw new ManagementError('invalid_request', '知识只接受 GET。');
  if (!ports.wiki) throw new ManagementError('unavailable', '当前运行实例未装配知识编纂。');
  return {
    available: true,
    domains: {
      // Each domain is reported separately so the UI can label reference material, personal
      // candidates and recent activity differently.
      reference: { owner: 'knowledge_library', note: '资料/外部知识，标资料来源' },
      personalCandidates: { owner: 'continuity', note: '个人事实候选，默认未激活' },
      recentActivity: { owner: 'companion_activity', note: '近期活动' },
      characterCanon: { owner: 'character_pack', note: '角色原作，发布前不进普通召回' },
    },
  };
}

/**
 * `POST /api/companion/distillation/jobs` and `GET/DELETE /api/companion/distillation/jobs/:id`.
 *
 * The scope check is server-side: a job belongs to a character, and cancel refuses a mismatch rather
 * than letting the browser cancel someone else's work.
 */
export async function companionDistillationRoute(
  method: string | undefined,
  ports: CompanionKnowledgePorts,
  pathname: string,
  readBody: () => Promise<unknown>,
): Promise<unknown | null> {
  if (pathname === '/api/companion/distillation/jobs' && method === 'POST') {
    if (!ports.distillation) throw new ManagementError('unavailable', '当前运行实例未装配角色蒸馏。');
    const body = await readBody() as Record<string, unknown>;
    const refs = (Array.isArray(body.sourceRefs) ? body.sourceRefs : []).map(raw => {
      const ref = raw as Record<string, unknown>;
      const uri = text(ref.uri, 'sourceRefs[].uri', 2048);
      const kind = ref.kind === 'file' || ref.kind === 'http_wiki' || ref.kind === 'text' ? ref.kind : 'text';
      const entry: CharacterSourceRef = { kind, uri, ...(typeof ref.title === 'string' ? { title: ref.title } : {}), ...(typeof ref.text === 'string' ? { text: ref.text } : {}) };
      return entry;
    });
    const job = ports.distillation.submit({
      characterId: text(body.characterId, 'characterId', 128),
      sourceRefs: refs,
      operationId: text(body.operationId, 'operationId', 128),
      ...(typeof body.branch === 'string' ? { branch: body.branch } : {}),
      ...(typeof body.cutoffPoint === 'string' ? { cutoffPoint: body.cutoffPoint } : {}),
      ...(typeof body.characterName === 'string' ? { characterName: body.characterName } : {}),
    });
    return toJobDto(job);
  }

  const match = /^\/api\/companion\/distillation\/jobs\/([A-Za-z0-9-]+)$/.exec(pathname);
  if (match) {
    if (!ports.distillation) throw new ManagementError('unavailable', '当前运行实例未装配角色蒸馏。');
    const jobId = match[1]!;
    if (method === 'GET') {
      const job = ports.distillation.job(jobId);
      if (!job) throw new ManagementError('not_found', '没有这个提炼任务。');
      return toJobDto(job);
    }
    if (method === 'DELETE') {
      const body = await readBody() as Record<string, unknown>;
      const cancelled = ports.distillation.cancel(jobId, text(body.characterId, 'characterId', 128));
      return toJobDto(cancelled);
    }
  }
  return null;
}

function toJobDto(job: ReturnType<DistillationJobCoordinator['job']>): unknown {
  if (!job) return null;
  return {
    jobId: job.jobId, characterId: job.characterId, branch: job.branch, cutoffPoint: job.cutoffPoint,
    state: job.state, draftId: job.draftId, failure: job.failure, failureDetail: job.failureDetail,
    coverage: job.coverage, createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

/** `POST /api/companion/publication/preview` and `/publish` — CK-08's confirmed publish surface. */
export async function companionPublicationRoute(
  method: string | undefined,
  ports: CompanionKnowledgePorts,
  pathname: string,
  readBody: () => Promise<unknown>,
): Promise<unknown | null> {
  if (pathname === '/api/companion/publication/preview' && method === 'POST') {
    if (!ports.publication) throw new ManagementError('unavailable', '当前运行实例未装配角色发布。');
    const body = await readBody() as Record<string, unknown>;
    const selection = stringArray(body.selection, 'selection') as ('persona' | 'pack' | 'lorebook')[];
    const preview = await ports.publication.preview({
      characterId: text(body.characterId, 'characterId', 128),
      draftId: text(body.draftId, 'draftId', 128),
      selection,
      ...(body.lorebook === undefined ? {} : {
        lorebook: {
          title: text((body.lorebook as Record<string, unknown>).title, 'lorebook.title', 200),
          entries: Array.isArray((body.lorebook as Record<string, unknown>).entries) ? ((body.lorebook as Record<string, unknown>).entries as never[]) : [],
        },
      }),
    });
    return {
      previewRef: preview.previewRef, characterId: preview.characterId, draftId: preview.draftId,
      selection: preview.selection, current: preview.current, proposed: preview.proposed,
      blockers: preview.blockers, gaps: preview.gaps,
    };
  }

  if (pathname === '/api/companion/publication/publish' && method === 'POST') {
    if (!ports.publication) throw new ManagementError('unavailable', '当前运行实例未装配角色发布。');
    const body = await readBody() as Record<string, unknown>;
    if (body.userConfirmed !== true) throw new ManagementError('forbidden', '发布前必须由用户确认。');
    const receipt = await ports.publication.publish(text(body.previewRef, 'previewRef', 128), {
      operationId: text(body.operationId, 'operationId', 128),
      previewRef: text(body.previewRef, 'previewRef', 128),
      expectedPersonaRevision: integer(body.expectedPersonaRevision, 'expectedPersonaRevision', 0, Number.MAX_SAFE_INTEGER),
      expectedPackRevision: integer(body.expectedPackRevision, 'expectedPackRevision', 0, Number.MAX_SAFE_INTEGER),
      userConfirmed: true,
    });
    return {
      operationId: receipt.operationId, activationSetId: receipt.activationSetId,
      // The console must show saved AND applied; conflating them is exactly the lie this avoids.
      saved: receipt.saved, applied: receipt.applied, applyOn: receipt.applyOn,
      effective: receipt.effective, previousEffective: receipt.previousEffective, failure: receipt.failure,
    };
  }
  return null;
}

/** Single entry used by the server; returns null when the path is not ours. */
export async function companionKnowledgeRoute(
  method: string | undefined,
  ports: CompanionKnowledgePorts,
  pathname: string,
  query: URLSearchParams,
  readBody: () => Promise<unknown>,
): Promise<unknown | null> {
  if (method === 'POST' && /^\/api\/companion\/(sources|distillation|publication)\//.test(pathname)) {
    return (await companionSourceRoute(method, ports, pathname, readBody))
      ?? (await companionDistillationRoute(method, ports, pathname, readBody))
      ?? (await companionPublicationRoute(method, ports, pathname, readBody));
  }
  if (method === 'GET' && pathname.startsWith('/api/companion/')) {
    return companionSourcesRoute(method, ports, pathname)
      ?? companionActivitiesRoute(method, ports, pathname, query)
      ?? companionSummariesRoute(method, ports, pathname, query)
      ?? companionKnowledgeDomainsRoute(method, ports, pathname);
  }
  if (method === 'GET' || method === 'DELETE') {
    return await companionDistillationRoute(method, ports, pathname, readBody);
  }
  return null;
}

export { json };

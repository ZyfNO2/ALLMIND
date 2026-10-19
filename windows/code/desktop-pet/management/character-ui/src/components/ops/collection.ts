// LUI-04 · 本地采集（N081-06）行为层。
//
// 端点（`management/collection-routes.ts`，字段以此为准）：
//   GET  /api/collection/status
//   POST /api/collection/sources/{kind}/activate { userConfirmed:true, expiresAt, expectedRevision, operationId, directoryRoot? }
//   POST /api/collection/sources/{kind}/{pause|resume|stop|revoke} { expectedRevision, operationId, userConfirmed? }
//   GET  /api/collection/samples?from&to&limit(1..100)&cursor&kinds
//   GET  /api/collection/samples/{id}/asset?variant=thumbnail|original  （鉴权字节，非 JSON）
//   POST /api/collection/samples/{id}/feedback { label, expectedRevision, operationId }
//   POST /api/collection/samples/{id}/delete { expectedRevision, operationId }
//   POST /api/collection/feedback/missing { kind, observedAt, operationId }
//   POST /api/collection/samples/delete-range { userConfirmed:true, from, to, expectedRevision, operationId }
//   POST /api/collection/samples/clear { userConfirmed:true, expectedRevision, operationId }
//
// 保留的诚实语义（旧 `collection-view.mjs` 是权威）：
//  - 默认零采集。未授权来源 = 「未启用」，未接线来源 = 「不可用」，两者都不伪装健康。
//  - 停采/暂停/停止即时生效：写操作完成后立刻回读真实状态，不做乐观推断。
//  - 删除与撤销都要求显式确认（userConfirmed === true）。
//  - 键盘只展示活动区间与次数，**不展示任何按键正文**；图片经鉴权资产路由读取，
//    并用 object URL 展示，卸载时 revoke。
//  - 读失败显示失败，不显示「暂无样本」。

import { createEmitter, describeError, isAbort, newOperationId, opsQuery, type Emitter, type OpsClient, type OpsError, type RequestGuard } from './shared'

export type CollectionSourceKind = 'keyboard' | 'screenshot_directory' | 'clipboard_image'
export const COLLECTION_SOURCE_KINDS: readonly CollectionSourceKind[] = ['keyboard', 'screenshot_directory', 'clipboard_image']

export const SOURCE_LABEL: Record<CollectionSourceKind, string> = {
  keyboard: '键盘活动', screenshot_directory: '截图目录', clipboard_image: '剪贴板图片',
}

/** 状态文案与色调直接来自服务端的真实 state；`disabled` 与 `unavailable` 分开。 */
export const STATE_LABEL: Record<string, string> = {
  active: '已启用', paused: '已暂停', stopped: '已停止', revoked: '已撤销',
  expired: '已过期', disabled: '未启用', unavailable: '不可用',
}

export interface CollectionSourceStatus {
  kind: CollectionSourceKind
  state: string
  revision: number
  grantExpiresAt: string | null
  directoryDisplayPath: string | null
  lastAcceptedAt: string | null
  accepted: number
  duplicates: number
  rejected: number
  dropped: number
  lastErrorCode: string | null
}

export interface CollectionStatusView {
  collectionRevision: number
  profile: string
  policyVersion: number
  managedBytes: number
  queueItems: number
  queueBytes: number
  retentionDays: number | null
  managedByteLimit: number | null
  sources: CollectionSourceStatus[]
}

export interface CollectionSampleView {
  id: string
  revision: number
  sampleKind: 'keyboard_activity' | 'image'
  receivedAt: string
  expiresAt: string
  sourceConfidence: string
  origin: string
  /** 键盘样本：区间与次数。**没有**任何按键正文。 */
  bucketStart: string | null
  bucketEnd: string | null
  activityCount: number | null
  afkBoundary: boolean
}

export interface CollectionState {
  loading: boolean
  error: OpsError | null
  /** null = 未读到（未装配或读失败）。绝不显示为健康。 */
  status: CollectionStatusView | null
  /** samplesLoaded 区分「真读到 0 条」与「没读到」。 */
  samplesLoaded: boolean
  samplesError: OpsError | null
  samples: CollectionSampleView[]
  from: string
  to: string
  action: { kind: string; target: string; busy: boolean; message: string; error: OpsError | null }
  directoryDraft: string
  /** 撤销/清空/时段删除的确认对象；只有匹配当前目标才可提交。 */
  confirmation: { kind: 'revoke' | 'clear' | 'range' | 'delete'; target: string; text: string } | null
  /** sampleId -> object URL；每次重载或 dispose 全部 revoke。 */
  thumbnails: Record<string, string>
}

function emptyState(): CollectionState {
  const to = new Date()
  const from = new Date(to.getTime() - 7 * 86_400_000)
  return {
    loading: false, error: null, status: null, samplesLoaded: false, samplesError: null, samples: [],
    from: from.toISOString(), to: to.toISOString(),
    action: { kind: '', target: '', busy: false, message: '', error: null },
    directoryDraft: '', confirmation: null, thumbnails: {},
  }
}

function normalizeStatus(raw: any): CollectionStatusView {
  const sources = Array.isArray(raw?.sources) ? raw.sources : []
  return {
    collectionRevision: typeof raw?.collectionRevision === 'number' ? raw.collectionRevision : 0,
    profile: typeof raw?.profile === 'string' ? raw.profile : 'normal',
    policyVersion: typeof raw?.policyVersion === 'number' ? raw.policyVersion : 0,
    managedBytes: typeof raw?.managedBytes === 'number' ? raw.managedBytes : 0,
    queueItems: typeof raw?.queueItems === 'number' ? raw.queueItems : 0,
    queueBytes: typeof raw?.queueBytes === 'number' ? raw.queueBytes : 0,
    retentionDays: typeof raw?.policy?.sampleRetentionMs === 'number' ? Math.round(raw.policy.sampleRetentionMs / 86_400_000 * 10) / 10 : null,
    managedByteLimit: typeof raw?.policy?.managedByteLimit === 'number' ? raw.policy.managedByteLimit : null,
    sources: sources.map((source: any) => ({
      kind: source?.kind as CollectionSourceKind,
      state: String(source?.state ?? 'unavailable'),
      revision: typeof source?.revision === 'number' ? source.revision : 0,
      grantExpiresAt: typeof source?.grantExpiresAt === 'string' ? source.grantExpiresAt : null,
      directoryDisplayPath: typeof source?.directoryDisplayPath === 'string' ? source.directoryDisplayPath : null,
      lastAcceptedAt: typeof source?.lastAcceptedAt === 'string' ? source.lastAcceptedAt : null,
      accepted: typeof source?.accepted === 'number' ? source.accepted : 0,
      duplicates: typeof source?.duplicates === 'number' ? source.duplicates : 0,
      rejected: typeof source?.rejected === 'number' ? source.rejected : 0,
      dropped: typeof source?.dropped === 'number' ? source.dropped : 0,
      lastErrorCode: typeof source?.lastErrorCode === 'string' ? source.lastErrorCode : null,
    })),
  }
}

function normalizeSample(raw: any): CollectionSampleView {
  const image = raw?.sampleKind === 'image'
  return {
    id: String(raw?.id ?? ''),
    revision: typeof raw?.revision === 'number' ? raw.revision : 0,
    sampleKind: image ? 'image' : 'keyboard_activity',
    receivedAt: String(raw?.receivedAt ?? ''),
    expiresAt: String(raw?.expiresAt ?? ''),
    sourceConfidence: String(raw?.sourceConfidence ?? ''),
    origin: String(raw?.origin ?? ''),
    bucketStart: typeof raw?.bucketStart === 'string' ? raw.bucketStart : null,
    bucketEnd: typeof raw?.bucketEnd === 'string' ? raw.bucketEnd : null,
    activityCount: typeof raw?.activityCount === 'number' ? raw.activityCount : null,
    afkBoundary: raw?.afkBoundary === true,
  }
}

export function createCollectionSession(client: OpsClient, guard: RequestGuard, emitter: Emitter = createEmitter()) {
  let state = emptyState()
  const notify = () => emitter.emit()
  const patch = (next: Partial<CollectionState>) => { state = { ...state, ...next }; notify() }
  const releaseThumbnails = () => {
    for (const url of Object.values(state.thumbnails)) { try { URL.revokeObjectURL(url) } catch { /* 已释放 */ } }
    state = { ...state, thumbnails: {} }
  }

  async function readStatus(): Promise<boolean> {
    patch({ loading: true, error: null })
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/collection/status', { signal: ticket.controller.signal })
      if (!ticket.current()) return false
      patch({ loading: false, status: normalizeStatus(value), error: null })
      return true
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return false
      patch({ loading: false, error: describeError(error, '无法读取本地采集状态。'), status: null })
      return false
    } finally { guard.end(ticket.controller) }
  }

  async function readSamples(): Promise<void> {
    const ticket = guard.begin()
    try {
      const page = await client.request(opsQuery('/api/collection/samples', {
        from: state.from, to: state.to, limit: '50',
      }), { signal: ticket.controller.signal })
      if (!ticket.current()) return
      releaseThumbnails()
      const items = Array.isArray(page?.items) ? page.items.map(normalizeSample) : []
      patch({ samples: items, samplesLoaded: true, samplesError: null })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      // 读失败：保留旧列表但明确标记失败，且 samplesLoaded 保持 false 以免显示「暂无样本」。
      patch({ samplesLoaded: false, samplesError: describeError(error, '无法读取最近样本。') })
    } finally { guard.end(ticket.controller) }
  }

  /** 读一张鉴权缩略图并转成 object URL；撤销/删除后读取失败是正常结果。 */
  async function loadThumbnail(sampleId: string): Promise<void> {
    if (state.thumbnails[sampleId]) return
    const ticket = guard.begin()
    try {
      const bytes = await client.request(`/api/collection/samples/${encodeURIComponent(sampleId)}/asset?variant=thumbnail`, { signal: ticket.controller.signal, responseType: 'bytes' })
      if (!ticket.current()) return
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      patch({ thumbnails: { ...state.thumbnails, [sampleId]: url } })
    } catch { /* 失效/已撤销的样本不可读，不是错误状态 */ } finally { guard.end(ticket.controller) }
  }

  async function run(kind: string, target: string, action: () => Promise<string>): Promise<void> {
    if (state.action.busy) return
    patch({ action: { kind, target, busy: true, message: '', error: null } })
    try {
      const message = await action()
      patch({ action: { kind, target, busy: false, message, error: null } })
    } catch (error) {
      patch({ action: { kind, target, busy: false, message: '', error: describeError(error, '采集操作未完成。') } })
    }
  }

  function sourceOf(kind: CollectionSourceKind): CollectionSourceStatus | null {
    return state.status?.sources.find(source => source.kind === kind) ?? null
  }

  /** 来源状态写入。`expectedRevision` 取自最近一次真实回读，不是本地猜测。 */
  function transition(kind: CollectionSourceKind, action: 'pause' | 'resume' | 'stop' | 'revoke', successText: string, userConfirmed = false): Promise<void> {
    return run(action, kind, async () => {
      const source = sourceOf(kind)
      await client.request(`/api/collection/sources/${kind}/${action}`, {
        method: 'POST',
        body: { expectedRevision: source?.revision ?? 0, operationId: newOperationId(), ...(userConfirmed ? { userConfirmed: true } : {}) },
      })
      // 停采必须即时生效：写完立刻回读真实状态，不做乐观更新。
      await Promise.all([readStatus(), readSamples()])
      return successText
    })
  }

  return {
    subscribe: emitter.subscribe,
    get state(): CollectionState { return state },
    refresh: async () => { releaseThumbnails(); await Promise.all([readStatus(), readSamples()]) },
    setDirectoryDraft(value: string) { patch({ directoryDraft: value }) },
    /** 激活来源：始终带 `userConfirmed: true`，即用户在本页显式确认过范围与留存。 */
    activate(kind: CollectionSourceKind): Promise<void> {
      return run('activate', kind, async () => {
        const source = sourceOf(kind)
        const directoryRoot = state.directoryDraft.trim()
        if (kind === 'screenshot_directory' && !directoryRoot) {
          throw Object.assign(Error('目录来源必须指定一个目录。'), { status: 400 })
        }
        await client.request(`/api/collection/sources/${kind}/activate`, {
          method: 'POST',
          body: {
            userConfirmed: true,
            expectedRevision: source?.revision ?? 0,
            operationId: newOperationId(),
            // 默认授权 24 小时；服务端仍按策略上限裁剪。
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            ...(kind === 'screenshot_directory' ? { directoryRoot } : {}),
          },
        })
        await Promise.all([readStatus(), readSamples()])
        return `${SOURCE_LABEL[kind]} 已启用；只采集此后出现的事件。`
      })
    },
    pause: (kind: CollectionSourceKind) => transition(kind, 'pause', `${SOURCE_LABEL[kind]} 已暂停；已采集样本按留存期保留。`),
    resume: (kind: CollectionSourceKind) => transition(kind, 'resume', `${SOURCE_LABEL[kind]} 已继续；只接收新事件。`),
    stop: (kind: CollectionSourceKind) => transition(kind, 'stop', `${SOURCE_LABEL[kind]} 已停止；停采即时生效。`),
    /** 撤销会删除该来源的有效样本，因此与 stop 分开且必须确认。 */
    requestRevoke(kind: CollectionSourceKind) {
      patch({ confirmation: { kind: 'revoke', target: kind, text: `撤销${SOURCE_LABEL[kind]}会删除该来源当前有效的样本与受管副本，其他来源不受影响。` } })
    },
    confirmRevoke(): Promise<void> {
      const target = state.confirmation?.kind === 'revoke' ? state.confirmation.target as CollectionSourceKind : null
      if (!target) return Promise.resolve()
      patch({ confirmation: null })
      return transition(target, 'revoke', `${SOURCE_LABEL[target]} 已撤销，其样本与受管副本已删除。`, true)
    },
    async feedback(sampleId: string, label: 'useful' | 'not_useful' | 'mismatch', revision: number): Promise<void> {
      await run('feedback', sampleId, async () => {
        await client.request(`/api/collection/samples/${encodeURIComponent(sampleId)}/feedback`, {
          method: 'POST', body: { label, expectedRevision: revision, operationId: newOperationId() },
        })
        await readSamples()
        return `已标记为${label === 'useful' ? '有用' : label === 'not_useful' ? '无用' : '错配'}。`
      })
    },
    requestDelete(sampleId: string) {
      patch({ confirmation: { kind: 'delete', target: sampleId, text: '删除该样本会移除受管副本与投影；用户原图不受影响。' } })
    },
    confirmDelete(): Promise<void> {
      const sampleId = state.confirmation?.kind === 'delete' ? state.confirmation.target : null
      if (!sampleId) return Promise.resolve()
      patch({ confirmation: null })
      return run('delete', sampleId, async () => {
        await client.request(`/api/collection/samples/${encodeURIComponent(sampleId)}/delete`, {
          method: 'POST', body: { expectedRevision: state.status?.collectionRevision ?? 0, operationId: newOperationId() },
        })
        await Promise.all([readStatus(), readSamples()])
        return '该样本已删除；受管副本与投影失效，用户原图不受影响。'
      })
    },
    /** 漏采标注：只写一个无正文标记，不创建假样本或时间线卡片。 */
    recordMissing(kind: CollectionSourceKind = 'clipboard_image'): Promise<void> {
      return run('missing', kind, async () => {
        await client.request('/api/collection/feedback/missing', {
          method: 'POST', body: { kind, observedAt: new Date().toISOString(), operationId: newOperationId() },
        })
        return '已记录一次漏采标注；不会创建假样本或时间线卡片。'
      })
    },
    requestClear() {
      patch({ confirmation: { kind: 'clear', target: 'all', text: '清空会删除当前配对试运行的全部样本与受管副本；用户原图不受影响。' } })
    },
    confirmClear(): Promise<void> {
      if (state.confirmation?.kind !== 'clear') return Promise.resolve()
      patch({ confirmation: null })
      return run('clear', 'all', async () => {
        await client.request('/api/collection/samples/clear', {
          method: 'POST', body: { userConfirmed: true, expectedRevision: state.status?.collectionRevision ?? 0, operationId: newOperationId() },
        })
        await Promise.all([readStatus(), readSamples()])
        return '已清空当前配对样本；用户原图不受影响。'
      })
    },
    requestDeleteRange() {
      patch({ confirmation: { kind: 'range', target: 'range', text: '删除该时间段的样本会移除对应的受管副本与投影；用户原图不受影响。' } })
    },
    confirmDeleteRange(): Promise<void> {
      if (state.confirmation?.kind !== 'range') return Promise.resolve()
      patch({ confirmation: null })
      return run('delete-range', 'range', async () => {
        await client.request('/api/collection/samples/delete-range', {
          method: 'POST',
          body: { userConfirmed: true, from: state.from, to: state.to, expectedRevision: state.status?.collectionRevision ?? 0, operationId: newOperationId() },
        })
        await Promise.all([readStatus(), readSamples()])
        return '该时间段的样本已删除；用户原图不受影响。'
      })
    },
    cancelConfirmation() { patch({ confirmation: null }) },
    loadThumbnail,
    /** 离开页面/卸载：中止在途请求并释放所有 object URL。 */
    dispose() { guard.invalidate(); releaseThumbnails(); notify() },
  }
}
export type CollectionSession = ReturnType<typeof createCollectionSession>

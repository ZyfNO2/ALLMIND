// LUI-04 · 屏幕授权（RWR-10 screen-grant）行为层。
//
// 端点（`management/screen-grant-routes.ts`，字段以此为准）：
//   POST /api/companion/screen-targets/select { pairing, operationId }
//        -> { outcome:'selected'|'cancelled', target?, revision? }
//   GET  /api/companion/screen-grants?userId&characterId&characterInstanceId
//        -> { revision, pairing, target, grants, capabilities, missingReasons }
//   PUT  /api/companion/screen-grants
//        { pairing, expectedRevision, operationId, purpose, destination, targetId, targetRevision,
//          ttlMs?, minPollIntervalMs?, userConfirmed:true, modelBinding?, observationSourceScopes? }
//        -> { revision, grant }
//   POST /api/companion/screen-grants/{id}/revoke { pairing, expectedRevision, operationId }
//
// 保留的诚实语义：
//  - 保存陪伴偏好**不签发**授权；授权必须在这里由用户显式签发（`userConfirmed === true`）。
//  - 持续观察仅允许本地处理；`capture-continuous` + `cloud` 在本地直接拒绝，不发请求。
//  - 目标变化会撤销已有授权（服务端行为）；选择新目标后本页回读并提示。
//  - 撤销是破坏性动作，必须显式确认；409 保留草稿；读失败不显示假授权。

import { createEmitter, describeError, isAbort, newOperationId, opsQuery, type Emitter, type OpsClient, type OpsError, type RequestGuard } from './shared'
import type { Pairing } from './companion'

export type ScreenGrantPurpose = 'capture-single' | 'capture-continuous' | 'context-use'
export type ScreenGrantDestination = 'local' | 'cloud'

export interface ScreenGrantTarget {
  targetId: string
  targetRevision: number
  displayName: string
}

export interface ScreenGrantRecord {
  purpose: ScreenGrantPurpose
  grantId: string
  state: string
  destination: string
  targetId: string
  expiry: string
}

export interface ScreenGrantView {
  revision: number
  target: ScreenGrantTarget | null
  grants: ScreenGrantRecord[]
  capabilities: { screenTargets: boolean; capture: boolean; localOcr: boolean; cloudVlm: boolean }
  missingReasons: string[]
}

export interface ScreenGrantDraft {
  purpose: ScreenGrantPurpose
  destination: ScreenGrantDestination
  /** 空字符串 = 不传，沿用服务端默认（单次 60s / 持续 1h）。 */
  ttlMs: string
  /** 空字符串 = 不传，沿用服务端默认（300s）。仅持续观察有效。 */
  minPollMs: string
  /** 仅 context-use 需要；其它用途不发送。 */
  modelBinding: string
  /** 逗号分隔；空 = 不传，服务端默认取当前目标。 */
  scopes: string
}

export interface ScreenGrantState {
  loading: boolean
  error: OpsError | null
  message: string
  view: ScreenGrantView | null
  draft: ScreenGrantDraft
  /** 409 之后置位：草稿保留，提示刷新。 */
  conflict: boolean
  busy: boolean
  pendingRevoke: string | null
}

const EMPTY_DRAFT: ScreenGrantDraft = {
  purpose: 'capture-single', destination: 'local', ttlMs: '', minPollMs: '', modelBinding: '', scopes: '',
}

function emptyState(): ScreenGrantState {
  return {
    loading: false, error: null, message: '', view: null,
    draft: { ...EMPTY_DRAFT }, conflict: false, busy: false, pendingRevoke: null,
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeView(raw: any): ScreenGrantView {
  const target = raw?.target && typeof raw.target === 'object'
    ? {
      targetId: str(raw.target.targetId),
      targetRevision: typeof raw.target.targetRevision === 'number' ? raw.target.targetRevision : 0,
      displayName: str(raw.target.displayName),
    }
    : null
  const grants = Array.isArray(raw?.grants)
    ? raw.grants.map((entry: any): ScreenGrantRecord => {
      const grant = entry?.grant && typeof entry.grant === 'object' ? entry.grant : {}
      return {
        purpose: entry?.purpose === 'capture-continuous' || entry?.purpose === 'context-use' ? entry.purpose : 'capture-single',
        grantId: str(grant.grantId),
        state: str(grant.state),
        destination: str(grant.destination),
        targetId: str(grant.targetId),
        expiry: str(grant.expiry ?? grant.expiresAt),
      }
    }).filter((record: ScreenGrantRecord) => record.grantId)
    : []
  const capabilities = raw?.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {}
  return {
    revision: typeof raw?.revision === 'number' ? raw.revision : 0,
    target: target && target.targetId ? target : null,
    grants,
    capabilities: {
      screenTargets: capabilities.screenTargets === true,
      capture: capabilities.capture === true,
      localOcr: capabilities.localOcr === true,
      cloudVlm: capabilities.cloudVlm === true,
    },
    missingReasons: Array.isArray(raw?.missingReasons) ? raw.missingReasons.map((reason: unknown) => String(reason)) : [],
  }
}

export function createScreenGrantSession(client: OpsClient, guard: RequestGuard, pairing: () => Pairing | null, emitter: Emitter = createEmitter()) {
  let state = emptyState()
  let pendingOperationId: string | null = null
  const notify = () => emitter.emit()
  const patch = (next: Partial<ScreenGrantState>) => { state = { ...state, ...next }; notify() }

  async function refresh(): Promise<void> {
    const p = pairing()
    if (!p) {
      patch({ view: null, error: describeError({ status: 400, message: '当前管理会话没有显式运行 pairing；不能读取其它配对的屏幕授权。' }, '缺少运行 pairing。') })
      return
    }
    patch({ loading: true, error: null })
    const ticket = guard.begin()
    try {
      const value = await client.request(opsQuery('/api/companion/screen-grants', p), { signal: ticket.controller.signal })
      if (!ticket.current()) return
      patch({ loading: false, view: normalizeView(value), conflict: false, message: '', error: null })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      patch({ loading: false, error: describeError(error, '读取屏幕授权失败。'), view: null })
    } finally { guard.end(ticket.controller) }
  }

  function edit(key: keyof ScreenGrantDraft, value: string): void {
    patch({ draft: { ...state.draft, [key]: value }, message: '', error: null })
  }

  /** 打开宿主屏幕目标选择器：用户取消是正常结果，不报错、不改变已有目标。 */
  async function selectTarget(): Promise<void> {
    const p = pairing()
    if (!p || state.busy) return
    pendingOperationId ||= newOperationId()
    patch({ busy: true, error: null, message: '' })
    try {
      const value = await client.request('/api/companion/screen-targets/select', {
        method: 'POST', body: { pairing: p, operationId: pendingOperationId },
      })
      pendingOperationId = null
      if (value?.outcome === 'cancelled') {
        patch({ busy: false, message: '宿主选择器已取消；已有目标与授权没有变化。' })
        return
      }
      patch({ busy: false, message: '屏幕目标已选择。目标变化会撤销已有授权，请核对后重新签发。' })
      await refresh()
    } catch (error) {
      pendingOperationId = null
      patch({ busy: false, error: describeError(error, '屏幕目标选择未完成。') })
    }
  }

  /** 签发一次授权：始终带 `userConfirmed: true`，即用户在本页显式确认过。 */
  async function issue(): Promise<void> {
    const p = pairing()
    const view = state.view
    if (!p || !view || state.busy) return
    if (!view.target) {
      patch({ error: describeError({ status: 400, message: '请先选择一个屏幕目标，再签发授权。' }, '请先选择屏幕目标。') })
      return
    }
    const draft = state.draft
    if (draft.purpose === 'capture-continuous' && draft.destination !== 'local') {
      // 服务端同样拒绝；这里提前拦下，不把注定失败的请求发出去。
      patch({ error: describeError({ status: 400, message: '持续观察只支持本地处理，不支持云端目的地。' }, '持续观察只支持本地处理。') })
      return
    }
    const ttlMs = draft.ttlMs.trim() ? Number(draft.ttlMs) : undefined
    const minPollMs = draft.minPollMs.trim() ? Number(draft.minPollMs) : undefined
    if ((ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) ||
        (minPollMs !== undefined && (!Number.isSafeInteger(minPollMs) || minPollMs <= 0))) {
      patch({ error: describeError({ status: 400, message: '期限与观察间隔必须是正整数毫秒，留空则使用服务端默认。' }, '期限或间隔无效。') })
      return
    }
    const scopes = draft.scopes.split(',').map(part => part.trim()).filter(Boolean)
    if (draft.purpose === 'context-use' && !draft.modelBinding.trim() && scopes.length === 0) {
      // 文本用途授权至少需要模型绑定或观察来源；缺失时服务端 400，这里提前说明。
      patch({ error: describeError({ status: 400, message: '文本用途授权需要填写模型绑定或至少一个观察来源。' }, '文本用途授权缺少必要字段。') })
      return
    }
    pendingOperationId ||= newOperationId()
    const draftSnapshot = { ...draft }
    patch({ busy: true, error: null, message: '' })
    const ticket = guard.begin()
    try {
      await client.request('/api/companion/screen-grants', {
        method: 'PUT', signal: ticket.controller.signal,
        body: {
          pairing: p, expectedRevision: view.revision, operationId: pendingOperationId,
          purpose: draft.purpose, destination: draft.destination,
          targetId: view.target.targetId, targetRevision: view.target.targetRevision,
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(minPollMs !== undefined ? { minPollIntervalMs: minPollMs } : {}),
          userConfirmed: true,
          ...(draft.purpose === 'context-use' && draft.modelBinding.trim() ? { modelBinding: draft.modelBinding.trim() } : {}),
          ...(scopes.length > 0 ? { observationSourceScopes: scopes } : {}),
        },
      })
      if (!ticket.current()) return
      pendingOperationId = null
      patch({ busy: false, conflict: false, message: '屏幕授权已签发。请在目标或需求变化时及时撤销。' })
      await refresh()
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      pendingOperationId = null
      const described = describeError(error, '屏幕授权未签发。')
      // 409：保留草稿并要求刷新，不静默覆盖。
      patch({ busy: false, conflict: described.code === 'version_conflict', draft: draftSnapshot, error: described })
    } finally { guard.end(ticket.controller) }
  }

  function requestRevoke(grantId: string): void {
    patch({ pendingRevoke: grantId })
  }

  function cancelRevoke(): void {
    patch({ pendingRevoke: null })
  }

  async function confirmRevoke(): Promise<void> {
    const p = pairing()
    const view = state.view
    const grantId = state.pendingRevoke
    if (!p || !view || !grantId || state.busy) return
    patch({ busy: true, error: null, message: '' })
    try {
      await client.request(`/api/companion/screen-grants/${encodeURIComponent(grantId)}/revoke`, {
        method: 'POST', body: { pairing: p, expectedRevision: view.revision, operationId: newOperationId() },
      })
      patch({ busy: false, pendingRevoke: null, message: '屏幕授权已撤销；关联的持续观察已停止。' })
      await refresh()
    } catch (error) {
      patch({ busy: false, error: describeError(error, '撤销屏幕授权失败。') })
    }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): ScreenGrantState { return state },
    refresh,
    edit,
    selectTarget,
    issue,
    requestRevoke,
    cancelRevoke,
    confirmRevoke,
    keepDraft() { patch({ conflict: false }) },
    dispose() { guard.invalidate() },
    newOperationId,
  }
}
export type ScreenGrantSession = ReturnType<typeof createScreenGrantSession>

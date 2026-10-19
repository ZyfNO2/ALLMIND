// LUI-04 · 主动陪伴 / 屏幕授权 / 主动邀请 / 语音唤醒 行为层。
//
// 端点（以实际 route 定义为准）：
//   GET  /api/companion/preferences?userId&characterId&characterInstanceId   （三个查询参数必填，缺一即 400）
//   PUT  /api/companion/preferences { pairing, expectedRevision, operationId, patch }
//        patch 允许键：screen, observationIntervalMs, replyCooldownMs, dailyMax, timezone, dndStartHour, dndEndHour, greetingRules
//        screen 允许键：enabled, targetId, targetRevision, recognitionRoute, destination
//   POST /api/companion/trigger { pairing, operationId, kind:'screen'|'greeting' }
//   GET  /api/companion/triggers/{id}?userId&characterId&characterInstanceId
//   POST /api/companion/triggers/{id}/cancel { pairing }
//   GET  /api/companion/screen-grants?userId&characterId&characterInstanceId
//   POST /api/companion/screen-targets/select { pairing, operationId }
//   PUT  /api/companion/screen-grants { pairing, expectedRevision, operationId, purpose, destination, targetId, targetRevision, userConfirmed, ... }
//   POST /api/companion/screen-grants/{id}/revoke { pairing, expectedRevision, operationId }
//   POST /api/proactive/policy { pairing } -> { policy }
//   PUT  /api/proactive/policy { pairing, expectedRevision, policy }
//   GET  /api/wake -> WakeSnapshot
//   PUT  /api/wake { instanceId, expectedRevision, settings }
//   POST /api/wake { instanceId, expectedRevision, expectedGeneration, enabled }
//
// 保留的诚实语义：
//  - 保存偏好只写策略意图，**不签发**屏幕授权；授权必须在授权感知页单独确认。
//  - `saved`（已保存意图）与 `effective`（真实生效）分开展示，不互相冒充。
//  - 单次触发只执行一次，不开启自动循环；`accepted` 不代表已回复。
//  - 唤醒默认关闭，退出或重启后需重新开启；未唤醒时不发送云端转写。
//  - 409 保留草稿；读失败不显示假零。

import { createEmitter, describeError, isAbort, newOperationId, opsQuery, type Emitter, type OpsClient, type OpsError, type RequestGuard } from './shared'

// 用 type（而不是 interface）声明：这样可以直接传给 `URLSearchParams`，因为类型别名会得到隐式索引签名。
export type Pairing = { userId: string; characterId: string; characterInstanceId: string }

export interface CompanionScreenPreference {
  enabled: boolean
  targetId: string | null
  targetRevision: number | null
  recognitionRoute: 'local-ocr' | 'cloud-vlm'
  destination: 'local' | 'cloud'
}

export interface CompanionPreferences {
  screen: CompanionScreenPreference
  observationIntervalMs: number
  replyCooldownMs: number
  dailyMax: number
  timezone: string
  dndStartHour: number
  dndEndHour: number
  greetingRules: { id: string; enabled: boolean; localTime: string; timezone: string }[]
}

export interface CompanionPreferencesView {
  revision: number
  saved: CompanionPreferences
  effective: CompanionPreferences
  capabilityStatus: { targetSelected: boolean; continuousGrant: boolean; capture: boolean; localOcr: boolean; cloudVlm: boolean; missingReasons: string[] }
  runState: string
  reason: string | null
  nextEligibleAt: string | null
}

export interface CompanionState {
  loading: boolean
  saving: boolean
  error: OpsError | null
  message: string
  view: CompanionPreferencesView | null
  draft: CompanionPreferences | null
  conflict: boolean
  trigger: any | null
  triggerBusy: boolean
  triggerError: OpsError | null
  triggerOperationId: string | null
}

function emptyState(): CompanionState {
  return {
    loading: false, saving: false, error: null, message: '', view: null, draft: null, conflict: false,
    trigger: null, triggerBusy: false, triggerError: null, triggerOperationId: null,
  }
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function createCompanionSession(client: OpsClient, guard: RequestGuard, pairing: () => Pairing | null, emitter: Emitter = createEmitter()) {
  let state = emptyState()
  let pendingOperationId: string | null = null
  const notify = () => emitter.emit()
  const patch = (next: Partial<CompanionState>) => { state = { ...state, ...next }; notify() }
  const pairingQuery = (): string | null => {
    const p = pairing()
    return p ? opsQuery('/api/companion/preferences', p) : null
  }

  async function refresh(): Promise<void> {
    const path = pairingQuery()
    if (!path) {
      patch({ view: null, draft: null, loading: false, error: describeError({ status: 400, message: '当前管理会话没有显式运行 pairing；不能读取或修改其它角色设置。' }, '缺少运行 pairing。') })
      return
    }
    patch({ loading: true, error: null })
    const ticket = guard.begin()
    try {
      const value = await client.request(path, { signal: ticket.controller.signal })
      if (!ticket.current()) return
      const view: CompanionPreferencesView = {
        revision: typeof value?.revision === 'number' ? value.revision : 0,
        saved: value?.saved,
        effective: value?.effective,
        capabilityStatus: {
          targetSelected: value?.capabilityStatus?.targetSelected === true,
          continuousGrant: value?.capabilityStatus?.continuousGrant === true,
          capture: value?.capabilityStatus?.capture === true,
          localOcr: value?.capabilityStatus?.localOcr === true,
          cloudVlm: value?.capabilityStatus?.cloudVlm === true,
          missingReasons: Array.isArray(value?.capabilityStatus?.missingReasons) ? value.capabilityStatus.missingReasons : [],
        },
        runState: String(value?.runState ?? 'unavailable'),
        reason: typeof value?.reason === 'string' ? value.reason : null,
        nextEligibleAt: typeof value?.nextEligibleAt === 'string' ? value.nextEligibleAt : null,
      }
      patch({ loading: false, view, draft: clone(view.saved), conflict: false, message: '', error: null })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      patch({ loading: false, error: describeError(error, '读取主动陪伴偏好失败。'), view: null, draft: null })
    } finally { guard.end(ticket.controller) }
  }

  function edit(mutate: (draft: CompanionPreferences) => void): void {
    if (!state.draft) return
    const draft = clone(state.draft)
    mutate(draft)
    patch({ draft, message: '', error: null })
  }

  /** 保存整份草稿。`operationId` 在同一次动作重试期间复用。 */
  async function save(): Promise<void> {
    const p = pairing()
    const current = state.view
    const draft = state.draft
    if (!p || !current || !draft || state.saving) return
    pendingOperationId ||= newOperationId()
    const draftSnapshot = clone(draft)
    patch({ saving: true, error: null, message: '' })
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/companion/preferences', {
        method: 'PUT', signal: ticket.controller.signal,
        body: { pairing: p, expectedRevision: current.revision, operationId: pendingOperationId, patch: draft },
      })
      if (!ticket.current()) return
      pendingOperationId = null
      patch({
        saving: false, conflict: false, view: { ...current, revision: value?.revision ?? current.revision, saved: value?.saved ?? draft, effective: value?.effective ?? current.effective },
        draft: clone(value?.saved ?? draft),
        message: '偏好已保存。授权、可用能力与自动调度状态未因此改变。',
      })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      const described = describeError(error, '偏好未保存。')
      if (described.code === 'version_conflict') {
        // 冲突：保留草稿、丢弃已用编号，并要求刷新；不静默覆盖。
        pendingOperationId = null
        patch({ saving: false, conflict: true, draft: draftSnapshot, error: described })
        return
      }
      patch({ saving: false, draft: draftSnapshot, error: described })
    } finally { guard.end(ticket.controller) }
  }

  /** 单次触发：只执行一次，不开启自动循环。 */
  async function triggerOnce(kind: 'screen' | 'greeting' = 'screen'): Promise<void> {
    const p = pairing()
    if (!p || state.triggerBusy) return
    state.triggerOperationId ||= newOperationId()
    patch({ triggerBusy: true, triggerError: null })
    try {
      const value = await client.request('/api/companion/trigger', {
        method: 'POST', body: { pairing: p, operationId: state.triggerOperationId, kind },
      })
      patch({ trigger: value, triggerBusy: false, triggerOperationId: null })
    } catch (error) {
      patch({ triggerBusy: false, triggerError: describeError(error, '单次触发未完成。') })
    }
  }

  async function refreshTrigger(): Promise<void> {
    const p = pairing()
    const triggerId = state.trigger?.triggerId
    if (!p || !triggerId || state.triggerBusy) return
    patch({ triggerBusy: true, triggerError: null })
    try {
      const value = await client.request(opsQuery(`/api/companion/triggers/${encodeURIComponent(triggerId)}`, p))
      patch({ trigger: value, triggerBusy: false })
    } catch (error) {
      patch({ triggerBusy: false, triggerError: describeError(error, '读取触发状态失败。') })
    }
  }

  async function cancelTrigger(): Promise<void> {
    const p = pairing()
    const triggerId = state.trigger?.triggerId
    if (!p || !triggerId || state.triggerBusy) return
    patch({ triggerBusy: true, triggerError: null })
    try {
      const value = await client.request(`/api/companion/triggers/${encodeURIComponent(triggerId)}/cancel`, { method: 'POST', body: { pairing: p } })
      patch({ trigger: value, triggerBusy: false })
    } catch (error) {
      patch({ triggerBusy: false, triggerError: describeError(error, '取消触发失败。') })
    }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): CompanionState { return state },
    refresh,
    edit,
    save,
    triggerOnce,
    refreshTrigger,
    cancelTrigger,
    resetDraft() { if (state.view) patch({ draft: clone(state.view.saved), conflict: false, message: '', error: null }) },
    keepDraft() { patch({ conflict: false }) },
    dispose() { guard.invalidate() },
    newOperationId,
  }
}
export type CompanionSession = ReturnType<typeof createCompanionSession>

// ---------------------------------------------------------------------------
// 主动邀请策略（08-04）：`/api/proactive/policy`
// ---------------------------------------------------------------------------

export interface ProactivePolicy {
  enabled: boolean
  dailyMax: number
  minIntervalMs: number
  timezone: string
  dndStartHour: number
  dndEndHour: number
  sourceKinds: string[]
  revision: number
}

export interface ProactiveState {
  loading: boolean
  error: OpsError | null
  message: string
  policy: ProactivePolicy | null
  draft: ProactivePolicy | null
  conflict: boolean
}

export function createProactiveSession(client: OpsClient, guard: RequestGuard, pairing: () => Pairing | null, emitter: Emitter = createEmitter()) {
  let state: ProactiveState = { loading: false, error: null, message: '', policy: null, draft: null, conflict: false }
  const notify = () => emitter.emit()
  const patch = (next: Partial<ProactiveState>) => { state = { ...state, ...next }; notify() }

  async function refresh(): Promise<void> {
    const p = pairing()
    if (!p) {
      patch({ policy: null, draft: null, error: describeError({ status: 400, message: '当前管理会话没有显式运行 pairing。' }, '缺少运行 pairing。') })
      return
    }
    patch({ loading: true, error: null })
    const ticket = guard.begin()
    try {
      // 读取用 POST（route 只接受 POST/PUT）；服务端返回 { policy }。
      const value = await client.request('/api/proactive/policy', { method: 'POST', signal: ticket.controller.signal, body: { pairing: p } })
      if (!ticket.current()) return
      const policy = value?.policy as ProactivePolicy
      patch({ loading: false, policy, draft: clone(policy), conflict: false, message: '', error: null })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      patch({ loading: false, error: describeError(error, '读取主动陪伴设置失败。'), policy: null, draft: null })
    } finally { guard.end(ticket.controller) }
  }

  function edit(key: keyof ProactivePolicy, value: unknown): void {
    if (!state.draft) return
    patch({ draft: { ...state.draft, [key]: value } as ProactivePolicy, message: '', error: null })
  }

  async function save(): Promise<void> {
    const p = pairing()
    const current = state.policy
    const draft = state.draft
    if (!p || !current || !draft || state.loading) return
    patch({ loading: true, error: null, message: '' })
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/proactive/policy', {
        method: 'PUT', signal: ticket.controller.signal,
        body: {
          pairing: p, expectedRevision: current.revision,
          // 服务端只接受这些字段；sourceKinds 目前仅支持 continuity_fact。
          policy: {
            enabled: draft.enabled, dailyMax: Number(draft.dailyMax), minIntervalMs: Number(draft.minIntervalMs),
            timezone: draft.timezone, dndStartHour: Number(draft.dndStartHour), dndEndHour: Number(draft.dndEndHour),
            sourceKinds: ['continuity_fact'],
          },
        },
      })
      if (!ticket.current()) return
      const policy = value?.policy as ProactivePolicy
      patch({
        loading: false, policy, draft: clone(policy), conflict: false,
        message: policy?.enabled ? '策略已启用。开启后新确认的有效事实可生成待仲裁邀请。' : '策略已关闭；未展示候选已清理。',
      })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      const described = describeError(error, '保存主动陪伴设置失败。')
      patch({ loading: false, conflict: described.code === 'version_conflict', draft, error: described })
    } finally { guard.end(ticket.controller) }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): ProactiveState { return state },
    refresh, edit, save,
    restore() { if (state.policy) patch({ draft: clone(state.policy), message: '', error: null }) },
    dispose() { guard.invalidate() },
  }
}
export type ProactiveSession = ReturnType<typeof createProactiveSession>

// ---------------------------------------------------------------------------
// 语音唤醒（B28）：`/api/wake`
// ---------------------------------------------------------------------------

export interface WakeSettings { keyword: string; sensitivity: 'standard' | 'sensitive' | 'strict'; silenceMs: number }
export interface WakeSnapshotView {
  version: string
  instanceId: string
  revision: number
  settings: WakeSettings
  available: boolean
  detail: string
  session: { generation: number; enabled: boolean; phase: string; detail: string }
}

export interface WakeState {
  loading: boolean
  writing: boolean
  error: OpsError | null
  message: string
  snapshot: WakeSnapshotView | null
  draft: WakeSettings | null
  conflict: boolean
}

export const WAKE_PHASE_LABEL: Record<string, string> = {
  off: '已关闭', connecting: '正在连接麦克风', waiting: '等待唤醒', listening: '正在听',
  submitting: '正在提交这一句', replying: '正在回复', paused: '手动语音处理中', error: '唤醒暂不可用',
}

/** 与服务端 `validateWakeSettings` 一致；前端只做快速反馈。 */
export const isValidWakeSettings = (value: unknown): value is WakeSettings => {
  const v = value as Partial<WakeSettings> | null
  return !!v && typeof v === 'object'
    && typeof v.keyword === 'string' && /^[\u3400-\u9fff]{2,12}$/.test(v.keyword)
    && ['standard', 'sensitive', 'strict'].includes(v.sensitivity ?? '')
    && Number.isInteger(v.silenceMs) && (v.silenceMs as number) >= 1000 && (v.silenceMs as number) <= 3000 && (v.silenceMs as number) % 500 === 0
}

function normalizeWake(value: any): WakeSnapshotView {
  return {
    version: String(value?.version ?? ''),
    instanceId: String(value?.instanceId ?? ''),
    revision: typeof value?.revision === 'number' ? value.revision : 0,
    settings: value?.settings,
    // 缺失即不可用：不假定本地唤醒模型就绪。
    available: value?.available === true,
    detail: typeof value?.detail === 'string' ? value.detail : '',
    session: {
      generation: typeof value?.session?.generation === 'number' ? value.session.generation : 0,
      enabled: value?.session?.enabled === true,
      phase: String(value?.session?.phase ?? 'off'),
      detail: typeof value?.session?.detail === 'string' ? value.session.detail : '',
    },
  }
}

export function createWakeSession(client: OpsClient, guard: RequestGuard, emitter: Emitter = createEmitter()) {
  let state: WakeState = { loading: false, writing: false, error: null, message: '', snapshot: null, draft: null, conflict: false }
  const notify = () => emitter.emit()
  const patch = (next: Partial<WakeState>) => { state = { ...state, ...next }; notify() }

  async function refresh(): Promise<void> {
    if (state.writing) return
    patch({ loading: true, error: null })
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/wake', { signal: ticket.controller.signal })
      if (!ticket.current()) return
      const snapshot = normalizeWake(value)
      // 草稿未被本地修改时才跟随服务端；否则保留用户草稿并标记冲突。
      const dirty = state.draft && state.snapshot && JSON.stringify(state.draft) !== JSON.stringify(state.snapshot.settings)
      patch({
        loading: false, snapshot,
        draft: dirty ? state.draft : clone(snapshot.settings),
        conflict: dirty ? state.conflict : false,
      })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      patch({ loading: false, error: describeError(error, '暂时无法读取唤醒状态。') })
    } finally { guard.end(ticket.controller) }
  }

  function edit(key: keyof WakeSettings, value: unknown): void {
    if (!state.draft) return
    patch({ draft: { ...state.draft, [key]: value } as WakeSettings, message: '', error: null })
  }

  async function write(kind: 'save' | 'enable' | 'disable'): Promise<void> {
    const snapshot = state.snapshot
    if (!snapshot || state.writing) return
    if (kind === 'save' && (!state.draft || !isValidWakeSettings(state.draft))) {
      patch({ error: describeError({ status: 400, message: '请输入 2–12 个汉字，并选择有效的灵敏度和静音时长。' }, '唤醒设置无效。') })
      return
    }
    const body: Record<string, unknown> = kind === 'save'
      ? { instanceId: snapshot.instanceId, expectedRevision: snapshot.revision, settings: clone(state.draft!) }
      : { instanceId: snapshot.instanceId, expectedRevision: snapshot.revision, expectedGeneration: snapshot.session.generation, enabled: kind === 'enable' }
    patch({ writing: true, error: null, message: kind === 'save' ? '正在保存唤醒设置…' : kind === 'enable' ? '正在请求开启，本机麦克风将持续监听…' : '正在关闭监听…' })
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/wake', { method: kind === 'save' ? 'PUT' : 'POST', signal: ticket.controller.signal, body })
      if (!ticket.current()) return
      const next = normalizeWake(value)
      patch({
        writing: false, snapshot: next, draft: clone(next.settings), conflict: false,
        message: kind === 'save' ? '设置已保存。请点击开启，按新设置监听。' : next.session.enabled ? '已开启本次监听。退出或重启后会关闭。' : '监听已关闭。',
      })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      const described = describeError(error, '唤醒操作未完成。')
      // 结果未确认时明确提示核对，且不自动重试。
      patch({
        writing: false, conflict: kind === 'save', message: '',
        error: described.code === 'version_conflict'
          ? describeError({ status: 409, message: '设置或本次监听已变化，请核对最新状态。' }, '设置或本次监听已变化。')
          : described,
      })
    } finally { guard.end(ticket.controller) }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): WakeState { return state },
    refresh, edit,
    save: () => write('save'),
    enable: () => write('enable'),
    disable: () => write('disable'),
    keepDraft() { patch({ conflict: false }) },
    dispose() { guard.invalidate() },
  }
}
export type WakeSession = ReturnType<typeof createWakeSession>

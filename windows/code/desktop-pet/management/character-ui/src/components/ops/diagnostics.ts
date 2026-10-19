// LUI-04 · 诊断（FIX61-07 / FIX61-11）行为层。
//
// 端点：
//   GET /api/health                 -> HealthSnapshot { configRevision, observedAt, modules }
//   GET /api/health/{module}        -> ModuleHealth + { reasonCode, repairAction }
//   GET /api/microphone/preference  -> { deviceId: string|null }
//   PUT /api/microphone/preference { deviceId: string|null }
//   GET /api/snapshot               -> ManagementSnapshot
//   GET /api/traces?characterId&limit&offset （Trace 详情归 LUI-03，这里只做入口指向）
//
// 保留的诚实语义（旧 `health-view.mjs` 是权威）：
//  - 这盏灯只反映后端**已经真实观察到**的事实。本页不主动探测任何端点，也不生成付费请求；
//    因此首次对话前多数模块显示「尚未确认」是预期状态，不是故障。
//  - `evidence` 三个维度分开展示，不折叠成一个布尔。
//  - 麦克风偏好只保存设备标识；控制台**不代替用户打开采集**。
//  - 读失败显示失败，不显示假零。

import { createEmitter, describeError, isAbort, type Emitter, type OpsClient, type OpsError, type RequestGuard } from './shared'

export interface HealthModuleView {
  id: string
  label: string
  state: string
  reasonCode: string | null
  repairAction: string | null
  checkedAt: string
  configRevision: number
  stale: boolean
  evidence: { configured: boolean; reachable: boolean; operational: boolean; selfCheck: boolean }
  providerSlot?: string
}

export interface HealthState {
  loading: boolean
  error: OpsError | null
  snapshot: { configRevision: number; observedAt: string; modules: HealthModuleView[] } | null
  detail: { module: string; value: HealthModuleView } | null
  detailError: OpsError | null
}

export const HEALTH_LABEL: Record<string, string> = {
  ready: '就绪', checking: '检查中', unknown: '尚未确认', disabled: '已停用', degraded: '部分可用', failed: '失败',
}

export const HEALTH_EVIDENCE: readonly [keyof HealthModuleView['evidence'], string][] = [
  ['configured', '已配置'], ['reachable', '端点已应答'], ['operational', '实际调用成功'], ['selfCheck', '本地自检通过'],
]

/** 失败优先、未知次之，便于操作者先看到真正需要处理的那一盏灯。 */
export function sortHealthModules(modules: HealthModuleView[]): HealthModuleView[] {
  const rank = (state: string) => state === 'failed' ? 0 : state === 'degraded' ? 1 : state === 'unknown' ? 2 : 3
  return [...modules].sort((a, b) => rank(a.state) - rank(b.state) || a.id.localeCompare(b.id))
}

export function normalizeHealthModule(id: string, raw: any): HealthModuleView {
  return {
    id,
    label: typeof raw?.label === 'string' ? raw.label : id,
    state: String(raw?.state ?? 'unknown'),
    reasonCode: typeof raw?.reasonCode === 'string' ? raw.reasonCode : null,
    repairAction: typeof raw?.repairAction === 'string' ? raw.repairAction : null,
    checkedAt: typeof raw?.checkedAt === 'string' ? raw.checkedAt : '',
    configRevision: typeof raw?.configRevision === 'number' ? raw.configRevision : 0,
    stale: raw?.stale === true,
    evidence: {
      configured: raw?.evidence?.configured === true,
      reachable: raw?.evidence?.reachable === true,
      operational: raw?.evidence?.operational === true,
      selfCheck: raw?.evidence?.selfCheck === true,
    },
    ...(typeof raw?.providerSlot === 'string' ? { providerSlot: raw.providerSlot } : {}),
  }
}

export function createDiagnosticsSession(client: OpsClient, guard: RequestGuard, emitter: Emitter = createEmitter()) {
  let state: HealthState = { loading: false, error: null, snapshot: null, detail: null, detailError: null }
  let microphone: { deviceId: string | null } | null = null
  let microphoneError: OpsError | null = null
  let snapshotValue: any = null
  let snapshotError: OpsError | null = null
  const notify = () => emitter.emit()

  async function refreshHealth(): Promise<void> {
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/health', { signal: ticket.controller.signal })
      if (!ticket.current()) return
      const modules = Object.entries(value?.modules ?? {}).map(([id, raw]) => normalizeHealthModule(id, raw))
      state = { ...state, loading: false, error: null, snapshot: { configRevision: value?.configRevision ?? 0, observedAt: value?.observedAt ?? '', modules } }
      notify()
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      // 读失败：清空 snapshot 并明确报错，不显示「0 个模块」这种假零。
      state = { ...state, loading: false, error: describeError(error, '暂时无法读取模块状态。'), snapshot: null }
      notify()
    } finally { guard.end(ticket.controller) }
  }

  async function inspect(module: string): Promise<void> {
    const ticket = guard.begin()
    try {
      const value = await client.request(`/api/health/${encodeURIComponent(module)}`, { signal: ticket.controller.signal })
      if (!ticket.current()) return
      state = { ...state, detail: { module, value: normalizeHealthModule(module, value) }, detailError: null }
      notify()
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      state = { ...state, detailError: describeError(error, '无法读取这个模块的修复建议。') }
      notify()
    } finally { guard.end(ticket.controller) }
  }

  async function readMicrophone(): Promise<void> {
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/microphone/preference', { signal: ticket.controller.signal })
      if (!ticket.current()) return
      microphone = { deviceId: typeof value?.deviceId === 'string' ? value.deviceId : null }
      microphoneError = null
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      microphone = null
      microphoneError = describeError(error, '无法读取麦克风偏好。')
    } finally { guard.end(ticket.controller); notify() }
  }

  async function saveMicrophone(deviceId: string | null): Promise<void> {
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/microphone/preference', { method: 'PUT', signal: ticket.controller.signal, body: { deviceId } })
      if (!ticket.current()) return
      microphone = { deviceId: typeof value?.deviceId === 'string' ? value.deviceId : null }
      microphoneError = null
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      microphoneError = describeError(error, '麦克风偏好未保存。')
    } finally { guard.end(ticket.controller); notify() }
  }

  async function readSnapshot(): Promise<void> {
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/snapshot', { signal: ticket.controller.signal })
      if (!ticket.current()) return
      snapshotValue = value; snapshotError = null
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      snapshotValue = null; snapshotError = describeError(error, '无法读取运行实例快照。')
    } finally { guard.end(ticket.controller); notify() }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): HealthState { return state },
    get microphone() { return microphone },
    get microphoneError() { return microphoneError },
    get snapshot() { return snapshotValue },
    get snapshotError() { return snapshotError },
    /** 只读一次快照：本页不轮询、不探测，避免为「点灯」产生任何付费请求。 */
    refresh: async () => { state = { ...state, loading: true }; notify(); await Promise.all([refreshHealth(), readMicrophone(), readSnapshot()]); state = { ...state, loading: false }; notify() },
    inspect,
    closeDetail() { state = { ...state, detail: null, detailError: null }; notify() },
    saveMicrophone,
    dispose() { guard.invalidate() },
  }
}
export type DiagnosticsSession = ReturnType<typeof createDiagnosticsSession>

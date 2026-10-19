// LUI-04 · ACP / MCP 工作协议（08-05）行为层。
//
// 端点（`management/work-protocol-routes.ts`，字段以此为准）：
//   GET  /api/work-protocol            -> { profiles, requests }
//   GET  /api/work-protocol/tools      -> { tools }
//   PUT  /api/work-protocol/profiles { expectedRevision, profiles }
//   POST /api/work-protocol/prepare { protocol:'acp'|'mcp', executorId, target:{title,directory?,projectId?}, instruction, permissionGrant, toolCall? }
//   POST /api/work-protocol/revise { operationId, expectedRevision, updates }
//   POST /api/work-protocol/confirm { operationId, expectedRevision }
//   POST /api/work-protocol/cancel { operationId, expectedRevision }
//   POST /api/work-protocol/forget { operationId }
//
// 保留的诚实语义（旧 `work-protocol-view.mjs` 是权威）：
//  - 保存执行器配置**不会**运行任何命令；`/tools` 只发现工具目录，不调用工具。
//  - 外部副作用只在确认卡确认后发生；断连/重启可能留下未知结果，系统不自动重发。
//  - 遗忘会擦除本机正文与回执，并从 Timeline 移除此来源；外部副作用不会因此撤销。
//  - 环境变量值不回显，只展示键名。

import { createEmitter, describeError, isAbort, newOperationId, type Emitter, type OpsClient, type OpsError, type RequestGuard } from './shared'

export interface WorkProtocolProfileView {
  executorId: string
  label: string
  command: string
  args: string[]
  cwd?: string
  environmentKeys: string[]
}

export interface WorkProtocolRecord {
  request: any
  receipt: any | null
  dispatchStarted: boolean
  forgotten: boolean
}

export interface WorkProtocolState {
  loading: boolean
  error: OpsError | null
  available: boolean | null
  profiles: { revision: number; acp?: WorkProtocolProfileView; mcp?: WorkProtocolProfileView } | null
  requests: WorkProtocolRecord[]
  profileText: string
  profileDirty: boolean
  tools: { name: string; description: string; readOnly: boolean; requiredGrant?: string }[]
  selected: string | null
  busy: boolean
  message: string
  actionError: OpsError | null
}

export const WORK_PROTOCOL_LABEL: Record<string, string> = { acp: 'ACP Agent', mcp: 'MCP 工具' }
export const WORK_STATE_LABEL: Record<string, string> = {
  prepared: '待确认', dispatched: '已派发', running: '运行中', succeeded: '已完成',
  failed: '失败', uncertain: '结果未知', cancelled: '已取消',
}

export interface WorkReviseInput {
  protocol: 'acp' | 'mcp'
  executorId: string
  title: string
  directory?: string
  instruction: string
  permissionGrant: string[]
  toolCall?: { name: string; arguments: Record<string, unknown> }
}

const editableProfile = (profile: any): WorkProtocolProfileView | null => {
  if (!profile) return null
  const { environmentKeys, ...rest } = profile
  return { ...rest, environmentKeys: Array.isArray(environmentKeys) ? environmentKeys : [] }
}

export function createWorkProtocolSession(client: OpsClient, guard: RequestGuard, emitter: Emitter = createEmitter()) {
  let state: WorkProtocolState = {
    loading: false, error: null, available: null, profiles: null, requests: [],
    profileText: '{\n  "acp": null,\n  "mcp": null\n}', profileDirty: false, tools: [],
    selected: null, busy: false, message: '', actionError: null,
  }
  const notify = () => emitter.emit()
  const patch = (next: Partial<WorkProtocolState>) => { state = { ...state, ...next }; notify() }

  async function load(): Promise<void> {
    patch({ loading: true })
    const ticket = guard.begin()
    try {
      const data = await client.request('/api/work-protocol', { signal: ticket.controller.signal })
      if (!ticket.current()) return
      if (!data || !Array.isArray(data.requests) || !data.profiles || !Number.isSafeInteger(data.profiles.revision)) {
        throw Object.assign(Error('工作协议状态格式无效。'), { status: 0 })
      }
      const selectedStillThere = state.selected && data.requests.some((row: any) => row?.request?.operationId === state.selected)
      patch({
        loading: false, available: true, requests: data.requests, error: null,
        profiles: data.profiles,
        // 有本地未保存草稿时不覆盖用户输入。
        profileText: state.profileDirty ? state.profileText : JSON.stringify({
          acp: editableProfile(data.profiles.acp) ?? null, mcp: editableProfile(data.profiles.mcp) ?? null,
        }, null, 2),
        selected: selectedStillThere ? state.selected : null,
      })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      const described = describeError(error, '工作协议操作未完成。')
      // 503 = 未装配：诚实显示 unavailable，而不是空白成功。
      patch({ loading: false, available: false, error: described.code === 'unavailable' ? null : described })
    } finally { guard.end(ticket.controller) }
  }

  function setProfileText(value: string): void { patch({ profileText: value, profileDirty: true }) }

  async function run(action: () => Promise<string>): Promise<void> {
    if (state.busy) return
    patch({ busy: true, message: '', actionError: null })
    try {
      const message = await action()
      patch({ busy: false, message })
    } catch (error) {
      patch({ busy: false, message: '', actionError: describeError(error, '工作协议操作未完成；没有自动重试。') })
    }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): WorkProtocolState { return state },
    refresh: load,
    setProfileText,
    async saveProfiles(): Promise<void> {
      await run(async () => {
        let parsed: unknown
        try { parsed = JSON.parse(state.profileText) } catch { throw Object.assign(Error('配置必须是 JSON 对象。'), { status: 400 }) }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(Error('配置必须是 JSON 对象。'), { status: 400 })
        const result = await client.request('/api/work-protocol/profiles', {
          method: 'PUT', body: { expectedRevision: state.profiles?.revision ?? 0, profiles: parsed },
        })
        if (result?.profiles?.revision === undefined) throw Error('保存回执版本缺失。')
        patch({ profileDirty: false })
        await load()
        return '执行器配置已保存并在当前实例生效。'
      })
    },
    /** 只读取 MCP 工具目录；不执行任何工具。 */
    async discoverTools(): Promise<void> {
      await run(async () => {
        const result = await client.request('/api/work-protocol/tools')
        if (!Array.isArray(result?.tools) || result.tools.length > 10000) throw Error('MCP 工具目录格式无效。')
        patch({ tools: result.tools })
        return `已发现 ${result.tools.length} 个工具；尚未执行任何工具。`
      })
    },
    async prepare(input: { protocol: 'acp' | 'mcp'; executorId: string; title: string; directory?: string; instruction: string; permissionGrant: string[]; toolCall?: { name: string; arguments: Record<string, unknown> } }): Promise<void> {
      await run(async () => {
        const value = await client.request('/api/work-protocol/prepare', {
          method: 'POST',
          body: {
            protocol: input.protocol, executorId: input.executorId,
            target: { title: input.title.trim(), ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}) },
            instruction: input.instruction,
            permissionGrant: input.permissionGrant,
            ...(input.toolCall ? { toolCall: input.toolCall } : {}),
          },
        })
        if (!value?.request?.operationId) throw Error('服务端未返回待确认请求。')
        patch({ selected: value.request.operationId })
        await load()
        return '请求已持久化为待确认状态。核对完整目标、正文、工具参数和权限后再执行。'
      })
    },
    /**
     * 修订待确认请求。只允许尚未派发、无回执的行；修订后 revision +1，
     * 旧确认卡失效，必须重新核对。`expectedRevision` 取选中行的当前 revision。
     */
    async revise(operationId: string, expectedRevision: number, input: WorkReviseInput): Promise<void> {
      await run(async () => {
        const value = await client.request('/api/work-protocol/revise', {
          method: 'POST',
          body: {
            operationId, expectedRevision,
            updates: {
              protocol: input.protocol, executorId: input.executorId,
              target: { title: input.title.trim(), ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}) },
              instruction: input.instruction,
              permissionGrant: input.permissionGrant,
              ...(input.toolCall ? { toolCall: input.toolCall } : {}),
            },
          },
        })
        if (!value?.request?.operationId) throw Error('服务端未返回修订后的请求。')
        patch({ selected: value.request.operationId })
        await load()
        return '请求已修订并生成新版本；旧确认卡已失效，请重新核对后再执行。'
      })
    },
    async confirm(operationId: string, expectedRevision: number): Promise<void> {
      await run(async () => {
        const value = await client.request('/api/work-protocol/confirm', { method: 'POST', body: { operationId, expectedRevision } })
        if (!value?.receipt) throw Error('服务端未返回执行回执。')
        await load()
        return '已收到本次协议回执。'
      })
    },
    async cancel(operationId: string, expectedRevision: number): Promise<void> {
      await run(async () => {
        const value = await client.request('/api/work-protocol/cancel', { method: 'POST', body: { operationId, expectedRevision } })
        if (!value?.receipt) throw Error('服务端未返回取消回执。')
        await load()
        return '取消请求已取得回执；未确认时会保持未知状态。'
      })
    },
    /** 遗忘：擦除本机正文与回执；外部副作用不撤销。调用方必须先确认。 */
    async forget(operationId: string): Promise<void> {
      await run(async () => {
        await client.request('/api/work-protocol/forget', { method: 'POST', body: { operationId } })
        patch({ selected: null })
        await load()
        return '本机任务内容已遗忘；外部执行结果不受此操作影响。'
      })
    },
    select(operationId: string | null) { patch({ selected: operationId }) },
    dispose() { guard.invalidate() },
    newOperationId,
  }
}
export type WorkProtocolSession = ReturnType<typeof createWorkProtocolSession>

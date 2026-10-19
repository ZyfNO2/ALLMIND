/**
 * 记忆 / 知识 / 导入 / 未完成请求的写操作。
 *
 * 每条规则都对应 LUI-03 的 AC：
 *  - 幂等：同一份 payload 的重试复用同一个 `operationId`；只有服务端确认后或 payload 变化才换新编号。
 *  - 冲突：409 保留调用方草稿并回报 conflict，不静默重载覆盖用户输入。
 *  - 范围：遗忘/纠正必须携带明确的角色（或配对）+ 记录版本，服务端回执不匹配即视为未确认成功。
 *  - 遗忘不可逆：本层不提供任何“把被遗忘内容重新写回”的路径，只允许服务端支持的 restore（仍受保留期约束）。
 */
import { DataError, isAbort, type PairingScope, type RequestFn } from './client'

export type ActionOutcome<T = any> =
  | { ok: true; value: T }
  | { ok: false; conflict: true; message: string }
  | { ok: false; conflict?: false; message: string; aborted?: boolean; status?: number }

export const newOperationId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random().toString(16).slice(2)}`

/** 幂等编号注册表：signature 不变则复用，确认成功后清空。 */
export class OperationIds {
  private readonly ids = new Map<string, string>()
  /** 取该 signature 对应的编号；首次或 payload 变化时生成新的。 */
  take(signature: string): string {
    const existing = this.ids.get(signature)
    if (existing) return existing
    const created = newOperationId()
    this.ids.set(signature, created)
    return created
  }
  /** 服务端已确认：释放该编号，下一次尝试是新的操作。 */
  confirm(signature: string): void {
    this.ids.delete(signature)
  }
  clear(): void {
    this.ids.clear()
  }
  get size(): number {
    return this.ids.size
  }
}

const message = (error: unknown): string => {
  if (error instanceof DataError) return error.message
  const text = (error as { message?: unknown } | null)?.message
  return typeof text === 'string' && text ? text : '操作未完成，请刷新后核对。'
}

const status = (error: unknown): number => {
  const value = (error as { status?: unknown } | null)?.status
  return typeof value === 'number' ? value : 0
}

async function run<T>(work: () => Promise<T>): Promise<ActionOutcome<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    if (isAbort(error)) return { ok: false, message: '请求已取消。', aborted: true }
    if (status(error) === 409) return { ok: false, conflict: true, message: message(error) }
    return { ok: false, message: message(error), status: status(error) }
  }
}

// ---------------------------------------------------------------- 记录：纠正 / 遗忘 / 恢复

export interface RecordEditInput {
  characterId: string
  id: string
  expectedVersion: number
  text: string
  reason: string
}

export interface RecordEditReceipt {
  status: 'applied'
  characterId: string
  operationId: string
  revision: number
  record: Record<string, any>
  invalidatedIds: string[]
}

export function editRecord(request: RequestFn, operations: OperationIds, input: RecordEditInput) {
  if (!input.text.trim() || !input.reason.trim()) return Promise.resolve({ ok: false, message: '请填写修改内容与原因。' } as ActionOutcome<RecordEditReceipt>)
  const signature = `edit:${JSON.stringify(input)}`
  const operationId = operations.take(signature)
  return run(async () => {
    const value = (await request('/api/records/edit', {
      method: 'POST',
      body: { characterId: input.characterId, id: input.id, expectedVersion: input.expectedVersion, operationId, text: input.text, reason: input.reason },
    })) as RecordEditReceipt
    if (value?.status !== 'applied' || value.characterId !== input.characterId || !Array.isArray(value.invalidatedIds)) {
      throw new DataError('修改回执不匹配，尚未确认成功，请刷新核对。')
    }
    operations.confirm(signature)
    return value
  })
}

export interface RecordActionInput {
  characterId: string
  id: string
  expectedVersion: number
  reason: string
}

export interface RecordActionReceipt {
  characterId: string
  revision: number
  affectedIds: string[]
  status: 'applied'
}

/** 遗忘：明确范围（角色 + 记录 + 版本 + 原因），回执必须列出受影响记录。 */
export function forgetRecord(request: RequestFn, operations: OperationIds, input: RecordActionInput) {
  return recordAction(request, operations, '/api/memory/forget', 'forget', input)
}

/** 恢复：只对仍在保留期内的记录有效；服务端拒绝即视为未恢复。 */
export function restoreRecord(request: RequestFn, operations: OperationIds, input: RecordActionInput) {
  return recordAction(request, operations, '/api/memory/restore', 'restore', input)
}

function recordAction(
  request: RequestFn,
  operations: OperationIds,
  path: string,
  action: 'forget' | 'restore',
  input: RecordActionInput,
): Promise<ActionOutcome<RecordActionReceipt>> {
  if (!input.reason.trim()) return Promise.resolve({ ok: false, message: '请填写处理原因。' } as ActionOutcome<RecordActionReceipt>)
  const signature = `${action}:${JSON.stringify(input)}`
  const operationId = operations.take(signature)
  return run(async () => {
    const value = (await request(path, {
      method: 'POST',
      body: { characterId: input.characterId, id: input.id, expectedVersion: input.expectedVersion, operationId, reason: input.reason },
    })) as RecordActionReceipt
    if (value?.status !== 'applied' || value.characterId !== input.characterId
      || !Number.isSafeInteger(value.revision) || !Array.isArray(value.affectedIds) || !value.affectedIds.includes(input.id)) {
      throw new DataError('处理回执不匹配，尚未确认成功，请刷新核对。')
    }
    operations.confirm(signature)
    return value
  })
}

// ---------------------------------------------------------------- 连续性：晋升 / 纠正 / 遗忘

export interface ContinuityActionInput {
  pairing: PairingScope
  targetId: string
  expectedVersion: number
  reason: string
  text?: string
  sourceIds?: string[]
}

export function promoteContinuity(request: RequestFn, operations: OperationIds, input: ContinuityActionInput) {
  const signature = `promote:${JSON.stringify(input)}`
  const operationId = operations.take(signature)
  return run(async () => {
    const value = await request('/api/continuity/promote', {
      method: 'POST',
      body: { pairing: input.pairing, operationId, targetId: input.targetId, expectedVersion: input.expectedVersion },
    })
    if (value?.status !== 'applied' && value?.status !== 'unchanged') throw new DataError('晋升回执不匹配，尚未确认成功，请刷新核对。')
    operations.confirm(signature)
    return value
  })
}

export function correctContinuity(request: RequestFn, operations: OperationIds, input: ContinuityActionInput) {
  if (!input.text?.trim()) return Promise.resolve({ ok: false, message: '请填写纠正后的正文。' } as ActionOutcome)
  if (!input.reason.trim()) return Promise.resolve({ ok: false, message: '请填写处理原因。' } as ActionOutcome)
  const signature = `correct:${JSON.stringify(input)}`
  const operationId = operations.take(signature)
  return run(async () => {
    const value = await request('/api/continuity/correct', {
      method: 'POST',
      body: {
        pairing: input.pairing,
        operationId,
        targetId: input.targetId,
        expectedVersion: input.expectedVersion,
        text: input.text,
        reason: input.reason,
        sourceIds: input.sourceIds ?? [],
      },
    })
    if (value?.status !== 'applied' && value?.status !== 'unchanged') throw new DataError('纠正回执不匹配，尚未确认成功，请刷新核对。')
    operations.confirm(signature)
    return value
  })
}

export function forgetContinuity(request: RequestFn, operations: OperationIds, input: ContinuityActionInput) {
  if (!input.reason.trim()) return Promise.resolve({ ok: false, message: '请填写处理原因。' } as ActionOutcome)
  const signature = `continuity-forget:${JSON.stringify(input)}`
  const operationId = operations.take(signature)
  return run(async () => {
    const value = await request('/api/continuity/forget', {
      method: 'POST',
      body: { pairing: input.pairing, operationId, targetId: input.targetId, expectedVersion: input.expectedVersion, reason: input.reason },
    })
    if (value?.status !== 'applied' && value?.status !== 'unchanged') throw new DataError('遗忘回执不匹配，尚未确认成功，请刷新核对。')
    operations.confirm(signature)
    return value
  })
}

// ---------------------------------------------------------------- 记忆策略

export function saveMemoryPolicy(
  request: RequestFn,
  operations: OperationIds,
  input: { characterId: string; expectedRevision: number; policy: Record<string, number> },
) {
  const signature = `policy:${JSON.stringify(input)}`
  const operationId = operations.take(signature)
  return run(async () => {
    const value = await request('/api/memory/policy', { method: 'PUT', body: { ...input, operationId } })
    if (!Number.isSafeInteger(value?.revision) || value.revision <= input.expectedRevision) {
      throw new DataError('策略保存回执不匹配，尚未确认成功，请刷新核对。')
    }
    operations.confirm(signature)
    return value
  })
}

export function rollbackMemoryPolicy(
  request: RequestFn,
  operations: OperationIds,
  input: { characterId: string; expectedRevision: number; targetRevision: number },
) {
  const signature = `policy-rollback:${JSON.stringify(input)}`
  const operationId = operations.take(signature)
  return run(async () => {
    const value = await request('/api/memory/policy/rollback', { method: 'POST', body: { ...input, operationId } })
    if (!Number.isSafeInteger(value?.revision) || value?.restoredFromRevision !== input.targetRevision) {
      throw new DataError('回退回执不匹配，尚未确认成功，请刷新核对。')
    }
    operations.confirm(signature)
    return value
  })
}

// ---------------------------------------------------------------- 资料库

export function createLibrary(request: RequestFn, characterId: string, name: string) {
  if (!name.trim()) return Promise.resolve({ ok: false, message: '请填写资料库名称。' } as ActionOutcome)
  return run(() => request(`/api/knowledge/libraries?${new URLSearchParams({ characterId })}`, { method: 'POST', body: { name: name.trim() } }))
}

export function renameLibrary(request: RequestFn, characterId: string, input: { libraryId: string; name: string; expectedRevision: number }) {
  if (!input.name.trim()) return Promise.resolve({ ok: false, message: '请填写资料库名称。' } as ActionOutcome)
  return run(() =>
    request(`/api/knowledge/rename?${new URLSearchParams({ characterId })}`, { method: 'POST', body: { ...input, name: input.name.trim() } }),
  )
}

export function activateLibrary(request: RequestFn, characterId: string, input: { libraryId: string | null; expectedRevision: number }) {
  return run(() => request(`/api/knowledge/activate?${new URLSearchParams({ characterId })}`, { method: 'POST', body: input }))
}

export function importDocuments(request: RequestFn, characterId: string, input: { libraryId: string; files: { sourceName: string; text: string }[] }) {
  if (!input.files.length) return Promise.resolve({ ok: false, message: '请选择要导入的文件。' } as ActionOutcome)
  return run(() => request(`/api/knowledge/import?${new URLSearchParams({ characterId })}`, { method: 'POST', body: input }))
}

export function removeDocument(request: RequestFn, characterId: string, input: { libraryId: string; documentId: string; expectedRevision: number }) {
  return run(() => request(`/api/knowledge/documents/remove?${new URLSearchParams({ characterId })}`, { method: 'POST', body: input }))
}

export function deleteLibrary(request: RequestFn, characterId: string, input: { libraryId: string; expectedRevision: number }) {
  return run(() => request(`/api/knowledge/libraries/delete?${new URLSearchParams({ characterId })}`, { method: 'POST', body: input }))
}

/** 浏览器端读取本地文件为文本；上限与旧资料库页面一致（20 个文件、每个 2 MiB）。 */
export async function readLocalFiles(files: File[]): Promise<{ sourceName: string; text: string }[]> {
  if (files.length > 20) throw new DataError('每次最多导入 20 个文件。')
  for (const file of files) if (file.size > 2 * 1024 * 1024) throw new DataError(`${file.name} 超过 2 MiB 上限。`)
  return Promise.all(files.map(async file => ({ sourceName: file.name, text: await file.text() })))
}

// ---------------------------------------------------------------- 导入旧聊天

export interface ImportStartInput {
  instanceId: string
  characterId: string
  pairing?: PairingScope
  source: { kind: 'codex-project' | 'text-export'; projectName: string; path: string }
}

const LOCAL_PATH = /^(\/|[A-Za-z]:[\\/])/

export function localPathProblem(path: string): string {
  if (!path.trim()) return '请填写本机绝对路径。'
  if (path.length > 4096 || path.includes('\0')) return '路径过长或包含无效字符。'
  if (path.startsWith('//')) return '不接受网络共享路径。'
  if (!LOCAL_PATH.test(path)) return '请填写本机绝对路径（例如 C:\\ 或 / 开头）。'
  return ''
}

/**
 * 开始导入。
 *
 * 同一来源的重试复用同一个 operationId：服务端据此去重，避免一次重试产生第二个任务。
 */
export function startImport(request: RequestFn, operations: OperationIds, input: ImportStartInput) {
  if (!input.source.projectName.trim()) return Promise.resolve({ ok: false, message: '请填写旧 AI 项目名称。' } as ActionOutcome)
  const pathProblem = localPathProblem(input.source.path)
  if (pathProblem) return Promise.resolve({ ok: false, message: pathProblem } as ActionOutcome)
  const signature = `import-start:${JSON.stringify(input)}`
  const operationId = operations.take(signature)
  return run(async () => {
    const value = await request('/api/memory-import/start', { method: 'POST', body: { ...input, operationId } })
    if (!value || value.characterId !== input.characterId || value.source?.kind !== input.source.kind || value.source?.path !== input.source.path) {
      throw new DataError('导入回执与提交的来源不一致，尚未确认成功，请刷新核对。')
    }
    operations.confirm(signature)
    return value
  })
}

export function pauseImport(request: RequestFn, input: { instanceId: string; characterId: string; pairing?: PairingScope; jobId: string; expectedRevision: number }) {
  return run(() => request('/api/memory-import/pause', { method: 'POST', body: input }))
}

export function resumeImport(request: RequestFn, input: { instanceId: string; characterId: string; pairing?: PairingScope; jobId: string; expectedRevision: number }) {
  return run(() => request('/api/memory-import/resume', { method: 'POST', body: input }))
}

// ---------------------------------------------------------------- 未完成请求

/**
 * 重新处理一项未完成请求。
 *
 * 结果不确定（超时/断连）时不自动重发：调用方保留确认框，由用户显式再点一次。
 */
export function retryPending(request: RequestFn, input: { instanceId: string; id: string }) {
  return run(() => request('/api/memory-pending/retry', { method: 'POST', body: input }))
}

export function cancelPending(request: RequestFn, input: { instanceId: string; id: string }) {
  return run(() => request('/api/memory-pending/cancel', { method: 'POST', body: input }))
}

export { message as outcomeMessage, status as outcomeStatus }

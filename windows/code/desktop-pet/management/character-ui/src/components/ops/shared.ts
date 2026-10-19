// LUI-04：插件 / 宿主设置 / 采集隐私 / 诊断工具共享基础件。
//
// 本目录的 `*.ts` 是**不依赖 React 与 DOM 的行为层**：请求形状、修订与幂等、草稿保留、
// 取消与释放都在这里实现，React 组件只做渲染。这样生产语义可以在 `node --test` 下用真实
// 管理服务验证，而不是只靠浏览器截图。

/** 只允许 `runtime.request(path, opts)` 这一条通道；这里不新增具名包装。 */
export interface OpsClient {
  request(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal; responseType?: 'bytes' }): Promise<any>
}

export interface OpsError {
  /** 与服务端 `error.code` 对齐的稳定分类；`unknown` 表示没有可用状态码。 */
  code: 'unauthorized' | 'forbidden' | 'invalid_request' | 'not_found' | 'version_conflict' | 'unavailable' | 'internal_error' | 'unknown'
  message: string
  status: number
}

/**
 * 读失败必须能和「读到 0 条」区分开。这里把任何异常收敛成一个可展示的错误，绝不返回空数据。
 */
export function describeError(error: unknown, fallback: string): OpsError {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 0
  const raw = (error as { message?: unknown })?.message
  const message = typeof raw === 'string' && raw.trim() && raw.length <= 300 ? raw : fallback
  const code: OpsError['code'] = status === 401 ? 'unauthorized'
    : status === 403 ? 'forbidden'
      : status === 400 ? 'invalid_request'
        : status === 404 ? 'not_found'
          : status === 409 ? 'version_conflict'
            : status === 503 ? 'unavailable'
              : status >= 500 ? 'internal_error' : 'unknown'
  return { code, message, status }
}

export const isAbort = (error: unknown): boolean => (error as { name?: unknown })?.name === 'AbortError'
export const isConflict = (error: unknown): boolean => (error as { status?: unknown })?.status === 409
/** 503 = 能力未装配或宿主缺席；必须显示 unavailable，不能显示「已保存」。 */
export const isUnavailable = (error: unknown): boolean => (error as { status?: unknown })?.status === 503

/** 每个用户动作一个新编号；同一次动作重试时复用同一个（服务端按 operationId 幂等）。 */
export function newOperationId(): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID()
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const opsQuery = (path: string, values: Record<string, string>): string =>
  `${path}?${new URLSearchParams(values)}`
/** 简单的订阅器：会话对象用它通知 React 重新渲染，不引入状态库。 */
export function createEmitter() {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    emit() { for (const listener of [...listeners]) listener() },
  }
}
export type Emitter = ReturnType<typeof createEmitter>

/** 请求生命周期票据：任何一次新请求或 dispose 都会让旧响应失效。 */
export function createRequestGuard() {
  let epoch = 0
  const inflight = new Set<AbortController>()
  return {
    /** 让所有在途请求作废并中止。 */
    invalidate() { epoch += 1; for (const controller of inflight) controller.abort(); inflight.clear() },
    begin(): { epoch: number; controller: AbortController; current: () => boolean } {
      const controller = new AbortController()
      inflight.add(controller)
      const started = epoch
      return {
        epoch: started, controller,
        current: () => started === epoch && !controller.signal.aborted,
      }
    },
    end(controller: AbortController) { inflight.delete(controller) },
    get epoch() { return epoch },
  }
}
export type RequestGuard = ReturnType<typeof createRequestGuard>

/** 只接受服务端明确给出的数字；缺字段时返回 null，而不是拿 0 冒充真实读数。 */
export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 读失败时展示的诚实占位：区分「不可用」与「暂无」。 */
export const UNAVAILABLE = 'unavailable' as const

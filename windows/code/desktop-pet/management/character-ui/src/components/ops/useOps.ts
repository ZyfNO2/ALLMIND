// LUI-04 · 把 ops 行为层接到 React。
//
// 这里只做三件事：订阅、卸载时释放、把请求守卫的生命周期对齐到组件。
// 不引入状态库，也不在渲染期发起请求。

import { useEffect, useMemo, useReducer, useRef } from 'react'
import { createRequestGuard, type OpsClient } from './shared'

interface OpsSession { subscribe(listener: () => void): () => void; dispose(): void }

/**
 * 创建一个 ops 会话并订阅它。`deps` 变化时重建会话；旧会话会被 `dispose()`，
 * 因此 `AbortController`、媒体轨道与 object URL 都会随组件卸载一起释放。
 */
export function useOpsSession<T extends OpsSession>(factory: () => T, deps: unknown[]): T {
  const [, force] = useReducer((n: number) => n + 1, 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const session = useMemo(factory, deps)
  useEffect(() => {
    const unsubscribe = session.subscribe(force)
    return () => { unsubscribe(); session.dispose() }
  }, [session])
  return session
}

/** 会话共享一个请求守卫；组件卸载时整体作废，在途请求全部中止。 */
export function useRequestGuard() {
  const guard = useMemo(() => createRequestGuard(), [])
  useEffect(() => () => guard.invalidate(), [guard])
  return guard
}

/**
 * 惰性读取：只有 `enabled` 为真时才调用 `load`。
 * 用于「未连接宿主 / 未进入该 tab 时不发请求」，避免未选引擎被启动。
 */
export function useLazyLoad(enabled: boolean, load: () => void, deps: unknown[] = []): void {
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (enabled) loadRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])
}

export type { OpsClient }

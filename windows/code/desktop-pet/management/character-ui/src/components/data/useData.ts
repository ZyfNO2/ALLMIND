/**
 * 数据页共用的读取状态。
 *
 * 关键不变式：**读失败不显示假零**。
 *  - `data` 只在真正读到时才有值；失败时保持 `null`，页面必须显示错误而不是空列表。
 *  - 依赖变化或卸载时 abort 上一个请求；`isAbort` 的失败不算错误。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbort } from './client'

export interface LoaderState<T> {
  data: T | null
  loading: boolean
  error: string
  /** 至少完成过一次读取尝试（成功或失败）。 */
  settled: boolean
}

export interface Loader<T> extends LoaderState<T> {
  reload: () => void
  setData: (value: T | null) => void
}

export function useLoader<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Loader<T> {
  const [state, setState] = useState<LoaderState<T>>({ data: null, loading: true, error: '', settled: false })
  const [nonce, setNonce] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setState(previous => ({ data: previous.data, loading: true, error: '', settled: previous.settled }))
    Promise.resolve()
      .then(() => loadRef.current(controller.signal))
      .then(value => {
        if (!alive || controller.signal.aborted) return
        setState({ data: value, loading: false, error: '', settled: true })
      })
      .catch(error => {
        if (!alive || controller.signal.aborted || isAbort(error)) return
        const message = (error as { message?: unknown } | null)?.message
        setState(previous => ({ data: previous.data, loading: false, error: typeof message === 'string' && message ? message : '读取失败', settled: true }))
      })
    return () => {
      alive = false
      controller.abort()
    }
    // 调用方显式给出的依赖决定请求生命周期。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce(value => value + 1), [])
  const setData = useCallback((value: T | null) => setState(previous => ({ ...previous, data: value, error: '' })), [])
  return { ...state, reload, setData }
}

/** 写操作按钮的忙碌/结果状态；失败保留调用方的草稿，不在这里改任何输入。 */
export interface ActionState {
  busy: boolean
  message: string
  error: string
  conflict: boolean
}

export function useActionState() {
  const [state, setState] = useState<ActionState>({ busy: false, message: '', error: '', conflict: false })
  const reset = useCallback(() => setState({ busy: false, message: '', error: '', conflict: false }), [])
  return { state, setState, reset }
}

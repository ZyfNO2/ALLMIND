import { useEffect, useState } from 'react'
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], initial: T) {
  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setLoading(true); setError(''); setData(initial)
    Promise.resolve().then(fn).then(v => { if (alive) setData(v) }).catch(e => { if (alive) setError(e.message || '读取失败') }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // Only callers' explicit identity dependencies control request lifetimes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, loading, error, setData }
}

import { useState, type ReactNode } from 'react'
// LUI-06: the `Advanced` escape hatch and `legacyUrl` are gone — every capability lives in this SPA.
export function Notice({ children }: { children: ReactNode }) { return <div role="status" className="my-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{children}</div> }
export function Action({ children, run, disabled = false }: { children: ReactNode; run: () => Promise<unknown>; disabled?: boolean }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  return <div><button className="rounded-2xl bg-aika-500 px-5 py-2 text-white disabled:opacity-40" disabled={disabled || busy} onClick={async () => { setBusy(true); setMessage(''); try { const result = await run(); setMessage(typeof result === 'string' ? result : '操作完成，请以回读结果为准。') } catch(e) { setMessage((e as Error).message) } finally { setBusy(false) } }}>{busy ? '处理中…' : children}</button>{message && <Notice>{message}</Notice>}</div>
}

/**
 * 数据页共用展示件：读取状态块、分页器、二次确认。
 *
 * 状态块的唯一职责是把「读失败」「真的 0 条」「读取中」三种情况分开显示，
 * 避免任何一处把失败渲染成「暂无数据」。
 */
import { useState, type ReactNode } from 'react'
import { Spinner } from '../ui'
import { Notice } from '../Connection'

export function ReadState({
  loading,
  error,
  settled,
  count,
  emptyText,
  onRetry,
  children,
}: {
  loading: boolean
  error: string
  settled: boolean
  count: number | null
  emptyText: string
  onRetry?: () => void
  children: ReactNode
}) {
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700" role="alert">
        <p className="font-semibold">读取失败，未显示任何数据</p>
        <p className="mt-1">{error}</p>
        <p className="mt-1 text-xs">失败不代表这里是空的；下面没有用 0 条冒充结果。</p>
        {onRetry && (
          <button className="mt-3 rounded-xl border border-rose-300 px-4 py-2 text-rose-700" onClick={onRetry}>
            重试读取
          </button>
        )}
      </div>
    )
  }
  if (loading && !settled) return <Spinner />
  if (count === 0) return <Notice>{emptyText}</Notice>
  return <>{children}</>
}

export function Pager({
  offset,
  total,
  loaded,
  busy,
  onPrevious,
  onNext,
}: {
  offset: number
  /** 服务端每页条数；仅用于展示，分页本身由服务端 offset 驱动。 */
  limit: number
  total: number
  loaded: number
  busy: boolean
  onPrevious: () => void
  onNext: () => void
}) {
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + loaded, total)
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-ink-500">
      <button className="rounded-xl border border-slate-200 px-3 py-1.5 disabled:opacity-40" disabled={busy || offset === 0} onClick={onPrevious}>
        上一页
      </button>
      <span>
        已读取 {loaded} 条 · 显示 {from}–{to} / 共 {total} 条
      </span>
      <button
        className="rounded-xl border border-slate-200 px-3 py-1.5 disabled:opacity-40"
        disabled={busy || to >= total}
        onClick={onNext}
      >
        下一页
      </button>
    </div>
  )
}

/** 破坏性操作的二次确认：先确认再发请求，取消不发任何请求。 */
export function Confirm({
  label,
  question,
  confirmLabel = '确认',
  disabled = false,
  busy = false,
  onConfirm,
}: {
  label: string
  question: string
  confirmLabel?: string
  disabled?: boolean
  busy?: boolean
  onConfirm: () => void
}) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <button className="rounded-xl border border-rose-200 px-4 py-2 text-sm text-rose-600 disabled:opacity-40" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    )
  }
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p>{question}</p>
      <div className="mt-3 flex gap-2">
        <button
          className="rounded-xl bg-rose-500 px-4 py-2 text-white disabled:opacity-40"
          disabled={busy}
          onClick={() => {
            setAsking(false)
            onConfirm()
          }}
        >
          {busy ? '处理中…' : confirmLabel}
        </button>
        <button className="rounded-xl border border-rose-200 px-4 py-2" disabled={busy} onClick={() => setAsking(false)}>
          取消
        </button>
      </div>
    </div>
  )
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled = false,
  multiline = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  multiline?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-500">{label}</span>
      {multiline ? (
        <textarea
          aria-label={label}
          className="soft-input"
          rows={6}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
        />
      ) : (
        <input
          aria-label={label}
          className="soft-input"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
        />
      )}
    </label>
  )
}

export function Definition({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="col-span-2 grid grid-cols-[120px_1fr] gap-x-4">
          <dt className="text-ink-300">{label}</dt>
          <dd className="break-all text-ink-700">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

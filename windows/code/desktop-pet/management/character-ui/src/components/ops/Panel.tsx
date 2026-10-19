// LUI-04 · ops 面板共用的展示件。
//
// 只有两类语义在这里被强制：
//  1. `ReadState` 把「读失败」「未读到」「真读到空」分开渲染 —— 绝不把读失败画成空列表。
//  2. `Confirm` 把不可逆动作（卸载 / 数据删除 / 撤销授权）统一成显式确认。

import { useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react'
import type { OpsError } from './shared'

export function OpsNotice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const styles = {
    info: 'border-slate-200 bg-slate-50 text-slate-700',
    warn: 'border-amber-200 bg-amber-50 text-amber-800',
    error: 'border-rose-200 bg-rose-50 text-rose-800',
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  }[tone]
  const Icon = tone === 'error' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Info
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`my-3 flex items-start gap-2 rounded-2xl border p-3 text-sm ${styles}`}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function OpsErrorNotice({ error, fallback }: { error: OpsError | null; fallback?: string }) {
  if (!error) return null
  return <OpsNotice tone="error">{fallback ? `${fallback}：` : ''}{error.message}</OpsNotice>
}

export function OpsBusy({ text }: { text: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-ink-500">
      <Loader2 size={14} className="animate-spin" />{text}
    </span>
  )
}

export function OpsButton({ children, onClick, disabled = false, tone = 'primary', ariaLabel }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; tone?: 'primary' | 'ghost' | 'danger'; ariaLabel?: string
}) {
  const styles = {
    primary: 'bg-aika-500 text-white hover:bg-aika-600 disabled:opacity-40',
    ghost: 'border border-aika-200 text-aika-600 hover:bg-aika-50 disabled:opacity-40',
    danger: 'border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40',
  }[tone]
  return <button type="button" aria-label={ariaLabel} disabled={disabled} onClick={onClick} className={`rounded-2xl px-4 py-2 text-sm transition ${styles}`}>{children}</button>
}

export function OpsField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-ink-700">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  )
}

/**
 * 读状态：`loading` → 读失败 → 未读到 → 真读到空 → 内容。
 * 调用方必须显式传入 `loaded`，否则「读失败」会被画成「暂无」。
 */
export function OpsReadState({ loading, error, loaded, empty, loadingText, errorText, emptyText, children }: {
  loading: boolean
  error: OpsError | null
  loaded: boolean
  empty: boolean
  loadingText: string
  errorText: string
  emptyText: string
  children: ReactNode
}) {
  if (loading) return <OpsBusy text={loadingText} />
  if (error) return <OpsErrorNotice error={error} fallback={errorText} />
  if (!loaded) return <OpsNotice tone="warn">{errorText}：尚未读取到真实状态，本页不会用空列表代替。</OpsNotice>
  if (empty) return <p className="py-4 text-sm text-ink-400">{emptyText}</p>
  return <>{children}</>
}

/**
 * 不可逆动作的确认条。`onConfirm` 只在用户显式点击后调用；取消不会产生任何请求。
 */
export function OpsConfirm({ title, description, confirmLabel, cancelLabel = '取消', onConfirm, onCancel, busy = false, danger = true }: {
  title: string; description: ReactNode; confirmLabel: string; cancelLabel?: string
  onConfirm: () => void; onCancel: () => void; busy?: boolean; danger?: boolean
}) {
  return (
    <section role="group" aria-label={title} className="my-3 space-y-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
      <h4 className="font-bold text-amber-900">{title}</h4>
      <div className="text-sm text-amber-900">{description}</div>
      <div className="flex flex-wrap gap-3">
        <OpsButton onClick={onConfirm} disabled={busy} tone={danger ? 'danger' : 'primary'}>{busy ? '处理中…' : confirmLabel}</OpsButton>
        <OpsButton onClick={onCancel} disabled={busy} tone="ghost">{cancelLabel}</OpsButton>
      </div>
    </section>
  )
}

export function OpsBadge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'muted' | 'error' }) {
  const styles = {
    ok: 'bg-emerald-50 text-emerald-700',
    warn: 'bg-amber-50 text-amber-700',
    muted: 'bg-slate-100 text-slate-600',
    error: 'bg-rose-50 text-rose-700',
  }[tone]
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}>{children}</span>
}

export function OpsDefinition({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value], index) => (
        <div key={`${label}-${index}`} className="contents">
          <dt className="text-ink-400">{label}</dt>
          <dd className="break-all text-ink-700">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function OpsCard({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card space-y-3 p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold">{title}</h3>
        {extra}
      </header>
      {children}
    </section>
  )
}

/** 明文「未实现」文案。未来功能必须保持这个状态，不造占位功能。 */
export function NotImplemented({ children }: { children: ReactNode }) {
  return <OpsNotice tone="warn">{children}</OpsNotice>
}

/** 折叠面板：默认收起，避免一次性加载所有域的读取请求。 */
export function OpsDisclosure({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-2xl border border-slate-100">
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-ink-700">
        {title}
        <span aria-hidden className="text-ink-300">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="border-t border-slate-100 px-4 py-3">{children}</div>}
    </div>
  )
}

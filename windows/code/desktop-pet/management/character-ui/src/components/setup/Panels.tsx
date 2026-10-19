/**
 * LUI-01: the small presentational primitives the setup sections share. They carry no state and no
 * network access; every rule lives in `setup-connection.ts` / `model.ts`.
 */
import type { ReactNode } from 'react'
import { safeLink } from './model'

export function Panel({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="card space-y-4 p-6">
      <h2 className="text-lg font-bold text-ink-900">{title}</h2>
      {children}
    </section>
  )
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' }) {
  const style = tone === 'warning'
    ? 'border-amber-200 bg-amber-50 text-amber-800'
    : 'border-aika-200 bg-aika-50 text-aika-700'
  return <div role="status" className={`rounded-2xl border p-4 text-sm ${style}`}>{children}</div>
}

export function Failure({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{children}</div>
}

export function Help({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink-500">{children}</p>
}

export function Field({
  id, label, value, onInput, type = 'text', hint, maxLength, disabled = false, min, max, step, placeholder,
}: {
  id: string
  label: string
  value: string | number
  onInput: (value: string) => void
  type?: 'text' | 'password' | 'number' | 'textarea'
  hint?: string
  maxLength?: number
  disabled?: boolean
  min?: number
  max?: number
  step?: number
  placeholder?: string
}) {
  const className = 'soft-input'
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-ink-700">{label}</label>
      {type === 'textarea'
        ? <textarea id={id} className={`${className} min-h-[88px]`} value={String(value)} maxLength={maxLength} disabled={disabled} placeholder={placeholder} onChange={event => onInput(event.target.value)} />
        : <input id={id} className={className} type={type} value={String(value)} maxLength={maxLength} disabled={disabled} min={min} max={max} step={step} placeholder={placeholder}
            autoComplete={type === 'password' ? 'new-password' : undefined} spellCheck={false} onChange={event => onInput(event.target.value)} />}
      {hint && <p className="text-xs text-ink-400">{hint}</p>}
    </div>
  )
}

export function Select({
  id, label, value, options, onChange, disabled = false, hint,
}: {
  id: string
  label: string
  value: string
  options: readonly { value: string; label: string; disabled?: boolean }[]
  onChange: (value: string) => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-ink-700">{label}</label>
      <select id={id} className="soft-input" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
      {hint && <p className="text-xs text-ink-400">{hint}</p>}
    </div>
  )
}

export function Button({
  children, onClick, disabled = false, tone = 'primary', type = 'button', id,
  'data-setup-confirm': confirmId, 'data-setup-retry': retryId, 'data-setup-sample': sampleId, 'data-setup-cancel': cancelId,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: 'primary' | 'secondary' | 'danger'
  type?: 'button' | 'submit'
  id?: string
  /** Stable hooks for the browser tests; they are attributes, not styling. */
  'data-setup-confirm'?: string
  'data-setup-retry'?: string
  'data-setup-sample'?: string
  'data-setup-cancel'?: string
}) {
  const style = tone === 'primary'
    ? 'bg-aika-500 text-white hover:bg-aika-600'
    : tone === 'danger'
      ? 'border border-rose-200 bg-white text-rose-600 hover:bg-rose-50'
      : 'border border-aika-200 bg-white text-aika-600 hover:bg-aika-50'
  return (
    <button id={id} type={type} onClick={onClick} disabled={disabled}
      data-setup-confirm={confirmId} data-setup-retry={retryId} data-setup-sample={sampleId} data-setup-cancel={cancelId}
      className={`rounded-2xl px-5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${style}`}>
      {children}
    </button>
  )
}

export function Definition({ rows }: { rows: readonly [string, ReactNode][] }) {
  return (
    <dl className="space-y-1 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="flex gap-4">
          <dt className="w-28 shrink-0 text-ink-500">{term}</dt>
          <dd className="text-ink-900">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Only an https URL becomes a link; anything else is rendered as plain text. */
export function ExternalLink({ label, url }: { label: string; url: unknown }) {
  const link = safeLink(label, url)
  if (!link.href) return <span>{label}</span>
  return <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-aika-600 underline">{label}</a>
}

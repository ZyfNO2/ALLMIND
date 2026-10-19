// LUI-02: 角色高级编辑面板共用的最小 UI 原语。
//
// 这些只是排版与可访问性包装，不含任何业务语义：写入契约、revision 与 operationId 全在
// `session.ts` 里，页面只负责把回执显示出来。
import type { ReactNode } from 'react'
import { Notice } from '../Connection'

export function Panel({ title, description, extra, children }: { title: string; description?: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{title}</h2>
          {description && <p className="mt-1 text-xs text-ink-500">{description}</p>}
        </div>
        {extra}
      </div>
      {children}
    </section>
  )
}

export function Field({ label, value, onChange, multiline = false, disabled = false, type = 'text', hint, id, placeholder, min, step, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; multiline?: boolean; disabled?: boolean
  type?: string; hint?: string; id?: string; placeholder?: string; min?: number | string; step?: number | string; maxLength?: number
}) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-2 block text-sm text-ink-600">{label}</span>
      {multiline
        ? <textarea id={id} aria-label={label} className="soft-input" rows={5} value={value} disabled={disabled} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
        : <input id={id} aria-label={label} type={type} className="soft-input" value={value} disabled={disabled} placeholder={placeholder} min={min} step={step} maxLength={maxLength} onChange={e => onChange(e.target.value)} />}
      {hint && <small className="mt-1 block text-xs text-ink-400">{hint}</small>}
    </label>
  )
}

export function SelectField({ label, id, value, options, onChange, disabled = false, hint }: {
  label: string; id?: string; value: string; options: [string, string][]
  onChange: (v: string) => void; disabled?: boolean; hint?: string
}) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-2 block text-sm text-ink-600">{label}</span>
      <select id={id} aria-label={label} className="soft-input" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
      {hint && <small className="mt-1 block text-xs text-ink-400">{hint}</small>}
    </label>
  )
}

/** 一个面板自己的保存按钮：只在自己分区内提交，并显示真实回执。 */
export function SaveRow({ busy, disabled, onClick, children, note }: { busy: boolean; disabled: boolean; onClick: () => void; children: ReactNode; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="rounded-2xl bg-aika-500 px-5 py-2 text-white disabled:opacity-40" disabled={disabled || busy} onClick={onClick}>{busy ? '保存中…' : children}</button>
      {note && <span className="text-xs text-ink-400">{note}</span>}
    </div>
  )
}

export function ErrorNotice({ message }: { message: string }) {
  if (!message) return null
  return <div role="alert"><Notice>{message}</Notice></div>
}

export function SuccessNotice({ message }: { message: string }) {
  if (!message) return null
  return <div role="status" className="my-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{message}</div>
}

/** 诚实不可用：能力未接入时显示原因，不显示假数据。 */
export function Unavailable({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded-2xl bg-slate-50 p-4 text-sm text-ink-500">{children}</p>
}

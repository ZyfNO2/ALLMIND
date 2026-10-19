import type { ReactNode } from 'react'
import type { ServiceStatusKind } from '../types'

// ---------- 状态圆点（仅展示摘要，详情进 Trace） ----------
const statusColor: Record<ServiceStatusKind, string> = {
  ok: 'bg-emerald-500',
  unconfigured: 'bg-slate-300',
  error: 'bg-rose-500',
  loading: 'bg-amber-400 animate-pulse',
}

const statusText: Record<ServiceStatusKind, string> = {
  ok: '正常',
  unconfigured: '未配置',
  error: '异常',
  loading: '加载中',
}

export function StatusDot({ status }: { status: ServiceStatusKind }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {status === 'ok' && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
      )}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusColor[status]}`} />
    </span>
  )
}

export { statusText }

// ---------- 卡片 ----------
export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`card p-5 ${className}`}>{children}</div>
}

export function SectionTitle({
  title,
  extra,
}: {
  title: string
  extra?: ReactNode
}) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h3 className="text-base font-bold text-ink-900">{title}</h3>
      {extra}
    </div>
  )
}

// ---------- 开关 ----------
export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-aika-500' : 'bg-slate-200'
      }`}
    >
      <span
        className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${
          checked ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

// ---------- 标签 ----------
const toneClass: Record<string, string> = {
  blue: 'bg-blue-50 text-blue-600',
  pink: 'bg-pink-50 text-pink-600',
  amber: 'bg-amber-50 text-amber-600',
  green: 'bg-emerald-50 text-emerald-600',
  violet: 'bg-violet-50 text-violet-600',
  slate: 'bg-slate-100 text-slate-600',
}

export function Tag({
  children,
  tone = 'slate',
}: {
  children: ReactNode
  tone?: keyof typeof toneClass
}) {
  return <span className={`chip ${toneClass[tone]}`}>{children}</span>
}

export function IconTile({
  children,
  tone = 'blue',
  size = 'md',
}: {
  children: ReactNode
  tone?: 'blue' | 'green' | 'amber' | 'pink' | 'violet'
  size?: 'md' | 'lg'
}) {
  const bg: Record<string, string> = {
    blue: 'bg-gradient-to-br from-blue-400 to-indigo-500',
    green: 'bg-gradient-to-br from-emerald-400 to-teal-500',
    amber: 'bg-gradient-to-br from-amber-400 to-orange-500',
    pink: 'bg-gradient-to-br from-pink-400 to-rose-400',
    violet: 'bg-gradient-to-br from-violet-400 to-aika-500',
  }
  return (
    <div
      className={`flex items-center justify-center rounded-2xl text-white shadow-card ${
        bg[tone]
      } ${size === 'lg' ? 'h-12 w-12' : 'h-10 w-10'}`}
    >
      {children}
    </div>
  )
}

export function Spinner() {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-aika-200 border-t-aika-500" />
    </div>
  )
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-ink-300">
      <div className="text-4xl">🌙</div>
      <p className="text-sm">{text}</p>
    </div>
  )
}

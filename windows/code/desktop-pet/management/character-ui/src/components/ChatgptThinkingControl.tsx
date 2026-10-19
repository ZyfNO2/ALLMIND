import { useState } from 'react'
import { api } from '../book-api'

type Choices = { level: number; label: string; revision: number; options?: { level: number; label: string }[] }
export default function ChatgptThinkingControl({ disabled, action, applied }: { disabled: boolean; action: (fn: () => Promise<void>) => Promise<void>; applied: () => Promise<void> }) {
  const [choices, setChoices] = useState<Choices | null>(null), [pending, setPending] = useState(false)
  async function run(fn: () => Promise<void>) { setPending(true); try { await action(fn) } finally { setPending(false) } }
  return <section className="mb-card"><h3>ChatGPT 思考强度</h3><p className="mb-muted">读取当前网页实际支持的额度，核对切换成功后立即保存。请先保存或放弃其他设置草稿；生成中不能切换。</p>
    <button disabled={disabled || pending} onClick={() => void run(async () => setChoices(await api<Choices>('/chatgpt-web/thinking')))}>读取可用思考强度</button>
    {choices && <><p role="status">当前：{choices.label}</p><div className="mb-row">{choices.options?.map(row => <button key={row.level} aria-pressed={row.level === choices.level} disabled={disabled || pending} onClick={() => void run(async () => {
      const next = await api<Choices>('/chatgpt-web/thinking', { method: 'POST', body: { level: row.level, expectedRevision: choices.revision, operationId: crypto.randomUUID() } })
      setChoices({ ...next, options: next.options ?? choices.options }); await applied()
    })}>{row.label}</button>)}</div></>}
  </section>
}

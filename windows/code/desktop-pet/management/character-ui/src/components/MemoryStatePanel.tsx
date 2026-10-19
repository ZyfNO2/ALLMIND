import { useState } from 'react'
import type { BookSnapshot, SavedTurn, StatePreview } from '../../../../contracts/memory-book'
import { api } from '../book-api'

export default function MemoryStatePanel({ book, turns, characterId, sessionId, update }: { book: BookSnapshot | null; turns: SavedTurn[]; characterId: string; sessionId: string; update: (book: BookSnapshot) => void }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [key, setKey] = useState('地点'), [value, setValue] = useState(''), [preview, setPreview] = useState<StatePreview | null>(null)
  const scope = { characterId, sessionId }, turn = turns.at(-1), events = book?.entries.filter(e => e.event && e.enabled) ?? []
  async function work(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  async function apply() { if (!preview) return; const result = await api<{ book: BookSnapshot }>('/state/apply', { method: 'POST', body: { ...scope, previewId: preview.id, operationId: crypto.randomUUID() } }); update(result.book); setPreview(null); setValue('') }
  return <section className="mb-card" aria-label="共同记忆" style={{ overflowWrap: 'anywhere' }}><h3>Memory · 与用户的共同记忆</h3><p>将已提交聊天记录保存为私人 Memory；用户与角色的发言分别保留。助手发言可回看，不能单独证明外部事实。</p>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || !turn || !book} onClick={() => void work(async () => { const result = await api<{ book: BookSnapshot }>('/memory/remember', { method: 'POST', body: { ...scope, turnId: turn!.id, expectedRevision: book!.revision, operationId: crypto.randomUUID() } }); update(result.book) })}>记录最近一次共同聊天</button>
    <details><summary>依据记忆更新当前状态</summary><p>显式核对新值后一次提交事件和状态。原作初始设定需要明确初始化；重新导入不会覆盖实例。</p><fieldset disabled={busy}>
      <label>状态名称<input aria-label="状态名称" value={key} onChange={e => { setKey(e.target.value); setPreview(null) }} /></label><label>新值<input aria-label="状态新值" value={value} onChange={e => { setValue(e.target.value); setPreview(null) }} /></label>
      <button disabled={!turn || !key.trim() || !value.trim()} onClick={() => void work(async () => setPreview(await api<StatePreview>('/state/preview', { method: 'POST', body: { ...scope, proposal: { turnId: turn!.id, quote: turn!.user, changes: [{ key, value }] } } })))}>预览状态变化</button>
      {(book?.entries ?? []).filter(e => e.type === 'state' && e.origin === 'authored' && e.pairingId === null && e.enabled).map(e => <button key={e.id} onClick={() => void work(async () => setPreview(await api<StatePreview>('/state/initialize', { method: 'POST', body: { ...scope, templateId: e.id } })))}>初始化「{e.title}」</button>)}
      {preview && <div><p>依据：{preview.event.event!.basis === 'user_message' ? '已提交的用户消息' : '作者初始设定'} · {preview.event.body}</p>{preview.event.event!.changes.map(c => <p key={c.key}>{c.key}：{c.before ?? '未设置'} → {c.after}</p>)}<button onClick={() => void work(apply)}>确认事件与状态</button><button onClick={() => setPreview(null)}>取消预览</button></div>}
    </fieldset></details>
    {(book?.entries ?? []).filter(e => e.state && e.enabled && events.some(event => event.id === e.state!.eventId) && (!e.validUntil || Date.parse(e.validUntil) > Date.now())).map(e => <p key={e.id}>{e.body} · 依据：{events.find(event => event.id === e.state!.eventId)!.event!.basis === 'user_message' ? '用户消息' : '作者初始设定'}</p>)}
    {!!events.length && <details><summary>状态变化记录 · {events.length}</summary>{events.map(e => <article key={e.id}><p>{e.body} · {e.event!.basis === 'user_message' ? '用户消息' : '作者初始设定'}</p>{e.event!.changes.map(c => <small key={c.key}>{c.key}：{c.before ?? '未设置'} → {c.after} </small>)}</article>)}</details>}
  </section>
}

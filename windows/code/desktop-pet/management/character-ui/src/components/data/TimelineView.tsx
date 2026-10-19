/**
 * 完整时间线：领域筛选、日期区间、分页游标、活动视图。
 *
 * 端点：`GET /api/unified-timeline?characterId=&userId=&characterInstanceId=&domains=&limit=&cursor=&from=&to=&activitiesOnly=&order=`
 * （`management/server.ts` 校验 domains ∈ canon,companion,work,collection；limit 1..200。）
 *
 * 契约要点：
 *  - 分页用服务端游标：`nextCursor` 没有前进即视为失败，不用重复页冒充「更多」。
 *  - 服务返回的领域必须落在本次筛选内，否则拒绝显示（避免混入未请求的数据）。
 *  - 读失败显示错误并保留「重试」，不显示成「没有事件」。
 *  - 游标/筛选/角色任一变化都 abort 上一个请求。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import { isAbort, pairingFor, readRunningPairing, readTimeline, TIMELINE_DOMAINS, type PairingScope, type TimelineDomain, type TimelineItem } from './client'
import { Definition, ReadState } from './Panel'

const PAGE_SIZE = 50

const DOMAIN_TONES: Record<TimelineDomain, string> = {
  companion: 'bg-emerald-50 text-emerald-600',
  canon: 'bg-indigo-50 text-indigo-600',
  work: 'bg-amber-50 text-amber-600',
  collection: 'bg-slate-100 text-slate-600',
}

const WORK_STATUS: Record<string, string> = {
  prepared: '待确认',
  dispatched: '已派发',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  uncertain: '结果待核对',
  cancelled: '已取消',
}

export default function TimelineView({ characterId }: { characterId: string }) {
  const [pairing, setPairing] = useState<PairingScope | null>(null)
  const [pairingError, setPairingError] = useState('')
  const [domains, setDomains] = useState<TimelineDomain[]>(['companion'])
  const [activitiesOnly, setActivitiesOnly] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [order, setOrder] = useState<'desc' | 'asc'>('desc')

  const [items, setItems] = useState<TimelineItem[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [loadMoreError, setLoadMoreError] = useState('')
  const [settled, setSettled] = useState(false)
  const [selected, setSelected] = useState<TimelineItem | null>(null)

  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    readRunningPairing(runtime.request)
      .then(running => {
        if (alive) setPairing(pairingFor(characterId, running))
      })
      .catch(error => {
        if (!alive || isAbort(error)) return
        setPairingError((error as Error).message || '读取运行配对失败')
        setPairing(pairingFor(characterId, null))
      })
    return () => {
      alive = false
    }
  }, [characterId])

  const filterKey = useMemo(
    () => JSON.stringify([characterId, pairing?.userId, pairing?.characterInstanceId, [...domains].sort(), activitiesOnly, from, to, order]),
    [characterId, pairing, domains, activitiesOnly, from, to, order],
  )

  useEffect(() => {
    if (!pairing) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    setError('')
    setLoadMoreError('')
    readTimeline(
      runtime.request,
      {
        characterId,
        userId: pairing.userId,
        characterInstanceId: pairing.characterInstanceId,
        domains,
        limit: PAGE_SIZE,
        order,
        ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
        ...(to ? { to: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() } : {}),
        ...(activitiesOnly ? { activitiesOnly: true } : {}),
      },
      current.signal,
    )
      .then(value => {
        if (current.signal.aborted) return
        setItems(value.items)
        setCursor(value.nextCursor)
        setTotal(value.totalMatching)
        setSelected(null)
        setSettled(true)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        // 读失败不显示假零：列表置空并显示错误。
        setItems(null)
        setCursor(null)
        setError((error as Error).message || '读取统一时间线失败')
        setSettled(true)
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false)
      })
    return () => current.abort()
    // filterKey 已经把参与请求的全部条件编码进去。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  async function loadMore() {
    if (!pairing || !cursor || loadingMore || loading) return
    const current = new AbortController()
    controller.current?.abort()
    controller.current = current
    setLoadingMore(true)
    setLoadMoreError('')
    try {
      const value = await readTimeline(
        runtime.request,
        {
          characterId,
          userId: pairing.userId,
          characterInstanceId: pairing.characterInstanceId,
          domains,
          limit: PAGE_SIZE,
          cursor,
          order,
          ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
          ...(to ? { to: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() } : {}),
          ...(activitiesOnly ? { activitiesOnly: true } : {}),
        },
        current.signal,
      )
      if (current.signal.aborted) return
      setItems(previous => {
        const seen = new Set((previous ?? []).map(item => item.eventId))
        return [...(previous ?? []), ...value.items.filter(item => !seen.has(item.eventId))]
      })
      setCursor(value.nextCursor)
      setTotal(value.totalMatching)
    } catch (error) {
      if (current.signal.aborted || isAbort(error)) return
      setLoadMoreError((error as Error).message || '加载更多失败')
    } finally {
      if (!current.signal.aborted) setLoadingMore(false)
    }
  }

  return (
    <div className="space-y-5">
      <section className="card space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-500">领域</span>
          {TIMELINE_DOMAINS.map(domain => {
            const active = domains.includes(domain.id)
            return (
              <button
                key={domain.id}
                aria-pressed={active}
                className={`rounded-2xl px-4 py-2 text-xs font-medium ${active ? 'bg-aika-500 text-white' : 'bg-white text-ink-500'}`}
                onClick={() => {
                  const next = active ? domains.filter(value => value !== domain.id) : [...domains, domain.id]
                  if (!next.length) return
                  setDomains(next)
                }}
              >
                {domain.label}
              </button>
            )
          })}
        </div>

        <div className="grid grid-cols-4 gap-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-500">起始日期</span>
            <input aria-label="起始日期" type="date" className="soft-input" value={from} onChange={event => setFrom(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-500">结束日期</span>
            <input aria-label="结束日期" type="date" className="soft-input" value={to} onChange={event => setTo(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-500">排序</span>
            <select aria-label="排序" className="soft-input" value={order} onChange={event => setOrder(event.target.value as 'desc' | 'asc')}>
              <option value="desc">最新在前</option>
              <option value="asc">最早在前</option>
            </select>
          </label>
          <label className="flex items-end gap-2 pb-2 text-xs text-ink-500">
            <input aria-label="只看活动事件" type="checkbox" checked={activitiesOnly} onChange={event => setActivitiesOnly(event.target.checked)} />
            只看活动事件（不含对话正文）
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-400">
          <button
            className="rounded-2xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-40"
            disabled={loading}
            onClick={() => {
              setFrom('')
              setTo('')
              setActivitiesOnly(false)
              setDomains(['companion'])
              setOrder('desc')
            }}
          >
            重置筛选
          </button>
          <span>已读取 {items?.length ?? 0} / {total} 项；分页由服务端游标推进。</span>
        </div>
        {pairingError && <Notice>运行配对读取失败：{pairingError}。筛选按角色派生配对请求，服务端仍以真实配对为准。</Notice>}
      </section>

      <section className="card space-y-4 p-6">
        <ReadState
          loading={loading}
          error={error}
          settled={settled}
          count={items ? items.length : null}
          emptyText="这个筛选条件下还没有事件。"
          onRetry={() => setDomains(previous => [...previous])}
        >
          <div className="space-y-3">
            {items?.map(item => (
              <button
                key={item.eventId}
                onClick={() => setSelected(item)}
                className="block w-full rounded-2xl border border-slate-100 p-4 text-left transition hover:bg-slate-50"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`chip ${DOMAIN_TONES[item.domain]}`}>{TIMELINE_DOMAINS.find(domain => domain.id === item.domain)?.label ?? item.domain}</span>
                  <span className="text-ink-400">{new Date(item.occurredAt).toLocaleString('zh-CN')}</span>
                  <span className="text-ink-400">{item.type}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-ink-800">{item.summary || '（无摘要）'}</p>
                {item.companionDetails && (
                  <p className="mt-1 line-clamp-2 text-xs text-ink-500">
                    你：{item.companionDetails.userText} / 角色：{item.companionDetails.assistantText}
                  </p>
                )}
              </button>
            ))}
          </div>

          {loadMoreError && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
              <p>{loadMoreError}</p>
              <button className="mt-2 rounded-xl border border-rose-300 px-4 py-2" onClick={loadMore}>
                重试加载
              </button>
            </div>
          )}
          {cursor && !loadMoreError && (
            <button className="rounded-2xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-40" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? '正在读取…' : '加载更早的事件'}
            </button>
          )}
        </ReadState>
      </section>

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-ink-900/30 backdrop-blur-[2px]" onClick={() => setSelected(null)} />
          <aside className="animate-slide-in relative h-full w-[480px] overflow-y-auto bg-white p-7 shadow-soft">
            <div className="mb-4 flex items-start justify-between">
              <span className={`chip ${DOMAIN_TONES[selected.domain]}`}>
                {TIMELINE_DOMAINS.find(domain => domain.id === selected.domain)?.label ?? selected.domain}
              </span>
              <button className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>
            <h2 className="text-lg font-bold text-ink-900">{selected.summary || '（无摘要）'}</h2>
            <p className="mt-1 text-xs text-ink-400">{new Date(selected.occurredAt).toLocaleString('zh-CN')} · {selected.type}</p>

            <div className="mt-5 space-y-4 text-sm">
              {selected.companionDetails && (
                <div className="space-y-2">
                  <p className="rounded-2xl bg-aika-50 p-3">你：{selected.companionDetails.userText}</p>
                  <p className="rounded-2xl bg-slate-50 p-3">角色：{selected.companionDetails.assistantText}</p>
                </div>
              )}
              {selected.canonDetails && (
                <div className="space-y-1 rounded-2xl bg-indigo-50 p-3 text-xs text-indigo-900">
                  <p>这是角色原作设定（作者虚构），不是用户事实。</p>
                  {selected.canonDetails.scene && <p>场景 · {selected.canonDetails.scene}</p>}
                  {selected.canonDetails.awareness && <p>角色认知 · {selected.canonDetails.awareness}</p>}
                </div>
              )}
              {selected.companionActivityDetails && (
                <p className="rounded-2xl bg-slate-50 p-3 text-xs text-ink-600">
                  主动陪伴邀请 · {selected.companionActivityDetails.status === 'dismissed' ? '已忽略' : '已接受'} ·{' '}
                  {selected.companionActivityDetails.actionKind}
                  {selected.companionActivityDetails.sourceKind ? ` · 来源类型 ${selected.companionActivityDetails.sourceKind}` : ''}
                </p>
              )}
              {selected.workDetails && (
                <div className="rounded-2xl bg-amber-50 p-3 text-xs text-amber-900">
                  <p>执行者 · {selected.workDetails.executorId} · {WORK_STATUS[selected.workDetails.status] ?? selected.workDetails.status}</p>
                  {selected.workDetails.instruction && <p className="mt-1">{selected.workDetails.instruction}</p>}
                  {selected.workDetails.resultSummary && <p className="mt-1">{selected.workDetails.resultSummary}</p>}
                </div>
              )}

              <Definition
                rows={[
                  ['事件标识', <span className="font-mono">{selected.eventId}</span>],
                  ['来源标识', selected.sourceRef.id],
                  ['来源版本', String(selected.sourceRef.version)],
                ]}
              />
              <Notice>时间线是面向用户的经历记录；请求、耗时与 Token 等工程字段只在 Trace 页显示。</Notice>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

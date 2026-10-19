/**
 * Trace（工程证据）与运行日志。
 *
 * 端点：
 *  - `GET /api/traces?characterId=&limit=&offset=`（limit 1..100；返回 total/summary/traces）
 *  - `GET /api/traces/{id}/content`（正文按需读取，服务器按历史所有者返回 available/forgotten/unavailable）
 *  - `GET /api/snapshot`（运行事件日志；本页只读，不启动任何模块）
 *
 * 契约要点：
 *  - Trace 正文默认脱敏（列表里是 `[digest:…]`）；只有显式点击才请求正文，且**不落盘**、不写缓存。
 *  - 三态诚实显示：available / forgotten / unavailable 分别给出不同说明，不用空字符串冒充。
 *  - 失败显示错误，不把「读不到」显示成「没有 Trace」。
 *  - 分页用服务端 offset + total；切换角色时 abort 上一个请求。
 */
import { useEffect, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import { isAbort, readTraceContent, readTraces, type RuntimeTrace, type TraceContent, type TraceListResult } from './client'
import { Pager, ReadState } from './Panel'

const TRACE_DIGEST_PATTERN = /^\[digest:[0-9a-f]{8} len:\d+\]$/

/** 未展开正文时只显示脱敏摘要；已经是 digest 形态的按原样显示，其他文本一律降级成脱敏标记。 */
export function safeTraceSnippet(text: string | undefined): string {
  if (!text) return ''
  if (TRACE_DIGEST_PATTERN.test(text)) return text
  return `[digest:masked len:${[...text].length}]`
}

const BACKGROUND_STAGES = ['memory_enqueue', 'memory_plan', 'memory_commit', 'summary', 'distill']

function isBackground(stage: RuntimeTrace['stages'][number]): boolean {
  return stage.category === 'background' || BACKGROUND_STAGES.includes(stage.name)
}

export default function TraceView({ characterId, initialTab = 'traces' }: { characterId: string; initialTab?: 'traces' | 'logs' }) {
  const [tab, setTab] = useState<'traces' | 'logs'>(initialTab)
  const [result, setResult] = useState<TraceListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [settled, setSettled] = useState(false)
  const [offset, setOffset] = useState(0)
  const [nonce, setNonce] = useState(0)
  const [contents, setContents] = useState<Record<string, TraceContent | 'loading'>>({})
  const [contentErrors, setContentErrors] = useState<Record<string, string>>({})
  const [logs, setLogs] = useState<Record<string, any> | null>(null)
  const [logsError, setLogsError] = useState('')

  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    setError('')
    setContents({})
    setContentErrors({})
    readTraces(runtime.request, characterId, { limit: 20, offset }, current.signal)
      .then(value => {
        if (current.signal.aborted) return
        setResult(value)
        setSettled(true)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        // 读失败不能显示成「暂无 Trace」。
        setResult(null)
        setError((error as Error).message || '读取 Trace 失败')
        setSettled(true)
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false)
      })
    return () => current.abort()
  }, [characterId, offset, nonce])

  useEffect(() => {
    const current = new AbortController()
    setLogsError('')
    runtime
      .request('/api/snapshot')
      .then(snapshot => {
        if (!current.signal.aborted) setLogs(snapshot)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        setLogs(null)
        setLogsError((error as Error).message || '读取运行记录失败')
      })
    return () => current.abort()
  }, [nonce])

  async function toggleContent(trace: RuntimeTrace) {
    const existing = contents[trace.traceId]
    if (existing && existing !== 'loading') {
      setContents(previous => {
        const next = { ...previous }
        delete next[trace.traceId]
        return next
      })
      return
    }
    if (existing === 'loading') return
    setContents(previous => ({ ...previous, [trace.traceId]: 'loading' }))
    setContentErrors(previous => {
      const next = { ...previous }
      delete next[trace.traceId]
      return next
    })
    try {
      const value = await readTraceContent(runtime.request, trace.traceId)
      setContents(previous => ({ ...previous, [trace.traceId]: value }))
    } catch (error) {
      setContents(previous => {
        const next = { ...previous }
        delete next[trace.traceId]
        return next
      })
      setContentErrors(previous => ({ ...previous, [trace.traceId]: (error as Error).message || '读取正文失败' }))
    }
  }

  const summary = result?.summary

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['traces', '调用链 Trace'],
            ['logs', '运行事件日志'],
          ] as ['traces' | 'logs', string][]
        ).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`rounded-2xl px-5 py-2 text-sm ${tab === id ? 'bg-aika-500 text-white' : 'bg-white text-ink-500'}`}>
            {label}
          </button>
        ))}
        <button className="rounded-2xl border border-slate-200 px-4 py-2 text-sm" onClick={() => setNonce(value => value + 1)}>
          刷新
        </button>
      </div>

      <Notice>
        Trace 是工程证据，与用户动态、知识 Wiki 分开；列表正文默认脱敏，只有点击「查看本机历史正文」才按需读取，读取结果不写入本地存储。
        没有 Trace 不代表模型或系统已经通过测试。
      </Notice>

      {tab === 'traces' ? (
        <>
          <section className="card grid grid-cols-4 gap-4 p-6">
            {(
              [
                ['总对话轮次', summary ? String(summary.totalCount) : '未读取'],
                ['平均响应耗时', summary ? `${summary.avgElapsedMs} ms` : '未读取'],
                ['调用成功率', summary ? `${summary.successRate}%` : '未读取'],
                ['累计消耗 Token', summary ? summary.totalTokens.toLocaleString('zh-CN') : '未读取'],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-slate-50 p-4">
                <p className="text-lg font-bold text-ink-900">{value}</p>
                <p className="mt-1 text-xs text-ink-500">{label}</p>
              </div>
            ))}
          </section>

          <section className="card space-y-4 p-6">
            <ReadState
              loading={loading}
              error={error}
              settled={settled}
              count={result ? result.traces.length : null}
              emptyText="暂无 Trace 记录；这不代表模型或系统已通过测试。"
              onRetry={() => setNonce(value => value + 1)}
            >
              <div className="space-y-4">
                {result?.traces.map(trace => {
                  const content = contents[trace.traceId]
                  const available = content && content !== 'loading' && content.status === 'available'
                  const foreground = trace.stages.filter(stage => !isBackground(stage))
                  const background = trace.stages.filter(isBackground)
                  return (
                    <article key={trace.traceId} className="rounded-2xl border border-slate-100 p-4">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className={`chip ${trace.status === 'ok' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                          {trace.status === 'ok' ? '成功' : '失败'}
                        </span>
                        <span className="text-ink-400">{new Date(trace.createdAt).toLocaleString('zh-CN')}</span>
                        <span className="font-mono text-ink-400">轮次 {trace.turnId.slice(0, 8)}…</span>
                        <span className="chip bg-slate-100 text-slate-600">总耗时 {trace.totalElapsedMs} ms</span>
                      </div>

                      <div className="mt-3 space-y-1 text-sm">
                        <p>
                          <span className="text-ink-400">用户：</span>
                          {available ? (content as TraceContent).userText : safeTraceSnippet(trace.userText)}
                        </p>
                        <p>
                          <span className="text-ink-400">ALLMIND：</span>
                          {available ? (content as TraceContent).replyText : safeTraceSnippet(trace.replyText)}
                        </p>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <button
                          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs disabled:opacity-40"
                          disabled={content === 'loading'}
                          onClick={() => toggleContent(trace)}
                        >
                          {content === 'loading' ? '读取中…' : available ? '隐藏正文' : '查看本机历史正文'}
                        </button>
                        {content && content !== 'loading' && content.status === 'forgotten' && (
                          <span className="text-xs text-ink-400">{content.reason || '对应历史已遗忘或清理。'}</span>
                        )}
                        {content && content !== 'loading' && content.status === 'unavailable' && (
                          <span className="text-xs text-ink-400">{content.reason || '正文暂不可用。'}</span>
                        )}
                        {contentErrors[trace.traceId] && <span className="text-xs text-rose-600">{contentErrors[trace.traceId]}</span>}
                      </div>

                      <div className="mt-4 space-y-2">
                        <StageTrack
                          title="前台主链 · 对话响应与语音播报"
                          tone="bg-blue-50 text-blue-600"
                          stages={foreground}
                          emptyText="本轮没有前台阶段记录"
                        />
                        <StageTrack
                          title="后台异步 · 记忆提炼与落库提交"
                          tone="bg-violet-50 text-violet-600"
                          stages={background}
                          emptyText="本轮无后台记忆写入或已跳过"
                        />
                      </div>

                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs text-aika-600">查看该轮调用阶段明细与 Token 数据</summary>
                        <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-50 p-3 text-xs text-ink-600">
                          {JSON.stringify({ turnId: trace.turnId, tokens: trace.tokens ?? null, stages: trace.stages }, null, 2)}
                        </pre>
                      </details>
                    </article>
                  )
                })}
              </div>
              {result && (
                <Pager
                  offset={result.offset}
                  limit={result.limit}
                  total={result.total}
                  loaded={result.traces.length}
                  busy={loading}
                  onPrevious={() => setOffset(Math.max(0, offset - 20))}
                  onNext={() => setOffset(offset + 20)}
                />
              )}
            </ReadState>
          </section>
        </>
      ) : (
        <section className="card space-y-4 p-6">
          <h2 className="text-base font-bold">运行事件日志</h2>
          {logsError ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700" role="alert">
              <p className="font-semibold">读取运行记录失败</p>
              <p className="mt-1">{logsError}</p>
              <p className="mt-1 text-xs">失败不代表没有运行事件。</p>
              <button className="mt-3 rounded-xl border border-rose-300 px-4 py-2" onClick={() => setNonce(value => value + 1)}>
                重试读取
              </button>
            </div>
          ) : !logs ? (
            <p className="text-xs text-ink-400">正在读取运行事件…</p>
          ) : (logs.events ?? []).length === 0 ? (
            <Notice>当前快照没有运行事件记录；没有记录不等于维护已完成。</Notice>
          ) : (
            <div className="space-y-2">
              {[...(logs.events ?? [])].reverse().map((event: any) => (
                <div key={event.id} className="rounded-2xl border border-slate-100 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ink-400">{new Date(event.at).toLocaleString('zh-CN')}</span>
                    <span className="chip bg-slate-100 text-slate-600">{event.kind}</span>
                    <span className="text-ink-500">{event.moduleId}</span>
                    {event.elapsedMs !== null && event.elapsedMs !== undefined && <span className="text-ink-400">{event.elapsedMs} ms</span>}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-ink-700">{event.message}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function StageTrack({
  title,
  tone,
  stages,
  emptyText,
}: {
  title: string
  tone: string
  stages: RuntimeTrace['stages']
  emptyText: string
}) {
  const elapsed = stages.reduce((sum, stage) => sum + (stage.elapsedMs || 0), 0)
  return (
    <div className="rounded-2xl bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`chip ${tone}`}>{title}</span>
        <span className="text-ink-400">耗时 {elapsed} ms</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {stages.length === 0 ? (
          <span className="text-ink-400">{emptyText}</span>
        ) : (
          stages.map((stage, index) => (
            <span key={`${stage.name}-${index}`} className="flex items-center gap-2">
              <span
                className={`chip ${
                  stage.status === 'failed' ? 'bg-rose-50 text-rose-600' : stage.status === 'cancelled' ? 'bg-amber-50 text-amber-600' : 'bg-white text-ink-600'
                }`}
              >
                {stage.label || stage.name} · {stage.elapsedMs}ms
              </span>
              {index < stages.length - 1 && <span className="text-ink-300">→</span>}
            </span>
          ))
        )}
      </div>
    </div>
  )
}

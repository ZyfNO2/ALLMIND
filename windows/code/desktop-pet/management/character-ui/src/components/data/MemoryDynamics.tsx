/**
 * 记忆动态：鲜活度 / 情绪 / 来源定位 / 遗忘与恢复 / 实际召回轨迹 / 策略微调。
 *
 * 端点（`management/memory-dynamics-routes.ts`）：
 *  - `GET  /api/memory/dynamics?characterId=&query=&state=&offset=&limit=`（limit 1..100）
 *  - `GET  /api/memory/traces?characterId=&offset=&limit=`
 *  - `POST /api/memory/forget` / `restore`（`id` + `expectedVersion` + `operationId` + 非空 `reason`）
 *  - `PUT  /api/memory/policy`、`POST /api/memory/policy/rollback`
 *  - `POST /api/memory/preview`（冻结版本试算，不写库、不调用模型）
 *
 * 缺失数据不解释成 0：没有动态评估时明确说明「不把缺失解释为鲜活度或情绪为零」。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import {
  isAbort,
  MEMORY_POLICY_LIMITS,
  policyProblem,
  readMemoryDynamics,
  readRecallTraces,
  type MemoryDynamicsItem,
  type MemoryDynamicsSnapshot,
  type MemoryPolicy,
  type RecallTrace,
} from './client'
import { forgetRecord, OperationIds, restoreRecord, saveMemoryPolicy, rollbackMemoryPolicy } from './actions'
import { Definition, Field, Pager, ReadState } from './Panel'

const STATE_LABELS: Record<string, string> = {
  active: '有效',
  invalidated: '已失效',
  deleted: '已遗忘',
  expired: '已过期',
  purged: '已清理',
}

const KIND_LABELS: Record<string, string> = {
  memory: '长期记忆',
  transcript: '对话原文',
  summary: '会话摘要',
  emotion: '情绪记录',
  keyword_index: '关键词索引',
  vector_index: '向量索引',
  context_cache: '上下文缓存',
}

const CUE_LABELS: Record<string, string> = {
  keywords: '关键词',
  phrase: '完整短语',
  supported_relation: '有来源支持的事实关系',
  none: '无线索',
}

const OMISSION_LABELS: Record<string, string> = {
  hard_gate: '归属、有效性或遗忘检查未通过',
  no_cue: '没有匹配线索',
  below_threshold: '低于选入门槛',
  limit: '超过条数上限',
  budget: '上下文空间不足',
}

const TRACE_STATUS_LABELS: Record<string, string> = {
  assembled: '已组装 · 未确认用于模型输入',
  consumed: '已用于模型输入',
  invalidated: '已失效 · 不再代表有效上下文',
}

const POLICY_FIELDS: [keyof MemoryPolicy, string][] = [
  ['baseHalfLifeDays', '记忆淡化基准（天）'],
  ['emotionHalfLifeDays', '情绪淡化基准（天）'],
  ['baselineWeight', '基础权重'],
  ['activationWeight', '鲜活度权重'],
  ['importanceWeight', '重要性权重'],
  ['emotionWeight', '情绪权重'],
]

const pct = (value: number) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '未评估')
const decimal = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : '—')

export default function MemoryDynamics({ characterId }: { characterId: string }) {
  const [view, setView] = useState<'records' | 'traces' | 'policy'>('records')
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<'active' | 'all'>('active')
  const [offset, setOffset] = useState(0)

  const [snapshot, setSnapshot] = useState<MemoryDynamicsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [settled, setSettled] = useState(false)
  const [nonce, setNonce] = useState(0)

  const [traces, setTraces] = useState<{ records: RecallTrace[]; total: number; offset: number; limit: number } | null>(null)
  const [tracesLoading, setTracesLoading] = useState(false)
  const [tracesError, setTracesError] = useState('')
  const [traceOffset, setTraceOffset] = useState(0)

  const [selectedId, setSelectedId] = useState('')
  const [reason, setReason] = useState('')
  const [lookup, setLookup] = useState<{ id: string; found: boolean; version?: number; requestedVersion?: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [conflict, setConflict] = useState('')
  const [confirmingForget, setConfirmingForget] = useState(false)

  const [policyDraft, setPolicyDraft] = useState<MemoryPolicy | null>(null)
  const [policyBase, setPolicyBase] = useState<number | null>(null)
  const [previewQuery, setPreviewQuery] = useState('')
  const [preview, setPreview] = useState<any>(null)

  const operations = useRef(new OperationIds())
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    setError('')
    readMemoryDynamics(runtime.request, characterId, { query, state, offset, limit: 20 }, current.signal)
      .then(value => {
        if (current.signal.aborted) return
        setSnapshot(value)
        setPolicyBase(previous => (previous === null ? value.policy.revision : previous))
        setPolicyDraft(previous => previous ?? { ...value.policy.policy })
        setSettled(true)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        // 读失败不显示假零：清空快照并显示错误。
        setSnapshot(null)
        setError((error as Error).message || '读取记忆动态失败')
        setSettled(true)
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false)
      })
    return () => current.abort()
  }, [characterId, query, state, offset, nonce])

  useEffect(() => {
    if (view !== 'traces') return
    const current = new AbortController()
    setTracesLoading(true)
    setTracesError('')
    readRecallTraces(runtime.request, characterId, { offset: traceOffset, limit: 10 }, current.signal)
      .then(value => {
        if (!current.signal.aborted) setTraces(value)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        setTraces(null)
        setTracesError((error as Error).message || '读取实际召回轨迹失败')
      })
      .finally(() => {
        if (!current.signal.aborted) setTracesLoading(false)
      })
    return () => current.abort()
  }, [characterId, view, traceOffset, nonce])

  useEffect(() => {
    setSelectedId('')
    setReason('')
    setMessage('')
    setActionError('')
    setConflict('')
    setLookup(null)
    setConfirmingForget(false)
    setPolicyDraft(null)
    setPolicyBase(null)
    setPreview(null)
    operations.current.clear()
  }, [characterId])

  const selected = useMemo(() => snapshot?.items.find(item => item.record.id === selectedId) ?? null, [snapshot, selectedId])
  const policyProblemText = policyProblem(policyDraft)
  const dirty = !!snapshot && !!policyDraft && POLICY_FIELDS.some(([key]) => snapshot.policy.policy[key] !== policyDraft[key])

  async function act(outcome: Promise<{ ok: boolean; value?: any; conflict?: boolean; message?: string }>, success: (value: any) => string) {
    setBusy(true)
    setMessage('')
    setActionError('')
    setConflict('')
    const result = await outcome
    setBusy(false)
    if (result.ok) {
      setMessage(success(result.value))
      setNonce(value => value + 1)
      return
    }
    if (result.conflict) {
      setConflict(result.message ?? '版本已变化。')
      return
    }
    setActionError(result.message ?? '操作未完成。')
  }

  function locateSource(id: string, version?: number) {
    setQuery(id)
    setState('all')
    setOffset(0)
    setSelectedId(id)
    setLookup({ id, found: false, requestedVersion: version })
  }

  useEffect(() => {
    if (!lookup || !snapshot) return
    const found = snapshot.items.find(item => item.record.id === lookup.id)
    setLookup(previous => (previous ? { ...previous, found: !!found, version: found?.record.version } : previous))
  }, [snapshot, lookup?.id])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['records', '内容与遗忘'],
            ['traces', '实际召回'],
            ['policy', '策略微调'],
          ] as ['records' | 'traces' | 'policy', string][]
        ).map(([id, label]) => (
          <button key={id} onClick={() => setView(id)} className={`rounded-2xl px-5 py-2 text-sm ${view === id ? 'bg-aika-500 text-white' : 'bg-white text-ink-500'}`}>
            {label}
          </button>
        ))}
        <button className="rounded-2xl border border-slate-200 px-4 py-2 text-sm" onClick={() => setNonce(value => value + 1)}>
          刷新
        </button>
      </div>

      {message && <Notice>{message}</Notice>}
      {actionError && <Notice>{actionError}</Notice>}
      {conflict && <Notice>{conflict}草稿已保留，未覆盖你的输入。</Notice>}

      {view === 'records' && (
        <div className="grid grid-cols-[1fr_440px] gap-6">
          <section className="card space-y-4 p-6">
            <form
              className="grid grid-cols-2 gap-3"
              onSubmit={event => {
                event.preventDefault()
                setOffset(0)
                setQuery(queryDraft.trim())
              }}
            >
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-ink-500">搜索已保存的内容</span>
                <input
                  aria-label="搜索已保存的内容"
                  className="soft-input"
                  value={queryDraft}
                  maxLength={1000}
                  placeholder="例如：公园、课程、周末"
                  onChange={event => setQueryDraft(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-ink-500">内容状态</span>
                <select
                  aria-label="内容状态"
                  className="soft-input"
                  value={state}
                  onChange={event => {
                    setState(event.target.value as 'active' | 'all')
                    setOffset(0)
                  }}
                >
                  <option value="active">仅有效内容</option>
                  <option value="all">包括已失效与已删除</option>
                </select>
              </label>
              <div className="col-span-2 flex items-center gap-3">
                <button className="rounded-2xl bg-aika-500 px-5 py-2 text-sm text-white" type="submit" disabled={loading}>
                  搜索与刷新
                </button>
                <span className="text-xs text-ink-400">记忆会逐渐淡化，但不会因此自动删除。</span>
              </div>
            </form>

            {lookup && (
              <Notice>
                {!lookup.found
                  ? `没有取得该标识的来源记录（${lookup.id}）。可能已清理或当前不可见；其他正文匹配不会被当作这条来源。`
                  : lookup.requestedVersion !== undefined && lookup.requestedVersion !== lookup.version
                    ? `引用的是版本 ${lookup.requestedVersion}，当前可读版本为 ${lookup.version}。下方正文不代表引用时的旧正文。`
                    : `已定位来源 ${lookup.id}，这里显示当前可读内容。`}
              </Notice>
            )}

            <ReadState
              loading={loading}
              error={error}
              settled={settled}
              count={snapshot ? snapshot.items.length : null}
              emptyText="没有符合条件的内容。"
              onRetry={() => setNonce(value => value + 1)}
            >
              <div className="space-y-2">
                {snapshot?.items.map(item => (
                  <button
                    key={item.record.id}
                    onClick={() => {
                      setSelectedId(item.record.id)
                      setReason('')
                      setConfirmingForget(false)
                      setMessage('')
                      setActionError('')
                      setConflict('')
                    }}
                    className={`block w-full rounded-2xl border p-4 text-left transition ${
                      selectedId === item.record.id ? 'border-aika-300 bg-aika-50' : 'border-slate-100 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                      <span className="chip bg-slate-100 text-slate-600">{KIND_LABELS[item.record.kind] ?? item.record.kind}</span>
                      <span className="chip bg-slate-100 text-slate-600">{STATE_LABELS[item.record.state] ?? item.record.state}</span>
                      <span>v{item.record.version}</span>
                      <span>{new Date(item.record.createdAt).toLocaleString('zh-CN')}</span>
                    </div>
                    <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm text-ink-700">
                      {item.record.state === 'active' ? item.record.text : `正文已隐藏（${STATE_LABELS[item.record.state] ?? item.record.state}）`}
                    </p>
                  </button>
                ))}
              </div>
              {snapshot && (
                <Pager
                  offset={snapshot.offset}
                  limit={snapshot.limit}
                  total={snapshot.total}
                  loaded={snapshot.items.length}
                  busy={loading}
                  onPrevious={() => setOffset(Math.max(0, offset - 20))}
                  onNext={() => setOffset(offset + 20)}
                />
              )}
            </ReadState>
          </section>

          <section className="card space-y-4 p-6">
            {!selected ? (
              <p className="text-sm text-ink-400">选择一条内容查看正文、来源、鲜活度与情绪，并进行遗忘或恢复。</p>
            ) : (
              <RecordDetail
                item={selected}
                reason={reason}
                busy={busy}
                confirmingForget={confirmingForget}
                onReason={setReason}
                onConfirmForget={setConfirmingForget}
                onLocate={locateSource}
                onForget={() =>
                  act(
                    forgetRecord(runtime.request, operations.current, {
                      characterId,
                      id: selected.record.id,
                      expectedVersion: selected.record.version,
                      reason,
                    }),
                    value => `遗忘已确认，服务报告 ${value.affectedIds.length} 条记录受影响。`,
                  )
                }
                onRestore={() =>
                  act(
                    restoreRecord(runtime.request, operations.current, {
                      characterId,
                      id: selected.record.id,
                      expectedVersion: selected.record.version,
                      reason,
                    }),
                    value => `恢复已确认，服务报告 ${value.affectedIds.length} 条记录受影响。`,
                  )
                }
              />
            )}
          </section>
        </div>
      )}

      {view === 'traces' && (
        <section className="card space-y-4 p-6">
          <h2 className="text-base font-bold">实际召回轨迹</h2>
          <p className="text-xs text-ink-400">这里是真实检索记录；每条会标明是否已用于对话。试算不会补成历史。</p>
          {tracesError ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700" role="alert">
              <p className="font-semibold">读取实际召回轨迹失败</p>
              <p className="mt-1">{tracesError}</p>
              <p className="mt-1 text-xs">失败不代表没有轨迹。</p>
              <button className="mt-3 rounded-xl border border-rose-300 px-4 py-2" onClick={() => setNonce(value => value + 1)}>
                重试读取
              </button>
            </div>
          ) : tracesLoading ? (
            <p className="text-xs text-ink-400">正在读取实际轨迹…</p>
          ) : traces && traces.records.length === 0 ? (
            <Notice>暂时没有已保存的实际轨迹；不会用试算补成历史。</Notice>
          ) : (
            <>
              <div className="space-y-3">
                {traces?.records.map(trace => (
                  <article key={trace.id} className="rounded-2xl border border-slate-100 p-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                      <span className="font-semibold text-ink-700">轮次 {trace.scope.turnId}</span>
                      <span className="chip bg-slate-100 text-slate-600">{TRACE_STATUS_LABELS[trace.status] ?? trace.status}</span>
                    </div>
                    <div className="mt-3">
                      <Definition
                        rows={[
                          ['轨迹标识', <span className="font-mono">{trace.id}</span>],
                          ['评估时间', new Date(trace.evaluatedAt).toLocaleString('zh-CN')],
                          ['会话 / 代次', `${trace.scope.sessionId} / ${trace.scope.generation}`],
                          ['数据 / 策略版本', `${trace.dataRevision} / ${trace.policyRevision}`],
                          ['上下文用量', `${trace.countedInputTokens} / ${trace.inputTokenBudget} token`],
                        ]}
                      />
                    </div>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-aika-600">查看候选与选入原因 · {trace.candidates.length} 条</summary>
                      <div className="mt-2 space-y-2">
                        {trace.candidates.map(candidate => (
                          <div key={candidate.source.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <button className="text-aika-600" onClick={() => locateSource(candidate.source.id, candidate.source.version)}>
                                {candidate.source.id} · v{candidate.source.version}
                              </button>
                              <span className={`chip ${candidate.selected ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-600'}`}>
                                {candidate.selected ? '选入' : OMISSION_LABELS[candidate.omission ?? ''] ?? '未选入'}
                              </span>
                            </div>
                            <p className="mt-1 text-ink-500">
                              {CUE_LABELS[candidate.cueKind] ?? candidate.cueKind} · 匹配：{candidate.matchedTerms.join('、') || '无'}
                            </p>
                            <p className="mt-1 text-ink-500">
                              相关度 {decimal(candidate.relevance)} · 鲜活度 {decimal(candidate.activation)} · 重要性 {decimal(candidate.importance)} · 情绪{' '}
                              {decimal(candidate.emotion)} · 排序分 {decimal(candidate.priority)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </details>
                  </article>
                ))}
              </div>
              {traces && (
                <Pager
                  offset={traces.offset}
                  limit={traces.limit}
                  total={traces.total}
                  loaded={traces.records.length}
                  busy={tracesLoading}
                  onPrevious={() => setTraceOffset(Math.max(0, traceOffset - 10))}
                  onNext={() => setTraceOffset(traceOffset + 10)}
                />
              )}
            </>
          )}
        </section>
      )}

      {view === 'policy' && (
        <section className="card space-y-4 p-6">
          <h2 className="text-base font-bold">小幅调整记忆策略</h2>
          <p className="text-xs text-ink-400">保存后影响今后的记忆变化；四项权重之和必须为 1。回退不会恢复已遗忘的内容。</p>
          {!snapshot || !policyDraft ? (
            error ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700" role="alert">
                <p className="font-semibold">读取记忆策略失败</p>
                <p className="mt-1">{error}</p>
              </div>
            ) : (
              <Notice>读取记忆快照后可查看策略。</Notice>
            )
          ) : (
            <>
              <Definition
                rows={[
                  ['当前策略版本', String(snapshot.policy.revision)],
                  ['生效时间', new Date(snapshot.policy.effectiveAt).toLocaleString('zh-CN')],
                  ['数据版本', String(snapshot.dataRevision)],
                ]}
              />
              <div className="grid grid-cols-2 gap-4">
                {POLICY_FIELDS.map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="mb-1.5 block text-xs font-medium text-ink-500">{label}</span>
                    <input
                      aria-label={label}
                      className="soft-input"
                      type="number"
                      min={MEMORY_POLICY_LIMITS[key][0]}
                      max={MEMORY_POLICY_LIMITS[key][1]}
                      step={key.includes('HalfLife') ? 0.5 : 0.01}
                      value={policyDraft[key]}
                      disabled={busy}
                      onChange={event => setPolicyDraft({ ...policyDraft, [key]: Number(event.target.value) })}
                    />
                    <span className="mt-1 block text-xs text-ink-400">
                      允许范围 {MEMORY_POLICY_LIMITS[key][0]}–{MEMORY_POLICY_LIMITS[key][1]}
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-ink-500">
                四项权重之和：
                {Number.isFinite(policyDraft.baselineWeight + policyDraft.activationWeight + policyDraft.importanceWeight + policyDraft.emotionWeight)
                  ? (policyDraft.baselineWeight + policyDraft.activationWeight + policyDraft.importanceWeight + policyDraft.emotionWeight).toFixed(3)
                  : '未填写完整'}
              </p>
              {policyProblemText && <Notice>{policyProblemText}</Notice>}

              <div className="flex flex-wrap gap-3">
                <button
                  className="rounded-2xl bg-aika-500 px-5 py-2 text-sm text-white disabled:opacity-40"
                  disabled={busy || !!policyProblemText || !dirty || policyBase === null}
                  onClick={() =>
                    act(
                      saveMemoryPolicy(runtime.request, operations.current, {
                        characterId,
                        expectedRevision: policyBase!,
                        policy: policyDraft as unknown as Record<string, number>,
                      }),
                      value => `策略已保存为新版本（修订 ${value.revision}）。`,
                    )
                  }
                >
                  {busy ? '处理中…' : '保存策略'}
                </button>
                <button
                  className="rounded-2xl border border-slate-200 px-4 py-2 text-sm"
                  onClick={() => {
                    setPolicyDraft({ ...snapshot.policy.policy })
                    setPolicyBase(snapshot.policy.revision)
                    setConflict('')
                  }}
                >
                  读取最新版本
                </button>
              </div>

              <div className="space-y-2 border-t border-slate-100 pt-4">
                <h3 className="text-sm font-semibold">策略历史与回退</h3>
                <p className="text-xs text-ink-400">回退会替换本页草稿并保存为新版本，今后生效；不会恢复已遗忘的内容。</p>
                {snapshot.policyHistory.map(history => (
                  <div key={history.revision} className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 p-3 text-xs">
                    <div>
                      <p className="font-semibold text-ink-700">版本 {history.revision}</p>
                      <p className="text-ink-400">
                        {new Date(history.effectiveAt).toLocaleString('zh-CN')}
                        {history.restoredFromRevision === null ? '' : ` · 参数来自版本 ${history.restoredFromRevision}`}
                      </p>
                    </div>
                    <button
                      className="rounded-xl border border-slate-200 px-3 py-1.5 disabled:opacity-40"
                      disabled={busy || history.revision === snapshot.policy.revision || policyBase === null}
                      onClick={() =>
                        act(
                          rollbackMemoryPolicy(runtime.request, operations.current, {
                            characterId,
                            expectedRevision: policyBase!,
                            targetRevision: history.revision,
                          }),
                          value => `已用版本 ${history.revision} 的参数生成新版本 ${value.revision}。`,
                        )
                      }
                    >
                      回退到此版本
                    </button>
                  </div>
                ))}
              </div>

              <div className="space-y-3 border-t border-slate-100 pt-4">
                <h3 className="text-sm font-semibold">策略试算</h3>
                <p className="text-xs text-ink-400">仅供试算，不是实际对话记录，也不会改变记忆或保存设置。</p>
                <Field label="预测时的检索问题" value={previewQuery} onChange={setPreviewQuery} placeholder="输入想检查的问题" disabled={busy} />
                <button
                  className="rounded-2xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-40"
                  disabled={busy || !!policyProblemText || policyBase === null}
                  onClick={async () => {
                    setBusy(true)
                    setMessage('')
                    setActionError('')
                    try {
                      const value = await runtime.request('/api/memory/preview', {
                        method: 'POST',
                        body: {
                          characterId,
                          query: previewQuery,
                          evaluatedAt: 'now',
                          expectedDataRevision: snapshot.dataRevision,
                          expectedPolicyRevision: snapshot.policy.revision,
                          policy: policyDraft,
                        },
                      })
                      setPreview(value)
                      setMessage('试算完成；结果只代表冻结版本下的预测。')
                    } catch (error) {
                      setPreview(null)
                      setActionError((error as Error).message || '试算失败')
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  比较当前策略与本页参数
                </button>
                {preview && (
                  <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-xs">
                    <p className="font-semibold text-ink-700">
                      冻结的数据 / 策略版本 {preview.dataRevision} / {preview.policyRevision} · 假设新参数生效于{' '}
                      {new Date(preview.effectiveFrom).toLocaleString('zh-CN')}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      {(['before', 'after'] as const).map(key => (
                        <div key={key}>
                          <p className="font-semibold">{key === 'before' ? '沿用当前策略' : '使用本页参数'}</p>
                          <ul className="mt-1 space-y-1 text-ink-500">
                            {(preview[key] ?? []).map((candidate: any) => (
                              <li key={candidate.source.id}>
                                {candidate.source.id} · {candidate.selected ? '选入' : OMISSION_LABELS[candidate.omission ?? ''] ?? '未选入'}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  )
}

function RecordDetail({
  item,
  reason,
  busy,
  confirmingForget,
  onReason,
  onConfirmForget,
  onLocate,
  onForget,
  onRestore,
}: {
  item: MemoryDynamicsItem
  reason: string
  busy: boolean
  confirmingForget: boolean
  onReason: (value: string) => void
  onConfirmForget: (value: boolean) => void
  onLocate: (id: string, version?: number) => void
  onForget: () => void
  onRestore: () => void
}) {
  const record = item.record
  const dynamics = item.dynamics
  const emotion = dynamics?.traits.emotion
  return (
    <>
      <h2 className="text-base font-bold">内容详情</h2>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
        <span className="chip bg-slate-100 text-slate-600">{KIND_LABELS[record.kind] ?? record.kind}</span>
        <span className="chip bg-slate-100 text-slate-600">{STATE_LABELS[record.state] ?? record.state}</span>
        <span>v{record.version}</span>
      </div>
      <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm">{record.state === 'active' ? record.text || '（空）' : '正文已隐藏。'}</p>

      <Definition
        rows={[
          ['保存时间', new Date(record.createdAt).toLocaleString('zh-CN')],
          ['形成方式', record.origin === 'conversation' ? '来自对话' : record.origin === 'manual' ? '人工纠正' : '自动维护'],
        ]}
      />

      <div className="space-y-2 text-xs">
        <p className="font-semibold text-ink-500">引用来源</p>
        {record.sources.length ? (
          <div className="flex flex-wrap gap-2">
            {record.sources.map(source => (
              <button key={source.id} className="rounded-xl border border-slate-200 px-3 py-1.5 text-aika-600" onClick={() => onLocate(source.id, source.version)}>
                {source.id} · v{source.version}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-ink-400">无来源引用</p>
        )}
        <p className="font-semibold text-ink-500">关联记录</p>
        {item.relatedIds.length ? (
          <div className="flex flex-wrap gap-2">
            {item.relatedIds.map(id => (
              <button key={id} className="rounded-xl border border-slate-200 px-3 py-1.5 text-aika-600" onClick={() => onLocate(id)}>
                {id}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-ink-400">未提供关联记录</p>
        )}
      </div>

      {dynamics ? (
        <details className="text-xs" open>
          <summary className="cursor-pointer font-semibold text-ink-500">记忆变化详情</summary>
          <div className="mt-2 space-y-2">
            <p>
              鲜活度 {pct(dynamics.activation)} · 情绪影响 {emotion?.status === 'observed' ? pct(dynamics.emotion) : '未观测'}
            </p>
            <Definition
              rows={[
                ['记忆性质', dynamics.traits.category === 'event' ? '事件记忆' : dynamics.traits.category === 'stable_profile' ? '稳定人物事实' : '尚未评估'],
                ['重要性', String(dynamics.traits.importance)],
                ['当前淡化周期', dynamics.halfLifeDays === null ? '不按事件周期淡化' : `${dynamics.halfLifeDays} 天`],
                ['评估时点', new Date(dynamics.evaluatedAt).toLocaleString('zh-CN')],
                ['演化起点', new Date(dynamics.anchorAt).toLocaleString('zh-CN')],
                ['策略版本', String(dynamics.policyRevision)],
                ['最近有效强化日', dynamics.lastReinforcedDay || '尚无强化记录'],
                ['同源记录', dynamics.lineageIds.join('\n') || '未提供'],
              ]}
            />
            <p className="text-ink-500">
              情绪证据：
              {emotion?.status === 'observed' ? `有强度观测 ${pct(emotion.intensity ?? NaN)}` : emotion?.status === 'invalid' ? '情绪信息无效' : '暂无有效情绪信息'}
            </p>
          </div>
        </details>
      ) : (
        <Notice>该内容没有记忆动态评估；不把缺失数据解释为鲜活度或情绪为零。</Notice>
      )}

      {record.kind === 'memory' && (record.state === 'active' || record.state === 'deleted') && (
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <Field label="处理原因" value={reason} onChange={onReason} placeholder="说明遗忘或恢复的原因" disabled={busy} />
          {record.state === 'active' ? (
            confirmingForget ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                <p>遗忘后，这条内容和相关检索记录将不再用于对话。相关内容共享来源时可能无法处理，请以服务端结果为准。</p>
                <div className="mt-3 flex gap-2">
                  <button className="rounded-xl bg-rose-500 px-4 py-2 text-white disabled:opacity-40" disabled={busy} onClick={onForget}>
                    {busy ? '正在遗忘…' : '确认遗忘'}
                  </button>
                  <button className="rounded-xl border border-rose-200 px-4 py-2" disabled={busy} onClick={() => onConfirmForget(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="rounded-2xl border border-rose-200 px-4 py-2 text-sm text-rose-600 disabled:opacity-40"
                disabled={busy || !reason.trim()}
                onClick={() => onConfirmForget(true)}
              >
                遗忘这条内容
              </button>
            )
          ) : (
            <button className="rounded-2xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-40" disabled={busy || !reason.trim()} onClick={onRestore}>
              {busy ? '正在处理…' : '恢复这条内容'}
            </button>
          )}
          <p className="text-xs text-ink-400">遗忘与恢复都需要填写原因；恢复只对仍在保留期内的内容有效。</p>
        </div>
      )}
    </>
  )
}

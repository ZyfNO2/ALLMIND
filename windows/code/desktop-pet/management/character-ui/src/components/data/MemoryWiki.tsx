/**
 * 知识 Wiki：用户事实 / 待审候选 / 角色原作 Canon / 陪伴知识域。
 *
 * 四类数据必须保持分离（LUI-03 AC）：
 *  - 用户事实：`POST /api/continuity/snapshot`（`includeCandidates: true`）返回的 soul/wiki/relationship 中
 *    `status === 'active'` 的条目。它们来自真实互动，可纠正、可遗忘。
 *  - 待审候选：同一快照的 `candidates`（`status === 'candidate'`）。未晋升前**不**混进用户事实池。
 *  - 角色原作 Canon：`GET /api/prompt` + `GET /api/characters/profile`。这是作者虚构设定，只读，
 *    既不显示为用户事实，也不写入用户记忆。
 *  - 陪伴知识域：`GET /api/companion/knowledge` 声明的四个域（reference / personalCandidates /
 *    recentActivity / characterCanon）由服务端分别归属；本页只按域展示，不把它们合并成一个列表。
 *
 * Raw Trace（请求/响应/耗时/Token）不属于本页，只在 Trace 页出现。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import {
  isAbort,
  pairingFor,
  readCompanionActivities,
  readCompanionKnowledgeDomains,
  readCompanionSources,
  readCompanionSummary,
  readContinuity,
  readProfile,
  readPrompt,
  readRunningPairing,
  type ContinuitySnapshot,
  type PairingScope,
} from './client'
import { correctContinuity, forgetContinuity, OperationIds, promoteContinuity } from './actions'
import { Definition, Field, ReadState } from './Panel'

type Domain = 'user' | 'candidates' | 'canon' | 'companion'

const LAYER_LABELS: Record<string, string> = {
  user_soul: '用户底色',
  user_wiki: '用户 Wiki',
  relationship: '关系事实',
}

export default function MemoryWiki({ characterId, initialDomain = 'user' }: { characterId: string; initialDomain?: Domain }) {
  const [domain, setDomain] = useState<Domain>(initialDomain)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [editText, setEditText] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [conflict, setConflict] = useState('')
  const operations = useRef(new OperationIds())

  // --- 配对：运行角色沿用服务端配对，被浏览的其他角色派生自己的实例 ---
  const [pairing, setPairing] = useState<PairingScope | null>(null)
  const [pairingError, setPairingError] = useState('')

  const [snapshot, setSnapshot] = useState<ContinuitySnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [settled, setSettled] = useState(false)
  const [nonce, setNonce] = useState(0)

  const [canon, setCanon] = useState<{ prompt: { revision: number; text: string }; profile: Record<string, any> } | null>(null)
  const [canonError, setCanonError] = useState('')

  const [companion, setCompanion] = useState<Record<string, any> | null>(null)
  const [companionError, setCompanionError] = useState('')

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
        // 配对读取失败时仍然用角色派生配对展示只读内容，但禁止写入（见 pairingReady）。
        setPairing(pairingFor(characterId, null))
      })
    return () => {
      alive = false
    }
  }, [characterId])

  useEffect(() => {
    if (!pairing) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    setError('')
    readContinuity(runtime.request, pairing, true, current.signal)
      .then(value => {
        if (current.signal.aborted) return
        setSnapshot(value)
        setSettled(true)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        setSnapshot(null)
        setError((error as Error).message || '读取知识 Wiki 失败')
        setSettled(true)
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false)
      })
    return () => current.abort()
  }, [pairing, nonce])

  useEffect(() => {
    const current = new AbortController()
    setCanonError('')
    Promise.all([readPrompt(runtime.request, characterId, current.signal), readProfile(runtime.request, characterId, current.signal)])
      .then(([prompt, profile]) => {
        if (!current.signal.aborted) setCanon({ prompt, profile })
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        setCanon(null)
        setCanonError((error as Error).message || '读取角色原作设定失败')
      })
    return () => current.abort()
  }, [characterId])

  useEffect(() => {
    const current = new AbortController()
    setCompanionError('')
    Promise.allSettled([
      readCompanionKnowledgeDomains(runtime.request, current.signal),
      readCompanionSources(runtime.request, current.signal),
      readCompanionActivities(runtime.request, { limit: 50 }, current.signal),
      readCompanionSummary(runtime.request, {}, current.signal),
    ]).then(results => {
      if (current.signal.aborted) return
      const [domains, sources, activities, summary] = results
      const failures = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason?.message ?? '读取失败')
      setCompanion({
        domains: domains.status === 'fulfilled' ? domains.value : null,
        sources: sources.status === 'fulfilled' ? sources.value : null,
        activities: activities.status === 'fulfilled' ? activities.value : null,
        summary: summary.status === 'fulfilled' ? summary.value : null,
      })
      setCompanionError(failures.join('；'))
    })
    return () => current.abort()
  }, [nonce])

  useEffect(() => {
    setSelectedId('')
    setEditText('')
    setReason('')
    setMessage('')
    setActionError('')
    setConflict('')
    operations.current.clear()
  }, [characterId, domain])

  const userFacts = useMemo(
    () => [...(snapshot?.soul ?? []), ...(snapshot?.wiki ?? []), ...(snapshot?.relationship ?? [])].filter(fact => fact.status === 'active'),
    [snapshot],
  )
  const candidates = useMemo(() => (snapshot?.candidates ?? []).filter(fact => fact.status === 'candidate'), [snapshot])

  const pool = domain === 'user' ? userFacts : domain === 'candidates' ? candidates : []
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return pool
    return pool.filter(fact => fact.text.toLowerCase().includes(needle) || fact.kind.toLowerCase().includes(needle) || fact.origin.toLowerCase().includes(needle))
  }, [pool, search])
  const selected = pool.find(fact => fact.id === selectedId) ?? null

  useEffect(() => {
    if (selected) setEditText(selected.text)
  }, [selected])

  /** 配对读取失败时不允许写入：宁可显示只读，也不对不确定的配对域发起变更。 */
  const writable = !!pairing && !pairingError

  async function apply(outcome: Promise<{ ok: boolean; conflict?: boolean; message?: string }>, success: string) {
    setBusy(true)
    setMessage('')
    setActionError('')
    setConflict('')
    const result = await outcome
    setBusy(false)
    if (result.ok) {
      setMessage(success)
      setNonce(value => value + 1)
      return
    }
    if (result.conflict) {
      setConflict(result.message ?? '版本已变化。')
      return
    }
    setActionError(result.message ?? '操作未完成。')
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['user', `用户事实 (${userFacts.length})`],
            ['candidates', `待审候选 (${candidates.length})`],
            ['canon', '角色原作 Canon'],
            ['companion', '陪伴知识域'],
          ] as [Domain, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setDomain(id)}
            className={`rounded-2xl px-5 py-2 text-sm ${domain === id ? 'bg-aika-500 text-white' : 'bg-white text-ink-500'}`}
          >
            {label}
          </button>
        ))}
        <button className="rounded-2xl border border-slate-200 px-4 py-2 text-sm" onClick={() => setNonce(value => value + 1)}>
          刷新
        </button>
      </div>

      <Notice>
        用户事实、待审候选、角色原作 Canon 与陪伴知识域是四类不同数据：Canon 是作者虚构设定，不代表用户；候选未晋升前不计入用户事实；
        请求/响应等 Raw Trace 只在 Trace 页出现。
      </Notice>
      {pairingError && <Notice>运行配对读取失败：{pairingError}。当前为只读，不发起任何写入。</Notice>}
      {message && <Notice>{message}</Notice>}
      {actionError && <Notice>{actionError}</Notice>}
      {conflict && <Notice>{conflict}草稿已保留，未覆盖你的输入。</Notice>}

      {domain === 'canon' ? (
        <CanonPanel canon={canon} error={canonError} characterId={characterId} />
      ) : domain === 'companion' ? (
        <CompanionPanel data={companion} error={companionError} />
      ) : (
        <div className="grid grid-cols-[1fr_420px] gap-6">
          <section className="card space-y-4 p-6">
            <input
              aria-label="搜索知识"
              className="soft-input"
              placeholder="按正文、类别或来源搜索"
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
            <ReadState
              loading={loading}
              error={error}
              settled={settled}
              count={filtered.length}
              emptyText={domain === 'user' ? '暂无已存条目。' : '当前没有待审候选。'}
              onRetry={() => setNonce(value => value + 1)}
            >
              <div className="space-y-2">
                {filtered.map(fact => (
                  <button
                    key={fact.id}
                    onClick={() => {
                      setSelectedId(fact.id)
                      setReason('')
                      setMessage('')
                      setActionError('')
                      setConflict('')
                    }}
                    className={`block w-full rounded-2xl border p-4 text-left transition ${
                      selectedId === fact.id ? 'border-aika-300 bg-aika-50' : 'border-slate-100 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                      <span className="chip bg-slate-100 text-slate-600">{LAYER_LABELS[fact.layer] ?? fact.layer}</span>
                      <span className="chip bg-amber-50 text-amber-600">{fact.status === 'candidate' ? '待审候选' : '已生效'}</span>
                      <span>v{fact.version}</span>
                      <span>{fact.updatedAt ? new Date(fact.updatedAt).toLocaleString('zh-CN') : '更新时间未提供'}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-ink-700">{fact.text}</p>
                  </button>
                ))}
              </div>
            </ReadState>
          </section>

          <section className="card space-y-4 p-6">
            {!selected ? (
              <p className="text-sm text-ink-400">选择一条查看来源、版本，并进行晋升 / 纠正 / 遗忘。</p>
            ) : (
              <>
                <h2 className="text-base font-bold">{selected.status === 'candidate' ? '候选详情' : '事实详情'}</h2>
                <Definition
                  rows={[
                    ['标识', <span className="font-mono">{selected.id}</span>],
                    ['层级', LAYER_LABELS[selected.layer] ?? selected.layer],
                    ['类别', selected.kind],
                    ['状态', selected.status],
                    ['来源方式', selected.origin],
                    ['版本', String(selected.version)],
                    ['首次记录', selected.createdAt ? new Date(selected.createdAt).toLocaleString('zh-CN') : '未提供'],
                    ['最近更新', selected.updatedAt ? new Date(selected.updatedAt).toLocaleString('zh-CN') : '未提供'],
                    ['溯源凭据', selected.sourceIds.length ? selected.sourceIds.join('\n') : '暂无外部溯源引用'],
                    ['证据资格', selected.evidenceEligible ? '可作为证据' : '不可作为证据'],
                  ]}
                />
                <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm">{selected.text}</p>

                <Field label="处理原因" value={reason} onChange={setReason} placeholder="说明纠正或遗忘的原因" disabled={busy} />

                {selected.status === 'candidate' && (
                  <div className="flex flex-wrap gap-3">
                    <button
                      className="rounded-2xl bg-aika-500 px-5 py-2 text-sm text-white disabled:opacity-40"
                      disabled={busy || !writable}
                      onClick={() =>
                        apply(
                          promoteContinuity(runtime.request, operations.current, {
                            pairing: pairing!,
                            targetId: selected.id,
                            expectedVersion: selected.version,
                            reason,
                          }),
                          '候选已晋升为正式用户事实。',
                        )
                      }
                    >
                      {busy ? '正在处理…' : '审核通过并晋升'}
                    </button>
                    <button
                      className="rounded-2xl border border-rose-200 px-4 py-2 text-sm text-rose-600 disabled:opacity-40"
                      disabled={busy || !writable || !reason.trim()}
                      onClick={() =>
                        apply(
                          forgetContinuity(runtime.request, operations.current, {
                            pairing: pairing!,
                            targetId: selected.id,
                            expectedVersion: selected.version,
                            reason,
                          }),
                          '候选已丢弃。',
                        )
                      }
                    >
                      丢弃这条候选
                    </button>
                  </div>
                )}

                {selected.status === 'active' && (
                  <div className="space-y-3">
                    <Field label="纠正后的正文" value={editText} onChange={setEditText} multiline disabled={busy} />
                    <div className="flex flex-wrap gap-3">
                      <button
                        className="rounded-2xl bg-aika-500 px-5 py-2 text-sm text-white disabled:opacity-40"
                        disabled={busy || !writable || !editText.trim() || !reason.trim() || editText === selected.text}
                        onClick={() =>
                          apply(
                            correctContinuity(runtime.request, operations.current, {
                              pairing: pairing!,
                              targetId: selected.id,
                              expectedVersion: selected.version,
                              reason,
                              text: editText,
                              sourceIds: selected.sourceIds,
                            }),
                            '条目已纠正。',
                          )
                        }
                      >
                        {busy ? '正在保存…' : '保存纠正'}
                      </button>
                      <button
                        className="rounded-2xl border border-rose-200 px-4 py-2 text-sm text-rose-600 disabled:opacity-40"
                        disabled={busy || !writable || !reason.trim()}
                        onClick={() =>
                          apply(
                            forgetContinuity(runtime.request, operations.current, {
                              pairing: pairing!,
                              targetId: selected.id,
                              expectedVersion: selected.version,
                              reason,
                            }),
                            '条目已遗忘。',
                          )
                        }
                      >
                        {busy ? '正在处理…' : '遗忘这条事实'}
                      </button>
                    </div>
                    <p className="text-xs text-ink-400">
                      纠正与遗忘都需要填写原因并携带当前版本；被遗忘的内容不会因为新界面而恢复。
                    </p>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function CanonPanel({
  canon,
  error,
  characterId,
}: {
  canon: { prompt: { revision: number; text: string }; profile: Record<string, any> } | null
  error: string
  characterId: string
}) {
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700" role="alert">
        <p className="font-semibold">读取角色原作设定失败</p>
        <p className="mt-1">{error}</p>
        <p className="mt-1 text-xs">失败不等于设定为空。</p>
      </div>
    )
  }
  if (!canon) return <Notice>正在读取角色原作设定…</Notice>
  const persona = canon.profile.persona ?? {}
  return (
    <section className="card space-y-4 p-6">
      <h2 className="text-base font-bold">角色原作 Canon（作者虚构设定，只读）</h2>
      <Notice>
        以下内容来自角色资料与完整人格设定，是作者编写的虚构设定，不是用户事实，也不会写进用户记忆。故事书作者配置在
        <Link className="mx-1 text-aika-600" to={`/characters/${characterId}/config?tab=lorebook`}>
          角色配置 · 故事书
        </Link>
        中编辑。
      </Notice>
      <Definition
        rows={[
          ['人格设定修订', String(canon.prompt.revision)],
          ['字段修订', String(canon.profile.fieldRevision ?? '未提供')],
        ]}
      />
      <div>
        <h3 className="mb-2 text-sm font-semibold">完整人格设定</h3>
        <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-xs text-ink-700">
          {canon.prompt.text || '（空）'}
        </pre>
      </div>
      <div className="grid grid-cols-2 gap-4 text-xs">
        {(
          [
            ['简介', canon.profile.identity?.intro],
            ['背景与情境', persona.scenario],
            ['开场白（仅展示）', persona.firstMessage],
            ['示例对话', persona.exampleDialogue],
          ] as [string, string | undefined][]
        ).map(([label, value]) => (
          <div key={label}>
            <p className="mb-1 font-semibold text-ink-500">{label}</p>
            <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-3 text-ink-700">{value || '尚未填写'}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function CompanionPanel({ data, error }: { data: Record<string, any> | null; error: string }) {
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700" role="alert">
        <p className="font-semibold">部分陪伴知识读取失败</p>
        <p className="mt-1">{error}</p>
        <p className="mt-1 text-xs">读取失败的那部分不会显示为空结果。</p>
      </div>
    )
  }
  if (!data) return <Notice>正在读取陪伴知识域…</Notice>
  const domains = data.domains?.domains ?? null
  const sources = data.sources
  const activities = data.activities
  const summary = data.summary
  return (
    <div className="space-y-5">
      <section className="card space-y-3 p-6">
        <h2 className="text-base font-bold">知识域归属</h2>
        <p className="text-xs text-ink-400">服务端按域分别归属；本页不把它们合并成一个列表。</p>
        {domains ? (
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(domains as Record<string, { owner: string; note: string }>).map(([key, value]) => (
              <div key={key} className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm font-semibold text-ink-800">{key}</p>
                <p className="mt-1 text-xs text-ink-500">归属：{value.owner}</p>
                <p className="mt-1 text-xs text-ink-500">{value.note}</p>
              </div>
            ))}
          </div>
        ) : (
          <Notice>服务未返回知识域归属；不显示为“没有知识”。</Notice>
        )}
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-base font-bold">正文来源</h2>
        {sources?.available === false ? (
          <Notice>正文来源管理未接入：{sources.reason === 'not_wired' ? '当前运行实例未装配' : sources.reason}</Notice>
        ) : sources ? (
          <div className="space-y-2">
            {(sources.sources ?? []).map((source: any) => (
              <div key={source.kind} className="rounded-2xl bg-slate-50 p-3 text-xs">
                <p className="font-semibold text-ink-800">{source.kind}</p>
                <p className="mt-1 text-ink-500">{source.note || source.detail || '服务未提供说明'}</p>
              </div>
            ))}
            {(sources.sources ?? []).length === 0 && <p className="text-xs text-ink-400">服务返回的来源列表为空。</p>}
          </div>
        ) : (
          <Notice>未取得正文来源能力矩阵。</Notice>
        )}
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-base font-bold">近期活动</h2>
        <p className="text-xs text-ink-400">发生时间与记录时间是分开的字段；这里同时显示，不把记录时间当成发生时间。</p>
        {activities?.events?.length ? (
          <div className="space-y-2">
            {activities.events.map((event: any) => (
              <div key={event.eventId} className="rounded-2xl bg-slate-50 p-3 text-xs">
                <p className="font-semibold text-ink-800">{event.claim || event.subject || event.eventId}</p>
                <p className="mt-1 text-ink-500">
                  发生 {event.occurredAt}（依据 {event.occurredAtBasis}） · 记录 {event.receivedAt}
                </p>
                <p className="mt-1 text-ink-500">
                  状态 {event.status}
                  {event.reason ? ` · ${event.reason}` : ''}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-400">{activities ? '这一天没有已记录的活动。' : '未取得活动数据。'}</p>
        )}
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-base font-bold">日摘要状态</h2>
        {summary ? (
          <Definition
            rows={[
              ['本地日期', summary.localDate],
              ['状态', summary.status],
              ['事件数', String(summary.eventCount)],
              ['交付状态', String(summary.delivered)],
              ['仅记录时间', summary.recordedTimeOnly ? '是（发生时间未知）' : '否'],
            ]}
          />
        ) : (
          <Notice>未取得日摘要。</Notice>
        )}
      </section>
    </div>
  )
}

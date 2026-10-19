/**
 * 导入旧聊天（`?tab=import`）。
 *
 * 端点：`GET /api/memory-import?characterId=&userId=&characterInstanceId=`、
 * `POST /api/memory-import/{start,pause,resume}`。
 *
 * 契约要点：
 *  - `instanceId` / `operationId` / `expectedRevision` 全部保留；同一来源的重试复用同一个 operationId。
 *  - 结果不确定（超时、断连、5xx）**不自动重发**；页面显示「尚未确认」，由用户显式再点一次。
 *  - 读取失败显示为「进度可能已过期」，并停用操作，不显示成 0 个任务。
 *  - 费用是本地估算账，不是服务商账单；未知费用调用不按 0 计入。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import { isAbort, pairingFor, readMemoryImport, readRunningPairing, type ImportJob, type PairingScope } from './client'
import { localPathProblem, OperationIds, pauseImport, resumeImport, startImport } from './actions'
import { Definition, Field, ReadState } from './Panel'

const STATUS_LABELS: Record<ImportJob['status'], string> = {
  discovering: '正在发现聊天',
  running: '正在整理记忆',
  paused: '已暂停',
  failed: '未完成',
  completed: '已完成',
}

const FAILURE_LABELS: Record<string, string> = {
  invalid_request: '导入信息无效，请检查项目名称和本机位置。',
  invalid_state: '任务状态已变化，请刷新后核对。',
  version_conflict: '任务已在其他位置变化，请按最新进度操作。',
  source_changed: '原始来源已变化，请核对来源后再操作。',
  source_unavailable: '无法读取指定来源，请检查本机位置和读取权限。',
  unsupported_export: '导出格式不受支持，请按页面说明准备文件。',
  ambiguous_project: '项目匹配不唯一，请填写准确的项目位置。',
  invalid_source_entry: '来源条目的日期、说话人或正文格式无效。',
  provider_failed: '记忆整理服务未完成请求，可稍后继续。',
  provider_timeout: '记忆整理超时，可稍后继续。',
  commit_conflict: '记忆记录已变化，可刷新后继续。',
  unavailable: '旧聊天导入暂不可用，请稍后刷新。',
  budget_exceeded: '当前费用配置不允许继续，请检查模型与费用设置。',
}

const money = (value: number | null): string =>
  value === null ? '尚不能估算' : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value / 1e6)} 元`

export default function MemoryImport({ characterId }: { characterId: string }) {
  const [pairing, setPairing] = useState<PairingScope | null>(null)
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof readMemoryImport>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [settled, setSettled] = useState(false)
  const [stale, setStale] = useState(false)
  const [nonce, setNonce] = useState(0)

  const [kind, setKind] = useState<'codex-project' | 'text-export'>('codex-project')
  const [projectName, setProjectName] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [uncertain, setUncertain] = useState('')

  const operations = useRef(new OperationIds())
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    readRunningPairing(runtime.request)
      .then(running => {
        if (alive) setPairing(pairingFor(characterId, running))
      })
      .catch(error => {
        if (!alive || isAbort(error)) return
        setPairing(pairingFor(characterId, null))
        setActionError(`运行配对读取失败：${(error as Error).message}。导入状态按角色派生配对读取，写入仍以服务端实例为准。`)
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
    readMemoryImport(runtime.request, characterId, pairing, current.signal)
      .then(value => {
        if (current.signal.aborted) return
        setSnapshot(value)
        setStale(false)
        setSettled(true)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        // 读失败：保留上一次快照但标记过期，并停用写操作。
        setStale(true)
        setError(`暂时无法核对导入状态：${(error as Error).message || '读取失败'}`)
        setSettled(true)
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false)
      })
    return () => current.abort()
  }, [characterId, pairing, nonce])

  useEffect(() => {
    setMessage('')
    setActionError('')
    setUncertain('')
    operations.current.clear()
  }, [characterId])

  const writable = !!snapshot && !stale && !busy

  const duplicate = useMemo(
    () =>
      snapshot?.jobs.some(
        job => job.source.kind === kind && job.source.projectName === projectName.trim() && job.source.path === path.trim()
          && ['discovering', 'running', 'paused', 'failed'].includes(job.status),
      ) ?? false,
    [snapshot, kind, projectName, path],
  )

  const pathProblem = localPathProblem(path)

  async function act(outcome: Promise<{ ok: boolean; conflict?: boolean; message?: string }>, success: string) {
    setBusy(true)
    setMessage('')
    setActionError('')
    setUncertain('')
    const result = await outcome
    setBusy(false)
    if (result.ok) {
      setMessage(success)
      setNonce(value => value + 1)
      return
    }
    if (result.conflict) {
      setStale(true)
      setActionError(`${result.message ?? '版本冲突'}已标记为过期，请刷新后核对。`)
      return
    }
    // 结果不确定：不自动重发，提示用户显式重试。
    setUncertain(`${result.message ?? '操作结果尚未确认'} 不会自动重发；确认状态后可用同一请求再试一次。`)
    setNonce(value => value + 1)
  }

  return (
    <div className="space-y-5">
      <section className="card space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold">导入旧聊天</h2>
            <p className="mt-1 text-sm text-ink-500">把过去与陪伴 AI 的聊天整理为长期记忆。导入期间可以继续聊天。</p>
          </div>
          <button className="rounded-2xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-40" disabled={loading} onClick={() => setNonce(value => value + 1)}>
            刷新导入进度
          </button>
        </div>

        {error && <Notice>{error}操作已停用，避免在过期进度上继续。</Notice>}
        {message && <Notice>{message}</Notice>}
        {actionError && <Notice>{actionError}</Notice>}
        {uncertain && <Notice>{uncertain}</Notice>}

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-500">聊天来源</span>
            <select aria-label="聊天来源" className="soft-input" value={kind} disabled={busy} onChange={event => setKind(event.target.value as 'codex-project' | 'text-export')}>
              <option value="codex-project">本机 Codex 项目</option>
              <option value="text-export">聊天文本导出（JSONL）</option>
            </select>
          </label>
          <Field label="旧 AI 项目名称" value={projectName} onChange={setProjectName} disabled={busy} placeholder="1–200 字符" />
          <Field
            label={kind === 'codex-project' ? '本机项目目录（绝对路径）' : '本机导出文件（绝对路径）'}
            value={path}
            onChange={setPath}
            disabled={busy}
            placeholder="例如 C:\\Users\\me\\project"
          />
        </div>

        <p className="text-xs text-ink-400">
          {kind === 'codex-project' ? '按这个项目目录精确匹配本机 Codex 对话，不扫描其他项目。' : '只接受页面说明支持的导出格式。'}
        </p>
        {path && pathProblem && <Notice>{pathProblem}</Notice>}

        {snapshot ? (
          <p className="text-xs text-ink-500">
            整理模型：{snapshot.configuration.model} ·{' '}
            {snapshot.configuration.budgetMode === 'unlimited' ? '不设本地费用上限，持续记账' : `当前费用上限 ${money(snapshot.configuration.limitMicros)}`}
          </p>
        ) : (
          <Notice>正在读取模型与费用配置；读取成功前不能开始导入。</Notice>
        )}
        {duplicate && <Notice>同一来源已有未完成导入，请在下方查看进度或继续处理。</Notice>}

        <button
          className="rounded-2xl bg-aika-500 px-5 py-2 text-sm text-white disabled:opacity-40"
          disabled={!writable || !projectName.trim() || !!pathProblem || duplicate}
          onClick={() =>
            act(
              startImport(runtime.request, operations.current, {
                instanceId: snapshot!.instanceId,
                characterId,
                pairing: pairing!,
                source: { kind, projectName: projectName.trim(), path: path.trim() },
              }),
              '导入任务已建立，可离开此页，后台会继续处理。',
            )
          }
        >
          {busy ? '正在提交…' : '开始后台导入'}
        </button>
        <p className="text-xs text-ink-400">发现聊天后显示预计费用；实际费用以服务商账单为准。</p>
      </section>

      <section className="card space-y-4 p-6">
        <h2 className="text-base font-bold">导入记录</h2>
        <ReadState
          loading={loading}
          error=""
          settled={settled}
          count={snapshot ? snapshot.jobs.length : null}
          emptyText="尚未开始导入。"
        >
          <div className="space-y-4">
            {snapshot?.jobs.map(job => {
              const running = job.status === 'discovering' || job.status === 'running'
              return (
                <article key={job.id} className="rounded-2xl border border-slate-100 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-bold text-ink-800">{job.source.projectName}</h3>
                    <span className="chip bg-slate-100 text-slate-600">{STATUS_LABELS[job.status]}</span>
                  </div>
                  <p className="mt-1 text-xs text-ink-400">
                    {job.source.kind === 'codex-project' ? '本机 Codex 项目' : '聊天文本导出'} · {job.source.path}
                  </p>
                  {job.status === 'discovering' ? (
                    <p className="mt-2 text-xs text-ink-500">正在只读发现指定来源，数量和费用估算会随进度更新。</p>
                  ) : (
                    <progress className="mt-2 w-full" max={Math.max(1, job.totalBatches)} value={job.completedBatches} aria-label="已完成批次" />
                  )}
                  <div className="mt-3 grid grid-cols-4 gap-3 text-xs">
                    {(
                      [
                        ['发现消息', job.discoveredMessages],
                        ['处理消息', job.processedMessages],
                        ['去重跳过', job.skippedMessages],
                        ['写入记忆', job.importedMemories],
                      ] as [string, number][]
                    ).map(([label, value]) => (
                      <div key={label} className="rounded-xl bg-slate-50 p-2 text-center">
                        <p className="text-sm font-bold">{value}</p>
                        <p className="text-ink-400">{label}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-ink-500">
                    批次 {job.completedBatches} / {job.totalBatches} · 预计调用 {job.estimatedCalls} 次 · 已调用 {job.actualCalls} 次
                  </p>
                  <div className="mt-3">
                    <Definition
                      rows={[
                        ['预计费用', money(job.estimatedMicros)],
                        ['本地估算账', money(job.accountedMicros)],
                        ['费用未知', `${job.unknownCostCalls} 次调用，未按零计入`],
                        ['更新于', job.updatedAt ? new Date(job.updatedAt).toLocaleString('zh-CN') : '未提供'],
                      ]}
                    />
                  </div>
                  {job.failures.length > 0 && (
                    <Notice>{[...new Set(job.failures.map(failure => FAILURE_LABELS[failure.code] ?? '部分内容未处理完成，请检查来源或稍后继续。'))].join(' ')}</Notice>
                  )}
                  {job.status !== 'completed' && (
                    <button
                      className="mt-3 rounded-2xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-40"
                      disabled={!writable}
                      onClick={() =>
                        act(
                          running
                            ? pauseImport(runtime.request, { instanceId: snapshot!.instanceId, characterId, pairing: pairing!, jobId: job.id, expectedRevision: job.revision })
                            : resumeImport(runtime.request, { instanceId: snapshot!.instanceId, characterId, pairing: pairing!, jobId: job.id, expectedRevision: job.revision }),
                          '操作已返回，请以任务最新状态为准。',
                        )
                      }
                    >
                      {running ? '暂停导入' : '继续导入'}
                    </button>
                  )}
                </article>
              )
            })}
          </div>
        </ReadState>
      </section>
    </div>
  )
}

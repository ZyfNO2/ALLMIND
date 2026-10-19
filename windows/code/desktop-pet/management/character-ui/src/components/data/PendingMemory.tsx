/**
 * 未完成的记忆请求：`GET /api/memory-pending`、`POST /api/memory-pending/{retry,cancel}`。
 *
 * 契约要点（对齐旧 `pending-memory-view.mjs` 的真实语义）：
 *  - 服务返回的 `instanceId` 与当前实例不一致时，整个面板视为不可信：不显示列表、不提供操作。
 *  - 重新处理会再次调用记忆模型并继续记账，因此必须显式确认后才发请求。
 *  - 撤销只解除临时隔离，不会恢复已经遗忘的内容；文案如实说明。
 *  - `busy` 时不允许重新处理（服务端同样会拒绝）。
 *  - 结果不确定不自动重发。
 */
import { useEffect, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import { isAbort, readPendingMemory, type PendingRequest } from './client'
import { cancelPending, retryPending } from './actions'
import { ReadState } from './Panel'

const INTENT_LABELS: Record<string, string> = {
  forget: '遗忘请求',
  correction: '个人资料修改',
  uncertain: '待确认的记忆请求',
}

export default function PendingMemory() {
  const [data, setData] = useState<{ instanceId: string; requests: PendingRequest[]; busy: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [settled, setSettled] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [confirming, setConfirming] = useState<{ action: 'retry' | 'cancel'; request: PendingRequest } | null>(null)
  const controller = useRef<AbortController | null>(null)

  const [instanceId, setInstanceId] = useState('')
  const [instanceError, setInstanceError] = useState('')

  useEffect(() => {
    let alive = true
    runtime
      .request('/api/snapshot')
      .then(snapshot => {
        if (alive) setInstanceId(snapshot?.runtime?.instanceId ?? '')
      })
      .catch(error => {
        if (!alive || isAbort(error)) return
        setInstanceError((error as Error).message || '读取当前实例失败')
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    setError('')
    readPendingMemory(runtime.request, current.signal)
      .then(value => {
        if (current.signal.aborted) return
        setData(value)
        setSettled(true)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        setData(null)
        setError((error as Error).message || '读取未完成请求失败')
        setSettled(true)
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false)
      })
    return () => current.abort()
  }, [nonce])

  // 实例不匹配：服务可能已经重启，此时列表和操作都不可信。
  const trusted = !!data && !!instanceId && data.instanceId === instanceId && !instanceError

  async function act(action: 'retry' | 'cancel', request: PendingRequest) {
    setBusy(true)
    setMessage('')
    setActionError('')
    const outcome = action === 'retry' ? await retryPending(runtime.request, { instanceId: data!.instanceId, id: request.id }) : await cancelPending(runtime.request, { instanceId: data!.instanceId, id: request.id })
    setBusy(false)
    if (outcome.ok) {
      setMessage(action === 'retry' ? '重新处理已排队；费用会继续记录。' : '未完成请求已撤销。')
    } else {
      setActionError(outcome.message ?? '操作未完成。')
    }
    setNonce(value => value + 1)
  }

  return (
    <section className="card space-y-4 p-6" aria-label="未完成的记忆请求">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-bold">未完成的记忆请求</h2>
        <button className="rounded-2xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-40" disabled={loading || busy} onClick={() => setNonce(value => value + 1)}>
          刷新请求
        </button>
      </div>

      {message && <Notice>{message}</Notice>}
      {actionError && <Notice>{actionError}</Notice>}
      {instanceError && <Notice>无法确认当前实例：{instanceError}。为避免误操作，下面不提供重新处理或撤销。</Notice>}
      {!instanceError && data && instanceId && data.instanceId !== instanceId && (
        <Notice>服务已经重启（实例 {data.instanceId} ≠ 当前 {instanceId}）。请刷新页面后核对未完成请求，这里不提供操作。</Notice>
      )}

      <ReadState loading={loading} error={error} settled={settled} count={trusted ? data!.requests.length : null} emptyText="当前没有未完成的记忆请求。" onRetry={() => setNonce(value => value + 1)}>
        <div className="space-y-3">
          <Notice>这些请求尚未完成。处理期间，已有个人资料暂不用于回复；聊天仍可继续。</Notice>
          {data?.requests.map(request => (
            <div key={request.id} className="rounded-2xl border border-slate-100 p-4">
              <p className="text-sm font-semibold text-ink-800">
                {INTENT_LABELS[request.intent] ?? '记忆请求'} · {request.status === 'failed' ? '上次未完成' : '待处理'}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-600">{request.preview}</p>
              {request.createdAt && <p className="mt-1 text-xs text-ink-400">{new Date(request.createdAt).toLocaleString('zh-CN')}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs disabled:opacity-40"
                  disabled={!trusted || busy || data!.busy}
                  onClick={() => {
                    setConfirming({ action: 'retry', request })
                    setMessage('')
                    setActionError('')
                  }}
                >
                  重新处理
                </button>
                <button
                  className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs disabled:opacity-40"
                  disabled={!trusted || busy}
                  onClick={() => {
                    setConfirming({ action: 'cancel', request })
                    setMessage('')
                    setActionError('')
                  }}
                >
                  撤销未完成请求
                </button>
              </div>
            </div>
          ))}
          {data?.busy && <p className="text-xs text-ink-400">后台还有任务，结束后可刷新并选择重新处理。</p>}
        </div>
      </ReadState>

      {confirming && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{confirming.action === 'retry' ? '重新处理这项请求？' : '撤销未完成请求？'}</p>
          <p className="mt-1">
            {confirming.action === 'retry'
              ? '重新处理会再次调用当前记忆模型，费用会继续记录。现在重新处理这项未完成请求？'
              : '撤销只解除这项未完成请求的临时隔离。尚未删除的个人资料可能重新用于回复；已经遗忘的内容不会恢复。确定撤销？'}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              className="rounded-xl bg-aika-500 px-4 py-2 text-white disabled:opacity-40"
              disabled={busy || !trusted}
              onClick={async () => {
                const target = confirming
                setConfirming(null)
                await act(target.action, target.request)
              }}
            >
              {confirming.action === 'retry' ? '重新处理' : '确认撤销'}
            </button>
            <button className="rounded-xl border border-amber-300 px-4 py-2" disabled={busy} onClick={() => setConfirming(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

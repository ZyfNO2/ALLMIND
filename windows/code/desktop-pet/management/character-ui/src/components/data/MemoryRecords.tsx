/**
 * 长期记忆 / 对话原文 / 摘要：真实分页、过滤、来源，以及纠正 / 遗忘 / 恢复。
 *
 * 端点：`GET /api/records`（kind/state/query/offset/limit/from/to）、
 * `POST /api/records/edit`、`POST /api/memory/forget`、`POST /api/memory/restore`。
 * 分页使用服务端 `offset` + `total`，本地不切片；`AbortController` 在参数变化与卸载时取消。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import {
  isAbort,
  readRecords,
  RECORD_KINDS,
  type ManagedRecord,
  type RecordKind,
  type RecordPage,
} from './client'
import { editRecord, forgetRecord, restoreRecord, OperationIds, type ActionOutcome } from './actions'
import { Confirm, Definition, Field, Pager, ReadState } from './Panel'

const PAGE_SIZE = 25

const STATE_LABELS: Record<ManagedRecord['state'], string> = {
  active: '有效',
  invalidated: '已失效',
  deleted: '已遗忘',
  expired: '已过期',
  purged: '已清理',
}

const ORIGIN_LABELS: Record<ManagedRecord['origin'], string> = {
  conversation: '来自对话',
  automatic: '自动维护',
  manual: '人工纠正',
}

export default function MemoryRecords({ characterId }: { characterId: string }) {
  const [kind, setKind] = useState<RecordKind>('memory')
  const [state, setState] = useState<'active' | 'all'>('active')
  const [draftQuery, setDraftQuery] = useState('')
  const [query, setQuery] = useState('')
  const [day, setDay] = useState('')
  const [offset, setOffset] = useState(0)

  const [page, setPage] = useState<RecordPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [settled, setSettled] = useState(false)
  const [nonce, setNonce] = useState(0)

  const [selectedId, setSelectedId] = useState('')
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [conflict, setConflict] = useState('')

  const operations = useRef(new OperationIds())
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    setError('')
    const from = day ? new Date(`${day}T00:00:00`).toISOString() : ''
    const to = day ? new Date(new Date(`${day}T00:00:00`).getTime() + 86_400_000).toISOString() : ''
    readRecords(runtime.request, characterId, { kind, state, query, offset, limit: PAGE_SIZE, ...(from ? { from, to } : {}) }, current.signal)
      .then(value => {
        if (current.signal.aborted) return
        setPage(value)
        setSettled(true)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        // 读失败保持 page=null：页面必须显示错误，不能显示成 0 条。
        setPage(null)
        setError((error as Error).message || '读取记录失败')
        setSettled(true)
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false)
      })
    return () => current.abort()
  }, [characterId, kind, state, query, offset, day, nonce])

  const selected = useMemo(() => page?.records.find(record => record.id === selectedId) ?? null, [page, selectedId])

  useEffect(() => {
    setSelectedId('')
    setText('')
    setReason('')
    setConflict('')
    setMessage('')
    setActionError('')
    operations.current.clear()
  }, [characterId])

  useEffect(() => {
    if (selected) setText(selected.text)
  }, [selected])

  const reload = () => setNonce(value => value + 1)

  async function apply(outcome: Promise<ActionOutcome>, success: (value: any) => string, refresh: () => void) {
    setBusy(true)
    setMessage('')
    setActionError('')
    setConflict('')
    const result = await outcome
    setBusy(false)
    if (result.ok) {
      setMessage(success(result.value))
      refresh()
      return
    }
    if (result.conflict) {
      // 409：保留用户草稿，提示刷新核对，不静默覆盖。
      setConflict(result.message)
      return
    }
    setActionError(result.message)
  }

  function refreshList() {
    reload()
  }

  return (
    <div className="grid grid-cols-[1fr_420px] gap-6">
      <section className="card space-y-4 p-6">
        <form
          className="grid grid-cols-2 gap-3"
          onSubmit={event => {
            event.preventDefault()
            setOffset(0)
            setQuery(draftQuery.trim())
          }}
        >
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-500">记录类别</span>
            <select
              aria-label="记录类别"
              className="soft-input"
              value={kind}
              onChange={event => {
                setKind(event.target.value as RecordKind)
                setOffset(0)
              }}
            >
              {RECORD_KINDS.map(item => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-500">保存状态</span>
            <select
              aria-label="保存状态"
              className="soft-input"
              value={state}
              onChange={event => {
                setState(event.target.value as 'active' | 'all')
                setOffset(0)
              }}
            >
              <option value="active">仅有效记录</option>
              <option value="all">包括已失效与已遗忘</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-500">搜索正文</span>
            <input
              aria-label="搜索正文"
              className="soft-input"
              value={draftQuery}
              maxLength={1000}
              placeholder="输入关键词"
              onChange={event => setDraftQuery(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-500">按日期筛选</span>
            <input
              aria-label="按日期筛选"
              type="date"
              className="soft-input"
              value={day}
              onChange={event => {
                setDay(event.target.value)
                setOffset(0)
              }}
            />
          </label>
          <div className="col-span-2 flex items-center gap-3">
            <button className="rounded-2xl bg-aika-500 px-5 py-2 text-sm text-white disabled:opacity-40" type="submit" disabled={loading}>
              查询
            </button>
            <button
              type="button"
              className="rounded-2xl border border-slate-200 px-4 py-2 text-sm"
              onClick={() => {
                setDraftQuery('')
                setQuery('')
                setDay('')
                setOffset(0)
                reload()
              }}
            >
              清除筛选
            </button>
            <span className="text-xs text-ink-400">筛选与分页都由服务端执行；这里的条数是真实 total。</span>
          </div>
        </form>

        {message && <Notice>{message}</Notice>}
        {actionError && <Notice>{actionError}</Notice>}
        {conflict && <Notice>{conflict}草稿已保留，未覆盖你的输入。</Notice>}

        <ReadState
          loading={loading}
          error={error}
          settled={settled}
          count={page ? page.records.length : null}
          emptyText="这个筛选条件下没有记录。"
          onRetry={reload}
        >
          <div className="space-y-2">
            {page?.records.map(record => (
              <button
                key={record.id}
                onClick={() => {
                  setSelectedId(record.id)
                  setMessage('')
                  setActionError('')
                  setConflict('')
                  setReason('')
                }}
                className={`block w-full rounded-2xl border p-4 text-left transition ${
                  selectedId === record.id ? 'border-aika-300 bg-aika-50' : 'border-slate-100 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-2 text-xs text-ink-400">
                  <span className="chip bg-slate-100 text-slate-600">{STATE_LABELS[record.state]}</span>
                  <span>v{record.version}</span>
                  <span>{new Date(record.createdAt).toLocaleString('zh-CN')}</span>
                  {record.role && <span>{record.role === 'user' ? '用户' : '角色'}</span>}
                </div>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-ink-700">
                  {record.state === 'active' ? record.text : `正文已隐藏（${STATE_LABELS[record.state]}）`}
                </p>
              </button>
            ))}
          </div>
          {page && (
            <Pager
              offset={page.offset}
              limit={page.limit}
              total={page.total}
              loaded={page.records.length}
              busy={loading}
              onPrevious={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              onNext={() => setOffset(offset + PAGE_SIZE)}
            />
          )}
        </ReadState>
      </section>

      <section className="card space-y-4 p-6">
        {!selected ? (
          <p className="text-sm text-ink-400">从左侧选择一条记录，查看正文、来源，并进行纠正或遗忘。</p>
        ) : (
          <>
            <h2 className="text-base font-bold">记录详情</h2>
            <Definition
              rows={[
                ['记录标识', <span className="font-mono">{selected.id}</span>],
                ['版本', String(selected.version)],
                ['状态', STATE_LABELS[selected.state]],
                ['形成方式', ORIGIN_LABELS[selected.origin]],
                [
                  '来源引用',
                  selected.sources.length
                    ? selected.sources.map(source => `${source.id} · v${source.version}`).join('\n')
                    : '无来源引用',
                ],
              ]}
            />

            {selected.state === 'active' && <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm">{selected.text}</p>}

            {selected.editable && selected.state === 'active' ? (
              <div className="space-y-3">
                <Field label="记录正文" value={text} onChange={setText} multiline disabled={busy} />
                <Field label="修改原因" value={reason} onChange={setReason} placeholder="说明需要纠正或遗忘的原因" disabled={busy} />
                <div className="flex flex-wrap gap-3">
                  <button
                    className="rounded-2xl bg-aika-500 px-5 py-2 text-sm text-white disabled:opacity-40"
                    disabled={busy || !text.trim() || !reason.trim() || text === selected.text}
                    onClick={() =>
                      apply(
                        editRecord(runtime.request, operations.current, {
                          characterId,
                          id: selected.id,
                          expectedVersion: selected.version,
                          text,
                          reason,
                        }),
                        value => `已保存纠正（记录修订 ${value.revision}）。`,
                        refreshList,
                      )
                    }
                  >
                    {busy ? '正在保存…' : '保存这条纠正'}
                  </button>
                  {selected.state === 'active' && (
                    <Confirm
                      label="遗忘这条记录"
                      question="遗忘后该记录不再用于对话上下文与检索；已遗忘的内容不会因为新界面而恢复。"
                      confirmLabel="确认遗忘"
                      busy={busy}
                      disabled={busy || !reason.trim()}
                      onConfirm={() =>
                        apply(
                          forgetRecord(runtime.request, operations.current, {
                            characterId,
                            id: selected.id,
                            expectedVersion: selected.version,
                            reason,
                          }),
                          value => `遗忘已确认，服务报告 ${value.affectedIds.length} 条记录受影响。`,
                          refreshList,
                        )
                      }
                    />
                  )}
                </div>
                {!reason.trim() && <p className="text-xs text-ink-400">纠正与遗忘都需要填写原因，服务端同样要求非空。</p>}
              </div>
            ) : (
              <Notice>
                {selected.state === 'deleted'
                  ? '这条记录已被遗忘；恢复只对仍在保留期内、来源未被清理的记录有效。'
                  : selected.editable
                    ? '当前状态下不能直接编辑。'
                    : '这类内容不能直接编辑，请修改对应的对话或记忆来源。'}
              </Notice>
            )}

            {selected.state === 'deleted' && (
              <div className="space-y-3">
                <Field label="处理原因" value={reason} onChange={setReason} placeholder="说明恢复原因" disabled={busy} />
                <button
                  className="rounded-2xl border border-slate-200 px-5 py-2 text-sm disabled:opacity-40"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    apply(
                      restoreRecord(runtime.request, operations.current, {
                        characterId,
                        id: selected.id,
                        expectedVersion: selected.version,
                        reason,
                      }),
                      value => `恢复已确认，服务报告 ${value.affectedIds.length} 条记录受影响。`,
                      refreshList,
                    )
                  }
                >
                  {busy ? '正在处理…' : '恢复这条记录'}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

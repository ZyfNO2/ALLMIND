/**
 * 资料库与文档：每角色独立，读 / 写都带 `characterId` 查询参数与 `expectedRevision`。
 *
 * 端点（`management/knowledge-routes.ts`，方法名即真实 HTTP 方法）：
 *  - `GET  /api/knowledge?characterId=` → 快照（revision / activeLibraryId / libraries）
 *  - `POST /api/knowledge/libraries`、`/rename`、`/activate`、`/import`
 *  - `POST /api/knowledge/documents/list`、`/documents/content`、`/documents/remove`、`/libraries/delete`
 *
 * 文档正文按需读取：列表只拿元数据，点击“查看正文”才请求 `/documents/content`，且不落盘。
 * 删除 / 删除资料库带 revision；409 保留当前选择并提示刷新，不静默重载。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import {
  isAbort,
  readKnowledge,
  readKnowledgeDocumentContent,
  readKnowledgeDocuments,
  type KnowledgeDocument,
  type KnowledgeSnapshot,
} from './client'
import {
  activateLibrary,
  createLibrary,
  deleteLibrary,
  importDocuments,
  readLocalFiles,
  removeDocument,
  renameLibrary,
} from './actions'
import { Definition, Field, ReadState } from './Panel'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function KnowledgeLibrary({ characterId }: { characterId: string }) {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [settled, setSettled] = useState(false)
  const [nonce, setNonce] = useState(0)

  const [selectedLibraryId, setSelectedLibraryId] = useState('')
  const [documents, setDocuments] = useState<KnowledgeDocument[] | null>(null)
  const [documentsError, setDocumentsError] = useState('')
  const [documentsLoading, setDocumentsLoading] = useState(false)

  const [reader, setReader] = useState<(KnowledgeDocument & { text: string }) | null>(null)
  const [readerError, setReaderError] = useState('')

  const [newName, setNewName] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [conflict, setConflict] = useState('')
  const [confirming, setConfirming] = useState<'' | 'library' | 'document'>('')

  const snapshotController = useRef<AbortController | null>(null)
  const documentsController = useRef<AbortController | null>(null)

  useEffect(() => {
    snapshotController.current?.abort()
    const current = new AbortController()
    snapshotController.current = current
    setLoading(true)
    setError('')
    readKnowledge(runtime.request, characterId, current.signal)
      .then(value => {
        if (current.signal.aborted) return
        setSnapshot(value)
        setSelectedLibraryId(previous => previous || value.activeLibraryId || value.libraries[0]?.id || '')
        setSettled(true)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        setSnapshot(null)
        setError((error as Error).message || '读取资料库失败')
        setSettled(true)
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false)
      })
    return () => current.abort()
  }, [characterId, nonce])

  useEffect(() => {
    if (!selectedLibraryId) {
      setDocuments(null)
      setDocumentsError('')
      return
    }
    documentsController.current?.abort()
    const current = new AbortController()
    documentsController.current = current
    setDocumentsLoading(true)
    setDocumentsError('')
    setReader(null)
    setReaderError('')
    readKnowledgeDocuments(runtime.request, characterId, selectedLibraryId, current.signal)
      .then(value => {
        if (current.signal.aborted) return
        setDocuments(value)
      })
      .catch(error => {
        if (current.signal.aborted || isAbort(error)) return
        // 文档列表读取失败不能显示成“0 篇文档”。
        setDocuments(null)
        setDocumentsError((error as Error).message || '读取文档列表失败')
      })
      .finally(() => {
        if (!current.signal.aborted) setDocumentsLoading(false)
      })
    return () => current.abort()
  }, [characterId, selectedLibraryId, nonce])

  const library = useMemo(() => snapshot?.libraries.find(item => item.id === selectedLibraryId) ?? null, [snapshot, selectedLibraryId])

  useEffect(() => {
    setRenameDraft(library?.name ?? '')
  }, [library])

  useEffect(() => {
    setMessage('')
    setActionError('')
    setConflict('')
    setConfirming('')
  }, [characterId, selectedLibraryId])

  async function apply(outcome: Promise<{ ok: boolean; value?: any; conflict?: boolean; message?: string }>, success: string) {
    setBusy(true)
    setMessage('')
    setActionError('')
    setConflict('')
    const result = await outcome
    setBusy(false)
    if (result.ok) {
      if (result.value) setSnapshot(result.value as KnowledgeSnapshot)
      setMessage(success)
      setNonce(value => value + 1)
      return
    }
    if (result.conflict) {
      setConflict(result.message ?? '资料库版本已变化。')
      return
    }
    setActionError(result.message ?? '操作未完成。')
  }

  const revision = snapshot?.revision ?? null

  return (
    <div className="grid grid-cols-[320px_1fr] gap-6">
      <aside className="card space-y-4 p-6">
        <h2 className="text-base font-bold">资料库</h2>
        <p className="text-xs text-ink-400">每个角色有独立的资料库；这里的资料只作为参考来源，不自动改写为用户记忆。</p>
        <ReadState
          loading={loading}
          error={error}
          settled={settled}
          count={snapshot ? snapshot.libraries.length : null}
          emptyText="这个角色还没有资料库。"
          onRetry={() => setNonce(value => value + 1)}
        >
          <div className="space-y-2">
            {snapshot?.libraries.map(item => (
              <button
                key={item.id}
                onClick={() => setSelectedLibraryId(item.id)}
                className={`block w-full rounded-2xl border p-3 text-left text-sm transition ${
                  selectedLibraryId === item.id ? 'border-aika-300 bg-aika-50' : 'border-slate-100 hover:bg-slate-50'
                }`}
              >
                <span className="block font-semibold text-ink-800">{item.name}</span>
                <span className="mt-1 block text-xs text-ink-400">
                  {item.documentCount} 个文档 · {formatBytes(item.bytes)}
                  {snapshot?.activeLibraryId === item.id ? ' · 当前生效' : ''}
                </span>
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-400">资料库修订 Rev {snapshot?.revision ?? '未读取'}</p>
        </ReadState>

        <div className="space-y-2 border-t border-slate-100 pt-4">
          <Field label="新资料库名称" value={newName} onChange={setNewName} placeholder="1–80 字符" disabled={busy} />
          <button
            className="rounded-2xl bg-aika-500 px-4 py-2 text-sm text-white disabled:opacity-40"
            disabled={busy || !newName.trim()}
            onClick={() => apply(createLibrary(runtime.request, characterId, newName), '资料库已创建。').then(() => setNewName(''))}
          >
            新建资料库
          </button>
        </div>
      </aside>

      <section className="card space-y-4 p-6">
        {message && <Notice>{message}</Notice>}
        {actionError && <Notice>{actionError}</Notice>}
        {conflict && <Notice>{conflict}当前选择与草稿已保留，未覆盖。</Notice>}

        {!library ? (
          <p className="text-sm text-ink-400">从左侧选择一个资料库，或新建一个。</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[240px] flex-1">
                <Field label="资料库名称" value={renameDraft} onChange={setRenameDraft} disabled={busy} />
              </div>
              <button
                className="rounded-2xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-40"
                disabled={busy || !renameDraft.trim() || renameDraft === library.name || revision === null}
                onClick={() => apply(renameLibrary(runtime.request, characterId, { libraryId: library.id, name: renameDraft, expectedRevision: revision! }), '资料库已重命名。')}
              >
                重命名
              </button>
              <button
                className="rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40"
                disabled={busy || revision === null}
                onClick={() =>
                  apply(
                    activateLibrary(runtime.request, characterId, {
                      libraryId: snapshot?.activeLibraryId === library.id ? null : library.id,
                      expectedRevision: revision!,
                    }),
                    snapshot?.activeLibraryId === library.id ? '已停用该资料库。' : '该资料库已在本角色对话中启用。',
                  )
                }
              >
                {snapshot?.activeLibraryId === library.id ? '停用此资料库' : '在该角色对话中使用'}
              </button>
            </div>

            <Definition
              rows={[
                ['归属角色', library.ownerCharacterId],
                ['资料库修订', String(library.revision)],
                ['全局知识修订', String(snapshot?.revision ?? '未提供')],
                ['创建时间', library.createdAt ? new Date(library.createdAt).toLocaleString('zh-CN') : '未提供'],
              ]}
            />

            <div className="space-y-3 border-t border-slate-100 pt-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-ink-500">导入 TXT / Markdown 文件（每次 ≤ 20 个，每个 ≤ 2 MiB）</span>
                <input
                  aria-label="导入文件"
                  type="file"
                  accept=".txt,.md,.markdown"
                  multiple
                  disabled={busy}
                  onChange={async event => {
                    const files = [...(event.target.files ?? [])]
                    event.target.value = ''
                    if (!files.length) return
                    let payload: { sourceName: string; text: string }[]
                    try {
                      payload = await readLocalFiles(files)
                    } catch (error) {
                      setActionError((error as Error).message)
                      return
                    }
                    await apply(importDocuments(runtime.request, characterId, { libraryId: library.id, files: payload }), '文件已导入资料库。')
                  }}
                />
              </label>

              {documentsError ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
                  <p className="font-semibold">文档列表读取失败</p>
                  <p className="mt-1">{documentsError}</p>
                  <p className="mt-1 text-xs">失败不代表这个资料库没有文档。</p>
                </div>
              ) : documentsLoading ? (
                <p className="text-xs text-ink-400">正在读取文档列表…</p>
              ) : documents && documents.length === 0 ? (
                <p className="text-xs text-ink-400">这个资料库还没有文档。</p>
              ) : (
                <div className="space-y-2">
                  {documents?.map(document => (
                    <div key={document.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 p-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink-800">{document.sourceName}</p>
                        <p className="text-xs text-ink-400">
                          {formatBytes(document.bytes)} · 修订 {document.revision} · {new Date(document.createdAt).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs disabled:opacity-40"
                          disabled={busy}
                          onClick={async () => {
                            setReaderError('')
                            setBusy(true)
                            try {
                              const content = await readKnowledgeDocumentContent(runtime.request, characterId, {
                                libraryId: library.id,
                                documentId: document.id,
                              })
                              setReader(content)
                            } catch (error) {
                              setReader(null)
                              setReaderError((error as Error).message || '读取正文失败')
                            } finally {
                              setBusy(false)
                            }
                          }}
                        >
                          查看正文
                        </button>
                        <button
                          className="rounded-xl border border-rose-200 px-3 py-1.5 text-xs text-rose-600 disabled:opacity-40"
                          disabled={busy || revision === null}
                          onClick={() => {
                            setConfirming('document')
                            setMessage('')
                            setActionError('')
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {readerError && <Notice>{readerError}</Notice>}
              {reader && (
                <div className="space-y-2 rounded-2xl bg-slate-50 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{reader.sourceName}</p>
                    <button className="text-xs text-aika-600" onClick={() => setReader(null)}>
                      关闭正文
                    </button>
                  </div>
                  <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap text-xs text-ink-700">{reader.text || '（空文档）'}</pre>
                </div>
              )}
            </div>

            <div className="space-y-3 border-t border-slate-100 pt-4">
              <button
                className="rounded-2xl border border-rose-200 px-4 py-2 text-sm text-rose-600 disabled:opacity-40"
                disabled={busy || revision === null}
                onClick={() => {
                  setConfirming('library')
                  setMessage('')
                  setActionError('')
                }}
              >
                删除这个资料库
              </button>
              {confirming === 'library' && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                  <p>删除《{library.name}》会同时移除库内全部文档，且立即对后续对话检索失效。</p>
                  <div className="mt-3 flex gap-2">
                    <button
                      className="rounded-xl bg-rose-500 px-4 py-2 text-white disabled:opacity-40"
                      disabled={busy}
                      onClick={async () => {
                        setConfirming('')
                        await apply(deleteLibrary(runtime.request, characterId, { libraryId: library.id, expectedRevision: revision! }), '资料库已删除。')
                        setSelectedLibraryId('')
                      }}
                    >
                      确认删除资料库
                    </button>
                    <button className="rounded-xl border border-rose-200 px-4 py-2" onClick={() => setConfirming('')}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {confirming === 'document' && documents && (
          <DocumentDeleteConfirmation
            documents={documents}
            busy={busy}
            onCancel={() => setConfirming('')}
            onConfirm={async document => {
              setConfirming('')
              await apply(
                removeDocument(runtime.request, characterId, { libraryId: library!.id, documentId: document.id, expectedRevision: revision! }),
                `文档《${document.sourceName}》已删除。`,
              )
            }}
          />
        )}
      </section>
    </div>
  )
}

function DocumentDeleteConfirmation({
  documents,
  busy,
  onCancel,
  onConfirm,
}: {
  documents: KnowledgeDocument[]
  busy: boolean
  onCancel: () => void
  onConfirm: (document: KnowledgeDocument) => void
}) {
  const [targetId, setTargetId] = useState(documents[0]?.id ?? '')
  const target = documents.find(document => document.id === targetId) ?? null
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p>选择要删除的文档；删除后该文档不再参与后续对话检索。</p>
      <select aria-label="要删除的文档" className="soft-input mt-3" value={targetId} onChange={event => setTargetId(event.target.value)}>
        {documents.map(document => (
          <option key={document.id} value={document.id}>
            {document.sourceName}
          </option>
        ))}
      </select>
      <div className="mt-3 flex gap-2">
        <button className="rounded-xl bg-rose-500 px-4 py-2 text-white disabled:opacity-40" disabled={busy || !target} onClick={() => target && onConfirm(target)}>
          确认删除文档
        </button>
        <button className="rounded-xl border border-rose-200 px-4 py-2" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}

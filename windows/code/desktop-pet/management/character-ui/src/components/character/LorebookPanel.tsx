// LUI-02: 故事书 / Lorebook 作者配置。
//
// 真实契约（`management/lorebook-routes.ts`）：
//  * `GET    /api/characters/lorebooks?characterId=`            → `{ apiVersion, characterId, books }`
//  * `POST   /api/characters/lorebooks`                          → 新建（`operationId` 幂等）
//  * `PUT    /api/characters/lorebooks/{id}`                     → 追加一批条目（整批一个事务）
//  * `DELETE /api/characters/lorebooks/{id}`                     → 删除整本（`expectedRevision` + `operationId`）
//  * `PUT    /api/characters/lorebooks/{id}/entries/{entry}`     → 就地替换一个条目（只发 `enabled` 时是开关）
//  * `DELETE /api/characters/lorebooks/{id}/entries/{entry}`     → 删除一个条目
//  * `POST   /api/characters/lorebooks/import`                   → preview（**不写库**）
//  * `POST   /api/characters/lorebooks/import/confirm`           → 显式确认（一次事务、`operationId` 幂等）
//
// 保留语义：book revision 作为 `expectedRevision`；409 保留草稿；三种条目操作是三次不同的真实调用
// （不是「删全部再重建」）；服务端返回整本书后替换本地副本（不做乐观合并）。
import { useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { useAsync } from '../../hooks/useAsync'
import { Notice } from '../Connection'
import { Spinner } from '../ui'
import { createCharacterSession, isConflict, messageOf, replaceBook, splitKeywords, type Lorebook, type OperationHolder } from './session'
import { ErrorNotice, Field, Panel, SaveRow, SelectField, SuccessNotice, Unavailable } from './primitives'

const session = createCharacterSession(runtime)

export default function LorebookPanel({ characterId }: { characterId: string }) {
  const loaded = useAsync(() => session.loadLorebooks(characterId), [characterId], undefined)
  if (loaded.error) {
    // 「本机未装配」（unavailable）与「该角色没有书」是两种不同的诚实状态。
    const unavailable = (loaded.error as any)?.status === 503
    return (
      <Panel title="故事书与世界设定 · Lorebook" description="按关键词或始终包含注入对话上下文。">
        {unavailable
          ? <Unavailable>本机未装配故事书功能，无法读取或新建：{loaded.error}</Unavailable>
          : <ErrorNotice message={`读取故事书失败：${loaded.error}`} />}
      </Panel>
    )
  }
  if (!loaded.data) return <Spinner />
  return <LorebookEditor key={characterId} characterId={characterId} books={loaded.data.books} onChange={books => loaded.setData({ ...loaded.data!, books })} />
}

function LorebookEditor({ characterId, books, onChange }: { characterId: string; books: Lorebook[]; onChange: (books: Lorebook[]) => void }) {
  const [bookId, setBookId] = useState(books[0]?.id || '')
  const [title, setTitle] = useState('')
  const [entry, setEntry] = useState({ title: '', content: '', keywords: '', strategy: 'keyword' as 'keyword' | 'always' })
  const [state, setState] = useState({ busy: '', message: '', error: '', conflict: '' })
  const createHolder = useRef<OperationHolder>({})
  const importHolder = useRef<OperationHolder>({})

  const book = books.find(item => item.id === bookId) || books[0] || null
  const revision = book?.revision ?? 0
  const busy = !!state.busy

  const fail = (error: unknown, extra?: { keepDraft?: boolean }) => {
    if (isConflict(error)) {
      setState({ busy: '', message: '', error: '', conflict: `${messageOf(error)} 当前草稿已保留，请重新读取后再保存。` })
      return
    }
    setState({ busy: '', message: '', error: `保存失败：${messageOf(error)}`, conflict: extra?.keepDraft ? state.conflict : '' })
  }

  async function createBook() {
    setState({ busy: 'create', message: '', error: '', conflict: '' })
    try {
      const result = await session.createLorebook({ characterId, title, holder: createHolder.current })
      onChange([...books, result.lorebook])
      setBookId(result.lorebook.id)
      // 只有服务端确认后才清空输入框。
      setTitle('')
      createHolder.current = {}
      setState({ busy: '', error: '', conflict: '', message: `故事书已创建：${result.lorebook.title}` })
    } catch (error) { fail(error) }
  }

  async function addEntry() {
    if (!book) return
    setState({ busy: 'add', message: '', error: '', conflict: '' })
    try {
      const next = await session.writeLorebookEntry(characterId, {
        op: 'add', bookId: book.id, expectedRevision: revision,
        entry: { title: entry.title, content: entry.content, strategy: entry.strategy, keywords: splitKeywords(entry.keywords) },
      })
      onChange(replaceBook(books, next))
      setEntry({ title: '', content: '', keywords: '', strategy: 'keyword' })
      setState({ busy: '', error: '', conflict: '', message: `条目已追加到《${next.title}》。` })
    } catch (error) { fail(error, { keepDraft: true }) }
  }

  async function toggleEntry(target: { id: string; enabled: boolean }) {
    if (!book) return
    setState({ busy: target.id, message: '', error: '', conflict: '' })
    try {
      // 只发送 intended 的 `enabled`：服务端保留被省略的字段，开关不可能清空正文。
      const next = await session.writeLorebookEntry(characterId, { op: 'toggle', bookId: book.id, entryId: target.id, expectedRevision: revision, enabled: !target.enabled })
      onChange(replaceBook(books, next))
      setState({ busy: '', error: '', conflict: '', message: `条目已${!target.enabled ? '启用' : '停用'}。` })
    } catch (error) { fail(error) }
  }

  async function removeEntry(target: { id: string }) {
    if (!book) return
    setState({ busy: target.id, message: '', error: '', conflict: '' })
    try {
      const next = await session.writeLorebookEntry(characterId, { op: 'remove', bookId: book.id, entryId: target.id, expectedRevision: revision })
      onChange(replaceBook(books, next))
      setState({ busy: '', error: '', conflict: '', message: '条目已删除。' })
    } catch (error) { fail(error) }
  }

  return (
    <Panel
      title="故事书与世界设定 · Lorebook"
      description="故事书承载角色的世界设定、人物关系与故事背景，按关键词或始终包含注入对话上下文。"
      extra={<span className="chip bg-slate-100 text-ink-500">{books.length} 本</span>}
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-bold">故事书列表</h3>
          {books.length === 0 && <Unavailable>该角色还没有故事书。</Unavailable>}
          {books.map(item => (
            <div key={item.id} className="rounded-2xl border border-slate-100 p-3">
              <button type="button" aria-pressed={item.id === book?.id}
                className={`w-full rounded-xl px-3 py-2 text-left text-sm ${item.id === book?.id ? 'bg-aika-50 text-aika-600' : 'hover:bg-slate-50'}`}
                onClick={() => setBookId(item.id)}>{item.title}</button>
              <p className="mt-1 text-xs text-ink-400">{item.entries.length} 条 · 修订 {item.revision}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-ink-500">
                {item.entries.map(row => <li key={row.id}><code>{row.strategy === 'always' ? 'always' : (row.keywords.join('、') || 'keyword')}</code> {row.title}{row.enabled ? '' : '（已停用）'}</li>)}
              </ul>
            </div>
          ))}
          <Field id="lorebook-title" label="新建故事书标题" value={title} disabled={busy} placeholder="例如：世界设定与人物关系" onChange={setTitle} />
          <SaveRow busy={state.busy === 'create'} disabled={!title.trim()} onClick={() => void createBook()} note="新建后该书会成为当前编辑目标。">新建故事书</SaveRow>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-bold">{book ? `编辑《${book.title}》的条目` : '条目编辑'}</h3>
          {!book && <Unavailable>先新建或选择一本故事书，才能编辑条目。</Unavailable>}
          <Field id="lorebook-entry-title" label="条目标题" value={entry.title} disabled={busy || !book} placeholder="例如：初遇" onChange={v => setEntry(current => ({ ...current, title: v }))} />
          <SelectField id="lorebook-entry-strategy" label="触发方式" value={entry.strategy} disabled={busy || !book}
            options={[['keyword', '关键词命中时注入'], ['always', '每轮都注入']]}
            onChange={v => setEntry(current => ({ ...current, strategy: v as 'keyword' | 'always' }))} />
          {entry.strategy !== 'always' && (
            <Field id="lorebook-entry-keywords" label="关键词（逗号分隔）" value={entry.keywords} disabled={busy || !book} placeholder="图书馆, 初遇" onChange={v => setEntry(current => ({ ...current, keywords: v }))} />
          )}
          <Field id="lorebook-entry-content" label="条目正文" value={entry.content} multiline disabled={busy || !book} placeholder="这条设定要注入对话上下文的内容…" onChange={v => setEntry(current => ({ ...current, content: v }))} />
          <SaveRow busy={state.busy === 'add'} disabled={!book || !entry.content.trim()} onClick={() => void addEntry()} note="关键词为字面匹配；正文过大或关键词为空会被服务端拒绝。">追加条目</SaveRow>

          <h3 className="pt-2 text-sm font-bold">条目</h3>
          {book && book.entries.length === 0 && <Unavailable>这本书还没有条目。</Unavailable>}
          {(book?.entries || []).map(row => (
            <div key={row.id} className="rounded-2xl border border-slate-100 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">{row.title}</strong>
                <span className="chip bg-slate-100 text-ink-500">{row.strategy === 'always' ? '始终注入' : `关键词：${row.keywords.join('、')}`}</span>
                {!row.enabled && <span className="chip bg-amber-50 text-amber-700">已停用</span>}
              </div>
              <p className="mt-1 text-xs text-ink-500">{row.content}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="rounded-xl border border-aika-200 px-3 py-1.5 text-xs text-aika-600 disabled:opacity-40"
                  disabled={busy} onClick={() => void toggleEntry(row)}>{state.busy === row.id ? '处理中…' : (row.enabled ? '停用' : '启用')}</button>
                <button type="button" className="rounded-xl border border-rose-200 px-3 py-1.5 text-xs text-rose-600 disabled:opacity-40"
                  disabled={busy} onClick={() => void removeEntry(row)}>删除此条目</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <SuccessNotice message={state.message} />
      <ErrorNotice message={state.error} />
      {state.conflict && <Notice>{state.conflict}</Notice>}
      <LorebookImport characterId={characterId} holder={importHolder} onImported={next => onChange(replaceBook(books, next))} />
      <p className="text-xs text-ink-400">共享故事书与本地 Lorebook 文件导入尚未实现，不保存任何假路径。</p>
    </Panel>
  )
}

/**
 * 导入：先 preview（不写库）再显式 confirm。
 *
 * preview 与 confirm 是两次独立请求；用户必须在看到预览后再次点击确认，confirm 才提交一次事务。
 */
function LorebookImport({ characterId, holder, onImported }: { characterId: string; holder: React.MutableRefObject<OperationHolder>; onImported: (book: Lorebook) => void }) {
  const [text, setText] = useState('')
  const [state, setState] = useState<{ busy: string; preview?: { title: string; entries: unknown[] }; error: string; message: string }>({ busy: '', error: '', message: '' })

  const parse = (): unknown => {
    try { return JSON.parse(text) } catch { throw new Error('导入内容不是有效的 JSON。') }
  }

  async function preview() {
    setState({ busy: 'preview', error: '', message: '' })
    try {
      const result = await session.previewLorebookImport(characterId, parse())
      setState({ busy: '', error: '', message: '', preview: result.preview })
    } catch (error) { setState({ busy: '', error: `预览失败：${messageOf(error)}`, message: '' }) }
  }

  async function confirm() {
    setState(current => ({ ...current, busy: 'confirm', error: '', message: '' }))
    try {
      const book = await session.confirmLorebookImport({ characterId, book: parse(), holder: holder.current })
      onImported(book)
      holder.current = {}
      setText('')
      setState({ busy: '', error: '', message: `已导入《${book.title}》（${book.entries.length} 条）。`, preview: undefined })
    } catch (error) { setState(current => ({ ...current, busy: '', error: `导入失败：${messageOf(error)}` })) }
  }

  return (
    <details className="rounded-2xl border border-slate-100 p-4">
      <summary className="cursor-pointer text-sm font-bold">导入故事书（v1 JSON）</summary>
      <p className="mt-2 text-xs text-ink-400">先预览校验结果，确认后再写入；预览不会修改任何数据。</p>
      <div className="mt-3 space-y-3">
        <Field id="lorebook-import-text" label="故事书 JSON" value={text} multiline disabled={!!state.busy} onChange={setText} />
        <div className="flex flex-wrap gap-3">
          <button type="button" id="lorebook-import-preview" className="rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40"
            disabled={!!state.busy || !text.trim()} onClick={() => void preview()}>{state.busy === 'preview' ? '校验中…' : '预览校验'}</button>
          <button type="button" id="lorebook-import-confirm" className="rounded-2xl bg-aika-500 px-4 py-2 text-sm text-white disabled:opacity-40"
            disabled={!!state.busy || !state.preview} onClick={() => void confirm()}>{state.busy === 'confirm' ? '导入中…' : '确认导入'}</button>
        </div>
        {state.preview && <p className="text-xs text-ink-500">预览：{state.preview.title} · {state.preview.entries.length} 条（尚未写入）</p>}
        <SuccessNotice message={state.message} />
        <ErrorNotice message={state.error} />
      </div>
    </details>
  )
}

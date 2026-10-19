// CB-04: 统一角色文档（.aiki.md）导入面板 —— 双入口 → 同一预览 → 保存草稿 → 显式应用 → 版本/回退。
//
// 边界（[CB-04 SPEC](../../../../docs/next/aiki-character-book/specs/CB-04.md)）：
//   * 文件本地读取（UTF-8 fatal / 128 KiB / NUL 检查），路径不上传，sourceName 只留文件名；
//   * 两入口走同一 preview API；输入/角色变化立即失效旧预览；迟到响应用序列号丢弃；
//   * 保存与应用是**不同**按钮；应用前重新预览（服务端再校验一次修订）；
//   * 409 保留输入与草稿并给出原因；结果未知时保留 operationId 供查询，不用新 ID 重试；
//   * 正文纯文本渲染：不执行 HTML/脚本、不加载外链媒体；
//   * 改名只做「建议」：显式二次确认后走既有 rename 流程，绝不在一次应用内改名。
import { useRef, useState } from 'react'
import { useAsync } from '../../hooks/useAsync'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import { Panel } from './primitives'

const MAX_BYTES = 128 * 1024
const newOp = () => crypto.randomUUID()

type Action = 'add' | 'noop' | 'update' | 'conflict' | 'skip' | 'blocked'
interface PreviewItem { entryId: string; type: string; subtype?: string; title?: string; action: Action; reason: string; targetOwner: string; targetField?: string; blocked: boolean }
interface PreviewState {
  documentHash: string; mode: 'aiki-character' | 'source_only'; documentId?: string
  counts: { persona: number; wiki: number; story: number; state: number }
  authoring: { intro: string | null; scenario: string | null; firstMessage: string | null; exampleDialogue: string | null }
  nameSuggestion?: { documentName: string; currentLabel: string | null; differs: boolean }
  entries: PreviewItem[]
  current: { profileRevision: number | null; promptRevision: number | null; packRevision: number; lorebookFingerprint: string }
  canSave: boolean; canApply: boolean; blockers: string[]; diff: { summary: string }
  diagnostics: { code: string; message: string; line?: number; entryId?: string; field?: string }[]
}

const ACTION_LABEL: Record<Action, string> = { add: '新增', update: '更新', noop: '无变化', conflict: '冲突（保留本地）', skip: '跳过', blocked: '不可应用' }
const ACTION_TONE: Record<Action, string> = {
  add: 'bg-emerald-50 text-emerald-700', update: 'bg-amber-50 text-amber-700', noop: 'bg-slate-100 text-ink-500',
  conflict: 'bg-orange-50 text-orange-700', skip: 'bg-slate-100 text-ink-400', blocked: 'bg-red-50 text-red-600',
}
/** 条目 → 将填入的位置（人可读）。 */
const TARGET_LABEL: Record<string, string> = {
  profile: '角色资料', prompt: '人设正文', pack: '角色 Wiki', lorebook: '故事书', authorState: '作者初始状态', none: '仅预览',
}

export default function DocumentImportPanel({ characterId }: { characterId: string }) {
  // The API returns `{ characterId, imports: [...] }` — read `imports`, not `drafts`.
  const imports = useAsync(() => runtime.listDocumentDrafts(characterId), [characterId], undefined)
  const authorState = useAsync(() => runtime.authorState(characterId), [characterId], undefined)
  const snapshot = useAsync(() => runtime.getSnapshotSafe?.() ?? Promise.resolve(null), [characterId], undefined)
  const runningCharacterId: string = snapshot.data?.runtime?.characterId ?? ''
  const [text, setText] = useState('')
  const [sourceName, setSourceName] = useState('粘贴内容')
  const [inputKind, setInputKind] = useState<'file' | 'paste'>('paste')
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'unknown' | 'conflict'; message: string } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | 'apply' | 'rollback' | 'export' | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [receipt, setReceipt] = useState<any>(null)
  // Survives a reload: the server reports the last committed apply so rollback stays reachable.
  const lastApply = (authorState.data?.lastApply ?? null) as { operationId: string; committedAt: string; alreadyRolledBack: boolean } | null
  const [rollbackPreview, setRollbackPreview] = useState<any>(null)
  const sequence = useRef(0)
  const operation = useRef<{ id: string; hash: string } | null>(null)
  const lastOperationId = useRef<string | null>(null)

  /** 输入/角色变化：旧预览与应用资格立即失效。 */
  function invalidate(nextText: string, nextName: string, nextKind: 'file' | 'paste') {
    setText(nextText); setSourceName(nextName); setInputKind(nextKind)
    setPreview(null); setExcluded(new Set()); setConfirming(false); setStatus(null)
  }

  async function runPreview() {
    if (!text.trim()) { setStatus({ kind: 'error', message: '请先粘贴内容或选择 .aiki.md 文件。' }); return }
    const seq = ++sequence.current
    setBusy('preview'); setStatus(null)
    try {
      const result = await runtime.previewDocument(characterId, inputKind, sourceName, text) as PreviewState
      if (seq !== sequence.current || characterId === '') return
      setPreview(result); setExcluded(new Set()); setConfirming(false)
      setStatus({
        kind: 'ok',
        message: result.mode === 'aiki-character'
          ? `解析完成：Persona ${result.counts.persona} · Wiki ${result.counts.wiki} · 故事 ${result.counts.story} · State ${result.counts.state}（未保存、未应用）。`
          : '来源草稿：尚无结构化角色文档，可保存来源，不能应用。',
      })
    } catch (error) {
      if (seq !== sequence.current) return
      setStatus({ kind: 'error', message: (error as Error).message })
    } finally { if (seq === sequence.current) setBusy(null) }
  }

  async function saveDraft(): Promise<string | null> {
    if (!preview) return null
    const op = operation.current?.hash === preview.documentHash ? operation.current : { id: newOp(), hash: preview.documentHash }
    operation.current = op
    setBusy('save'); setStatus(null)
    try {
      const result = await runtime.saveDocumentDraft(characterId, inputKind, sourceName, text, op.id, preview.documentHash)
      setStatus({ kind: 'ok', message: result.duplicate ? '相同内容此前已保存（未应用）。' : '草稿已保存（未应用）。' })
      imports.setData(await runtime.listDocumentDrafts(characterId))
      return result.importId as string
    } catch (error) {
      const message = (error as Error).message
      if (/409|冲突|变化/.test(message)) setStatus({ kind: 'conflict', message: `${message} 输入与草稿已保留；请重新预览后重试。` })
      else setStatus({ kind: 'error', message })
      return null
    } finally { setBusy(null) }
  }

  /** 应用前必须已有 importId（先保存草稿换取，幂等）。 */
  async function startApply() {
    if (!preview?.canApply) return
    setBusy('apply'); setStatus(null)
    try {
      const importId = await saveDraft()
      if (!importId) return
      const detail = await runtime.previewDocumentApply(characterId, importId, {
        profileRevision: preview.current.profileRevision, promptRevision: preview.current.promptRevision,
        packRevision: preview.current.packRevision, bookRevision: null,
      })
      if (detail?.blocked === true || (Array.isArray(detail?.blockers) && detail.blockers.length > 0)) {
        setStatus({ kind: 'error', message: `不能应用：${(detail.blockers ?? []).join('；') || '存在阻塞项'}` })
        return
      }
      setConfirming(true)
    } catch (error) {
      setStatus({ kind: 'error', message: (error as Error).message })
    } finally { setBusy(null) }
  }

  async function confirmApply() {
    if (!preview) return
    const importId = operation.current?.hash === preview.documentHash ? lastOperationId.current : null
    setBusy('apply'); setStatus(null)
    const opId = newOp()
    lastOperationId.current = opId
    try {
      const saved = await runtime.saveDocumentDraft(characterId, inputKind, sourceName, text, operation.current?.id ?? newOp(), preview.documentHash)
      const selection = {
        // 未提供作者字段的域仍勾选，但 apply 侧对「文档未提供」只会保留原值，不会清空。
        profile: true, prompt: true, wiki: true, story: true, state: true,
        skippedEntryIds: [...excluded],
        ...(preview.authoring.intro ? {} : {}),
      }
      const result = await runtime.applyDocument(characterId, (importId ?? saved.importId) as string, preview.documentHash, selection, {
        profileRevision: preview.current.profileRevision, promptRevision: preview.current.promptRevision,
        packRevision: preview.current.packRevision, bookRevision: null,
      }, opId)
      setReceipt(result)
      setConfirming(false)
      if (result.applied === false) {
        setStatus({ kind: 'error', message: `未应用：${result.failure ?? '未知原因'}（operationId 已保留，可查询该操作）` })
      } else {
        setStatus({ kind: 'ok', message: runningCharacterId === characterId ? '已应用并保存；将在下一轮对话生效。' : '已应用到该角色（非运行角色，下次成为运行角色时生效）。' })
        setPreview(null); setExcluded(new Set())
      }
      imports.setData(await runtime.listDocumentDrafts(characterId))
    } catch (error) {
      // 结果未知：保留 operationId，不用新 ID 重试。
      setStatus({ kind: 'unknown', message: `${(error as Error).message}（operationId ${opId} 已保留，可查询该操作后再决定）` })
    } finally { setBusy(null) }
  }

  // Fall back to the server-reported last apply so rollback works after a reload too.
  const rollbackTargetId = receipt?.operationId ?? lastApply?.operationId ?? null

  async function startRollback() {
    if (!rollbackTargetId) return
    setBusy('rollback'); setStatus(null)
    try { setRollbackPreview(await runtime.previewDocumentRollback(characterId, rollbackTargetId)) }
    catch (error) { setStatus({ kind: 'error', message: (error as Error).message }) }
    finally { setBusy(null) }
  }

  async function confirmRollback() {
    if (!rollbackTargetId) return
    setBusy('rollback'); setStatus(null)
    try {
      await runtime.rollbackDocument(characterId, rollbackTargetId)
      setStatus({ kind: 'ok', message: '已回退（形成新修订，不删除任何版本）。' })
      setRollbackPreview(null); setReceipt(null)
      authorState.setData(await runtime.authorState(characterId))
    } catch (error) {
      setStatus({ kind: 'error', message: (error as Error).message })
    } finally { setBusy(null) }
  }

  async function exportCurrent() {
    setBusy('export'); setStatus(null)
    try {
      const result = await runtime.exportDocument(characterId)
      const blob = new Blob([result.text], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = result.filename
      anchor.click()
      URL.revokeObjectURL(url)
      setStatus({ kind: 'ok', message: `已导出 ${result.entryCount} 条（Persona ${result.counts.persona} · Wiki ${result.counts.wiki} · 故事 ${result.counts.story} · State ${result.counts.state}）。${result.warnings?.length ? `注意：${result.warnings.join('；')}` : ''}` })
    } catch (error) {
      setStatus({ kind: 'error', message: (error as Error).message })
    } finally { setBusy(null) }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return // 取消选择：保留原输入
    if (!/\.(aiki\.md|md|markdown)$/i.test(file.name)) { setStatus({ kind: 'error', message: '仅支持 .aiki.md / .md / .markdown 文件。' }); return }
    if (file.size > MAX_BYTES) { setStatus({ kind: 'error', message: `文件超过 ${MAX_BYTES / 1024}KiB 上限。` }); return }
    try {
      const buffer = await file.arrayBuffer()
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      if (decoded.includes('\0')) { setStatus({ kind: 'error', message: '文件包含 NUL 字符，拒绝导入。' }); return }
      const body = decoded.charCodeAt(0) === 0xFEFF ? decoded.slice(1) : decoded
      invalidate(body, file.name, 'file')
    } catch {
      setStatus({ kind: 'error', message: '文件不是有效 UTF-8 文本，拒绝导入。' })
    }
  }

  const toggle = (entryId: string) => {
    setExcluded(previous => {
      const next = new Set(previous)
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId)
      return next
    })
    setConfirming(false)
  }

  return (
    <Panel title="导入角色文档" description="一次导入统一角色文档（.aiki.md）：作者资料、人设正文、角色 Wiki、故事书与作者初始状态。保存草稿不生效，应用才进入当前角色。">
      <p className="text-xs text-ink-500">导入到：{characterId}{imports.data?.imports?.length ? ` · 已有 ${imports.data.imports.length} 条导入记录` : ' · 尚无导入记录'}</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600 cursor-pointer">
          选择 .aiki.md 文件
          <input type="file" accept=".md,.markdown" aria-label="选择角色文档文件" className="hidden" onChange={event => void pickFile(event.target.files?.[0])} />
        </label>
        <button type="button" id="document-export" className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40"
          disabled={busy !== null} onClick={() => void exportCurrent()}>导出当前为 .aiki.md</button>
        {sourceName && <span className="text-xs text-ink-400">来源：{sourceName} · {new Blob([text]).size} 字节</span>}
      </div>
      <textarea aria-label="角色文档内容" className="soft-input mt-3 h-48 w-full font-mono text-xs" value={text}
        onChange={event => invalidate(event.target.value, inputKind === 'file' ? `${sourceName.replace(/\.md$/i, '')}（已编辑）.md` : '粘贴内容', inputKind)}
        placeholder={'在此粘贴 .aiki.md 内容（YAML frontmatter + :::entry 块），或选择文件。'} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" id="document-preview" className="rounded-2xl bg-aika-500 px-5 py-2 text-white disabled:opacity-40"
          disabled={busy !== null || !text.trim()} onClick={() => void runPreview()}>{busy === 'preview' ? '解析中…' : '预览校验'}</button>
        <button type="button" id="document-save" className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40"
          disabled={busy !== null || !preview?.canSave} onClick={() => void saveDraft()}>保存草稿</button>
        <button type="button" id="document-apply" className="rounded-xl bg-aika-600 px-4 py-2 text-sm text-white disabled:opacity-40"
          disabled={busy !== null || !preview?.canApply} onClick={() => void startApply()}>应用到当前角色</button>
      </div>
      {status && <div aria-live="polite" className="mt-3"><Notice>{status.message}</Notice></div>}
      {status?.kind === 'conflict' && (
        <button type="button" className="mt-2 rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600" onClick={() => void runPreview()}>重新读取并预览</button>
      )}
      {preview && (
        <section className="mt-4 space-y-3 rounded-2xl border border-slate-100 p-4" aria-label="预览结果">
          <h3 className="text-sm font-bold">预览（{preview.mode === 'aiki-character' ? '统一角色文档' : '来源草稿'}）</h3>
          <p className="text-xs text-ink-500">{preview.diff?.summary}</p>
          <p className="text-xs text-ink-500" id="document-counts">
            Persona {preview.counts.persona} · Wiki {preview.counts.wiki} · 故事 {preview.counts.story} · State {preview.counts.state}
          </p>
          {preview.blockers.length > 0 && (
            <div className="rounded-xl bg-red-50 p-3 text-xs text-red-600">
              {preview.blockers.map((blocker, index) => <p key={index}>{blocker}</p>)}
            </div>
          )}
          {preview.diagnostics.length > 0 && (
            <div className="rounded-xl bg-red-50 p-3 text-xs text-red-600">
              {preview.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic.line ? `第 ${diagnostic.line} 行：` : ''}{diagnostic.message}</p>)}
            </div>
          )}
          {preview.nameSuggestion?.differs && (
            <div className="rounded-xl border border-aika-200 p-3 text-xs">
              <p>文档名称「{preview.nameSuggestion.documentName}」与当前角色名「{preview.nameSuggestion.currentLabel ?? '未命名'}」不同。</p>
              <p className="mt-1 text-ink-400">改名不在本次应用内进行：请到「角色配置」页显式修改，避免一次操作同时改内容与名称。</p>
            </div>
          )}
          <div>
            <h4 className="text-xs font-bold">将填入的位置</h4>
            <table className="mt-2 w-full text-left text-xs" aria-label="条目应用计划">
              <thead className="text-ink-400"><tr><th className="py-1">启用</th><th>条目</th><th>类型</th><th>目标位置</th><th>动作</th></tr></thead>
              <tbody>
                {preview.entries.map(item => (
                  <tr key={item.entryId} className="border-t border-slate-100">
                    <td className="py-1">
                      <input type="checkbox" aria-label={`应用 ${item.entryId}`} checked={!excluded.has(item.entryId)}
                        disabled={item.action === 'noop' || item.action === 'blocked' || item.action === 'skip'}
                        onChange={() => toggle(item.entryId)} />
                    </td>
                    <td className="py-1 font-mono text-[11px]">{item.title ?? item.entryId}</td>
                    <td className="py-1">{item.type}</td>
                    <td className="py-1">{TARGET_LABEL[item.targetOwner] ?? item.targetOwner}{item.targetField ? ` · ${item.targetField}` : ''}</td>
                    <td className="py-1">
                      <span className={`rounded-lg px-2 py-0.5 ${ACTION_TONE[item.action]}`}>{ACTION_LABEL[item.action]}</span>
                      <span className="ml-2 text-ink-400">{item.reason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary className="cursor-pointer text-xs">查看作者字段（纯文本）</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{JSON.stringify(preview.authoring, null, 2)}</pre>
          </details>
        </section>
      )}
      {confirming && preview && (
        <section className="mt-3 space-y-2 rounded-2xl border border-aika-200 p-4" aria-label="应用确认">
          <h3 className="text-sm font-bold">确认应用</h3>
          <p className="text-xs text-ink-500">将按上表写入：{preview.entries.filter(item => !excluded.has(item.entryId) && (item.action === 'add' || item.action === 'update')).length} 条新增/更新，其余保留原值。</p>
          <p className="text-xs text-ink-400">当前修订：资料 {preview.current.profileRevision ?? '—'} · 人设 {preview.current.promptRevision ?? '—'} · 角色包 {preview.current.packRevision}</p>
          <div className="flex gap-3">
            <button type="button" id="document-apply-confirm" className="rounded-xl bg-aika-600 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={busy !== null} onClick={() => void confirmApply()}>确认应用</button>
            <button type="button" className="rounded-xl border border-aika-200 px-4 py-2 text-sm" onClick={() => setConfirming(false)}>取消</button>
          </div>
        </section>
      )}
      {(receipt || lastApply) && (
        <section className="mt-3 space-y-2 rounded-2xl border border-slate-100 p-4" aria-label="应用回执">
          <h3 className="text-sm font-bold">应用回执</h3>
          {receipt ? (
            <>
              <p className="text-xs text-ink-500">已保存：{Object.entries(receipt.saved ?? {}).filter(([, value]) => value === true).map(([key]) => key).join('、') || '无'}</p>
              <p className="text-xs text-ink-400">生效方式：{receipt.applyOn === 'restart' ? '保存后于下一轮/重启生效' : String(receipt.applyOn)} · 操作 {receipt.operationId}</p>
              {receipt.failure && <p className="text-xs text-red-600">失败：{receipt.failure}</p>}
            </>
          ) : (
            // After a reload the in-memory receipt is gone; the server still knows the last apply.
            <p className="text-xs text-ink-500">最近一次应用：{lastApply!.committedAt} · 操作 <span className="font-mono text-[11px]">{lastApply!.operationId}</span></p>
          )}
          <div className="flex gap-3">
            {lastApply?.alreadyRolledBack
              ? <p className="text-xs text-ink-400">这次应用已经回退过了。</p>
              : <button type="button" className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40" disabled={busy !== null} onClick={() => void startRollback()}>回退这次应用…</button>}
          </div>
        </section>
      )}
      {rollbackPreview && (
        <section className="mt-3 space-y-2 rounded-2xl border border-aika-200 p-4" aria-label="回退确认">
          <h3 className="text-sm font-bold">确认回退</h3>
          <p className="text-xs text-ink-500">{rollbackPreview.note ?? '将本次涉及字段/条目恢复为旧值（新修订）。'}</p>
          <div className="flex gap-3">
            <button type="button" className="rounded-xl bg-aika-600 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={busy !== null} onClick={() => void confirmRollback()}>确认回退</button>
            <button type="button" className="rounded-xl border border-aika-200 px-4 py-2 text-sm" onClick={() => setRollbackPreview(null)}>取消</button>
          </div>
        </section>
      )}
      {authorState.data?.entries?.length > 0 && (
        <section className="mt-4 space-y-2" aria-label="作者初始状态">
          <h3 className="text-sm font-bold">作者初始状态</h3>
          <p className="text-xs text-ink-400">{authorState.data.note}</p>
          <ul className="space-y-2">
            {authorState.data.entries.map((row: any) => (
              <li key={row.entryId} className="rounded-xl border border-slate-100 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-lg bg-aika-50 px-2 py-0.5 text-aika-600">作者设定</span>
                  <span className="font-bold">{row.title}</span>
                  <span className="font-mono text-[11px] text-ink-400">{row.entryId}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-ink-600">{row.body}</p>
                <p className="mt-1 text-ink-400">
                  来源导入 {row.importId} · 修订 {row.revision}
                  {row.expiresAt ? ` · 有效期至 ${row.expiresAt}` : ''}
                  {row.validUntil ? ` · 有效至 ${row.validUntil}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {imports.data?.imports?.length > 0 && (
        <section className="mt-4" aria-label="导入记录">
          <h3 className="text-sm font-bold">导入记录</h3>
          <ul className="mt-2 space-y-2">
            {imports.data.imports.map((draft: any) => (
              <li key={draft.importId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 p-3 text-xs">
                <span className="font-mono text-[11px]">{draft.importId}</span>
                <span>{draft.mode === 'aiki-character' ? '结构化文档' : '来源草稿'} · {draft.sourceName} · {draft.documentHash?.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {imports.error && <Notice>{imports.error}</Notice>}
    </Panel>
  )
}

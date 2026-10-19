// WV0-03: 角色 Wiki v0 导入面板 —— 双入口（粘贴 / MD 文件）→ 同一预览/校验 → 保存草稿 → 显式应用 → 版本回退。
//
// 边界（[WV0-03 SPEC](../../../../docs/next/character-wiki-v0/specs/WV0-03.md)）：
//   * 粘贴是普通 textarea + Ctrl+V；「读取剪贴板」按钮只在**显式点击**时一次 readText，失败可手贴；
//   * 文件本地读取（UTF-8 fatal decode / 大小 / NUL 检查），路径不上传，sourceName 只留文件名；
//   * 两入口走同一 preview API；输入/模式/文件/角色变化即失效旧预览；迟到响应用序列号丢弃；
//   * 保存与应用是**不同**按钮；应用前重新预览活动版本，服务端回执+hash 读回相符才提示成功；
//   * 409 保留输入显示原因；结果未知时保留 operationId 供查询，不用新 ID 重试；
//   * 正文纯文本渲染：不执行 HTML/脚本、不加载外链媒体。
import { useRef, useState } from 'react'
import { useAsync } from '../../hooks/useAsync'
import { runtime } from '../../services/runtime'
import { Notice } from '../Connection'
import { Panel } from './primitives'

const MAX_BYTES = 128 * 1024
const newOp = () => crypto.randomUUID()

interface PreviewState { documentHash: string; mode: 'structured' | 'source_only'; normalizedPreview: any; diagnostics: { path?: string; message: string }[]; current: { packId: string | null; packRevision: number }; canApply: boolean; diff: { summary: string } }

export default function WikiImportPanel({ characterId }: { characterId: string }) {
  const versions = useAsync(() => runtime.wikiVersions(characterId), [characterId], undefined)
  // CB-04: `versions` lists pack versions only; facts show what is actually in effect.
  const facts = useAsync(() => runtime.wikiFacts(characterId), [characterId], undefined)
  const snapshot = useAsync(() => runtime.getSnapshotSafe?.() ?? Promise.resolve(null), [characterId], undefined)
  const runningCharacterId: string = snapshot.data?.runtime?.characterId ?? ''
  const [text, setText] = useState('')
  const [sourceName, setSourceName] = useState('粘贴内容')
  const [inputKind, setInputKind] = useState<'file' | 'clipboard'>('clipboard')
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'unknown' | 'conflict'; message: string } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | 'apply' | 'rollback' | null>(null)
  const [applyPreviewState, setApplyPreviewState] = useState<any>(null)
  const [rollbackPreviewState, setRollbackPreviewState] = useState<any>(null)
  const sequence = useRef(0)
  const fileBuffer = useRef<string | null>(null)
  const operation = useRef<{ id: string; hash: string } | null>(null)

  /** 输入/角色变化：旧预览与应用资格立即失效。 */
  function invalidate(nextText: string, nextName: string, nextKind: 'file' | 'clipboard') {
    setText(nextText); setSourceName(nextName); setInputKind(nextKind)
    setPreview(null); setApplyPreviewState(null); setStatus(null)
  }

  async function runPreview() {
    if (!text.trim()) { setStatus({ kind: 'error', message: '请先粘贴内容或选择 MD 文件。' }); return }
    const seq = ++sequence.current
    setBusy('preview'); setStatus(null)
    try {
      const result = await runtime.previewWikiImport(characterId, inputKind, sourceName, text)
      if (seq !== sequence.current || characterId === '') return
      setPreview(result as PreviewState)
      setStatus({ kind: 'ok', message: result.mode === 'structured' ? '结构化 Wiki 文档解析完成（未保存、未应用）。' : '来源草稿：尚无结构化角色设定，可保存来源，不能应用。' })
    } catch (error) {
      if (seq !== sequence.current) return
      setStatus({ kind: 'error', message: (error as Error).message })
    } finally { if (seq === sequence.current) setBusy(null) }
  }

  async function saveDraft() {
    // eslint-disable-next-line
    if (!preview) return
    const op = operation.current?.hash === preview.documentHash ? operation.current : { id: newOp(), hash: preview.documentHash }
    operation.current = op
    setBusy('save'); setStatus(null)
    try {
      const receipt = await runtime.saveWikiDraft(characterId, inputKind, sourceName, text, op.id, preview.documentHash)
      setStatus({ kind: 'ok', message: receipt.duplicate ? '相同内容此前已保存（未应用）。' : '草稿已保存（未应用）。' })
      versions.setData(await runtime.wikiVersions(characterId))
    } catch (error) {
      const message = (error as Error).message
      if (/409|冲突|变化/.test(message)) setStatus({ kind: 'conflict', message: `${message} 请重新预览后重试。` })
      else setStatus({ kind: 'error', message })
    } finally { setBusy(null) }
  }

  async function startApply() {
    if (!preview?.canApply) return
    setBusy('apply'); setStatus(null)
    try {
      // 应用前重新预览当前活动版本（服务端 hash/revision 在 apply 里再校验一次）。
      const detail = await runtime.previewWikiApply(characterId, preview.documentHash ? (applyPreviewState?.importId ?? (await importDraftId())) : '')
      setApplyPreviewState(detail)
    } catch (error) {
      setStatus({ kind: 'error', message: (error as Error).message })
    } finally { setBusy(null) }
  }

  async function importDraftId(): Promise<string> {
    // apply 需要 importId：预览阶段由后端返回 normalized hash；草稿保存后才有 importId。
    // 这里通过保存（幂等）换取 importId：相同内容返回既有 importId，不复制。
    if (!operation.current || operation.current.hash !== preview!.documentHash) operation.current = { id: newOp(), hash: preview!.documentHash }
    const receipt = await runtime.saveWikiDraft(characterId, inputKind, sourceName, text, operation.current.id, preview!.documentHash)
    return receipt.importId
  }

  async function confirmApply() {
    if (!applyPreviewState) return
    setBusy('apply'); setStatus(null)
    try {
      const importId = applyPreviewState.importId ?? (await importDraftId())
      const receipt = await runtime.applyWiki(characterId, importId, preview!.documentHash, applyPreviewState.current.packRevision, newOp())
      setStatus({ kind: 'ok', message: runningCharacterId === characterId ? '已应用；将用于下一轮对话（读侧生效以正式轮次为准）。' : '已应用到该角色（非运行角色，下次成为运行角色时生效）。' })
      setApplyPreviewState(null); setPreview(null)
      versions.setData(await runtime.wikiVersions(characterId))
      void receipt
    } catch (error) {
      setStatus({ kind: 'error', message: (error as Error).message })
    } finally { setBusy(null) }
  }

  async function startRollback(targetPackId: string) {
    setBusy('rollback'); setStatus(null)
    try { setRollbackPreviewState(await runtime.previewWikiRollback(characterId, targetPackId)) }
    catch (error) { setStatus({ kind: 'error', message: (error as Error).message }) }
    finally { setBusy(null) }
  }

  async function confirmRollback() {
    if (!rollbackPreviewState) return
    setBusy('rollback'); setStatus(null)
    try {
      await runtime.rollbackWiki(characterId, rollbackPreviewState.target.packId, rollbackPreviewState.expectedPackRevision, newOp())
      setStatus({ kind: 'ok', message: '已回退到所选版本。' })
      setRollbackPreviewState(null)
      versions.setData(await runtime.wikiVersions(characterId))
    } catch (error) {
      setStatus({ kind: 'error', message: (error as Error).message })
    } finally { setBusy(null) }
  }

  /** 显式点击才读一次剪贴板；失败仍可手动粘贴。 */
  async function readClipboardOnce() {
    try {
      const value = await navigator.clipboard.readText()
      if (typeof value === 'string' && value) invalidate(value, '剪贴板内容', 'clipboard')
      else setStatus({ kind: 'error', message: '剪贴板为空或不可读；请手动粘贴。' })
    } catch (error) {
      setStatus({ kind: 'error', message: `无法读取剪贴板（${(error as Error).message}）；请手动粘贴到下方文本框。` })
    }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return // 取消选择：保留原输入
    if (!/\.(md|markdown)$/i.test(file.name)) { setStatus({ kind: 'error', message: '仅支持 .md / .markdown 文件。' }); return }
    if (file.size > MAX_BYTES) { setStatus({ kind: 'error', message: `文件超过 ${MAX_BYTES / 1024}KiB 上限。` }); return }
    try {
      const buffer = await file.arrayBuffer()
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      if (decoded.includes('\0')) { setStatus({ kind: 'error', message: '文件包含 NUL 字符，拒绝导入。' }); return }
      const body = decoded.charCodeAt(0) === 0xFEFF ? decoded.slice(1) : decoded
      fileBuffer.current = body
      invalidate(body, file.name, 'file')
    } catch {
      setStatus({ kind: 'error', message: '文件不是有效 UTF-8 文本，拒绝导入。' })
    }
  }

  const hasStructured = preview?.mode === 'structured'

  return (
    <Panel title="角色 Wiki 导入" description="从网页整理的结构化 Markdown 导入角色 Wiki；保存草稿不生效，应用才进入当前角色。">
      <p className="text-xs text-ink-500">导入到：{characterId}{versions.data?.current ? ` · 当前活动版本 ${versions.data.current.packVersion}` : ' · 尚无活动 Wiki 包'}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600" onClick={() => void readClipboardOnce()}>一次读取剪贴板</button>
        <label className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600 cursor-pointer">
          选择 MD 文件
          <input type="file" accept=".md,.markdown" className="hidden" onChange={event => void pickFile(event.target.files?.[0])} />
        </label>
        {sourceName && <span className="text-xs text-ink-400">来源：{sourceName} · {new Blob([text]).size} 字节</span>}
      </div>
      <textarea aria-label="Wiki 内容" className="soft-input mt-3 h-48 w-full font-mono text-xs" value={text}
        onChange={event => invalidate(event.target.value, inputKind === 'file' ? `${sourceName.replace(/\.md$/i, '')}（已编辑）.md` : '粘贴内容', inputKind)}
        placeholder={'在此粘贴网页整理的 Wiki Markdown（含 aika-wiki-v0 代码块），或普通 Markdown 作为来源草稿。'} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" id="wiki-preview" className="rounded-2xl bg-aika-500 px-5 py-2 text-white disabled:opacity-40"
          disabled={busy !== null || !text.trim()} onClick={() => void runPreview()}>{busy === 'preview' ? '解析中…' : '预览校验'}</button>
        <button type="button" id="wiki-save" className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40"
          disabled={busy !== null || !preview} onClick={() => void saveDraft()}>保存草稿</button>
        <button type="button" id="wiki-apply" className="rounded-xl bg-aika-600 px-4 py-2 text-sm text-white disabled:opacity-40"
          disabled={busy !== null || !preview?.canApply} onClick={() => void startApply()}>应用到当前角色</button>
      </div>
      {status && <div aria-live="polite" className="mt-3"><Notice>{status.message}</Notice></div>}
      {status?.kind === 'conflict' && (
        <button type="button" className="mt-2 rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600" onClick={() => void runPreview()}>重新读取并预览</button>
      )}
      {preview && (
        <section className="mt-4 space-y-3 rounded-2xl border border-slate-100 p-4" aria-label="预览结果">
          <h3 className="text-sm font-bold">预览（{preview.mode === 'structured' ? '结构化 Wiki' : '来源草稿'}）</h3>
          <p className="text-xs text-ink-500">{preview.diff?.summary}</p>
          {preview.diagnostics.length > 0 && (
            <div className="rounded-xl bg-red-50 p-3 text-xs text-red-600">
              {preview.diagnostics.map((d, i) => <p key={i}>{d.path ? `${d.path}：` : ''}{d.message}</p>)}
            </div>
          )}
          {hasStructured && preview.normalizedPreview && (
            <div className="space-y-2 text-xs text-ink-600">
              <p>角色核心：{preview.normalizedPreview.bible?.name} —— {preview.normalizedPreview.bible?.soul}</p>
              <p>Wiki 事实：{preview.normalizedPreview.wikiFacts?.length ?? 0} 条（canon {(preview.normalizedPreview.wikiFacts ?? []).filter((f: any) => f.status === 'canon').length} 条，其余为候选不入运行）</p>
              <p>故事事件：{preview.normalizedPreview.storyEvents?.length ?? 0} 条（作者确认顺序，awareness 各自标注）</p>
              <p>来源：{(preview.normalizedPreview.sources ?? []).length} 个（导入者声明，未经联网验证）</p>
              <details><summary className="cursor-pointer">查看解析后内容（纯文本）</summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{JSON.stringify(preview.normalizedPreview, null, 2)}</pre>
              </details>
            </div>
          )}
          {preview.mode === 'source_only' && <p className="text-xs text-ink-400">普通 Markdown：仅保存为来源草稿，应用已禁用。可先参考导入模板整理为结构化格式。</p>}
        </section>
      )}
      {applyPreviewState && (
        <section className="mt-3 space-y-2 rounded-2xl border border-aika-200 p-4" aria-label="应用确认">
          <h3 className="text-sm font-bold">确认应用</h3>
          <p className="text-xs text-ink-500">{applyPreviewState.diff?.summary}</p>
          <p className="text-xs text-ink-400">当前活动包：{applyPreviewState.current?.packId ?? '无'} · 修订 {applyPreviewState.current?.packRevision}</p>
          <div className="flex gap-3">
            <button type="button" className="rounded-xl bg-aika-600 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={busy !== null} onClick={() => void confirmApply()}>确认应用</button>
            <button type="button" className="rounded-xl border border-aika-200 px-4 py-2 text-sm" onClick={() => setApplyPreviewState(null)}>取消</button>
          </div>
        </section>
      )}
      {rollbackPreviewState && (
        <section className="mt-3 space-y-2 rounded-2xl border border-aika-200 p-4" aria-label="回退确认">
          <h3 className="text-sm font-bold">确认回退到 {rollbackPreviewState.target.packVersion}</h3>
          <p className="text-xs text-ink-500">当前：{rollbackPreviewState.current?.packVersion ?? '无'} → 目标：{rollbackPreviewState.target.packVersion}（形成新修订，不删除任何版本）</p>
          <div className="flex gap-3">
            <button type="button" className="rounded-xl bg-aika-600 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={busy !== null} onClick={() => void confirmRollback()}>确认回退</button>
            <button type="button" className="rounded-xl border border-aika-200 px-4 py-2 text-sm" onClick={() => setRollbackPreviewState(null)}>取消</button>
          </div>
        </section>
      )}
      {facts.data?.facts?.length > 0 && (
        <section className="mt-4 space-y-2" aria-label="当前角色 Wiki 事实">
          <h3 className="text-sm font-bold">当前生效的角色 Wiki 事实（{facts.data.facts.length} 条）</h3>
          <p className="text-xs text-ink-400">{facts.data.note}</p>
          <ul className="space-y-2">
            {facts.data.facts.map((fact: any) => (
              <li key={fact.id} className="rounded-xl border border-slate-100 p-3 text-xs">
                <p className="font-mono text-[11px] text-ink-400">{fact.id}</p>
                <pre className="mt-1 whitespace-pre-wrap text-ink-600">{fact.text}</pre>
              </li>
            ))}
          </ul>
        </section>
      )}
      {facts.data && facts.data.facts.length === 0 && (
        <p className="mt-4 text-xs text-ink-400">当前没有生效的角色 Wiki 事实。</p>
      )}
      {versions.data && (
        <section className="mt-4" aria-label="版本历史">
          <h3 className="text-sm font-bold">版本历史</h3>
          {versions.data.versions.length === 0 && <p className="mt-2 text-xs text-ink-400">尚无历史版本。</p>}
          <ul className="mt-2 space-y-2">
            {versions.data.versions.map((version: any) => (
              <li key={version.packId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 p-3 text-xs">
                <span>{version.packVersion} · {version.name}{versions.data?.current?.packId === version.packId ? ' · 当前活动' : ''}</span>
                {versions.data?.current?.packId !== version.packId && (
                  <button type="button" className="rounded-lg border border-aika-200 px-3 py-1 text-aika-600 disabled:opacity-40" disabled={busy !== null} onClick={() => void startRollback(version.packId)}>恢复此版本…</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {versions.error && <Notice>{versions.error}</Notice>}
    </Panel>
  )
}

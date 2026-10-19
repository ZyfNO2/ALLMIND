import { useEffect, useRef, useState } from 'react'
import type { BookSnapshot, SavedTurn, PersonalWikiRevision } from '../../../../contracts/memory-book'
import type { WikiPreview, WikiIssue, FactClaim } from '../../../../memory/fact-wiki'
import { api } from '../book-api'
import WikiCompilation from './WikiCompilation'
import OrganizationReview from './OrganizationReview'

interface Pages { revision: number; pages: { id: string; subject: string; body: string; entryIds: string[]; sourceIds: string[];kind?:string;revision?:number;links?:string[];backlinks?:string[];history?:PersonalWikiRevision[] }[]; sourceCount: number;compiledCount?:number }
const issueLabels: Record<string, string> = { source_revoked_or_superseded: '来源已撤销或修订', conflicting_fact: '事实冲突', knowledge_boundary: '超出角色知情范围', missing_source: '缺少来源', expired: '已过期', broken_link: '关联缺失', uncompiled_declaration: '声明尚未整理', state_event_unavailable: '状态依据不可用', manual_fact_review_required: '手改事实需要重新核对' }
const changeLabels: Record<string, string> = { add: '新增', update: '更新', noop: '无变化', conflict: '需要处理', forgotten: '已遗忘，跳过', retire: '停用' }
export default function FactWikiPanel({ characterId, sessionId, book, turns, modelAvailable, modelBudgetMs, update }: {
  characterId: string; sessionId: string; book: BookSnapshot | null; turns: SavedTurn[]; modelAvailable: boolean; modelBudgetMs?: number; update: (book: BookSnapshot) => void
}) {
  const [pages, setPages] = useState<Pages | null>(null), [issues, setIssues] = useState<WikiIssue[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [title, setTitle] = useState(''), [sourceId, setSourceId] = useState('source-' + crypto.randomUUID()), [text, setText] = useState(''), [privateSource, setPrivate] = useState(true)
  const [preview, setPreview] = useState<WikiPreview | null>(null), [claimsText, setClaimsText] = useState(''), [reviewing, setReviewing] = useState(false)
  const [searchText,setSearchText]=useState(''),[selectedPage,setSelectedPage]=useState<string|null>(null)
  const pending = useRef<AbortController | null>(null)
  const [revocation,setRevocation]=useState<{id:string;title:string;revision:number;facts:number;pages:number}|null>(null)
  const revokeDialog=useRef<HTMLDialogElement|null>(null),revokeTrigger=useRef<HTMLButtonElement|null>(null)
  useEffect(()=>{if(!revocation)return;const dialog=revokeDialog.current!;dialog.showModal();dialog.querySelector<HTMLButtonElement>('button')?.focus();return()=>{dialog.close();revokeTrigger.current?.focus()}},[revocation])
  const generation = useRef(0)
  useEffect(() => { generation.current++; setRevocation(null); return () => { generation.current++; pending.current?.abort() } }, [characterId, sessionId])
  const scope = { characterId, sessionId }, query = '?' + new URLSearchParams(scope)
  useEffect(() => { const controller = new AbortController();setPages(null);api<Pages>('/wiki' + query, { signal: controller.signal }).then(next=>{if(!controller.signal.aborted)setPages(next)}).catch(e => { if (!controller.signal.aborted) setError(e.message) }); return () => controller.abort() }, [characterId,sessionId,book?.revision])
  useEffect(()=>{if(selectedPage){const node=document.getElementById(`wiki-${selectedPage}`);if(node instanceof HTMLDetailsElement){node.open=true;node.scrollIntoView({block:'nearest'})}}},[selectedPage,pages])
  async function work(fn: (publish: (next: BookSnapshot) => void) => Promise<void>) { if (busy) return; const epoch=generation.current; setBusy(true); setError(''); try { await fn(next=>{if(epoch!==generation.current)return;if(next.characterId!==characterId)throw Error('Wiki 回传的角色作用域不匹配。');update(next)}) } catch (e) { if(epoch===generation.current)setError(e instanceof Error ? e.message : String(e)) } finally { if(epoch===generation.current)setBusy(false) } }
  function changed() { setPreview(null); setClaimsText(''); setReviewing(false) }
  async function prepare(mode: 'declarations' | 'model', turn?: SavedTurn) {
    const controller = new AbortController(); pending.current = controller
    try {
    const source = { sourceId, title, text, private: privateSource, ...(reviewing ? { claims: JSON.parse(claimsText) as FactClaim[] } : {}) }
    const p = await api<WikiPreview>('/wiki/preview', { method: 'POST', signal: controller.signal, timeoutMs: mode === 'model' ? (modelBudgetMs ?? 60000) + 20000 : 80000, body: { ...scope, mode, ...(turn ? { turnId: turn.id } : { source }) } })
    if (turn) { setSourceId(p.source.id); setTitle(p.source.title); setText(turn.user); setPrivate(true) }
    setPreview(p); setReviewing(false); setClaimsText(JSON.stringify(p.facts.filter(e => e.fact && e.enabled).map(e => ({ subject: e.fact!.subject, predicate: e.fact!.predicate, value: e.fact!.value, quote: e.fact!.quote, start: e.fact!.start })), null, 2))
    } finally { pending.current = null }
  }
  return <section className="mb-card" aria-label="事实 Wiki" style={{ overflowWrap: 'anywhere' }}><div className="mb-section-head"><h3>事实 Wiki</h3><span className="mb-tag">{pages?.pages.length ?? 0} 个主题</span></div>
    {book&&<WikiCompilation characterId={characterId} sessionId={sessionId} book={book} update={update} budgetMs={modelBudgetMs}/>}
    {book && <OrganizationReview characterId={characterId} sessionId={sessionId} revision={book.revision} update={update} />}
    <p className="mb-muted">任何有依据的事实都可以整理：项目、技术、用户偏好、关系与经历。先核对事实和原文，再应用；知识按需进入对话。</p>
    {error && <p role="alert">{error}</p>}
    {busy && pending.current && <button onClick={() => pending.current?.abort()}>停止整理</button>}
    <details><summary>整理事实来源</summary><fieldset disabled={busy}>
      <label>资料名称<input aria-label="Wiki 资料名称" value={title} onChange={e => { setTitle(e.target.value); changed() }} /></label>
      <label>事实资料<textarea aria-label="Wiki 事实资料" value={text} onChange={e => { setText(e.target.value); changed() }} placeholder={'# ALLMIND\n存储：本地文件\n# 用户\n饮品偏好：乌龙茶'} /></label>
      <label><input type="checkbox" checked={privateSource} onChange={e => { setPrivate(e.target.checked); changed() }} />仅当前用户与角色可用（默认）</label>
      <details><summary>更新同一来源</summary><label>来源 ID<input aria-label="Wiki 来源 ID" value={sourceId} onChange={e => { setSourceId(e.target.value); changed() }} /></label><small>更新保留同一 ID；新资料使用新的 ID。</small></details>
      <div className="mb-row"><button disabled={!title.trim() || !text.trim()} onClick={() => void work(() => prepare('declarations'))}>预览事实整理</button><button disabled={!title.trim() || !text.trim() || !modelAvailable} onClick={() => void work(() => prepare('model'))}>AI 整理并预览</button></div>
      <small>AI 整理使用已绑定的整理模型，原文会发送至该来源；仅生成待核对草稿。</small>
      {!!turns.length && <button disabled={!modelAvailable} onClick={() => void work(() => prepare('model', turns.at(-1)!))}>整理最近一条用户消息</button>}
      {preview && <div><h4>事实与更新预览</h4>{preview.facts.filter(e => e.enabled).map(entry => <article key={entry.id}><p>{entry.body}</p><small>原文：{entry.fact?.quote} · 来源中的陈述，尚未独立核实</small></article>)}<ul>{preview.changes.map(c => <li key={c.id}>{changeLabels[c.action]} · {c.reason}</li>)}</ul></div>}
      {!!claimsText && <details><summary>修正事实草稿</summary><textarea aria-label="Wiki 事实草稿" value={claimsText} onChange={e => { setClaimsText(e.target.value); setPreview(null); setReviewing(true) }} /><button onClick={() => void work(() => prepare('declarations'))}>校验修正后的草稿</button></details>}
      {preview && <button onClick={() => void work(async publish => { const result = await api<{ book: BookSnapshot }>('/wiki/apply', { method: 'POST', body: { ...scope, previewId: preview.id, operationId: crypto.randomUUID() } }); publish(result.book); setPreview(null); setClaimsText(''); setText(''); setSourceId('source-' + crypto.randomUUID()); setIssues([]) })}>确认事实并应用</button>}
    </fieldset></details>
    <div className="mb-row"><button disabled={busy} onClick={() => void work(async () => setIssues((await api<{ issues: WikiIssue[] }>('/wiki/lint' + query)).issues))}>检查 Wiki</button><small>检查来源、冲突、过期和断链；不自动猜测修复。</small></div>
    <div className="mb-row"><label>查询个人 Wiki<input value={searchText} onChange={e=>setSearchText(e.target.value)}/></label><button disabled={busy||!searchText.trim()} onClick={()=>void work(async()=>setPages(await api<Pages>('/wiki/query?'+new URLSearchParams({...scope,query:searchText}))))}>搜索 Wiki</button><button disabled={busy} onClick={()=>void work(async publish=>{const current=await api<BookSnapshot>('/book'+query);const result=await api<Pages&{book:BookSnapshot}>('/wiki/refresh',{method:'POST',body:{...scope,expectedRevision:current.revision,operationId:crypto.randomUUID()}});publish(result.book);setPages(result)})}>刷新编纂与关联</button></div>
    <p className="mb-muted">已编纂 {pages?.compiledCount??0} 个个人主题。页面引用有效事实并维护版本；已撤销或冲突的内容不进入当前理解。</p>
    {issues.map((issue, i) => <p key={i}>{issueLabels[issue.code] ?? '需要检查'} · {issue.message}<small>{issue.entryIds.join(', ')}</small></p>)}
    {pages?.pages.map(page => <details key={page.id} id={`wiki-${page.id}`}><summary>{page.subject}{page.kind?` · 编纂主题 r${page.revision}`:''} · {page.entryIds.length} 条事实</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{page.body}</pre><small>来源：{page.sourceIds.join(', ')}</small>{!!page.links?.length&&<p>关联：{page.links.map(id=><button key={id} disabled={busy} onClick={()=>void work(async()=>{setPages(await api<Pages>('/wiki'+query));setSelectedPage(id)})}>{pages.pages.find(other=>other.id===id)?.subject??'打开关联主题'}</button>)}</p>}{!!page.backlinks?.length&&<small>反向关联 {page.backlinks.length} 个主题</small>}{!!page.history?.length&&<details><summary>历史编纂版本</summary><small>历史版本供回查，不作为当前召回依据。</small>{page.history.map(version=><article key={version.revision}><b>r{version.revision}</b><pre style={{whiteSpace:'pre-wrap'}}>{version.body}</pre><small>依据：{version.basisRefs.map(ref=>ref.entryId).join(', ')}</small></article>)}</details>}</details>)}
    {!!book?.wikiSources?.length && <details><summary>来源与版本</summary>{book.wikiSources.map(source => <article key={source.id} id={'wiki-source-'+source.id}><b>{source.title}</b><small style={{ overflowWrap: 'anywhere' }}>{source.id} · {source.snapshots.length} 个快照 · {source.enabled ? '有效' : '已撤销'}</small><details><summary>回查原始来源</summary>{source.snapshots.map(snapshot => <article key={snapshot.hash}><small style={{ overflowWrap: 'anywhere' }}>{snapshot.capturedAt} · {snapshot.hash === source.hash ? '当前版本' : '历史版本'}</small><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{snapshot.text}</pre></article>)}</details>{source.enabled && <button disabled={busy} onClick={event => {revokeTrigger.current=event.currentTarget;setRevocation({id:source.id,title:source.title,revision:book.revision,facts:book.entries.filter(entry=>entry.enabled&&entry.fact?.sourceId===source.id).length,pages:pages?.pages.filter(page=>page.sourceIds.includes(source.id)).length??0})}}>撤销来源</button>}</article>)}</details>}
    <dialog ref={revokeDialog} aria-labelledby="revoke-source-title" onCancel={()=>setRevocation(null)}>
      {revocation&&<><h3 id="revoke-source-title">确认撤销来源</h3><p>来源：{revocation.title}</p><p>涉及 {revocation.facts} 条有效事实、当前视图 {revocation.pages} 个关联主题。依赖此来源的事实与派生内容将停止消费；其他独立有效依据仍保留。</p><p>来源原文和历史快照保留，本操作不会删除云端聊天。</p><div className="mb-row"><button type="button" disabled={busy} onClick={()=>setRevocation(null)}>取消</button><button type="button" disabled={busy} onClick={()=>void work(async publish=>{try{const result=await api<{book:BookSnapshot}>('/wiki/revoke',{method:'POST',body:{...scope,sourceId:revocation.id,expectedRevision:revocation.revision,operationId:crypto.randomUUID()}});publish(result.book);setIssues([])}finally{setRevocation(null)}})}>确认撤销来源</button></div></>}
    </dialog>
  </section>
}

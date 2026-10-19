import type {EntryTimeFilter} from '../../../../memory/book-time-filter'
import type {KnowledgeCategory} from '../../../../memory/knowledge-category'
import type {GraphControls} from './GraphCanvas'
const GraphCanvas=lazy(()=>import('./GraphCanvas'))
import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react'
import type {BookEntry,WikiSource} from '../../../../contracts/memory-book'
import type {WikiGraph} from '../../../../memory/fact-wiki'
import {api} from '../book-api'
import {knowledgeCategoryLabels} from '../../../../memory/knowledge-category'
import type {BuiltBookContext} from '../../../../memory/book-recall'

type NodeKind = WikiGraph['nodes'][number]['kind']
const labels: Record<NodeKind, string> = { page: '知识主题', source: '原始来源', entry: '独立设定' }
const structureFilters: { id: 'all' | NodeKind; label: string }[] = [
  { id: 'all', label: '全部节点' },
  { id: 'page', label: '知识主题' },
  { id: 'source', label: '原始来源' },
  { id: 'entry', label: '独立设定' },
]

export default function MemoryGraph({ characterId, sessionId, revision, time, category, query, onQuery, entries, entry, openPage,trace,sources=[] }: { characterId: string; sessionId: string; revision: number; time: EntryTimeFilter; category: KnowledgeCategory | 'all'; query: string; onQuery: (value: string) => void; entries: BookEntry[]; entry: (id: string) => void; openPage: (id: string) => void;trace?:BuiltBookContext|null;sources?:WikiSource[] }) {
  const [graph, setGraph] = useState<WikiGraph | null>(null), [error, setError] = useState(''), [unlinked, setUnlinked] = useState(true), [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<string | null>(null), [layoutSeed, setLayoutSeed] = useState(0), [structure, setStructure] = useState<'all' | NodeKind>('all')
  const [range,setRange]=useState<'known'|'management'>('known'),[recallView,setRecallView]=useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setGraph(null); setSelected(null); setError('')
    const params = new URLSearchParams({ characterId, sessionId, includeUnlinked: String(unlinked), timeBasis: time.basis, from: time.from, to: time.to })
    params.set('range',range)
    if (category !== 'all') params.set('category', category)
    if (query.trim()) params.set('q', query.trim())
    api<WikiGraph>('/wiki/graph?' + params, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setGraph(value) }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => controller.abort()
  }, [characterId, sessionId, revision, unlinked, time.basis, time.from, time.to, refresh, category, query,range])
  const controls=useRef<GraphControls>(null),[colorMode,setColorMode]=useState<'category'|'community'>('category'),[communityCount,setCommunityCount]=useState(0),[expanded,setExpanded]=useState(false)
  const workspace=useRef<HTMLElement>(null)
  useEffect(()=>{if(!expanded)return;const previous=document.activeElement,overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const handle=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setExpanded(false)}if(event.key==='Tab'){const items=[...workspace.current!.querySelectorAll<HTMLElement>('button,input,select,summary')].filter(item=>item.getClientRects().length&&!item.hasAttribute('disabled')),first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}};
    document.addEventListener('keydown',handle);return()=>{document.removeEventListener('keydown',handle);document.body.style.overflow=overflow;if(previous instanceof HTMLElement&&previous.isConnected)previous.focus()};
  },[expanded])
  const view = useMemo(() => {
    const nodes = graph?.nodes ?? [], edges = graph?.edges ?? []
    if (structure === 'all') return { nodes, edges, context: new Set<string>() }
    const primary = new Set(nodes.filter(node => node.kind === structure).map(node => node.id))
    const context = new Set<string>()
    for (const edge of edges) {
      if (primary.has(edge.from) && !primary.has(edge.to)) context.add(edge.to)
      if (primary.has(edge.to) && !primary.has(edge.from)) context.add(edge.from)
    }
    const ids = new Set([...primary, ...context])
    return { nodes: nodes.filter(node => ids.has(node.id)), edges: edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), context }
  }, [graph, structure])
  const node = view.nodes.find(row => row.id === selected) ?? graph?.nodes.find(row => row.id === selected)
  const entryById = useMemo(() => new Map(entries.map(row => [row.id, row])), [entries])
  function fit(){controls.current?.fit()}
  const linked = node && graph ? graph.edges.filter(edge => edge.from === node.id || edge.to === node.id) : []
  const pageTarget = node?.kind === 'page' ? node.id : graph?.nodes.find(row => row.kind === 'page' && node?.entryIds.some(id => row.entryIds.includes(id)))?.id
  const traceValid=trace?.recall.scope.characterId===characterId&&trace.recall.scope.sessionId===sessionId&&trace.recall.bookRevision===revision
  const used=new Set(traceValid?trace!.consumed.map(ref=>ref.entryId):[])
  const originalSource=sources.find(source=>source.id===node?.sourceId&&source.enabled)
  return <section ref={workspace} role={expanded?'dialog':undefined} aria-modal={expanded?true:undefined} className={'knowledge-workspace'+(expanded?' is-expanded':'')} aria-label="知识与来源图谱">
    <div className="tac-card knowledge-main">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">知识与来源拓扑图谱</h3>
          <p className="text-[11px]" style={{ color: 'var(--mb-muted)' }}>颜色区分知识分类或连接社区，大小表示连接度；箭头表示语义方向，浅色线为来源引用。</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className="tac-btn py-1 px-2.5 text-xs font-mono-tech" aria-label="放大图谱" onClick={() => controls.current?.zoomIn()}>＋</button>
          <button type="button" className="tac-btn py-1 px-2.5 text-xs font-mono-tech" aria-label="缩小图谱" onClick={() => controls.current?.zoomOut()}>−</button>
          <button type="button" className="tac-btn py-1 px-2.5 text-xs" onClick={fit}>适应画布</button>
          <button type="button" className="tac-btn py-1 px-2.5 text-xs" onClick={() => setLayoutSeed(value => value + 1)}>重新布局</button><button type="button" className="tac-btn" onClick={()=>setExpanded(value=>!value)}>{expanded?'退出全屏':'全屏图谱'}</button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 graph-toolbar">
        <label>查看范围<select aria-label="图谱查看范围" value={range} onChange={event=>setRange(event.target.value as 'known'|'management')}><option value="known">角色已知范围</option><option value="management">管理范围（仅查看）</option></select></label>
        <button type="button" aria-pressed={!recallView} onClick={()=>setRecallView(false)}>知识结构</button><button type="button" aria-pressed={recallView} onClick={()=>setRecallView(true)}>本轮召回</button>
        <div className="flex flex-wrap gap-1.5" aria-label="图谱结构">
          {structureFilters.map(filter => <button type="button" key={filter.id} className={'tac-btn py-1 px-2.5 text-xs' + (structure === filter.id ? ' tac-btn-active' : '')} aria-pressed={structure === filter.id} onClick={() => setStructure(filter.id)}>{filter.label} · {filter.id === 'all' ? (graph?.nodes.length ?? 0) : (graph?.nodes.filter(row => row.kind === filter.id).length ?? 0)}</button>)}
        </div>
        <label className="graph-color-control">着色<select aria-label="图谱着色" value={colorMode} onChange={event=>setColorMode(event.target.value as 'category'|'community')}><option value="category">四类知识</option><option value="community">连接社区 · {communityCount}</option></select></label><input aria-label="搜索图谱节点" className="tac-input w-52 text-xs py-1" type="search" value={query} placeholder="查找主题、来源或设定…" onChange={event => onQuery(event.target.value)} />
        <label className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--mb-muted)' }}><input aria-label="显示未关联设定" type="checkbox" checked={unlinked} onChange={event => setUnlinked(event.target.checked)} />显示未关联设定</label>
      </div>
      <p className="mb-muted graph-scope-note">{range==='management'?'管理查看不改变角色知识视角，也不授权将这些内容发送给模型。':'仅展示当前角色知识视角内有效内容。'} {graph?.excluded?.map(row=>`${row.reason}：${row.count}`).join(' · ')}</p>
      {recallView&&<p role="status">{traceValid?`${trace!.status!=='consumed'?'编译预览':'当前轮次上下文'}：候选 ${trace!.recall.candidates.length}，已装配 ${trace!.consumed.length}；${trace!.status==='consumed'?'模型请求已完成':'是否实际使用以对应轮次投递回执为准'}`:'当前没有同角色、同会话、同修订的召回记录；不会重新检索冒充历史。'}</p>}
      <p className="font-mono-tech text-[11px]" role="status" style={{display:structure==='all'?'none':undefined,color:'var(--mb-muted)'}}>结构筛选：{structureFilters.find(filter => filter.id === structure)?.label}{structure !== 'all' ? ` · 上下文 ${view.context.size}` : ''} <button type="button" className="underline" onClick={() => setStructure('all')}>清除结构筛选</button></p>
      {error && <p role="alert">{error}<button type="button" className="tac-btn py-1 px-2.5 text-xs" onClick={() => setRefresh(value => value + 1)}>重新读取图谱</button></p>}
      {!graph && !error && <p role="status">正在读取有效图谱…</p>}
      {graph && <>
        <p role="status" className={graph.omittedNodes||graph.omittedEdges?'graph-limit-warning':'graph-redundant-count'} style={{ color: 'var(--mb-muted)' }}>匹配 {graph.matchedCount} · 上下文 {graph.contextCount} · 可见 {graph.visibleCount}{graph.omittedNodes > 0 || graph.omittedEdges > 0 ? ` · 未展示节点 ${graph.omittedNodes}、连线 ${graph.omittedEdges}（上限 128 / 2048，不是全部）` : ''}</p>
        <div className="rounded-lg border overflow-hidden relative" style={{ background: 'var(--mb-bg)', borderColor: 'var(--mb-line)', height: 'clamp(520px, 68vh, 850px)' }}>
          {view.nodes.length === 0 ? <div className="mb-empty"><h3>{query.trim() ? '没有匹配节点' : '当前没有可见的有据关联'}</h3><p>可调整搜索、分类和结构筛选。没有依据时保持空白，不会补造关系。</p></div> : <Suspense fallback={<p role="status">正在加载图谱…</p>}><GraphCanvas ref={controls} nodes={view.nodes} edges={view.edges} seed={layoutSeed} selected={selected} onSelect={setSelected} colorMode={colorMode} onCommunities={setCommunityCount} highlight={recallView&&traceValid?new Set(view.nodes.filter(row=>row.entryIds.some(id=>used.has(id))).map(row=>row.id)):new Set()}/></Suspense>}
          <div className="absolute bottom-2.5 left-3 font-mono-tech text-[10px] px-2 py-1 rounded border" style={{ background: 'var(--mb-surface)', borderColor: 'var(--mb-line)', color: 'var(--mb-muted)' }}>{view.nodes.length} 个可见节点 · {view.edges.length} 条有据连线 · 点击节点检视依据</div>
        </div>
      </>}
    </div>
    <aside className="tac-card knowledge-detail" id="mb-graph-detail"><details open><summary>分类与节点目录</summary>{Object.entries(knowledgeCategoryLabels).map(([category,title])=><details key={category}><summary>{title} · {view.nodes.filter(row=>row.categories.includes(category as KnowledgeCategory)).length}</summary>{view.nodes.filter(row=>row.categories.includes(category as KnowledgeCategory)).map(row=><button type="button" key={row.id} className="tac-btn w-full text-left" aria-pressed={selected===row.id} onClick={()=>setSelected(row.id)}>{row.title}</button>)}</details>)}</details>
      <div className="border-b pb-3" style={{ borderColor: 'var(--mb-line)' }}>
        <span className="font-mono-tech text-[10px] uppercase tracking-wider block" style={{ color: 'var(--mb-accent)' }}>节点详情</span>
        <h3 className="text-base font-bold mt-0.5">{node?.title ?? '选择一个节点'}</h3>
        {node && <div className="flex gap-2 mt-1.5 flex-wrap"><span className="tac-badge tac-badge-cyan">{labels[node.kind]} · {node.pageType==='entity'?'实体':node.pageType==='event'?'事件':node.pageType==='topic'?'主题':node.kind==='source'?'来源':'未分类页'}</span>{node.categories.map(item => <span key={item} className="tac-badge">{knowledgeCategoryLabels[item]}</span>)}{node.sourceId && <span className="tac-badge">来源 {node.sourceId}</span>}</div>}
      </div>
      {!node && <p className="text-xs" style={{ color: 'var(--mb-muted)' }}>选择节点查看原文、依据修订和来源。没有依据时这里保持空白。</p>}
      {originalSource&&<details open><summary>原始来源 · r{originalSource.revision}</summary><pre className="mb-graph-body">{originalSource.snapshots.find(snapshot=>snapshot.hash===originalSource.hash)?.text}</pre></details>}{node&&node.kind!=='source'&&<details open><summary>节点内容与依据</summary>{node.entryIds.map(id=>{const row=entryById.get(id);return row?<article key={id}><b>{row.title}</b>{row.knowledge&&<small> · {row.knowledge.worldId}/{row.knowledge.branch} · 章节{row.knowledge.chapter}</small>}<pre className="mb-graph-body">{row.body}</pre></article>:null})}</details>}{node && <div className="space-y-2 text-xs" style={{ color: 'var(--mb-muted)' }}>{node.entryIds.length === 0 && <p>此节点没有挂接条目。</p>}{node.entryIds.map((id, index) => { const row = entryById.get(id); const basis = linked.flatMap(edge => edge.basisRefs).find(ref => ref.entryId === id); const stale = basis && row && basis.revision !== row.revision; return <div key={id}><p>{row?.title || id}{row ? ` · 当前修订 ${row.revision}` : ' · 条目不在当前书中'}{basis ? ` · 依据修订 ${basis.revision}` : ''}{stale ? ' · 依据已过期' : ''}</p><button type="button" className="tac-btn py-1 px-2.5 text-xs" onClick={() => entry(id)}>查看原文 {index + 1}</button></div> })}</div>}
      {node && <div className="p-3 rounded-lg border space-y-1.5 text-xs" style={{ background: 'var(--mb-bg)', borderColor: 'var(--mb-line)' }}><div className="font-mono-tech text-[10px] uppercase" style={{ color: 'var(--mb-accent)' }}>LINKED NODES // 关联拓扑</div>{linked.length === 0 && <p>没有有据连线。</p>}{linked.map((edge, index) => { const other = graph?.nodes.find(row => row.id === (edge.from === node.id ? edge.to : edge.from)); return <p key={index} className="font-mono-tech text-[11px]">{edge.kind === 'semantic' ? '→' : edge.kind === 'source' ? '⇢' : '—'} {other?.title ?? '未知节点'} · {edge.kind === 'source' ? '来源引用' : edge.kind === 'semantic' ? '语义：' + (edge.label || '未命名') : '页面关联'} · {edge.basisRefs.length} 条依据{edge.basisRefs.some(ref => { const current = entryById.get(ref.entryId); return current && current.revision !== ref.revision }) ? ' · 依据已过期' : ''}</p> })}</div>}
      <button type="button" className="tac-btn tac-btn-primary w-full text-xs" disabled={!pageTarget||range==='management'} onClick={() => pageTarget && openPage(pageTarget)}>{pageTarget ? '在图文 Wiki 中阅读全文 →' : '当前节点没有可定位的知识页'}</button>
    </aside>
  </section>
}

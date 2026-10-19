import type { BuiltBookContext } from '../../../../memory/book-recall'

export function contextEntries(trace: BuiltBookContext) {
  return [...new Map([...trace.recall.base, ...trace.recall.selected]
    .filter(item => trace.consumed.some(ref => ref.chunkId === item.candidate.ref.chunkId))
    .map(item => [item.entry.id, item])).values()]
}
export default function BookTrace({ trace }: { trace: BuiltBookContext }) {
  const entries = contextEntries(trace)
  const titles = new Map([...trace.recall.base, ...trace.recall.selected].map(item => [item.entry.id, item.entry.title]))
  return <div className="mb-trace">
    <div className="mb-metrics"><div><b>{trace.recall.candidates.length}</b><span>检索候选</span></div><div><b>{entries.length}</b><span>使用的条目</span></div><div><b>{Math.round(trace.recall.timings.total ?? 0)}<small> ms</small></b><span>召回耗时</span></div></div>
    <p className="mb-query">“{trace.recall.query}”</p>
    <p role="status">{trace.status==='consumed'?'该轮模型请求已完成；以下是实际发送的上下文。':'这是已装配上下文；尚未确认模型实际使用。'}</p>
    <p className="mb-muted">{trace.recall.enhancement === 'local' ? '本地检索' : trace.recall.enhancement === 'planned' ? 'Fast LLM 已参与规划' : trace.recall.enhancement === 'no-retrieval' ? '规划器建议不新增检索' : '增强失败，已明确降级'} · {trace.usedTokens} 预算单位</p>
    {trace.recall.enhancementError && <p role="alert" className="mb-error">{trace.recall.enhancementError}</p>}
    {trace.relationshipUsed&&<details><summary>本轮相处依据 · r{trace.relationshipUsed.revision}</summary><small>独立于查询召回的实例沟通偏好与关系规则；仍计入输入预算。</small><pre>{JSON.stringify(trace.relationshipUsed.basisRefs,null,2)}</pre></details>}
    {!!trace.compiledPagesUsed?.length&&<><h3>本轮个人 Wiki</h3>{trace.compiledPagesUsed.map(page=><article key={page.id}><b>{page.id} · r{page.revision}</b><small>有效事实依据：{page.basisRefs.map(ref=>`${titles.get(ref.entryId)||ref.entryId} r${ref.revision}`).join('、')}</small></article>)}</>}
    <h3>本轮上下文</h3>{entries.length ? entries.map(item => <article className="mb-memory-hit" key={item.entry.id}>
      <div className="mb-row"><b>{item.entry.title || item.entry.id}</b><span className="mb-tag">{item.entry.type}</span><span className="mb-tag ok">已注入</span></div>
      <p>{item.text}</p><small>{item.candidate.matchReasons.join(' · ') || (item.entry.type === 'persona' ? '人格常驻' : '常驻 / 活跃记忆')}</small>
    </article>) : <p className="mb-muted">本轮没有注入记忆条目。</p>}
    <details><summary>候选、分数与省略原因</summary><p className="mb-muted">分数用于排序，不代表概率。常驻内容不一定出现在搜索候选中。</p>
      {trace.recall.candidates.map(item => <article className="mb-candidate" key={item.ref.chunkId}><div className="mb-row"><b>{titles.get(item.ref.entryId) || item.ref.entryId}</b><span className="mb-tag">{trace.consumed.some(ref => ref.chunkId === item.ref.chunkId) ? '已注入' : '未注入'}</span><code>{item.fusionScore.toFixed(5)}</code></div><small>{item.routes.join(' / ')} · {item.matchReasons.join(' · ')}</small><small>{item.ref.chunkId} · 原始分 {JSON.stringify(item.rawScores)} · 估算 {item.tokenCost ?? '—'}</small></article>)}
      <pre>{JSON.stringify({ excluded: trace.recall.excluded, rejected: trace.recall.rejected, omissions: trace.omissions }, null, 2)}</pre>
    </details>
    <details><summary>查询计划与流程耗时</summary><pre>{JSON.stringify({ plan: trace.recall.plan, timings: trace.recall.timings, bookRevision: trace.recall.bookRevision }, null, 2)}</pre></details>
    {trace.compilation&&<section aria-label="Prompt 编译与投递"><h3>Prompt Inspector</h3><p>{trace.compilation.status==='consumed'?'模型请求已完成':'编译预览，尚未确认模型使用'} · {trace.compilation.transport==='web-text'?'网页文本兼容':'API messages'} · {trace.compilation.presetId} r{trace.compilation.presetRevision}</p><p>估算 {trace.compilation.estimatedTokens} / {trace.compilation.inputBudget} · 当前用户消息位置 {trace.compilation.currentMessageIndex}</p><pre>{JSON.stringify({items:trace.compilation.items,parameters:trace.compilation.parameters,warnings:trace.compilation.warnings,omissions:trace.compilation.omissions},null,2)}</pre></section>}
    <details><summary>最终 Prompt / Context</summary><pre>{JSON.stringify(trace.messages, null, 2)}</pre></details>
  </div>
}

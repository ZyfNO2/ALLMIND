import { useEffect, useRef, useState } from 'react'
import type { BookSnapshot, RuntimeConfig } from '../../../../contracts/memory-book'
import type { SynthesisJob, SynthesisPage, SynthesisPageReview } from '../../../../contracts/wiki-synthesis'
import {synthesisPageCategory,knowledgeCategoryOrder,knowledgeCategoryLabels} from '../../../../memory/knowledge-category'
import { api } from '../book-api'

const statusText: Record<SynthesisJob['status'], string> = { prepared:'材料已准备', running:'正在整理', review:'等待核对', applied:'已应用', failed:'失败，未应用', cancelled:'已取消', stale:'依据已变化' }
export default function WikiSynthesis({ characterId, sessionId, book, config, configDirty, onConfig, update }: {
  characterId: string; sessionId: string; book: BookSnapshot; config: RuntimeConfig; configDirty: boolean;
  onConfig: (next:RuntimeConfig)=>void; update: (next:BookSnapshot)=>void
}) {
  const [jobs,setJobs]=useState<SynthesisJob[]>([]),[job,setJob]=useState<SynthesisJob|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmed,setConfirmed]=useState(false),[minutes,setMinutes]=useState(10)
  const role=config.characters.find(row=>row.id===characterId),scope={characterId,sessionId},query='?'+new URLSearchParams(scope),scopeKey=characterId+':'+sessionId,current=useRef(scopeKey)
  const [world,setWorld]=useState(''),[branch,setBranch]=useState(''),[cutoff,setCutoff]=useState(0)
  const applyId=useRef(''),abort=useRef<AbortController|null>(null)
  const [sendConsent,setSendConsent]=useState(false),[retryFailed,setRetryFailed]=useState(false)
  const [reviews,setReviews]=useState<Record<string,SynthesisPageReview>>({})
  useEffect(()=>{setReviews({});setConfirmed(false);applyId.current=''},[scopeKey,job?.id])
  function pageReview(page:SynthesisPage):SynthesisPageReview{
    return reviews[page.id]??job?.review?.find(row=>row.pageId===page.id)??{pageId:page.id,category:synthesisPageCategory(page,book.entries),corePersona:false}
  }
  function reviewPage(page:SynthesisPage,patch:Partial<SynthesisPageReview>){
    const next={...pageReview(page),...patch};if(next.category!=='persona')next.corePersona=false
    setReviews(rows=>({...rows,[page.id]:next}));setConfirmed(false);applyId.current=''
  }
  useEffect(()=>{
    current.current=scopeKey;setJob(null);setJobs([]);setError('');setNotice('');setConfirmed(false);setSendConsent(false);setBusy(false);applyId.current=''
    const sample=book.entries.find(row=>row.knowledge)?.knowledge
    setWorld(role?.knowledgeView?.worldId??sample?.worldId??'');setBranch(role?.knowledgeView?.branch??sample?.branch??'main');setCutoff(role?.knowledgeView?.cutoff??Math.max(0,...book.entries.flatMap(row=>row.knowledge?[row.knowledge.chapter]:[])))
    const controller=new AbortController()
    void api<{jobs:SynthesisJob[]}>('/wiki/synthesis'+query,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted){setJobs(result.jobs);setJob(result.jobs.at(-1)??null)}}).catch(error=>{if(!controller.signal.aborted)setError(String(error))})
    return()=>{controller.abort();abort.current?.abort();current.current=''}
  },[scopeKey])
  async function work(fn:()=>Promise<void>){if(busy)return;const key=scopeKey;setBusy(true);setError('');try{await fn()}catch(error){if(current.current===key)setError(error instanceof Error?error.message:String(error))}finally{if(current.current===key)setBusy(false)}}
  async function refresh(){const value=await api<{jobs:SynthesisJob[]}>('/wiki/synthesis'+query);if(current.current!==scopeKey)return;setJobs(value.jobs);setJob(value.jobs.find(row=>row.id===job?.id)??value.jobs.at(-1)??null)}
  const binding=config.wikiModel??config.fastModel
  async function useMain(){
    if(!config.mainModel)throw Error('请先配置并保存文字主模型。')
    const result=await api<{config:RuntimeConfig;activationError:string|null}>('/runtime',{method:'PUT',body:{config:{...config,wikiModel:{...config.mainModel}},expectedRevision:config.revision,operationId:crypto.randomUUID()}})
    if(current.current===scopeKey){onConfig(result.config);setJob(null);setNotice(result.activationError??'已选择文字主模型作为整理来源；仍需单次发送确认，不启用自动记忆。')}
  }
  const [inputTokens,setInputTokens]=useState(binding?.inputTokens??262144),[outputTokens,setOutputTokens]=useState(binding?.outputTokens??32768)
  useEffect(()=>{setInputTokens(binding?.inputTokens??262144);setOutputTokens(binding?.outputTokens??32768)},[config.revision])
  async function saveBudget(){
    if(!binding)return
    const next={...config,wikiModel:{...binding,inputTokens,outputTokens}},result=await api<{config:RuntimeConfig;activationError:string|null}>('/runtime',{method:'PUT',body:{config:next,expectedRevision:config.revision,operationId:crypto.randomUUID()}})
    if(current.current===scopeKey){onConfig(result.config);setJob(null);setNotice(result.activationError??'整理预算已保存，请重新准备材料。')}
  }
  async function saveEffort(value:string){
    if(!binding||binding.kind==='chatgpt-web')return
    const chosen={...binding};if(value)chosen.reasoningEffort=value as 'low'|'medium'|'high';else delete chosen.reasoningEffort
    const next={...config,wikiModel:chosen},result=await api<{config:RuntimeConfig;activationError:string|null}>('/runtime',{method:'PUT',body:{config:next,expectedRevision:config.revision,operationId:crypto.randomUUID()}})
    if(current.current===scopeKey){onConfig(result.config);setJob(null);setNotice(result.activationError??'整理模型参数已保存，请重新准备材料。')}
  }
  const needsView=!role?.knowledgeView&&book.entries.some(row=>row.knowledge&&row.enabled)
  async function saveView(){
    const next=structuredClone(config);next.characters=next.characters.map(row=>row.id===characterId?{...row,knowledgeView:{worldId:world,branch,cutoff}}:row)
    const result=await api<{config:RuntimeConfig;activationError:string|null}>('/runtime',{method:'PUT',body:{config:next,expectedRevision:config.revision,operationId:crypto.randomUUID()}})
    if(current.current!==scopeKey)return;onConfig(result.config);setJob(null);setNotice(result.activationError??'已明确保存知情范围，请重新准备材料。')
  }
  async function prepare(){const result=await api<{job:SynthesisJob}>('/wiki/synthesis/prepare',{method:'POST',body:{...scope,expectedRevision:book.revision,operationId:crypto.randomUUID()}});if(current.current!==scopeKey)return;setJob(result.job);setJobs(rows=>[...rows,result.job]);setConfirmed(false);applyId.current='';setNotice('已准备完整材料、规范和schema；尚未发送模型。')}
  async function download(){if(!job)return;const result=await api<{zipBase64:string}>('/wiki/synthesis/package',{method:'POST',body:{...scope,jobId:job.id}});if(current.current!==scopeKey)return;const bytes=Uint8Array.from(atob(result.zipBase64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'})),link=document.createElement('a');link.href=url;link.download='ALLMIND-Wiki-Task.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
  async function generate(){if(!job)return;const controller=new AbortController();abort.current=controller;setConfirmed(false);setNotice('由ALLMIND发送完整材料与规范，结果须经独立校验；不自动重发。');try{const result=await api<{job:SynthesisJob}>('/wiki/synthesis/run',{method:'POST',signal:controller.signal,timeoutMs:minutes*60000+30000,body:{...scope,jobId:job.id,budgetMs:minutes*60000,confirmedSend:sendConsent}});if(current.current===scopeKey){setJob(result.job);setNotice('结构、逐字依据、资料域与覆盖校验通过，请核对内容含义。')}}finally{abort.current=null;if(current.current===scopeKey)await refresh()}}
  async function cancel(){if(!job)return;try{const value=await api<{job:SynthesisJob}>('/wiki/synthesis/cancel',{method:'POST',body:{...scope,jobId:job.id}});abort.current?.abort();if(current.current===scopeKey){setJob(value.job);setNotice('已取消本地整理；提交后的远端请求仍需来源回执确认，不会重发。')}}catch(error){setError(String(error))}}
  async function resume(){if(!job)return;const result=await api<{job:SynthesisJob}>('/wiki/synthesis/resume',{method:'POST',timeoutMs:190000,body:{...scope,jobId:job.id,confirmed:true}});if(current.current===scopeKey){setJob(result.job);setConfirmed(false);setNotice('已读取并独立校验原请求结果，没有发送新消息。')}}
  async function continueBatches(){if(!job)return;const controller=new AbortController();abort.current=controller;try{const result=await api<{job:SynthesisJob}>('/wiki/synthesis/continue',{method:'POST',signal:controller.signal,timeoutMs:minutes*60000+30000,body:{...scope,jobId:job.id,budgetMs:minutes*60000,confirmedSend:sendConsent,retryFailed}});if(current.current===scopeKey){setJob(result.job);setRetryFailed(false);setNotice('已保留通过的批次并完成剩余检查，请审核完整结果。')}}finally{abort.current=null;if(current.current===scopeKey)await refresh()}}
  async function saveOutputMode(value:string){if(!binding)return;const result=await api<{config:RuntimeConfig}>('/runtime',{method:'PUT',body:{config:{...config,wikiModel:{...binding,structuredOutput:value}},expectedRevision:config.revision,operationId:crypto.randomUUID()}});onConfig(result.config);setJob(null);setNotice('已保存结构化输出方式，请重新准备材料。不会因服务拒绝而自动切换方式或重发。')}
  async function apply(){if(!job)return;applyId.current||=crypto.randomUUID();const result=await api<{book:BookSnapshot}>('/wiki/synthesis/apply',{method:'POST',body:{...scope,jobId:job.id,expectedRevision:job.expectedRevision,operationId:applyId.current,confirmed,review:job.result?.pages.map(pageReview)}});if(current.current!==scopeKey)return;update(result.book);await refresh();setConfirmed(false);setNotice('已应用核对后的分类与核心人设选择，原始条目保持原样。')}
  return <section className="mb-card" aria-label="日常整理"><h2>日常整理</h2><p>按完整规范综合当前角色资料，生成知识页、语义关系与覆盖清单。模型先自检，ALLMIND再独立校验，核对后才应用。</p>
    <p className="mb-muted">整理来源：{binding?.model??'尚未绑定'} · {binding?.kind==='chatgpt-web'?'发送前必须确认 High，并上传带schema与自检脚本的任务包':`API effort：${binding?.reasoningEffort??'服务默认（未额外设置）'}`}</p>
    <button type="button" disabled={busy||configDirty||!config.mainModel} onClick={()=>void work(useMain)}>使用文字主模型整理</button>
    {binding&&<details><summary>整理输入与输出预算</summary><p>按所选模型实际窗口设置。完整资料超预算会在发送前拒绝，不静默截断；这里仅调整整理模型。</p><label>整理模型窗口<input type="number" min="512" max="1000000" disabled={busy||configDirty} value={inputTokens} onChange={e=>setInputTokens(Number(e.target.value))}/></label><label>整理输出预留<input type="number" min="1" max="128000" disabled={busy||configDirty} value={outputTokens} onChange={e=>setOutputTokens(Number(e.target.value))}/></label><button disabled={busy||configDirty} onClick={()=>void work(saveBudget)}>保存整理预算</button></details>}
    {binding&&binding.kind!=='chatgpt-web'&&<details><summary>整理 API 的思考参数</summary><p>仅在已确认服务支持 reasoning_effort 时选择；不支持会如实失败，不自动删除参数重试。</p><label>API reasoning effort<select disabled={busy||configDirty} value={binding.reasoningEffort??''} onChange={e=>void work(()=>saveEffort(e.target.value))}><option value="">不发送额外参数</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label></details>}
    {binding&&binding.kind!=='chatgpt-web'&&<section className="mb-card"><h3>整理 API 输出能力</h3><p>普通聊天成功不代表能完成严格 Wiki。模式由你明确选择；服务拒绝参数、字段缺失、引用不一致或截断都会失败，不自动换模型或补造结果。</p><label>结构化输出方式<select disabled={busy||configDirty} value={binding.structuredOutput??'json-object'} onChange={event=>void work(()=>saveOutputMode(event.target.value))}><option value="json-object">JSON 对象（兼容模式）</option><option value="json-schema">JSON Schema（服务需明确支持）</option><option value="prompt">仅提示词约束（服务不接受格式参数时）</option></select></label><p>当前模型的严格编纂能力：以本模型实际校验结果为准。建议先用少量无敏感信息的材料验证，再处理完整资料；批次失败保留原输出与错误。</p></section>}
    {needsView&&<fieldset disabled={busy||configDirty}><legend>先确认角色知情范围</legend><p>当前角色未设置范围；以下由资料推导为建议，保存后才使用。章节越大，允许的剧透越多。</p><label>作品 ID<input value={world} onChange={e=>setWorld(e.target.value)}/></label><label>分支 ID<input value={branch} onChange={e=>setBranch(e.target.value)}/></label><label>已知章节截止点<input type="number" min="0" max="1000000" value={cutoff} onChange={e=>setCutoff(Number(e.target.value))}/></label><button onClick={()=>void work(saveView)}>确认并保存知情范围</button></fieldset>}
    <label><input type="checkbox" checked={sendConsent} disabled={busy} onChange={e=>setSendConsent(e.target.checked)}/>允许把本次角色整理材料发送给上方整理模型（不启用自动记忆）</label>
    {configDirty&&<p role="status">请先保存或放弃当前设置草稿，再准备整理任务。</p>}
    <div className="mb-row"><button disabled={busy||needsView||configDirty} onClick={()=>void work(prepare)}>准备当前角色整理材料</button><button disabled={busy} onClick={()=>void work(refresh)}>回读整理任务</button></div>
    {jobs.length>1&&<label>整理任务<select value={job?.id??''} disabled={busy} onChange={e=>{setJob(jobs.find(row=>row.id===e.target.value)??null);setConfirmed(false);applyId.current=''}}>{jobs.map(row=><option key={row.id} value={row.id}>{statusText[row.status]} · {new Date(row.createdAt).toLocaleString()}</option>)}</select></label>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {job&&<><p>任务状态：{statusText[job.status]} · 原始材料 {job.basis.length} 条</p>{job.error&&<p role="alert">{job.error}</p>}
      <p>{job.batchProgress?`分批校验：${job.batchProgress.completed} / ${job.batchProgress.total}；全部通过后才进入审核，不会逐批写入角色。`:""}</p><details><summary>材料与提示版本</summary><p>输入：{job.inputHash}</p><p>提示：{job.promptHash}</p>{job.preparedReceipt?.thinking&&<p>发送前页面核验：{job.preparedReceipt.thinking.label}（level {job.preparedReceipt.thinking.level}）</p>}{job.preparedReceipt?.taskArchiveSha256&&<p>已确认上传任务包：{job.preparedReceipt.taskArchiveSha256}</p>}</details>
      {['failed','cancelled'].includes(job.status)&&(job.batchProgress?.total??1)===1&&job.preparedReceipt?.requestId&&<button disabled={busy} onClick={()=>void work(resume)}>接续读取本次结果（不重发）</button>}
      {['failed','cancelled'].includes(job.status)&&job.checkpoints&&<section className="mb-card" aria-label="分批任务恢复"><p>已通过的 {job.checkpoints.filter(row=>row.result).length} 批将复用；继续时只读接续未确认网页回执，再发送尚未提交的批次。输入或配置变化会拒绝续办。</p><label><input type="checkbox" checked={retryFailed} onChange={event=>setRetryFailed(event.target.checked)}/>我已核对来源，明确允许重新请求失败或结果未知的批次；可能再次计费，通过的批次不重发。有失败输出时，会连同校验错误发送给同一整理模型修正</label><button type="button" disabled={busy||!sendConsent||configDirty} onClick={()=>void work(continueBatches)}>{retryFailed?'确认修正失败批次并继续':'接续回执并继续未提交批次'}</button><details><summary>失败批次与原始输出</summary>{job.checkpoints.map((checkpoint,index)=><article key={index}><h4>批次 {index+1} · {checkpoint.result?'已通过':checkpoint.attempted?'已尝试':'未提交'}</h4>{checkpoint.attempts.map((attempt,i)=><div key={i}><p>{attempt.error??'已收到输出'}</p>{attempt.response&&<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{attempt.response}</pre>}</div>)}</article>)}</details></section>}
      <div className="mb-row"><button disabled={busy||job.status!=='prepared'} onClick={()=>void work(download)}>下载规范与自检任务包</button><label>生成时限（分钟）<input type="number" min="1" max="45" value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></label><button disabled={busy||job.status!=='prepared'||!binding||!sendConsent||configDirty} onClick={()=>void work(generate)}>发送模型并生成整理草稿</button>{(busy||job.status==='running'||job.status==='review')&&<button onClick={()=>void cancel()}>取消本次整理</button>}</div>
      {job.result&&<><p>{job.result.pages.length} 个综合页 · {job.result.relations.length} 条语义关系 · 已引用材料 {job.result.coverage.filter(row=>row.pageIds.length).length}/{job.result.coverage.length} 条</p><p className="mb-muted">逐字证据与结构通过不等于语义一定正确；请检查推断、冲突、原作/私设和模拟记录。</p>
        {job.result.pages.map(page=><fieldset key={page.id} disabled={busy||job.status!=='review'}><legend>{page.title} · {page.domain} · {page.pageType==='entity'?'实体':page.pageType==='event'?'事件':'主题'}</legend>
          <label>归入分类<select aria-label={page.title+'：归入分类'} value={pageReview(page).category} onChange={e=>reviewPage(page,{category:e.target.value as SynthesisPageReview['category']})}>{knowledgeCategoryOrder.map(category=><option key={category} value={category}>{knowledgeCategoryLabels[category]}</option>)}</select></label>
          {pageReview(page).category==='persona'&&<label><input type="checkbox" checked={pageReview(page).corePersona} onChange={e=>reviewPage(page,{corePersona:e.target.checked})}/>将“{page.title}”作为核心人设启用（每轮注入）</label>}
          {pageReview(page).category==='persona'&&<p className="mb-muted">仅归类不会改变角色行为。核心人设默认关闭，启用前请核对措辞；所有核心人设合计最多 4 KiB，来源撤销后停止使用。模拟资料仍受当前召回模式限制。</p>}
          <details><summary>核对综合正文与逐字依据</summary>{page.paragraphs.map((paragraph,i)=><article key={i}><p style={{whiteSpace:'pre-wrap'}}>{paragraph.text}</p><details><summary>本段原文依据</summary>{paragraph.evidence.map((ref,j)=><blockquote key={j}>{ref.quote}<small>〔{ref.entryId}〕</small></blockquote>)}</details></article>)}</details>
        </fieldset>)}
        <details><summary>语义关系与覆盖</summary>{job.result.relations.map((row,i)=><p key={i}>{row.from} → {row.to}：{row.label}（{row.evidence.length} 条证据）</p>)}{job.result.coverage.filter(row=>!row.pageIds.length).map(row=><p key={row.entryId}>未采用 {row.entryId}：{row.reason}</p>)}</details>
        {job.status==='review'&&<><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对综合内容、原文依据、关系和未采用资料</label><button disabled={busy||!confirmed} onClick={()=>void work(apply)}>确认整理并应用</button></>}
      </>}
    </>}
  </section>
}

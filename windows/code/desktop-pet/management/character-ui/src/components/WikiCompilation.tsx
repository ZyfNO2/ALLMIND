import {useEffect,useRef,useState} from 'react'
import type {BookSnapshot} from '../../../../contracts/memory-book'
import type {WikiCompileJob} from '../../../../contracts/wiki-maintenance'
import {api} from '../book-api'
const statusLabels={pending:'待生成',running:'生成中',review:'待核对',applied:'已应用',failed:'失败',cancelled:'已取消'}

export default function WikiCompilation({characterId,sessionId,book,update,budgetMs}:{characterId:string;sessionId:string;book:BookSnapshot;update:(book:BookSnapshot)=>void;budgetMs?:number}){
  const [jobs,setJobs]=useState<WikiCompileJob[]>([]),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState<string[]>([])
  const generation=useRef(0),pending=useRef<AbortController|null>(null),scope={characterId,sessionId},query='?'+new URLSearchParams(scope)
  const pendingJob=useRef<string|null>(null)
  useEffect(()=>{const epoch=++generation.current,controller=new AbortController();setJobs([]);setSelected([]);setConfirmed([]);setBusy(false);setError('');api<{jobs:WikiCompileJob[]}>('/wiki/compilation'+query,{signal:controller.signal}).then(result=>{if(epoch===generation.current)setJobs(result.jobs)}).catch(e=>{if(!controller.signal.aborted&&epoch===generation.current)setError(e.message)});return()=>{generation.current++;controller.abort();pending.current?.abort()}},[characterId,sessionId,book.revision])
  async function act(action:string,body:object){if(busy)return;const epoch=generation.current,controller=new AbortController();pending.current=controller;setBusy(true);setError('');try{const result=await api<{book?:BookSnapshot}>('/wiki/compilation/'+action,{method:'POST',body:{...scope,...body},signal:controller.signal,timeoutMs:(budgetMs??60000)+20000});if(epoch!==generation.current)return;if(result.book)update(result.book);const refreshed=await api<{jobs:WikiCompileJob[]}>('/wiki/compilation'+query,{signal:controller.signal});if(epoch===generation.current)setJobs(refreshed.jobs)}catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:String(e))}finally{if(epoch===generation.current)setBusy(false)}}
  const pages=(book.wikiPages??[]).filter(page=>page.characterId===characterId&&page.pairingId==='local-user')
  async function cancel(id:string){const epoch=generation.current;if(pendingJob.current===id)pending.current?.abort();try{await api('/wiki/compilation/cancel',{method:'POST',body:{...scope,jobId:id}});const result=await api<{jobs:WikiCompileJob[]}>('/wiki/compilation'+query);if(epoch===generation.current)setJobs(result.jobs)}catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:String(e))}}
  return <details><summary>综合编纂任务</summary><p>选择最多四个主题合并生成草稿。核对段落、引用与固定原文后再应用；草稿不会新增事实。</p>
    {pages.map(page=><label key={page.id} style={{display:'block'}}><input type="checkbox" checked={selected.includes(page.id)} disabled={busy||!selected.includes(page.id)&&selected.length>=4} onChange={e=>setSelected(e.target.checked?[...selected,page.id]:selected.filter(id=>id!==page.id))}/>{page.subject}</label>)}
    <button disabled={busy||!selected.length} onClick={()=>void act('queue',{pageIds:selected,operationId:crypto.randomUUID()})}>加入编纂批次</button>
    {error&&<p role="alert">{error}</p>}
    {jobs.map(job=><article key={job.id}><p>{statusLabels[job.status]} · 尝试 {job.attempts}/3</p>{job.error&&<p>{job.error}</p>}
      {job.results.map(result=><div key={result.pageId}><h4>{pages.find(page=>page.id===result.pageId)?.subject??result.pageId}</h4>{result.paragraphs.map((paragraph,index)=><p key={index}>{paragraph.text}<small>〔{paragraph.entryIds.join('、')}〕</small></p>)}</div>)}
      <details><summary>核对来源与固定内容</summary>{job.targets.flatMap(target=>target.basisRefs).map((ref,index)=>{const entry=book.entries.find(entry=>entry.id===ref.entryId);return <p key={index}>{ref.entryId} · r{ref.revision} {entry?.pinned?'固定原文：':''}{entry?.body??'依据不可用'}</p>})}</details>
      {['pending','failed'].includes(job.status)&&<button disabled={busy} onClick={()=>{pendingJob.current=job.id;void act('run',{jobId:job.id})}}>生成／重试</button>}
      {!['applied','cancelled'].includes(job.status)&&<button onClick={()=>void cancel(job.id)}>取消任务</button>}
      {job.status==='review'&&<><label><input type="checkbox" checked={confirmed.includes(job.id)} onChange={e=>setConfirmed(e.target.checked?[...confirmed,job.id]:confirmed.filter(id=>id!==job.id))}/>已核对综合正文与全部依据</label><button disabled={busy||!confirmed.includes(job.id)} onClick={()=>void act('apply',{jobId:job.id,confirmed:true,expectedRevision:book.revision,operationId:crypto.randomUUID()})}>应用草稿</button></>}
    </article>)}
  </details>
}

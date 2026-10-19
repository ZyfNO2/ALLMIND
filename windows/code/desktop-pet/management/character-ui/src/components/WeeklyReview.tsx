import {useEffect,useRef,useState} from 'react'
import type {WeeklyReviewResult,WeeklyNarrativeResult} from '../../../../contracts/weekly-review'
import {api} from '../book-api'
export default function WeeklyReview({characterId,sessionId,revision}:{characterId:string;sessionId:string;revision:number}){
  const [review,setReview]=useState<WeeklyReviewResult|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),controller=useRef<AbortController|null>(null)
  const [narrative,setNarrative]=useState<WeeklyNarrativeResult|null>(null)
  useEffect(()=>{controller.current?.abort();controller.current=new AbortController();setReview(null);setNarrative(null);setBusy(false);setError('');return()=>controller.current?.abort()},[revision])
  async function generate(){
    setBusy(true);setError('');setNarrative(null);const signal=controller.current!.signal
    try{const result=await api<WeeklyReviewResult>(`/companion/weekly-review?${new URLSearchParams({characterId,sessionId})}`,{signal});if(!signal.aborted)setReview(result)}
    catch(error){if(!signal.aborted)setError(error instanceof Error?error.message:String(error))}
    finally{if(!signal.aborted)setBusy(false)}
  }
  async function narrate(){
    if(!review)return;setBusy(true);setError('');setNarrative(null);const signal=controller.current!.signal
    try{const result=await api<WeeklyNarrativeResult>('/companion/weekly-review/narrative',{method:'POST',body:{characterId,sessionId,expectedRevision:review.revision,confirmed:true},signal,timeoutMs:310000});if(!signal.aborted){setReview(result.review);setNarrative(result)}}
    catch(error){if(!signal.aborted)setError(error instanceof Error?error.message:String(error))}
    finally{if(!signal.aborted)setBusy(false)}
  }
  function clear(){controller.current?.abort();controller.current=new AbortController();setBusy(false);setReview(null);setNarrative(null);setError('')}
  return <section className="mb-card"><h3>我们的这一周</h3><p>手动整理当前角色实例最近7个本地日的有效记录；全部普通会话合计，无痕不计。本地预览不调用模型；可再明确选择把下方最多24条摘录交给已授权、已绑定的整理模型，生成带依据的AI回顾。回顾不自动存为新记忆，不包含无痕或未记录经历。</p>{error&&<p role="alert">{error}</p>}<button disabled={busy} onClick={()=>void generate()}>生成本地周回顾</button>{busy&&<button onClick={clear}>停止并清除本次回顾</button>}{review&&<><button disabled={busy} onClick={()=>void narrate()}>生成AI有据回顾（发送本次摘录）</button><button onClick={clear}>撤销本次回顾</button>{narrative&&<section aria-label="AI有据周回顾"><p>整理模型：{narrative.model??"没有有效摘录，未调用模型"} · AI措辞需结合原文核对；引用不代表独立核实。</p>{narrative.items.map((item,index)=><article key={index}><p>{item.text}</p><small>依据：{item.entryIds.map(id=><a key={id} href={"#week-source-"+id}>{id} </a>)}</small></article>)}</section>}<p>{review.from}～{review.to} · {review.timezone}</p><p role="status">聊天 {review.chatDays} 天 · {review.turns} 轮 · 新有效回忆 {review.newMemories} 条 · 相关页面关联 {review.relatedPageLinks} 对</p><small>新回忆按有效来源首次记录日期去重；关联是当前页面中与本周事实有关的有据链接，并非新增关系分数。发生日期不由记录日期推断。遗忘或撤销后重新生成会移除影响。</small>{review.turns===0&&review.newMemories===0?<p>这段时间没有可回顾的聊天或有效新回忆。</p>:<><p>来源中的话题：{review.topics.join('、')||'没有新增事实话题'}</p>{review.memories.map(memory=><article key={memory.entryId} id={"week-source-"+memory.entryId}><strong>{memory.subject} · {memory.predicate}</strong><p>{memory.value}</p><blockquote>{memory.quote}</blockquote><small>依据 {memory.entryId} r{memory.revision} · 来源 {memory.sourceId} · 记录于 {new Date(memory.recordedAt).toLocaleString('zh-CN')}</small></article>)}{review.omittedMemories>0&&<p>还有 {review.omittedMemories} 条有效新回忆未展开；统计仍包括它们。</p>}</>}</>}</section>
}

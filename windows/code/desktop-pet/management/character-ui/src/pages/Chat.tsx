import { useEffect, useRef, useState } from 'react'
import { Send, Loader2 } from 'lucide-react'
import { useParams, Link } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { runtime } from '../services/runtime'
import { Notice, Action } from '../components/Connection'

/**
 * DUX-03 · Playground 本地消息状态机（契约 §3）。
 *
 * 消息目标 `{id,characterId,sessionId,operationId,turnId?,role,text,status,error?}`；
 * 状态 submitting/running/completed/failed/cancelled/unknown。operationId 在意图建立时生成；
 * 用户气泡与助手占位拥有独立稳定 id 并关联同一 operation。
 * 点击发送 → 立即用户气泡 + 助手占位（等待动画持续到真正终态）；
 * 重复回执/历史不复制气泡；terminal 后迟到 running 不倒退；未知结果不重复调用。
 */
type ChatStatus = 'submitting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; status: ChatStatus; operationId: string; turnId?: string; error?: string }

const newId = () => crypto.randomUUID()

export default function Chat() {
  const { characterId = '' } = useParams()
  return <ChatSession key={characterId} id={characterId}/>
}

function ChatSession({id}:{id:string}) {
  const session=useAsync(()=>runtime.getSession(id),[id],undefined)
  const history=useAsync(()=>runtime.records(id,'transcript'),[id],undefined)
  const [input,setInput]=useState('')
  // 本地消息：历史（只读）之后是本会话操作产生的气泡。
  const [messages,setMessages]=useState<ChatMessage[]>([])
  const [error,setError]=useState('')
  // 意图（operationId 在建立时生成，重试沿用）；alive/pending 为竞态与双击防护。
  const operation=useRef<{operationId:string;text:string}|undefined>(undefined)
  const alive=useRef(true), pending=useRef(false)
  // 供轮询 effect 读取的最新意图/轮次，避免把它放进依赖造成重复轮询。
  const turnState=useRef<{operationId:string;turnId?:string;status:ChatStatus}|undefined>(undefined)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])

  /** 把某条消息推进到新状态；助手占位文本按状态渲染（completed 填 reply）。 */
  function setMessage(operationId:string, role:'user'|'assistant', fields:Partial<ChatMessage>) {
    setMessages(current=>current.map(m=>m.operationId===operationId&&m.role===role?{...m,...fields}:m))
  }

  useEffect(()=>{if(!turnState.current||turnState.current.status!=='running')return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const next=await runtime.getTurn(turnState.current!.turnId!,controller.signal);if(controller.signal.aborted)return;const current=turnState.current!;if(next.status==='running'){timer=setTimeout(poll,800);return}
    // 终态：填占位或标记失败；重复回执（已 terminal）不处理。
    turnState.current={...current,status:next.status as ChatStatus,turnId:next.turnId}
    setMessage(current.operationId,'assistant',{status:next.status as ChatStatus,...(next.reply?{text:next.reply}:{}),...(next.error?{error:next.error}:{})})
    setMessage(current.operationId,'user',{status:'completed',turnId:next.turnId})
  }catch(e){if(!controller.signal.aborted){const m=(e as Error).message;setError(m)}}};timer=setTimeout(poll,800);return()=>{controller.abort();clearTimeout(timer)}},[])

  const send=async()=>{
    const text=input.trim()
    if(!text||pending.current||!session.data)return
    pending.current=true;setError('')
    // 意图：重试沿用同一 operationId；新输入生成新 id。
    const intent=operation.current?.text===text?operation.current:{operationId:newId(),text}
    operation.current=intent
    // 立即本地气泡：用户 submitting + 助手占位等待；独立稳定 id，关联同一 operation。
    const userId=newId(), assistantId=newId()
    setMessages(current=>[...current,
      {id:userId,role:'user',text,status:'submitting',operationId:intent.operationId},
      {id:assistantId,role:'assistant',text:'',status:'submitting',operationId:intent.operationId}])
    setInput('')
    try{
      const result=await runtime.submitTurn(session.data,text,intent.operationId)
      if(!alive.current)return
      turnState.current={operationId:intent.operationId,turnId:result.turnId,status:(result.status as ChatStatus)}
      if(result.status==='running'){
        // 启动轮询（effect 依赖空数组，这里手动触发一次首查后交给 interval 逻辑）。
        setMessage(intent.operationId,'user',{status:'running',turnId:result.turnId})
        setMessage(intent.operationId,'assistant',{status:'running',turnId:result.turnId})
        void pollTurn(result.turnId,intent.operationId)
      } else if(result.reply){
        setMessage(intent.operationId,'user',{status:'completed',turnId:result.turnId})
        setMessage(intent.operationId,'assistant',{status:'completed',text:result.reply,turnId:result.turnId})
        operation.current=undefined
      } else { setMessage(intent.operationId,'user',{status:'completed',turnId:result.turnId}); setMessage(intent.operationId,'assistant',{status:(result.status as ChatStatus),...(result.error?{error:result.error}:{}),turnId:result.turnId}); operation.current=undefined }
    }catch(e){
      if(!alive.current)return
      const m=(e as Error).message
      // 提交失败：用户气泡标 failed、保留文本；助手占位移除（无伪回答）；意图保留供重试。
      setMessage(intent.operationId,'user',{status:'failed',error:m})
      setMessages(current=>current.filter(msg=>!(msg.operationId===intent.operationId&&msg.role==='assistant')))
      setError(m)
    }finally{pending.current=false}
  }

  /** 真实轮询：运行中的轮次每 800ms 查询，直到终态；重复/迟到回执不倒退、不复制。 */
  function pollTurn(turnId:string,operationId:string){
    const poll=async()=>{
      try{
        const next=await runtime.getTurn(turnId)
        if(!alive.current)return
        if(turnState.current?.turnId!==turnId)return
        if(next.status==='running'){setTimeout(()=>{if(alive.current)void poll()},800);return}
        // terminal：只更新尚未 terminal 的对；迟到重复回执不复制气泡。
        setMessage(operationId,'user',{status:'completed',turnId})
        setMessage(operationId,'assistant',{status:next.status as ChatStatus,...(next.reply?{text:next.reply}:{}),...(next.error?{error:next.error}:{}),turnId})
        turnState.current={operationId,turnId,status:next.status as ChatStatus}
        operation.current=undefined
      }catch(e){if(alive.current)setError((e as Error).message)}
    }
    void poll()
  }

  const rows=[...(history.data?.records||[]).map((r:any)=>({role:r.role as 'user'|'assistant',text:r.text as string,status:'completed' as ChatStatus,operationId:`history-${r.role}`,id:`h${r.role}`})),...messages]
  const busy=messages.some(m=>m.status==='submitting'||m.status==='running')
  return <div className="animate-fade-in grid h-[calc(100vh-110px)] grid-cols-[1fr_280px] gap-6"><section className="card flex flex-col overflow-hidden p-0"><header className="border-b border-slate-100 p-5"><h1 className="font-bold">正式文字 Playground</h1><p className="mt-1 text-xs text-ink-400">只有当前运行角色可提交；不生成模拟回复。</p></header><div className="flex-1 space-y-4 overflow-auto p-6">{session.error && <Notice>{session.error}</Notice>}{history.error && <Notice>历史读取失败：{history.error}</Notice>}{error && <Notice>{error}</Notice>}{rows.map((m,i)=><div key={m.id+':'+i} className={`flex ${m.role==='user'?'justify-end':'justify-start'}`}><div className={`inline-block w-fit max-w-[80%] whitespace-pre-wrap rounded-3xl px-5 py-3 text-sm ${m.role==='user'?'bg-aika-500 text-white':'bg-aika-50 text-ink-700'}`}>{m.role==='assistant'&&m.status!=='completed'&&m.status!=='failed'&&m.status!=='cancelled'
    ? <span data-waiting={m.status} className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />正在回复…</span>
    : <>{m.text}{m.status==='failed'&&m.error&&<span className="mt-2 block text-xs text-red-500">{m.error}</span>}{m.status==='unknown'&&<span className="mt-2 block text-xs text-amber-600">结果待确认；未确认前不重复发送。</span>}</>}</div></div>)}{busy && <p className="sr-only" role="status">正在回复</p>}</div><div className="flex gap-3 border-t border-slate-100 p-4"><input className="soft-input" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing)void send()}} placeholder="输入文字…" disabled={!session.data||busy}/><button className="rounded-xl bg-aika-500 px-4 text-white disabled:opacity-40" disabled={!session.data||busy||!input.trim()} onClick={()=>void send()} title="发送"><Send size={18}/></button></div></section><aside className="card space-y-5 p-5"><h2 className="font-bold">Playground</h2><p className="text-xs text-ink-500">生效配置修订：{session.data?.effectiveConfigRevision??'未读取'}</p>{turnState.current&&<p className="break-all text-xs">Turn：{turnState.current.turnId||'尚未分配'}<br/>状态：{turnState.current.status}</p>}{turnState.current?.status==='running'&&turnState.current.turnId&&<Action run={async()=>{const r=await runtime.cancelTurn(turnState.current!.turnId!);if(r.cancelled){setMessage(turnState.current!.operationId,'assistant',{status:'cancelled',text:'已停止生成'});setMessage(turnState.current!.operationId,'user',{status:'completed'});turnState.current={operationId:turnState.current!.operationId,turnId:turnState.current!.turnId,status:'cancelled'}}return r.cancelled?'轮次已取消':'该轮次不在运行中'}}>取消轮次</Action>}<Link className="block text-aika-600" to={`/characters/${id}/trace`}>查看正式 Trace →</Link><Notice>Memory Retrieval / Tool Calls 不展示示例结果。已有上下文检索工具在高级管理；语音输入未接线。</Notice></aside></div>
}

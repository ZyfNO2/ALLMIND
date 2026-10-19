import {useEffect,useRef,useState} from 'react'
import {api} from '../book-api'
import {COMPANION_INTERACTIONS,type CompanionInteraction,type InteractionControlsState,type InteractionSettings} from '../../../../contracts/companion-interactions'
const names={touch:'戳一戳',feed:'喂食（虚拟互动）',gift:'送礼物（虚拟互动）'}
type Draft={skinId:string;assetFingerprint:string;bindings:InteractionSettings['bindings'];revision:number}
export default function CompanionInteractions({characterId,sessionId}:{characterId:string;sessionId:string}){
  const [status,setStatus]=useState<InteractionControlsState|null>(null),[draft,setDraft]=useState<Draft|null>(null),[error,setError]=useState(''),[readError,setReadError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),controller=useRef<AbortController|null>(null),operation=useRef<{kind:CompanionInteraction;id:string}|null>(null)
  const scope={characterId,sessionId}
  function adopt(value:InteractionControlsState){setStatus(value);setDraft(value.available?{skinId:value.skinId,assetFingerprint:value.assetFingerprint,revision:value.settings?.revision??0,bindings:value.settings?.bindings??{touch:null,feed:null,gift:null}}:null)}
  useEffect(()=>{
    const current=new AbortController();controller.current=current;setStatus(null);setDraft(null);operation.current=null;setError('');setReadError('');setMessage('')
    async function refresh(){try{const value=await api<InteractionControlsState>(`/companion/interactions?${new URLSearchParams({characterId,sessionId})}`,{signal:current.signal});if(!current.signal.aborted){setStatus(value);setReadError('');setDraft(previous=>previous??(value.available?{skinId:value.skinId,assetFingerprint:value.assetFingerprint,revision:value.settings?.revision??0,bindings:value.settings?.bindings??{touch:null,feed:null,gift:null}}:null))}}catch(error){if(!current.signal.aborted)setReadError(error instanceof Error?error.message:String(error))}}
    void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>{clearInterval(timer);current.abort()}
  },[characterId,sessionId])
  async function work(fn:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await fn()}catch(error){if(!controller.current?.signal.aborted)setError(error instanceof Error?error.message:String(error))}finally{if(!controller.current?.signal.aborted)setBusy(false)}}
  async function play(kind:CompanionInteraction){
    if(!status?.available)return
    if(operation.current?.kind!==kind)operation.current={kind,id:crypto.randomUUID()}
    const result=await api<{controls:InteractionControlsState;played:boolean;message:string}>('/companion/interactions/play',{method:'POST',body:{...scope,kind,id:operation.current.id,expectedRevision:status.settings?.revision??0},signal:controller.current!.signal});
    if(!controller.current!.signal.aborted){setStatus(result.controls);setMessage(result.message);operation.current=null}
  }
  if(!status||!status.available)return <section className="mb-card" aria-label="小互动"><h3>小互动</h3><p role="status">{status&&!status.available?status.reason:readError?'尚未核对当前角色的小互动。':'正在核对角色互动声明…'}</p>{(error||readError)&&<p role="alert">{error||readError}</p>}</section>
  const last=status?.available?status.records.filter(row=>!row.undone).at(-1):undefined
  const declared=COMPANION_INTERACTIONS.filter(kind=>status?.available&&!!status.declared?.[kind])
  if(status?.available&&declared.length===0)return <section className="mb-card" aria-label="小互动"><h3>小互动</h3><p>当前角色未提供小互动。</p>{(error||readError)&&<p role="alert">{error||readError}</p>}</section>
  return <section className="mb-card" aria-label="小互动与动作映射"><h3>小互动与动作映射</h3><p>只显示角色明确声明且资源有效的互动；手动互动优先于自主活动，对话开始立即停止互动。喂食与礼物是虚拟互动，仅影响短期心情，不修改信任、共同经历或核心人格。每30秒最多一次、滚动24小时最多12次；撤销不退次数。</p>{(error||readError)&&<p role="alert">{error||readError}</p>}{message&&<p role="status">{message}</p>}
    <><p>资源：{status.skinId} · 短期心情 {Math.round(status.mood)} · 24小时互动 {status.records.filter(row=>Date.now()-row.at<86400000).length}/12</p>{!status.allowance.allowed&&<p>{status.allowance.reason}</p>}{status.choices.length===0&&<p>当前资源没有可映射的动画或姿态；基础触摸反馈保留，不冒充喂食或送礼动画。</p>}{status.settings&&!status.matched&&<p>资源已变化，旧映射未套用；请重新读取并选择当前资源。</p>}
      <div className="mb-row">{declared.map(kind=><button key={kind} disabled={busy||status.pending||!status.allowance.allowed||!status.bindings[kind]} onClick={()=>void work(()=>play(kind))}>{names[kind]}</button>)}<button disabled={busy||!last} onClick={()=>void work(async()=>{const value=await api<InteractionControlsState>('/companion/interactions/undo',{method:'POST',body:{...scope,id:last!.id},signal:controller.current!.signal});if(!controller.current!.signal.aborted){setStatus(value);setMessage('已撤销该次短期反馈，次数不退回。')}})}>撤销最近一次互动反馈</button></div>
      {draft&&<fieldset disabled={busy}><legend>动作映射</legend>{declared.map(kind=><label key={kind}>{names[kind]}<select aria-label={`${names[kind]}动作映射`} value={draft.bindings[kind]??''} onChange={event=>setDraft({...draft,bindings:{...draft.bindings,[kind]:event.target.value||null}})}><option value="">关闭此互动</option>{draft.bindings[kind]&&!status.choices.some(row=>row.id===draft.bindings[kind])&&<option value={draft.bindings[kind]!}>旧资源映射不可用</option>}{status.choices.filter(choice=>choice.id===status.declared?.[kind]).map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>)}<button onClick={()=>void work(async()=>{const {revision,...settings}=draft;settings.bindings=Object.fromEntries(COMPANION_INTERACTIONS.map(kind=>[kind,status.declared?.[kind]===draft.bindings[kind]?draft.bindings[kind]:null])) as InteractionSettings['bindings'];const value=await api<InteractionControlsState>('/companion/interactions/settings',{method:'POST',body:{...scope,settings,expectedRevision:revision},signal:controller.current!.signal});if(!controller.current!.signal.aborted){adopt(value);setMessage('动作映射已保存，绑定当前资源。')}})}>保存动作映射</button><button onClick={()=>void work(async()=>{const value=await api<InteractionControlsState>(`/companion/interactions?${new URLSearchParams(scope)}`,{signal:controller.current!.signal});if(!controller.current!.signal.aborted){adopt(value);setMessage('已放弃草稿，读取当前资源与已保存映射。')}})}>重新读取当前资源（放弃草稿）</button></fieldset>}
    </>
  </section>
}

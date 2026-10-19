import {useEffect,useRef,useState} from 'react'
import {api} from '../book-api'
import type {CompanionLifeState} from '../../../../core/companion-behavior'
import type {CompanionData} from '../../../../contracts/book-companion'
import type {DesktopHostPreferences,DesktopHostPatchReceipt} from '../../../../contracts/desktop-host'

export function LifeControls({characterId,section='behavior'}:{characterId:string;section?:'behavior'|'history'|'privacy'}){
  const [life,setLife]=useState<CompanionLifeState|null>(null),[error,setError]=useState(''),[readError,setReadError]=useState(''),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false)
  const controller=useRef<AbortController|null>(null)
  useEffect(()=>{const current=new AbortController();controller.current=current;setLife(null);setConfirmed(false);setError('');setReadError('');setBusy(false)
    const load=async()=>{try{const state=await api<CompanionLifeState>('/companion/life?'+new URLSearchParams({characterId}),{signal:current.signal});if(!current.signal.aborted){setLife(state);setReadError('')}}catch(error){if(!current.signal.aborted)setReadError(error instanceof Error?error.message:String(error))}}
    void load();const timer=setInterval(()=>void load(),3000);return()=>{clearInterval(timer);current.abort()}
  },[characterId])
  async function change(action:'set_enabled'|'set_quiet'|'clear_history',enabled?:boolean){if(!life)return;const signal=controller.current!.signal;setBusy(true);setError('');try{const next=await api<CompanionLifeState>('/companion/life',{method:'POST',signal,body:{characterId,action,expectedRevision:life.revision,...(enabled===undefined?{confirmed}: {enabled})}});if(!signal.aborted){setLife(next);setConfirmed(false)}}catch(error){if(!signal.aborted)setError(error instanceof Error?error.message:String(error))}finally{if(!signal.aborted)setBusy(false)}}
  const labels:Record<string,string>={idle:'待机',walking:'散步',resting:'休息',petting:'抚摸',dragging:'拖起放下',feeding:'投喂',gifting:'礼物',playing:'玩耍',chasing:'逗鼠标',jumping:'窗口跳转'}
  return <section className="mb-card" aria-label={section==='history'?'最近相处记录':section==='privacy'?'相处记录清理':'自主活动与免打扰'}><h3>{section==='history'?'最近相处记录':section==='privacy'?'相处记录清理':'自主活动与免打扰'}</h3>
    {(error||readError)&&<p role="alert">{error||readError}</p>}{!life&&<p role="status">当前桌宠状态尚未读到，不能修改。</p>}
    {section==='behavior'&&<fieldset disabled={busy||!life}><label><input type="checkbox" checked={life?.enabled??false} onChange={event=>void change('set_enabled',event.target.checked)}/>自主活动</label><label><input type="checkbox" checked={life?.quiet??false} onChange={event=>void change('set_quiet',event.target.checked)}/>免打扰</label><p role="status">当前活动：{life?labels[life.activity]:'未连接'}</p><small>免打扰暂停主动打扰；专注模式还会暂时暂停自主活动。结束专注后恢复原偏好，不影响主动聊天。</small></fieldset>}
    {section==='history'&&life&&<><p>最近 20 条已完成互动，最多保留 30 天 / 2048 条。</p>{life.localHistory?.length?life.localHistory.slice(-20).reverse().map(row=><p key={row.id}>{new Date(row.at).toLocaleString('zh-CN')} · {labels[row.kind]??row.kind}{row.presentation==='missing'?'（无专用动画）':''}</p>):<p>尚无相处记录。</p>}</>}
    {section==='privacy'&&<fieldset disabled={busy||!life}><p>仅清除当前角色的本地相处摘要，不删除聊天原文或 Wiki。</p><label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>确认清空当前角色的相处记录</label><button type="button" className="mb-danger" disabled={!confirmed} onClick={()=>void change('clear_history')}>清空相处记录</button></fieldset>}
  </section>
}

export function FocusControls({characterId,sessionId,timer=false}:{characterId:string;sessionId:string;timer?:boolean}){
  const [data,setData]=useState<CompanionData|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [minutes,setMinutes]=useState(25),[now,setNow]=useState(Date.now())
  const controller=useRef<AbortController|null>(null)
  useEffect(()=>{if(!timer)return;const tick=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(tick)},[timer])
  useEffect(()=>{const current=new AbortController();controller.current=current;setData(null);setError('');setBusy(false);const load=async()=>{try{const next=await api<CompanionData>('/companion?'+new URLSearchParams({characterId,sessionId}),{signal:current.signal});if(!current.signal.aborted)setData(next)}catch(error){if(!current.signal.aborted)setError(error instanceof Error?error.message:String(error))}};void load();const timer=setInterval(()=>void load(),3000);return()=>{clearInterval(timer);current.abort()}},[characterId,sessionId])
  async function change(enabled:boolean,extra:{minutes?:number;action?:'pause'|'resume'}={}){const signal=controller.current!.signal;setBusy(true);setError('');try{const next=await api<CompanionData>('/companion/focus',{method:'POST',body:{characterId,sessionId,enabled,...extra},signal});if(!signal.aborted){setData(next);setNow(Date.now())}}catch(error){if(!signal.aborted)setError(error instanceof Error?error.message:String(error))}finally{if(!signal.aborted)setBusy(false)}}
  const clock=data?.focusTimer,paused=clock?.pausedRemainingMs!==undefined,running=!!data?.focus&&!!clock&&!clock.completedAt
  const remaining=clock?(paused?clock.pausedRemainingMs!:clock.completedAt?0:Math.max(0,clock.until-now)):minutes*60000
  if(timer)return <section className="mb-card mb-focus-timer" aria-label="首页专注计时"><h3>专注陪伴</h3><p>留一段时间给自己，我会安静地陪着你。</p>{error&&<p role="alert">{error}</p>}<fieldset disabled={!data||busy}><div className="mb-row" aria-label="专注时长">{[25,45].map(value=><button key={value} type="button" aria-pressed={minutes===value} disabled={running||paused} onClick={()=>setMinutes(value)}>{value} 分钟</button>)}</div><output aria-label="专注剩余时间" className="mb-focus-clock">{String(Math.floor(remaining/60000)).padStart(2,'0')}:{String(Math.floor(remaining/1000)%60).padStart(2,'0')}</output><p role="status">{paused?'已暂停':running?'专注进行中':clock?.completedAt?'专注已完成，休息一下吧。':'尚未开始'}</p><div className="mb-row"><button type="button" className="mb-primary" onClick={()=>void change(!running,running?{action:'pause'}:paused?{action:'resume'}:{minutes})}>{running?'暂停专注':paused?'继续专注':'开始专注'}</button><button type="button" disabled={!clock&&!data?.focus} onClick={()=>void change(false)}>重置计时</button></div></fieldset><small>运行时暂停自主活动与主动打扰，聊天仍可用。暂停、刷新与重启保留计时；重置恢复原偏好。</small></section>
  return <section className="mb-card"><h3>专注模式</h3>{error&&<p role="alert">{error}</p>}<label><input type="checkbox" aria-label="专注模式" checked={data?.focus??false} disabled={!data||busy} onChange={event=>void change(event.target.checked)}/>安静陪伴，暂停自主活动与主动打扰</label><small>聊天仍然可用；免打扰与自主活动的原开关保持不变。计时入口位于“陪伴”页面。</small></section>
}

export function SoundControls(){
  const [state,setState]=useState<DesktopHostPreferences|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const controller=useRef<AbortController|null>(null)
  useEffect(()=>{const current=new AbortController();controller.current=current;void api<DesktopHostPreferences>('/desktop/preferences',{signal:current.signal}).then(next=>{if(!current.signal.aborted)setState(next)}).catch(error=>{if(!current.signal.aborted)setError(error.message)});return()=>current.abort()},[])
  async function change(replySound:boolean){if(!state)return;const signal=controller.current!.signal;setBusy(true);setError('');try{const next=await api<DesktopHostPatchReceipt>('/desktop/preferences',{method:'PUT',signal,body:{expectedRevision:state.revision,operationId:crypto.randomUUID(),patch:{replySound}}});if(!signal.aborted)setState(next.preferences)}catch(error){if(!signal.aborted)setError(error instanceof Error?error.message:String(error))}finally{if(!signal.aborted)setBusy(false)}}
  return <section className="mb-card"><h3>回复声音</h3>{error&&<p role="status">{error}</p>}<label><input type="checkbox" checked={state?.replySound??false} disabled={!state||busy} onChange={event=>void change(event.target.checked)}/>播放回复声音</label><small>由桌面宿主保存，不会自动配置或启用语音模型。</small></section>
}

export function SystemControls(){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
  async function restart(){if(!window.confirm('重启后台会中断当前请求。确认重启？'))return;setBusy(true);setError('');try{await api('/desktop/restart',{method:'POST',body:{}});setMessage('已请求重启后台，请从桌宠重新打开管理页面。')}catch(error){setError(error instanceof Error?error.message:String(error))}finally{setBusy(false)}}
  return <section className="mb-card"><h3>系统与故障排查</h3><p>关闭窗口会继续在系统托盘运行；双击托盘图标恢复，托盘右键“退出 ALLMIND”才彻底退出。</p><button type="button" disabled={busy} onClick={()=>void restart()}>快速重启后台</button>{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}</section>
}

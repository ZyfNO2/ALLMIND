import {useEffect,useState,useRef} from 'react'
import {api} from '../book-api'
import type {ActivityView} from '../../../../core/book-activity'

export default function KeyboardActivity({characterId}:{characterId:string}){
  const [view,setView]=useState<ActivityView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[day,setDay]=useState('')
  const generation=useRef(0)
  useEffect(()=>{let alive=true;++generation.current;setView(null);setError('');setBusy(false);const load=()=>api<ActivityView>('/companion/keyboard?characterId='+encodeURIComponent(characterId)).then(row=>{if(alive)setView(row)}).catch(error=>{if(alive)setError(String(error))});void load();const timer=setInterval(load,10000);return()=>{alive=false;++generation.current;clearInterval(timer)}},[characterId])
  const change=async(body:object)=>{const current=generation.current;setBusy(true);setError('');try{const result=await api<ActivityView>('/companion/keyboard',{method:'POST',body:{...body,characterId}});if(current===generation.current)setView(result)}catch(error){if(current===generation.current)setError(String(error))}finally{if(current===generation.current)setBusy(false)}}
  const dates=[...new Set(view?.days.map(row=>row.day)??[])].sort().reverse(),selected=dates.includes(day)?day:dates[0]
  const bins=view?.days.filter(row=>row.day===selected)??[],count=bins.reduce((n,row)=>n+row.count,0),coverage=bins.reduce((n,row)=>n+row.coveredMs,0)
  return <section className="mb-card"><h3>本地键盘活动与相处习惯</h3><p>只统计按下通知次数（包含系统长按连发），不保存字符、键码或应用内容。原始聚合保留 7 天，时段统计保留 30 天；数据仅供本机陪伴使用。新角色需单独开启。</p>
    <label><input type="checkbox" disabled={busy||!view} checked={view?.enabled??false} onChange={e=>void change({action:'enable',enabled:e.target.checked})}/>开启当前角色的键盘活动记录</label>
    <p role="status">来源：{view?({disabled:'关闭',starting:'连接中',active:'监听中',paused:'暂停',unavailable:'不可用'})[view.state]:'读取中'}{view?.error?' · '+view.error:''}</p>
    {error&&<p role="alert">{error}</p>}
    <label>记录日期<select value={selected??''} onChange={e=>setDay(e.target.value)}><option value="">选择日期</option>{dates.map(date=><option key={date}>{date}</option>)}</select></label>
    <p>{selected??'暂无样本'}：{count} 次按下通知，有效覆盖 {Math.round(coverage/60000)} 分钟。未监听的时段属于未知。</p>
    <div aria-label="每半小时时段活动">{bins.sort((a,b)=>a.slot-b.slot).map(row=><p key={`${row.slot}.${row.offset}.${row.timezone}`}>{String(Math.floor(row.slot/2)).padStart(2,'0')}:{row.slot%2?'30':'00'} · {row.count} 次 · 覆盖 {Math.round(row.coveredMs/1000)} 秒 · {row.timezone}</p>)}</div>
    <p>同类日有效样本：{view?.sampleDays??0} 天。{view?.habitSlots.length?`高活跃时段：${view.habitSlots.map(slot=>`${Math.floor(slot/2)}:${slot%2?'30':'00'}`).join('、')}，在这些时段安静陪伴。`:'画像未知；同一时段至少 3 天、每天覆盖 5 分钟后试算。'}</p>
    <button disabled={busy||!selected} onClick={()=>void change({action:'delete',day:selected})}>删除所选日期</button>{' '}
    <button disabled={busy||!view} onClick={()=>void change({action:'delete'})}>清空当前角色活动记录</button>
  </section>
}

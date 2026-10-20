import {useState} from 'react'
import type {SessionSummary} from '../../../../contracts/memory-book'
import Modal from './Modal'
export default function SessionPicker({sessions,current,disabled,timezone,change,controlledOpen,onOpenChange}:{sessions:SessionSummary[];current:string;disabled:boolean;timezone:string;change:(id:string)=>void;controlledOpen?:boolean;onOpenChange?:(open:boolean)=>void}){
  const [query,setQuery]=useState(''),[localOpen,setLocalOpen]=useState(false)
  const open=controlledOpen??localOpen,setOpen=(value:boolean)=>{setLocalOpen(value);onOpenChange?.(value)}
  const matches=sessions.filter(row=>(row.title+' '+row.sessionId).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const groups=new Map<string,SessionSummary[]>()
  for(const row of matches){const date=new Date(row.updatedAt).toLocaleDateString('zh-CN',{timeZone:timezone});groups.set(date,[...(groups.get(date)??[]),row])}
  const selected=sessions.find(row=>row.sessionId===current),label=selected?.title??(current==='web-chat'?'默认会话':current==='desktop'?'桌宠对话':'新会话')
  return <div className="mb-session-picker"><button hidden={controlledOpen!==undefined} type="button" aria-label="选择会话" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={()=>{setQuery('');setOpen(true)}}>{label} ▾</button>
    <Modal open={open} title="会话记录" close={()=>setOpen(false)}><label>搜索会话<input data-autofocus aria-label="搜索会话" type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索标题或会话"/></label><p className="mb-muted">当前：{label}</p>
      {[...groups].map(([date,rows])=><section key={date}><h3>{date}</h3>{rows.map(row=><button type="button" className="mb-session-option" key={row.sessionId} aria-current={row.sessionId===current?'true':undefined} disabled={disabled} onClick={()=>{change(row.sessionId);setOpen(false)}}><span>{row.sessionId==='desktop'?'桌宠 · ':''}{row.title}</span><small>{row.turnCount<0?'轮次未精确计数':row.turnCount+' 轮'}</small></button>)}</section>)}
      {matches.length===0&&<p role="status">没有匹配会话，保留当前会话。</p>}
    </Modal></div>
}

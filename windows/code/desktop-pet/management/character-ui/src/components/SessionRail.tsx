import {useState} from 'react'
import {Plus,Search} from 'lucide-react'
import type {SessionSummary} from '../../../../contracts/memory-book'

export default function SessionRail({sessions,current,disabled,choose,create,archives}:{sessions:SessionSummary[];current:string;disabled:boolean;choose:(id:string)=>void;create:()=>void;archives:()=>void}) {
  const [query,setQuery]=useState('')
  const rows=sessions.filter(row=>!row.archivedAt&&row.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <aside className="v2-session-rail" aria-label="最近对话"><h2>最近对话</h2><button type="button" className="v2-outline" disabled={disabled} onClick={create}><Plus size={16}/>开始新话题</button><label className="v2-session-search"><Search size={15}/><input type="search" aria-label="搜索聊天记录" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索会话标题"/></label><div className="v2-session-list">{rows.map(row=><button key={row.sessionId} type="button" disabled={disabled} aria-current={current===row.sessionId?'page':undefined} onClick={()=>choose(row.sessionId)}><b>{row.title}</b><small>{row.turnCount<0?'已有聊天记录':`${row.turnCount} 轮对话`} · {new Date(row.updatedAt).toLocaleDateString('zh-CN')}</small></button>)}{!rows.length&&<p className="mb-muted">{query?'没有匹配的会话标题。':'还没有保存的对话，发出第一条消息后会出现在这里。'}</p>}</div><button type="button" className="mb-link" onClick={archives}>查看归档 →</button></aside>
}

export function ArchivedSessions({sessions,disabled,restore,read}:{sessions:SessionSummary[];disabled:boolean;restore:(id:string)=>void;read:(id:string)=>void}){
 const [query,setQuery]=useState('');const rows=sessions.filter(row=>row.archivedAt&&row.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 return <section className="mb-setting-group"><h2>归档的会话</h2><p className="mb-muted">归档只收起会话，不删除聊天和记忆。恢复后回到首页最近对话。</p><label>搜索归档<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索会话标题"/></label>{rows.map(row=><article className="mb-card v2-archive-row" key={row.sessionId}><div><h3>{row.title}</h3><small>归档于 {new Date(row.archivedAt!).toLocaleString('zh-CN')} · {row.turnCount<0?'已有聊天记录':row.turnCount+' 轮'}</small></div><button type="button" disabled={disabled} onClick={()=>read(row.sessionId)}>查看会话</button><button type="button" className="v2-outline" disabled={disabled} onClick={()=>restore(row.sessionId)}>恢复到最近对话</button></article>)}{!rows.length&&<p className="v2-blank" role="status">{query?'没有匹配的归档。':'还没有归档的会话。'}</p>}</section>
}

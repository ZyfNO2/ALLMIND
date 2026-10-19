import {useEffect,useRef,useState} from 'react'
import {emptyEntry,type BookSnapshot} from '../../../../../contracts/memory-book'
import {api} from '../../book-api'

export default function PersonaEditor({characterId,book,onChange,onDirty}:{characterId:string;book:BookSnapshot|null;onChange:(book:BookSnapshot)=>void;onDirty:(dirty:boolean)=>void}){
 const rows=book?.entries.filter(row=>row.type==='persona'&&row.enabled)??[]
 const [editing,setEditing]=useState<string|null>(null),[body,setBody]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
 const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;onDirty(false)}},[onDirty])
 const bytes=new TextEncoder().encode(body).length,otherBytes=rows.filter(row=>row.id!==editing).reduce((total,row)=>total+new TextEncoder().encode(row.body).length,0)
 function edit(id:string){setEditing(id);setBody(rows.find(row=>row.id===id)?.body??'');setMessage('');onDirty(false)}
 async function save(){if(!book)return;setBusy(true);setMessage('');try{
  if(!body.trim())throw Error('请填写角色的身份、性格或说话习惯。');if(bytes+otherBytes>4096)throw Error('核心设定合计超过 4 KiB，请把详细背景放入世界设定。')
  const existing=rows.find(row=>row.id===editing),entry=existing?{...existing,body}:emptyEntry('persona-'+crypto.randomUUID(),'persona','核心人设',body);entry.trigger={...entry.trigger,strategy:'always'}
  const result=await api<{book:BookSnapshot}>('/entries',{method:'PUT',body:{characterId,sessionId:'web-chat',entry,expectedRevision:book.revision,operationId:crypto.randomUUID()}})
  if(live.current){onChange(result.book);onDirty(false);setEditing(null);setMessage('核心人设已保存，从下一轮对话生效。')}
 }catch(error){if(live.current)setMessage(error instanceof Error?error.message:String(error))}finally{if(live.current)setBusy(false)}}
 return <section className="mb-card persona-editor" aria-label="角色核心人设"><div className="mb-section-head"><div><h3>核心人设</h3><p className="mb-muted">角色是谁、怎样说话。每轮对话都会带上这些内容；详细背景可通过角色包导入。</p></div><span className="mb-tag">{rows.length?'已设置 '+rows.length+' 条':'尚未设置'}</span></div>
  {editing===null?<><div className="persona-summary">{rows.length?rows.map(row=><article key={row.id}><div className="mb-section-head"><strong>{row.title}</strong><button type="button" onClick={()=>edit(row.id)}>编辑人设</button></div><p>{row.body.slice(0,220)}{row.body.length>220?'…':''}</p></article>):<p>还没有角色设定。可以手动写下几句话，也可以导入已有角色包。</p>}</div><button type="button" disabled={!book} onClick={()=>edit('new')}>添加核心人设</button></>:<fieldset disabled={busy}><label>人设正文<textarea aria-label="人设正文" rows={8} value={body} placeholder="例如：你是一位冷静、坦率的桌面同伴。日常聊天简短自然，技术问题给出具体步骤；不知道的事直接说明。" onChange={event=>{setBody(event.target.value);onDirty(true)}}/></label><p className="mb-muted">本角色核心设定：{bytes+otherBytes} / 4096 字节。身份简介用于展示，核心人设才定义回复方式。</p><div className="mb-row"><button type="button" className="mb-primary" onClick={()=>void save()}>{busy?'正在保存…':'保存核心人设'}</button><button type="button" onClick={()=>{setEditing(null);onDirty(false);setMessage('')}}>取消编辑人设</button></div></fieldset>}
  {message&&<p role="status">{message}</p>}
 </section>
}

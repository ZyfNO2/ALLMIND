import {useEffect,useRef,useState} from 'react'
import {api} from '../../book-api'
import type {BookImportPreview,BookSnapshot} from '../../../../../contracts/memory-book'

export default function CharacterImport({characterId,name,onChange}:{characterId:string;name:string;onChange:(book:BookSnapshot)=>void}){
 const [preview,setPreview]=useState<BookImportPreview|null>(null),[message,setMessage]=useState(''),[fileName,setFileName]=useState(''),[busy,setBusy]=useState(false)
 const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 async function choose(file?:File){if(!file)return;setBusy(true);setMessage('');setPreview(null);setFileName(file.name);try{
  if(file.size>1024*1024)throw Error('角色包超过 1 MiB。形象图片请在下方立绘区单独添加。')
  const content=/\.zip$/i.test(file.name)?{zipBase64:await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]??'');reader.onerror=()=>reject(Error('无法读取文件，请重新选择。'));reader.readAsDataURL(file)})}:{text:await file.text()}
  const next=await api<BookImportPreview>('/imports/preview',{method:'POST',body:{characterId,sessionId:'web-chat',sourceName:file.name,...content}});if(live.current)setPreview(next)
 }catch(error){if(live.current)setMessage(error instanceof Error?error.message:String(error))}finally{if(live.current)setBusy(false)}}
 async function apply(){if(!preview)return;setBusy(true);setMessage('');try{const result=await api<{book:BookSnapshot}>('/imports/apply',{method:'POST',body:{characterId,sessionId:'web-chat',previewId:preview.id,operationId:crypto.randomUUID()}});if(live.current){onChange(result.book);setPreview(null);setMessage('角色资料已导入，从下一轮对话生效。')}}catch(error){if(live.current)setMessage(error instanceof Error?error.message:String(error))}finally{if(live.current)setBusy(false)}}
 return <section className="mb-card character-import" aria-label="导入角色包"><div className="mb-section-head"><div><h3>已有角色包？直接导入</h3><p className="mb-muted">支持 ALLMIND ZIP、角色书 JSON 和 .aiki.md。先看预览，确认后才写入当前角色。</p></div></div>
  <label className="character-file-label">选择角色包<input type="file" aria-label="选择角色包" accept=".zip,.json,.md,.markdown" disabled={busy} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';void choose(file)}}/></label>
  {busy&&<p role="status">正在处理角色资料…</p>}
  {preview&&<div className="character-import-preview"><h4>{preview.name} · {preview.entries.length} 条资料</h4><p>目标角色：{name}。当前内容会保留，重名冲突以预览结果为准。</p><p>{preview.entries.filter(row=>row.type==='persona').length} 条人设 · {preview.entries.filter(row=>row.type!=='persona').length} 条背景与知识</p>{preview.diagnostics.map(item=><p role="alert" key={item}>{item}</p>)}<details><summary>查看条目与冲突</summary>{preview.changes.map(change=><p key={change.id}>{preview.entries.find(row=>row.id===change.id)?.title??change.id} · {change.reason}</p>)}</details><div className="mb-row"><button type="button" className="mb-primary" disabled={busy||preview.diagnostics.length>0} onClick={()=>void apply()}>确认导入角色资料</button><button type="button" disabled={busy} onClick={()=>{setPreview(null);setFileName('');setMessage('已取消，没有改动角色资料。')}}>取消导入角色资料</button></div></div>}
  {fileName&&!preview&&<small>{fileName}</small>}{message&&<p role="status">{message}</p>}
 </section>
}

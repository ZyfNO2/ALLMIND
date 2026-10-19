import {useEffect,useState} from 'react'
import {api} from '../book-api'
type Archive={binding:{name:string;enabled:boolean}|null;thread:{url:string;projectName:string;projectId:string;targetChanged:boolean}|null}
export default function ChatgptThreadLink({characterId,sessionId,revision}:{characterId:string;sessionId:string;revision:number}){
  const [archive,setArchive]=useState<Archive|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0)
  useEffect(()=>{const controller=new AbortController();setArchive(null);setError('');api<Archive>('/chatgpt-web/projects/thread?'+new URLSearchParams({characterId,sessionId}),{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setArchive(value)}).catch(failure=>{if(!controller.signal.aborted)setError(failure.message)});return()=>controller.abort()},[characterId,sessionId,revision,refresh])
  return <div className="mb-thread-location" aria-label="本会话项目归属">{error?<><span role="alert">项目归属读取失败：{error}</span><button type="button" onClick={()=>setRefresh(value=>value+1)}>重新读取归属</button></>:!archive?<small role="status">正在读取项目归属…</small>:archive.thread?<><small>已确认归档：{archive.thread.projectName}</small> · <a href={archive.thread.url} target="_blank" rel="noreferrer">打开对应聊天</a>{archive.thread.targetChanged&&<p>项目绑定已变化；此会话保留原归属，请新建会话使用新目标。</p>}</>:<small>{archive.binding?.enabled?'目标项目：'+archive.binding.name+' · 尚无已确认线程':'此会话尚无已确认的项目归档'}</small>}</div>
}

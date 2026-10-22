import {useState} from 'react'
import type {BookSnapshot,RuntimeConfig} from '../../../../contracts/memory-book'
import Modal from './Modal'

export default function GettingStarted({config,book,go}:{config:RuntimeConfig;book:BookSnapshot|null;go:(path:string)=>void}){
  const key='allmind-onboarding-dismissed:'+config.currentCharacterId
  const [hidden,setHidden]=useState(()=>localStorage.getItem(key)==='1')
  const [open,setOpen]=useState(false)
  const role=config.characters.find(row=>row.id===config.currentCharacterId)
  const tasks=[{label:'角色资料',done:Boolean(role?.intro||book?.entries.some(row=>row.enabled&&row.type==='persona')),path:'/character'},
    {label:'设置模型连接',done:Boolean(config.mainModel),path:'/settings?section=settings-conversation'},
    {label:'准备知识资料（可选）',done:Boolean(book?.entries.length),path:'/memory-book?tab=import'},
    {label:'了解备份与恢复',done:false,path:'/settings?section=settings-data'}]
  return <><button type="button" onClick={()=>setOpen(true)}>{hidden?'使用清单':'开始使用 · 清单'}</button><Modal open={open} title="首次使用清单" close={()=>setOpen(false)}><h3>开始使用 ALLMIND</h3><p>先连接模型即可聊天；人设、知识、语音与 QQ 可以稍后补充。“已配置”不代表当前服务在线，请在连接页主动测试。</p><div className="mb-row">{tasks.map(task=><button type="button" key={task.label} onClick={()=>{setOpen(false);go(task.path)}}>{task.done?'✓ ':''}{task.label}</button>)}</div><p>模型连接由应用共用；角色与会话分别保存。本地无痕控制本机记录，网页临时聊天控制远端模式，两者独立。</p><button type="button" className="mb-link" onClick={()=>{localStorage.setItem(key,'1');setHidden(true);setOpen(false)}}>收起清单，稍后自行设置</button></Modal></>
}

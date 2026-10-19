import {useEffect,useState,useRef} from 'react'
import type {RuntimeConfig} from '../../../../contracts/memory-book'
import type {ChatgptProjectBinding} from '../../../../contracts/chatgpt-project'
import {api} from '../book-api'

type Props={config:RuntimeConfig;save:(next:RuntimeConfig)=>Promise<void>;action:(work:()=>Promise<void>)=>Promise<void>}
export default function ChatgptProjectSettings({config,save,action}:Props){
  const role=config.characters.find(row=>row.id===config.currentCharacterId)!
  const binding=config.chatgptProjects?.find(row=>row.characterId===role.id&&row.pairingId==='local-user')
  const [url,setUrl]=useState(''),[checked,setChecked]=useState<{projectId:string;name:string;account:string}|null>(null)
  const [confirmed,setConfirmed]=useState(false),[status,setStatus]=useState('')
  const owner=useRef(role.id);owner.current=role.id
  const supported=config.chatgptWeb?.transport==='embedded'
  useEffect(()=>{setChecked(null);setUrl('');setConfirmed(false);setStatus('')},[role.id])
  async function persist(next:ChatgptProjectBinding|null){
    const expected=owner.current
    await save({...config,chatgptProjects:[...(config.chatgptProjects??[]).filter(row=>!(row.characterId===role.id&&row.pairingId==='local-user')),...(next?[next]:[])]})
    if(owner.current===expected){setChecked(null);setStatus(next?'项目绑定已保存并回读。':'已解除绑定，云端聊天保留。')}
  }
  return <section className="mb-card" aria-label="对话所属 ChatGPT 项目">
    <h3>对话所属 ChatGPT 项目</h3><p>当前角色：{role.name}</p>
    <p className="mb-muted">粘贴已有项目链接，检查后保存。同一 ALLMIND 会话续接原网页线程，新会话在此项目新建线程；项目聊天会保存在云端。</p>
    {!supported&&<p role="status">项目路由目前需要“ALLMIND 独立常驻页面”。请先在连接方式中选择并保存，再检查链接；不会自动切换来源。</p>}
    {binding&&<div><p>项目：{binding.name} · {binding.enabled?'已启用':'已暂停'}</p><p className="mb-muted">记忆范围：{binding.memory==='user-confirmed-project-only'?'仅项目记忆（用户确认）':'未核验'}。本地遗忘不会删除云端旧聊天。</p><div className="mb-row"><a href={'https://chatgpt.com/g/'+binding.projectId+'/project'} target="_blank" rel="noreferrer">查看项目</a><button type="button" onClick={()=>void action(()=>persist({...binding,enabled:!binding.enabled}))}>{binding.enabled?'暂停项目绑定':'启用项目绑定'}</button><button type="button" onClick={()=>void action(()=>persist(null))}>解除项目绑定（保留云端聊天）</button></div></div>}
    <label>已有项目链接<input aria-label="已有项目链接" value={url} onChange={event=>{setUrl(event.target.value);setChecked(null);setStatus('')}} placeholder="https://chatgpt.com/g/g-p-…/project"/></label>
    <p className="mb-muted">使用有权访问的项目主页链接，无需公开分享。邀请链接若无法识别，请打开项目后复制主页地址。</p>
    <button type="button" disabled={!supported||!url.trim()} onClick={()=>void action(async()=>{const expected=owner.current;setChecked(null);const result=await api<{projectId:string;name:string;account:string}>('/chatgpt-web/projects/check',{method:'POST',body:{url}});if(owner.current!==expected)return;setChecked(result);setConfirmed(false);setStatus('链接与当前独立账号已检查；核对项目后保存。')})}>检查项目链接</button>
    {checked&&<div><p>待绑定：{checked.name} · 当前账号 {checked.account.slice(0,8)}</p><label className="mb-toggle">我已确认此项目使用仅项目记忆<input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/></label><small>无法自动核验；未勾选将如实标为未核验。</small><button type="button" onClick={()=>void action(()=>persist({id:binding?.projectId===checked.projectId&&binding.account===checked.account?binding.id:crypto.randomUUID(),characterId:role.id,pairingId:'local-user',enabled:true,projectId:checked.projectId,name:checked.name,account:checked.account,memory:confirmed?'user-confirmed-project-only':'unverified'}))}>保存项目绑定</button></div>}
    {status&&<p role="status">{status}</p>}
  </section>
}

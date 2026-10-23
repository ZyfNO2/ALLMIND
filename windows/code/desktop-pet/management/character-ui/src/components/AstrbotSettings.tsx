import {useEffect,useState} from 'react'
import {api} from '../book-api'

export default function AstrbotSettings(){
  const [profile,setProfile]=useState(''),[installed,setInstalled]=useState(false),[execution,setExecution]=useState('local'),[active,setActive]=useState('local')
  const [baseUrl,setBaseUrl]=useState('http://127.0.0.1:6185'),[instanceId,setInstanceId]=useState('astrbot-local'),[configId,setConfigId]=useState(''),[key,setKey]=useState(''),[token,setToken]=useState('')
  const [binding,setBinding]=useState(''),[selection,setSelection]=useState(''),[publication,setPublication]=useState<unknown>(null),[bindings,setBindings]=useState<unknown[]>([]),[records,setRecords]=useState<unknown[]>([])
  const [modeConfigIds,setModeConfigIds]=useState('{}')
  const [moduleStates,setModuleStates]=useState<Record<string,{installed:boolean;enabled:boolean}>>({})
  const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  async function refresh(){
    const runtime=await api<{product:{id:string;modules:Record<string,boolean>;moduleStates?:Record<string,{installed:boolean;enabled:boolean}>}}>('/runtime');setProfile(runtime.product.id);setInstalled(runtime.product.modules.astrbot??false);setModuleStates(runtime.product.moduleStates??{})
    if(!runtime.product.modules.astrbot)return
    const state=await api<{settings:{execution:string;baseUrl:string;instanceId:string;configId:string|null;modeConfigIds?:Record<string,string>}|null;activeExecution:string;bindings:unknown[];records:unknown[]}>('/integrations/astrbot')
    setActive(state.activeExecution);setBindings(state.bindings);setRecords(state.records)
    if(state.settings){setExecution(state.settings.execution);setBaseUrl(state.settings.baseUrl||'http://127.0.0.1:6185');setInstanceId(state.settings.instanceId||'astrbot-local');setConfigId(state.settings.configId??'');setModeConfigIds(JSON.stringify(state.settings.modeConfigIds??{}))}
  }
  useEffect(()=>{void refresh().catch(error=>setNotice(error.message))},[])
  async function run(work:()=>Promise<void>){setBusy(true);setNotice('');try{await work()}catch(error){setNotice(error instanceof Error?error.message:String(error))}finally{setBusy(false)}}
  return <section className="mb-card" aria-label="模块与 AstrBot"><h3>模块与 AstrBot</h3><p>当前组合：{profile||'读取中'}。{installed?`当前会话引擎：${active==='astrbot'?'AstrBot':'本地'}`:'此组合未安装 AstrBot 连接器。'}</p>
    <p>语音、屏幕和本机工具扩展可独立安装，重启生效；用户资料与程序模块分开保存。</p>
    <ul aria-label="扩展安装状态">{Object.entries({voice:'语音',screen:'屏幕',tools:'本机工具'}).map(([id,label])=><li key={id}>{label}：{moduleStates[id]?.enabled?'已安装并启用':moduleStates[id]?.installed?'已安装，已禁用':'未安装'}</li>)}</ul><p>设备和连接是否可用，请在对应功能页检测。模块文件校验失败会阻止启动并报告错误。</p>
    {installed&&<><label>聊天引擎<select value={execution} onChange={event=>setExecution(event.target.value)}><option value="local">本地</option><option value="astrbot">AstrBot</option></select></label>
    <label>AstrBot 本机地址<input value={baseUrl} onChange={event=>setBaseUrl(event.target.value)}/></label><label>实例编号<input value={instanceId} onChange={event=>setInstanceId(event.target.value)}/></label><label>配置 ID（可选）<input value={configId} onChange={event=>setConfigId(event.target.value)}/></label>
    <label>场景与 AstrBot 配置 ID 映射（JSON，可选）<input value={modeConfigIds} onChange={event=>setModeConfigIds(event.target.value)}/></label><label>OpenAPI Key<input type="password" autoComplete="off" value={key} placeholder="留空保留已有凭据" onChange={event=>setKey(event.target.value)}/></label>
    <button disabled={busy} onClick={()=>void run(async()=>{await api('/integrations/astrbot/config',{method:'PUT',body:{execution,baseUrl,instanceId,configId,modeConfigIds:JSON.parse(modeConfigIds),apiKey:key}});setKey('');setNotice('已保存。退出并重新启动 ALLMIND，再新建会话使用所选引擎。')})}>保存连接</button>
    <p>在 AstrBot 安装 ALLMIND 插件，使用下方独立能力令牌。请勿使用管理页面令牌。</p><button disabled={busy} onClick={()=>void run(async()=>setToken((await api<{token:string}>('/integrations/astrbot/token')).token))}>显示插件能力令牌</button>{token&&<><textarea readOnly aria-label="插件能力令牌" value={token}/><button onClick={()=>setToken('')}>隐藏令牌</button></>}
    <details><summary>平台绑定与公开资料审核</summary><p>桌面会话自动绑定。其他平台须明确绑定身份；公开聊天只能使用已审核的资料快照。填写 publication selection 后预览全文，再放入绑定保存。</p>
    <label>公开资料选择 JSON<textarea value={selection} onChange={event=>{setSelection(event.target.value);setPublication(null)}}/></label><button disabled={busy} onClick={()=>void run(async()=>setPublication((await api<{publication:unknown}>('/integrations/astrbot/publication',{method:'POST',body:{selection:JSON.parse(selection)}})).publication))}>预览公开资料</button>{publication!==null&&<pre>{JSON.stringify(publication,null,2)}</pre>}
    <label>绑定 JSON<textarea value={binding} onChange={event=>setBinding(event.target.value)}/></label><button disabled={busy} onClick={()=>void run(async()=>{const value=JSON.parse(binding);if(value.audience==='public'){if(!publication)throw Error('请先预览并核对公开资料。');value.publication=publication}await api('/integrations/astrbot/bindings',{method:'PUT',body:{binding:value,confirmed:true}});await refresh();setNotice('身份与资料绑定已保存。')})}>确认身份与资料并保存绑定</button>
    <button disabled={busy} onClick={()=>void run(async()=>{await api('/integrations/astrbot/bindings',{method:'DELETE',body:JSON.parse(binding)});await refresh();setNotice('绑定已撤销。')})}>撤销填写的身份绑定</button><pre>{JSON.stringify(bindings,null,2)}</pre></details>
    <details><summary>外部回合候选记录（{records.length}）</summary><p>这些是待审核来源记录；没有自动写入事实 Wiki。投递状态不表示用户已读。</p><pre>{JSON.stringify(records,null,2)}</pre><button disabled={busy} onClick={()=>void run(refresh)}>回读记录</button></details></>}
    {notice&&<p role="status">{notice}</p>}
  </section>
}

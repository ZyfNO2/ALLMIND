import {useEffect,useState} from 'react'
import {api} from '../book-api'
import type {NapcatHostView} from '../../../../contracts/napcat-host'

const prefix='/channels/qq/napcat'
export default function NapcatSettings({channelEnabled,expectedAccount}:{channelEnabled:boolean;expectedAccount:string}){
  const [view,setView]=useState<NapcatHostView>(),[directory,setDirectory]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[qr,setQr]=useState(''),[confirmSwitch,setConfirmSwitch]=useState(false)
  useEffect(()=>{const controller=new AbortController();api<NapcatHostView>(prefix,{signal:controller.signal}).then(value=>{setView(value);setDirectory(value.installDirectory)}).catch(e=>{if(!controller.signal.aborted)setError(e.message)});return()=>controller.abort()},[])
  useEffect(()=>{
    if(!view?.configured)return
    const controller=new AbortController();let running=false
    const timer=setInterval(()=>{if(running||busy)return;running=true;api<NapcatHostView>(prefix,{signal:controller.signal}).then(value=>{setView(value);if(value.online)setQr('')}).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{running=false})},5000)
    return()=>{clearInterval(timer);controller.abort()}
  },[view?.configured,busy])
  async function act(work:()=>Promise<void>){setBusy(true);setError('');setNotice('');try{await work()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  const disabled=busy||channelEnabled,dirty=directory!==(view?.installDirectory??'')
  return <section className="qq-section qq-account" aria-label="NapCat 登录与管理"><span className="ef-eyebrow">// QQ ACCOUNT</span><h3>QQ 登录与账号</h3>
    <p className="mb-muted">在这里扫码、检查登录或更换机器人账号，无需另开 NapCat 网页。</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <details className="qq-install-location" open={!view?.configured}><summary>NapCat 安装位置</summary><label>NapCat 安装目录<input disabled={disabled} placeholder="包含 NapCatWinBootMain.exe 和 versions 的目录" value={directory} onChange={e=>setDirectory(e.target.value)}/></label>
    <button disabled={disabled||!view||!directory} onClick={()=>void act(async()=>{const next=await api<NapcatHostView>(prefix,{method:'PUT',body:{settings:{installDirectory:directory},expectedRevision:view!.revision}});setView(next);setDirectory(next.installDirectory);setQr('');setNotice('已连接本机安装；WebUI 凭据已单独保存，不会回显。')})}>连接此安装</button>
    </details>{view?.configured&&<>
      <p className="qq-account-identity" role="status">{view.online?`当前 QQ：${view.accountId} / ${view.nickname||'昵称暂不可用'}`:view.reachable?'NapCat 已启动，等待扫码登录':'NapCat 尚未就绪'}{view.online&&(view.accountId!==expectedAccount||!expectedAccount)?' / 账号不匹配，请勿启用回复':''}</p>
      {view.error&&<p className="mb-muted">{view.error}</p>}
      <p className="mb-muted">预期机器人：{expectedAccount||'先在连接配置中保存机器人 QQ 号'} / 仅连接本机</p>
      <div className="qq-actions">
        <button disabled={disabled||dirty} onClick={()=>void act(async()=>{await api(prefix+'/start',{method:'POST',body:{}});setNotice('已请求启动 NapCat；启动较慢时请稍候，状态每 5 秒更新。')})}>启动 NapCat</button>
        <button disabled={disabled||dirty} onClick={()=>void act(async()=>{await api(prefix+'/stop',{method:'POST',body:{}});setQr('');setView(await api<NapcatHostView>(prefix));setNotice('已停止指定独立目录的 NapCat，其他 QQ 未操作。')})}>停止 NapCat</button>
        <button disabled={busy} onClick={()=>void act(async()=>{const next=await api<NapcatHostView>(prefix);setView(next);if(next.online)setQr('')})}>检查登录状态</button>
      </div>
      {!view.online&&<div className="qq-actions"><button className="mb-primary" disabled={disabled||dirty||!view.reachable} onClick={()=>void act(async()=>{const result=await api<{image:string}>(prefix+'/qr',{method:'POST',body:{refresh:false}});setQr(result.image)})}>显示登录二维码</button>
        <button disabled={disabled||dirty||!view.reachable||view.online} onClick={()=>void act(async()=>{setQr('');const result=await api<{image:string}>(prefix+'/qr',{method:'POST',body:{refresh:true}});setQr(result.image)})}>刷新二维码</button>
      </div>}
      {qr&&<figure><img src={qr} width="256" height="256" alt="NapCat QQ 登录二维码"/><figcaption>请用预期机器人账号扫码；登录成功后二维码自动收起。二维码过期时点击刷新。</figcaption></figure>}
      <details><summary>登错号？重新扫码</summary><p>这会关闭当前 NapCat 登录并重启其后台，不会修改白名单或把旧会话迁给其他账号。</p><label><input type="checkbox" disabled={disabled} checked={confirmSwitch} onChange={e=>setConfirmSwitch(e.target.checked)}/>确认退出当前 NapCat 账号，重新扫码</label><button disabled={disabled||dirty||!view.reachable||!confirmSwitch} onClick={()=>void act(async()=>{await api(prefix+'/switch-account',{method:'POST',body:{confirmed:true}});setQr('');setConfirmSwitch(false);setNotice('已请求重新扫码，等待后台重启后显示二维码。')})}>退出当前账号并重新扫码</button></details>
      <details><summary>自动配置 OneBot 反向连接</summary><p>先在连接配置中保存机器人 QQ 号、端口和 access token，再停止 NapCat。仅更新此账号的 ALLMIND-local 连接，保留其他配置；随后启动 NapCat。</p><button disabled={disabled||dirty} onClick={()=>void act(async()=>{await api(prefix+'/prepare',{method:'POST',body:{}});setNotice('反向连接已写入。现在启动 NapCat，登录后审核角色并启动 QQ 通道。')})}>写入 ALLMIND 反向连接</button></details>
    </>}
    {channelEnabled&&<p className="mb-muted">QQ 自动回复正在运行。停止通道后才能切换登录或管理 NapCat。</p>}
  </section>
}

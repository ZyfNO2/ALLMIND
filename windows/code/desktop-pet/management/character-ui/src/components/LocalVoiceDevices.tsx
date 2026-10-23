import {useEffect,useState} from 'react'
import {api} from '../book-api'
import {readVoiceDevices,saveVoiceDevices,type VoiceDevicePreference} from '../voice-devices'
export default function LocalVoiceDevices(){
 const [installed,setInstalled]=useState<boolean|null>(null)
 const [devices,setDevices]=useState<MediaDeviceInfo[]>([]),[preference,setPreference]=useState<VoiceDevicePreference|null>(null),[error,setError]=useState('')
 useEffect(()=>{const controller=new AbortController();void api<{installed?:boolean}>('/voice/capabilities',{signal:controller.signal}).then(row=>setInstalled(row.installed!==false)).catch(()=>setInstalled(true));return()=>controller.abort()},[])
 if(installed===null)return <section className="mb-card" aria-label="本机音频设备"><h3>本机音频设备</h3><p role="status">正在检查语音模块…</p></section>
 if(!installed)return <section className="mb-card" aria-label="本机音频设备"><h3>本机音频设备</h3><p role="status">语音模块未安装，没有录音或设备入口。</p></section>
 async function inspect(){setError('');try{setPreference(readVoiceDevices());setDevices(await navigator.mediaDevices.enumerateDevices())}catch(e){setError(e instanceof Error?e.message:String(e))}}
 function save(next:VoiceDevicePreference){try{saveVoiceDevices(next);setPreference(next);setError('')}catch(e){setError(e instanceof Error?e.message:String(e))}}
 return <section className="mb-card" aria-label="本机音频设备"><h3>本机音频设备</h3><p>设备偏好仅保存在此浏览器，不进入角色备份或同步。切换设备立即停止当前录音/播放。列举设备不会录音；标签未知时请先完成浏览器麦克风授权。</p>{error&&<p role="alert">{error}</p>}<button type="button" onClick={()=>void inspect()}>读取本机音频设备</button><button type="button" onClick={()=>save({input:null,output:null})}>恢复系统默认设备</button>{preference&&(['input','output'] as const).map(kind=><label key={kind}>{kind==='input'?'麦克风设备':'扬声器设备'}<select aria-label={kind==='input'?'麦克风设备':'扬声器设备'} value={preference[kind]??''} onChange={e=>save({...preference,[kind]:e.target.value||null})}><option value="">系统默认</option>{preference[kind]&&!devices.some(row=>row.deviceId===preference[kind])&&<option value={preference[kind]!}>先前设备（当前未检测到）</option>}{devices.filter(row=>row.kind===(kind==='input'?'audioinput':'audiooutput')&&row.deviceId).map((row,index)=><option key={row.deviceId} value={row.deviceId}>{row.label||'设备 '+(index+1)+'（名称未知）'}</option>)}</select></label>)}<small>显式选择的设备消失或浏览器不支持输出选择时会报错，不会静默换到别的设备。物理设备效果需手动验收。</small></section>
}

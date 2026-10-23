import {useState} from 'react'
import type {RuntimeConfig} from '../../../../contracts/memory-book'
import {DEFAULT_COMPANION_SETTINGS,companionFrequency} from '../../../../contracts/book-companion'
import KeyboardActivity from './KeyboardActivity'
type Section='all'|'proactive'|'privacy'|'advanced'|'keyboard'
export default function CompanionSettings({config,onChange,section='all'}:{config:RuntimeConfig;onChange:(config:RuntimeConfig)=>void;section?:Section}){
  const settings=config.companion??DEFAULT_COMPANION_SETTINGS,[timeError,setTimeError]=useState('')
  const frequency=companionFrequency(settings)
  const set=(patch:Partial<typeof settings>)=>onChange({...config,companion:{...settings,...patch}})
  const show=(name:Section)=>section==='all'||section===name
  const time=(hour:number)=>String(hour).padStart(2,'0')+':00'
  function setTime(field:'quietStart'|'quietEnd',value:string){if(!/^([01]\d|2[0-3]):00$/.test(value)){setTimeError('当前安静时段按整点保存，请选择 HH:00；不会自动取整。');return}setTimeError('');set({[field]:Number(value.slice(0,2))})}
  let zoneError='',offset=''
  try{offset=new Intl.DateTimeFormat('en',{timeZone:settings.timezone,timeZoneName:'longOffset'}).formatToParts(new Date()).find(part=>part.type==='timeZoneName')?.value.replace('GMT','UTC')??'';if(offset==='UTC')offset='UTC+00:00'}catch{zoneError='时区无效，请选择有效的 IANA 时区。'}
  return <>
    {show('proactive')&&<section className="mb-card" aria-label="主动交流"><h2>主动交流</h2><label><input type="checkbox" checked={settings.proactive} onChange={event=>set({proactive:event.target.checked})}/>主动问候与事件跟进</label><p className="mb-muted">按下方频率限制主动请求；自然日和滚动 24 小时共用上限，失败尝试也计入。隐藏、免打扰、输入、录音、朗读或其他任务进行中保持安静；连续两次未回应后暂停。</p>
      <div className="mb-row"><label>每日主动请求上限<select aria-label="每日主动请求上限" value={frequency.dailyLimit} onChange={event=>set({dailyLimit:Number(event.target.value)})}>{[1,2,3,4,5,6].map(limit=><option key={limit} value={limit}>{limit} 次</option>)}</select></label><label>最短间隔（分钟）<input aria-label="最短间隔（分钟）" type="number" min={30} max={1440} step={1} value={frequency.minimumIntervalMinutes} onChange={event=>set({minimumIntervalMinutes:Number(event.target.value)})}/></label></div><small>保存后生效。最短间隔 30～1440 分钟；调整频率不会清空已消耗预算，也不会补发错过的问候。</small>
      <label>时区<input aria-label="时区" aria-invalid={!!zoneError} aria-describedby="companion-zone-note" list="companion-timezones" value={settings.timezone} onChange={event=>set({timezone:event.target.value})}/></label><datalist id="companion-timezones">{['Asia/Singapore','Asia/Shanghai','Asia/Tokyo','Europe/London','America/New_York','UTC'].map(zone=><option key={zone} value={zone}/>)}</datalist><small id="companion-zone-note">{zoneError||('当前日期偏移 '+offset+'，夏令时按所选时区计算。')}</small>
      <div className="mb-row"><label>安静开始时<input aria-label="安静开始时" type="time" step={3600} value={time(settings.quietStart)} onChange={event=>setTime('quietStart',event.target.value)}/></label><label>安静结束时<input aria-label="安静结束时" type="time" step={3600} value={time(settings.quietEnd)} onChange={event=>setTime('quietEnd',event.target.value)}/></label></div>{timeError&&<p role="alert">{timeError}</p>}<p role="status">{settings.quietStart===settings.quietEnd?'未设置固定安静时段':time(settings.quietStart)+' ～ '+(settings.quietEnd<settings.quietStart?'次日 ':'')+time(settings.quietEnd)}</p>
      <label>事件跟进窗口<select value={settings.followUpHour??''} onChange={event=>set({followUpHour:event.target.value===''?null:Number(event.target.value)})}><option value="">未设置，仅有据的开始前关心</option>{Array.from({length:24},(_,hour)=><option key={hour} value={hour}>{hour}:00～{hour}:30</option>)}</select></label><small>按事件的时区计算；没有结束时间只询问进展，不推断完成或结果。</small>
    </section>}
    {show('privacy')&&<section className="mb-card" aria-label="记忆隐私"><h3>记忆隐私</h3><label><input type="checkbox" checked={settings.autoMemory} onChange={event=>set({autoMemory:event.target.checked})}/>自动记忆</label><p>保存已提交用户发言中的明确事实、原文依据与修订；私人资料保存在本机。</p><label><input type="checkbox" checked={settings.cloudMemoryConsent} onChange={event=>set({cloudMemoryConsent:event.target.checked})}/>授权后台将用户消息发给所选整理模型（独立于回复授权）</label><small>模型模式会将原文发往 Wiki/Fast 来源。关闭后停止新任务；第三方已收到的内容不能通过本地操作撤回。</small></section>}
    {show('advanced')&&<section className="mb-card"><h3>后台整理方式</h3><label>提取方式<select value={settings.extraction} onChange={event=>set({extraction:event.target.value as typeof settings.extraction})}><option value="declarations">本地事实声明</option><option value="model">已绑定模型整理自然语言</option></select></label><small>声明模式仅处理“属性：值”；自然语言整理使用绑定的 Wiki/Fast 模型，保留失败与人工审核。</small></section>}
    {show('keyboard')&&<KeyboardActivity key={config.currentCharacterId} characterId={config.currentCharacterId}/>}
  </>
}

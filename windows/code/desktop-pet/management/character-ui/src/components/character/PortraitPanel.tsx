import {useEffect,useRef,useState} from 'react'
import {api} from '../../book-api'
import {Panel} from './primitives'
import ResourcePicker,{ResourceImage} from '../ResourcePicker'
import type {ResourceRecord} from '../../../../../contracts/book-resources'
import type {PortraitSet,OutfitJob} from '../../../../../contracts/portraits'
import type {GptNiangReport} from '../../../../../management/gpt-niang-local'

const activePhases=['preparing','submitted','receiving','submission_unknown']
export default function PortraitPanel({characterId}:{characterId:string}){
 const [collection,setCollection]=useState<PortraitSet|null>(null),[job,setJob]=useState<OutfitJob|null>(null)
 const [references,setReferences]=useState<ResourceRecord[]>([]),[name,setName]=useState('静态立绘'),[names,setNames]=useState<Record<string,string>>({})
 const [instruction,setInstruction]=useState('保持人物身份和姿势，换成另一套衣服。'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 const [conversationMode,setConversationMode]=useState('source')
 const [localRoot,setLocalRoot]=useState(''),[localPet,setLocalPet]=useState<GptNiangReport|null>(null)
 const current=useRef(characterId);current.current=characterId
 const pending=useRef<{fingerprint:string;operationId:string}|null>(null)
 const scope={characterId,sessionId:'web-chat'},query='?characterId='+encodeURIComponent(characterId)+'&sessionId=web-chat',storageKey='allmind-outfit:'+characterId
 async function load(){const next=await api<PortraitSet>('/appearance/portraits'+query);if(current.current===characterId)setCollection(next)}
 useEffect(()=>{let live=true;current.current=characterId;setBusy(false);setCollection(null);setJob(null);setReferences([]);setMessage('');setNames({});pending.current=null;void load().catch(error=>{if(live)setMessage(String(error))});const id=sessionStorage.getItem(storageKey);if(id)void api<OutfitJob>('/appearance/outfits/'+encodeURIComponent(id)+query).then(next=>{if(live)setJob(next)}).catch(error=>{if(live)setMessage(String(error))});return()=>{live=false;current.current=''}},[characterId])
 useEffect(()=>{if(!job||!activePhases.includes(job.phase))return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;async function poll(){try{const next=await api<OutfitJob>('/appearance/outfits/'+job!.id+query,{signal:controller.signal});if(!controller.signal.aborted){setJob(next);if(activePhases.includes(next.phase))timer=setTimeout(()=>void poll(),3000)}}catch(error){if(!controller.signal.aborted)setMessage('任务查询失败，可点击刷新：'+String(error))}}timer=setTimeout(()=>void poll(),2000);return()=>{controller.abort();clearTimeout(timer)}},[job?.id,query])
 async function run(action:()=>Promise<void>){setBusy(true);setMessage('');try{await action()}catch(error){if(current.current===characterId)setMessage(String(error))}finally{if(current.current===characterId)setBusy(false)}}
 async function mutate(route:string,body:Record<string,unknown>,method='POST'){const next=await api<PortraitSet>(route,{method,body:{...scope,...body,expectedRevision:collection!.revision,operationId:crypto.randomUUID()}});if(current.current===characterId)setCollection(next)}
 async function generate(){const request={...scope,...(conversationMode==='source'?{}:{conversationMode}),expectedAppearanceRevision:collection!.revision,instruction,references:references.map(row=>({resourceId:row.id,sha256:row.sha256!,resourceRevision:row.revision}))};const fingerprint=JSON.stringify(request);if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,operationId:crypto.randomUUID()};const next=await api<OutfitJob>('/appearance/outfits',{method:'POST',body:{...request,operationId:pending.current.operationId}});if(current.current!==characterId)return;setJob(next);sessionStorage.setItem(storageKey,next.id);pending.current=null}
 return <Panel title="静态立绘与换装" description="上传透明 PNG/WebP 添加差分。点击生成会把选中的参考图发给当前 GPT 网页；生成后预览，再选择是否应用。">
  <button type="button" disabled={busy} onClick={()=>void run(load)}>刷新立绘</button>
  <details><summary>从本地 GPT-Niang 读取形象与额度</summary>
   <p>自动查找已安装的 GPT 娘；也可填写本地项目的 gpt-niang-usage 目录。只读形象和额度快照，不启动原挂件。</p>
   <label>本地 GPT 娘目录（选填）<input value={localRoot} onChange={event=>{setLocalRoot(event.target.value);setLocalPet(null)}}/></label>
   <button type="button" disabled={busy} onClick={()=>void run(async()=>{const result=await api<GptNiangReport>('/appearance/gpt-niang',{method:'POST',body:{...scope,...(localRoot.trim()?{sourceRoot:localRoot.trim()}:{})}});if(current.current===characterId)setLocalPet(result)})}>读取本地 GPT 娘</button>
   {localPet&&<><p>额度：{localPet.quota.state==='fresh'?'近期本地快照':localPet.quota.state==='stale'?'过期快照（非当前额度）':'暂无快照'}{localPet.quota.observedAt?' · '+new Date(localPet.quota.observedAt).toLocaleString():''}</p>
    {localPet.quota.windows.map((window,index)=><p key={index}>{window.minutes===null?'个人额度':window.minutes+' 分钟窗口'} · 剩余 {window.remaining}%</p>)}
    {localPet.notes.map(note=><p key={note}>{note}</p>)}
    {localPet.portraits.map(portrait=><div key={portrait.id}><p>{portrait.name}</p><ResourceImage id={portrait.id} query={query} route={'/appearance/gpt-niang/'+portrait.id+'/image'}/><button type="button" disabled={busy||!collection} onClick={()=>void run(()=>mutate('/appearance/gpt-niang/import',{portraitId:portrait.id,name:portrait.name}))}>添加为本地立绘</button><small>添加后仍需点击“使用此差分”。图片保留在本机，不随空白发布包分发。</small></div>)}
   </>}
  </details>
  {collection&&<><p>当前取景：{collection.framing==='bust'?'半身':'全身'}</p><button type="button" disabled={busy} onClick={()=>void run(()=>mutate('/appearance/portraits/framing',{framing:collection.framing==='bust'?'full':'bust'}))}>切换为{collection.framing==='bust'?'全身':'半身'}</button><button type="button" disabled={busy||!collection.selectedVariantId} onClick={()=>void run(()=>mutate('/appearance/portraits/select',{variantId:null}))}>恢复原模型</button>
   {collection.variants.map(variant=><fieldset key={variant.id} disabled={busy}><legend>{variant.name}{collection.selectedVariantId===variant.id?' · 正在使用':''}</legend>
    <ResourceImage id={variant.id} query={query} route={'/appearance/portraits/'+variant.id+'/image'}/>
    <label>差分名称<input value={names[variant.id]??variant.name} onChange={event=>setNames({...names,[variant.id]:event.target.value})}/></label>
    <button type="button" onClick={()=>void run(()=>mutate('/appearance/portraits/'+variant.id,{name:names[variant.id]??variant.name},'PATCH'))}>重命名</button>
    <button type="button" disabled={collection.selectedVariantId===variant.id} onClick={()=>void run(()=>mutate('/appearance/portraits/select',{variantId:variant.id}))}>使用此差分</button>
    <button type="button" onClick={()=>void run(async()=>{const record=await api<ResourceRecord>('/appearance/portraits/'+variant.id+'/reference',{method:'POST',body:{...scope,operationId:crypto.randomUUID()}});if(current.current===characterId)setReferences([record])})}>用作换装参考</button>
    <button type="button" onClick={()=>void run(()=>mutate('/appearance/portraits/'+variant.id,{},'DELETE'))}>删除差分</button>
   </fieldset>)}
  </>}
  <ResourcePicker query={query} kind="image" value={references} onChange={setReferences}/>
  <label>新增差分名称<input value={name} onChange={event=>setName(event.target.value)}/></label>
  <button type="button" disabled={busy||!collection||references.length!==1} onClick={()=>void run(()=>mutate('/appearance/portraits',{name,resourceId:references[0]!.id,sha256:references[0]!.sha256}))}>将选中图片添加为差分</button>
  <label>换装要求<textarea value={instruction} onChange={event=>setInstruction(event.target.value)}/></label>
  <label>本次网页会话<select value={conversationMode} onChange={event=>setConversationMode(event.target.value)}><option value="source">沿用来源设置</option><option value="temporary">新建临时聊天</option><option value="regular">新建普通聊天</option></select></label><small>临时聊天的图像能力需以实际返回为准。普通聊天会留在 GPT 网页历史中，云端记忆范围未核验；此选项只影响本次换装。</small>
  <button type="button" disabled={busy||!collection||!references.length||!!job&&activePhases.includes(job.phase)} onClick={()=>void run(generate)}>发送参考图并生成衣装</button>
  {job&&<div><p role="status">换装状态：{job.phase}{job.error?'：'+job.error:''}</p>
   <button type="button" disabled={busy} onClick={()=>void run(async()=>{setJob(await api<OutfitJob>('/appearance/outfits/'+job.id+query))})}>刷新任务</button>
   {activePhases.includes(job.phase)&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{setJob(await api<OutfitJob>('/appearance/outfits/'+job.id+'/cancel',{method:'POST',body:scope}))})}>取消生成</button>}
   {job.images.map(image=><div key={image.resourceId}><ResourceImage id={image.resourceId} query={query}/><p>{image.width} × {image.height} · {image.warning??'可以应用此图片。'}</p><button type="button" disabled={busy||job.phase!=='ready'} onClick={()=>void run(async()=>{const next=await api<OutfitJob>('/appearance/outfits/'+job.id+'/apply',{method:'POST',body:{...scope,resourceId:image.resourceId,sha256:image.sha256,expectedAppearanceRevision:collection?.revision,operationId:crypto.randomUUID()}});setJob(next);await load();setMessage('已收到桌宠载入确认，衣装已应用。')})}>应用这张衣装</button></div>)}
  </div>}
  {message&&<p role="status">{message}</p>}
 </Panel>
}

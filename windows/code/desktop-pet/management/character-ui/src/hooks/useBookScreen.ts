import {useEffect,useRef,useState} from 'react'
import {api,releaseScreenObservation} from '../book-api'
import {SENSITIVE_SCREEN_TERMS,type BookScreenObservation} from '../../../../contracts/book-screen'

type Phase='idle'|'selecting'|'preview'|'recognizing'|'attaching'|'ready'
type ScreenJob={key:string;characterId:string;sessionId:string;controller:AbortController;stream?:MediaStream;url?:string;blob?:Blob;id?:string;sourceName?:string;sourceKind?:string;previewUntil?:number;expiry?:ReturnType<typeof setTimeout>}
export function useBookScreen(characterId:string,sessionId:string,page:string,blocked:string[],onClear:()=>void){
 const key=JSON.stringify([characterId,sessionId,page,blocked]),current=useRef(key);current.current=key
 const callbacks=useRef(onClear);callbacks.current=onClear
 const jobRef=useRef<ScreenJob>(),[phase,setPhase]=useState<Phase>('idle'),[error,setError]=useState(''),[preview,setPreview]=useState(''),[observation,setObservation]=useState<BookScreenObservation>(),[selected,setSelected]=useState(false),[used,setUsed]=useState(false),[installed,setInstalled]=useState(true)
 const route=(path:string)=>path+'?'+new URLSearchParams({characterId,sessionId})
 const [imageAdded,setImageAdded]=useState(false)
 function release(pagehide=false){const job=jobRef.current;jobRef.current=undefined;if(!job)return;job.controller.abort();job.stream?.getTracks().forEach(track=>track.stop());if(job.url)URL.revokeObjectURL(job.url);clearTimeout(job.expiry);if(job.id&&pagehide)releaseScreenObservation(job.characterId,job.sessionId,job.id);else if(job.id)void api('/screen/observations/'+job.id+'?'+new URLSearchParams({characterId:job.characterId,sessionId:job.sessionId}),{method:'DELETE',body:{}}).catch(failure=>{if((failure as {status?:number}).status!==404)console.error('屏幕观察清除失败',failure instanceof Error?failure.name:'network_error')});job.blob=undefined;callbacks.current()}
 function clear(){release();setPhase('idle');setPreview('');setObservation(undefined);setSelected(false);setUsed(false);setImageAdded(false);setError('')}
 useEffect(()=>{setImageAdded(false);setPhase('idle');setPreview('');setObservation(undefined);setSelected(false);setUsed(false);setError('');const leave=()=>release(true);window.addEventListener('pagehide',leave);return()=>{window.removeEventListener('pagehide',leave);release()}},[key])
 useEffect(()=>{const controller=new AbortController();void api<{installed?:boolean}>(route('/screen/capabilities'),{signal:controller.signal}).then(row=>{if(row.installed===false)setInstalled(false)}).catch(()=>{});return()=>controller.abort()},[characterId,sessionId])
 function fail(job:ScreenJob,failure:unknown){if(jobRef.current!==job||current.current!==key)return;release();setPhase('idle');setPreview('');setObservation(undefined);setSelected(false);setError(failure instanceof DOMException&&failure.name==='NotAllowedError'?'没有授权屏幕来源，未采集或上传画面。':failure instanceof Error?failure.message:String(failure))}
 async function choose(){
  if(phase==='selecting'||phase==='recognizing')return
  const caps=await api<{installed?:boolean}>(route('/screen/capabilities'))
  if(caps.installed===false){setInstalled(false);setError('屏幕模块未安装，没有截屏入口。');return}
  clear();const job:ScreenJob={key,characterId,sessionId,controller:new AbortController()};jobRef.current=job;setPhase('selecting')
  try{
   if(!navigator.mediaDevices?.getDisplayMedia)throw Error('当前浏览器不支持屏幕来源选择，请在本机 Chrome 或 Edge 中打开管理页。')
   const stream=await navigator.mediaDevices.getDisplayMedia({audio:false,video:{frameRate:{ideal:1,max:5}}})
   if(jobRef.current!==job||current.current!==key){stream.getTracks().forEach(track=>track.stop());return}
   job.stream=stream;const track=stream.getVideoTracks()[0];if(!track||!track.label.trim())throw Error('系统未提供明确的屏幕来源名称，请重新选择。')
   const surface=track.getSettings().displaySurface
   job.sourceName=track.label;job.sourceKind=surface==='monitor'?'screen':surface??'screen'
   if([...SENSITIVE_SCREEN_TERMS,...blocked].some(term=>track.label.normalize('NFKC').toLocaleLowerCase().includes(term.normalize('NFKC').toLocaleLowerCase())))throw Error('所选来源命中敏感窗口排除项，没有截取画面。')
   const video=document.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=stream
   try{await video.play();if(job.controller.signal.aborted)return
    if(!video.videoWidth||!video.videoHeight||video.videoWidth*video.videoHeight>40000000)throw Error('屏幕尺寸无效或过大，请选择更小的窗口。')
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight
    try{const context=canvas.getContext('2d');if(!context)throw Error('无法创建屏幕预览。');context.drawImage(video,0,0)
     const encode=(type:string)=>new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('屏幕预览编码失败。')),type,0.92))
     let blob=await encode('image/png');if(blob.size>1500000)blob=await encode('image/jpeg');if(blob.size>1500000)throw Error('截图超过 1.5 MB，请选择更小的窗口；没有上传画面。')
     if(jobRef.current!==job||current.current!==key)return
     job.blob=blob;job.url=URL.createObjectURL(blob);job.previewUntil=Date.now()+60000;setPreview(job.url);setPhase('preview');job.expiry=setTimeout(clear,60000)
    }finally{canvas.width=0;canvas.height=0}
   }finally{stream.getTracks().forEach(track=>track.stop());job.stream=undefined;video.pause();video.srcObject=null}
  }catch(failure){fail(job,failure)}
 }
 async function recognize(){
  const job=jobRef.current;if(!job?.blob||phase!=='preview')return
  if(Date.now()>=(job.previewUntil??0)){clear();setError('预览已过期，请重新选取。');return}
  clearTimeout(job.expiry);setPhase('recognizing');setError('')
  try{const bytes=new Uint8Array(await job.blob.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);bytes.fill(0)
   const result=await api<BookScreenObservation>(route('/screen/recognize'),{method:'POST',body:{imageBase64:btoa(binary),mime:job.blob.type,sourceName:job.sourceName,sourceKind:job.sourceKind,confirmed:true},signal:job.controller.signal,timeoutMs:35000})
   if(jobRef.current!==job||current.current!==key)return
   job.id=result.id;job.blob=undefined;if(job.url){URL.revokeObjectURL(job.url);job.url=undefined}setPreview('');setObservation(result);setPhase('ready');job.expiry=setTimeout(clear,Math.max(0,result.expiresAt-Date.now()))
  }catch(failure){fail(job,failure)}
 }
 async function attachImage(upload:(file:File,signal:AbortSignal)=>Promise<void>){
  const job=jobRef.current;if(!job?.blob||phase!=='preview')return
  if(Date.now()>=(job.previewUntil??0)){clear();setError('预览已过期，请重新选取。');return}
  clearTimeout(job.expiry);setPhase('attaching');setError('')
  try{
   await upload(new File([job.blob],job.blob.type==='image/png'?'screen.png':'screen.jpg',{type:job.blob.type}),job.controller.signal)
   if(jobRef.current!==job||current.current!==key)return
   clear();setImageAdded(true)
  }catch(failure){fail(job,failure)}
 }
 const valid=jobRef.current?.key===key
 return {installed,phase:valid?phase:'idle' as Phase,error,imageAdded,preview:valid?preview:'',observation:valid?observation:undefined,selected:valid&&selected,used:valid&&used,clear,choose,recognize,attachImage,setSelected,markUsed:()=>{setSelected(false);setUsed(true)},busy:phase==='selecting'||phase==='recognizing'||phase==='attaching',inputId:valid&&selected&&!used?observation?.id:undefined}
}

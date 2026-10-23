import {useEffect,useRef,useState} from 'react'
import {api} from '../book-api'
import {CaptureError} from '../../../../media/capture-errors'
import {BrowserCaptureDriver} from '../../../../media/browser-capture'
import type {CaptureSession} from '../../../../media/capture'
import {DEFAULT_BOOK_VOICE,type BookVoiceSettings} from '../../../../contracts/book-voice'
import {speechChunks} from '../../../../core/speech-chunks'
import {readVoiceDevices} from '../voice-devices'
import type {TextTranscriptReceipt} from '../../../../contracts/book-message'

type VoiceJob={controller:AbortController;capture?:CaptureSession;audio?:HTMLAudioElement;url?:string;timer?:ReturnType<typeof setTimeout>;finishing?:boolean}
type Stage='idle'|'opening'|'recording'|'recognizing'|'generating'|'playing'
/** One volatile operation. A scope/settings change invalidates every awaited result. */
export function useLocalVoice(characterId:string,sessionId:string,page:string,settings:BookVoiceSettings|undefined,onTranscript:(text:string,receipt?:Omit<TextTranscriptReceipt,'start'|'end'>)=>void){
 const value=settings??DEFAULT_BOOK_VOICE,key=JSON.stringify([characterId,sessionId,page,value]),current=useRef(key);current.current=key
 const callback=useRef(onTranscript);callback.current=onTranscript
 const [stage,setStage]=useState<Stage>('idle'),[error,setError]=useState(''),[installed,setInstalled]=useState(true)
 const active=useRef<VoiceJob>()
 function release(){const job=active.current;active.current=undefined;if(!job)return;clearTimeout(job.timer);job.controller.abort();job.capture?.stop();if(job.audio){job.audio.pause();job.audio.removeAttribute('src');job.audio.load()}if(job.url)URL.revokeObjectURL(job.url)}
 function stop(){release();setStage('idle')}
 useEffect(()=>{setStage('idle');setError('');return release},[key])
 useEffect(()=>{window.addEventListener('allmind-voice-device-change',stop);return()=>window.removeEventListener('allmind-voice-device-change',stop)},[])
 useEffect(()=>{const controller=new AbortController();void api<{installed?:boolean}>('/voice/capabilities',{signal:controller.signal}).then(row=>{if(row.installed===false)setInstalled(false)}).catch(()=>{});return()=>controller.abort()},[characterId,sessionId])
 const route=(path:string)=>path+'?'+new URLSearchParams({characterId,sessionId})
 function fail(job:VoiceJob,failure:unknown){if(active.current!==job||current.current!==key)return;release();setStage('idle');setError(failure instanceof CaptureError&&failure.failure.code==='permission_denied'?'麦克风权限未开启，请在浏览器或 Windows 隐私设置中允许后重试。':failure instanceof Error?failure.message:String(failure))}
 async function finish(){
  const job=active.current;if(!job?.capture||job.finishing||stage!=='recording')return;job.finishing=true
  clearTimeout(job.timer);setStage('recognizing')
  try{const captured=await job.capture.finish();job.capture=undefined
   try{let binary='';for(const byte of captured.audio)binary+=String.fromCharCode(byte)
    const result=await api<{text:string;receipt:Omit<TextTranscriptReceipt,'start'|'end'>}>(route('/voice/recognize'),{method:'POST',body:{audioBase64:btoa(binary)},signal:job.controller.signal})
    if(active.current!==job||current.current!==key)return
    callback.current(result.text,result.receipt);release();setStage('idle')
   }finally{captured.audio.fill(0)}
  }catch(failure){fail(job,failure)}
 }
 // Keep the timer bound to the current recording, not a stale render's stage.
 const finishRef=useRef(finish);finishRef.current=finish
 async function record(){
  if(!installed||!value.enabled||active.current)return
  const job={controller:new AbortController()} as VoiceJob;active.current=job;setError('');setStage('opening')
  try{const preference=readVoiceDevices(),driver=new BrowserCaptureDriver({deviceId:preference.input,cameraEnabled:false,sampleRate:16000,cameraWidth:320,jpegQuality:0.7,maxBufferedSamples:48000*17,workletModuleUrl:new URL('../../../../media/recorder-worklet.mjs',import.meta.url)})
   const capture=await driver.open(AbortSignal.any([job.controller.signal,AbortSignal.timeout(20000)]))
   if(active.current!==job||current.current!==key){capture.stop();return}
   job.capture=capture;setStage('recording');job.timer=setTimeout(()=>void finishRef.current(),15000)
  }catch(failure){fail(job,failure)}
 }
 async function speak(text:string){
  if(!value.enabled)return
  release();const job={controller:new AbortController()} as VoiceJob;active.current=job;setStage('generating');setError('')
  try{const preference=readVoiceDevices(),chunks=speechChunks(text)
   const generate=(part:string)=>api<{audioBase64:string;mime:string}>(route('/voice/synthesize'),{method:'POST',body:{text:part},signal:job.controller.signal}).then(value=>({value}),error=>{fail(job,error);return {error}})
   let pending=generate(chunks[0]!)
   for(let index=0;index<chunks.length;index++){
    const received=await pending;if('error' in received)throw received.error
    if(active.current!==job||current.current!==key)return
    const result=received.value,bytes=Uint8Array.from(atob(result.audioBase64),char=>char.charCodeAt(0));job.url=URL.createObjectURL(new Blob([bytes],{type:result.mime}));bytes.fill(0)
    const audio=job.audio=new Audio(job.url)
    if(preference.output){if(typeof audio.setSinkId!=='function')throw Error('当前浏览器不支持选择扬声器；未切换到默认设备。');await audio.setSinkId(preference.output)}
    if(active.current!==job||current.current!==key)return
    // Exactly one next chunk may synthesize while this one plays; cancellation owns both.
    if(index+1<chunks.length)pending=generate(chunks[index+1]!)
    setStage('playing')
    await new Promise<void>((resolve,reject)=>{const abort=()=>reject(job.controller.signal.reason??new DOMException('Cancelled','AbortError'));job.controller.signal.addEventListener('abort',abort,{once:true});audio.onended=()=>{job.controller.signal.removeEventListener('abort',abort);resolve()};audio.onerror=()=>{job.controller.signal.removeEventListener('abort',abort);reject(Error('本地语音播放失败，请检查输出设备。'))};void audio.play().catch(error=>{job.controller.signal.removeEventListener('abort',abort);reject(error)})})
    audio.removeAttribute('src');audio.load();if(job.url)URL.revokeObjectURL(job.url);delete job.url;delete job.audio
   }
   if(active.current===job){release();setStage('idle')}
  }catch(failure){fail(job,failure)}
 }
 return {stage,error,installed,enabled:value.enabled,active:stage!=='idle',record,finish,stop,speak,newReply:(text:string)=>{if(installed&&value.enabled&&value.autoRead)void speak(text)}}
}

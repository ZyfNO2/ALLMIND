import {useEffect,useRef,useState} from 'react'
import {api,tokenKey} from '../book-api'
import type {BookInteractionFlags} from '../../../../core/book-interaction-presence'
export function useInteractionPresence(characterId:string,sessionId:string,enabled:boolean,flags:Omit<BookInteractionFlags,'typing'>){
 const [typing,setTyping]=useState(false),[error,setError]=useState(''),timer=useRef<ReturnType<typeof setTimeout>>(),session=useRef<{viewId:string;sequence:number;characterId:string;sessionId:string}>();
 const current=useRef({...flags,typing});current.current={...flags,typing}
 const send=useRef<()=>void>(()=>{})
 useEffect(()=>{
  setTyping(false);setError('');clearTimeout(timer.current);if(!enabled)return
  const lease={viewId:crypto.randomUUID(),sequence:0,characterId,sessionId};session.current=lease;let disposed=false
  const publish=()=>{const state=current.current;void api('/interaction-presence',{method:'POST',timeoutMs:5000,body:{...lease,sequence:++lease.sequence,...state}}).then(()=>{if(!disposed)setError('')}).catch(()=>{if(!disposed)setError('无法同步交互状态，请暂时使用免打扰；输入内容没有上传。')})}
  send.current=publish;publish();const heartbeat=setInterval(()=>{if(Object.values(current.current).some(Boolean))publish()},4000)
  const leave=()=>{const token=sessionStorage.getItem(tokenKey);if(!token)return;void fetch('/api/memory-book/v1/interaction-presence',{method:'POST',keepalive:true,credentials:'omit',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...lease,sequence:++lease.sequence,typing:false,recording:false,speaking:false,busy:false})}).catch(failure=>console.warn('页面交互释放未送达，将按有限租约过期',failure instanceof Error?failure.name:'network_error'))}
  window.addEventListener('pagehide',leave)
  return()=>{disposed=true;clearInterval(heartbeat);clearTimeout(timer.current);window.removeEventListener('pagehide',leave);leave();if(session.current===lease){session.current=undefined;send.current=()=>{}}}
 },[characterId,sessionId,enabled])
 useEffect(()=>{if(enabled)send.current()},[typing,flags.recording,flags.speaking,flags.busy,flags.roleplay,enabled])
 return {error,type:()=>{clearTimeout(timer.current);setTyping(true);timer.current=setTimeout(()=>setTyping(false),15000)},blur:()=>{clearTimeout(timer.current);setTyping(false)}}
}

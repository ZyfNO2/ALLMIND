import {useEffect,useState} from 'react'
import {api} from '../book-api'
import type {DialogueDecision,DialogueMode} from '../../../../contracts/book-dialogue'
import type {RuntimeConfig} from '../../../../contracts/memory-book'
export default function DialogueModeControl({config,characterId,sessionId,text,value,change,disabled}:{config:RuntimeConfig;characterId:string;sessionId:string;text:string;value:DialogueMode|'inherit';change:(mode:DialogueMode|'inherit')=>void;disabled:boolean}){
 const [decision,setDecision]=useState<DialogueDecision|null>(null),[error,setError]=useState('')
 useEffect(()=>{const controller=new AbortController(),timer=setTimeout(()=>{api<DialogueDecision>('/dialogue/preview',{method:'POST',body:{characterId,sessionId,text,dialogueMode:value},signal:controller.signal}).then(row=>{if(!controller.signal.aborted){setDecision(row);setError('')}}).catch(e=>{if(!controller.signal.aborted){setDecision(null);setError(e.message)}})},180);return()=>{clearTimeout(timer);controller.abort()}},[characterId,sessionId,text,value,config.revision])
 return <div className="mb-dialogue-control"><label>场景<select aria-label="本轮场景" disabled={disabled} value={value} onChange={e=>change(e.target.value as DialogueMode|'inherit')}><option value="inherit">沿用设置</option><option value="auto">Auto</option><option value="smart">Smart</option><option value="quick">Quick</option><option value="rp">RP</option></select></label><small role="status">{decision?`${decision.mode.toUpperCase()} · ${decision.model} · ${decision.presetId??'基础指令'} · ${decision.memoryDomain==='all'?'当前配对记忆':decision.memoryDomain==='fiction'?'故事与模拟':'核心人格'} · 输入≤${decision.inputBudget} / 输出≤${decision.outputBudget} tokens`:error||'正在读取场景策略…'}</small></div>
}

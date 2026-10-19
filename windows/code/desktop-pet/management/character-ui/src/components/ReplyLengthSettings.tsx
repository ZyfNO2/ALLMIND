import {useEffect,useState} from 'react'
import {validateReplyLength,type ReplyLengthSettings as Range,type ReplyStyle} from '../../../../contracts/reply-length'
import type {RuntimeCharacter} from '../../../../contracts/memory-book'

const STYLE_OPTIONS: Array<{value:ReplyStyle;label:string;hint:string}> = [
  {value:'natural',label:'自然',hint:'不自动分类，按问题自然决定'},
  {value:'auto',label:'自动',hint:'按当前消息类型选择简短/适中/详细'},
  {value:'short',label:'简短',hint:'目标约50字，直接回答'},
  {value:'balanced',label:'适中',hint:'目标约180字，先结论再理由'},
  {value:'detailed',label:'详细',hint:'目标约500字，结构化展开'},
]

export default function ReplyLengthSettings({role,save,action,dirty,busy}:{role:RuntimeCharacter;save:(range:Range,style:ReplyStyle)=>Promise<void>;action:(work:()=>Promise<void>)=>Promise<void>;dirty:(value:boolean)=>void;busy:boolean}){
  const [min,setMin]=useState(role.replyLength?.minChars?.toString()??''),[max,setMax]=useState(role.replyLength?.maxChars?.toString()??'')
  const [style,setStyle]=useState<ReplyStyle>(role.replyStyle??'natural')
  const changed=min!==(role.replyLength?.minChars?.toString()??'')||max!==(role.replyLength?.maxChars?.toString()??'')||style!==(role.replyStyle??'natural')
  useEffect(()=>{dirty(changed);return()=>dirty(false)},[changed,dirty])
  function persist(natural=false){void action(async()=>{
    const parse=(text:string)=>{if(!text.trim())return null;if(!/^\d+$/u.test(text.trim()))throw Error('回复字数只能填写整数，留空表示不限制。');return Number(text)}
    const range=natural?{minChars:null,maxChars:null}:{minChars:parse(min),maxChars:parse(max)}
    validateReplyLength(range);await save(range,natural?'natural':style)
  })}
  return <section className="mb-card" aria-label="回复长度"><h3>回复长度</h3><p>当前角色：{role.name}。普通聊天与桌宠回复使用同一范围；主动问候、资料整理和周回顾保持各自长度。</p>
    <div className="mb-row"><label>最小回复字数<input aria-label="最小回复字数" type="text" inputMode="numeric" value={min} onChange={event=>setMin(event.target.value)} placeholder="不限制"/></label><label>最大回复字数<input aria-label="最大回复字数" type="text" inputMode="numeric" value={max} onChange={event=>setMax(event.target.value)} placeholder="不限制"/></label></div>
    <label>默认回复风格<select aria-label="默认回复风格" value={style} onChange={event=>setStyle(event.target.value as ReplyStyle)}>{STYLE_OPTIONS.map(option=><option key={option.value} value={option.value}>{option.label} · {option.hint}</option>)}</select></label>
    <p className="mb-muted">范围为 1～20000 字，可只设一端；中英文字母、数字与标点按 Unicode 字素计数，空白、格式标记与隐藏引用不计。模型可能偏离，会保留完整回答并提示。保存回复长度时也会保存本页其他设置修改。</p>
    <div className="mb-row"><button type="button" onClick={()=>persist()}>保存回复长度</button><button type="button" onClick={()=>persist(true)}>恢复自然长度</button><small aria-live="polite">{busy?'正在保存设置…':changed?'回复长度有未保存的修改':'当前回复长度已保存'}</small></div>
    <p className="mb-muted">「恢复自然长度」会同时把默认风格恢复为自然并清空最小/最大字数；仅想换风格时用上方下拉选择。</p>
  </section>
}

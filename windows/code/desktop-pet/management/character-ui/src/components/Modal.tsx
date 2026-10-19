import {useEffect,useId,useRef,type ReactNode} from 'react'
export default function Modal({open,title,close,children,keepMounted=false}:{open:boolean;title:string;close:()=>void;children:ReactNode;keepMounted?:boolean}){
  const dialog=useRef<HTMLDialogElement|null>(null),titleId=useId(),closeRef=useRef(close);closeRef.current=close
  useEffect(()=>{if(!open)return;const trigger=document.activeElement,element=dialog.current!;element.showModal();element.querySelector<HTMLElement>('[data-autofocus]')?.focus();return()=>{element.close();if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus()}},[open])
  return <dialog className="mb-modal" ref={dialog} aria-labelledby={titleId} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRef.current()}}} onCancel={event=>{event.preventDefault();closeRef.current()}}><div className="mb-section-head"><h2 id={titleId}>{title}</h2><button type="button" aria-label={'关闭'+title} onClick={()=>closeRef.current()}>关闭</button></div>{(open||keepMounted)&&children}</dialog>
}

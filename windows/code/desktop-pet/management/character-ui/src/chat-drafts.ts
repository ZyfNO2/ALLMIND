import type {TurnReplyStyle} from '../../../contracts/reply-length'
import type {DialogueMode} from '../../../contracts/book-dialogue'
export interface PendingChatRequest {text:string;id:string;style:TurnReplyStyle;dialogueMode?:DialogueMode|'inherit';transcript?:{id:string;start:number}}
export interface ChatDraft {text:string;style:TurnReplyStyle;dialogueMode?:DialogueMode|'inherit';pending:PendingChatRequest|null}
const prefix='allmind-chat-draft-v1:'
export function readChatDraft(scope:string):ChatDraft|null{
 const raw=localStorage.getItem(prefix+scope);if(!raw)return null
 const value=JSON.parse(raw) as ChatDraft
 if([value.dialogueMode,value.pending?.dialogueMode].some(mode=>mode!==undefined&&!['inherit','auto','smart','quick','rp'].includes(mode)))throw Error('本地草稿场景模式无效；未发送。')
 if(typeof value.text!=='string'||value.text.length>16000||!['inherit','short','balanced','detailed'].includes(value.style)||value.pending&&(!/^[A-Za-z0-9._-]{1,128}$/.test(value.pending.id)||typeof value.pending.text!=='string'||value.pending.text.length>16000||!['inherit','short','balanced','detailed'].includes(value.pending.style)))throw Error('本地草稿格式无效；未发送，请先清除该草稿。')
 return value
}
export function writeChatDraft(scope:string,value:ChatDraft):void{if(!value.text&&!value.pending)localStorage.removeItem(prefix+scope);else localStorage.setItem(prefix+scope,JSON.stringify(value))}
export function clearChatDraft(scope:string):void{localStorage.removeItem(prefix+scope)}

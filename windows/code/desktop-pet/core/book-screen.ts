import {randomUUID,createHash} from 'node:crypto';
import {BookError,type BookScope,type RuntimeRepository} from '../contracts/memory-book.js';
import {SENSITIVE_SCREEN_TERMS,type BookScreenObservation,type BookScreenReceipt} from '../contracts/book-screen.js';
import {WindowsBookOcr,type BookOcrEngine} from '../providers/windows-book-ocr.js';
import {validateScope} from '../memory/book-validation.js';

/** Volatile, scoped, one-turn screen text. Images never enter a file or LLM request. */
export class BookScreenService {
 private observations=new Map<string,{scope:BookScope;value:BookScreenObservation;timer:ReturnType<typeof setTimeout>;turnId?:string}>();
 private active=new Map<string,AbortController>();
 onInvalidated?: (scope:BookScope,id:string)=>void;
 constructor(private repository:Pick<RuntimeRepository,'loadConfig'>,private engine:BookOcrEngine=new WindowsBookOcr(),private ttlMs=300000){}
 async capabilities(signal:AbortSignal){return this.engine.capabilities(AbortSignal.any([signal,AbortSignal.timeout(15000)]))}
 private settings(scope:BookScope){validateScope(scope);const role=this.repository.loadConfig().characters.find(row=>row.id===scope.characterId);if(!role)throw new BookError('not_found','角色不存在。');return role.screen?.blockedWindows??[]}
 async recognize(scope:BookScope,input:{imageBase64:unknown;mime:unknown;sourceName:unknown;sourceKind:unknown;confirmed:unknown},signal:AbortSignal):Promise<BookScreenObservation>{
  const blocked=this.settings(scope);signal.throwIfAborted();if(input.confirmed!==true)throw new BookError('invalid_input','请预览并明确确认本次本地识别。');
  if(typeof input.sourceName!=='string'||!input.sourceName.trim()||input.sourceName.length>300||!['window','browser','screen'].includes(String(input.sourceKind)))throw new BookError('invalid_input','请选择明确的屏幕或窗口来源。');
  const name=input.sourceName.normalize('NFKC').toLocaleLowerCase();if([...SENSITIVE_SCREEN_TERMS,...blocked].some(term=>name.includes(term.normalize('NFKC').toLocaleLowerCase())))throw new BookError('conflict','所选来源命中敏感窗口排除项，未进行识别；请重新选择来源。');
  if(!['image/png','image/jpeg'].includes(String(input.mime))||typeof input.imageBase64!=='string'||!input.imageBase64.length||input.imageBase64.length>2000000||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.imageBase64))throw new BookError('invalid_input','截图编码无效或超过 1.5 MB。');
  const bytes=Buffer.from(input.imageBase64,'base64');const key=JSON.stringify(scope);
  try{
   if(bytes.toString('base64')!==input.imageBase64||!bytes.length||bytes.length>1500000||!(input.mime==='image/png'?bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw new BookError('invalid_input','截图签名或内容编码无效。');
   if(this.active.has(key)||this.active.size>=4)throw new BookError('busy','当前已有屏幕识别，请取消或等待完成。');
   this.clearScope(scope);const controller=new AbortController();this.active.set(key,controller);const bounded=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(30000)]),revision=this.repository.loadConfig().revision;
   try{
    const cap=await this.capabilities(bounded);if(!cap.available)throw new BookError('unavailable',cap.reason??'本地 OCR 不可用。');
    const result=await this.engine.recognize(bytes,bounded);bounded.throwIfAborted();if(this.repository.loadConfig().revision!==revision)throw new BookError('conflict','识别期间设置已变化，本次画面未采用。');
    if(result.status!=='ok'||typeof result.readingOrderText!=='string'||!result.readingOrderText.trim())throw new BookError('unavailable','没有得到完整、清晰的屏幕文字，请重选来源；没有自动发送聊天。');
    if(result.readingOrderText.length>12000)throw new BookError('budget','本次屏幕文字超过 12000 字，请选取更小的窗口；未截断或发送。');
    if(this.observations.size>=16)throw new BookError('budget','未清除的屏幕观察过多，请先清除旧观察。');
    const value={id:'screen-'+randomUUID(),text:result.readingOrderText,sha256:createHash('sha256').update(result.readingOrderText).digest('hex'),capturedAt:new Date().toISOString(),expiresAt:Date.now()+this.ttlMs,language:result.language??'unknown'};
    const timer=setTimeout(()=>this.remove(value.id),this.ttlMs);timer.unref();this.observations.set(value.id,{scope:structuredClone(scope),value,timer});return structuredClone(value);
   }catch(error){if(bounded.aborted)throw new BookError('unavailable','本地屏幕识别已取消或超时，没有自动重试。',{cause:error});if(error instanceof BookError)throw error;throw new BookError('unavailable','本地 OCR 未完成，请检查 Windows 文字识别语言组件。',{cause:error})}finally{if(this.active.get(key)===controller)this.active.delete(key)}
  }finally{bytes.fill(0)}
 }
 project(scope:BookScope,id:string,turnId?:string):BookScreenObservation{
  const row=this.observations.get(id);if(!row||JSON.stringify(scope)!==JSON.stringify(row.scope))throw new BookError('not_found','屏幕观察不存在或不属于当前会话。');
  if(turnId&&row.turnId&&row.turnId!==turnId)throw new BookError('conflict','这份屏幕文字已绑定另一轮，请重新选取；不会重复发送。');
  if(Date.now()>=row.value.expiresAt){this.remove(id);throw new BookError('conflict','屏幕观察已过期，请重新选取。')}return structuredClone(row.value);
 }
 bind(scope:BookScope,id:string,turnId:string):BookScreenReceipt{const value=this.project(scope,id,turnId),row=this.observations.get(id)!;if(row.turnId&&row.turnId!==turnId)throw new BookError('conflict','这份屏幕文字已绑定另一轮，请重新选取；不会重复发送。');row.turnId=turnId;return {id,sha256:value.sha256,capturedAt:value.capturedAt}}
 clear(scope:BookScope,id:string){this.project(scope,id);this.remove(id)}
 private remove(id:string){const row=this.observations.get(id);if(!row)return;clearTimeout(row.timer);this.observations.delete(id);this.onInvalidated?.(row.scope,id)}
 clearScope(scope:BookScope){this.active.get(JSON.stringify(scope))?.abort();for(const [id,row] of this.observations)if(JSON.stringify(scope)===JSON.stringify(row.scope))this.remove(id)}
 clearCharacter(characterId:string){for(const [key,controller] of this.active)if(JSON.parse(key).characterId===characterId)controller.abort();for(const [id,row] of this.observations)if(row.scope.characterId===characterId)this.remove(id)}
 close(){for(const controller of this.active.values())controller.abort();for(const id of this.observations.keys())this.remove(id)}
}

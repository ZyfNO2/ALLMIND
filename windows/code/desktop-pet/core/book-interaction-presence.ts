import {BookError,type BookScope} from '../contracts/memory-book.js';
import {validateScope} from '../memory/book-validation.js';
export interface BookInteractionFlags {typing:boolean;recording:boolean;speaking:boolean;busy:boolean;roleplay?:boolean}
export interface BookInteractionUpdate extends BookInteractionFlags {viewId:string;sequence:number}
const idle=():BookInteractionFlags=>({typing:false,recording:false,speaking:false,busy:false});
/** Volatile browser leases. Ordered updates prevent late heartbeats reviving a closed view. */
export class BookInteractionPresence {
 private rows=new Map<string,{scope:BookScope;flags:BookInteractionFlags;sequence:number;activeUntil:number;forgetAt:number}>();
 update(scope:BookScope,input:BookInteractionUpdate,now=performance.now()):{accepted:boolean}{
  validateScope(scope);
  if(!input||Object.keys(input).some(key=>!['viewId','sequence','typing','recording','speaking','busy','roleplay'].includes(key))||typeof input.viewId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.viewId)||!Number.isSafeInteger(input.sequence)||input.sequence<1||['typing','recording','speaking','busy'].some(key=>typeof input[key as keyof BookInteractionFlags]!=='boolean')||input.roleplay!==undefined&&typeof input.roleplay!=='boolean')throw new BookError('invalid_input','页面交互状态无效；仅接受状态标记，不接收输入内容。');
  this.prune(now);const key=JSON.stringify([scope,input.viewId]),previous=this.rows.get(key);
  if(previous&&input.sequence<=previous.sequence)return {accepted:false};
  if(!previous&&this.rows.size>=128)throw new BookError('busy','页面交互状态已达上限，请关闭不再使用的页面。');
  const flags={typing:input.typing,recording:input.recording,speaking:input.speaking,busy:input.busy,...(input.roleplay?{roleplay:true}:{})};
  this.rows.set(key,{scope:structuredClone(scope),flags,sequence:input.sequence,activeUntil:now+20000,forgetAt:now+60000});return {accepted:true};
 }
 read(characterId?:string,now=performance.now()):BookInteractionFlags{
  this.prune(now);const flags=idle();for(const row of this.rows.values())if((characterId===undefined||row.scope.characterId===characterId)&&now<row.activeUntil){for(const key of ['typing','recording','speaking','busy'] as const)flags[key] ||= row.flags[key];if(row.flags.roleplay)flags.roleplay=true;}return flags;
 }
 private prune(now:number){for(const [key,row] of this.rows)if(now>=row.forgetAt)this.rows.delete(key)}
}

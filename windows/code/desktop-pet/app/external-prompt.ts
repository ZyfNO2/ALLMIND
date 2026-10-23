import {BookError, type RuntimeConfig, type BookScope, type ChatMessage} from '../contracts/memory-book.js';
import {compilePreset, presetBudget} from './prompt-compiler.js';
import {BOOK_TRUST_POLICY} from '../core/book-trust-policy.js';

/** Tool messages are opaque: preserve IDs/content byte-for-byte, never parse them as macros. */
export function compileExternalPrompt(config:RuntimeConfig, scope:BookScope, current:string, history:unknown[], fragments:{entryId:string;text:string;type:string}[]) {
  const role=config.characters.find(row=>row.id===scope.characterId);
  if(!role)throw new BookError('not_found','绑定的角色不存在。');
  if(!Array.isArray(history)||history.length>512||JSON.stringify(history).length>1000000)throw new BookError('budget','外部上下文超过限制。');
  const preset=config.promptPresets?.find(row=>row.id===role.promptPresetId);
  if(role.promptPresetId&&!preset)throw new BookError('conflict','绑定的预设不存在。');
  if(!preset)return {preset:{status:'unused' as const},systemNote:[BOOK_TRUST_POLICY,role.intro,...fragments.map(row=>`[wiki:${row.entryId}] ${row.text}`)].join('\n\n')};
  if(!config.mainModel)throw new BookError('unavailable','Preset 需要明确的模型窗口配置。');
  const opaque=new Map<string,Record<string,unknown>>();
  const textHistory:ChatMessage[]=history.map((value,index)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new BookError('invalid_input','外部历史格式无效。');
    const row=value as Record<string,unknown>;
    if(!['system','user','assistant','tool'].includes(String(row.role)))throw new BookError('invalid_input','外部历史 Role 不支持。');
    if(typeof row.content==='string'&&!row.tool_calls&&row.role!=='tool'&&row.role!=='system')return {role:row.role as 'user'|'assistant',content:row.content};
    const marker=`[allmind.opaque.${index}]`+JSON.stringify(row);opaque.set(marker,row);
    return {role:row.role==='user'?'user':'assistant',content:marker};
  });
  const context={preset,char:role.name,user:role.userName||'用户',intro:role.intro,binding:config.mainModel,now:new Date()};
  const compiled=compilePreset(context,{current,history:textHistory,segments:fragments.map((row,index)=>({id:'external.'+index,slot:row.type==='persona'?'charDescription' as const:row.type==='memory'?'allmindMemory' as const:'worldInfoBefore' as const,content:`[wiki:${row.entryId}] ${row.text}`})),policy:BOOK_TRUST_POLICY,budget:presetBudget(context).input});
  if(opaque.size&&compiled.compilation.omissions.some(row=>row.id==='history'))throw new BookError('budget','含工具历史的上下文不能部分裁剪，请先在 AstrBot 归档或压缩后重试。');
  return {preset:{status:'assembled' as const,compilation:compiled.compilation},historyKeep:compiled.compilation.items.map(row=>row.identifier==='allmind.current'||row.identifier.startsWith('history.')),messages:compiled.messages.map(row=>opaque.get(row.content)??row)};
}

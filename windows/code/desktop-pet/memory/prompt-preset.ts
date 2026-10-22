import {BookError} from '../contracts/memory-book.js';
import {promptSlots,type PresetDocument,type StoredPromptPreset} from '../contracts/prompt-preset.js';

const fail=(message:string):never=>{throw new BookError('invalid_input','对话预设：'+message);};
export function parsePreset(text:string):PresetDocument{
  if(typeof text!=='string'||new TextEncoder().encode(text).length>512000)fail('JSON 最大500KiB。');
  let value:unknown;try{value=JSON.parse(text);}catch{fail('不是有效 JSON。');}
  if(!value||typeof value!=='object'||Array.isArray(value))fail('需要 Chat Completion 对象。');
  const document=value as PresetDocument;
  if(!Array.isArray(document.prompts)||!document.prompts.length||document.prompts.length>256||!Array.isArray(document.prompt_order)||!document.prompt_order.length||document.prompt_order.length>64)fail('缺少 prompts / prompt_order 或条目过多。');
  const ids=new Set<string>();
  for(const prompt of document.prompts){
    if(!prompt||typeof prompt.identifier!=='string'||!prompt.identifier||prompt.identifier.length>128||ids.has(prompt.identifier))fail('identifier 缺失或重复。');ids.add(prompt.identifier);
    if(prompt.role!==undefined&&!['system','user','assistant'].includes(prompt.role))fail(prompt.identifier+' Role 无效。');
    if(prompt.content!==undefined&&(typeof prompt.content!=='string'||prompt.content.length>100000))fail(prompt.identifier+' 正文无效。');
    if(prompt.marker!==undefined&&typeof prompt.marker!=='boolean')fail(prompt.identifier+' marker 无效。');
    for(const field of ['injection_position','injection_depth','injection_order'] as const)if(prompt[field]!==undefined&&(!Number.isSafeInteger(prompt[field])||prompt[field]!<0||prompt[field]!>100000))fail(prompt.identifier+' '+field+' 无效。');
    if(prompt.injection_position!==undefined&&prompt.injection_position!==0&&prompt.injection_position!==1)fail(prompt.identifier+' Position 无效。');
    if(prompt.injection_trigger!==undefined&&(!Array.isArray(prompt.injection_trigger)||prompt.injection_trigger.some(value=>typeof value!=='string')))fail(prompt.identifier+' Trigger 无效。');
  }
  const blocks=new Set<number>();
  for(const block of document.prompt_order){
    if(!block||!Number.isSafeInteger(block.character_id)||blocks.has(block.character_id)||!Array.isArray(block.order)||block.order.length>256)fail('order block 无效或重复。');blocks.add(block.character_id);
    const seen=new Set<string>();for(const row of block.order){if(!row||!ids.has(row.identifier)||seen.has(row.identifier)||typeof row.enabled!=='boolean')fail('排序含未知/重复 identifier 或 enabled 无效。');seen.add(row.identifier);}
  }
  for(const key of ['temperature','top_p','frequency_penalty','presence_penalty','openai_max_tokens','openai_max_context'] as const)if(document[key]!==undefined&&(!Number.isFinite(document[key])||typeof document[key]!=='number'))fail(key+' 必须是有限数值。');
  for(const key of ['openai_max_tokens','openai_max_context'] as const)if(document[key]!==undefined&&(!Number.isSafeInteger(document[key])||document[key]!<1))fail(key+' 必须是正整数。');
  return document;
}
export function validateStoredPreset(preset:StoredPromptPreset):void{
  if(!preset||typeof preset.id!=='string'||!/^preset-[a-zA-Z0-9-]{1,100}$/.test(preset.id)||typeof preset.name!=='string'||!preset.name.trim()||preset.name.length>200||!Number.isSafeInteger(preset.revision)||preset.revision<1)fail('本地记录无效。');
  parsePreset(preset.original);const document=parsePreset(JSON.stringify(preset.document));
  if(!document.prompt_order.some(block=>block.character_id===preset.orderBlock))fail('请选择存在的 order block。');
}
const knownMacros=new Set(['char','charIfNotGroup','user','description','personality','scenario','persona','trim','date','time']);
export function presetCompatibility(preset:StoredPromptPreset):{errors:string[];warnings:string[]}{
  const errors:string[]=[],warnings:string[]=[];
  const order=preset.document.prompt_order.find(block=>block.character_id===preset.orderBlock)?.order??[];
  const enabled=new Set(order.filter(row=>row.enabled).map(row=>row.identifier));
  for(const prompt of preset.document.prompts){
    const messages=enabled.has(prompt.identifier)?errors:warnings;
    if(prompt.marker&&!promptSlots.includes(prompt.identifier as typeof promptSlots[number]))messages.push(prompt.identifier+'：未知 Marker。');
    const text=(prompt.content??'').replace(/\{\{\/\/[\s\S]*?\}\}/g,'');
    const remainder=text.replace(/\{\{[\s\S]*?\}\}/g,'');if(remainder.includes('{{')||remainder.includes('}}'))messages.push(prompt.identifier+'：宏括号未正确闭合。');
    for(const match of text.matchAll(/\{\{([\s\S]*?)\}\}/g))if(!knownMacros.has(match[1]!.trim()))messages.push(prompt.identifier+'：不支持宏 '+match[0]);
    if(enabled.has(prompt.identifier)&&prompt.injection_trigger?.some(type=>!['normal','regenerate'].includes(type)))warnings.push(prompt.identifier+'：部分 Trigger 在当前产品无对应入口，不会作为 normal 启用。');
  }
  if(order.filter(row=>row.enabled&&row.identifier==='chatHistory').length!==1)errors.push('普通回复必须启用恰好一个 chatHistory Marker。');
  if(!preset.document.prompts.find(row=>row.identifier==='chatHistory')?.marker)errors.push('chatHistory 必须为 Marker。');
  for(const key of Object.keys(preset.document))if(!['prompts','prompt_order','temperature','top_p','frequency_penalty','presence_penalty','openai_max_tokens','openai_max_context'].includes(key))warnings.push(key+'：作为原始配置保留，不执行、不覆盖模型连接。');
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}
/** Export authoring fields only; connection credentials and executable extensions never travel. */
export function exportPreset(document:PresetDocument):string{
  return JSON.stringify(Object.fromEntries(Object.entries(document).filter(([key])=>['prompts','prompt_order','temperature','top_p','frequency_penalty','presence_penalty','openai_max_tokens','openai_max_context'].includes(key))),null,2);
}

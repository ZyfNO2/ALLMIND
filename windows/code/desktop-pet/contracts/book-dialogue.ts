import type {ModelBinding,RecallMode} from './memory-book.js';
import {BookError} from './memory-book.js';
export const DIALOGUE_MODES=['auto','smart','quick','rp'] as const;
export type DialogueMode=typeof DIALOGUE_MODES[number];
export type DialogueMemoryDomain='all'|'core-only'|'fiction';
export interface DialogueProfile {model?:ModelBinding;presetId?:string|null;recallMode?:RecallMode;memoryDomain?:DialogueMemoryDomain;inputTokens?:number;outputTokens?:number}
export interface DialogueRoutingSettings {defaultMode:DialogueMode;profiles:Partial<Record<'smart'|'quick'|'rp',DialogueProfile>>}
export interface DialogueDecision {requested:DialogueMode|'inherit';mode:'smart'|'quick'|'rp';reason:string;model:string;modelKind:'http'|'chatgpt-web';presetId:string|null;recallMode:RecallMode;memoryDomain:DialogueMemoryDomain;inputBudget:number;outputBudget:number}
export interface DialogueReceipt extends DialogueDecision {inputTokensEstimated:number;outputTokensEstimated:number;durationMs:number;usageSource:'local-estimate';monetaryCost:null}
export function validateDialogueReceipt(value:DialogueReceipt):void{
 if(!value||typeof value!=='object'||Array.isArray(value)||!['inherit',...DIALOGUE_MODES].includes(value.requested)||!['smart','quick','rp'].includes(value.mode)||!['http','chatgpt-web'].includes(value.modelKind)||!['all','core-only','fiction'].includes(value.memoryDomain)||!['off','smart','deep','story-rp'].includes(value.recallMode)||value.usageSource!=='local-estimate'||value.monetaryCost!==null)throw new BookError('invalid_input','场景回执无效。');
 for(const text of [value.reason,value.model])if(typeof text!=='string'||!text||text.length>1000||text.includes('\0'))throw new BookError('invalid_input','场景回执文本无效。');
 if(value.presetId!==null&&(typeof value.presetId!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(value.presetId)))throw new BookError('invalid_input','场景预设标识无效。');
 for(const number of [value.inputBudget,value.outputBudget,value.inputTokensEstimated,value.outputTokensEstimated,value.durationMs])if(!Number.isSafeInteger(number)||number<0||number>24*60*60*1000)throw new BookError('invalid_input','场景预算/消耗回执无效。');
}

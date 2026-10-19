import {BookError} from './memory-book.js';
export interface ReplyLengthSettings {minChars:number|null;maxChars:number|null}
export interface ReplyLengthResult extends ReplyLengthSettings {actualChars:number;status:'within'|'too-short'|'too-long'}
export function validateReplyLength(value:ReplyLengthSettings):void{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['minChars','maxChars'].includes(key))
    ||[value.minChars,value.maxChars].some(bound=>bound!==null&&(!Number.isSafeInteger(bound)||bound<1||bound>20000))
    ||value.minChars!==null&&value.maxChars!==null&&value.minChars>value.maxChars)throw new BookError('invalid_input','回复字数必须为 1～20000 的整数，最小字数不能大于最大字数；留空表示不限制。');
}

// ── B03: reply style tiers, per-turn selection and the frozen per-turn decision ──────────────
/** Character-level default. Legacy characters without the field stay 'natural'. */
export type ReplyStyle = 'natural'|'auto'|'short'|'balanced'|'detailed';
/** Per-turn request option. 'inherit' keeps the character default (and stays replay-compatible). */
export type TurnReplyStyle = 'inherit'|'short'|'balanced'|'detailed';
export const REPLY_STYLES:readonly ReplyStyle[] = ['natural','auto','short','balanced','detailed'];
export const TURN_REPLY_STYLES:readonly TurnReplyStyle[] = ['inherit','short','balanced','detailed'];
/** Bounded ruleId registry: decisions must cite one of these, never free text or private content. */
export const REPLY_STYLE_RULE_IDS = ['turn-selection-v1','explicit-style-short-v1','explicit-style-detailed-v1','explicit-numeric-v1','explicit-numeric-conflict-v1','role-default-v1','intent-greeting-v1','intent-acknowledgement-v1','intent-support-v1','intent-explanation-v1','intent-technical-v1','intent-analysis-v1','intent-general-v1','natural-fallback-v1'] as const;
export type ReplyStyleRuleId = typeof REPLY_STYLE_RULE_IDS[number];
export const REPLY_STYLE_INTENTS = ['greeting','acknowledgement','support','explanation','technical','analysis','general','unknown'] as const;
/** Initial soft targets per §3.3 of the B03 spec; never hard bounds. */
export const REPLY_STYLE_TARGETS:Record<'short'|'balanced'|'detailed',number> = {short:50,balanced:180,detailed:500};
export function validateReplyStyle(value:ReplyStyle):void{
  if(!REPLY_STYLES.includes(value))throw new BookError('invalid_input','回复风格必须为自然、自动、简短、适中或详细。');
}
export function validateTurnReplyStyle(value:TurnReplyStyle):void{
  if(!TURN_REPLY_STYLES.includes(value))throw new BookError('invalid_input','本轮回复风格必须为沿用设置、简短、适中或详细。');
}
export interface ReplyStyleDecision {
  version: 1;
  requestedStyle: TurnReplyStyle;
  selectedStyle: 'natural'|'short'|'balanced'|'detailed';
  source: 'turn'|'explicit-text'|'role'|'intent'|'natural';
  intent: (typeof REPLY_STYLE_INTENTS)[number]|null;
  certainty: 'matched'|'uncertain';
  ruleIds: string[];
  targetChars: number|null;
  effectiveRange: {minChars:number|null;maxChars:number|null};
  constrained: boolean;
  requestConflict: boolean;
}
export function validateReplyStyleDecision(value:ReplyStyleDecision):void{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new BookError('invalid_input','回复风格决策无效。');
  const keys=Object.keys(value);
  if(keys.some(key=>!['version','requestedStyle','selectedStyle','source','intent','certainty','ruleIds','targetChars','effectiveRange','constrained','requestConflict'].includes(key))
    ||value.version!==1||!TURN_REPLY_STYLES.includes(value.requestedStyle)
    ||!['natural','short','balanced','detailed'].includes(value.selectedStyle)
    ||!['turn','explicit-text','role','intent','natural'].includes(value.source)
    ||!(value.intent===null||REPLY_STYLE_INTENTS.includes(value.intent))
    ||!['matched','uncertain'].includes(value.certainty)
    ||!Array.isArray(value.ruleIds)||value.ruleIds.length<1||value.ruleIds.length>8||value.ruleIds.some((id:unknown)=>typeof id!=='string'||!(REPLY_STYLE_RULE_IDS as readonly string[]).includes(id))
    ||(value.targetChars!==null&&(!Number.isSafeInteger(value.targetChars)||value.targetChars<1||value.targetChars>20000)))throw new BookError('invalid_input','回复风格决策字段无效。');
  validateReplyLength(value.effectiveRange);
  if(value.targetChars!==null&&(value.targetChars<(value.effectiveRange.minChars??1)||value.targetChars>(value.effectiveRange.maxChars??20000)))throw new BookError('invalid_input','回复风格目标必须在有效字数范围内。');
  if(typeof value.constrained!=='boolean'||typeof value.requestConflict!=='boolean')throw new BookError('invalid_input','回复风格决策标记无效。');
}

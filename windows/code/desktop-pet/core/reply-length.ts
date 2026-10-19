import {validateReplyLength,type ReplyLengthSettings,type ReplyLengthResult} from '../contracts/reply-length.js';
import {splitRubyText} from './ruby-text.js';
export function replyLengthInstruction(range?:ReplyLengthSettings):string{
  if(!range)return '';validateReplyLength(range);
  if(range.minChars===null&&range.maxChars===null)return '【当前回复长度】本轮按问题自然决定回复长短，不沿用旧轮次的最小或最大字数偏好。';
  const bounds=[range.minChars===null?'':`最少 ${range.minChars} 字`,range.maxChars===null?'':`最多 ${range.maxChars} 字`].filter(Boolean).join('，');
  return `【当前回复字数】本轮普通回复正文${bounds}。按 Unicode 字素计数，中英文字母、数字与标点均计入，空白、Markdown 格式标记、隐藏引用与推理过程不计。请在完整表达且不编造事实的前提下遵守，不机械重复凑字，不输出字数统计或本条规则。此设置替代旧轮次的长度偏好。`;
}

/** Count body graphemes; preserve literal code, strip supported formatting outside code. */
export function countReplyChars(value:string):number{
  const text=splitRubyText(value).map(part=>part.text).join('').replace(/(?:cite|filecite|memcite)[^]*/gu,'');
  const plain=text.split(/(```[^\n]*\n[\s\S]*?\n```|~~~[^\n]*\n[\s\S]*?\n~~~|`[^`\n]+`)/gu).map(part=>{
    if(/^(?:```|~~~)/u.test(part))return part.replace(/^[^\n]*\n/u,'').replace(/\n(?:```|~~~)$/u,'');
    if(part.startsWith('`')&&part.endsWith('`'))return part.slice(1,-1);
    return part.replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/gu,'$1').replace(/^ {0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gmu,'').replace(/(\*\*|__|~~)([^\n]*?)\1/gu,'$2').replace(/([*_])([^\n]*?)\1/gu,'$2');
  }).join('');
  return [...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(plain)].filter(part=>!/\s/u.test(part.segment)).length;
}
export function measureReplyLength(value:string,range?:ReplyLengthSettings):ReplyLengthResult|null{
  if(!range)return null;validateReplyLength(range);
  if(range.minChars===null&&range.maxChars===null)return null;
  const actualChars=countReplyChars(value);
  return {...range,actualChars,status:range.minChars!==null&&actualChars<range.minChars?'too-short':range.maxChars!==null&&actualChars>range.maxChars?'too-long':'within'};
}
export function replyLengthNotice(result?:ReplyLengthResult|null):string{
  return !result||result.status==='within'?'':`本次回复 ${result.actualChars} 字，${result.status==='too-short'?'少于设定下限 '+result.minChars:'超过设定上限 '+result.maxChars} 字；已保留完整回答。`;
}

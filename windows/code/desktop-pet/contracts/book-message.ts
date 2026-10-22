import {BookError} from './memory-book.js';
export interface TextTranscriptReceipt {id:string;sha256:string;at:string;language:string;start:number;end:number}
export function validateTextTranscript(value:TextTranscriptReceipt,text:string):void{
 if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['id','sha256','at','language','start','end'].includes(key))||typeof value.id!=='string'||!/^transcript-[a-f0-9-]{36}$/.test(value.id)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.start)||!Number.isSafeInteger(value.end)||value.start<0||value.end<=value.start||value.end>text.length||!Number.isFinite(Date.parse(value.at))||typeof value.language!=='string'||value.language.length>40)throw new BookError('invalid_input','转写正文与来源回执无效。');
}
export interface MessageContent {id:string;kind:'text'|'image'|'file'|'transcript'|'screen';source:'user'|'resource'|'local-speech'|'local-ocr'|'qq';permission:'model-confirmed'|'not-authorized';status:'ready'|'unsupported'|'unknown';sha256:string;resourceId?:string;mime?:string;start?:number;end?:number}
export function validateMessageContents(value:MessageContent[]):void{
 if(!Array.isArray(value)||value.length>36||new Set(value.map(row=>row.id)).size!==value.length)throw new BookError('invalid_input','消息内容清单无效。');
 for(const row of value){if(!row||typeof row!=='object'||typeof row.id!=='string'||!row.id||row.id.length>160||!['text','image','file','transcript','screen'].includes(row.kind)||!['user','resource','local-speech','local-ocr','qq'].includes(row.source)||!['model-confirmed','not-authorized'].includes(row.permission)||!['ready','unsupported','unknown'].includes(row.status)||!/^[a-f0-9]{64}$/.test(row.sha256))throw new BookError('invalid_input','消息片段来源、权限或状态无效。');if(row.start!==undefined&&(!Number.isSafeInteger(row.start)||row.start<0)||row.end!==undefined&&(!Number.isSafeInteger(row.end)||row.end<=(row.start??0)))throw new BookError('invalid_input','消息片段正文区间无效。');}
}

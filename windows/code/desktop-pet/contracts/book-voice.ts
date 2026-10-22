import {BookError} from './memory-book.js';

export interface BookVoiceSettings {enabled:boolean;language:string;voiceName:string|null;autoRead:boolean}
export const DEFAULT_BOOK_VOICE:BookVoiceSettings={enabled:false,language:'zh-CN',voiceName:null,autoRead:false};
export interface LocalVoiceCapabilities {available:boolean;voices:{name:string;culture:string}[];recognizers:{id:string;culture:string}[];reason?:string}
export function validateBookVoice(value:BookVoiceSettings):void{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['enabled','language','voiceName','autoRead'].includes(key))||typeof value.enabled!=='boolean'||typeof value.autoRead!=='boolean'||typeof value.language!=='string'||!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(value.language)||(value.voiceName!==null&&(typeof value.voiceName!=='string'||!value.voiceName.trim()||value.voiceName.length>200||value.voiceName.includes('\0'))))throw new BookError('invalid_input','本地语音设置无效。');
}

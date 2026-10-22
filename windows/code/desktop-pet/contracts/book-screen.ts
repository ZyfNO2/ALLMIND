import {BookError} from './memory-book.js';
export interface BookScreenSettings {blockedWindows:string[]}
export const SENSITIVE_SCREEN_TERMS=['password','密码','1password','bitwarden','keepass','验证码','authenticator'];
export interface BookScreenObservation {id:string;text:string;sha256:string;capturedAt:string;expiresAt:number;language:string}
export interface BookScreenReceipt {id:string;sha256:string;capturedAt:string}
export function validateBookScreen(value:BookScreenSettings):void{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='blockedWindows')||!Array.isArray(value.blockedWindows)||value.blockedWindows.length>32||value.blockedWindows.some(term=>typeof term!=='string'||!term.trim()||term.length>120||/[\r\n\0]/.test(term)))throw new BookError('invalid_input','屏幕排除项须为最多 32 个非空名称片段，每项不超过 120 字。');
}
export function validateScreenReceipt(value:BookScreenReceipt):void{
 if(!value||Object.keys(value).some(key=>!['id','sha256','capturedAt'].includes(key))||typeof value.id!=='string'||!/^screen-[0-9a-f-]{36}$/.test(value.id)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isFinite(Date.parse(value.capturedAt)))throw new BookError('invalid_input','屏幕文字回执无效。');
}

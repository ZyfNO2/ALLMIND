import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {OcrResult} from '../contracts/perception.js';
export interface BookOcrEngine {capabilities(signal:AbortSignal):Promise<{available:boolean;language?:string;reason?:string;maxDimension?:number}>;recognize(bytes:Uint8Array,signal:AbortSignal):Promise<OcrResult>}
function invoke(input:unknown,signal:AbortSignal):Promise<any>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>{
  const script=fileURLToPath(new URL('../../desktop/ocr/windows-runtime-ocr.ps1',import.meta.url)),child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',diagnostic='',failure:Error|undefined;child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const abort=()=>{failure=new DOMException('本地屏幕识别已取消。','AbortError');child.kill()};signal.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>1024*1024){failure=Error('本地 OCR 输出超过限额。');child.kill()}});child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-1024)});
  child.once('error',error=>{signal.removeEventListener('abort',abort);reject(error)});child.once('close',code=>{signal.removeEventListener('abort',abort);if(failure)return reject(failure);if(code!==0)return reject(Error('本地 OCR 未完成：'+diagnostic.trim()));try{resolve(JSON.parse(output.replace(/^\uFEFF/,'')))}catch(cause){reject(Error('本地 OCR 回执不是有效 JSON。',{cause}))}});
  child.stdin.on('error',error=>{failure??=error;child.kill()});child.stdin.end(JSON.stringify(input));if(signal.aborted)abort();
 });
}
/** Direct Windows WinRT API via installed .NET; no SDK, image files, cloud fallback or model. */
export class WindowsBookOcr implements BookOcrEngine {
 async capabilities(signal:AbortSignal){if(process.platform!=='win32')return {available:false,reason:'本地屏幕识别需要 Windows。'};return invoke({action:'probe'},signal)}
 async recognize(bytes:Uint8Array,signal:AbortSignal):Promise<OcrResult>{
  const result=await invoke({action:'recognize',imageBase64:Buffer.from(bytes).toString('base64')},signal);
  if(result.status!=='ok'||result.engine!=='windows-media-ocr'||!Array.isArray(result.blocks)||result.blocks.length>256||!Number.isSafeInteger(result.width)||!Number.isSafeInteger(result.height)||result.width<1||result.height<1||result.width*result.height>40000000)throw Error('本地 OCR 回执结构无效。');
  for(const block of result.blocks){const bounds=block?.bounds;if(typeof block?.text!=='string'||Buffer.byteLength(block.text)>4096||block.confidence!==null||!bounds||Object.keys(bounds).length!==4||Object.values(bounds).some(value=>typeof value!=='number'||!Number.isFinite(value))||bounds.x<0||bounds.y<0||bounds.width<=0||bounds.height<=0||bounds.x+bounds.width>result.width+1||bounds.y+bounds.height>result.height+1)throw Error('本地 OCR 文字或边界无效。')}
  return {status:'ok',engine:'windows-media-ocr',language:result.language,blocks:result.blocks,readingOrderText:result.blocks.map((row:{text:string})=>row.text).join('\n')};
 }
}

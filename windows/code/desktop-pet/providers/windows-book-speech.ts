import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {LocalVoiceCapabilities} from '../contracts/book-voice.js';
import {synthesizeSapiWav} from './sapi-tts.js';

export interface BookSpeechEngine {
 capabilities(signal:AbortSignal):Promise<LocalVoiceCapabilities>;
 synthesize(text:string,voiceName:string|null,signal:AbortSignal):Promise<{bytes:Uint8Array;durationMs:number}>;
 recognize(bytes:Uint8Array,language:string,signal:AbortSignal):Promise<{text:string;segments:{text:string;confidence:number}[]}>;
}
export function runWindowsSpeech(input:unknown,signal:AbortSignal):Promise<any>{
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const helper=fileURLToPath(new URL('../../desktop/voice/windows-speech.ps1',import.meta.url));
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',error='',failed:Error|undefined;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const abort=()=>{failed=new DOMException('语音操作已取消。','AbortError');child.kill();};signal.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',bytes=>{output+=bytes.toString('utf8');if(Buffer.byteLength(output)>256*1024){failed=Error('语音识别输出超限。');child.kill();}});
  child.stderr.on('data',bytes=>{error=(error+bytes.toString('utf8')).slice(-2048);});
  child.once('error',cause=>{signal.removeEventListener('abort',abort);reject(cause);});
  child.once('close',code=>{signal.removeEventListener('abort',abort);if(failed){reject(failed);return;}if(code!==0){reject(Error('本地 Windows 语音操作未完成：'+error.trim()));return;}try{resolve(JSON.parse(output.replace(/^\uFEFF/,'')));}catch(cause){reject(Error('本地语音返回了无效 JSON。',{cause}));}});
  child.stdin.on('error',cause=>{if(!failed){failed=cause;child.kill();}});child.stdin.end(JSON.stringify(input));
  if(signal.aborted)abort();
 });
}
export class WindowsBookSpeech implements BookSpeechEngine {
 async capabilities(signal:AbortSignal):Promise<LocalVoiceCapabilities>{
  if(process.platform!=='win32')return {available:false,voices:[],recognizers:[],reason:'本地语音仅支持 Windows。'};
  return runWindowsSpeech({action:'probe'},signal);
 }
 synthesize(text:string,voiceName:string|null,signal:AbortSignal){return synthesizeSapiWav(text,signal,voiceName?{voiceName}:{});}
 recognize(bytes:Uint8Array,language:string,signal:AbortSignal){return runWindowsSpeech({action:'recognize',language,audioBase64:Buffer.from(bytes).toString('base64')},signal);}
}

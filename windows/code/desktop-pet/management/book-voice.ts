import {BookError,type BookScope,type RuntimeRepository} from '../contracts/memory-book.js';
import {DEFAULT_BOOK_VOICE,validateBookVoice,type LocalVoiceCapabilities} from '../contracts/book-voice.js';
import {WindowsBookSpeech,type BookSpeechEngine} from '../providers/windows-book-speech.js';
import {inspectPcmWav} from '../media/wav.js';
import {createHash,randomUUID} from 'node:crypto';
import type {TextTranscriptReceipt} from '../contracts/book-message.js';

/** Volatile local speech jobs. No transcript, audio, or history store is owned here. */
export class BookVoiceService {
 private active=new Map<string,AbortController>();
 private cached?:{until:number;value:LocalVoiceCapabilities};
 private transcripts=new Map<string,{scope:BookScope;text:string;receipt:Omit<TextTranscriptReceipt,'start'|'end'>;until:number}>();
 constructor(private repository:Pick<RuntimeRepository,'loadConfig'>,private engine:BookSpeechEngine=new WindowsBookSpeech()){}
 async capabilities(signal:AbortSignal):Promise<LocalVoiceCapabilities>{
  signal.throwIfAborted();if(this.cached&&this.cached.until>Date.now())return structuredClone(this.cached.value);
  const value=await this.engine.capabilities(AbortSignal.any([signal,AbortSignal.timeout(15000)]));
  if(typeof value.available!=='boolean'||!Array.isArray(value.voices)||!Array.isArray(value.recognizers))throw new BookError('unavailable','本地语音能力回执无效。');
  this.cached={until:Date.now()+60000,value};return structuredClone(value);
 }
 private settings(scope:BookScope){
  const role=this.repository.loadConfig().characters.find(row=>row.id===scope.characterId);if(!role)throw new BookError('not_found','角色不存在。');
  const settings=role.voice??DEFAULT_BOOK_VOICE;validateBookVoice(settings);if(!settings.enabled)throw new BookError('unavailable','请先在语音设置中启用并保存当前角色的本地语音。');return settings;
 }
 cancel(scope:BookScope){this.active.get(JSON.stringify(scope))?.abort();for(const [id,row]of this.transcripts)if(JSON.stringify(row.scope)===JSON.stringify(scope))this.transcripts.delete(id);}
 close(){for(const controller of this.active.values())controller.abort();this.transcripts.clear();}
 verifyTranscript(scope:BookScope,id:unknown,query:string,start:unknown):TextTranscriptReceipt{
  if(typeof id!=='string'||!Number.isSafeInteger(start)||Number(start)<0)throw new BookError('invalid_input','语音来源编号或正文区间无效。');
  const row=this.transcripts.get(id);if(!row||Date.now()>=row.until||JSON.stringify(row.scope)!==JSON.stringify(scope))throw new BookError('conflict','语音来源已过期或属于其他会话，请核对文字后作为普通输入发送。');
  if(query.slice(Number(start),Number(start)+row.text.length)!==row.text)throw new BookError('conflict','识别文字已修改，不能继续标记为原始转写；请作为普通输入发送。');return {...row.receipt,start:Number(start),end:Number(start)+row.text.length};
 }
 private async run<T>(scope:BookScope,signal:AbortSignal,work:(signal:AbortSignal,settings:ReturnType<BookVoiceService['settings']>)=>Promise<T>):Promise<T>{
  const settings=structuredClone(this.settings(scope)),key=JSON.stringify(scope);signal.throwIfAborted();
  if(this.active.has(key)||this.active.size>=4)throw new BookError('busy','本地语音正在处理，请先停止当前操作。');
  const controller=new AbortController(),bounded=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(60000)]);this.active.set(key,controller);
  try{
   const value=await work(bounded,settings);bounded.throwIfAborted();
   if(JSON.stringify(this.settings(scope))!==JSON.stringify(settings))throw new BookError('conflict','语音设置已变化，本次结果不再应用。');return value;
  }catch(error){if(bounded.aborted)throw new BookError('unavailable','本地语音已取消或超时，没有自动重试。',{cause:error});if(error instanceof BookError)throw error;throw new BookError('unavailable','本地语音失败：'+(error instanceof Error?error.message:String(error)),{cause:error});}finally{if(this.active.get(key)===controller)this.active.delete(key);}
 }
 async synthesize(scope:BookScope,text:unknown,signal:AbortSignal){
  if(typeof text!=='string'||!text.trim()||text.includes('\0')||[...text].length>2000)throw new BookError('invalid_input','朗读正文需要 1～2000 字；长回复请分段选择，不会静默截断。');
  return this.run(scope,signal,async(bounded,settings)=>{
   const capabilities=await this.capabilities(bounded);if(!capabilities.available||!capabilities.voices.length)throw new BookError('unavailable',capabilities.reason??'没有可用的 Windows 朗读声音。');
   if(settings.voiceName&&!capabilities.voices.some(row=>row.name===settings.voiceName))throw new BookError('unavailable','所选声音未安装，请重新选择；不会自动换声音。');
   const result=await this.engine.synthesize(text,settings.voiceName,bounded),wav=inspectPcmWav(result.bytes);
   if(result.bytes.byteLength>12*1024*1024||wav.durationMs>360000)throw new BookError('budget','生成的语音超过本地播放限额，未返回截断片段。');
   return {audioBase64:Buffer.from(result.bytes).toString('base64'),mime:'audio/wav',durationMs:wav.durationMs};
  });
 }
 async recognize(scope:BookScope,audioBase64:unknown,signal:AbortSignal){
  if(typeof audioBase64!=='string'||audioBase64.length>2000000||!audioBase64.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(audioBase64))throw new BookError('invalid_input','录音编码无效或超过限额。');
  const bytes=Buffer.from(audioBase64,'base64');
  try{
   if(bytes.toString('base64')!==audioBase64)throw new BookError('invalid_input','录音编码不规范。');
   let wav;try{wav=inspectPcmWav(bytes);}catch(cause){throw new BookError('invalid_input','录音须为有效的 16-bit PCM WAV。',{cause});}
   if(wav.channels!==1||wav.sampleRate<8000||wav.sampleRate>48000||wav.durationMs>30000)throw new BookError('budget','录音须为单声道、8～48 kHz、最长 30 秒。');
   return await this.run(scope,signal,async(bounded,settings)=>{
    const capabilities=await this.capabilities(bounded);if(!capabilities.available||!capabilities.recognizers.some(row=>row.culture===settings.language))throw new BookError('unavailable','所选本地识别语言未安装，请在 Windows 中安装或切换语言。');
    const result=await this.engine.recognize(bytes,settings.language,bounded);
    if(typeof result.text!=='string'||!result.text.trim())throw new BookError('unavailable','没有识别到清晰语音；本次没有发送聊天，请检查麦克风后重试。');
    if(result.text.length>4000||!Array.isArray(result.segments))throw new BookError('unavailable','语音识别回执无效或超限。');
    for(const [id,row]of this.transcripts)if(Date.now()>=row.until)this.transcripts.delete(id);
    if(this.transcripts.size>=32)throw new BookError('budget','待确认转写达到32份，请等待过期或关闭语音会话。');
    const receipt={id:'transcript-'+randomUUID(),sha256:createHash('sha256').update(result.text).digest('hex'),at:new Date().toISOString(),language:settings.language};this.transcripts.set(receipt.id,{scope:structuredClone(scope),text:result.text,receipt,until:Date.now()+300000});return {...result,receipt};
   });
  }finally{bytes.fill(0);}
 }
}

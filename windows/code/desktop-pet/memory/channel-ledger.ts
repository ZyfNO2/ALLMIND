import {mkdirSync,existsSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,lstatSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {BookError,type BookScope} from '../contracts/memory-book.js';
import type {QqIncomingMessage,ChannelDelivery} from '../contracts/book-channel.js';
import {validateIdentity,validateScope} from './book-validation.js';
import {replaceResourceFile} from './resource-atomic-replace.js';
import {acquireBookWriterLock} from './book-writer-lock.js';
import {restrictPrivatePathSync} from '../core/platform-files.js';
import {qqId} from './channel-publication.js';

export type {ChannelDelivery} from '../contracts/book-channel.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Bounded private durable ledger; an uncertain side effect never automatically becomes queued. */
export class ChannelLedger {
  private rows:ChannelDelivery[]=[];
  private lock:number|null=null;
  private readonly filename:string;
  constructor(private readonly directory:string){
    mkdirSync(directory,{recursive:true});restrictPrivatePathSync(directory);this.filename=join(directory,'deliveries.json');
    this.lock=acquireBookWriterLock(directory);writeFileSync(this.lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));fsyncSync(this.lock);
    try{
      if(existsSync(this.filename)){
        const stat=lstatSync(this.filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw new BookError('corrupt_data','QQ 投递账本无效或过大。');
        const data=JSON.parse(readFileSync(this.filename,'utf8'));if(data.schemaVersion!=='allmind-channel-ledger/v1'||!Array.isArray(data.rows)||data.rows.length>1000)throw new BookError('corrupt_data','QQ 投递账本结构无效。');
        const ids=new Set<string>();for(const row of data.rows){this.validate(row);if(ids.has(row.event.eventKey))throw new BookError('corrupt_data','QQ 账本出现重复入站。');ids.add(row.event.eventKey);}
        this.rows=data.rows;
        let changed=false;for(const row of this.rows){
          if(row.state==='generating'){row.state='unknown';row.error='重启前生成是否完成未确认，不自动重新生成。';changed=true;}
          for(const part of row.parts)if(part.state==='intent'){part.state='unknown';row.state='unknown';row.error='重启前投递回执未确认，不自动重发。';changed=true;}
        }
        if(changed)this.save();
      }
    }catch(error){this.close();throw error;}
  }
  private validate(row:ChannelDelivery){
    if(!row||typeof row!=='object'||!row.event||typeof row.event!=='object')throw new BookError('corrupt_data','QQ 入站记录无效。');
    validateIdentity(row.turnId);validateScope(row.scope);validateIdentity(row.event.eventKey);
    if(!Number.isSafeInteger(row.receivedAt)||row.receivedAt<0)throw new BookError('corrupt_data','QQ 入站时间无效。');
    const event=row.event;validateIdentity(event.connectorId);qqId(event.selfId);qqId(event.targetId);qqId(event.senderId);
    if(!['private','group'].includes(event.kind)||typeof event.messageId!=='string'||! /^-?\d{1,32}$/.test(event.messageId)||typeof event.text!=='string'||!event.text.trim()||event.text.length>16000||typeof event.senderName!=='string'||event.senderName.length>100||typeof event.mentionsSelf!=='boolean'||typeof event.hasUnsupportedMedia!=='boolean'||event.eventKey!=='qq-'+hash([event.connectorId,event.selfId,event.kind,event.targetId,event.messageId]))throw new BookError('corrupt_data','QQ 入站身份或文本无效。');
    if(!/^[a-f0-9]{64}$/.test(row.publicationHash)||!['queued','generating','generated','sent','failed','unknown','cancelled'].includes(row.state)||!Array.isArray(row.parts)||row.parts.length>16)throw new BookError('corrupt_data','QQ 投递记录无效。');
    for(const part of row.parts)if(typeof part.text!=='string'||!part.text.trim()||Array.from(part.text).length>1500||!['pending','intent','sent','unknown'].includes(part.state)||part.confirmation!==undefined&&!['platform','local'].includes(part.confirmation)||part.messageId!==null&&(typeof part.messageId!=='string'||! /^-?\d{1,32}$/.test(part.messageId)))throw new BookError('corrupt_data','QQ 投递分段无效。');
  }
  private assertOpen(){if(this.lock===null)throw new BookError('unavailable','QQ 账本已关闭。');}
  private save(){
    this.assertOpen();const content=JSON.stringify({schemaVersion:'allmind-channel-ledger/v1',rows:this.rows});if(Buffer.byteLength(content)>16*1024*1024)throw new BookError('budget','QQ 账本达到16 MiB上限，请在本机归档。');
    const temp=this.filename+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,content+'\n');fsyncSync(fd);}finally{closeSync(fd);}replaceResourceFile(temp,this.filename);
  }
  private mutate(key:string,work:(row:ChannelDelivery)=>void){
    this.assertOpen();const index=this.rows.findIndex(row=>row.event.eventKey===key);if(index<0)throw new BookError('not_found','QQ 投递记录不存在。');
    const previous=this.rows[index]!,next=structuredClone(previous);work(next);this.validate(next);this.rows[index]=next;try{this.save();}catch(error){this.rows[index]=previous;throw error;}return structuredClone(next);
  }
  get(key:string){this.assertOpen();const row=this.rows.find(row=>row.event.eventKey===key);return row?structuredClone(row):null;}
  list(){this.assertOpen();return structuredClone(this.rows);}
  accept(event:QqIncomingMessage,scope:BookScope,publicationHash:string):{row:ChannelDelivery;duplicate:boolean}{
    this.assertOpen();const prior=this.get(event.eventKey);
    if(prior){if(hash(prior.event)!==hash(event)||hash(prior.scope)!==hash(scope)||prior.publicationHash!==publicationHash)throw new BookError('conflict','QQ 重复消息的内容、角色版本或路由已变化，不处理。');return {row:prior,duplicate:true};}
    if(this.rows.length>=1000)throw new BookError('budget','QQ 投递账本已达1000条，请在本机归档。');
    const row:ChannelDelivery={event:structuredClone(event),scope:structuredClone(scope),publicationHash,turnId:'qq-turn-'+hash([event.eventKey,scope,publicationHash]),receivedAt:Date.now(),state:'queued',parts:[],error:null};this.validate(row);this.rows.push(row);try{this.save();}catch(error){this.rows.pop();throw error;}return {row:structuredClone(row),duplicate:false};
  }
  begin(key:string){return this.mutate(key,row=>{if(row.state!=='queued')throw new BookError('conflict','QQ 生成不允许自动重复。');row.state='generating';});}
  generated(key:string,text:string){
    if(typeof text!=='string'||!text.trim()||text.includes('\0')||Array.from(text).length>24000)throw new BookError('budget','QQ 回复为空或超过16段，未截断和发送。');
    const chars=Array.from(text),parts:ChannelDelivery['parts']=[];for(let offset=0;offset<chars.length;offset+=1500){const part=chars.slice(offset,offset+1500).join('');if(part.trim())parts.push({text:part,state:'pending',messageId:null});}
    return this.mutate(key,row=>{if(row.state!=='generating')throw new BookError('conflict','QQ 生成状态已改变。');row.parts=parts;row.state='generated';});
  }
  intent(key:string,index:number){return this.mutate(key,row=>{if(row.state!=='generated'||row.parts.slice(0,index).some(part=>part.state!=='sent')||row.parts[index]?.state!=='pending')throw new BookError('conflict','QQ 分段不可发送。');row.parts[index]!.state='intent';});}
  sent(key:string,index:number,messageId:string){return this.mutate(key,row=>{if(row.parts[index]?.state!=='intent')throw new BookError('conflict','QQ 发送意图不匹配。');row.parts[index]!.state='sent';row.parts[index]!.messageId=messageId;row.parts[index]!.confirmation='platform';if(row.parts.every(part=>part.state==='sent'))row.state='sent';});}
  unknown(key:string,index:number){return this.mutate(key,row=>{if(row.parts[index]?.state!=='intent')throw new BookError('conflict','QQ 未知回执的意图不匹配。');row.parts[index]!.state='unknown';row.state='unknown';row.error='投递结果未知，请在本机核对；不会自动重发。';});}
  review(key:string,index:number,action:'delivered'|'retry',messageId:string|null,confirmed:boolean){return this.mutate(key,row=>{
    if(confirmed!==true||row.state!=='unknown'||row.parts[index]?.state!=='unknown'||row.parts.some(part=>part.state==='intent'))throw new BookError('conflict','请先在本机核对未知分段并确认操作。');
    if(action==='delivered'){
      if(typeof messageId!=='string'||! /^-?\d{1,32}$/.test(messageId))throw new BookError('invalid_input','请输入核实后的平台消息ID。');
      row.parts[index]!.state='sent';row.parts[index]!.messageId=messageId;row.parts[index]!.confirmation='local';
    }else if(action==='retry'){row.parts[index]!.state='pending';row.parts[index]!.messageId=null;delete row.parts[index]!.confirmation;}
    else throw new BookError('invalid_input','未知的投递核对操作。');
    row.state=row.parts.every(part=>part.state==='sent')?'sent':'generated';row.error=null;
  });}
  stop(key:string,cancelled:boolean){return this.mutate(key,row=>{if(row.state==='sent'||row.state==='unknown'||row.parts.some(part=>part.state==='intent'||part.state==='unknown'))throw new BookError('conflict','已发出或未知结果不能改成失败/已取消。');row.state=cancelled?'cancelled':'failed';row.error=cancelled?'本机取消或授权已撤销。':'生成未完成，需在本机核对。';});}
  close(){if(this.lock!==null){closeSync(this.lock);this.lock=null;unlinkSync(join(this.directory,'writer.lock'));}}
}

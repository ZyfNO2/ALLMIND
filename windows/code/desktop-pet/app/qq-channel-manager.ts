import {existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,lstatSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BookError,type RuntimeConfig} from '../contracts/memory-book.js';
import type {QqIncomingMessage,QqChannelConfig} from '../contracts/book-channel.js';
import {assertPublicationCurrent,qqId,qqScope,type PublicationSelection} from '../memory/channel-publication.js';
import {validateIdentity,validateModelBinding} from '../memory/book-validation.js';
import {replaceResourceFile} from '../memory/resource-atomic-replace.js';
import {restrictPrivatePathSync} from '../core/platform-files.js';
import type {FileBookRepository} from '../memory/file-book-repository.js';
import type {BookCredentials} from '../management/book-credentials.js';
import type {BookModelPort} from '../providers/book-model.js';
import {OneBotQqListener} from '../providers/onebot-qq.js';
import {QqChannelService} from './qq-channel-service.js';
import {NapcatHostManager} from './napcat-host.js';

export type {QqChannelConfig} from '../contracts/book-channel.js';

const defaults=():QqChannelConfig=>({revision:0,enabled:false,connectorId:'qq-main',selfId:'',port:54188,privateIds:[],groupIds:[],publicationId:'',epoch:'initial',model:null,tokenCredentialId:null});

/** Local management owns lifecycle. Constructor opens no socket and performs no model calls. */
export class QqChannelManager {
  readonly napcat:NapcatHostManager;
  private config:QqChannelConfig=defaults();
  private listener:OneBotQqListener|null=null;
  private service:QqChannelService;
  private busy=false;
  private error:string|null=null;
  private readonly file:string;
  constructor(private readonly options:{directory:string;source:FileBookRepository;credentials:BookCredentials;model:(config:()=>RuntimeConfig)=>BookModelPort}){
    mkdirSync(options.directory,{recursive:true});restrictPrivatePathSync(options.directory);this.file=join(options.directory,'settings.json');
    if(existsSync(this.file)){
      const stat=lstatSync(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new BookError('corrupt_data','QQ 设置文件无效。');
      this.config=this.validate(JSON.parse(readFileSync(this.file,'utf8')));
    }
    this.service=this.makeService();
    this.napcat=new NapcatHostManager({directory:options.directory,credentials:options.credentials,channel:()=>structuredClone(this.config),channelBusy:()=>this.busy});
  }
  private validate(value:QqChannelConfig):QqChannelConfig {
    if(!value||typeof value!=='object'||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.enabled!=='boolean')throw new BookError('invalid_input','QQ 设置格式无效。');
    validateIdentity(value.connectorId);validateIdentity(value.epoch);
    if(typeof value.selfId!=='string'||value.selfId!==''&&qqId(value.selfId)!==value.selfId||!Number.isSafeInteger(value.port)||value.port<1024||value.port>65535)throw new BookError('invalid_input','QQ 账号或监听端口无效。');
    for(const ids of [value.privateIds,value.groupIds])if(!Array.isArray(ids)||ids.length>64||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||qqId(id)!==id))throw new BookError('invalid_input','QQ 白名单无效或重复。');
    if(typeof value.publicationId!=='string')throw new BookError('invalid_input','QQ 发布角色无效。');if(value.publicationId)validateIdentity(value.publicationId);
    if(value.model!==null)validateModelBinding(value.model);
    if(value.tokenCredentialId!==null)validateIdentity(value.tokenCredentialId);
    if(value.conversationEpochs!==undefined){
      if(!value.conversationEpochs||typeof value.conversationEpochs!=='object'||Array.isArray(value.conversationEpochs)||Object.keys(value.conversationEpochs).length>128)throw new BookError('invalid_input','QQ 会话标识无效。');
      for(const [key,epoch] of Object.entries(value.conversationEpochs)){if(!/^(private|group):[1-9][0-9]{0,31}$/.test(key))throw new BookError('invalid_input','QQ 会话目标无效。');validateIdentity(epoch);}
    }
    if(value.enabled&&(!value.selfId||!value.publicationId||!value.model||!value.tokenCredentialId||!value.privateIds.length&&!value.groupIds.length))throw new BookError('invalid_input','启用前请填写账号、白名单、渠道模型、token 并审核发布角色。');
    return {revision:value.revision,enabled:value.enabled,connectorId:value.connectorId,selfId:value.selfId,port:value.port,privateIds:[...value.privateIds],groupIds:[...value.groupIds],publicationId:value.publicationId,epoch:value.epoch,...(value.conversationEpochs?{conversationEpochs:structuredClone(value.conversationEpochs)}:{}),model:value.model?structuredClone(value.model):null,tokenCredentialId:value.tokenCredentialId};
  }
  private route(event:QqIncomingMessage){
    const config=this.config;if(!config.enabled||event.connectorId!==config.connectorId||event.selfId!==config.selfId||!(event.kind==='private'?config.privateIds:config.groupIds).includes(event.targetId))return null;
    return {publicationId:config.publicationId,epoch:config.conversationEpochs?.[event.kind+':'+event.targetId]??config.epoch};
  }
  private channelRuntime():RuntimeConfig {
    const base=this.options.source.loadConfig();return {...base,mainModel:this.config.model?structuredClone(this.config.model):null,chatgptProjects:[],...(base.chatgptWeb?{chatgptWeb:{...base.chatgptWeb,conversationMode:'temporary' as const,temporaryChatTests:true,authorizedPurposes:['reply' as const]}}:{})};
  }
  private makeService(){return new QqChannelService({source:this.options.source,directory:join(this.options.directory,'state'),route:event=>this.route(event),modelConfig:()=>this.channelRuntime(),model:this.options.model,send:async(event,text)=>{
    if(!this.route(event)||!this.listener)throw new BookError('conflict','QQ 通道未运行或授权已撤销。');return this.listener.send(event,text);
  }});}
  private save(config:QqChannelConfig){
    const file=this.file+'.'+randomUUID()+'.tmp',fd=openSync(file,'wx',0o600);try{writeFileSync(fd,JSON.stringify(config)+'\n');fsyncSync(fd);}finally{closeSync(fd);}replaceResourceFile(file,this.file);this.config=config;
  }
  view(){return {config:structuredClone(this.config),status:{...(this.listener?.status()??{listening:false,connected:false,ready:false}),busy:this.busy,error:this.error},publications:this.service.listPublications(),deliveries:this.service.ledger.list()};}
  preview(selection:PublicationSelection){return this.service.preview(selection);}
  publish(selection:PublicationSelection,hash:string,confirmed:boolean){if(this.busy||this.config.enabled)throw new BookError('busy','请先停止 QQ 通道，再审核发布资料。');return this.service.publish(selection,hash,confirmed);}
  revoke(id:string){this.service.revoke(id);}
  async configure(input:QqChannelConfig,expectedRevision:number,token?:string){
    if(this.napcat.processing)throw new BookError('busy','NapCat 正在操作，请稍后再修改 QQ 设置。');
    if(this.busy)throw new BookError('busy','QQ 通道操作尚未结束。');if(expectedRevision!==this.config.revision)throw new BookError('conflict','QQ 设置已变化，请回读。');
    if(input.enabled!==false)throw new BookError('invalid_input','保存设置不会自动启用；请单独点击启动。');
    const next=this.validate({...input,revision:this.config.revision+1,tokenCredentialId:this.config.tokenCredentialId});
    if(token!==undefined){if(!/^[A-Za-z0-9_-]{32,128}$/.test(token))throw new BookError('invalid_input','token 须为32–128位随机字符。');next.tokenCredentialId='qq-token-'+randomUUID();}
    this.busy=true;
    try{
      // Disable routing before aborting active work. Persisted disabled state also survives restart.
      const disabled={...this.config,enabled:false,revision:this.config.revision+1};this.save(disabled);
      await this.listener?.close();this.listener=null;await this.service.close();
      if(token!==undefined)this.options.credentials.save(next.tokenCredentialId!,token);
      this.save(next);this.service=this.makeService();this.error=null;return this.view();
    }catch(error){this.error='QQ 设置未完成，请停止并回读状态。';throw error;}finally{this.busy=false;}
  }
  async start(expectedRevision:number){
    if(this.napcat.processing)throw new BookError('busy','NapCat 正在操作，请稍后再启动 QQ 通道。');
    if(this.busy)throw new BookError('busy','QQ 通道操作尚未结束。');if(expectedRevision!==this.config.revision)throw new BookError('conflict','QQ 设置已变化，请回读。');if(this.listener)return this.view();
    const next=this.validate({...this.config,enabled:true,revision:this.config.revision+1});
    const publication=this.service.listPublications().find(row=>row.id===next.publicationId);if(!publication)throw new BookError('invalid_input','请先审核发布角色。');
    // Recheck source revocation before listening, without sending or generating anything.
    assertPublicationCurrent(this.options.source,publication);
    this.busy=true;
    let listener:OneBotQqListener|null=null;
    try{
      const host=await this.napcat.view();
      if(host.configured&&(!host.reachable||!host.accountMatches))throw new BookError('unavailable',host.error??'请先在 NapCat 中登录预期机器人账号。');
      const token=await this.options.credentials.get(next.tokenCredentialId!);
      listener=new OneBotQqListener({connectorId:next.connectorId,selfId:next.selfId,port:next.port,token,allowed:()=>({privateIds:this.config.privateIds,groupIds:this.config.groupIds}),onMessage:async event=>{await this.service.receive(event);},onError:()=>{this.error='QQ 连接或消息处理失败，请检查本机投递账本；未知结果不会自动重发。';}});
      await listener.start();this.listener=listener;this.save(next);this.error=null;return this.view();
    }catch(error){await listener?.close();this.listener=null;this.error='QQ 启动失败，请检查账号、token、发布资料和监听端口；桌面聊天不受影响。';throw error;}finally{this.busy=false;}
  }
  async stop(expectedRevision:number){return this.configure({...this.config,enabled:false},expectedRevision);}
  async resume(){if(this.busy||!this.config.enabled||!this.listener?.status().ready)throw new BookError('unavailable','请先连接并核对 QQ 账号。');await this.service.resumeQueued();return this.view();}
  async review(key:string,index:number,action:'delivered'|'retry',messageId:string|null,confirmed:boolean){if(this.busy)throw new BookError('busy','QQ 操作尚未结束。');await this.service.review(key,index,action,messageId,confirmed);return this.view();}
  newTopic(kind:'private'|'group',targetId:string,expectedRevision:number){
    if(this.busy)throw new BookError('busy','QQ 操作尚未结束。');if(expectedRevision!==this.config.revision)throw new BookError('conflict','QQ 设置已变化，请回读。');
    if(!['private','group'].includes(kind)||!(kind==='private'?this.config.privateIds:this.config.groupIds).includes(qqId(targetId)))throw new BookError('invalid_input','只能为已授权目标创建新话题。');
    const publication=this.service.listPublications().find(row=>row.id===this.config.publicationId);if(!publication)throw new BookError('not_found','QQ 发布角色不存在。');
    const conversation={kind,targetId,selfId:this.config.selfId,connectorId:this.config.connectorId};
    const next=this.validate({...this.config,revision:this.config.revision+1,conversationEpochs:{...this.config.conversationEpochs,[kind+':'+targetId]:randomUUID()}});
    this.save(next);this.service.cancelTarget(conversation);return this.view();
  }
  /** Saved opt-in starts only on explicit backend startup; disabled default creates no listener. */
  async restore(){if(this.config.enabled)await this.start(this.config.revision);}
  async close(){this.config={...this.config,enabled:false};await this.listener?.close();this.listener=null;await this.service.close();}
}

import {existsSync, readFileSync, writeFileSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BookError} from '../contracts/memory-book.js';
import type {BookRuntime} from '../app/book-runtime.js';
import type {BookCredentials} from './book-credentials.js';
import type {FileBookRepository} from '../memory/file-book-repository.js';
import {previewPublication, assertPublicationCurrent} from '../memory/channel-publication.js';
import {loadAstrbotSettings} from '../app/astrbot-settings.js';
import {listCapabilityBindings,listCapabilityRecords,saveCapabilityBinding,revokeCapabilityBinding,ensureCapabilityToken,type CapabilityBinding} from './allmind-capabilities.js';

export async function astrbotManagement(runtime:BookRuntime,credentials:BookCredentials,route:string,method:string,data:Record<string,unknown>) {
  const repo=runtime.repository as FileBookRepository,directory=repo.directory;
  if(!directory)throw new BookError('unavailable','当前存储不支持集成配置。');
  if(route==='/integrations/astrbot'&&method==='GET')return {settings:loadAstrbotSettings(directory),activeExecution:runtime.externalExecutor?'astrbot':'local',bindings:listCapabilityBindings(directory),records:listCapabilityRecords(directory),restartRequired:true};
  if(route==='/integrations/astrbot/token'&&method==='GET')return {token:ensureCapabilityToken(directory)};
  if(route==='/integrations/astrbot/config'&&method==='PUT'){
    if(data.execution!=='local'&&data.execution!=='astrbot')throw new BookError('invalid_input','执行模式无效。');
    const url=new URL(String(data.baseUrl));
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new BookError('invalid_input','AstrBot 地址必须为本机 HTTP 根地址。');
    if(typeof data.instanceId!=='string'||!/^[A-Za-z0-9._-]{1,80}$/.test(data.instanceId))throw new BookError('invalid_input','实例编号无效。');
    if(data.apiKey!==undefined&&data.apiKey!=='')credentials.save('astrbot-openapi',String(data.apiKey));
    if(data.execution==='astrbot'&&credentials.status('astrbot-openapi').state!=='ready')throw new BookError('invalid_input','请先填写 API Key。');
    if(data.modeConfigIds!==undefined&&(!data.modeConfigIds||typeof data.modeConfigIds!=='object'||Array.isArray(data.modeConfigIds)||Object.entries(data.modeConfigIds).some(([key,value])=>!['quick','smart','rp'].includes(key)||typeof value!=='string'||!value||value.length>100)))throw new BookError('invalid_input','场景配置映射无效。');
    const settings={...(data.modeConfigIds?{modeConfigIds:data.modeConfigIds}:{}),execution:data.execution,baseUrl:url.origin,credentialId:'astrbot-openapi',configId:typeof data.configId==='string'&&data.configId?data.configId:null,instanceId:data.instanceId};
    const temp=join(directory,'astrbot.'+randomUUID()+'.tmp');writeFileSync(temp,JSON.stringify(settings)+'\n',{mode:0o600});renameSync(temp,join(directory,'astrbot.json'));
    return {saved:true,restartRequired:true};
  }
  if(route==='/integrations/astrbot/publication'&&method==='POST')return {publication:previewPublication(repo,data.selection as Parameters<typeof previewPublication>[1])};
  if(route==='/integrations/astrbot/bindings'&&method==='PUT'){
    if(data.confirmed!==true)throw new BookError('invalid_input','请先核对身份与公开内容再确认绑定。');
    const binding=data.binding as CapabilityBinding;
    if(binding?.audience==='public'){
      if(!binding.publication)throw new BookError('invalid_input','公开绑定需要审核快照。');
      assertPublicationCurrent(repo,binding.publication);
      if(binding.characterId!==binding.publication.character.id)throw new BookError('invalid_input','角色与公开快照不符。');
    }
    saveCapabilityBinding(directory,binding);return {saved:true};
  }
  if(route==='/integrations/astrbot/bindings'&&method==='DELETE'){
    revokeCapabilityBinding(directory,data as unknown as CapabilityBinding);return {revoked:true};
  }
  if(route==='/integrations/astrbot/send'&&method==='POST'){
    if(data.confirmed!==true)throw new BookError('invalid_input','请核对目标和正文后确认发送。');
    const target=listCapabilityBindings(directory).find(row=>row.platform===data.platform&&row.conversationKey===data.conversationKey&&row.senderKey===data.senderKey);
    if(!target)throw new BookError('forbidden','目标尚未绑定或已撤销。');
    if(target.publication)assertPublicationCurrent(repo,target.publication);
    const settings=loadAstrbotSettings(directory);
    if(settings?.execution!=='astrbot')throw new BookError('conflict','AstrBot 连接未配置。');
    const {AstrbotConnector}=await import('../app/astrbot-connector.js');
    const connector=new AstrbotConnector(directory,settings,()=>credentials.get(settings.credentialId));
    return connector.send({requestId:String(data.requestId??''),umo:target.conversationKey,text:String(data.text??''),signal:AbortSignal.timeout(30000)});
  }
  throw new BookError('not_found','未知的 AstrBot 管理操作。');
}

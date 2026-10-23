import {statfsSync,lstatSync} from 'node:fs';
import type {BookRuntime} from '../app/book-runtime.js';
import type {BookCredentials} from './book-credentials.js';
import type {ModelBinding} from '../contracts/memory-book.js';
import type {DiagnosticCheck,BookDiagnosticReport} from '../contracts/book-diagnostics.js';
async function probe(binding:ModelBinding,credentials:BookCredentials,signal:AbortSignal):Promise<DiagnosticCheck>{
 const result:DiagnosticCheck={id:'model',status:'FAIL',detail:'连接尚未确认。',repair:'检查服务地址、模型名称和凭据，失败后手动重试。'};
 const url=new URL(binding.baseUrl);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))return {...result,detail:'服务地址不符合 HTTPS / 回环 HTTP 约束。'};
 url.pathname=url.pathname.replace(/\/$/,'').replace(/\/chat\/completions$/,'')+'/models';
 try{
  const key=await credentials.get(binding.credentialId),response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),redirect:'error',headers:key?{Authorization:'Bearer '+key}:{}});
  if(!response.ok){await response.body?.cancel();return {...result,detail:response.status===401||response.status===403?'凭据失效或权限不足。':response.status===429?'服务限流或额度不足。':'模型列表 HTTP '+response.status,repair:response.status===401||response.status===403?'撤销旧凭据后重新授权并测试连接。':result.repair};}
  const reader=response.body?.getReader();if(!reader)return {...result,detail:'模型列表没有正文。'};
  const chunks:Uint8Array[]=[];let size=0;try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024*1024){await reader.cancel();return {...result,detail:'模型列表超过1 MiB，停止读取。'};}chunks.push(part.value);}}finally{reader.releaseLock();}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(data.data)||!data.data.some((row:unknown)=>!!row&&typeof row==='object'&&(row as {id?:unknown}).id===binding.model))return {...result,detail:'服务列表未声明当前所选模型。'};
  return {...result,status:'PASS',detail:'当前凭据可以读取模型列表，且所选模型存在；没有提交推理请求。',repair:'如聊天失败，检查具体推理权限、额度和上下文预算；列表成功不等于推理成功。'};
 }catch{return {...result,detail:'连接、凭据读取或模型列表格式检查失败；未将响应正文、地址或密钥写入报告。'};}
}
/** Content-free by construction. The same report is safe for UI and manual export. */
export async function bookDiagnostics(options:{runtime:BookRuntime;credentials:BookCredentials;probeModels:boolean;signal:AbortSignal;webProbe?:()=>Promise<unknown>;channel?:()=>unknown}):Promise<BookDiagnosticReport>{
 const {runtime,credentials,signal}=options,config=runtime.repository.loadConfig(),checks:DiagnosticCheck[]=[{id:'backend',status:'PASS',detail:'当前管理 API 和运行时响应正常。',repair:'无。'}];
 try{for(const role of config.characters)runtime.repository.snapshot(runtime.scope(role.id,'diagnostics'));checks.push({id:'wiki',status:'PASS',detail:'全部活动角色的 Book 结构可读取；没有导出条目、角色名或原文。',repair:'如召回异常，检查来源启用状态和当前记忆域。'});}catch{checks.push({id:'wiki',status:'FAIL',detail:'存在不可读取或校验失败的 Book。',repair:'退出后保留数据原件；使用私人备份在独立目录恢复，勿覆盖损坏文件。'});}
 const directory=(runtime.repository as {directory?:string}).directory;
 if(directory)try{const stat=lstatSync(directory),space=statfsSync(directory),free=Number(space.bavail)*Number(space.bsize);checks.push({id:'storage',status:stat.isDirectory()&&!stat.isSymbolicLink()&&free>256*1024*1024?'PASS':'FAIL',detail:free>256*1024*1024?'数据目录可检查且至少有256 MiB可用空间。':'可用空间不足256 MiB。',repair:'保留数据与备份，清理已审核的旧程序版本；不删除运行数据。'});}catch{checks.push({id:'storage',status:'FAIL',detail:'数据目录或磁盘状态不可读取。',repair:'检查目录权限和磁盘，不切换到空目录掩盖错误。'});}else checks.push({id:'storage',status:'NOT_RUN',detail:'当前存储没有暴露本地目录检查能力。',repair:'使用文件存储实例检查。'});
 const bindings:[string,ModelBinding|null|undefined][]=[['main',config.mainModel],['fast',config.fastModel],['wiki',config.wikiModel],...Object.entries(config.dialogueRouting?.profiles??{}).map(([name,row]):[string,ModelBinding|undefined]=>['scene.'+name,row?.model])];
 for(const [slot,binding]of bindings){
  if(!binding){checks.push({id:'model.'+slot,status:'NOT_RUN',detail:'未配置此用途模型。',repair:slot==='main'?'在 AI 与对话中保存主模型。':'按需要配置专用模型。'});continue;}
  if(binding.kind==='chatgpt-web'){
   let ready=false;if(options.probeModels&&options.webProbe)try{const result=await options.webProbe();ready=!!result&&typeof result==='object'&&(result as {state?:string}).state==='ready';}catch{/* A failed probe is BLOCKED below; no provider response enters report. */}
   checks.push({id:'model.'+slot,status:ready?'PASS':options.probeModels?'BLOCKED':'NOT_RUN',detail:ready?'网页来源报告 ready；没有发送消息。':'网页模型需要就绪/登录检查，未验证推理。',repair:'从网页登录入口完成授权后检查就绪；不导出登录态。'});continue;
  }
  const state=credentials.status(binding.credentialId).state;
  checks.push({id:'credential.'+slot,status:['ready','not-required'].includes(state)?'PASS':'FAIL',detail:state==='ready'?'本机凭据文件存在且访问权限有效；未展示密钥。':state==='not-required'?'此连接显式不需要凭据。':'本机凭据缺失、已撤销或权限/格式无效。',repair:'在 AI 与对话重新填写 Key 并保存；可在此撤销旧凭据。'});
  const result=options.probeModels?await probe(binding,credentials,signal):{id:'model',status:'NOT_RUN' as const,detail:'尚未探测外部模型列表；本地检查不会访问外部服务。',repair:'点击“检查连接与本地状态”显式探测；该操作不发送聊天。'};checks.push({...result,id:'model.'+slot});
 }
 if(options.channel)try{const view=options.channel() as {config?:{enabled?:boolean};status?:{ready?:boolean}};checks.push({id:'channel',status:view.config?.enabled?(view.status?.ready?'PASS':'BLOCKED'):'NOT_RUN',detail:view.config?.enabled?'通道已启用，连接就绪状态以当前适配器回执为准。':'通道未启用；检查不会自动登录、连接或发信。',repair:'在 QQ 接入核对账号、token、发布快照和白名单后显式启动。'});}catch{checks.push({id:'channel',status:'FAIL',detail:'通道状态读取失败。',repair:'检查 QQ 设置；不会影响桌面记忆隔离。'});}else checks.push({id:'channel',status:'NOT_RUN',detail:'此运行实例没有外部通道。',repair:'使用完整桌面实例检查。'});
 return {schemaVersion:'allmind-diagnostics/v1',at:new Date().toISOString(),checks,privacy:'报告不含角色名、账号、Key、服务地址、本机路径、聊天/资料原文或登录态。模型列表检查不证明推理成功。',modelSubmissions:0};
}

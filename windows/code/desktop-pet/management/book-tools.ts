import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {BookError,type BookScope} from '../contracts/memory-book.js';
import type {BookToolProfile,BookToolJob} from '../contracts/book-tools.js';
import {validateIdentity,validateScope} from '../memory/book-validation.js';
import {replaceResourceFile} from '../memory/resource-atomic-replace.js';
import {AcpProtocolAdapter,McpToolProtocolAdapter} from '../core/work-protocol-adapter.js';
import type {WorkRequest} from '../contracts/perception.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Saved {schemaVersion:'allmind-tools/v1';revision:number;profiles:BookToolProfile[];jobs:BookToolJob[]}
function text(value:unknown,max:number){if(typeof value!=='string'||value.length>max||value.includes('\0'))throw new BookError('invalid_input','工具文本无效或过大。');return value;}
function binary(file:string){if(!isAbsolute(file))throw new BookError('invalid_input','请选择工具程序的绝对路径。');const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024*1024)throw new BookError('invalid_input','工具程序不可用、为链接或超过256 MiB。');return createHash('sha256').update(readFileSync(file)).digest('hex');}
function same(a:BookScope,b:BookScope){return a.characterId===b.characterId&&a.pairingId===b.pairingId&&a.sessionId===b.sessionId;}
function requestHash(job:Pick<BookToolJob,'id'|'scope'|'profileId'|'profileRevision'|'toolName'|'arguments'|'instruction'|'grants'>){return hash({id:job.id,scope:job.scope,profileId:job.profileId,profileRevision:job.profileRevision,toolName:job.toolName,arguments:job.arguments,instruction:job.instruction,grants:job.grants});}
/** Local user-controlled dispatch only. Quoted material and model output have no reference to this service. */
export class BookTools {
 private saved:Saved={schemaVersion:'allmind-tools/v1',revision:0,profiles:[],jobs:[]};
 private active=new Map<string,{controller:AbortController;done:Promise<void>;finish:()=>void}>();
 private mcp=new Map<string,McpToolProtocolAdapter>();
 private closed=false;
 private configuring=false;
 constructor(private readonly directory:string){
  mkdirSync(directory,{recursive:true});const file=join(directory,'tools.json');
  if(existsSync(file)){const stat=lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>8*1024*1024)throw new BookError('corrupt_data','工具账本无效。');const saved=JSON.parse(readFileSync(file,'utf8')) as Saved;
   if(saved?.schemaVersion!=='allmind-tools/v1'||!Number.isSafeInteger(saved.revision)||saved.revision<0||!Array.isArray(saved.profiles)||saved.profiles.length>16||!Array.isArray(saved.jobs)||saved.jobs.length>128)throw new BookError('corrupt_data','工具账本结构无效。');
   for(const job of saved.jobs){validateScope(job.scope);validateIdentity(job.id);if(requestHash(job)!==job.hash||!['prepared','running','succeeded','failed','unknown','cancelled'].includes(job.state))throw new BookError('corrupt_data','工具任务校验失败。');}
   this.saved=saved;let changed=false;for(const job of saved.jobs)if(job.state==='running'){job.state='unknown';job.error='上次执行回执未确认；重启不会自动重发。';changed=true;}if(changed)this.persist(saved);
  }
 }
 private persist(next:Saved){if(this.closed)throw new BookError('unavailable','工具服务已关闭。');const serialized=JSON.stringify(next)+'\n';if(Buffer.byteLength(serialized)>8*1024*1024)throw new BookError('budget','工具账本超过8 MiB；请保留原记录，未继续写入。');const target=join(this.directory,'tools.json');if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new BookError('corrupt_data','工具账本链接无效。');const temp=target+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,serialized);fsyncSync(fd);}finally{closeSync(fd);}replaceResourceFile(temp,target);this.saved=next;}
 view(scope:BookScope){validateScope(scope);return structuredClone({...this.saved,jobs:this.saved.jobs.filter(job=>same(job.scope,scope))});}
 private profile(id:string){if(this.configuring)throw new BookError('busy','工具连接正在变更，请等待保存结束。');const p=this.saved.profiles.find(row=>row.id===id);if(!p)throw new BookError('not_found','工具连接不存在。');if(binary(p.command)!==p.commandHash||!Array.isArray(p.argumentFiles)||p.argumentFiles.some(row=>binary(row.path)!==row.sha256))throw new BookError('conflict','工具程序或启动脚本已变化；请重新核对连接，旧审核无效。');return p;}
 async configure(value:Omit<BookToolProfile,'revision'|'commandHash'|'argumentFiles'>,expectedRevision:number,confirmed:boolean){
  if(confirmed!==true)throw new BookError('invalid_input','需明确授权此本机程序；工具以当前用户权限运行，权限表不是操作系统沙箱。');
  if(this.configuring)throw new BookError('busy','工具连接保存尚未结束。');
  if(this.saved.revision!==expectedRevision)throw new BookError('conflict','工具配置已变化，请回读。');if(this.active.size)throw new BookError('busy','先停止或等待当前工具任务。');
  if(!value||Object.keys(value).some(k=>!['id','label','protocol','command','args','cwd','permission','policies'].includes(k)))throw new BookError('invalid_input','工具连接字段无效。');
  validateIdentity(value.id);if(!text(value.label,120).trim()||!['mcp','acp','plugin'].includes(value.protocol)||!['read-only','confirm','write'].includes(value.permission)||!Array.isArray(value.args)||value.args.length>64||!isAbsolute(value.cwd)||!lstatSync(value.cwd).isDirectory()||lstatSync(value.cwd).isSymbolicLink())throw new BookError('invalid_input','工具连接或工作目录无效。');value.args.forEach(arg=>text(arg,4096));
  if(!value.policies||typeof value.policies!=='object'||Array.isArray(value.policies)||Object.keys(value.policies).length>128)throw new BookError('invalid_input','本机工具权限表无效。');
  for(const [name,policy]of Object.entries(value.policies)){validateIdentity(name);if(!policy||typeof policy.readOnly!=='boolean'||Object.keys(policy).some(key=>!['readOnly','requiredGrant'].includes(key))||policy.requiredGrant!==undefined&&!/^[A-Za-z0-9._-]{1,128}$/.test(policy.requiredGrant))throw new BookError('invalid_input','工具权限声明无效。');}
  const prior=this.saved.profiles.find(row=>row.id===value.id);if(!prior&&this.saved.profiles.length>=16)throw new BookError('budget','工具连接最多16个。');
  const argumentFiles=value.args.filter(arg=>arg&&!arg.startsWith('-')&&/\.(?:mjs|cjs|js|py|ps1|sh|exe|dll|bat|cmd)$/i.test(arg)).map(arg=>resolve(value.cwd,arg)).filter(file=>existsSync(file)&&lstatSync(file).isFile()).map(file=>({path:file,sha256:binary(file)}));
  const profile:BookToolProfile={...structuredClone(value),revision:(prior?.revision??0)+1,commandHash:binary(value.command),argumentFiles};
  this.configuring=true;try{await this.mcp.get(value.id)?.close();this.mcp.delete(value.id);this.persist({...this.saved,revision:this.saved.revision+1,profiles:[...this.saved.profiles.filter(p=>p.id!==value.id),profile]});return structuredClone(profile);}finally{this.configuring=false;}
 }
 private adapter(profile:BookToolProfile){let adapter=this.mcp.get(profile.id);if(!adapter){adapter=new McpToolProtocolAdapter(undefined,[],{command:profile.command,args:profile.args,cwd:profile.cwd,requestTimeoutMs:30000,maxMessageBytes:1024*1024,trustedToolPolicies:profile.policies});this.mcp.set(profile.id,adapter);}return adapter;}
 async listTools(id:string){const profile=this.profile(id);if(profile.protocol==='acp')return [];return this.adapter(profile).listTools();}
 async prepare(scope:BookScope,input:{profileId:string;toolName?:string;arguments?:Record<string,unknown>;instruction?:string}){
  validateScope(scope);if(this.saved.jobs.length>=128)throw new BookError('budget','任务记录达到128条；不能淘汰旧编号来重新执行。');const profile=this.profile(input.profileId);let grants:string[]=[];
  const args=input.arguments??{};if(!args||typeof args!=='object'||Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>64000)throw new BookError('invalid_input','工具参数必须为不超过64 KiB的 JSON 对象。');
  const instruction=text(input.instruction??'',20000);let toolName:string|null=null;
  if(profile.protocol==='acp'){if(!instruction.trim()||profile.permission==='read-only')throw new BookError('invalid_input','ACP 需明确任务说明和确认/可写授权；无法证明代理内部任务只读，已拒绝只读连接。');grants=['acp.allow_once'];}
  else{toolName=text(input.toolName,128);const tool=(await this.listTools(profile.id)).find(row=>row.name===toolName);if(!tool)throw new BookError('not_found','没有该工具。');const policy=Object.hasOwn(profile.policies,toolName)?profile.policies[toolName]:undefined;
   if(!policy)throw new BookError('invalid_input','远端工具声明不能授予权限；请在本机权限表明确授权此工具。');if(!policy.readOnly){if(profile.permission==='read-only')throw new BookError('invalid_input','此连接只读，不能准备写入工具。');grants=[policy.requiredGrant??'write'];}
  }
  const job:BookToolJob={id:randomUUID(),scope:structuredClone(scope),profileId:profile.id,profileRevision:profile.revision,protocol:profile.protocol,toolName,arguments:structuredClone(args),instruction,grants,hash:'',state:'prepared',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),result:null,error:null};job.hash=requestHash(job);this.persist({...this.saved,jobs:[...this.saved.jobs,job]});return structuredClone(job);
 }
 private job(scope:BookScope,id:string){const job=this.saved.jobs.find(row=>row.id===id&&same(row.scope,scope));if(!job)throw new BookError('not_found','工具任务不存在或属于其他会话。');return job;}
 private update(id:string,patch:Partial<BookToolJob>){const next=structuredClone(this.saved),job=next.jobs.find(row=>row.id===id)!;Object.assign(job,patch,{updatedAt:new Date().toISOString()});this.persist(next);return structuredClone(job);}
 async execute(scope:BookScope,id:string,confirmedHash:string,confirmed:boolean,signal:AbortSignal){
  const job=this.job(scope,id),profile=this.profile(job.profileId);if(job.state!=='prepared'||profile.revision!==job.profileRevision||confirmedHash!==job.hash||confirmed!==true)throw new BookError('conflict','需确认当前任务完整预览；旧审核、结果未知和已执行编号不能再次提交。');
  if(this.active.size>=2)throw new BookError('busy','工具并发达到2个。');signal.throwIfAborted();const controller=new AbortController(),bounded=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(60000)]);let finish!:()=>void;const done=new Promise<void>(resolve=>finish=resolve);this.active.set(id,{controller,done,finish});
  try{this.update(id,{state:'running'});}catch(error){this.active.delete(id);finish();throw error;}
  try{
   let result:unknown;
   if(profile.protocol==='acp'){
    const adapter=new AcpProtocolAdapter(undefined,undefined,undefined,{command:profile.command,args:profile.args,cwd:profile.cwd,requestTimeoutMs:50000,maxMessageBytes:1024*1024});
    const request:WorkRequest={operationId:job.id,revision:1,protocol:'acp',executorId:profile.id,executorRevision:profile.revision,target:{title:profile.label,directory:profile.cwd},instruction:job.instruction,permissionGrant:job.grants,requestedAt:job.createdAt};try{result=await adapter.dispatchTask(request,bounded);}finally{await adapter.close();}
    if((result as {status:string}).status!=='succeeded')throw new BookError('unavailable','ACP 执行未得到成功回执；不会自动重发。');
   }else result=await this.adapter(profile).callTool(job.toolName!,job.arguments,job.grants,bounded);
   bounded.throwIfAborted();const serialized=JSON.stringify(result);if(typeof serialized!=='string'||Buffer.byteLength(serialized)>1024*1024)throw new BookError('budget','工具回执无效或超过1 MiB；结果可能已经产生，禁止自动重发。');
   if(result&&typeof result==='object'&&(result as {isError?:boolean}).isError===true)return this.update(id,{state:'failed',result:serialized,error:'工具返回失败回执；未自动重试。'});
   return this.update(id,{state:'succeeded',result:serialized,error:null});
  }catch(error){this.update(id,{state:'unknown',error:'工具调用已开始但未能确认完整结果；取消/网络错误不代表远端操作已撤回。未自动重发。'});if(error instanceof BookError)throw error;throw new BookError('unavailable','工具执行回执未确认。请在工具端核对；没有自动重试。',{cause:error});}finally{this.active.delete(id);finish();}
 }
 cancel(scope:BookScope,id:string){const job=this.job(scope,id);if(job.state==='prepared')return this.update(id,{state:'cancelled'});if(job.state==='running'){this.active.get(id)?.controller.abort();return this.update(id,{state:'unknown',error:'已停止本地等待，远端结果未知。'});}return structuredClone(job);}
 async close(){const active=[...this.active.values()];for(const row of active)row.controller.abort();await Promise.all([...this.mcp.values()].map(adapter=>adapter.close()));await Promise.all(active.map(row=>row.done));this.mcp.clear();this.closed=true;}
}

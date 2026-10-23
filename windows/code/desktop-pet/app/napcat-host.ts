import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,resolve,relative,sep} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import QRCode from 'qrcode';
import {BookError} from '../contracts/memory-book.js';
import type {NapcatHostSettings,NapcatHostView} from '../contracts/napcat-host.js';
import type {QqChannelConfig} from '../contracts/book-channel.js';
import type {BookCredentials} from '../management/book-credentials.js';
import {qqId} from '../memory/channel-publication.js';
import {restrictPrivatePathSync} from '../core/platform-files.js';
import {replaceResourceFile} from '../memory/resource-atomic-replace.js';

const run=promisify(execFile);
type Installation={root:string;executable:string;configDirectory:string};
function readJson(file:string):any {
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw new BookError('invalid_input','NapCat 配置文件无效。');
  try{return JSON.parse(readFileSync(file,'utf8'));}catch{throw new BookError('invalid_input','NapCat 配置不是有效 JSON。');}
}
function installation(input:string):Installation {
  if(typeof input!=='string'||!isAbsolute(input)||/[\r\n\0]/.test(input))throw new BookError('invalid_input','请填写 NapCat 独立安装目录的绝对路径。');
  const root=resolve(input);
  if(realpathSync(root).toLowerCase()!==root.toLowerCase())throw new BookError('invalid_input','NapCat 安装目录不能通过符号链接跳转。');
  const executable=join(root,'NapCatWinBootMain.exe'),versions=join(root,'versions');
  const candidates=readdirSync(versions,{withFileTypes:true}).filter(row=>row.isDirectory()).map(row=>join(versions,row.name,'resources','app','napcat')).filter(path=>existsSync(join(path,'napcat.mjs'))&&existsSync(join(path,'config','webui.json')));
  if(candidates.length!==1||!existsSync(executable)||lstatSync(executable).isSymbolicLink()||!lstatSync(executable).isFile())throw new BookError('invalid_input','需要一个完整的 NapCat Windows 独立安装，且只有一个有效版本。');
  for(const path of [executable,candidates[0]!]){const rel=relative(root,realpathSync(path));if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new BookError('invalid_input','NapCat 文件必须位于指定安装目录中。');}
  return {root,executable,configDirectory:join(candidates[0]!,'config')};
}
const processScript=String.raw`
$ErrorActionPreference='Stop'
$root=$env:ALLMIND_NAPCAT_ROOT
$exe=[IO.Path]::Combine($root,'NapCatWinBootMain.exe')
$items=@(Get-CimInstance Win32_Process)
$owned=@($items | Where-Object { $_.ExecutablePath -eq $exe -or $_.ExecutablePath -eq [IO.Path]::Combine($root,'QQ.exe') -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith([IO.Path]::Combine($root,'versions')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($_.ExecutablePath) -eq 'QQ.exe') })
if ($env:ALLMIND_NAPCAT_ACTION -eq 'stop') {
  $targets=[Collections.Generic.List[object]]::new()
  foreach($item in $owned){$targets.Add($item)}
  for($i=0;$i -lt $targets.Count;$i++){
    foreach($child in $items){
      if($child.ParentProcessId -eq $targets[$i].ProcessId -and $child.ExecutablePath -and $child.ExecutablePath.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and -not ($targets.ProcessId -contains $child.ProcessId)){$targets.Add($child)}
    }
  }
  for($i=$targets.Count-1;$i -ge 0;$i--){
    $item=$targets[$i]
    $live=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$item.ProcessId)
    if($live -and $live.CreationDate -eq $item.CreationDate -and $live.ExecutablePath -eq $item.ExecutablePath){Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop}
  }
}
ConvertTo-Json -InputObject @{count=$owned.Count} -Compress
`;
async function processes(install:Installation,action:'status'|'stop'){
  if(process.platform!=='win32')throw new BookError('unavailable','NapCat 进程管理目前仅支持 Windows。');
  try{
    const {stdout}=await run(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(processScript,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,env:{...process.env,ALLMIND_NAPCAT_ROOT:install.root,ALLMIND_NAPCAT_ACTION:action}});
    return Number(JSON.parse(stdout).count);
  }catch{throw new BookError('unavailable','无法核对或停止指定目录的 NapCat 进程；未操作其他 QQ。');}
}

/** Explicit local lifecycle only. No automatic installation, account adoption or external messaging. */
export class NapcatHostManager {
  private settings:NapcatHostSettings|null=null;
  private busy=false;
  private authorization:{credential:string;until:number}|null=null;
  private authenticating:Promise<string>|null=null;
  private readonly file:string;
  constructor(private readonly options:{directory:string;credentials:BookCredentials;channel:()=>QqChannelConfig;channelBusy?:()=>boolean;processes?:typeof processes;launch?:(install:Installation)=>Promise<void>}){
    this.file=join(options.directory,'napcat-host.json');
    if(existsSync(this.file)){
      const value=readJson(this.file);this.validateSettings(value);this.settings=value;
    }
  }
  get processing(){return this.busy;}
  private validateSettings(value:NapcatHostSettings){
    if(!value||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.installDirectory!=='string'||!Number.isSafeInteger(value.webuiPort)||value.webuiPort<1024||value.webuiPort>65535||!/^napcat-webui-[a-f0-9-]+$/.test(value.credentialId))throw new BookError('corrupt_data','NapCat 本地设置无效。');
  }
  private requireSettings(){if(!this.settings)throw new BookError('invalid_input','请先连接已安装的 NapCat。');return this.settings;}
  private async exclusive<T>(work:()=>Promise<T>){if(this.busy)throw new BookError('busy','NapCat 操作尚未结束。');this.busy=true;try{return await work();}finally{this.busy=false;}}
  private stopped(){if(this.options.channelBusy?.()||this.options.channel().enabled)throw new BookError('busy','请先停止 QQ 自动回复通道，再修改 NapCat 或账号。');}
  private async request(path:string,data:object,credential?:string):Promise<any>{
    const settings=this.requireSettings();let response:Response;
    if(credential&&this.authorization?.credential!==credential)throw new BookError('conflict','NapCat 授权已变化，请重新读取状态。');
    try{response=await fetch(`http://127.0.0.1:${settings.webuiPort}/api/`+path,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:JSON.stringify(data),signal:AbortSignal.timeout(5000)});}catch{throw new BookError('unavailable','NapCat WebUI 无法连接或请求超时，请检查启动状态和端口。');}
    if(!response.ok||!response.body){if(response.status===401||response.status===403)this.authorization=null;throw new BookError('unavailable','NapCat WebUI 返回 HTTP '+response.status+'。');}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536)throw new BookError('unavailable','NapCat 响应超过允许大小。');chunks.push(part.value);}}finally{await reader.cancel();}
    let result:any;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new BookError('unavailable','NapCat 响应不是有效 JSON。');}
    if(this.settings!==settings)throw new BookError('conflict','NapCat 设置已变化，忽略旧安装返回的状态。');
    if(result?.code!==0){this.authorization=null;throw new BookError('unavailable',path==='auth/login'?'NapCat WebUI 授权失败，请重新连接安装目录。':'NapCat 操作被拒绝（'+path+'）；请回读状态，不自动重试。');}
    return result.data;
  }
  private async authenticate():Promise<string>{
    if(this.authorization&&this.authorization.until>Date.now())return this.authorization.credential;
    if(this.authenticating)return this.authenticating;
    this.authenticating=(async()=>{const settings=this.requireSettings(),token=await this.options.credentials.get(settings.credentialId);if(this.settings!==settings)throw new BookError('conflict','NapCat 设置已变化，请回读。');const value=await this.request('auth/login',{hash:createHash('sha256').update(token+'.napcat').digest('hex')});if(typeof value?.Credential!=='string')throw new BookError('unavailable','NapCat 未返回有效授权。');this.authorization={credential:value.Credential,until:Date.now()+240000};return value.Credential as string;})();
    try{return await this.authenticating;}finally{this.authenticating=null;}
  }
  async view():Promise<NapcatHostView>{
    const config=this.settings;
    const view:NapcatHostView={revision:config?.revision??0,installDirectory:config?.installDirectory??'',webuiPort:config?.webuiPort??6099,configured:!!config,reachable:false,online:false,accountId:null,nickname:'',accountMatches:false,phase:'stopped',error:null};
    if(!config)return view;
    try{
      const credential=await this.authenticate(),status=await this.request('QQLogin/CheckLoginStatus',{},credential);view.reachable=true;view.phase=typeof status?.loginPhase==='string'?status.loginPhase:'unknown';
      if(status?.isLogin===true){const info=await this.request('QQLogin/GetQQLoginInfo',{},credential);view.accountId=qqId(info.uin);view.nickname=typeof info.nick==='string'?info.nick.slice(0,100):'';view.online=info.online===true;view.accountMatches=view.online&&view.accountId===this.options.channel().selfId;if(!view.accountMatches)view.error='登录账号与机器人 QQ 号不一致，不能启用回复。';}
      else if(status?.isOffline===true)view.error='QQ 已离线，请重新登录。';
    }catch(error){view.error=error instanceof BookError?error.message:'NapCat 状态校验失败。';}
    return view;
  }
  async configure(input:{installDirectory:string},expectedRevision:number){return this.exclusive(async()=>{
    this.stopped();if(expectedRevision!==(this.settings?.revision??0))throw new BookError('conflict','NapCat 设置已变化，请回读。');
    const install=installation(input?.installDirectory),web=readJson(join(install.configDirectory,'webui.json'));
    if(web.host!=='127.0.0.1'||typeof web.token!=='string'||!web.token||!Number.isSafeInteger(web.port)||web.port<1024||web.port>65535)throw new BookError('invalid_input','NapCat WebUI 必须绑定 127.0.0.1，且配置有效端口和 token。');
    const next:NapcatHostSettings={revision:(this.settings?.revision??0)+1,installDirectory:install.root,webuiPort:web.port,credentialId:'napcat-webui-'+randomUUID()};
    this.options.credentials.save(next.credentialId,web.token);mkdirSync(this.options.directory,{recursive:true});restrictPrivatePathSync(this.options.directory);
    const temp=this.file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(next)+'\n',{flag:'wx',mode:0o600});restrictPrivatePathSync(temp);replaceResourceFile(temp,this.file);this.settings=next;this.authorization=null;return this.view();
  });}
  async qr(refresh:boolean){return this.exclusive(async()=>{
    this.stopped();const credential=await this.authenticate();const data=await this.request('QQLogin/'+(refresh?'RefreshQRcode':'GetQQLoginQrcode'),{},credential);
    const value=refresh?data?.qrcodeurl:data?.qrcode;
    if(typeof value!=='string'||value.length>4096)throw new BookError('unavailable','NapCat 二维码尚未就绪，请稍后刷新。');
    const url=new URL(value);if(url.protocol!=='https:'||!(url.hostname==='qq.com'||url.hostname.endsWith('.qq.com')))throw new BookError('unavailable','NapCat 返回的二维码不是 QQ 登录地址。');
    return {image:await QRCode.toDataURL(value,{width:256,margin:2}),expiresHint:'二维码仅用于当前登录，请用机器人账号扫码；过期后手动刷新。'};
  });}
  async switchAccount(){return this.exclusive(async()=>{
    this.stopped();const credential=await this.authenticate();await this.request('QQLogin/SetQuickLoginQQ',{uin:''},credential);await this.request('QQLogin/RestartNapCat',{},credential);return {restarting:true};
  });}
  async start(){return this.exclusive(async()=>{
    this.stopped();const install=installation(this.requireSettings().installDirectory);
    if(await (this.options.processes??processes)(install,'status'))return this.view();
    if(this.options.launch)await this.options.launch(install);
    else {
      if(process.platform!=='win32')throw new BookError('unavailable','NapCat 启动目前仅支持 Windows。');
      const child=spawn(install.executable,[],{cwd:install.root,windowsHide:true,detached:true,stdio:'ignore'});
      await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new BookError('unavailable','NapCat 启动失败。')));});child.unref();
    }
    return {starting:true};
  });}
  async stop(){return this.exclusive(async()=>{this.stopped();const count=await (this.options.processes??processes)(installation(this.requireSettings().installDirectory),'stop');return {stopped:true,count};});}
  async prepareBridge(){return this.exclusive(async()=>{
    this.stopped();const install=installation(this.requireSettings().installDirectory);
    if(await (this.options.processes??processes)(install,'status'))throw new BookError('busy','请先停止 NapCat，再写入反向连接配置。');
    const config=this.options.channel();qqId(config.selfId);if(!config.tokenCredentialId)throw new BookError('invalid_input','请先保存 QQ 通道的 access token。');
    const token=await this.options.credentials.get(config.tokenCredentialId);
    const file=join(install.configDirectory,'onebot11_'+config.selfId+'.json'),previous=existsSync(file)?readJson(file):{};
    const url=`ws://127.0.0.1:${config.port}/onebot/v11/ws`,network=previous.network??{},clients=network.websocketClients??[];
    if(!Array.isArray(clients))throw new BookError('invalid_input','NapCat 网络配置格式无效。');
    const retained=clients.filter((row:any)=>row.name!=='ALLMIND-local');
    if(retained.some((row:any)=>row.enable===true))throw new BookError('conflict','NapCat 已有其他启用的反向连接，请先在 NapCat 中核对，未覆盖。');
    const next={...previous,network:{...network,websocketClients:[...retained,{name:'ALLMIND-local',enable:true,url,token,messagePostFormat:'array',reportSelfMessage:false,reconnectInterval:5000,heartInterval:30000,debug:false}]}};
    const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});restrictPrivatePathSync(temp);replaceResourceFile(temp,file);return {prepared:true};
  });}
}

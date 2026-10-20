import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {existsSync,readFileSync,writeFileSync,mkdirSync,unlinkSync,openSync,closeSync,createWriteStream,statSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import {restrictPrivatePathSync,isPrivateFileSync} from '../../dist/core/platform-files.js';
import {createWpfPipe,pipeRequest,validateVisibility} from './pipe.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const data=resolve(option('--data',join(process.env.LOCALAPPDATA??root,'ALLMIND'))),shellRoot=resolve(option('--shell-root',join(root,'wpf-shell')));
const hostData=join(data,'host'),bookData=join(data,'book');mkdirSync(hostData,{recursive:true});mkdirSync(bookData,{recursive:true});restrictPrivatePathSync(data);restrictPrivatePathSync(hostData);
const lock=join(hostData,'controller.json');
if(existsSync(lock)){
 if(!isPrivateFileSync(lock))throw Error('运行控制文件权限无效。');const previous=JSON.parse(readFileSync(lock,'utf8'));
 try{process.kill(previous.pid,0);}catch(error){if(error.code!=='ESRCH')throw error;unlinkSync(lock);}
 if(existsSync(lock)){await pipeRequest(previous.endpoint,previous.token,'visible',{visible:true});process.stdout.write('ALLMIND existing instance restored.\n');process.exit(0);}
}
const instanceId=randomUUID(),token=randomBytes(32).toString('hex'),pipeName='ALLMIND-'+instanceId,endpoint='\\\\.\\pipe\\'+pipeName;
const descriptor={version:1,pid:process.pid,instanceId,endpoint,pipeName,token,dataDir:hostData,nodePath:process.execPath,appDir:shellRoot,product:'allmind',appVersion:'0.2.0-dev',automation:process.argv.includes('--native-test')};
const fd=openSync(lock,'wx',0o600);try{writeFileSync(fd,JSON.stringify(descriptor)+'\n');}finally{closeSync(fd);}restrictPrivatePathSync(lock);
const config=join(hostData,'widget-config.json');writeFileSync(config,JSON.stringify(descriptor)+'\n',{mode:0o600});restrictPrivatePathSync(config);
const log=createWriteStream(join(hostData,'runtime.log'),{flags:'a',mode:0o600});
let backend=null,widget=null,browser=null,browserReady=null,management=null,appearance=null,stopping=false,backendExpected=false,widgetExpected=false;
let state={instanceId,backend:'starting',characterId:null,characterLabel:'ALLMIND',sessionId:'desktop',hidden:true,visibility:null,capabilities:{staticPortrait:true,live2d:false,chatgptWeb:true}};
let presence={hidden:true,dnd:true};
const pendingBrowser=new Map();
const sendBackend=value=>{if(backend?.stdin.writable)backend.stdin.write(JSON.stringify(value)+'\n');else throw Error('后台尚未就绪。');};
const publish=value=>pipe.publish(value);
function publicState(){return {...state,managementOrigin:management?.origin??null};}
async function readManagement(){
 const file=join(bookData,'management-session.json');if(!isPrivateFileSync(file))throw Error('管理会话权限无效。');const value=JSON.parse(readFileSync(file,'utf8'));const url=new URL(value.url);if(value.pid!==backend.pid||url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw Error('管理会话不属于当前后台。');management={origin:url.origin};
}
function sync(){publish({channel:'wpf_state',state:publicState()});if(appearance)publish(appearance);}
function fail(error){log.write('[host] '+String(error.stack??error)+'\n');state={...state,backend:'failed',error:error.message};publish({channel:'wpf_state',state:publicState()});}
async function browserRequest(request){
 if(!browser){
  const electron=createRequire(import.meta.url)('electron');
  browser=spawn(electron,[join(root,'desktop/wpf/browser-host.mjs'),'--data',join(data,'chatgpt')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});browser.stderr.pipe(log,{end:false});
  const child=browser;browserReady=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('网页辅助宿主启动超时。')),20000);child.once('error',reject);const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{const message=JSON.parse(line);if(message.ready){clearTimeout(timer);resolve();return;}const waiter=pendingBrowser.get(message.requestId);if(waiter){clearTimeout(waiter.timer);pendingBrowser.delete(message.requestId);message.ok?waiter.resolve(message.value):waiter.reject(Error(message.error));}}catch{log.write('[browser] Invalid protocol output.\n');}});child.once('exit',()=>{clearTimeout(timer);browser=null;reject(Error('网页辅助宿主已关闭。'));for(const item of pendingBrowser.values()){clearTimeout(item.timer);item.reject(Error('网页宿主已断开，请核对请求状态。'));}pendingBrowser.clear();});});
 }
 await browserReady;
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingBrowser.delete(request.requestId);reject(Error('网页宿主请求超时，结果需要核对。'));},70000);pendingBrowser.set(request.requestId,{resolve,reject,timer});browser.stdin.write(JSON.stringify({requestId:request.requestId,params:request.params})+'\n');});
}
async function backendMessage(message){
 if(message.channel==='backend_ready'){
  state={...state,backend:'ready',characterId:message.characterId,characterLabel:message.characterLabel,sessionId:message.sessionId,backendInstanceId:message.backendInstanceId,error:null};await readManagement();sendBackend({channel:'companion_presence',...presence});sync();return;
 }
 if(message.channel==='appearance'){
  const file=message.routes?.find(row=>row[0]===message.manifest?.modelEntry)?.[1];
  if(message.manifest?.type!=='sprite'||message.manifest?.sprite?.frameCount!==1||typeof file!=='string'||!existsSync(file)||statSync(file).size>20*1024*1024){sendBackend({channel:'rpc_error',requestId:message.requestId,message:'WPF宿主当前仅支持单帧本地静态图片，保留原形象。'});publish({channel:'wpf_error',message:'该形象不适用于静态 WPF 宿主。'});return;}
  appearance={channel:'wpf_appearance',requestId:message.requestId,characterId:state.characterId,skinId:message.manifest.skinId,path:file};publish(appearance);return;
 }
 if(message.channel==='host_request'){
  if(message.method!=='chatgpt-page'){sendBackend({channel:'host_reply',requestId:message.requestId,error:{code:'unsupported',message:'此 WPF 宿主尚不支持该原生操作，请使用角色页的文件上传入口。'}});return;}
  try{const result=await browserRequest(message);sendBackend({channel:'host_reply',requestId:message.requestId,ok:true,result});}catch(error){sendBackend({channel:'host_reply',requestId:message.requestId,error:{code:'unavailable',message:error.message}});}return;
 }
 if(message.channel==='companion_takeover'&&message.phase==='prepare'){sendBackend({channel:'companion_takeover',characterId:state.characterId,stopped:true,lastShownAt:0,previouslyEnabled:false});return;}
 publish({...message,hostReceivedAt:Date.now()});
}
function startBackend(){
 management=null;appearance=null;state={...state,backend:'starting',error:null};publish({channel:'wpf_state',state:publicState()});backendExpected=false;
 const child=spawn(process.execPath,[join(root,'dist/app/book-backend.js')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,AIKI_BOOK_DATA:bookData,AIKI_BOOK_PORT:'0',AIKI_BOOK_WEB_ONLY:'0',AIKI_WPF_HOST:'1'}});backend=child;child.stderr.pipe(log,{end:false});createInterface({input:child.stdout}).on('line',line=>{try{void backendMessage(JSON.parse(line)).catch(fail);}catch{fail(Error('后台返回非法协议消息。'));}});child.on('error',fail);child.once('exit',(code)=>{if(!stopping&&!backendExpected)fail(Error('后台进程已退出（'+code+'），请在菜单中重新启动后台；未知请求不会重发。'));});
}
async function stopChild(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();},12000);const final=setTimeout(resolve,15000);child.once('exit',()=>{clearTimeout(timer);clearTimeout(final);resolve();});child.stdin?.end();});}
async function shutdown(){
 if(stopping)return;stopping=true;publish({channel:'wpf_shutdown'});backendExpected=true;widgetExpected=true;await Promise.all([stopChild(backend),stopChild(browser)]);if(widget)await new Promise(resolve=>{if(widget.exitCode!==null)return resolve();const t=setTimeout(()=>{widget.kill();resolve();},5000);widget.once('exit',()=>{clearTimeout(t);resolve();});});await pipe.close();for(const file of [lock,config])if(existsSync(file)&&JSON.parse(readFileSync(file,'utf8')).instanceId===instanceId)unlinkSync(file);log.end();
}
const pipe=createWpfPipe({endpoint,token,onConnect:sync,onDisconnect:()=>{state={...state,hidden:true,visibility:null};presence={hidden:true,dnd:true};if(!stopping&&state.backend==='ready'&&backend?.stdin.writable)sendBackend({channel:'companion_presence',...presence});},async onCommand(request){
 const p=request.params??{};
 switch(request.method){
  case 'state':return publicState();
  case 'visible':if(typeof p.visible!=='boolean')throw Error('显示参数无效。');publish({channel:'wpf_visible',visible:p.visible});return {accepted:true,requestedVisible:p.visible,effectiveVisible:state.visibility?.visible??false,revision:state.visibility?.revision??null};
  case 'exit':setTimeout(()=>void shutdown(),50);return {exiting:true};
  case 'open':{const routes={chat:'/chat',character:'/character',memory:'/memory-book',settings:'/settings'};const route=Object.hasOwn(routes,p.target)?routes[p.target]:null;if(!route||state.backend!=='ready'||!management)throw Error('后台尚未就绪，请稍后重试。');const url=management.origin+route;const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});opener.on('error',fail);return {opened:true};}
  case 'appearance-result':if(!appearance||p.requestId!==appearance.requestId||p.characterId!==state.characterId)throw Error('形象请求已经过期。');if(p.ok===true){sendBackend({channel:'ack',requestId:p.requestId});state={...state,appearanceSkinId:appearance.skinId};}else sendBackend({channel:'rpc_error',requestId:p.requestId,message:'WPF 未能解码该图片，保留原形象。'});return {accepted:true};
  case 'presence':{const visibility=validateVisibility(p.visibility);if(state.visibility&&visibility.revision<state.visibility.revision)throw Error('窗口状态已过期。');state={...state,visibility,hidden:!visibility.visible};presence={hidden:!visibility.visible,dnd:p.dnd===true||!visibility.notificationAllowed};if(state.backend==='ready')sendBackend({channel:'companion_presence',...presence});return {accepted:true,revision:visibility.revision,effectiveVisible:visibility.visible};}
  case 'companion-action':if(!['set_enabled','set_quiet'].includes(p.action)||typeof p.enabled!=='boolean'||p.characterId!==state.characterId)throw Error('陪伴操作无效。');sendBackend({channel:'companion_action',characterId:state.characterId,pairingId:'local-user',action:p.action,enabled:p.enabled});return {accepted:true};
  case 'claim':if(!state.visibility?.notificationAllowed||p.characterId!==state.characterId||p.sessionId!==state.sessionId||typeof p.id!=='string')throw Error('主动消息范围或窗口状态无效。');sendBackend({channel:'companion_claim',id:p.id,characterId:p.characterId,sessionId:p.sessionId});return {accepted:true};
  case 'restart-backend':if(state.backend!=='failed')throw Error('后台仍在运行，不能重复启动。');backendExpected=true;await stopChild(backend);startBackend();return {restarting:true};
  default:throw Error('未知操作。');
 }
}});
try{
 await pipe.listen();startBackend();
 if(!process.argv.includes('--no-widget')){
  const script=join(shellRoot,'widget.ps1');if(!existsSync(script))throw Error('没有找到 GPT-Niang WPF 源码，请用 --shell-root 指定 gpt-niang-usage 目录。');
  const native=join(shellRoot,'bin/ALLMIND.Widget.exe');if(!existsSync(native))throw Error('请先运行 runtime/build-allmind-host.ps1 构建 WPF 宿主。');
  widget=spawn(native,[config],{windowsHide:true,stdio:['ignore','pipe','pipe']});widget.stdout.pipe(log,{end:false});widget.stderr.pipe(log,{end:false});widget.on('error',error=>{fail(error);void shutdown();});widget.once('exit',code=>{if(!stopping&&!widgetExpected){if(code)process.exitCode=code;void shutdown();}});
 }
 process.stdout.write('ALLMIND WPF controller ready.\n');
}catch(error){fail(error);await shutdown();process.exitCode=1;}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());

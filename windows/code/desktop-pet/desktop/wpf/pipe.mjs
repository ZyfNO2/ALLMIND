import net from 'node:net';
import {timingSafeEqual,randomUUID} from 'node:crypto';

export const WPF_PROTOCOL_VERSION=1;
const methods=new Set(['hello','state','open','visible','exit','appearance-result','presence','companion-action','restart-backend','claim']);
export function validateVisibility(value){
 if(!value||!Number.isSafeInteger(value.revision)||value.revision<1||!['VISIBLE','HIDDEN','SUSPENDED','EXITING'].includes(value.state)||!['smart','resident','normal'].includes(value.mode)||!Array.isArray(value.reasons)||value.reasons.length>10||value.reasons.some(reason=>!['exiting','session-unknown','session-unavailable','power-suspended','manual','presentation','fullscreen','detector-degraded'].includes(reason)))throw Error('窗口状态无效。');
 for(const field of ['visible','manualHidden','topmost','notificationAllowed'])if(typeof value[field]!=='boolean')throw Error('窗口状态字段无效。');
 if(value.visible&&value.state!=='VISIBLE'||value.notificationAllowed&&!value.visible)throw Error('窗口状态相互矛盾。');
 return {revision:value.revision,state:value.state,mode:value.mode,visible:value.visible,manualHidden:value.manualHidden,topmost:value.topmost,notificationAllowed:value.notificationAllowed,reasons:[...value.reasons]};
}
export function createWpfPipe({endpoint,token,onCommand,onConnect,onDisconnect}){
 const sockets=new Set();let active=null;
 const send=(socket,value)=>{if(!socket.destroyed)socket.write(JSON.stringify({version:WPF_PROTOCOL_VERSION,...value})+'\n');};
 const server=net.createServer(socket=>{
  sockets.add(socket);let buffer='',authenticated=false;socket.setEncoding('utf8');socket.setTimeout(10000,()=>{if(!authenticated)socket.destroy();});
  socket.on('error',()=>{});socket.on('close',()=>{sockets.delete(socket);if(active===socket){active=null;onDisconnect?.();}});
  socket.on('data',chunk=>{
   buffer+=chunk;if(Buffer.byteLength(buffer)>262144){socket.destroy();return;}
   for(let index;(index=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let request;try{request=JSON.parse(line);}catch{socket.destroy();return;}
    if(!request||request.version!==WPF_PROTOCOL_VERSION||typeof request.id!=='string'||!/^[a-zA-Z0-9-]{1,96}$/.test(request.id)||!methods.has(request.method)){socket.destroy();return;}
    if(!authenticated){const supplied=Buffer.from(typeof request.token==='string'?request.token:''),expected=Buffer.from(token);if(request.method!=='hello'||!['widget','control'].includes(request.client)||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)||(request.client==='widget'&&active)){socket.destroy();return;}authenticated=true;if(request.client==='widget'){active=socket;}socket.setTimeout(0);send(socket,{id:request.id,ok:true});if(request.client==='widget')onConnect?.();continue;}
    if(request.method==='hello'){socket.destroy();return;}
    Promise.resolve().then(()=>onCommand(request)).then(value=>send(socket,{id:request.id,ok:true,value}),error=>send(socket,{id:request.id,ok:false,error:error.message??'宿主操作失败。'}));
   }
  });
 });
 return {async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});},publish(value){if(active)send(active,{event:value});},get connected(){return !!active;},async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
export function pipeRequest(endpoint,token,method,params={}){
 return new Promise((resolve,reject)=>{const socket=net.connect(endpoint),hello=randomUUID(),id=randomUUID();let buffer='';const timer=setTimeout(()=>{socket.destroy();reject(Error('桌宠实例未响应。'));},5000);socket.setEncoding('utf8');socket.on('error',error=>{clearTimeout(timer);reject(error);});socket.on('connect',()=>socket.write(JSON.stringify({version:1,id:hello,method:'hello',token,client:'control'})+'\n'));socket.on('data',chunk=>{buffer+=chunk;for(let end;(end=buffer.indexOf('\n'))>=0;){const result=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(result.id===hello&&result.ok)socket.write(JSON.stringify({version:1,id,method,params})+'\n');if(result.id===id){clearTimeout(timer);socket.end();result.ok?resolve(result.value):reject(Error(result.error));}}});});
}

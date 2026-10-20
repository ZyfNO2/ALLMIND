import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';

// Windows GUI Electron does not reliably inherit stdin. Keep its lifetime and
// request protocol on a dedicated capability-authenticated named pipe instead.
export async function startBrowserHost({executable,script,data,onDiagnostic=()=>{}}){
 const endpoint='\\\\.\\pipe\\ALLMIND-Browser-'+randomUUID(),token=randomBytes(32).toString('hex');
 const pending=new Map(),sockets=new Set();let active,child,closed=false,resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
 const fail=error=>{rejectReady(error);for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}pending.clear();};
 const server=net.createServer(socket=>{
  sockets.add(socket);let buffer='',authenticated=false;socket.setEncoding('utf8');socket.setTimeout(5000,()=>socket.destroy());
  socket.on('error',()=>socket.destroy());socket.on('close',()=>{sockets.delete(socket);if(active===socket){active=null;fail(Error('网页宿主已断开，请核对请求状态。'));}});
  socket.on('data',chunk=>{
   buffer+=chunk;if(buffer.length>16*1024*1024){socket.destroy();return;}
   for(let end;(end=buffer.indexOf('\n'))>=0;){
    let message;try{message=JSON.parse(buffer.slice(0,end));}catch{socket.destroy();return;}buffer=buffer.slice(end+1);
    if(!authenticated){
     const supplied=Buffer.from(typeof message?.token==='string'?message.token:''),expected=Buffer.from(token);
     if(message?.ready!==true||active||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){socket.destroy();return;}
     authenticated=true;active=socket;socket.setTimeout(0);clearTimeout(startTimer);resolveReady();continue;
    }
    const waiter=pending.get(message?.requestId);if(!waiter)continue;
    clearTimeout(waiter.timer);pending.delete(message.requestId);message.ok===true?waiter.resolve(message.value):waiter.reject(Error(message.error??'网页宿主操作失败。'));
   }
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
 const startTimer=setTimeout(()=>{fail(Error('网页辅助宿主启动超时。'));void close();},20000);
 const env={...process.env,ALLMIND_BROWSER_PIPE:endpoint,ALLMIND_BROWSER_TOKEN:token};delete env.ELECTRON_RUN_AS_NODE;
 child=spawn(executable,[script,'--data',data],{windowsHide:true,env,stdio:['ignore','ignore','pipe']});
 child.stderr.on('data',chunk=>onDiagnostic(String(chunk)));
 child.on('error',error=>{closed=true;clearTimeout(startTimer);fail(error);for(const socket of sockets)socket.destroy();server.close();});
 child.once('exit',()=>{closed=true;clearTimeout(startTimer);fail(Error('网页辅助宿主已关闭，请重新打开登录页。'));for(const socket of sockets)socket.destroy();server.close();});
 async function close(){
  clearTimeout(startTimer);if(active)active.end();else if(child?.exitCode===null)child.kill();
  if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));closed=true;
 }
 return {get closed(){return closed;},async request(requestId,params){
  await ready;if(!active||closed)throw Error('网页宿主已断开，请重新打开登录页。');
  if(pending.has(requestId))throw Error('网页请求标识重复。');
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('网页宿主请求超时，结果需要核对。'));},70000);pending.set(requestId,{resolve,reject,timer});active.write(JSON.stringify({requestId,params})+'\n');});
 },close};
}

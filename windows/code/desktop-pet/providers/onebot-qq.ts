import {createServer, type Server} from 'node:http';
import {randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import {BookError} from '../contracts/memory-book.js';
import type {QqIncomingMessage} from '../contracts/book-channel.js';
import {qqId} from '../memory/channel-publication.js';
import {validateIdentity} from '../memory/book-validation.js';

const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new BookError('invalid_input','OneBot 数据必须为对象。');return value as Record<string,unknown>;};
function messageId(value:unknown):string{
  if(typeof value==='number'){if(!Number.isSafeInteger(value))throw new BookError('invalid_input','OneBot 消息ID不是安全整数。');value=String(value);}
  if(typeof value!=='string'||! /^-?\d{1,32}$/.test(value))throw new BookError('invalid_input','OneBot 消息ID无效。');return value;
}
export function normalizeQqEvent(value:unknown,config:{connectorId:string;selfId:string;privateIds:string[];groupIds:string[]}):QqIncomingMessage|null {
  const event=object(value);if(event.post_type!=='message')return null;
  if(qqId(event.self_id)!==config.selfId)throw new BookError('conflict','OneBot 事件账号不匹配。');
  const senderId=qqId(event.user_id);if(senderId===config.selfId)return null;
  if(event.message_type!=='private'&&event.message_type!=='group')return null;
  const kind=event.message_type;
  // Temporary group-origin private messages are not an authorized friend conversation.
  if(kind==='private'&&event.sub_type!=='friend')return null;
  if(kind==='group'&&event.anonymous)return null;
  const targetId=kind==='private'?senderId:qqId(event.group_id);
  if(!(kind==='private'?config.privateIds:config.groupIds).includes(targetId))return null;
  if(!Array.isArray(event.message)||event.message.length>128)throw new BookError('invalid_input','OneBot 首版只接受最多128段的消息数组。');
  let text='',mentionsSelf=false,hasUnsupportedMedia=false;
  for(const raw of event.message){
    const segment=object(raw),data=object(segment.data);
    if(segment.type==='text'){
      if(typeof data.text!=='string'||data.text.includes('\0'))throw new BookError('invalid_input','OneBot 文本无效。');text+=data.text;
    }else if(segment.type==='at'){
      if(data.qq!=='all'&&qqId(data.qq)===config.selfId)mentionsSelf=true;
    }else if(segment.type!=='reply')hasUnsupportedMedia=true;
    if(text.length>16000)throw new BookError('budget','QQ 消息超过16000字符。');
  }
  if(!text.trim()&&!hasUnsupportedMedia||kind==='group'&&!mentionsSelf)return null;
  if(!text.trim())text='[收到暂不支持的媒体；未读取内容]';
  const sender=event.sender&&typeof event.sender==='object'&&!Array.isArray(event.sender)?event.sender as Record<string,unknown>:{};
  const display=typeof sender.card==='string'&&sender.card?sender.card:sender.nickname;
  const id=messageId(event.message_id);
  return {connectorId:config.connectorId,selfId:config.selfId,kind,targetId,senderId,messageId:id,senderName:typeof display==='string'?display.slice(0,100):senderId,text,mentionsSelf,hasUnsupportedMedia,
    eventKey:'qq-'+createHash('sha256').update(JSON.stringify([config.connectorId,config.selfId,kind,targetId,id])).digest('hex')};
}

interface Pending {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}
export interface OneBotQqOptions {
  connectorId:string;selfId:string;token:string;port:number;
  allowed:()=>{privateIds:string[];groupIds:string[]};
  onMessage:(message:QqIncomingMessage)=>Promise<void>;
  onError:(error:Error)=>void;
  actionTimeoutMs?:number;
}

/** Dedicated loopback listener. Construction is inert; start is always explicit. */
export class OneBotQqListener {
  private server:Server|null=null;
  private readonly wss=new WebSocketServer({noServer:true,maxPayload:128*1024,perMessageDeflate:false});
  private socket:WebSocket|null=null;
  private ready=false;
  private pending=new Map<string,Pending>();
  private heartbeat:ReturnType<typeof setInterval>|undefined;
  private online=false;
  constructor(private readonly options:OneBotQqOptions){
    validateIdentity(options.connectorId);qqId(options.selfId);
    if(!/^[A-Za-z0-9_-]{32,128}$/.test(options.token))throw new BookError('invalid_input','OneBot token须为32–128位随机字符。');
    if(!Number.isSafeInteger(options.port)||options.port<0||options.port>65535)throw new BookError('invalid_input','OneBot 端口无效。');
  }
  status(){return {listening:this.server?.listening===true,connected:this.socket?.readyState===WebSocket.OPEN,ready:this.ready};}
  async start():Promise<{url:string}>{
    if(this.server)throw new BookError('conflict','OneBot 已启动。');
    const server=createServer((_req,res)=>{res.writeHead(404);res.end();});this.server=server;
    server.on('upgrade',(request,socket,head)=>{
      const supplied=Buffer.from(request.headers.authorization??''),expected=Buffer.from('Bearer '+this.options.token);
      const auth=supplied.length===expected.length&&timingSafeEqual(supplied,expected);
      if(!auth||request.url!=='/onebot/v11/ws'||request.headers.origin||request.headers['x-self-id']!==this.options.selfId||request.headers['x-client-role']!=='Universal'||this.socket){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
      this.wss.handleUpgrade(request,socket,head,ws=>this.accept(ws));
    });
    try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.options.port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});}
    catch(error){this.server=null;throw error;}
    server.on('error',()=>this.options.onError(new BookError('unavailable','OneBot 监听服务出错。')));
    const address=server.address();if(!address||typeof address==='string')throw new BookError('unavailable','OneBot 未取得监听地址。');
    return {url:`ws://127.0.0.1:${address.port}/onebot/v11/ws`};
  }
  private accept(socket:WebSocket){
    this.socket=socket;this.ready=false;this.online=true;
    socket.on('pong',()=>{this.online=true;});
    socket.on('message',(data,binary)=>{
      try{
        if(binary)throw new BookError('invalid_input','OneBot 不接受二进制消息。');
        const value=object(JSON.parse(data.toString()));
        if(Object.hasOwn(value,'echo')){
          if(typeof value.echo!=='string')throw new BookError('invalid_input','OneBot echo无效。');
          const pending=this.pending.get(value.echo);if(!pending)return;
          clearTimeout(pending.timer);this.pending.delete(value.echo);
          if(value.status!=='ok'||value.retcode!==0)pending.reject(new BookError('unavailable','OneBot 动作被拒绝（retcode='+ (Number.isSafeInteger(value.retcode)?String(value.retcode):'invalid') +'）。'));
          else pending.resolve(value.data);return;
        }
        if(value.self_id!==undefined&&qqId(value.self_id)!==this.options.selfId)throw new BookError('conflict','OneBot 账号发生变化。');
        if(value.post_type==='meta_event'&&value.meta_event_type==='heartbeat'){
          const status=object(value.status);if(status.online===false||status.good===false)throw new BookError('unavailable','NapCat 账号已离线。');return;
        }
        if(!this.ready)return;
        const message=normalizeQqEvent(value,{connectorId:this.options.connectorId,selfId:this.options.selfId,...this.options.allowed()});
        if(message)void this.options.onMessage(message).catch(error=>{this.options.onError(new BookError('unavailable','QQ 入站处理失败，需在本机核对。',{cause:error}));});
      }catch(error){this.ready=false;this.options.onError(error instanceof BookError?error:new BookError('invalid_input','OneBot 数据解析失败。'));socket.close(1008,'Invalid OneBot event');}
    });
    socket.on('error',()=>this.options.onError(new BookError('unavailable','OneBot 连接发生错误。')));
    socket.on('close',()=>{if(this.socket!==socket)return;this.ready=false;this.socket=null;if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=undefined;
      for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new BookError('unavailable','OneBot 连接已断开；已发动作的结果未知，不自动重发。'));}this.pending.clear();
    });
    this.heartbeat=setInterval(()=>{if(!this.online){this.ready=false;socket.terminate();return;}this.online=false;socket.ping();},20000);this.heartbeat.unref();
    void this.verify(socket);
  }
  private async verify(socket:WebSocket){
    try{const login=object(await this.request('get_login_info',{},true)),status=object(await this.request('get_status',{},true));
      if(qqId(login.user_id)!==this.options.selfId||status.online!==true||status.good===false)throw new BookError('unavailable','NapCat 账号或在线状态未确认。');
      if(this.socket===socket&&socket.readyState===WebSocket.OPEN)this.ready=true;
    }catch{this.ready=false;this.options.onError(new BookError('unavailable','NapCat 账号核验失败；未启用消息接收。'));socket.close(1008,'Account verification failed');}
  }
  private request(action:string,params:Record<string,unknown>,checking=false):Promise<unknown>{
    const socket=this.socket;if(!socket||socket.readyState!==WebSocket.OPEN||!checking&&!this.ready)return Promise.reject(new BookError('unavailable','NapCat 未就绪，未发送。'));
    if(this.pending.size>=32)return Promise.reject(new BookError('budget','OneBot 动作队列已满。'));
    const echo=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(echo);reject(new BookError('unavailable','OneBot 动作回执超时，结果未知，不自动重发。'));},this.options.actionTimeoutMs??15000);
      this.pending.set(echo,{resolve,reject,timer});
      socket.send(JSON.stringify({action,params,echo}),error=>{if(error){const row=this.pending.get(echo);if(row){clearTimeout(row.timer);this.pending.delete(echo);row.reject(new BookError('unavailable','OneBot 发送未确认，需核对，不自动重发。'));}}});
    });
  }
  async send(message:QqIncomingMessage,text:string):Promise<{messageId:string}>{
    if(message.selfId!==this.options.selfId||message.connectorId!==this.options.connectorId)throw new BookError('conflict','QQ 投递账号不匹配。');
    const allowed=this.options.allowed();if(!(message.kind==='private'?allowed.privateIds:allowed.groupIds).includes(message.targetId))throw new BookError('conflict','QQ 目标授权已撤销，未发送。');
    if(typeof text!=='string'||!text.trim()||Array.from(text).length>1500||text.includes('\0'))throw new BookError('budget','QQ 单段发送须为1–1500字符。');
    const segments:unknown[]=[];
    if(message.kind==='group')segments.push({type:'reply',data:{id:message.messageId}},{type:'at',data:{qq:message.senderId}});
    segments.push({type:'text',data:{text}});
    const result=object(await this.request(message.kind==='private'?'send_private_msg':'send_group_msg',{[message.kind==='private'?'user_id':'group_id']:message.targetId,message:segments}));
    return {messageId:messageId(result.message_id)};
  }
  async close():Promise<void>{
    this.ready=false;if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=undefined;
    const socket=this.socket;if(socket){socket.terminate();await new Promise<void>(resolve=>{if(socket.readyState===WebSocket.CLOSED)resolve();else socket.once('close',()=>resolve());});}
    const server=this.server;this.server=null;if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
}

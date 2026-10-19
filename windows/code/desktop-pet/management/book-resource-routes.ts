import type { IncomingMessage, ServerResponse } from 'node:http';
import { BookError, type BookScope } from '../contracts/memory-book.js';
import type { BookRuntime } from '../app/book-runtime.js';
import { validateIdentity } from '../memory/book-validation.js';
export async function resourceRoute(request:IncomingMessage,response:ServerResponse,route:string,url:URL,scope:BookScope,runtime:BookRuntime,signal:AbortSignal,body:()=>Promise<Record<string,any>>):Promise<boolean>{
  if(!route.startsWith('/resources/')&&!route.startsWith('/artifact-deliveries/'))return false;
  const service=runtime.resources;
  const send=(value:unknown)=>{response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
  const operation=(value:unknown)=>{validateIdentity(value,'operationId');return value as string;};
  if(route==='/resources/list'&&request.method==='GET'){send({resources:service.list(scope)});return true;}
  if(route==='/resources/capabilities'&&request.method==='GET'){send({...runtime.resourceCapabilities(),limits:service.limits});return true;}
  if(route==='/resources/upload'&&request.method==='POST'){send(await service.receiveUpload(scope,{name:url.searchParams.get('name')??'',mime:String(request.headers['content-type']??'')},request,operation(url.searchParams.get('operationId')),signal));return true;}
  if(route==='/resources/from-url'&&request.method==='POST'){const data=await body();if(typeof data.url!=='string')throw new BookError('invalid_input','网址无效。');send(await service.captureUrl(scope,data.url,operation(data.operationId),signal));return true;}
  const match=/^\/(resources|artifact-deliveries)\/([a-zA-Z0-9._-]+)(?:\/(content|material|bundle-preview|revoke|retry|cancel))?$/.exec(route);
  if(!match)throw new BookError('not_found','资源接口不存在。');
  const [,owner,id,action]=match;validateIdentity(id);
  if(owner==='artifact-deliveries'){
    const delivery=service.getDelivery(scope,id!);
    if(request.method==='GET'&&!action){send({delivery,resources:delivery.resourceIds.map(key=>service.get(scope,key))});return true;}
    if(request.method==='POST'&&(action==='retry'||action==='cancel')){const data=await body();const op=operation(data.operationId);if(action==='cancel'){runtime.cancelArtifacts(id!);send(service.cancelReceive(scope,id!,data.expectedRevision,op));}else send(await runtime.retryArtifacts(scope,id!,data.resourceIds,data.expectedRevision,op,signal));return true;}
  }else{
    const record=service.get(scope,id!);
    if(request.method==='GET'&&!action){send(record);return true;}
    if(request.method==='GET'&&action==='content'){const bytes=await service.readBytes(scope,id!,signal);response.writeHead(200,{'Content-Type':record.mime!,'Content-Length':bytes.byteLength,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':(record.kind==='image'?'inline':'attachment')+`; filename="resource.${record.kind==='html'?'html':record.kind==='zip'?'zip':'bin'}"`});response.end(bytes);return true;}
    if(request.method==='GET'&&action==='material'){send(await service.readMaterial(scope,id!,signal));return true;}
    if(request.method==='POST'&&action==='bundle-preview'){send(await service.previewBundle(scope,id!,signal));return true;}
    if(request.method==='POST'&&action==='revoke'){const data=await body();send(service.revoke(scope,id!,data.expectedRevision,operation(data.operationId)));return true;}
  }
  throw new BookError('invalid_input','资源操作或方法无效。');
}

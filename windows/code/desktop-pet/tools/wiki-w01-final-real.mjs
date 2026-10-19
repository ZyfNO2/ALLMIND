// Drives the normal product API only. The product, not this runner, downloads web artifacts.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const directory='../../../docs/next/chatgpt-integration/wiki-handoff/evidence/w01';
mkdirSync(directory,{recursive:true});
const file=directory+'/final-real.json';
const previous=JSON.parse(readFileSync(directory+'/real-review.json','utf8'));
const management=new URL(JSON.parse(readFileSync('../../.local/memory-book/management-session.json','utf8')).url);
const headers={Authorization:'Bearer '+new URLSearchParams(management.hash.slice(1)).get('token'),'Content-Type':'application/json'};
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const report={sessionId:previous.sessionId,turnId:'w01-real-final-r3',startedAt:new Date().toISOString(),calls:[]};
const save=()=>writeFileSync(file,JSON.stringify(report,null,2));
const api=async(path,body)=>{const response=await fetch(management.origin+'/api/memory-book/v1'+path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),signal:AbortSignal.timeout(330000)});const result=await response.json();return{http:response.status,result};};
const runtime=await api('/runtime');if(runtime.http!==200)throw Error('正常实例未就绪');
report.configHashBefore=hash(runtime.result.config);report.characterId=runtime.result.config.currentCharacterId;
const query='?'+new URLSearchParams({characterId:report.characterId,sessionId:report.sessionId});
const original=previous.delivery.result.resources;
const inputs=original.filter(row=>row.kind==='markdown'||row.kind==='image').map(row=>({resourceId:row.id,use:row.kind==='image'?'image':'text'}));
report.inputResources=original.filter(row=>inputs.some(input=>input.resourceId===row.id)).map(({id,sha256,bytes,mime})=>({id,sha256,bytes,mime}));
report.phase='submitting';save();
try{
  const response=await api('/chat'+query,{turnId:report.turnId,inputResources:inputs,text:'这是纯合成文件链路验收 W01_FINAL_20261016，不涉及真人经历，也不要调用任何业务工具。先读取本轮实际附件，简述MD中的合成物品和图片颜色。再实际生成四个可下载文件：README.md、index.html、diagram.png、aiki-resource-bundle.zip。图片用简单64×64绿色方块即可；MD和HTML的正文含标记W01_FINAL_20261016，并引用相对图片 assets/diagram.png。ZIP根目录包含manifest.json，格式schemaVersion为aiki-resource-bundle/v1，title为合成资料包，entrypoint为index.html，files包含README.md和index.html(role均为page)、assets/diagram.png(role为asset)，各项声明正确path/mime和实际sha256，不能列manifest自身。ZIP文件内必须确有这些文件；独立diagram.png与包内图片字节相同。实际创建文件并给下载链接，不要仅返回脚本、示例或tool call。'});
  report.chat={http:response.http,turn:response.result.turn,error:response.result.error,materialsUsed:response.result.context?.materialsUsed};save();
  if(response.http!==200)throw Error('正常聊天未通过，详见证据');
  const id=response.result.turn?.artifactDeliveryId;if(!id)throw Error('没有文件交付记录');
  const deadline=Date.now()+120000;
  while(true){report.delivery=await api('/artifact-deliveries/'+id+query);save();if(report.delivery.http!==200)throw Error('交付回读失败');if(!report.delivery.result.resources.some(row=>['pending','receiving'].includes(row.state)))break;if(Date.now()>deadline)throw Error('文件接收等待超时');await new Promise(done=>setTimeout(done,500));}
  for(const resource of report.delivery.result.resources){if(resource.state!=='ready')continue;if(resource.kind==='zip')report.bundle=await api('/resources/'+resource.id+'/bundle-preview'+query,{});if(['markdown','html','text'].includes(resource.kind)){const material=await api('/resources/'+resource.id+'/material'+query);report.calls.push({kind:'material',resourceId:resource.id,http:material.http,sha256:material.result.sha256,containsMarker:material.result.text?.includes('W01_FINAL_20261016'),extraction:material.result.extraction});}}
  report.web=await api('/resources/from-url'+query,{url:'https://example.com/',operationId:'w01-final-public-url'});
  if(report.web.http===200){const material=await api('/resources/'+report.web.result.id+'/material'+query);report.webMaterial={http:material.http,sha256:material.result.sha256,textLength:material.result.text?.length,containsExample:material.result.text?.includes('Example Domain')};}
  report.configHashAfter=hash((await api('/runtime')).result.config);report.phase='completed';save();
  console.log(JSON.stringify({evidence:file,http:report.chat.http,images:report.chat.turn?.inputImageReceipts,files:report.delivery.result.resources.map(row=>({name:row.name,state:row.state,error:row.error})),bundle:report.bundle?.result?.canOrganize,links:report.bundle?.result?.links,web:report.web.http,configUnchanged:report.configHashBefore===report.configHashAfter}));
}catch(error){report.phase='failed';report.error=String(error);save();throw error;}

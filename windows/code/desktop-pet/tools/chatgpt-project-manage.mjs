import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

// Use the running Book API; never edit a live writer's files or print its bearer token.
const directory=resolve(process.env.AIKI_BOOK_DATA??'../../.local/memory-book');
const session=JSON.parse(readFileSync(resolve(directory,'management-session.json'),'utf8'));
const url=new URL(session.url),token=new URLSearchParams(url.hash.slice(1)).get('token');
if(!token||!['127.0.0.1','localhost'].includes(url.hostname))throw Error('Invalid local management session');
const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'},base=url.origin+'/api/memory-book/v1';
const call=async(path,method='GET',body)=>{
  const response=await fetch(base+path,{method,headers,signal:AbortSignal.timeout(45000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw Error(result.error?.message??'HTTP '+response.status);return result;
};
const mode=process.argv[2]??'status';
if(mode==='regular-debug'){
  const {config}=await call('/runtime');
  if(!config.chatgptWeb)throw Error('ChatGPT source not configured');
  const result=await call('/runtime','PUT',{config:{...config,chatgptWeb:{...config.chatgptWeb,conversationMode:'regular',temporaryChatTests:false}},expectedRevision:config.revision,operationId:randomUUID()});
  if(result.activationError)throw Error('Settings saved; activation failed: '+result.activationError);
  console.log(JSON.stringify({revision:result.config.revision,conversationMode:result.config.chatgptWeb.conversationMode,temporaryChatTests:result.config.chatgptWeb.temporaryChatTests,transport:result.config.chatgptWeb.transport}));
}else if(mode==='status'){
  const {config}=await call('/runtime');console.log(JSON.stringify({characterId:config.currentCharacterId,transport:config.chatgptWeb?.transport,conversationMode:config.chatgptWeb?.conversationMode??'temporary',temporaryChatTests:config.chatgptWeb?.temporaryChatTests,bindings:config.chatgptProjects?.length??0}));
}else if(mode==='embedded-status')console.log(JSON.stringify(await call('/chatgpt-web/embedded/status')));
else if(mode==='models')console.log(JSON.stringify(await call('/chatgpt-web/models')));
else if(mode==='source-status')console.log(JSON.stringify(await call('/chatgpt-web/status')));
else if(mode==='thinking')console.log(JSON.stringify(await call('/chatgpt-web/thinking')));
else if(mode==='thinking-set'){
  const level=Number(process.argv[3]),{config}=await call('/runtime');
  console.log(JSON.stringify(await call('/chatgpt-web/thinking','POST',{level,expectedRevision:config.revision,operationId:randomUUID()})));
}
else if(mode==='restart-backend')console.log(JSON.stringify(await call('/chatgpt-web/backend/restart','POST',{})));
else if(mode==='check')console.log(JSON.stringify(await call('/chatgpt-web/projects/check','POST',{url:process.argv[3]})));
else if(mode==='bind'){
  const targetUrl=process.argv[3];if(!targetUrl)throw Error('Project URL required');
  let {config}=await call('/runtime');
  if(config.chatgptWeb?.transport!=='embedded'){
    const selected=await call('/runtime','PUT',{config:{...config,chatgptWeb:{...config.chatgptWeb,transport:'embedded',conversationMode:'regular',temporaryChatTests:false}},expectedRevision:config.revision,operationId:randomUUID()});
    if(selected.activationError)throw Error(selected.activationError);config=selected.config;
  }
  const checked=await call('/chatgpt-web/projects/check','POST',{url:targetUrl});
  const binding={id:randomUUID(),characterId:config.currentCharacterId,pairingId:'local-user',enabled:true,projectId:checked.projectId,name:checked.name,account:checked.account,memory:'unverified'};
  const saved=await call('/runtime','PUT',{config:{...config,chatgptProjects:[...(config.chatgptProjects??[]).filter(row=>row.characterId!==binding.characterId||row.pairingId!==binding.pairingId),binding]},expectedRevision:config.revision,operationId:randomUUID()});
  if(saved.activationError)throw Error(saved.activationError);
  console.log(JSON.stringify({revision:saved.config.revision,characterId:binding.characterId,projectId:binding.projectId,name:binding.name,memory:binding.memory,transport:saved.config.chatgptWeb.transport}));
}
else throw Error('Unknown mode');

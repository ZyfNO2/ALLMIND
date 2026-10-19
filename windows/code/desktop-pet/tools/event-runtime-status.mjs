import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const session=JSON.parse(readFileSync(resolve('../../.local/memory-book/management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token')};
for(const route of ['/runtime','/chatgpt-web/status']){
 try{const response=await fetch(url.origin+'/api/memory-book/v1'+route,{headers,signal:AbortSignal.timeout(10000)}),result=await response.json();console.log(JSON.stringify({route,http:response.status,...(route==='/runtime'?{model:result.config?.mainModel?.model,transport:result.config?.chatgptWeb?.transport,regularTests:result.config?.chatgptWeb?.temporaryChatTests===false}:{state:result.state,active:!!result.activeRequest})}));}catch(error){console.log(JSON.stringify({route,error:error.message}));process.exitCode=1;}
}

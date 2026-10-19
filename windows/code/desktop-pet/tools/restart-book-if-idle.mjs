import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const path=resolve('../../.local/memory-book/management-session.json'),session=JSON.parse(readFileSync(path,'utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
const status=await fetch(url.origin+'/api/memory-book/v1/chatgpt-web/status',{headers,signal:AbortSignal.timeout(10000)});if(!status.ok)throw Error('Cannot verify current source');const current=await status.json();if(current.activeRequest)throw Error('Model request live; refusing restart');
const response=await fetch(url.origin+'/api/memory-book/v1/chatgpt-web/backend/restart',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Managed restart refused: '+response.status);console.log(JSON.stringify({managedRestartAcknowledged:true}));

// Register as a stdio MCP server in AstrBot. Identity and token belong to an operator-owned config.
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createInterface} from 'node:readline';
if(!process.argv[2]||!isAbsolute(process.argv[2]))throw Error('Use an absolute private configuration file');
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const origin=new URL(config.origin);
if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.hash||origin.search)throw Error('Loopback root origin required');
if(!config.identity||!['platform','conversationKey','senderKey'].every(key=>typeof config.identity[key]==='string')||!isAbsolute(config.tokenFile))throw Error('Explicit bound identity and absolute capability token file required');
const schemas={
 prepare_task:{type:'object',properties:{profileId:{type:'string'},toolName:{type:'string'},arguments:{type:'object'},instruction:{type:'string'}},required:['profileId'],additionalProperties:false},
 task_status:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},
};
async function handle(message){
 if(message.method==='initialize')return {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'allmind-approved-tasks',version:'0.1.0'}};
 if(message.method==='ping')return {};
 if(message.method==='tools/list')return {tools:Object.entries(schemas).map(([name,inputSchema])=>({name,inputSchema,description:name==='prepare_task'?'Prepare a task for explicit local review. Does not execute.':'Read a bound task receipt. Unknown is never retried.'}))};
 if(message.method!=='tools/call')throw Error('Unsupported method');
 const {name,arguments:args}=message.params??{};
 if(!Object.hasOwn(schemas,name)||!args||typeof args!=='object'||Object.keys(args).some(key=>!Object.hasOwn(schemas[name].properties,key)))throw Error('Invalid tool arguments');
 const token=readFileSync(config.tokenFile,'utf8').trim();
 const response=await fetch(origin.origin+'/api/memory-book/v1/astrbot/task/'+(name==='prepare_task'?'prepare':'status'),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...args,...config.identity}),redirect:'error',signal:AbortSignal.timeout(30000)});
 const body=await response.json();return {isError:!response.ok,content:[{type:'text',text:JSON.stringify(body)}]};
}
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 let message;try{message=JSON.parse(line);}catch{process.stderr.write('Malformed MCP JSON input\n');continue;}
 if(message.id===undefined)continue;
 let result;try{result={result:await handle(message)};}catch(error){result={error:{code:-32603,message:error.message}};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...result})+'\n');
}

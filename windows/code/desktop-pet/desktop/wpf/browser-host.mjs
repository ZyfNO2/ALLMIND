import {app,BrowserWindow} from 'electron';
import {createInterface} from 'node:readline';
import {mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import net from 'node:net';
import {createParallelChatgptPageHost} from '../electron/chatgpt-page-host.mjs';
const data=resolve(process.argv[process.argv.indexOf('--data')+1]);
const endpoint=process.env.ALLMIND_BROWSER_PIPE,token=process.env.ALLMIND_BROWSER_TOKEN;
delete process.env.ALLMIND_BROWSER_PIPE;delete process.env.ALLMIND_BROWSER_TOKEN;
if(!endpoint?.startsWith('\\\\.\\pipe\\ALLMIND-Browser-')||!token||!/^[a-f0-9]{64}$/.test(token))throw Error('Missing private browser channel.');
mkdirSync(data,{recursive:true});app.setPath('userData',join(data,'profile'));
// Electron must finish evaluating its ESM entry before emitting ready.
// Awaiting whenReady at module scope can deadlock the helper before its handshake.
app.whenReady().then(()=>{
const host=createParallelChatgptPageHost({BrowserWindow,getParent:()=>undefined,accountFile:join(data,'account.json')});
const channel=net.connect(endpoint);
const lines=createInterface({input:channel,crlfDelay:Infinity});
const reply=value=>{if(!channel.destroyed)channel.write(JSON.stringify(value)+'\n');};
lines.on('line',line=>{let r;try{r=JSON.parse(line);if(typeof r.requestId!=='string'||!r.params)throw Error('浏览器请求无效。');}catch{process.stderr.write('Rejected malformed browser-host request.\n');return;}void host.handle(r.params).then(value=>reply({requestId:r.requestId,ok:true,value}),error=>reply({requestId:r.requestId,ok:false,error:error.message}));});
let closing=false;function close(){if(closing)return;closing=true;host.close();app.quit();}
lines.on('close',close);channel.on('error',close);app.on('window-all-closed',()=>{});app.on('before-quit',()=>host.close());
channel.on('connect',()=>reply({ready:true,token}));
}).catch(error=>{process.stderr.write('ChatGPT host startup failed: '+error.message+'\n');app.exit(1);});

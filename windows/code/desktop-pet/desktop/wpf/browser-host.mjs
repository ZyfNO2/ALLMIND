import {app,BrowserWindow} from 'electron';
import {createInterface} from 'node:readline';
import {mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createChatgptPageHost} from '../electron/chatgpt-page-host.mjs';
const data=resolve(process.argv[process.argv.indexOf('--data')+1]);
mkdirSync(data,{recursive:true});app.setPath('userData',join(data,'profile'));
await app.whenReady();const host=createChatgptPageHost({BrowserWindow,getParent:()=>undefined,accountFile:join(data,'account.json')});
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
const reply=value=>process.stdout.write(JSON.stringify(value)+'\n');
lines.on('line',line=>{let r;try{r=JSON.parse(line);if(typeof r.requestId!=='string'||!r.params)throw Error('浏览器请求无效。');}catch{process.stderr.write('Rejected malformed browser-host request.\n');return;}void host.handle(r.params).then(value=>reply({requestId:r.requestId,ok:true,value}),error=>reply({requestId:r.requestId,ok:false,error:error.message}));});
let closing=false;function close(){if(closing)return;closing=true;host.close();app.quit();}
lines.on('close',close);app.on('window-all-closed',()=>{});app.on('before-quit',()=>host.close());
reply({ready:true});

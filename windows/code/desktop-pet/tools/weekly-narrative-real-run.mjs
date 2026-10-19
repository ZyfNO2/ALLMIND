import {readFileSync,writeFileSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const directory=JSON.parse(readFileSync('.local/weekly-real-current.json','utf8')).directory,input=JSON.parse(readFileSync(join(directory,'input.json'),'utf8')),production=resolve('../../.local/memory-book');
if(existsSync(join(production,'writer.lock')))throw Error('Normal writer lock still present; verify exact writer has exited first');
try{
 const child=spawn(createRequire(import.meta.url)('electron'),[resolve('tools/weekly-narrative-real-probe.mjs'),'--root',resolve('desktop'),'--node',process.execPath,'--backend',input.backend,'--companion-probe','--background-acceptance','--probe-user-data',input.profile],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,AIKI_BOOK_DATA:directory,AIKI_BOOK_PORT:'0'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',part=>process.stdout.write(part));let stderr='';child.stderr.on('data',part=>{stderr+=part;writeFileSync(join(directory,'stderr.log'),stderr)});writeFileSync(join(directory,'process.json'),JSON.stringify({parentPid:process.pid,electronPid:child.pid}));
 process.exitCode=(await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)}))??1;
}finally{
 for(const row of input.savedPreferences)copyFileSync(row.backup,row.path);
 const normal=spawn(process.execPath,[resolve('dist/app/book-launcher.js'),'--inactive-start'],{cwd:process.cwd(),detached:true,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,AIKI_BOOK_DATA:production,AIKI_BOOK_PORT:undefined},stdio:'ignore'});normal.unref();writeFileSync(join(directory,'normal-restored.json'),JSON.stringify({launcherPid:normal.pid,at:new Date().toISOString()}));console.log(JSON.stringify({normalRestoredLauncher:normal.pid}));
}

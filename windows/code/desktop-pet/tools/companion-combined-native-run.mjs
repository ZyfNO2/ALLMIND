import {readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const lifecycle=process.env.AIKI_NATIVE_LIFECYCLE==='1';
const directory=JSON.parse(readFileSync('.local/native-combined-current.json','utf8')).directory,input=JSON.parse(readFileSync(join(directory,lifecycle?'native-lifecycle-input.json':'native-combined-input.json'),'utf8'));
const production=resolve('../../.local/memory-book'),lock=join(production,'writer.lock');
if(existsSync(lock))throw Error('Normal Book writer lock still present; confirm stopped writer before opening original profile');
const originalPreferences=input.savedPreferences.map(row=>({...row,bytes:readFileSync(row.backup)}));
let child;
try{
  child=spawn(createRequire(import.meta.url)('electron'),[resolve(process.env.AIKI_NATIVE_ERASE_VERIFY==='1'?'tools/companion-erase-native-probe.mjs':lifecycle?'tools/companion-lifecycle-native-probe.mjs':'tools/companion-combined-native-probe.mjs'),'--root',resolve('desktop'),'--node',process.execPath,'--backend',input.backend,'--companion-probe','--background-acceptance','--probe-user-data',input.profile],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,AIKI_BOOK_DATA:directory,AIKI_BOOK_PORT:'0'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stdout.on('data',part=>process.stdout.write(part));child.stderr.on('data',part=>{stderr+=part;writeFileSync(join(directory,lifecycle?'native-lifecycle.stderr.log':'native.stderr.log'),stderr)});
  writeFileSync(join(directory,'native-process.json'),JSON.stringify({parentPid:process.pid,electronPid:child.pid,startedAt:new Date().toISOString()}));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});console.log(JSON.stringify({nativeExitCode:code,evidence:input.evidence}));process.exitCode=code??1;
}finally{
  // Only preferences from this exclusive-profile test interval are restored; no cookie copying.
  for(const row of originalPreferences)if(!existsSync(row.path)||!readFileSync(row.path).equals(row.bytes))copyFileSync(row.backup,row.path);
  const normal=spawn(process.execPath,[resolve('dist/app/book-launcher.js'),'--inactive-start'],{cwd:process.cwd(),detached:true,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,AIKI_BOOK_DATA:production,AIKI_BOOK_PORT:undefined},stdio:'ignore'});normal.unref();writeFileSync(join(directory,'normal-restored.json'),JSON.stringify({launcherPid:normal.pid,startedAt:new Date().toISOString()}));console.log(JSON.stringify({normalRestoredLauncher:normal.pid}));
}

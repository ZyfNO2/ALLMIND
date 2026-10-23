import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,rmdirSync,unlinkSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(readFileSync(file,'utf8'));
const inside=(root,path)=>{const rel=relative(root,path);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);};
const fail=message=>{throw Error(message);};
function noLinks(path){
 for(let current=resolve(path);;current=dirname(current)){
  if(existsSync(current)&&lstatSync(current).isSymbolicLink())fail('Linked paths are not allowed: '+current);
  if(dirname(current)===current)break;
 }
}
function filesUnder(root){
 const files=[];
 function walk(directory){for(const name of readdirSync(directory)){
  const file=join(directory,name),stat=lstatSync(file);
  if(stat.isSymbolicLink())fail('Linked package member: '+file);
  if(stat.isDirectory())walk(file);else if(stat.isFile())files.push(relative(root,file).split(sep).join('/'));else fail('Unsupported package member: '+file);
 }}
 walk(root);return files;
}
/** Integrity is not publisher authenticity. Updates additionally require a digest supplied by the user. */
export function verifyInstallPackage(directory,expectedManifest){
 const root=resolve(directory);noLinks(root);
 const raw=readFileSync(join(root,'package-manifest.json')),manifestHash=sha(raw),manifest=JSON.parse(raw);
 if(expectedManifest!==undefined&&(!/^[a-f0-9]{64}$/.test(expectedManifest)||manifestHash!==expectedManifest))fail('Package manifest SHA-256 does not match the supplied release digest.');
 if(manifest.schemaVersion!==1||manifest.platform!=='win32-x64'||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>20000)fail('Unsupported package manifest.');
 const names=new Set();
 for(const row of manifest.files){
  if(!row||typeof row.path!=='string'||row.path.length>500||row.path.split('/').some(part=>!part||part==='.'||part==='..'||/[\\:\x00-\x1f<>"|?*]/.test(part)||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^([a-f0-9]{64})$/.test(row.sha256))fail('Invalid package inventory entry.');
  if(names.has(row.path.toLowerCase())||row.path.toLowerCase()==='package-manifest.json')fail('Duplicate or reserved package path.');
  names.add(row.path.toLowerCase());
  const target=resolve(root,row.path);if(!inside(root,target))fail('Package path escaped root.');noLinks(target);
  const stat=lstatSync(target);if(!stat.isFile()||stat.size!==row.bytes||sha(readFileSync(target))!==row.sha256)fail('Package integrity failed: '+row.path);
 }
 const actual=filesUnder(root).filter(path=>path!=='package-manifest.json');
 if(actual.length!==names.size||actual.some(path=>!names.has(path.toLowerCase())))fail('Package contains unlisted files.');
 const meta=read(join(root,'package.json'));
 if(meta.name!=='allmind-portable'||typeof meta.version!=='string'||!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/.test(meta.version))fail('Invalid ALLMIND package identity.');
 for(const required of ['runtime/node.exe','desktop/wpf/main.mjs','Start-ALLMIND.vbs'])if(!names.has(required.toLowerCase()))fail('Package missing '+required);
 return {root,manifest,manifestHash,version:meta.version};
}
const legacyLauncher=`Option Explicit\r\nDim fso,shell,root,current,slot,command,stream,regex\r\nSet fso=CreateObject("Scripting.FileSystemObject")\r\nSet shell=CreateObject("WScript.Shell")\r\nroot=fso.GetParentFolderName(WScript.ScriptFullName)\r\nIf fso.FileExists(root & "\\.install.lock") Then\r\n MsgBox "ALLMIND maintenance is in progress. Try again after it finishes.",48,"ALLMIND"\r\n WScript.Quit 1\r\nEnd If\r\nSet stream=fso.OpenTextFile(root & "\\current.txt",1)\r\ncurrent=stream.ReadAll\r\nstream.Close\r\nslot=Trim(Replace(Replace(current,vbCr,""),vbLf,""))\r\nSet regex=New RegExp\r\nregex.Pattern="^[0-9A-Za-z.+-]+-[a-f0-9]{12}$"\r\nIf Not regex.Test(slot) Then Err.Raise 5,,"Invalid ALLMIND install pointer"\r\nIf InStr(slot,"..")>0 Or InStr(slot,"/")>0 Or InStr(slot,"\\")>0 Or Len(slot)=0 Then Err.Raise 5,,"Invalid ALLMIND install pointer"\r\ncommand=Chr(34) & root & "\\versions\\" & slot & "\\runtime\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\versions\\" & slot & "\\desktop\\wpf\\main.mjs" & Chr(34)\r\nIf WScript.Arguments.Count > 0 Then command=command & " --data " & Chr(34) & WScript.Arguments(0) & Chr(34)\r\nshell.Run command,0,False\r\n`;
// Keep the installed launcher independent of the caller's working directory and default profile.
const launcher=legacyLauncher.replace(
 'If WScript.Arguments.Count > 0 Then command=command & " --data " & Chr(34) & WScript.Arguments(0) & Chr(34)',
 'Set stream=fso.OpenTextFile(root & "\\data-root.txt",1,False,-1)\r\ncurrent=stream.ReadAll\r\nstream.Close\r\ncommand=command & " --data " & Chr(34) & current & Chr(34)'
);
const samePath=(a,b)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
function assertDataRoot(record,data){
 if(record?.dataRoot!==undefined&&!samePath(record.dataRoot,data))fail('The installed data directory differs from --data-root. Use the bound data directory; no installation files changed.');
}
function context(options){
 const root=resolve(options.installRoot),data=resolve(options.dataRoot);
 if(/["\x00-\x1f]/.test(data))fail('Invalid data directory for the Windows launcher.');
 if(root===data||inside(root,data)||inside(data,root))fail('Installation and user data must be separate directories.');
 if(root===dirname(root))fail('Cannot install at a drive root.');
 noLinks(root);noLinks(data);return {root,data};
}
function current(root){
 if(!existsSync(join(root,'install.json')))return null;
 const value=read(join(root,'install.json'));
 if(value.product!=='ALLMIND'||value.schemaVersion!==1||!Array.isArray(value.versions)||value.versions.some(v=>!v||!/^[0-9A-Za-z.+-]+-[a-f0-9]{12}$/.test(v.slot)||!/^[a-f0-9]{64}$/.test(v.manifestHash))||new Set(value.versions.map(v=>v.slot)).size!==value.versions.length||!value.versions.some(v=>v.slot===value.current))fail('Invalid managed installation record.');
 if(value.dataRoot!==undefined&&(typeof value.dataRoot!=='string'||!isAbsolute(value.dataRoot)||/["\x00-\x1f]/.test(value.dataRoot)))fail('Invalid installed data directory.');
 return value;
}
function lock(root){
 mkdirSync(root,{recursive:true});const file=join(root,'.install.lock'),id=randomUUID();
 const fd=openSync(file,'wx');try{writeFileSync(fd,id);}finally{closeSync(fd);}
 return ()=>{if(existsSync(file)&&readFileSync(file,'utf8')===id)unlinkSync(file);};
}
function atomic(file,contents){const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,contents,{flag:'wx'});renameSync(temp,file);}
function assertRootLayout(root,record){
 if(!record&&readdirSync(root).some(name=>name!=='.install.lock'))fail('Installation directory is not empty or managed by ALLMIND.');
 const allowed=new Set(['.install.lock','install.json','current.txt','Start-ALLMIND.vbs','versions','data-root.txt']);
 for(const name of readdirSync(root))if(!allowed.has(name))fail('Unmanaged installation content; preserve and inspect: '+name);
 for(const name of ['install.json','current.txt','Start-ALLMIND.vbs','data-root.txt'])if(existsSync(join(root,name))&&!lstatSync(join(root,name)).isFile())fail('Invalid installation control file.');
 if(record){
  if(readFileSync(join(root,'Start-ALLMIND.vbs'),'utf8')!==(record.dataRoot===undefined?legacyLauncher:launcher))fail('Installed launcher was modified.');
  if(record.dataRoot!==undefined&&readFileSync(join(root,'data-root.txt'),'utf16le')!=='\ufeff'+record.dataRoot)fail('Installed data directory pointer was modified.');
  if(record.dataRoot===undefined&&existsSync(join(root,'data-root.txt')))fail('Unmanaged data directory pointer; preserve and inspect.');
  const pointer=readFileSync(join(root,'current.txt'),'utf8').trim();
  if(!record.versions.some(v=>v.slot===pointer))fail('Install pointer is not a verified version.');
 }
}
function noRunningData(data){
 for(const path of ['host/controller.json','book/writer.lock'])if(existsSync(join(data,path))){
  const descriptor=read(join(data,path));if(!Number.isSafeInteger(descriptor.pid)||descriptor.pid<=0)fail('Cannot establish user-data process status.');
  try{process.kill(descriptor.pid,0);}catch(error){if(error.code==='ESRCH')continue;throw error;}
  fail('Exit ALLMIND normally before rollback or uninstall; user data will be preserved.');
 }
}
export function installAllmind(options){
 const {root,data}=context(options),pkg=verifyInstallPackage(options.packageRoot,options.expectedManifest);
 if(root===pkg.root||inside(root,pkg.root)||inside(pkg.root,root))fail('Package source and installation must not overlap.');
 const release=lock(root);
 try{
  const prior=current(root);assertRootLayout(root,prior);assertDataRoot(prior,data);
  if(prior&&prior.versions.find(v=>v.slot===prior.current)?.manifestHash!==pkg.manifestHash&&!options.expectedManifest)fail('Updates require --expected-manifest <SHA-256 from a trusted release channel>. No installed version changed.');
  const slot=pkg.version+'-'+pkg.manifestHash.slice(0,12),destination=join(root,'versions',slot);
  if(existsSync(destination))verifyInstallPackage(destination,pkg.manifestHash);
  else{
   const staging=join(root,'versions','.staging-'+randomUUID());mkdirSync(staging,{recursive:true});
   for(const path of [...pkg.manifest.files.map(row=>row.path),'package-manifest.json']){
    const target=join(staging,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(pkg.root,path),target);
   }
   verifyInstallPackage(staging,pkg.manifestHash);renameSync(staging,destination);
  }
  const versions=prior?.versions??[];
  if(!versions.some(v=>v.slot===slot))versions.push({slot,manifestHash:pkg.manifestHash,version:pkg.version});
  if(prior?.dataRoot===undefined){
   atomic(join(root,'data-root.txt'),Buffer.from('\ufeff'+data,'utf16le'));
   atomic(join(root,'Start-ALLMIND.vbs'),launcher);
  }
  // Records first: if pointer replacement fails, the old verified slot still starts.
  atomic(join(root,'install.json'),JSON.stringify({schemaVersion:1,product:'ALLMIND',dataRoot:prior?.dataRoot??data,current:slot,previous:prior?.current===slot?prior.previous:prior?.current??null,versions},null,2)+'\n');
  atomic(join(root,'current.txt'),slot+'\n');
  return {status:'installed',version:pkg.version,manifestHash:pkg.manifestHash,launcher:join(root,'Start-ALLMIND.vbs'),dataRoot:data,restartRequired:!!prior};
 }finally{release();}
}
export function rollbackAllmind(options){
 const {root,data}=context(options);const release=lock(root);
 try{
  const record=current(root);assertDataRoot(record,data);if(!record?.previous)fail('No previous installed version.');assertRootLayout(root,record);noRunningData(data);
  const target=record.versions.find(v=>v.slot===record.previous);if(!target)fail('Previous version missing from managed record.');
  verifyInstallPackage(join(root,'versions',target.slot),target.manifestHash);
  const previous=record.current;record.current=target.slot;record.previous=previous;
  atomic(join(root,'install.json'),JSON.stringify(record,null,2)+'\n');atomic(join(root,'current.txt'),target.slot+'\n');
  return {status:'rolled-back',version:target.version,dataRoot:data};
 }finally{release();}
}
export function uninstallAllmind(options){
 const {root,data}=context(options);if(inside(root,resolve(process.execPath)))fail('Run uninstall using Node from an external portable package, not the installation being removed.');const release=lock(root);
 let moved;
 try{
  const record=current(root);if(!record)fail('Not an ALLMIND managed installation.');assertRootLayout(root,record);assertDataRoot(record,data);noRunningData(data);
  const slots=readdirSync(join(root,'versions'));if(slots.length!==record.versions.length||slots.some(slot=>!record.versions.some(v=>v.slot===slot)))fail('Unmanaged version/staging content; no files removed.');
  for(const version of record.versions)verifyInstallPackage(join(root,'versions',version.slot),version.manifestHash);
  moved=root+'.uninstall-'+randomUUID();renameSync(root,moved);
  // Delete only the fully checked code tree. Data is outside it and is never touched.
  for(const path of filesUnder(moved))unlinkSync(join(moved,path));
  function empty(directory){for(const name of readdirSync(directory)){const path=join(directory,name);if(lstatSync(path).isDirectory())empty(path);else fail('Unexpected file during uninstall.');}rmdirSync(directory);}
  empty(moved);return {status:'uninstalled',dataPreserved:data};
 }finally{if(!moved)release();}
}
/** Read-only inventory. Current and rollback slots are always protected. */
export function previewPruneAllmind(options){
 const {root,data}=context(options),record=current(root);if(!record)fail('Not an ALLMIND managed installation.');
 assertRootLayout(root,record);assertDataRoot(record,data);
 const directory=resolve(root,'versions');if(!inside(root,directory))fail('Version directory escaped installation.');
 const slots=readdirSync(directory);if(slots.length!==record.versions.length||slots.some(slot=>!record.versions.some(v=>v.slot===slot)))fail('Unmanaged version/staging content; no cleanup is offered.');
 const candidates=[];
 for(const version of record.versions){const path=resolve(directory,version.slot);if(!inside(directory,path))fail('Invalid version path.');const checked=verifyInstallPackage(path,version.manifestHash);if(version.slot!==record.current&&version.slot!==record.previous)candidates.push({slot:version.slot,version:version.version,bytes:checked.manifest.files.reduce((n,row)=>n+row.bytes,0),manifestHash:version.manifestHash});}
 const plan={current:record.current,previous:record.previous,candidates};return {...plan,planHash:sha(JSON.stringify(plan))};
}
export function pruneAllmind(options){
 const {root,data}=context(options),release=lock(root);
 try{
  noRunningData(data);const plan=previewPruneAllmind(options);
  if(options.expectedPlan!==plan.planHash||!Array.isArray(options.slots)||!options.slots.length||new Set(options.slots).size!==options.slots.length||options.slots.some(slot=>!plan.candidates.some(row=>row.slot===slot)))fail('Cleanup selection or plan changed; preview and explicitly confirm again.');
  const record=current(root),targets=options.slots.map(slot=>resolve(root,'versions',slot));
  for(const path of targets){if(!inside(resolve(root,'versions'),path))fail('Cleanup target escaped versions.');noLinks(path);}
  if(targets.some(path=>inside(path,resolve(process.execPath))))fail('Run cleanup from an external portable package or a protected version, not a selected cleanup target.');
  // The complete selection is checked before the first delete. Only exact inventoried program files are removed.
  for(const slot of options.slots){const target=targets[options.slots.indexOf(slot)],version=record.versions.find(row=>row.slot===slot);verifyInstallPackage(target,version.manifestHash);for(const name of filesUnder(target))unlinkSync(join(target,name));
   function empty(directory){for(const name of readdirSync(directory)){const path=join(directory,name);if(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink())fail('Unknown cleanup content; partial cleanup retained for inspection.');empty(path);}rmdirSync(directory);}empty(target);
   record.versions=record.versions.filter(row=>row.slot!==slot);atomic(join(root,'install.json'),JSON.stringify(record,null,2)+'\n');
  }
  return {status:'pruned',removedSlots:options.slots,dataPreserved:data,current:record.current,previous:record.previous};
 }finally{release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 let resultReserved=false;
 try{
  if(process.platform!=='win32'||process.arch!=='x64')fail('ALLMIND installation requires Windows x64.');
  const operation=args[0]??'install',allowed=new Set(['--install-root','--data-root','--package','--expected-manifest','--result-file','--expected-plan','--slots']),seen=new Set();
  if(!['install','rollback','uninstall','prune-preview','prune'].includes(operation))fail('Use install, rollback, uninstall, prune-preview or prune.');
  for(let i=1;i<args.length;i+=2){if(!allowed.has(args[i])||seen.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))fail('Unknown, duplicate or missing installer option value.');seen.add(args[i]);}
  if(value('--result-file')){writeFileSync(value('--result-file'),'',{flag:'wx'});resultReserved=true;}
  const local=process.env.LOCALAPPDATA;if(!local)fail('LOCALAPPDATA is unavailable.');
  const installRoot=value('--install-root')??join(local,'Programs','ALLMIND');noLinks(installRoot);
  const options={installRoot,dataRoot:value('--data-root')??current(installRoot)?.dataRoot??join(local,'ALLMIND'),packageRoot:value('--package')??resolve(dirname(fileURLToPath(import.meta.url)),'..'),expectedManifest:value('--expected-manifest'),expectedPlan:value('--expected-plan'),slots:value('--slots')?.split(',')};
  const result=operation==='install'?installAllmind(options):operation==='rollback'?rollbackAllmind(options):operation==='uninstall'?uninstallAllmind(options):operation==='prune-preview'?previewPruneAllmind(options):pruneAllmind(options);
  if(resultReserved)writeFileSync(value('--result-file'),'\ufeff'+JSON.stringify(result,null,2),'utf16le');
  console.log(JSON.stringify(result));
 }catch(error){if(resultReserved)writeFileSync(value('--result-file'),'\ufeff'+error.message,'utf16le');console.error(error.message);process.exitCode=1;}
}

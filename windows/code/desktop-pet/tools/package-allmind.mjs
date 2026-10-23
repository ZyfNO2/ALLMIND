import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,lstatSync,realpathSync,copyFileSync} from 'node:fs';
import {dirname,join,resolve,relative,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Build this Windows x64 package with Windows x64 Node.');
const index=process.argv.indexOf('--output');if(index<0||!process.argv[index+1])throw Error('Usage: npm run pack:allmind -- --output <new directory>');
const profileIndex=process.argv.indexOf('--profile');
const profileName=profileIndex<0?'full':process.argv[profileIndex+1];
const {PROFILES}=await import(new URL('../dist/app/product-profile.js',import.meta.url));
const profile=PROFILES[profileName];if(!profile)throw Error('Unknown --profile. Use full, desktop-lite, desktop-astrbot or server-core.');
const output=resolve(process.argv[index+1]);if(existsSync(output))throw Error('Output already exists; select a new directory. No files were removed.');
const inside=relative(root,output),inSource=inside===''||(!isAbsolute(inside)&&inside!=='..'&&!inside.startsWith('..'+sep));
if(inSource&&!inside.startsWith('.local'+sep))throw Error('Use a separate output directory or .local/packages.');
for(const file of [...(profile.id==='server-core'?['dist/app/server-core.js']:['dist/app/book-backend.js']),'management/character-app/index.html','management/preview-runtime/presentation-preview.js','desktop/wpf/NODE-LICENSE.txt',...(profile.id==='server-core'?[]:['desktop/wpf/shell/bin/ALLMIND.Widget.exe','desktop/wpf/shell/assets/press.wav','desktop/wpf/shell/assets/release.wav'])])if(!existsSync(join(root,file)))throw Error('Build first: missing '+file);
const sourcePackage=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const sourceHashIndex=process.argv.indexOf('--source-hash'),sourceHash=sourceHashIndex<0?null:process.argv[sourceHashIndex+1];
if(sourceHash!==null&&(typeof sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(sourceHash)))throw Error('--source-hash must be the reviewed source inventory SHA-256.');
// The checked-in notice matches the verified build runtime. Other Node releases
// need their own bundled-dependency notices, not this version's license text.
let nodeLicense=readFileSync(join(root,'desktop/wpf/NODE-LICENSE.txt'),'utf8');
if(process.version!=='v24.18.0'){
 const response=await fetch('https://raw.githubusercontent.com/nodejs/node/'+process.version+'/LICENSE',{signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('Cannot obtain the matching Node license: HTTP '+response.status);
 nodeLicense=await response.text();if(!nodeLicense.includes('Node.js')||!nodeLicense.includes('Permission is hereby granted'))throw Error('Unexpected Node license response');
}
mkdirSync(output,{recursive:true});
function copyTree(from,to,filter=()=>true){
 const stat=lstatSync(from);if(stat.isSymbolicLink())throw Error('Refusing a linked package member: '+from);
 if(stat.isDirectory()){mkdirSync(to,{recursive:true});for(const entry of readdirSync(from)){if(filter(entry,join(from,entry)))copyTree(join(from,entry),join(to,entry),filter);}}
 else if(stat.isFile()){mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);}else throw Error('Unsupported file: '+from);
}
if(profile.id==='full')copyTree(join(root,'dist'),join(output,'dist'),name=>name!=='tests'&&!name.endsWith('.d.ts'));
else{
 const {moduleClosure}=await import('./profile-closure.mjs');
 for(const file of moduleClosure(join(root,profile.id==='server-core'?'dist/app/server-core.js':'dist/app/book-backend.js'),profile.omitDynamic)){
  const target=join(output,'dist',relative(join(root,'dist'),file));
  mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target);
 }
}
writeFileSync(join(output,'product-profile.json'),JSON.stringify({id:profile.id})+'\n');
for(const directory of ['management/character-app',...(profile.id==='server-core'?[]:['management/preview-runtime','desktop/assets','desktop/config','desktop/electron','desktop/build','desktop/chatgpt-extension']),...(profile.modules.voice?['desktop/voice']:[])])copyTree(join(root,directory),join(output,directory));
if(profile.modules.screen){mkdirSync(join(output,'desktop/ocr'),{recursive:true});copyFileSync(join(root,'desktop/ocr/windows-runtime-ocr.ps1'),join(output,'desktop/ocr/windows-runtime-ocr.ps1'));}
if(profile.modules.astrbot){for(const file of ['main.py','metadata.yaml','_conf_schema.json']){const dest=join(output,'integrations/astrbot_plugin_allmind',file);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(root,'integrations/astrbot_plugin_allmind',file),dest);}}
mkdirSync(join(output,'tools'),{recursive:true});
for(const file of ['sprite-inspect.cjs','model-archive.ps1','management-url.mjs','harness-relay-mcp.mjs','install-allmind.mjs','book-schema.mjs','allmind-modules.mjs','profile-closure.mjs','astrbot-task-mcp.mjs'])copyFileSync(join(root,'tools',file),join(output,'tools',file));
if(profile.id!=='server-core')for(const name of readdirSync(join(root,'desktop')))if(/\.(?:mjs|js|html|css)$/.test(name))copyFileSync(join(root,'desktop',name),join(output,'desktop',name));
if(profile.id!=='server-core')copyTree(join(root,'desktop/wpf'),join(output,'desktop/wpf'),name=>!['tests','.test-output','.tmp'].includes(name));
// Copy only the declared production dependency closure plus Electron. No dev tools, data, or links.
const copied=new Map();
function packageDirectory(name,from){
 for(let parent=from;;parent=dirname(parent)){const candidate=join(parent,'node_modules',name);if(existsSync(join(candidate,'package.json')))return realpathSync(candidate);if(dirname(parent)===parent)break;}
 throw Error('Installed dependency is missing: '+name);
}
function copyPackage(name,from){
 const source=packageDirectory(name,from),meta=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
 if(copied.has(name)){if(copied.get(name)!==meta.version)throw Error('Conflicting runtime versions need explicit nesting: '+name);return;}
 copied.set(name,meta.version);copyTree(source,join(output,'node_modules',name),entry=>entry!=='node_modules');
 for(const child of Object.keys(meta.dependencies??{}))copyPackage(child,source);
}
for(const name of [...Object.keys(sourcePackage.dependencies??{}),...(profile.id==='server-core'?[]:['electron'])])copyPackage(name,root);
const electron=join(output,'node_modules/electron');if(profile.id!=='server-core'&&!existsSync(join(electron,'dist/electron.exe')))throw Error('Installed Electron runtime is missing.');
mkdirSync(join(output,'runtime'),{recursive:true});copyFileSync(process.execPath,join(output,'runtime/node.exe'));
writeFileSync(join(output,'runtime/NODE-LICENSE.txt'),nodeLicense);
writeFileSync(join(output,'package.json'),JSON.stringify({name:'allmind-portable',version:sourcePackage.version,private:true,type:'module'},null,2)+'\n');
const repository=resolve(root,'../../..');for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md'])copyFileSync(join(repository,file),join(output,file));
const launcher=profile.id==='server-core'?'MsgBox "Set AIKI_BOOK_DATA and run Start-Server.cmd. This package has no desktop host."\r\n':`Option Explicit\r\nDim fso, shell, root, command\r\nSet fso = CreateObject("Scripting.FileSystemObject")\r\nSet shell = CreateObject("WScript.Shell")\r\nroot = fso.GetParentFolderName(WScript.ScriptFullName)\r\ncommand = Chr(34) & root & "\\runtime\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\desktop\\wpf\\main.mjs" & Chr(34)\r\nIf WScript.Arguments.Count > 0 Then command = command & " --data " & Chr(34) & WScript.Arguments(0) & Chr(34)\r\nshell.Run command, 0, False\r\n`;
writeFileSync(join(output,'Start-ALLMIND.vbs'),launcher);
if(profile.id==='server-core')writeFileSync(join(output,'Start-Server.cmd'),'@echo off\r\nif "%AIKI_BOOK_DATA%"=="" (echo Set AIKI_BOOK_DATA to a new data directory first. & exit /b 1)\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\app\\server-core.js"\r\n');
for(const [file,operation] of [['Install-ALLMIND.vbs','install'],['Rollback-ALLMIND.vbs','rollback'],['Uninstall-ALLMIND.vbs','uninstall']]){
 const script=`Option Explicit\r\nDim fso,shell,root,command,code,resultFile,resultText,stream,digest,regex\r\nSet fso=CreateObject("Scripting.FileSystemObject")\r\nSet shell=CreateObject("WScript.Shell")\r\nroot=fso.GetParentFolderName(WScript.ScriptFullName)\r\nIf MsgBox("ALLMIND ${operation}: program files only. User data is preserved. Continue?",36,"ALLMIND")<>6 Then WScript.Quit\r\nresultFile=fso.BuildPath(fso.GetSpecialFolder(2),fso.GetTempName)\r\ncommand=Chr(34) & root & "\\runtime\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\tools\\install-allmind.mjs" & Chr(34) & " ${operation} --result-file " & Chr(34) & resultFile & Chr(34)\r\n${operation==='install'?`If fso.FileExists(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\\Programs\\ALLMIND\\install.json")) Then\r\n digest=InputBox("For an update, paste the package-manifest.json SHA-256 from a trusted release channel. Cancel to leave the current version unchanged.","ALLMIND update")\r\n Set regex=New RegExp\r\n regex.Pattern="^[a-f0-9]{64}$"\r\n If Not regex.Test(digest) Then WScript.Quit\r\n command=command & " --expected-manifest " & digest\r\nEnd If\r\n`:''}code=shell.Run(command,0,True)\r\nIf fso.FileExists(resultFile) Then\r\n Set stream=fso.OpenTextFile(resultFile,1,False,-1)\r\n resultText=stream.ReadAll\r\n stream.Close\r\nElse\r\n resultText="Installer did not return a result. No success is assumed."\r\nEnd If\r\nIf code=0 Then\r\n MsgBox resultText,64,"ALLMIND ${operation} completed"\r\nElse\r\n MsgBox resultText,16,"ALLMIND ${operation} failed"\r\nEnd If\r\n`;
 writeFileSync(join(output,file),script);
}
writeFileSync(join(output,'README.txt'),'ALLMIND Windows portable preview\r\n\r\nDouble-click Start-ALLMIND.vbs. Node and Electron are included. Windows x64, Windows PowerShell 5.1 and .NET Framework WPF are required.\r\nOptional: Install-ALLMIND.vbs installs to %LOCALAPPDATA%/Programs/ALLMIND. Launch the installed Start-ALLMIND.vbs there.\r\nUpdates require the new package-manifest.json SHA-256 from a trusted release channel. Quit before rollback/uninstall; run Rollback-ALLMIND.vbs or Uninstall-ALLMIND.vbs from this external portable package. User data is preserved. Old code versions remain for rollback.\r\nRight-click the pet to open chat, roles, memory or settings. Closing the pet hides it; Exit ALLMIND in the system tray stops it.\r\nUser data stays in %LOCALAPPDATA%/ALLMIND and is not in this package. New users start with GPT-Niang; persona and Wiki are empty.\r\nLocal speech and screen-text OCR use installed Windows language components. Enable speech in settings; screen selection and both sending confirmations stay manual. No cloud speech/OCR fallback.\r\nPrivate backups: Settings > Data and backup. v2 includes every saved session and validates its checksum. Legacy v1 can be previewed with explicit missing-metadata warnings. Restore refuses existing role data; keys, login state, appearance and attachment files are excluded.\r\nFailed chats: check the original request result first; preparing a new request requires explicit duplicate/cost acknowledgement. Normal browser drafts survive page reload; incognito drafts are not stored.\r\nOld code cleanup: run tools/install-allmind.mjs prune-preview with bundled Node, then explicitly select candidate slots and the plan hash using prune. Current and rollback versions are protected; quit first.\r\nScenes: Auto/Smart/Quick/RP show the actual selected route and local token estimates. RP does not auto-write real memories.\r\nTools: explicitly trust the local program, review per-task parameters and confirm. The permission table is not an OS sandbox; unknown results are never auto-retried.\r\nSelective sync: explicit manual file exchange with full preview and conflict choices, excluding credentials, accounts, chat history and attachment files. This is not background cloud sync.\r\nData upgrade: beta.2 uses a new on-disk reader barrier. Program rollback does not roll back data. Quit all instances before using tools/book-schema.mjs rollback --data <book directory> --confirm; it rejects any post-migration edits. Keep independent pre-upgrade backups.\r\nNo keys, accounts or sample chats are bundled. Live2D SDK, voice models, signing and unattended auto-update are not included. SHA-256 checks integrity, not publisher authenticity.\r\nImage and quotation permissions are in desktop/wpf/shell/assets; keep all notices.\r\n');
const files=[];function inventory(base){for(const entry of readdirSync(base)){const file=join(base,entry),stat=lstatSync(file);if(stat.isSymbolicLink())throw Error('Output contains a link');if(stat.isDirectory())inventory(file);else files.push({path:relative(output,file).split(sep).join('/'),bytes:stat.size,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')});}}
inventory(output);writeFileSync(join(output,'package-manifest.json'),JSON.stringify({schemaVersion:1,platform:'win32-x64',node:process.version,sourceHash,profile:profile.id,modules:profile.modules,dependencies:Object.fromEntries(copied),files},null,2)+'\n');
console.log(JSON.stringify({output,files:files.length,bytes:files.reduce((total,file)=>total+file.bytes,0),runtimePackages:copied.size,manifestSha256:createHash('sha256').update(readFileSync(join(output,'package-manifest.json'))).digest('hex')}));

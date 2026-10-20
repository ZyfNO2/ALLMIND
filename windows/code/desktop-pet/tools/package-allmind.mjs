import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,lstatSync,realpathSync,copyFileSync} from 'node:fs';
import {dirname,join,resolve,relative,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Build this Windows x64 package with Windows x64 Node.');
const index=process.argv.indexOf('--output');if(index<0||!process.argv[index+1])throw Error('Usage: npm run pack:allmind -- --output <new directory>');
const output=resolve(process.argv[index+1]);if(existsSync(output))throw Error('Output already exists; select a new directory. No files were removed.');
const inside=relative(root,output),inSource=inside===''||(!isAbsolute(inside)&&inside!=='..'&&!inside.startsWith('..'+sep));
if(inSource&&!inside.startsWith('.local'+sep))throw Error('Use a separate output directory or .local/packages.');
for(const file of ['dist/app/book-backend.js','management/character-app/index.html','management/preview-runtime/presentation-preview.js','desktop/wpf/shell/bin/ALLMIND.Widget.exe','desktop/wpf/NODE-LICENSE.txt'])if(!existsSync(join(root,file)))throw Error('Build first: missing '+file);
const sourcePackage=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
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
copyTree(join(root,'dist'),join(output,'dist'),name=>name!=='tests'&&!name.endsWith('.d.ts'));
for(const directory of ['management/character-app','management/preview-runtime','desktop/assets','desktop/config','desktop/electron','desktop/build','desktop/chatgpt-extension'])copyTree(join(root,directory),join(output,directory));
mkdirSync(join(output,'tools'),{recursive:true});
for(const file of ['sprite-inspect.cjs','model-archive.ps1','management-url.mjs','harness-relay-mcp.mjs'])copyFileSync(join(root,'tools',file),join(output,'tools',file));
for(const name of readdirSync(join(root,'desktop')))if(/\.(?:mjs|js|html|css)$/.test(name))copyFileSync(join(root,'desktop',name),join(output,'desktop',name));
copyTree(join(root,'desktop/wpf'),join(output,'desktop/wpf'),name=>!['tests','.test-output','.tmp'].includes(name));
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
for(const name of [...Object.keys(sourcePackage.dependencies??{}),'electron'])copyPackage(name,root);
const electron=join(output,'node_modules/electron');if(!existsSync(join(electron,'dist/electron.exe')))throw Error('Installed Electron runtime is missing.');
mkdirSync(join(output,'runtime'),{recursive:true});copyFileSync(process.execPath,join(output,'runtime/node.exe'));
writeFileSync(join(output,'runtime/NODE-LICENSE.txt'),nodeLicense);
writeFileSync(join(output,'package.json'),JSON.stringify({name:'allmind-portable',version:sourcePackage.version,private:true,type:'module'},null,2)+'\n');
const repository=resolve(root,'../../..');for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md'])copyFileSync(join(repository,file),join(output,file));
const launcher=`Option Explicit\r\nDim fso, shell, root, command\r\nSet fso = CreateObject("Scripting.FileSystemObject")\r\nSet shell = CreateObject("WScript.Shell")\r\nroot = fso.GetParentFolderName(WScript.ScriptFullName)\r\ncommand = Chr(34) & root & "\\runtime\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\desktop\\wpf\\main.mjs" & Chr(34)\r\nIf WScript.Arguments.Count > 0 Then command = command & " --data " & Chr(34) & WScript.Arguments(0) & Chr(34)\r\nshell.Run command, 0, False\r\n`;
writeFileSync(join(output,'Start-ALLMIND.vbs'),launcher);
writeFileSync(join(output,'README.txt'),'ALLMIND Windows portable preview\r\n\r\nDouble-click Start-ALLMIND.vbs. Node and Electron are included. Windows x64, Windows PowerShell 5.1 and .NET Framework WPF are required.\r\nRight-click the pet to open chat, roles, memory or settings. Closing the pet hides it; Exit ALLMIND in the system tray stops it.\r\nUser data stays in %LOCALAPPDATA%/ALLMIND and is not in this package. New users start with GPT-Niang; persona and Wiki are empty.\r\nNo keys, accounts or sample chats are bundled. Live2D SDK, voice models, installer/signing and auto-update are not included.\r\nImage and quotation permissions are in desktop/wpf/shell/assets; keep all notices.\r\n');
const files=[];function inventory(base){for(const entry of readdirSync(base)){const file=join(base,entry),stat=lstatSync(file);if(stat.isSymbolicLink())throw Error('Output contains a link');if(stat.isDirectory())inventory(file);else files.push({path:relative(output,file).split(sep).join('/'),bytes:stat.size,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')});}}
inventory(output);writeFileSync(join(output,'package-manifest.json'),JSON.stringify({schemaVersion:1,platform:'win32-x64',node:process.version,dependencies:Object.fromEntries(copied),files},null,2)+'\n');
console.log(JSON.stringify({output,files:files.length,bytes:files.reduce((total,file)=>total+file.bytes,0),runtimePackages:copied.size}));

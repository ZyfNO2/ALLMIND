import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,renameSync,readdirSync,lstatSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {moduleClosure} from './profile-closure.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const id=arg('--id'),operation=process.argv[2];
const definitions={voice:{entry:'management/book-voice.js',resources:['desktop/voice/windows-speech.ps1']},screen:{entry:'core/book-screen.js',resources:['desktop/ocr/windows-runtime-ocr.ps1']},tools:{entry:'management/book-tools.js',resources:[]}};
if(!Object.hasOwn(definitions,id))throw Error('Use --id voice|screen|tools');
function collect(base){return readdirSync(base,{withFileTypes:true}).flatMap(row=>{const path=join(base,row.name);if(row.isSymbolicLink())throw Error('Linked module member');return row.isDirectory()?collect(path):[path];});}
if(operation==='pack'){
 const output=resolve(arg('--output')??'');if(!arg('--output')||existsSync(output))throw Error('Use a new --output directory');
 const definition=definitions[id],files=[...moduleClosure(join(root,'dist',definition.entry)),...definition.resources.map(p=>join(root,p))];
 mkdirSync(output,{recursive:true});const rows=[];
 for(const file of files){const path=relative(root,file).replaceAll('\\','/');if(path.startsWith('..'))throw Error('Escaped source');const target=join(output,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target);rows.push({path,sha256:hash(readFileSync(file))});}
 const manifest={schemaVersion:1,id,version:'1',appVersion:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,entry:'dist/'+definition.entry,requires:['allmind-module/v1'],permissions:id==='voice'?['microphone','speaker']:id==='tools'?['execute-after-local-confirmation']:['screen-after-confirmation'],enabled:true,files:rows};
 writeFileSync(join(output,'module.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({id,files:rows.length,manifestSha256:hash(readFileSync(join(output,'module.json')))}));
}else{
 if(!arg('--module-root'))throw Error('--module-root must be an explicit program-module directory, separate from Wiki data');
 const moduleRoot=resolve(arg('--module-root')),target=join(moduleRoot,id);
 if(relative(moduleRoot,target)!==id)throw Error('Invalid module target');
 if(operation==='install'){
  const source=resolve(arg('--source')??''),file=join(source,'module.json');
  if(!arg('--source')||hash(readFileSync(file))!==arg('--expected-manifest'))throw Error('Trusted manifest SHA-256 is required');
  const manifest=JSON.parse(readFileSync(file,'utf8'));if(manifest.id!==id||manifest.schemaVersion!==1||!Array.isArray(manifest.files))throw Error('Invalid module manifest');
  const sourcePaths=collect(source).map(file=>relative(source,file).replaceAll('\\','/')).sort();
  if(JSON.stringify(sourcePaths)!==JSON.stringify(['module.json',...manifest.files.map(row=>row.path)].sort()))throw Error('Uninventoried module content');
  const {safeMember}=await import('../dist/app/module-runtime.js');
  for(const row of manifest.files)if(hash(readFileSync(safeMember(source,row.path)))!==row.sha256)throw Error('Module checksum mismatch');
  mkdirSync(moduleRoot,{recursive:true});if(lstatSync(moduleRoot).isSymbolicLink())throw Error('Linked module root');
  const staged=join(moduleRoot,id+'.stage-'+randomUUID());mkdirSync(staged);
  for(const path of sourcePaths){const dest=join(staged,path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(source,path),dest);}
  // Old versions are retained for rollback; never delete unknown files.
  if(existsSync(target)){if(lstatSync(target).isSymbolicLink())throw Error('Linked module target');renameSync(target,join(moduleRoot,id+'.previous-'+randomUUID()));}
  renameSync(staged,target);console.log('Installed '+id+'; restart ALLMIND. User data was not touched.');
 }else if(operation==='disable'||operation==='enable'){
  const file=join(target,'module.json');if(lstatSync(target).isSymbolicLink()||lstatSync(file).isSymbolicLink())throw Error('Linked module');const manifest=JSON.parse(readFileSync(file,'utf8'));manifest.enabled=operation==='enable';writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');console.log('Restart ALLMIND to apply.');
 }else if(operation==='uninstall'){
  if(lstatSync(target).isSymbolicLink())throw Error('Linked module target');
  const manifest=JSON.parse(readFileSync(join(target,'module.json'),'utf8')),{safeMember}=await import('../dist/app/module-runtime.js');
  const files=collect(target),expected=['module.json',...manifest.files.map(row=>row.path)].sort();
  if(JSON.stringify(files.map(file=>relative(target,file).replaceAll('\\','/')).sort())!==JSON.stringify(expected))throw Error('Unknown files; uninstall refused');
  for(const row of manifest.files)if(hash(readFileSync(safeMember(target,row.path)))!==row.sha256)throw Error('Modified module; uninstall refused');
  const dirs=new Set();for(const file of files){let parent=dirname(file);while(parent!==moduleRoot){dirs.add(parent);parent=dirname(parent);}unlinkSync(file);}
  for(const dir of [...dirs].sort((a,b)=>b.length-a.length))rmdirSync(dir);
  console.log('Uninstalled '+id+'; Wiki and settings retained. Restart ALLMIND.');
 }else throw Error('Use pack|install|enable|disable|uninstall');
}

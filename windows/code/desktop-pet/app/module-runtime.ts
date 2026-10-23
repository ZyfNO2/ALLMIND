import {existsSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const appRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const moduleRoot=()=>resolve(process.env.ALLMIND_MODULE_ROOT??join(process.env.AIKI_BOOK_DATA?dirname(process.env.AIKI_BOOK_DATA):process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'ALLMIND'):appRoot,'modules'));
export function safeMember(root:string,path:string):string {
  if(typeof path!=='string'||!path||isAbsolute(path)||path.includes('\\')||path.split('/').some(part=>!part||part==='..'||part==='.'))throw Error('Invalid module member');
  const target=resolve(root,path),rel=relative(root,target);
  if(rel.startsWith('..')||isAbsolute(rel))throw Error('Module path escaped its root');
  if(lstatSync(target).isSymbolicLink()||!lstatSync(target).isFile()||relative(realpathSync(root),realpathSync(target)).startsWith('..'))throw Error('Module contains a linked or invalid member');
  return target;
}
export function installedModules():Record<string,string>{
  const result:Record<string,string>={};
  const version=JSON.parse(readFileSync(join(appRoot,'package.json'),'utf8')).version;
  for(const id of ['voice','screen','tools']){
    const root=join(moduleRoot(),id),file=join(root,'module.json');
    if(!existsSync(file))continue;
    if(lstatSync(root).isSymbolicLink()||lstatSync(file).isSymbolicLink())throw Error('Linked module descriptor');
    const manifest=JSON.parse(readFileSync(file,'utf8'));
    if(manifest.schemaVersion!==1||manifest.id!==id||manifest.appVersion!==version||!Array.isArray(manifest.files))throw Error('Incompatible module: '+id);
    for(const row of manifest.files){const member=safeMember(root,row.path);if(createHash('sha256').update(readFileSync(member)).digest('hex')!==row.sha256)throw Error('Module integrity failed: '+id+'/'+row.path);}
    if(manifest.enabled===false)continue;
    if(!manifest.files.some((row:{path:string})=>row.path===manifest.entry))throw Error('Module entry is not inventoried');
    result[id]=pathToFileURL(safeMember(root,manifest.entry)).href;
  }
  return result;
}

/** Active entries and installed-but-disabled descriptors are different product states. */
export function moduleStates(active:Record<string,string>):Record<string,{installed:boolean;enabled:boolean}>{
  return Object.fromEntries(['voice','screen','tools'].map(id=>[id,{installed:existsSync(join(moduleRoot(),id,'module.json')),enabled:Boolean(active[id])}]));
}

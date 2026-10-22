import {openSync,closeSync,readFileSync,writeFileSync,fsyncSync,lstatSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Reclaim only a proven-dead writer. A separate exclusive guard serializes reclaimers. */
export function acquireBookWriterLock(directory:string):number{
 const filename=join(directory,'writer.lock');
 try{return openSync(filename,'wx');}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const guard=join(directory,'writer.recovery.lock'),fd=openSync(guard,'wx',0o600);
 try{
  writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));fsyncSync(fd);
  const before=lstatSync(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.size>1024)throw Error('Writer lock is not a bounded regular file.');
  const text=readFileSync(filename,'utf8'),owner=JSON.parse(text) as {pid?:number;startedAt?:string};
  if(!Number.isSafeInteger(owner.pid)||owner.pid!<=0||typeof owner.startedAt!=='string'||!Number.isFinite(Date.parse(owner.startedAt)))throw Error('Writer identity is malformed.');
  const dead=()=>{try{process.kill(owner.pid!,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}};
  if(!dead())throw Error('Writer process is still alive.');
  const after=lstatSync(filename);
  if(after.isSymbolicLink()||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||readFileSync(filename,'utf8')!==text||!dead())throw Error('Writer lock identity changed during recovery.');
  renameSync(filename,join(directory,`writer.lock.stale-${owner.pid}-${randomUUID()}`));
  // A normal writer may win this open; never remove or replace its new lock.
  return openSync(filename,'wx');
 }finally{closeSync(fd);unlinkSync(guard);}
}

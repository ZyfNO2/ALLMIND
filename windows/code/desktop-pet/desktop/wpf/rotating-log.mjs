import {Writable} from 'node:stream';
import {existsSync,lstatSync,openSync,closeSync,writeSync,renameSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';

/** Bounded, exact-name host logs. A failed write is an error, never silently discarded. */
export function createRotatingLog(path,{maxBytes=5*1024*1024,archives=3}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(archives)||archives<1||archives>10)throw Error('Invalid log retention limits');
 const file=resolve(path);let fd=null,size=0;
 const check=target=>{if(existsSync(target)&&(!lstatSync(target).isFile()||lstatSync(target).isSymbolicLink()))throw Error('Log path must be a regular file');};
 const open=()=>{check(file);fd=openSync(file,'a',0o600);size=lstatSync(file).size;};
 const rotate=()=>{closeSync(fd);fd=null;for(let index=archives;index>=1;index--){const target=file+'.'+index,source=index===1?file:file+'.'+(index-1);check(target);check(source);if(index===archives&&existsSync(target))unlinkSync(target);if(existsSync(source))renameSync(source,target);}open();};
 open();
 return new Writable({write(chunk,_encoding,done){try{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);for(let offset=0;offset<bytes.length;){if(size>=maxBytes)rotate();const length=Math.min(maxBytes-size,bytes.length-offset);let written=0;while(written<length)written+=writeSync(fd,bytes,offset+written,length-written);size+=length;offset+=length;}done();}catch(error){done(error);}},final(done){try{if(fd!==null){closeSync(fd);fd=null;}done();}catch(error){done(error);}},destroy(error,done){try{if(fd!==null){closeSync(fd);fd=null;}done(error);}catch(failure){done(failure);}}});
}

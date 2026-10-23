import {resolve,join} from 'node:path';
import {closeSync,unlinkSync} from 'node:fs';
import {acquireBookWriterLock} from '../dist/memory/book-writer-lock.js';
import {rollbackBookStorage} from '../dist/memory/book-storage-format.js';
const position=process.argv.indexOf('--data');
if(process.argv[2]!=='rollback'||position<0||!process.argv[position+1]||!process.argv.includes('--confirm'))throw Error('Usage: node tools/book-schema.mjs rollback --data <directory> --confirm (quit ALLMIND first; changed data is never overwritten)');
const directory=resolve(process.argv[position+1]),lock=acquireBookWriterLock(directory);
try{rollbackBookStorage(directory,true);console.log(JSON.stringify({status:'PASS',operation:'schema rollback',note:'Only unchanged pre-migration envelopes restored; start the prior program version. A current program will migrate again.'}));}finally{closeSync(lock);unlinkSync(join(directory,'writer.lock'));}

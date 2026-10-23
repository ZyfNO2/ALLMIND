import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {BookError} from '../contracts/memory-book.js';
import {replaceResourceFile} from './resource-atomic-replace.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const marker='storage-format.json',journal='schema-migration.json',backup='schema-backup-v1';
type Row={name:string;before:string;after:string};
interface Migration {schemaVersion:'allmind-migration/v1';state:'prepared'|'complete'|'rollback-prepared'|'rolled-back'|'invalidated';files:Row[]}
function read(directory:string,name:string):string{
 const file=join(directory,name),stat=lstatSync(file);
 if(stat.isSymbolicLink()||!stat.isFile()||stat.size>128*1024*1024)throw new BookError('corrupt_data','迁移文件身份或大小无效。');
 return readFileSync(file,'utf8');
}
function atomic(directory:string,name:string,text:string):void{
 const target=join(directory,name);if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new BookError('corrupt_data','拒绝覆盖链接迁移文件。');
 const temp=target+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);
 try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}replaceResourceFile(temp,target);
}
function validateMigration(value:Migration):void{
 if(value?.schemaVersion!=='allmind-migration/v1'||!['prepared','complete','rollback-prepared','rolled-back','invalidated'].includes(value.state)||!Array.isArray(value.files)||value.files.length>512||new Set(value.files.map(row=>row.name)).size!==value.files.length)throw new BookError('corrupt_data','Schema 迁移日志无效。');
 for(const row of value.files)if(!/^(runtime|book-[a-f0-9]+)\.json$/.test(row.name)||![row.before,row.after].every(h=>/^[a-f0-9]{64}$/.test(h)))throw new BookError('corrupt_data','Schema 迁移目标无效。');
}
function encodeLegacy(text:string,name:string):string{
 let envelope;try{envelope=JSON.parse(text);}catch(cause){throw new BookError('corrupt_data','迁移前快照不是有效 JSON。',{cause});}
 const expected=name==='runtime.json'?'memory-runtime/v1':'memory-book/v1';
 if(envelope?.data?.schemaVersion!==expected||!envelope.operations||typeof envelope.operations!=='object'||Array.isArray(envelope.operations)||!Number.isSafeInteger(envelope.data.revision)||envelope.data.revision<0)throw new BookError('corrupt_data','不支持或损坏的数据版本；未执行迁移。');
 envelope.data.schemaVersion=expected.replace('/v1','/v2');
 return JSON.stringify(envelope)+'\n';
}
/** The public runtime contract remains v1; v2 is an on-disk reader barrier for older binaries. */
export function decodeStorageEnvelope<T>(value:T):T{
 const row=value as {data?:{schemaVersion?:string}};
 if(row?.data?.schemaVersion==='memory-runtime/v2')row.data.schemaVersion='memory-runtime/v1';
 else if(row?.data?.schemaVersion==='memory-book/v2')row.data.schemaVersion='memory-book/v1';
 return value;
}
export function encodeStorageEnvelope<T>(value:T):T{
 const output=structuredClone(value),row=output as {data?:{schemaVersion?:string}};
 if(row?.data?.schemaVersion==='memory-runtime/v1')row.data.schemaVersion='memory-runtime/v2';
 else if(row?.data?.schemaVersion==='memory-book/v1')row.data.schemaVersion='memory-book/v2';
 return output;
}
/** Caller holds the directory's exclusive Book writer lock. No original bytes are discarded. */
export function migrateBookStorage(directory:string,afterWrite?:(index:number)=>void):void{
 let current:Migration|undefined;
 if(existsSync(join(directory,journal))){current=JSON.parse(read(directory,journal));validateMigration(current!);}
 if(existsSync(join(directory,marker))){
  const version=JSON.parse(read(directory,marker));
  if(version?.schemaVersion!=='allmind-storage/v1'||![1,2].includes(version.format)||!Number.isInteger(version.minimumReader)||version.minimumReader>2)throw new BookError('corrupt_data','数据由更新版本创建；本版本拒绝打开或写入，请升级程序。');
  if(version.format===2&&current?.state!=='prepared'&&current?.state!=='rollback-prepared')return;
 }
 if(current?.state==='rollback-prepared'){finishRollback(directory,current);return;}
 if(!current||current.state==='rolled-back'){
  const names=readdirSync(directory).filter(name=>/^(runtime|book-[a-f0-9]+)\.json$/.test(name));
  if(names.length>512)throw new BookError('budget','迁移文件超过512份；保留原件，未迁移。');
  const inputs=names.map(name=>{const text=read(directory,name),next=encodeLegacy(text,name);return {name,text,next};});
  const size=inputs.reduce((sum,row)=>sum+Buffer.byteLength(row.text)+Buffer.byteLength(row.next),0);if(size>256*1024*1024)throw new BookError('budget','迁移总量超过256 MiB；未执行不完整迁移。');
  const destination=join(directory,backup);mkdirSync(destination,{recursive:true});if(lstatSync(destination).isSymbolicLink())throw new BookError('corrupt_data','迁移备份目录不能为链接。');
  for(const row of inputs){const saved=join(destination,row.name);if(existsSync(saved)){if(read(destination,row.name)!==row.text)throw new BookError('conflict','既有迁移备份不同；保留两端，未覆盖。');}else atomic(destination,row.name,row.text);}
  current={schemaVersion:'allmind-migration/v1',state:'prepared',files:inputs.map(row=>({name:row.name,before:hash(row.text),after:hash(row.next)}))};atomic(directory,journal,JSON.stringify(current)+'\n');
 }
 validateMigration(current);
 for(const [index,row] of current.files.entries()){
  const original=read(join(directory,backup),row.name);if(hash(original)!==row.before)throw new BookError('corrupt_data','迁移备份校验失败，停止恢复。');
  const now=read(directory,row.name),next=encodeLegacy(original,row.name);if(hash(next)!==row.after)throw new BookError('corrupt_data','迁移结果校验失败。');
  if(hash(now)===row.before)atomic(directory,row.name,next);else if(hash(now)!==row.after)throw new BookError('conflict','迁移目标被其他写者改变，未覆盖。');
  afterWrite?.(index);
 }
 atomic(directory,marker,JSON.stringify({schemaVersion:'allmind-storage/v1',format:2,minimumReader:2})+'\n');
 current.state='complete';atomic(directory,journal,JSON.stringify(current)+'\n');
}
function finishRollback(directory:string,current:Migration):void{
 for(const row of current.files){const bytes=read(join(directory,backup),row.name);if(hash(bytes)!==row.before)throw new BookError('corrupt_data','回滚备份损坏。');const now=hash(read(directory,row.name));if(now!==row.before&&now!==row.after)throw new BookError('conflict','升级后数据已有修改，禁止无损声明或覆盖回滚。');}
 for(const row of current.files)atomic(directory,row.name,read(join(directory,backup),row.name));
 atomic(directory,marker,JSON.stringify({schemaVersion:'allmind-storage/v1',format:1,minimumReader:1})+'\n');current.state='rolled-back';atomic(directory,journal,JSON.stringify(current)+'\n');
}
/** Offline rollback refuses every post-migration change, including newly created Book files. */
export function rollbackBookStorage(directory:string,confirmed:boolean):void{
 if(confirmed!==true)throw new BookError('invalid_input','Schema 回滚需要明确确认，并先退出所有实例。');
 const current=JSON.parse(read(directory,journal)) as Migration;validateMigration(current);
 if(current.state!=='complete'&&current.state!=='rollback-prepared')throw new BookError('conflict','当前没有可回滚的完整迁移。');
 const names=readdirSync(directory).filter(name=>/^(runtime|book-[a-f0-9]+)\.json$/.test(name));
 if(names.some(name=>!current.files.some(row=>row.name===name)))throw new BookError('conflict','升级后新增了数据文件，禁止覆盖回滚；请恢复到独立目录。');
 for(const row of current.files){if(hash(read(join(directory,backup),row.name))!==row.before||![row.after,...(current.state==='rollback-prepared'?[row.before]:[])].includes(hash(read(directory,row.name))))throw new BookError('conflict','升级后数据变化或备份损坏，拒绝回滚。');}
 current.state='rollback-prepared';atomic(directory,journal,JSON.stringify(current)+'\n');finishRollback(directory,current);
}
/** Raw erasure also invalidates the app-owned pre-migration copy for this exact role. */
export function eraseMigrationBackup(directory:string,name:string):void{
 if(!/^book-[a-f0-9]+\.json$/.test(name))throw new BookError('invalid_input','迁移副本目标无效。');
 if(!existsSync(join(directory,journal)))return;
 const current=JSON.parse(read(directory,journal)) as Migration;validateMigration(current);
 if(!current.files.some(row=>row.name===name))return;
 current.state='invalidated';atomic(directory,journal,JSON.stringify(current)+'\n');
 const destination=join(directory,backup);if(!existsSync(destination))return;if(lstatSync(destination).isSymbolicLink())throw new BookError('corrupt_data','迁移副本目录为链接，未清除。');
 const target=join(destination,name);if(existsSync(target)){read(destination,name);unlinkSync(target);}
}

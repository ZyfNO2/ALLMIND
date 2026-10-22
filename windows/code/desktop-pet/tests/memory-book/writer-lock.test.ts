import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {emptyEntry} from '../../contracts/memory-book.js';

const scope={characterId:'aika',pairingId:'local-user',sessionId:'crash'};
function directory(t:test.TestContext){const dir=mkdtempSync(join(tmpdir(),'book-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('dead child writer is archived and recovered without changing its committed book',t=>{
 const dir=mkdtempSync(join(tmpdir(),'book-lock-')),moduleUrl=pathToFileURL(resolve('dist/memory/file-book-repository.js')).href;let repo:FileBookRepository|undefined;
 t.after(()=>{repo?.close();rmSync(dir,{recursive:true,force:true});});
 const entry=emptyEntry('before-crash','wiki','停机前记录','必须保留。');
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {FileBookRepository} from ${JSON.stringify(moduleUrl)};const r=new FileBookRepository(process.argv[1]);r.commit(${JSON.stringify(scope)},{upsert:[${JSON.stringify(entry)}]},0,'seed');process.exit(0);`,dir],{encoding:'utf8',windowsHide:true});
 assert.equal(child.status,0,child.stderr);const old=readFileSync(join(dir,'writer.lock'),'utf8');repo=new FileBookRepository(dir);
 const archive=readdirSync(dir).filter(name=>name.startsWith('writer.lock.stale-'));assert.equal(archive.length,1);assert.equal(readFileSync(join(dir,archive[0]!),'utf8'),old);
 assert.equal(repo.snapshot(scope).entries[0]!.body,'必须保留。');assert.equal(JSON.parse(readFileSync(join(dir,'writer.lock'),'utf8')).pid,process.pid);
 assert.throws(()=>new FileBookRepository(dir),{code:'busy'});assert.equal(readdirSync(dir).filter(name=>name.startsWith('writer.lock.stale-')).length,1);
});

test('simultaneous recovery attempts admit exactly one live writer',{timeout:15000},async t=>{
 const dir=directory(t),moduleUrl=pathToFileURL(resolve('dist/memory/file-book-repository.js')).href;
 const seed=spawnSync(process.execPath,['--input-type=module','-e',`import {FileBookRepository} from ${JSON.stringify(moduleUrl)};new FileBookRepository(process.argv[1]);process.exit(0);`,dir],{encoding:'utf8',windowsHide:true});assert.equal(seed.status,0,seed.stderr);
 const children=Array.from({length:3},()=>spawn(process.execPath,['--input-type=module','-e',`import {FileBookRepository} from ${JSON.stringify(moduleUrl)};let repo;process.on('message',message=>{if(message==='start'){try{repo=new FileBookRepository(process.argv[1]);process.send({result:'writer'});}catch(error){process.send({result:'busy',code:error.code});}}else if(message==='exit'){repo?.close();process.exit(0);}});process.send({ready:true});`,dir],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']}));
 const exits=children.map(child=>new Promise<void>(resolve=>child.once('exit',()=>resolve())));
 try{
  await Promise.all(children.map(child=>new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('message',message=>{assert.equal((message as any).ready,true);resolve();});})));
  const outcomes=children.map(child=>new Promise<{result:string;code?:string}>(resolve=>child.once('message',message=>resolve(message as any))));
  for(const child of children)child.send('start');const results=await Promise.all(outcomes);
  assert.equal(results.filter(row=>row.result==='writer').length,1);assert.equal(results.filter(row=>row.code==='busy').length,2);
  assert.equal(readdirSync(dir).filter(name=>name.startsWith('writer.lock.stale-')).length,1);
 }finally{for(const child of children)if(child.connected)child.send('exit');await Promise.all(exits);}
});
test('malformed, live-owner and occupied recovery locks are not reclaimed or deleted',t=>{
 const dir=directory(t),lock=join(dir,'writer.lock');
 for(const text of ['{broken',JSON.stringify({pid:-1,startedAt:new Date().toISOString()}),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})]){
  writeFileSync(lock,text);assert.throws(()=>new FileBookRepository(dir),{code:'busy'});assert.equal(readFileSync(lock,'utf8'),text);
 }
 writeFileSync(join(dir,'writer.recovery.lock'),'another recovery');const before=readFileSync(lock,'utf8');assert.throws(()=>new FileBookRepository(dir),{code:'busy'});assert.equal(readFileSync(lock,'utf8'),before);assert.equal(readFileSync(join(dir,'writer.recovery.lock'),'utf8'),'another recovery');
 assert.equal(readdirSync(dir).filter(name=>name.startsWith('writer.lock.stale-')).length,0);
});

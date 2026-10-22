import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {replaceResourceFile} from '../../memory/resource-atomic-replace.js';

async function lock(path:string,milliseconds:number){
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop';$file=[IO.File]::Open($env:ALLMIND_TEST_REPLACE_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::WriteLine('READY');[Console]::Out.Flush();Start-Sleep -Milliseconds ${milliseconds}}finally{$file.Dispose()}`],{windowsHide:true,env:{...process.env,ALLMIND_TEST_REPLACE_FILE:path},stdio:['ignore','pipe','pipe']});
 let error='';child.stderr.on('data',chunk=>error+=chunk.toString());const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Lock helper readiness timeout'))},10000);child.once('error',reject);child.stdout.once('data',chunk=>{clearTimeout(timer);String(chunk).includes('READY')?resolve():reject(Error('Unexpected lock helper output'))});child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(Error('Lock helper failed: '+error))})});return {child,closed};
}
test('Windows bounded replace survives transient reader denial and preserves both files on persistent failure',{timeout:20000,skip:process.platform!=='win32'},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'allmind-activity-replace-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const target=join(directory,'activity.json'),next=target+'.next';writeFileSync(target,'old');writeFileSync(next,'new');
 const short=await lock(target,100);try{replaceResourceFile(next,target);assert.equal(readFileSync(target,'utf8'),'new')}finally{short.child.kill();await short.closed}
 writeFileSync(next,'latest');const long=await lock(target,3000);try{assert.throws(()=>replaceResourceFile(next,target));assert.equal(readFileSync(target,'utf8'),'new');assert.equal(readFileSync(next,'utf8'),'latest');assert.ok(existsSync(next))}finally{long.child.kill();await long.closed}
});

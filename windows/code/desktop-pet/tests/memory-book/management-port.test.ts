import test from 'node:test';
import assert from 'node:assert/strict';
import {Server,createServer} from 'node:http';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {BookCredentials} from '../../management/book-credentials.js';
import {startBookServer} from '../../management/book-server.js';

async function fixture(t:any,port?:number){
 mkdirSync('.local/memory-book-tests',{recursive:true});const repo=new FileBookRepository(mkdtempSync(resolve('.local/memory-book-tests/port-')));
 t.after(()=>repo.close());return startBookServer({runtime:new BookRuntime(repo,{async complete(){throw Error('No model calls')}}),credentials:new BookCredentials(join(repo.directory,'credentials')),uiRoot:resolve('management'),...(port===undefined?{}:{port})});
}
test('automatic Book management ports are browser-accessible high ports, independent of OS ephemeral range',async t=>{
 const server=await fixture(t);t.after(()=>server.close());const port=Number(new URL(server.url).port);assert.ok(port>=49152&&port<=65535,`unsafe automatic range: ${port}`);
 assert.equal((await fetch(new URL('/api/memory-book/v1/runtime',server.url),{headers:{Authorization:'Bearer '+server.token}})).status,200);
});
test('automatic port selection retries occupied or Windows-reserved ports without leaving listening callbacks',async t=>{
 const original=Server.prototype.listen;let calls=0,baseListening=0,baseErrors=0;
 const mocked=t.mock.method(Server.prototype,'listen',function(this:Server,...args:any[]){calls++;if(calls===1){baseListening=this.listenerCount('listening')-1;baseErrors=this.listenerCount('error')-1;}if(calls<=2){queueMicrotask(()=>this.emit('error',Object.assign(Error('reserved fixture'),{code:calls===1?'EADDRINUSE':'EACCES'})));return this;}return (original as any).apply(this,args);});
 const server=await fixture(t);mocked.mock.restore();t.after(()=>server.close());assert.equal(calls,3);assert.equal(server.server.listenerCount('listening'),baseListening);assert.equal(server.server.listenerCount('error'),baseErrors);
});
test('an explicitly requested occupied Book port fails instead of silently changing its endpoint',async t=>{
 const occupied=createServer();await new Promise<void>(done=>occupied.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>occupied.close(()=>done())));const address=occupied.address();assert.ok(address&&typeof address!=='string');
 await assert.rejects(fixture(t,address.port),(error:any)=>error.code==='EADDRINUSE');
});

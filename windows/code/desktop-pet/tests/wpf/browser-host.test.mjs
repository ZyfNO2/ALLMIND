import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {startBrowserHost} from '../../desktop/wpf/browser-channel.mjs';

test('real GUI Electron accepts multiple named-pipe requests with stdin ignored and exits on channel close',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const data=await mkdtemp(join(tmpdir(),'allmind-browser-pipe-'));
 const host=await startBrowserHost({executable:createRequire(import.meta.url)('electron'),script:fileURLToPath(new URL('../../desktop/wpf/browser-host.mjs',import.meta.url)),data});
 try{
  await assert.rejects(host.request('first',{action:'invalid'}),/未知/);
  await delay(500);assert.equal(host.closed,false,'GUI stdin EOF must not terminate the host');
  await assert.rejects(host.request('second',{action:'invalid'}),/未知/);
 }finally{await host.close();assert.equal(host.closed,true);await rm(data,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

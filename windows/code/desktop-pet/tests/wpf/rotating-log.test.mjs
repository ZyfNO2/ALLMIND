import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {finished} from 'node:stream/promises';
import {createRotatingLog} from '../../desktop/wpf/rotating-log.mjs';
test('log retention bounds complete writes, rotates exact owned files, and preserves unrelated files',async()=>{
 const root=resolve('.local/user-data-closure-tests');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'logs-')),file=join(directory,'runtime.log');
 const log=createRotatingLog(file,{maxBytes:10,archives:2});log.end('0123456789abcdefghijABCDEFGHIJxyz');await finished(log);
 assert.equal(readFileSync(file,'utf8'),'xyz');assert.equal(readFileSync(file+'.1','utf8'),'ABCDEFGHIJ');assert.equal(readFileSync(file+'.2','utf8'),'abcdefghij');assert.equal(readdirSync(directory).length,3);
 const next=createRotatingLog(file,{maxBytes:10,archives:2});next.end('123');await finished(next);assert.equal(readFileSync(file,'utf8'),'xyz123');
});

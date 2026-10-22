import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WindowsBookOcr} from '../../providers/windows-book-ocr.js';

test('Windows WinRT OCR reads English and Chinese pixels and preserves a blank result without capture or cloud',{timeout:45000,skip:process.platform!=='win32'},async()=>{
 const engine=new WindowsBookOcr(),signal=AbortSignal.timeout(40000),caps=await engine.capabilities(signal);assert.equal(caps.available,true);
 for(const file of ['english.png','simplified-chinese.png']){
  const result=await engine.recognize(readFileSync('tests/companion-knowledge/fixtures/ocr/'+file),signal);assert.equal(result.status,'ok');assert.ok(result.readingOrderText.includes('10'));assert.ok(result.readingOrderText.includes('30'));assert.ok(result.readingOrderText.includes('42'));
  if(file==='english.png')assert.match(result.readingOrderText,/Meet.*room/);else assert.match(result.readingOrderText,/号房间开会/);assert.ok(result.blocks.every(row=>row.confidence===null));
 }
 assert.equal((await engine.recognize(readFileSync('tests/companion-knowledge/fixtures/ocr/blank.png'),signal)).readingOrderText,'');
});

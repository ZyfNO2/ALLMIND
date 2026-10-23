import test from 'node:test';
import assert from 'node:assert/strict';
import {speechChunks} from '../../core/speech-chunks.js';
test('speech playback chunks preserve all Unicode/punctuation/whitespace and bound every synthesis request',()=>{
 const text=('开头😀，这是长回复。\n下一段👩‍💻仍保持全部文字！ ').repeat(140),chunks=speechChunks(text,500);
 assert.ok(chunks.length>3);assert.equal(chunks.join(''),text);assert.ok(chunks.every(row=>Array.from(row).length<=500&&row.trim()));
 assert.throws(()=>speechChunks('a'.repeat(20001)),/最多20000/);assert.throws(()=>speechChunks(' '));assert.throws(()=>speechChunks('abc\0def'));assert.throws(()=>speechChunks('hello',0));
});

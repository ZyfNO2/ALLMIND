import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowsBookSpeech} from '../../providers/windows-book-speech.js';
import {inspectPcmWav} from '../../media/wav.js';

test('Windows local speech synthesizes and recognizes a multi-sentence WAV without microphone or speaker',{timeout:60000,skip:process.platform!=='win32'},async t=>{
 const speech=new WindowsBookSpeech(),signal=AbortSignal.timeout(55000),capabilities=await speech.capabilities(signal);
 const voice=capabilities.voices.find(row=>row.culture==='zh-CN');
 if(!voice||!capabilities.recognizers.some(row=>row.culture==='zh-CN')){t.skip('Chinese Windows synthesis/recognition components are not installed');return;}
 const audio=await speech.synthesize('你好，今天的天气很好。我们一起完成测试。',voice.name,signal),wav=inspectPcmWav(audio.bytes);
 assert.equal(wav.channels,1);assert.equal(wav.sampleRate,16000);assert.ok(wav.durationMs>1000);
 const result=await speech.recognize(audio.bytes,'zh-CN',signal);
 assert.ok(result.text.includes('天气很好'));assert.ok(result.text.includes('完成测试'));assert.ok(result.segments.length>=2,'file EOF must preserve all recognized sentences');
});

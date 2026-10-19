import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {validateRuntime} from '../../memory/book-validation.js';
import {countReplyChars,measureReplyLength,replyLengthInstruction} from '../../core/reply-length.js';

function fixture(t:test.TestContext){mkdirSync('.local/ui-v4/tests',{recursive:true});const repo=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/reply-length-'));t.after(()=>repo.close());return repo;}
test('counting uses graphemes and preserves literal code while excluding formatting and hidden citations',()=>{
 assert.equal(countReplyChars('你好，A1! 👨‍👩‍👧‍👦 e\u0301'),8);
 assert.equal(countReplyChars('**你好** [世界](https://example.com) `a*b`'),7);
 assert.equal(countReplyChars('```js\na*b\n```'),3);
 assert.equal(countReplyChars('你好citesource'),2);
 assert.equal(countReplyChars('<ruby>你好<rt>こんにちは</rt></ruby>'),2);
 assert.equal(measureReplyLength('你好',{minChars:1,maxChars:1})?.status,'too-long');
 assert.equal(measureReplyLength('你好',{minChars:null,maxChars:2})?.status,'within');
 assert.equal(measureReplyLength('你好',{minChars:2,maxChars:null})?.status,'within');
 assert.equal(measureReplyLength('你好',{minChars:null,maxChars:null}),null);
 assert.match(replyLengthInstruction({minChars:null,maxChars:null}),/不沿用旧轮次/);
});
test('reply length rejects invalid ranges on the backend rather than silently saving them',t=>{
 const repo=fixture(t),config=repo.loadConfig();
 for(const range of [{minChars:150,maxChars:50},{minChars:0,maxChars:null},{minChars:1.5,maxChars:100},{minChars:null,maxChars:20001},{minChars:'50',maxChars:150},{minChars:null,maxChars:NaN}]){
  assert.throws(()=>validateRuntime({...config,characters:[{...config.characters[0],replyLength:range}]} as any),{code:'invalid_input'});
 }
});
test('ordinary and incognito replies receive the role range, preserve deviating text, and never auto resend',async t=>{
 const repo=fixture(t),config=repo.loadConfig();
 repo.commitConfig({...config,characters:[{...config.characters[0],replyLength:{minChars:50,maxChars:150}}],mainModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:512}} as any,config.revision,'length-config');
 const calls:string[]=[];const runtime=new BookRuntime(repo,{async complete(_binding,messages){calls.push(JSON.stringify(messages));return '你好。'}}),scope={characterId:'aika',pairingId:'local-user',sessionId:'ordinary'};
 const result=await runtime.chat(scope,'你好',new AbortController().signal);
 assert.match(calls[0]!,/50.*150/);assert.equal(result.turn.assistant,'你好。');
 assert.match(JSON.stringify(result.turn),/"status":"too-short"/);assert.equal(calls.length,1);
 await runtime.chat({...scope,sessionId:'private'},'你好',new AbortController().signal,{incognito:true});
 assert.match(calls[1]!,/50.*150/);assert.equal(repo.readSession({...scope,sessionId:'private'}).length,0);
 await runtime.proactive({...scope,sessionId:'proactive'},'问候',new AbortController().signal);
 assert.doesNotMatch(calls[2]!,/回复字数/);assert.equal(calls.length,3);
});

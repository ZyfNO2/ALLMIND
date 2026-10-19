import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {focusState} from '../../core/book-focus.js';

test('focus deadline persists, expires once after sleep and manual reset cancels the completion',t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/focus-'));t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'focus'},runtime=new BookRuntime(repository,{async complete(){throw Error('timer must not call a model')}}),now=Date.now();
  runtime.setFocus(scope,true,25,now);const started=repository.loadCompanionData(scope);assert.equal(started.focusTimer!.until,now+25*60000);
  assert.equal(focusState(repository,scope,now-60000).focus,true);assert.equal(focusState(repository,{...scope,pairingId:'other'},now).focus,undefined);
  repository.close();const reopened=new FileBookRepository(repository.directory);t.after(()=>reopened.close());assert.equal(focusState(reopened,scope,now+24*60000).focus,true);
  const expired=focusState(reopened,scope,now+45*60000);assert.equal(expired.focus,false);assert.equal(expired.focusTimer!.completedAt,now+45*60000);assert.deepEqual(focusState(reopened,scope,now+46*60000),expired);
  const next=new BookRuntime(reopened,{async complete(){throw Error('timer must stay local')}});next.setFocus(scope,true,15,now+50*60000);next.setFocus(scope,false);assert.equal(focusState(reopened,scope,now+100*60000).focusTimer,undefined);
  assert.throws(()=>next.setFocus(scope,true,0),/15\/25\/45/);
  next.setFocus(scope,true,45,now);next.setFocus(scope,false,undefined,now+5*60000,'pause');
  const paused=focusState(reopened,scope,now+100*60000);assert.equal(paused.focus,false);assert.equal(paused.focusTimer!.pausedRemainingMs,40*60000);
  reopened.close();const resumed=new FileBookRepository(repository.directory);t.after(()=>resumed.close());
  const resumedRuntime=new BookRuntime(resumed,{async complete(){throw Error('paused timer must stay local')}});
  assert.equal(focusState(resumed,scope,now+101*60000).focusTimer!.pausedRemainingMs,40*60000);
  assert.throws(()=>resumedRuntime.setFocus(scope,false,undefined,now+101*60000,'resume'),/未暂停/);
  resumedRuntime.setFocus(scope,true,undefined,now+101*60000,'resume');
  assert.equal(resumed.loadCompanionData(scope).focusTimer!.until,now+141*60000);
  assert.equal(focusState(resumed,scope,now+140*60000).focus,true);
  assert.equal(focusState(resumed,scope,now+142*60000).focus,false);
});

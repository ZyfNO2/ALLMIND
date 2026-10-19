import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {FactWikiService} from '../../memory/fact-wiki.js';
import {weeklyReview} from '../../memory/weekly-review.js';

test('weekly review counts local-day valid records across sessions, deduplicates facts, excludes private/foreign/future and reflects erasure',t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/week-'));t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'one'},now=Date.now()+10000,wiki=new FactWikiService(repository);
  assert.equal(weeklyReview(repository,scope,now).turns,0);
  for(const [id,sessionId,pairingId,offset] of [['first','one','local-user',0],['second','two','local-user',-86400000],['old','one','local-user',-8*86400000],['future','two','local-user',86400000],['foreign','one','other',0]] as const){
    const target={...scope,sessionId,pairingId},turn={id,characterId:'aika',pairingId,sessionId,timestamp:new Date(now+offset).toISOString(),user:'饮品：白茶',assistant:'记住了',traceId:'trace-'+id};repository.appendTurn(target,turn);repository.appendTurn(target,turn);
  }
  assert.throws(()=>repository.appendTurn(scope,{id:'private',characterId:'aika',pairingId:'local-user',sessionId:'one',timestamp:new Date(now).toISOString(),user:'私密内容',assistant:'私密回答',traceId:'trace-private',incognito:true}),/无痕/);
  for(const id of ['original','duplicate']){const p=wiki.preview(scope,{sourceId:id,title:'用户',text:'饮品：白茶',private:true});wiki.apply(scope,p.id,'source-'+id)}
  const review=weeklyReview(repository,scope,now);assert.equal(review.turns,2);assert.equal(review.chatDays,2);assert.equal(review.newMemories,1);assert.equal(review.memories[0]!.quote,'饮品：白茶');assert.equal(review.memories[0]!.value,'白茶');assert.equal(review.days.length,7);assert.equal(review.timezone,'Asia/Singapore');
  const before=repository.snapshot(scope),ids=before.entries.filter(entry=>entry.fact?.value==='白茶').map(entry=>entry.id);repository.commit(scope,{remove:ids},before.revision,'forget');assert.equal(weeklyReview(repository,scope,now).newMemories,0);
  repository.eraseTurns(scope,['first'],repository.snapshot(scope).revision);assert.equal(weeklyReview(repository,scope,now).turns,1);assert.equal(repository.readSession({...scope,pairingId:'other'}).length,1);
});

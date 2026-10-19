import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../contracts/book-companion.js';
import {filterEntryTime} from '../../memory/book-time-filter.js';

test('time filtering separates source capture, explicitly reported occurrence and future plans in lists and graphs',async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/time-'));t.after(()=>repository.close());
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},config.revision,'seed');
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'time'},runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  for(const text of ['2026-10-12 上午九点 A公司面试已经结束，通过了','面试安排：2026-10-20 下午三点 B公司面试']){await runtime.chat(scope,text,new AbortController().signal);await runtime.automaticMemory!.flush();}
  const book=repository.snapshot(scope),base={from:'2026-10-12',to:'2026-10-12',timezone:'Asia/Singapore'};
  const occurred=filterEntryTime(book,book.entries,{...base,basis:'occurred'});assert.equal(occurred.length,1);assert.match(occurred[0]!.body,/A公司/);
  assert.equal(filterEntryTime(book,book.entries,{...base,basis:'planned'}).length,0);
  const planned=filterEntryTime(book,book.entries,{...base,basis:'planned',from:'2026-10-20',to:'2026-10-20'});assert.equal(planned.length,1);assert.match(planned[0]!.body,/B公司/);
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  assert.equal(filterEntryTime(book,book.entries,{...base,basis:'recorded',from:today,to:today}).length,book.entries.length);
  const graph=runtime.wiki.graph(scope,undefined,false,{...base,basis:'occurred'});assert.ok(graph.nodes.length>0);assert.ok(graph.nodes.filter(node=>node.kind==='page').every(node=>node.entryIds.every(id=>occurred.some(entry=>entry.id===id))));
  assert.throws(()=>filterEntryTime(book,book.entries,{...base,basis:'recorded',from:'2026-02-30'}),/日期/);assert.throws(()=>filterEntryTime(book,book.entries,{...base,basis:'recorded',from:'2026-10-13'}),/区间/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {FactWikiService} from '../../memory/fact-wiki.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {relationshipFor} from '../../core/companion-relationship.js';
import {arbitrateCompanionPresentation,createCompanionLifeState} from '../../core/companion-behavior.js';
import {emptyEntry,type BookScope} from '../../contracts/memory-book.js';
const scope:BookScope={characterId:'aika',pairingId:'local-user',sessionId:'relationship'};
function fixture(t:test.TestContext){mkdirSync('.local/allmind-m4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/allmind-m4/tests/relationship-'));t.after(()=>repository.close());return repository;}
function ingest(repository:FileBookRepository,id:string,text:string){const wiki=new FactWikiService(repository),p=wiki.preview(scope,{sourceId:id,title:'用户',text,private:true});const op=`apply-${id}-${p.expectedRevision}`;assert.deepEqual(wiki.apply(scope,p.id,op),wiki.apply(scope,p.id,op));return repository.snapshot(scope);}

test('evidenced dimensions persist, repeated sources do not add points, and author export/other pair stay private',t=>{
  const repository=fixture(t);ingest(repository,'experience','共同经历：昨天我和你一起整理项目\n信任反馈：你记对了\n回复长度：希望简短些');
  const first=repository.snapshot(scope).relationships![0]!;assert.equal(first.familiarity,2);assert.equal(first.trust,55);assert.equal(first.commonExperiences,1);
  ingest(repository,'experience','共同经历：昨天我和你一起整理项目\n信任反馈：你记对了\n回复长度：希望简短些');
  assert.deepEqual(repository.snapshot(scope).relationships![0],first);
  assert.equal(repository.snapshot({...scope,pairingId:'other'}).relationships?.length??0,0);
  const runtime=new BookRuntime(repository,{async complete(){throw Error('not called')}});assert.ok(!runtime.imports.export(scope).text.includes('简短些'));
  repository.close();const reopened=new FileBookRepository(repository.directory);t.after(()=>reopened.close());assert.deepEqual(reopened.snapshot(scope).relationships![0],first);
});
test('formal reply consumes bounded communication preferences and forgetting removes their influence',async t=>{
  const repository=fixture(t);ingest(repository,'communication','称呼：小林\n回复长度：希望简短些');
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9999/v1',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},0,'model');
  let prompt='';const runtime=new BookRuntime(repository,{async complete(_binding,messages){prompt=JSON.stringify(messages);return '好的。'}});
  const result=await runtime.chat(scope,'你好',new AbortController().signal);assert.match(prompt,/用户沟通偏好/);assert.match(prompt,/小林/);assert.match(prompt,/简短些/);assert.ok(result.context?.relationshipUsed?.basisRefs.length);
  const book=repository.snapshot(scope),pref=book.entries.find(entry=>entry.fact?.predicate==='回复长度')!;repository.commit(scope,{remove:[pref.id]},book.revision,'forget');runtime.invalidate(scope.characterId);
  await runtime.chat({...scope,sessionId:'fresh'},'你好',new AbortController().signal);assert.ok(!prompt.includes('简短些'));assert.equal(repository.snapshot(scope).relationships![0]!.preferences.length,1);
});
test('event response emotion has sourced persistent evidence, bounded decay, and real presentation arbitration',t=>{
  const repository=fixture(t),book=ingest(repository,'outcome','事件进展 event.test：A公司面试结束了，通过了');
  const stored=book.relationships![0]!,at=stored.emotion!.reportedAt;const now=relationshipFor(book,scope,at)!;
  assert.equal(now.emotion!.kind,'happy');assert.equal(now.emotion!.intensity,.45);
  const life=createCompanionLifeState(scope,at),view=arbitrateCompanionPresentation({state:'idle',characterId:'aika'},life,at,{relationship:{emotion:'happy',intensity:.45,until:at+10000}});
  assert.equal(view.characterState,'happy');assert.ok('expression' in view);assert.equal(view.expression.emotion,'happy');
  assert.equal(relationshipFor(book,scope,at+3*3600000)!.emotion,null);assert.equal(relationshipFor(book,scope,at-3600000)!.emotion!.intensity,.45);
  assert.equal(relationshipFor(book,scope,at+30*86400000)!.trust,stored.trust);assert.equal(relationshipFor(book,scope,at+30*86400000)!.familiarity,stored.familiarity);
  new FactWikiService(repository).revoke(scope,'outcome',book.revision,'revoke');assert.equal(relationshipFor(repository.snapshot(scope),scope,at)!.emotion,null);
});
test('negative trust feedback and role facts never become inferred trust',t=>{
  const repository=fixture(t);ingest(repository,'negative','信任反馈：我不信任你\n# 角色\n关系：非常亲密');
  const relationship=repository.snapshot(scope).relationships![0]!;assert.equal(relationship.trust,null);assert.equal(relationship.commonExperiences,0);
});

test('duplicate statements from another source do not inflate relationship dimensions or shared experience count',t=>{
  const repository=fixture(t);ingest(repository,'original','共同经历：我和你一起整理旧照片\n信任反馈：你记对了');
  const first=repository.snapshot(scope).relationships![0]!;ingest(repository,'duplicate','共同经历：我和你一起整理旧照片\n信任反馈：你记对了');
  const repeated=repository.snapshot(scope).relationships![0]!;assert.equal(repeated.familiarity,first.familiarity);assert.equal(repeated.trust,first.trust);assert.equal(repeated.commonExperiences,first.commonExperiences);
  assert.ok(repeated.basisRefs.length>first.basisRefs.length,'duplicate source provenance remains inspectable');
});

test('explicit failed outcomes are concerned but an unknown result never creates an outcome emotion',t=>{
  for(const value of ['A公司面试结束了，没有通过','A公司面试结束了，未通过','A公司面试不知道是否通过了','A公司面试尚未通过']){
    const repository=fixture(t),book=ingest(repository,'result','事件进展 event.test：'+value);
    if(/不知道|尚未/.test(value))assert.equal(book.relationships![0]!.emotion,null);
    else assert.equal(book.relationships![0]!.emotion!.kind,'concerned');
  }
});

test('switching models and applying author templates preserve evolved private relationship and scope',async t=>{
  const repository=fixture(t);ingest(repository,'private','共同经历：我和你一起整理旧照片\n信任反馈：你记对了\n称呼：小林');
  const runtime=new BookRuntime(repository,{async complete(){return '好的'}}),before=repository.snapshot(scope).relationships![0]!;
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9999/v1',model:'changed-fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},0,'switch-model');
  assert.deepEqual(repository.snapshot(scope).relationships![0],before);
  const authored=emptyEntry('author-core','persona','作者角色','角色自主兴趣是阅读历史，核心身份不会随用户偏好重写。');
  const imported=runtime.imports.preview(scope,JSON.stringify({schemaVersion:'memory-book/v1',name:'角色作者模板',entries:[authored]}), 'template.json');assert.deepEqual(imported.diagnostics,[]);runtime.imports.apply(scope,imported.id,'author-template');
  assert.ok(repository.snapshot(scope).entries.some(entry=>entry.id==='author-core'&&entry.pairingId===null&&entry.origin==='authored'));
  assert.deepEqual(repository.snapshot(scope).relationships![0],before);
  const other=await runtime.inspect({...scope,pairingId:'other',sessionId:'other-session'},'你好',new AbortController().signal);assert.ok(!JSON.stringify(other.messages).includes('小林'));assert.equal(other.relationshipUsed,undefined);
  const own=await runtime.chat(scope,'你好',new AbortController().signal);assert.ok(own.context!.relationshipUsed);assert.match(JSON.stringify(own.context!.messages),/小林/);assert.match(JSON.stringify(own.context!.messages),/阅读历史/);
});

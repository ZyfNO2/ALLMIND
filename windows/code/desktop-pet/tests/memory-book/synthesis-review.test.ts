import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {emptyEntry} from '../../contracts/memory-book.js';
import type {SynthesisTask,SynthesisResult,SynthesisPageReview} from '../../contracts/wiki-synthesis.js';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {classifyEntry} from '../../memory/knowledge-category.js';
import {validateSynthesisResult} from '../../memory/wiki-synthesis-protocol.js';

const scope={characterId:'aika',pairingId:'local-user',sessionId:'review-core'};
function result(task:SynthesisTask,text='说话简洁自然，尊重对方决定。'):SynthesisResult{
 return {schemaVersion:'allmind-wiki/v1',inputHash:task.inputHash,pages:[{id:'character',title:'角色说话方式',domain:'external',category:'persona',pageType:'topic',paragraphs:[{text,evidence:[{entryId:'raw',quote:'说话简洁自然，尊重对方决定。'}]}]}],relations:[],coverage:[{entryId:'raw',pageIds:['character'],reason:''}]};
}
async function fixture(t:test.TestContext,text?:string){
 const directory=mkdtempSync(join(tmpdir(),'synthesis-review-'));let repo=new FileBookRepository(directory);
 t.after(()=>{repo.close();rmSync(directory,{recursive:true,force:true});});
 const config=repo.loadConfig(),binding={baseUrl:'http://127.0.0.1:1/v1',model:'fixture',credentialId:'none',inputTokens:64000,outputTokens:8192};
 const document={prompts:[{identifier:'main',role:'system' as const,content:'完整角色预设'},{identifier:'charDescription',marker:true},{identifier:'chatHistory',marker:true}],prompt_order:[{character_id:1,order:['main','charDescription','chatHistory'].map(identifier=>({identifier,enabled:true}))}]};
 repo.commitConfig({...config,mainModel:binding,wikiModel:binding,promptPresets:[{id:'preset-review',name:'合成预设',revision:1,original:JSON.stringify(document),document,orderBlock:1}],characters:config.characters.map(role=>({...role,promptPresetId:'preset-review'}))},config.revision,'config');
 repo.commit(scope,{upsert:[emptyEntry('raw','wiki','一段混合导入资料','说话简洁自然，尊重对方决定。')]},0,'source');
 const runtime=new BookRuntime(repo,{async complete(_binding,messages){return JSON.stringify(result(JSON.parse(messages[1]!.content),text));}});
 const job=runtime.synthesis.prepare(scope,repo.snapshot(scope).revision,'prepare');
 await runtime.synthesis.run(scope,job.id,new AbortController().signal,60000,true);
 return {repo,runtime,job,restart(){repo.close();repo=new FileBookRepository(directory);return new BookRuntime(repo,{async complete(){throw Error('No generation during restart check');}});}};
}
test('model category is reviewable and cannot turn an ordinary Wiki into core persona by itself',async t=>{
 const {repo,runtime,job}=await fixture(t);
 const task=JSON.parse(runtime.synthesis.package(scope,job.id).files['materials.json']!) as SynthesisTask;
 runtime.synthesis.apply(scope,job.id,job.expectedRevision,'apply',true);
 const page=repo.snapshot(scope).entries.find(entry=>entry.synthesis)!;
 assert.equal(classifyEntry(page,repo.snapshot(scope).entries).category,'persona');assert.equal(page.corePersona,undefined);
 const context=await runtime.inspect(scope,'你好',new AbortController().signal);
 assert.ok(!context.recall.base.some(row=>row.entry.id===page.id));
 const bad=result(task);(bad.pages[0] as any).corePersona=true;assert.throws(()=>validateSynthesisResult(bad,task),/额外字段/);
});
test('explicit core review survives restart, occupies character slot, preserves source and stops on revocation',async t=>{
 const {repo,runtime,job,restart}=await fixture(t),source=repo.snapshot(scope).entries[0];
 const review:SynthesisPageReview[]=[{pageId:'character',category:'persona',corePersona:true}];
 const receipt=runtime.synthesis.apply(scope,job.id,job.expectedRevision,'apply',true,review);
 assert.deepEqual(runtime.synthesis.apply(scope,job.id,job.expectedRevision,'apply',true,review),receipt);
 assert.throws(()=>runtime.synthesis.apply(scope,job.id,job.expectedRevision,'apply',true,[{...review[0]!,corePersona:false}]),/选择已变化/);
 assert.deepEqual(repo.snapshot(scope).entries.find(entry=>entry.id==='raw'),source);
 let context=await runtime.inspect(scope,'你好',new AbortController().signal),page=repo.snapshot(scope).entries.find(entry=>entry.synthesis)!;
 assert.ok(context.recall.base.some(row=>row.entry.id===page.id));
 assert.ok(context.compilation!.items.some(row=>row.identifier.includes(page.id)));
 assert.ok(context.messages.some(row=>row.content.includes('说话简洁自然，尊重对方决定。')));
 const restarted=restart();context=await restarted.inspect(scope,'你好',new AbortController().signal);assert.ok(context.recall.base.some(row=>row.entry.corePersona));
 const repository=restarted.repository,current=repository.snapshot(scope),original=current.entries.find(row=>row.id==='raw')!;
 repository.commit(scope,{upsert:[{...original,enabled:false}]},current.revision,'revoke');
 restarted.invalidate(scope.characterId);context=await restarted.inspect(scope,'你好',new AbortController().signal);
 assert.ok(!context.recall.base.some(row=>row.entry.corePersona));assert.ok(!context.messages.some(row=>row.content.includes('说话简洁自然，尊重对方决定。')));
});
test('core selection requires persona category, unique complete review, and rejects excess bytes before commit',async t=>{
 const {repo,runtime,job}=await fixture(t,'较长人设正文。'.repeat(240)),revision=repo.snapshot(scope).revision;
 assert.throws(()=>runtime.synthesis.apply(scope,job.id,revision,'apply',true,[]),/逐页/);
 assert.throws(()=>runtime.synthesis.apply(scope,job.id,revision,'apply',true,[{pageId:'character',category:'world',corePersona:true}]),/字段无效/);
 assert.throws(()=>runtime.synthesis.apply(scope,job.id,revision,'apply',true,[{pageId:'character',category:'persona',corePersona:true}]),/4 KiB/);
 assert.equal(repo.snapshot(scope).revision,revision);assert.equal(runtime.synthesis.get(scope,job.id).applyIntent,undefined);
 runtime.synthesis.apply(scope,job.id,revision,'apply-without-core',true,[{pageId:'character',category:'world',corePersona:false}]);
 const page=repo.snapshot(scope).entries.find(entry=>entry.synthesis)!;assert.equal(classifyEntry(page,repo.snapshot(scope).entries).category,'world');assert.equal(page.corePersona,undefined);
});

test('core budget is pairing-scoped and manual oversized edits cannot bypass its atomic guard',async t=>{
 const {repo,runtime}=await fixture(t),other={...scope,pairingId:'other-user'},revision=repo.snapshot(scope).revision;
 repo.commit(other,{upsert:[{...emptyEntry('other-persona','persona','另一个配对的人设','其他配对正文。'.repeat(300)),pairingId:other.pairingId}]},revision,'other-seed');
 const job=runtime.synthesis.prepare(scope,repo.snapshot(scope).revision,'new-prepare');await runtime.synthesis.run(scope,job.id,new AbortController().signal,60000,true);
 runtime.synthesis.apply(scope,job.id,job.expectedRevision,'apply-new',true,[{pageId:'character',category:'persona',corePersona:true}]);
 const book=repo.snapshot(scope),page=book.entries.find(row=>row.corePersona)!;
 assert.throws(()=>repo.commit(scope,{upsert:[{...page,body:'过长正文。'.repeat(400)}]},book.revision,'oversize-edit'),/4 KiB/);
 assert.equal(repo.snapshot(scope).revision,book.revision);assert.equal(repo.snapshot(scope).entries.find(row=>row.id===page.id)!.body,page.body);
});

test('a preset cannot silently drop a reviewed core persona by disabling its character slot',async t=>{
 const {repo,runtime,job}=await fixture(t);runtime.synthesis.apply(scope,job.id,job.expectedRevision,'activate',true,[{pageId:'character',category:'persona',corePersona:true}]);
 const config=repo.loadConfig(),next=structuredClone(config);next.promptPresets![0]!.document.prompt_order[0]!.order.find(row=>row.identifier==='charDescription')!.enabled=false;
 repo.commitConfig(next,config.revision,'disable-slot');
 await assert.rejects(runtime.chat(scope,'你好',new AbortController().signal,{turnId:'missing-core-slot'}),/关闭角色说明槽/);
 assert.equal(repo.readSession(scope).length,0);
});

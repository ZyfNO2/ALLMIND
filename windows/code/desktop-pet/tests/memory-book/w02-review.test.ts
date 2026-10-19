import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BookRuntime} from '../../app/book-runtime.js';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {FileResourceStore} from '../../memory/file-resource-store.js';
import {BookResourceService} from '../../memory/book-resources.js';
import type {BookModelPort} from '../../providers/book-model.js';
const signal=new AbortController().signal;
async function fixture(t:test.TestContext, model?:BookModelPort){
 const root=join(process.cwd(),'.local','w02-review');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'case-'));
 const repository=new FileBookRepository(directory),config=repository.loadConfig();repository.commitConfig({...config,wikiModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local',inputTokens:8000,outputTokens:1000}},config.revision,'config');
 const resources=new BookResourceService(new FileResourceStore({directory:join(directory,'resources')}));const scope={characterId:'aika',pairingId:'local-user',sessionId:'review'};
 let calls=0;const port=model??{async complete(_binding,messages){calls++;const source=JSON.parse(messages.at(-1)!.content).materials[0];return JSON.stringify({candidates:[{subject:'角色',predicate:'饮品',value:'红茶',quote:'角色喜欢红茶。',sourceId:source.resourceId,action:'new',reason:'有据',existingEntryIds:[]}],chapters:[]});}};
 const runtime=new BookRuntime(repository,port,{resources});const resource=await resources.receiveUpload(scope,{name:'a.md',mime:'text/markdown'},Buffer.from('角色喜欢红茶。'),'upload',signal);
 const input={operationId:'preview-review',domain:'external' as const,expectedBookRevision:repository.snapshot(scope).revision,materials:[{resourceId:resource.id,sha256:resource.sha256!,resourceRevision:resource.revision}]};
 t.after(()=>{repository.close();rmSync(directory,{recursive:true,force:true})});return{repository,resources,runtime,scope,input,port,calls:()=>calls};
}
test('organization preview cannot be read or applied from a different session',async t=>{const f=await fixture(t);const preview=await f.runtime.organization.preview(f.scope,f.input,signal);assert.throws(()=>f.runtime.organization.get({...f.scope,sessionId:'foreign'},preview.id),{code:'not_found'});});
test('organization review survives Runtime reconstruction without another model request',async t=>{const f=await fixture(t);const preview=await f.runtime.organization.preview(f.scope,f.input,signal);const restored=new BookRuntime(f.repository,f.port,{resources:f.resources});assert.equal(restored.organization.get(f.scope,preview.id).id,preview.id);const applied=restored.organization.apply(f.scope,{previewId:preview.id,operationId:'apply-review',expectedRevision:preview.expectedBookRevision,decisions:preview.candidates.map(row=>({candidateId:row.id,accept:true}))},signal);assert.equal(applied.appliedEntryIds.length,1);assert.equal(f.calls(),1);});
test('concurrent preview requests with one operation ID submit only once',async t=>{
 let calls=0,release!:()=>void;const gate=new Promise<void>(done=>release=done);const f=await fixture(t,{async complete(){calls++;await gate;return '{"candidates":[],"chapters":[]}';}});
 const a=f.runtime.organization.preview(f.scope,f.input,signal),b=f.runtime.organization.preview(f.scope,f.input,signal);await new Promise(done=>setTimeout(done,10));release();await Promise.all([a,b]);assert.equal(calls,1);
});
test('revoking organized material invalidates the preview, source and derived Wiki recall',async t=>{
 const f=await fixture(t),preview=await f.runtime.organization.preview(f.scope,f.input,signal);
 const applied=f.runtime.organization.apply(f.scope,{previewId:preview.id,operationId:'apply-review',expectedRevision:preview.expectedBookRevision,decisions:preview.candidates.map(row=>({candidateId:row.id,accept:true}))},signal);
 assert.equal(applied.appliedEntryIds.length,1);
 const ref=f.input.materials[0]!;f.resources.revoke(f.scope,ref.resourceId,ref.resourceRevision,'revoke-review');
 const book=f.repository.snapshot(f.scope);assert.ok(book.wikiSources?.every(source=>!source.enabled));
 assert.equal(f.runtime.organization.get(f.scope,preview.id).phase,'expired');
 const context=await f.runtime.inspect(f.scope,'红茶',signal);assert.ok(!context.consumed.some(row=>applied.appliedEntryIds.includes(row.entryId)));
});
test('an expired persisted preview cannot bypass TTL by applying without get',async t=>{
 const f=await fixture(t),preview=await f.runtime.organization.preview(f.scope,f.input,signal),file=join(f.resources.store.directory,'wiki-organization.json');
 const stored=JSON.parse(readFileSync(file,'utf8'));stored.previews[0].createdAt=Date.now()-16*60_000;writeFileSync(file,JSON.stringify(stored));
 const restored=new BookRuntime(f.repository,f.port,{resources:f.resources});
 assert.throws(()=>restored.organization.apply(f.scope,{previewId:preview.id,expectedRevision:preview.expectedBookRevision,operationId:'expired-apply',decisions:preview.candidates.map(row=>({candidateId:row.id,accept:true}))},signal),{code:'conflict'});
 assert.equal(f.repository.snapshot(f.scope).entries.length,0);
});
test('a crash after Book commit replays the persisted exact apply intent once',async t=>{
 const f=await fixture(t),preview=await f.runtime.organization.preview(f.scope,f.input,signal);
 const input={previewId:preview.id,expectedRevision:preview.expectedBookRevision,operationId:'crash-apply',decisions:preview.candidates.map(row=>({candidateId:row.id,accept:true}))};
 const commit=f.repository.commit.bind(f.repository);let first=true;
 f.repository.commit=(...args:Parameters<typeof commit>)=>{const receipt=commit(...args);if(first){first=false;throw Error('injected-after-commit');}return receipt;};
 assert.throws(()=>f.runtime.organization.apply(f.scope,input,signal),/injected-after-commit/);
 f.repository.commit=commit;
 const restored=new BookRuntime(f.repository,f.port,{resources:f.resources});const result=restored.organization.apply(f.scope,input,signal),revision=result.book.revision;
 assert.equal(result.book.entries.length,1);assert.equal(restored.organization.apply(f.scope,input,signal).book.revision,revision);assert.equal(f.calls(),1);
 assert.throws(()=>restored.organization.apply(f.scope,{...input,operationId:'other-apply'},signal),{code:'conflict'});
});

test('reviewed multi-value supplements remain individually evidenced and recallable in their private pairing',async t=>{
 const f=await fixture(t,{async complete(_binding,messages){const source=JSON.parse(messages.at(-1)!.content).materials[0];return JSON.stringify({candidates:[
 {subject:'角色',predicate:'饮品',value:'红茶',quote:'角色喜欢红茶。',sourceId:source.resourceId,action:'new',reason:'首值',existingEntryIds:[]},
 {subject:'角色',predicate:'饮品',value:'乌龙茶',quote:'角色也喜欢乌龙茶。',sourceId:source.resourceId,action:'supplement',reason:'非互斥，多值并存',existingEntryIds:[]}
 ],chapters:[]});}});
 const material=await f.resources.receiveUpload(f.scope,{name:'multi.md',mime:'text/markdown'},Buffer.from('角色喜欢红茶。角色也喜欢乌龙茶。'),'multi-upload',signal);
 const preview=await f.runtime.organization.preview(f.scope,{...f.input,materials:[{resourceId:material.id,sha256:material.sha256!,resourceRevision:material.revision}]},signal);
 const applied=f.runtime.organization.apply(f.scope,{previewId:preview.id,expectedRevision:preview.expectedBookRevision,operationId:'multi-apply',decisions:preview.candidates.map(row=>({candidateId:row.id,accept:true}))},signal);
 assert.equal(applied.appliedEntryIds.length,2);const context=await f.runtime.inspect(f.scope,'角色 红茶 乌龙茶',signal);
 assert.ok(applied.appliedEntryIds.every(id=>context.consumed.some(row=>row.entryId===id)));
 assert.equal(f.repository.snapshot({...f.scope,pairingId:'foreign'}).entries.some(row=>applied.appliedEntryIds.includes(row.id)),false);
});

test('explicit sourced validity intervals retain history without recalling expired values',async t=>{
 const old='角色在2020-01-01T00:00:00Z到2021-01-01T00:00:00Z喜欢乌龙茶。',current='角色自2022-01-01T00:00:00Z起喜欢红茶。';
 const f=await fixture(t,{async complete(_binding,messages){const source=JSON.parse(messages.at(-1)!.content).materials[0];return JSON.stringify({candidates:[
 {subject:'角色',predicate:'饮品',value:'乌龙茶',quote:old,sourceId:source.resourceId,action:'time_change',validFrom:'2020-01-01T00:00:00Z',validUntil:'2021-01-01T00:00:00Z',reason:'旧区间',existingEntryIds:[]},
 {subject:'角色',predicate:'饮品',value:'红茶',quote:current,sourceId:source.resourceId,action:'time_change',validFrom:'2022-01-01T00:00:00Z',reason:'新区间',existingEntryIds:[]}
 ],chapters:[]});}});
 const material=await f.resources.receiveUpload(f.scope,{name:'dated.md',mime:'text/markdown'},Buffer.from(old+current),'dated-upload',signal);
 const preview=await f.runtime.organization.preview(f.scope,{...f.input,materials:[{resourceId:material.id,sha256:material.sha256!,resourceRevision:material.revision}]},signal);
 const applied=f.runtime.organization.apply(f.scope,{previewId:preview.id,expectedRevision:preview.expectedBookRevision,operationId:'dated-apply',decisions:preview.candidates.map(row=>({candidateId:row.id,accept:true}))},signal),context=await f.runtime.inspect(f.scope,'角色 饮品',signal);
 assert.equal(applied.appliedEntryIds.length,2);const expired=applied.book.entries.find(row=>row.fact?.value==='乌龙茶')!,active=applied.book.entries.find(row=>row.fact?.value==='红茶')!;
 assert.equal(expired.validUntil,'2021-01-01T00:00:00Z');assert.ok(!context.consumed.some(row=>row.entryId===expired.id));assert.ok(context.consumed.some(row=>row.entryId===active.id));
});

test('accepted duplicate sources preserve independent support after either source is revoked',async t=>{
 const f=await fixture(t,{async complete(_binding,messages){const materials=JSON.parse(messages.at(-1)!.content).materials;return JSON.stringify({candidates:materials.map((source:any,index:number)=>({subject:'角色',predicate:'饮品',value:'红茶',quote:index?'角色偏爱红茶。':'角色喜欢红茶。',sourceId:source.resourceId,action:index?'duplicate':'new',reason:'相同结论的独立来源',existingEntryIds:[]})),chapters:[]});}});
 const second=await f.resources.receiveUpload(f.scope,{name:'second.md',mime:'text/markdown'},Buffer.from('角色偏爱红茶。'),'second-upload',signal);
 const preview=await f.runtime.organization.preview(f.scope,{...f.input,materials:[...f.input.materials,{resourceId:second.id,sha256:second.sha256!,resourceRevision:second.revision}]},signal);
 const applied=f.runtime.organization.apply(f.scope,{previewId:preview.id,expectedRevision:preview.expectedBookRevision,operationId:'duplicate-apply',decisions:preview.candidates.map(row=>({candidateId:row.id,accept:true}))},signal);assert.equal(applied.appliedEntryIds.length,2);
 const first=f.input.materials[0]!;f.resources.revoke(f.scope,first.resourceId,first.resourceRevision,'revoke-first');
 const context=await f.runtime.inspect(f.scope,'角色 红茶',signal);assert.ok(context.consumed.some(row=>applied.appliedEntryIds.includes(row.entryId)));
 const enabled=f.repository.snapshot(f.scope).wikiSources!.filter(row=>row.enabled);assert.equal(enabled.length,1);assert.equal(enabled[0]!.uri,'resource:'+second.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {emptyEntry,type BookScope,type SavedTurn} from '../../contracts/memory-book.js';
import {BookImportService} from '../../memory/book-import.js';
import {BookHttpModel,strictOutputSchema} from '../../providers/book-model.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {createServer} from 'node:http';

const scope:BookScope={characterId:'aika',pairingId:'local-user',sessionId:'one'};
function fixture(t:test.TestContext){const root=resolve('.local/user-data-closure-tests');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'run-'));const repository=new FileBookRepository(directory);t.after(()=>repository.close());return {repository,directory};}
const turn=(sessionId:string,id='one'):SavedTurn=>({...scope,sessionId,id,user:'普通开场',assistant:'埋在回复中的检索暗号：月影石',traceId:'trace-'+id,timestamp:'2026-10-21T16:00:00Z'});

test('private backup includes more than 256 sessions and round-trips all metadata into an empty instance',t=>{
 const source=fixture(t).repository,target=fixture(t).repository;
 for(let i=0;i<270;i++)source.appendTurn({...scope,sessionId:'session-'+i},turn('session-'+i));
 source.renameSession({...scope,sessionId:'session-0'},'自定义标题');source.setSessionArchived({...scope,sessionId:'session-0'},true);
 source.commit(scope,{upsert:[emptyEntry('authored','wiki','材料','需要完整恢复的资料')]},0,'entry-add');
 const backup=source.exportPrivate(scope),preview=target.previewPrivate(backup.text);
 assert.equal(preview.sessions,270);assert.equal(preview.turns,270);assert.deepEqual(preview.conflicts,[]);
 target.restorePrivate(backup.text,preview.hash,0,true);
 assert.equal(target.listSessions('aika','local-user',{all:true}).length,270);
 assert.equal(target.listSessions('aika','local-user',{all:true}).find(row=>row.sessionId==='session-0')?.title,'自定义标题');
 assert.ok(target.listSessions('aika','local-user',{all:true}).find(row=>row.sessionId==='session-0')?.archivedAt);
 assert.equal(target.snapshot(scope).entries[0]?.body,'需要完整恢复的资料');
 assert.deepEqual(target.readSession({...scope,sessionId:'session-269'}),[turn('session-269')]);
 assert.ok(target.previewPrivate(backup.text).conflicts.length);
 assert.throws(()=>target.restorePrivate(backup.text,preview.hash,target.loadConfig().revision,true),{code:'conflict'});
});
test('backup tamper, wrong hashes, foreign turns and missing consent never mutate target data',t=>{
 const source=fixture(t).repository,{repository:target,directory}=fixture(t);source.appendTurn(scope,turn(scope.sessionId));const backup=source.exportPrivate(scope);const before=readdirSync(directory).sort();
 const corrupt=JSON.parse(backup.text);corrupt.payload.sessions[0].turns[0].assistant='tampered';assert.throws(()=>target.previewPrivate(JSON.stringify(corrupt)),{code:'invalid_input'});
 corrupt.sha256=createHash('sha256').update(JSON.stringify(corrupt.payload)).digest('hex');corrupt.payload.sessions[0].turns[0].pairingId='other';corrupt.sha256=createHash('sha256').update(JSON.stringify(corrupt.payload)).digest('hex');assert.throws(()=>target.previewPrivate(JSON.stringify(corrupt)),{code:'invalid_input'});
 assert.throws(()=>target.restorePrivate(backup.text,'0'.repeat(64),0,true),{code:'conflict'});assert.throws(()=>target.restorePrivate(backup.text,JSON.parse(backup.text).sha256,0,false),{code:'invalid_input'});
 assert.deepEqual(readdirSync(directory).sort(),before);
});
test('interrupted restore finishes its exact journal after restart without overwriting conflicting content',t=>{
 const source=fixture(t).repository,{repository:target,directory}=fixture(t);source.appendTurn(scope,turn(scope.sessionId));const backup=source.exportPrivate(scope),preview=target.previewPrivate(backup.text),original=target.commitConfig;
 target.commitConfig=()=>{throw Error('controlled interruption after file writes');};assert.throws(()=>target.restorePrivate(backup.text,preview.hash,0,true),/controlled interruption/);target.commitConfig=original;target.close();
 const reopened=new FileBookRepository(directory);try{assert.deepEqual(reopened.readSession(scope),[turn(scope.sessionId)]);assert.equal(reopened.loadConfig().revision,1);assert.equal(readdirSync(directory).includes('private-restore.json'),false);}finally{reopened.close();}
});
test('legacy private v1 backup restores its actual contents with an explicit integrity warning and no fabricated metadata',t=>{
 const source=fixture(t).repository,target=fixture(t).repository;source.appendTurn(scope,turn(scope.sessionId));const snapshot=source.snapshot(scope),role=source.loadConfig().characters[0]!;
 const text=JSON.stringify({schemaVersion:'private-companion-backup/v1',scope:{characterId:scope.characterId,pairingId:scope.pairingId},role:{...role,appearancePath:'C:/legacy-local-image.png',promptPresetId:'missing-preset'},snapshot,sessions:[{sessionId:scope.sessionId,turns:source.readSession(scope)}]}),preview=target.previewPrivate(text);
 assert.equal(preview.integrity,'legacy-unverified');assert.ok(preview.exclusions.some(row=>row.includes('没有内置完整性哈希')));target.restorePrivate(text,preview.hash,0,true);assert.equal(target.loadConfig().characters[0]?.appearancePath,null);assert.equal(target.loadConfig().characters[0]?.promptPresetId,null);assert.deepEqual(target.readSession(scope),[turn(scope.sessionId)]);assert.equal(target.listSessions('aika','local-user')[0]?.archivedAt,undefined);
});
test('session full-text search and titles remain pairing isolated; history byte cursors preserve Unicode and complete turns',t=>{
 const {repository:repo}=fixture(t);for(let i=0;i<113;i++)repo.appendTurn(scope,{...turn(scope.sessionId,'turn-'+i),user:'中文🙂'.repeat(50)+i});
 repo.appendTurn({...scope,pairingId:'someone-else',sessionId:'foreign'},{...turn('foreign'),pairingId:'someone-else'});
 assert.equal(repo.listSessions('aika','local-user',{all:true,query:'月影石'}).length,1);
 assert.equal(repo.listSessions('aika','local-user',{all:true,query:'missing'}).length,0);
 const collected:SavedTurn[]=[];let cursor:number|null=null;
 do{const page=repo.readSessionPage(scope,cursor,17);collected.unshift(...page.turns);cursor=page.before;}while(cursor!==null);
 assert.deepEqual(collected,repo.readSession(scope));assert.equal(collected.length,113);
 assert.throws(()=>repo.readSessionPage(scope,2,17),{code:'corrupt_data'});
 repo.appendTurn({...scope,sessionId:'constructor'},turn('constructor'));assert.equal(repo.listSessions('aika','local-user',{all:true}).find(row=>row.sessionId==='constructor')?.title,'普通开场');
});
test('runtime role archives survive restart and never become the active role',t=>{
 const {repository:repo,directory}=fixture(t),config=repo.loadConfig(),archived={...config.characters[0]!,id:'archived'};
 repo.commitConfig({...config,archivedCharacters:[archived]},0,'archive-config');
 assert.throws(()=>repo.commitConfig({...repo.loadConfig(),currentCharacterId:'archived'},1,'bad-active'),{code:'invalid_input'});
 assert.equal(repo.loadConfig().archivedCharacters?.[0]?.id,'archived');
 const runtimeFile=join(directory,'runtime.json');assert.match(readFileSync(runtimeFile,'utf8'),/archived/);
});

test('ordinary documents retain all Unicode text and explicit domains without becoming persona or real memories',t=>{
 const {repository:repo}=fixture(t),service=new BookImportService(repo),text='资料中的人物设定🙂。'.repeat(7000);
 const preview=service.previewDocument(scope,text,'ordinary.md','simulated');assert.equal(preview.entries.map(row=>row.body).join(''),text);assert.ok(preview.entries.length>1);assert.ok(preview.entries.every(row=>row.type==='wiki'&&row.organization?.domain==='rp'&&row.corePersona!==true));
 service.apply(scope,preview.id,'document-apply');assert.equal(repo.snapshot(scope).entries.map(row=>row.body).join(''),text);
 assert.throws(()=>service.previewDocument(scope,'正文','doc.md','real' as 'external'),{code:'invalid_input'});
});
test('HTTP structured modes are explicit and never silently retry rejected response formats',async()=>{
 const calls:any[]=[],binding={baseUrl:'http://127.0.0.1:1/v1',model:'controlled',credentialId:'none',inputTokens:16000,outputTokens:4000};
 const transport=async(_url:unknown,init:any)=>{calls.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}),{status:200});};
 const model=new BookHttpModel(async()=>'',transport as typeof fetch),schema={type:'object',properties:{ok:{type:'boolean'}},additionalProperties:false};
 await model.complete({...binding,structuredOutput:'json-schema'},[{role:'user',content:'JSON'}],new AbortController().signal,{json:true,jsonSchema:schema});
 assert.equal(calls[0].response_format.type,'json_schema');assert.deepEqual(calls[0].response_format.json_schema.schema.required,['ok']);
 await model.complete({...binding,structuredOutput:'prompt'},[{role:'user',content:'JSON'}],new AbortController().signal,{json:true});assert.equal(calls[1].response_format,undefined);
 const rejected=new BookHttpModel(async()=>'',(async()=>{calls.push('rejected');return new Response('{}',{status:400});}) as typeof fetch);
 await assert.rejects(rejected.complete({...binding,structuredOutput:'json-schema'},[],new AbortController().signal,{json:true,jsonSchema:schema}),/HTTP 400/);assert.equal(calls.filter(row=>row==='rejected').length,1);
 assert.deepEqual(strictOutputSchema({const:'x'}),{enum:['x'],type:'string'});
});
test('controlled HTTP Wiki compiles strict schema, applies reviewed pages, recalls and survives repository restart without resubmitting',async t=>{
 const {repository:repo,directory}=fixture(t);let calls=0;
 const server=createServer(async(request,response)=>{let raw='';for await(const chunk of request)raw+=chunk;const input=JSON.parse(raw);calls++;assert.equal(input.response_format.type,'json_schema');const task=JSON.parse(input.messages[1].content);const result={schemaVersion:'allmind-wiki/v1',inputHash:task.inputHash,pages:[{id:'city',title:'岚栖城',pageType:'entity',category:'world',domain:'external',paragraphs:[{text:'资料记载岚栖城位于银松河畔。',evidence:[{entryId:task.materials[0].id,quote:'岚栖城位于银松河畔。'}]}]}],relations:[],coverage:[{entryId:task.materials[0].id,pageIds:['city'],reason:''}]};response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())));const address=server.address();assert.ok(address&&typeof address!=='string');
 const config=repo.loadConfig();repo.commitConfig({...config,wikiModel:{baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'controlled-strict-fixture',credentialId:'local-no-auth',inputTokens:64000,outputTokens:16000,structuredOutput:'json-schema'}},0,'http-wiki-config');repo.commit(scope,{upsert:[emptyEntry('material','wiki','城市材料','岚栖城位于银松河畔。')]},0,'http-wiki-material');
 const model=new BookHttpModel(async()=>''),runtime=new BookRuntime(repo,model),job=runtime.synthesis.prepare(scope,1,'http-wiki-prepare');await runtime.synthesis.run(scope,job.id,new AbortController().signal,60000,true);runtime.synthesis.apply(scope,job.id,1,'http-wiki-apply',true,[{pageId:'city',category:'world',corePersona:false}]);
 assert.equal(repo.snapshot(scope).entries.filter(row=>row.synthesis).length,1);assert.match(JSON.stringify((await runtime.inspect(scope,'岚栖城在哪里',new AbortController().signal,'off')).messages),/银松河/);
 repo.close();const reopened=new FileBookRepository(directory);try{assert.equal(reopened.snapshot(scope).entries.filter(row=>row.synthesis).length,1);const next=new BookRuntime(reopened,model);assert.equal(next.synthesis.get(scope,job.id).status,'applied');assert.equal(calls,1);}finally{reopened.close();}
});

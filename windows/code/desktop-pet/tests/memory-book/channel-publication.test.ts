import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {emptyEntry, type BookEntry, type BookScope, type WikiSource} from '../../contracts/memory-book.js';
import {previewPublication, assertPublicationCurrent, publicationForPairing, publicationRuntime, qqScope, qqId, type PublicationSelection} from '../../memory/channel-publication.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {bookEntryHash} from '../../memory/book-entry-hash.js';
import type {StoredPromptPreset} from '../../contracts/prompt-preset.js';

const sourceScope:BookScope={characterId:'aika',pairingId:'local-user',sessionId:'desktop'};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function repository(t:test.TestContext){const directory=mkdtempSync(join(tmpdir(),'allmind-channel-'));const repo=new FileBookRepository(directory);t.after(()=>{repo.close();rmSync(directory,{recursive:true,force:true});});return repo;}
function selection(overrides:Partial<PublicationSelection>={}):PublicationSelection{return {id:'public-test',revision:1,scope:sourceScope,entryIds:['public'],sourceIds:[],name:'公开记录员',intro:'公开简介',presetId:null,...overrides};}
function fixture(t:test.TestContext){
  const repo=repository(t),publicEntry=emptyEntry('public','persona','公开身份','PUBLIC_ROLE');
  const desktop=emptyEntry('desktop-secret','wiki','桌面资料','DESKTOP_SECRET');
  const privateEntry=emptyEntry('owner-memory','memory','主人的经历','OWNER_SECRET');privateEntry.pairingId='local-user';
  repo.commit(sourceScope,{upsert:[publicEntry,desktop,privateEntry]},0,'seed');return repo;
}

test('QQ identity isolates account, connector, chat kind, target and session without unsafe numeric coercion',()=>{
  const input={connectorId:'qq-one',selfId:'10001',kind:'private' as const,targetId:'20002',senderId:'20002'};
  const scope=qqScope('aika',input,'epoch-1');assert.equal(scope.pairingId,qqScope('aika',input,'epoch-1').pairingId);
  for(const changed of [{...input,selfId:'10002'},{...input,connectorId:'qq-two'},{...input,kind:'group' as const},{...input,targetId:'20003'}])assert.notEqual(qqScope('aika',changed,'epoch-1').pairingId,scope.pairingId);
  assert.equal(qqScope('aika',input,'epoch-2').pairingId,scope.pairingId);assert.notEqual(qqScope('aika',input,'epoch-2').sessionId,scope.sessionId);
  assert.equal(qqId('999999999999999999999'), '999999999999999999999');assert.equal(qqId(123), '123');
  for(const value of [Number.MAX_SAFE_INTEGER+1,1.2,-1,'../book','0',{},null])assert.throws(()=>qqId(value));
});

test('publication is an explicit pure selection, not an export of all globally visible desktop entries',()=>{
  // no writer or network involved in preview
  const repo={loadConfig:()=>({characters:[{id:'aika'}]}),snapshot:()=>({entries:[emptyEntry('public','persona','Public','PUBLIC'),emptyEntry('secret','wiki','Secret','DESKTOP_SECRET')]})} as unknown as FileBookRepository;
  const preview=previewPublication(repo,selection());assert.equal(preview.entries.length,1);assert.ok(!JSON.stringify(preview).includes('DESKTOP_SECRET'));
  assert.throws(()=>previewPublication(repo,selection({entryIds:['missing']})),/不可用/);
  assert.throws(()=>previewPublication(repo,selection({entryIds:['public','public']})),/重复/);
});

test('publication blocks private experience, state, disabled entries and resource handles',t=>{
  const repo=fixture(t);assert.throws(()=>previewPublication(repo,selection({entryIds:['owner-memory']})),/个人经历/);
  for(const mutate of [(entry:BookEntry)=>{entry.enabled=false;},(entry:BookEntry)=>{entry.organization={domain:'real',evidenceStatus:'user_reported'};},(entry:BookEntry)=>{entry.organization={domain:'author',evidenceStatus:'source_asserted',resourceRefs:[{resourceId:'private-image',sha256:'a'.repeat(64),resourceRevision:1}]};}]){
    const entry=emptyEntry('candidate-'+repo.snapshot(sourceScope).revision,'wiki','Candidate','text');mutate(entry);repo.commit(sourceScope,{upsert:[entry]},repo.snapshot(sourceScope).revision,'modify-'+repo.snapshot(sourceScope).revision);assert.throws(()=>previewPublication(repo,selection({entryIds:[entry.id]})));
  }
});

test('public preset keeps ordered prompts but drops original secrets, extension fields and desktop identity',t=>{
  const repo=fixture(t),config=repo.loadConfig();
  const document={prompts:[{identifier:'main',role:'system' as const,content:'Act as {{char}}',privateSecret:'NESTED_KEY'},{identifier:'chatHistory',marker:true}],prompt_order:[{character_id:1,privateSecret:'ORDER_KEY',order:[{identifier:'main',enabled:true,privateSecret:'ORDER_ROW_KEY'},{identifier:'chatHistory',enabled:true}]}],proxy_password:'TOP_KEY'};
  const preset:StoredPromptPreset={id:'preset-public',name:'Public',revision:1,original:JSON.stringify(document),document,orderBlock:1};
  repo.commitConfig({...config,promptPresets:[preset],characters:config.characters.map(row=>({...row,intro:'DESKTOP_INTRO',userName:'OWNER_NAME',appearancePath:'C:/PRIVATE_PATH'}))},config.revision,'preset');
  const preview=previewPublication(repo,selection({presetId:preset.id})),serialized=JSON.stringify(preview);
  for(const secret of ['TOP_KEY','NESTED_KEY','ORDER_KEY','ORDER_ROW_KEY','DESKTOP_INTRO','OWNER_NAME','PRIVATE_PATH'])assert.ok(!serialized.includes(secret));
  assert.deepEqual(preview.preset!.document.prompt_order,[{character_id:1,order:[{identifier:'main',enabled:true},{identifier:'chatHistory',enabled:true}]}]);assert.equal(preview.preset!.document.prompts[0]!.content,'Act as {{char}}');
  const runtime=publicationRuntime(preview,{...repo.loadConfig(),chatgptProjects:[],fastModel:{model:'private-planner',baseUrl:'http://127.0.0.1:1',credentialId:'planner-secret',inputTokens:8192,outputTokens:1024}});
  assert.equal(runtime.fastModel,null);assert.equal(runtime.wikiModel,null);assert.equal(runtime.characters[0]!.appearancePath,null);assert.equal(runtime.characters[0]!.userName,undefined);assert.equal(runtime.companion,undefined);
});

test('derived publication requires complete exact evidence and current source; materialization rebases hashes for new scope',t=>{
  const repo=repository(t),raw=emptyEntry('basis','wiki','依据','PUBLIC_EVIDENCE');raw.pairingId='local-user';raw.sourceRefs=['source'];
  const source:WikiSource={id:'source',title:'Published source',uri:'file:///PRIVATE_PATH',pairingId:'local-user',enabled:true,revision:1,hash:sha(raw.body),forgottenKeys:[],snapshots:[{hash:sha(raw.body),text:raw.body,capturedAt:new Date().toISOString()},{hash:sha('OLD_PRIVATE_SNAPSHOT'),text:'OLD_PRIVATE_SNAPSHOT',capturedAt:new Date().toISOString()}]};
  repo.commit(sourceScope,{upsert:[raw],wikiSources:[source]},0,'raw');const persisted=repo.snapshot(sourceScope).entries[0]!;
  const derived=emptyEntry('derived','wiki','派生','PUBLISHED_SUMMARY');derived.pairingId='local-user';derived.sourceRefs=['source'];derived.synthesis={version:'allmind-wiki/v1',pageId:'page',domain:'author',pageType:'topic',basis:[{entryId:'basis',revision:persisted.revision,hash:bookEntryHash(persisted)}],sources:[{id:'source',revision:1,hash:source.hash}],relations:[]};
  repo.commit(sourceScope,{upsert:[derived]},1,'derived');
  assert.throws(()=>previewPublication(repo,selection({entryIds:['derived'],sourceIds:['source']})),/依据/);
  assert.throws(()=>previewPublication(repo,selection({entryIds:['basis','derived']})),/来源/);
  const preview=previewPublication(repo,selection({entryIds:['basis','derived'],sourceIds:['source']}));
  assert.ok(!JSON.stringify(preview).includes('PRIVATE_PATH'));assert.ok(!JSON.stringify(preview).includes('OLD_PRIVATE_SNAPSHOT'));
  const materialized=publicationForPairing(preview,'qq-target'),basis=materialized.entries.find(row=>row.id==='basis')!,page=materialized.entries.find(row=>row.id==='derived')!;
  assert.equal(page.synthesis!.basis[0]!.hash,bookEntryHash(basis));assert.equal(basis.pairingId,'qq-target');assert.equal(page.pairingId,'qq-target');
  const target=repository(t),scope={...sourceScope,pairingId:'qq-target'};target.commit(scope,{upsert:materialized.entries,wikiSources:materialized.sources},0,'apply-public');
  assert.equal(target.snapshot(scope).entries.length,2);assert.equal(target.snapshot({...scope,pairingId:'qq-other'}).entries.length,0);
  const changed=structuredClone(preview);changed.entries[0]!.body='TAMPERED';assert.throws(()=>publicationForPairing(changed,'qq-target'),/校验/);
  const current=repo.snapshot(sourceScope);repo.commit(sourceScope,{wikiSources:[{...current.wikiSources![0]!,enabled:false,revision:2}]},current.revision,'revoke');assert.throws(()=>assertPublicationCurrent(repo,preview));
});

test('four external private/group recipients cannot recall each other or desktop secrets using production Runtime',async t=>{
  const desktop=fixture(t),preview=previewPublication(desktop,selection());
  const targets=[{kind:'private' as const,targetId:'201'},{kind:'private' as const,targetId:'202'},{kind:'group' as const,targetId:'301'},{kind:'group' as const,targetId:'302'}];
  const before=JSON.stringify(desktop.snapshot(sourceScope));
  for(let index=0;index<targets.length;index++){
    const repo=repository(t),scope=qqScope('aika',{connectorId:'connector',selfId:'101',senderId:'20001',...targets[index]!},'initial'),config=repo.loadConfig();
    repo.commitConfig(publicationRuntime(preview,{...config,mainModel:{baseUrl:'http://127.0.0.1:1',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}}),config.revision,'runtime');
    const published=publicationForPairing(preview,scope.pairingId);repo.commit(scope,{upsert:published.entries,wikiSources:published.sources},0,'publication');
    const secret=emptyEntry('own-memory','memory','我的记录','RECIPIENT_SECRET_'+index);secret.pairingId=scope.pairingId;secret.trigger.strategy='always';repo.commit(scope,{upsert:[secret]},1,'own-memory');
    const runtime=new BookRuntime(repo,{async complete(_binding,messages){const text=JSON.stringify(messages);assert.ok(text.includes('PUBLIC_ROLE'));assert.ok(text.includes('RECIPIENT_SECRET_'+index));assert.ok(!text.includes('DESKTOP_SECRET')&&!text.includes('OWNER_SECRET'));for(let other=0;other<4;other++)if(other!==index)assert.ok(!text.includes('RECIPIENT_SECRET_'+other));return 'fixture';}});
    await runtime.chat(scope,'请介绍自己并回顾记录',new AbortController().signal,{turnId:'qq-turn'});assert.equal(repo.readSession(scope).length,1);
  }
  assert.equal(JSON.stringify(desktop.snapshot(sourceScope)),before);assert.equal(desktop.listSessions('aika','local-user').length,0);
  assertPublicationCurrent(desktop,preview);const snapshot=desktop.snapshot(sourceScope);desktop.commit(sourceScope,{upsert:[emptyEntry('new-private','wiki','未发布','NEW_DESKTOP_SECRET')]},snapshot.revision,'new');assertPublicationCurrent(desktop,preview);assert.ok(!JSON.stringify(preview).includes('NEW_DESKTOP_SECRET'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {SkinStore} from '../../management/skin-store.js';
import {ensureGptNiangStarter,GPT_NIANG_ROLE_ID,GPT_NIANG_SKIN_ID} from '../../management/starter-characters.js';
import {emptyEntry} from '../../contracts/memory-book.js';

async function fixture(t:test.TestContext){const root=resolve('.local/starter-tests');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'run-')),repo=new FileBookRepository(directory);t.after(()=>repo.close());const skins=await SkinStore.open(join(directory,'skins.json'),join(directory,'packs'),resolve('desktop'));return {repo,skins};}
test('fresh installation selects bundled GPT-Niang with a validated static image and no fabricated settings or memory',async t=>{
 const {repo,skins}=await fixture(t);await ensureGptNiangStarter(repo,skins,resolve('desktop'));
 const config=repo.loadConfig();assert.equal(config.currentCharacterId,GPT_NIANG_ROLE_ID);assert.equal(config.characters.length,1);assert.equal(config.mainModel,null);
 assert.equal(config.characters[0]?.appearanceSkinId,GPT_NIANG_SKIN_ID);assert.equal(config.gptNiangStarterVersion,1);
 const manifest=skins.manifest(GPT_NIANG_SKIN_ID);assert.equal(manifest.type,'sprite');assert.equal(manifest.sprite?.frameCount,1);assert.ok(manifest.sprite!.width>0);assert.ok(skins.routes(GPT_NIANG_SKIN_ID).size);
 const book=repo.snapshot({characterId:GPT_NIANG_ROLE_ID,pairingId:'local-user',sessionId:'desktop'});assert.deepEqual(book.entries,[]);assert.equal(book.wikiSources?.length??0,0);assert.equal(repo.listSessions(GPT_NIANG_ROLE_ID,'local-user').length,0);
 await ensureGptNiangStarter(repo,skins,resolve('desktop'));assert.deepEqual(repo.loadConfig(),config);
 const edited={...config,characters:[{...config.characters[0]!,name:'用户改名'}]};repo.commitConfig(edited,edited.revision,'user-rename');await ensureGptNiangStarter(repo,skins,resolve('desktop'));assert.equal(repo.loadConfig().characters[0]?.name,'用户改名');
});
test('existing roles, Wiki and model stay unchanged; deleting the starter does not recreate it on restart',async t=>{
 const {repo,skins}=await fixture(t),config=repo.loadConfig();repo.commitConfig({...config,characters:[{...config.characters[0]!,name:'我的角色'}]},0,'existing');
 const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'};repo.commit(scope,{upsert:[emptyEntry('my-note','wiki','原资料','原正文')]},0,'seed');const before=repo.snapshot(scope);
 await ensureGptNiangStarter(repo,skins,resolve('desktop'));const next=repo.loadConfig();assert.equal(next.currentCharacterId,'aika');assert.equal(next.characters[0]?.name,'我的角色');assert.equal(next.characters.length,2);assert.deepEqual(repo.snapshot(scope),before);
 repo.commitConfig({...next,characters:next.characters.filter(role=>role.id!==GPT_NIANG_ROLE_ID)},next.revision,'remove-starter');await ensureGptNiangStarter(repo,skins,resolve('desktop'));assert.equal(repo.loadConfig().characters.length,1);
});

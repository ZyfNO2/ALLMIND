import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {DEFAULT_COMPANION_SETTINGS} from '../../contracts/book-companion.js';
import {validateCompanionData} from '../../contracts/book-companion.js';

test('source erasure removes favorite references and private favorite metadata never author-exports',async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/favorite-erase-'));t.after(()=>repository.close());
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9',model:'fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true}},config.revision,'seed');
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'favorites'},runtime=new BookRuntime(repository,{async complete(){return '好的'}});
  await runtime.chat(scope,'饮品：乌龙茶',new AbortController().signal,{turnId:'favorite-source'});await runtime.automaticMemory!.flush();const id=repository.snapshot(scope).entries[0]!.id;
  const data=repository.loadCompanionData(scope);data.favorites=[id];repository.saveCompanionData(scope,data);assert.ok(!runtime.imports.export(scope).text.includes('favorites'));assert.deepEqual(repository.loadCompanionData({...scope,pairingId:'other'}).favorites??[],[]);
  repository.eraseTurns(scope,['favorite-source'],repository.snapshot(scope).revision);assert.deepEqual(repository.loadCompanionData(scope).favorites,[]);
  const fresh=repository.loadCompanionData(scope);assert.throws(()=>validateCompanionData({...fresh,favorites:['duplicate','duplicate']}),/favorites/);assert.throws(()=>validateCompanionData({...fresh,favorites:['invalid id']}),/favorites/);
});

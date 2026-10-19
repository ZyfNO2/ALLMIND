import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactFixture} from './artifact-fixture.mjs';
import {emptyEntry} from '../../dist/contracts/memory-book.js';
test('reader HTTP authenticates, enforces configured RP bounds and scopes all response projections',async t=>{
 const f=await artifactFixture(t),scope=f.runtime.scope('aika','reader-http'),repository=f.runtime.repository,config=repository.loadConfig();repository.commitConfig({...config,characters:config.characters.map(role=>role.id==='aika'?{...role,knowledgeView:{worldId:'world',branch:'main',cutoff:2}}:role)},config.revision,'view');
 const known=emptyEntry('known','lore','当前章','公开线索'),secret=emptyEntry('secret','lore','下一章','隐秘真名');for(const entry of [known,secret]){entry.sourceRefs=['reference'];entry.knowledge={worldId:'world',branch:'main',cutoff:0,chapter:entry===known?1:5,awareness:'experienced'};delete entry.knowledge.cutoff;entry.organization={domain:'rp',evidenceStatus:'source_asserted'}}repository.commit(scope,{upsert:[known,secret]},0,'seed');
 const query='?characterId=aika&sessionId=reader-http';const response=await f.request('/wiki/reader'+query),result=await response.json();assert.equal(response.status,200);assert.ok(JSON.stringify(result).includes('公开线索'));assert.ok(!JSON.stringify(result).includes('隐秘真名'));
 for(const suffix of ['&worldId=world&branch=main&cutoff=9','&worldId=other&branch=main&cutoff=1','&cutoff=1'])assert.equal((await f.request('/wiki/reader'+query+suffix)).status,400);
 const lowered=await f.request('/wiki/reader'+query+'&worldId=world&branch=main&cutoff=0');assert.equal(lowered.status,200);assert.ok(!JSON.stringify(await lowered.json()).includes('公开线索'));
 const unauth=await fetch(new URL(f.server.url).origin+'/api/memory-book/v1/wiki/reader'+query);assert.equal(unauth.status,401);
 assert.equal(f.prompts.length,0);
});

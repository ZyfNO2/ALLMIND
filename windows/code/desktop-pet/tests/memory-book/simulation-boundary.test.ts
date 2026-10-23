import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emptyEntry,DEFAULT_RECALL_CONFIG} from '../../contracts/memory-book.js';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRecallEngine} from '../../memory/book-recall.js';
import {LocalBookIndex} from '../../memory/local-book-index.js';
import {organizationExclusion} from '../../memory/wiki-organization.js';
import {classifyEntry} from '../../memory/knowledge-category.js';
import {wikiMaterialDomain} from '../../memory/wiki-synthesis.js';

test('simulation tags, author scope and organized RP share recall boundaries and visible simulation labels',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'simulation-boundary-')),repo=new FileBookRepository(directory);
 t.after(()=>{repo.close();rmSync(directory,{recursive:true,force:true});});
 const scope={characterId:'aika',pairingId:'local-user',sessionId:'simulation-boundary'};
 const entries=[
  {...emptyEntry('tagged','memory','模拟星河约定','模拟星河约定，作者虚构的陪伴记录。'),tags:['simulation']},
  {...emptyEntry('not-history','wiki','模拟星河资料','模拟星河资料，不是真人历史。'),tags:['not-user-history']},
  {...emptyEntry('author-scoped','story','模拟星河故事','模拟星河故事。'),authorScope:'simulation-only'},
  {...emptyEntry('organized','memory','模拟星河整理','模拟星河整理。'),organization:{domain:'rp' as const,evidenceStatus:'source_asserted' as const}},
 ].map(entry=>({...entry,pairingId:scope.pairingId}));
 repo.commit(scope,{upsert:entries},0,'seed');
 for(const entry of entries){
  assert.equal(wikiMaterialDomain(entry),'simulated');assert.equal(classifyEntry(entry,entries).simulated,true);
  for(const mode of ['smart','deep','off'] as const)assert.equal(organizationExclusion(entry,mode),'domain_fiction_isolated');
  assert.equal(organizationExclusion(entry,'story-rp'),null);
 }
 const engine=new BookRecallEngine(repo,new LocalBookIndex());
 for(const mode of ['smart','deep','story-rp'] as const){
  const result=await engine.run({scope,currentMessage:'模拟星河约定',recentMessages:[],config:{...DEFAULT_RECALL_CONFIG,mode},signal:new AbortController().signal});
  if(mode==='story-rp'){assert.ok(result.selected.length>0);assert.ok(!result.excluded.some(row=>row.reason==='domain_fiction_isolated'));}
  else{assert.equal(result.selected.length,0);for(const entry of entries)assert.ok(result.excluded.some(row=>row.entryId===entry.id&&row.reason==='domain_fiction_isolated'));}
 }
 const real={...emptyEntry('real','memory','星河真实记录','用户实际陈述。'),origin:'observed' as const,pairingId:scope.pairingId};
 assert.equal(classifyEntry(real,[real]).simulated,false);assert.equal(organizationExclusion(real,'smart'),null);
});

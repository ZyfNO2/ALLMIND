import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {FactWikiService} from '../../dist/memory/fact-wiki.js';
import {emptyEntry} from '../../dist/contracts/memory-book.js';

test('graph projects sourced pages and links, respects pair isolation and source revocation',t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/graph-'));t.after(()=>repository.close());
  const wiki=new FactWikiService(repository),scope={characterId:'aika',pairingId:'local-user',sessionId:'graph'};
  const preview=wiki.preview(scope,{sourceId:'private-source',title:'用户分享',text:'爱好：园艺\n饮品：乌龙茶',private:true});wiki.apply(scope,preview.id,'ingest');
  const graph=wiki.graph(scope);assert.ok(graph.nodes.some(node=>node.kind==='source'&&node.title==='用户分享'));assert.ok(graph.edges.some(edge=>edge.kind==='source'));
  for(const edge of graph.edges){assert.ok(graph.nodes.some(node=>node.id===edge.from));assert.ok(graph.nodes.some(node=>node.id===edge.to));assert.ok(edge.basisRefs.length);}
  assert.ok(!JSON.stringify(wiki.graph({...scope,pairingId:'other'})).includes('用户分享'));
  wiki.revoke(scope,'private-source',repository.snapshot(scope).revision,'revoke');assert.equal(wiki.graph(scope).nodes.length,0);
});

test('unlinked entries require explicit inclusion and graph limits are visible instead of silently dropping data',t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/unlinked-'));t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'graph'},wiki=new FactWikiService(repository);
  const entries=Array.from({length:140},(_,i)=>emptyEntry('node-'+i,'wiki','未关联设定 '+i,'原始手工设定'));repository.commit(scope,{upsert:entries},0,'entries');
  assert.equal(wiki.graph(scope).nodes.length,0);const graph=wiki.graph(scope,undefined,true);assert.equal(graph.nodes.length,128);assert.equal(graph.omittedNodes,12);assert.equal(graph.matchedCount,140);assert.equal(graph.visibleCount,128);assert.equal(graph.contextCount,0);
});

test('category and search run before the display cap and keep source context',t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const repository=new FileBookRepository(mkdtempSync('.local/ui-v4/tests/graph-filter-'));t.after(()=>repository.close());
  const scope={characterId:'aika',pairingId:'local-user',sessionId:'graph'},wiki=new FactWikiService(repository);
  const preview=wiki.preview(scope,{sourceId:'garden',title:'园艺来源',text:'地点：阳台',private:true});wiki.apply(scope,preview.id,'ingest');
  const stories=Array.from({length:130},(_,i)=>emptyEntry('story-'+i,'story','世界设定 '+i,'作者设定'));repository.commit(scope,{upsert:stories},repository.snapshot(scope).revision,'stories');
  const filtered=wiki.graph(scope,undefined,true,{basis:'all',from:'',to:'',timezone:'Asia/Singapore'},{category:'world',text:'世界设定 128'});
  assert.equal(filtered.matchedCount,1);assert.ok(filtered.nodes.some(node=>node.title==='世界设定 128'));assert.equal(filtered.nodes.filter(node=>node.kind==='source').length,0);
  const allWorld=wiki.graph(scope,undefined,true,undefined,{category:'world'});
  assert.equal(allWorld.matchedCount,130);assert.equal(allWorld.visibleCount,128);assert.equal(allWorld.omittedNodes,2);
  const located=wiki.graph(scope).nodes.find(node=>node.kind==='source');assert.equal(located.sourceId,'garden');
});

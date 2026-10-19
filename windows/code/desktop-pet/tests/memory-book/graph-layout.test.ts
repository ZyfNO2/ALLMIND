import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutKnowledgeGraph,computeKnowledgeLayout,graphEdgeWeight} from '../../memory/graph-layout.js';
test('ForceAtlas2 layout is deterministic, keeps every node and ignores invalid endpoints',()=>{
 const nodes=['a','b','c','alone'].map(id=>({id,kind:'page' as const})),edges=[{from:'a',to:'b'},{from:'b',to:'c'},{from:'missing',to:'a'}];
 const before=JSON.stringify({nodes,edges}),first=layoutKnowledgeGraph(nodes,edges);assert.deepEqual(layoutKnowledgeGraph(nodes,edges),first);assert.notDeepEqual(layoutKnowledgeGraph(nodes,edges,3),first);
 assert.deepEqual(Object.keys(first).sort(),nodes.map(node=>node.id).sort());for(const point of Object.values(first))assert.ok(Number.isFinite(point.x)&&Number.isFinite(point.y));assert.equal(JSON.stringify({nodes,edges}),before);
});
test('isolates remain distinct in a two-dimensional layout instead of a reserved side grid',()=>{
 const nodes=Array.from({length:29},(_,index)=>({id:'isolate-'+index,kind:'page' as const})),points=Object.values(layoutKnowledgeGraph(nodes,[]));
 assert.equal(new Set(points.map(p=>p.x+':'+p.y)).size,29);assert.ok(new Set(points.map(p=>Math.round(p.x))).size>8);assert.ok(new Set(points.map(p=>Math.round(p.y))).size>8);
});
test('community detection separates disconnected knowledge groups without creating semantic edges',()=>{
 const nodes=['a','b','c','x','y','z'].map(id=>({id,kind:'page' as const})),edges=[['a','b'],['a','c'],['b','c'],['x','y'],['x','z'],['y','z']].map(([from,to])=>({from:from!,to:to!,kind:'semantic'}));
 const result=computeKnowledgeLayout(nodes,edges);assert.equal(result.communityCount,2);assert.equal(result.communities.a,result.communities.b);assert.notEqual(result.communities.a,result.communities.x);assert.equal(result.degrees.a,2);assert.equal(edges.length,6);
 assert.ok(graphEdgeWeight({from:'a',to:'b',kind:'source'})<graphEdgeWeight(edges[0]!));
});

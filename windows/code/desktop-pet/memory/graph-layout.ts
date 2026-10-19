import {UndirectedGraph} from 'graphology';
import fa2 from 'graphology-layout-forceatlas2';
import communityAlgorithm from 'graphology-communities-louvain';
const forceAtlas2=fa2 as unknown as typeof import('graphology-layout-forceatlas2').default;
const louvain=communityAlgorithm as unknown as typeof import('graphology-communities-louvain').default;
export interface LayoutNode {id:string;kind:'page'|'source'|'entry'}
export interface LayoutEdge {from:string;to:string;kind?:string}
export interface LayoutPoint {x:number;y:number}
export interface GraphLayout {positions:Record<string,LayoutPoint>;communities:Record<string,number>;degrees:Record<string,number>;communityCount:number}
/** Display weights do not assert confidence or add a knowledge relationship. */
export function graphEdgeWeight(edge:LayoutEdge):number{return edge.kind==='semantic'?3:edge.kind==='source'?.2:1;}
export function computeKnowledgeLayout(nodes:readonly LayoutNode[],edges:readonly LayoutEdge[],seed=0):GraphLayout{
 const graph=new UndirectedGraph(),ids=[...new Set(nodes.map(node=>node.id))].sort();
 let state=(seed+1)>>>0;const rng=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
 ids.forEach((id,index)=>{const angle=index*2.399963+seed*.17,radius=20*Math.sqrt(index+1);graph.addNode(id,{x:Math.cos(angle)*radius,y:Math.sin(angle)*radius,size:2});});
 for(const edge of edges){if(edge.from===edge.to||!graph.hasNode(edge.from)||!graph.hasNode(edge.to))continue;const weight=graphEdgeWeight(edge);if(graph.hasEdge(edge.from,edge.to))graph.updateEdgeAttribute(edge.from,edge.to,'weight',(value:number)=>value+weight);else graph.addEdge(edge.from,edge.to,{weight});}
 const communities=ids.length?louvain(graph,{resolution:1,rng}):{};
 // Seed each detected community in its own neighborhood; a cold random start can remain
 // tangled after a bounded solve. These are visual positions, never synthetic graph edges.
 const groups=new Map<number,string[]>();for(const id of ids){const community=communities[id]??0,rows=groups.get(community)??[];rows.push(id);groups.set(community,rows);}
 const groupIds=[...groups.keys()].sort((a,b)=>a-b);
 groupIds.forEach((community,group)=>{const rows=groups.get(community)!;rows.forEach((id,index)=>{const angle=index*2.399963+seed*.17,radius=12*Math.sqrt(index+1);graph.mergeNodeAttributes(id,{x:Math.cos(group*2.399963)*280*Math.sqrt(group+1)+Math.cos(angle)*radius,y:Math.sin(group*2.399963)*280*Math.sqrt(group+1)+Math.sin(angle)*radius});});});
 if(ids.length>1)forceAtlas2.assign(graph,{iterations:350,settings:{...forceAtlas2.inferSettings(graph),linLogMode:true,scalingRatio:30,gravity:.02,strongGravityMode:false,barnesHutOptimize:ids.length>50,edgeWeightInfluence:1,slowDown:5,adjustSizes:true}});
 // Reserve hit-target space as well as drawn-node space at the overview scale.
 // This final collision pass changes coordinates only, not communities or relationships.
 if(ids.length>1){const xs=ids.map(id=>graph.getNodeAttribute(id,'x') as number),ys=ids.map(id=>graph.getNodeAttribute(id,'y') as number),gap=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))/400*34;
  for(let step=0;step<70;step++)for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length;b++){
   const left=graph.getNodeAttributes(ids[a]!),right=graph.getNodeAttributes(ids[b]!),dx=right.x-left.x,dy=right.y-left.y,distance=Math.hypot(dx,dy)||.01;
   if(distance<gap){const push=(gap-distance)*.52,ux=dx/distance,uy=dy/distance;graph.mergeNodeAttributes(ids[a]!,{x:left.x-ux*push,y:left.y-uy*push});graph.mergeNodeAttributes(ids[b]!,{x:right.x+ux*push,y:right.y+uy*push});}
  }
 }
 const positions:Record<string,LayoutPoint>={},degrees:Record<string,number>={};
 graph.forEachNode((id,attrs)=>{if(!Number.isFinite(attrs.x)||!Number.isFinite(attrs.y))throw Error('图谱布局产生无效坐标。');positions[id]={x:attrs.x,y:attrs.y};degrees[id]=graph.degree(id);});
 return {positions,communities,degrees,communityCount:new Set(Object.values(communities)).size};
}
export function layoutKnowledgeGraph(nodes:readonly LayoutNode[],edges:readonly LayoutEdge[],seed=0):Record<string,LayoutPoint>{return computeKnowledgeLayout(nodes,edges,seed).positions;}

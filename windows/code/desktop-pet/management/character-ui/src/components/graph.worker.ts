import {computeKnowledgeLayout,type LayoutNode,type LayoutEdge} from '../../../../memory/graph-layout';
self.onmessage=(event:MessageEvent<{nodes:LayoutNode[];edges:LayoutEdge[];seed:number}>)=>{
 try{self.postMessage({result:computeKnowledgeLayout(event.data.nodes,event.data.edges,event.data.seed)});}
 catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
};

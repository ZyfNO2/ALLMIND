import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react'
import {MultiDirectedGraph} from 'graphology'
import Sigma from 'sigma'
import type {WikiGraph} from '../../../../memory/fact-wiki'
import type {GraphLayout} from '../../../../memory/graph-layout'

export interface GraphControls {fit():void;zoomIn():void;zoomOut():void}
const categories:Record<string,string>={world:'#168ac0',persona:'#9865bc',knowledge:'#159883',companion:'#d87b3c'}
const communities=['#168ac0','#d87b3c','#9865bc','#159883','#bd5476','#6f8197','#a18c32','#4777bb']
export default forwardRef<GraphControls,{nodes:WikiGraph['nodes'];edges:WikiGraph['edges'];seed:number;selected:string|null;onSelect:(id:string)=>void;colorMode:'category'|'community';highlight:Set<string>;onCommunities:(count:number)=>void}>(function GraphCanvas({nodes,edges,seed,selected,onSelect,colorMode,highlight,onCommunities},ref){
 const container=useRef<HTMLDivElement>(null),renderer=useRef<Sigma|null>(null),select=useRef(onSelect);select.current=onSelect
 const [layout,setLayout]=useState<GraphLayout|null>(null),[failure,setFailure]=useState(''),[screen,setScreen]=useState<Record<string,{x:number;y:number;size:number}>>({})
 const dragging=useRef<{id:string;x:number;y:number}|null>(null),[hovered,setHovered]=useState<string|null>(null)
 const color=(node:WikiGraph['nodes'][number],result:GraphLayout)=>node.kind==='source'?'#8d9aaa':colorMode==='community'?communities[(result.communities[node.id]??0)%communities.length]!:categories[node.categories[0]??'knowledge']!
 useImperativeHandle(ref,()=>({fit(){renderer.current?.getCamera().setState({x:.5,y:.5,ratio:1.15,angle:0})},zoomIn(){const camera=renderer.current?.getCamera();if(camera)camera.setState({ratio:Math.max(.05,camera.ratio*.8)})},zoomOut(){const camera=renderer.current?.getCamera();if(camera)camera.setState({ratio:Math.min(8,camera.ratio*1.25)})}}),[])
 useEffect(()=>{setFailure('');setLayout(null);setScreen({});let worker:Worker;
  try{worker=new Worker(new URL('./graph.worker.ts',import.meta.url),{type:'module'});worker.onmessage=event=>{if(event.data.error){setFailure(event.data.error);return}setLayout(event.data.result);onCommunities(event.data.result.communityCount)};worker.onerror=()=>setFailure('图谱布局 Worker 无法运行，请重新布局。');worker.postMessage({nodes,edges,seed});}
  catch(error){setFailure(String(error));return}
  return()=>worker.terminate();
 },[nodes,edges,seed,onCommunities])
 useEffect(()=>{if(!layout||!container.current)return;let sigma:Sigma;
  try{
   const graph=new MultiDirectedGraph();const maxDegree=Math.max(1,...Object.values(layout.degrees)),density=Math.max(.55,Math.sqrt(90/Math.max(nodes.length,1)));
   for(const node of nodes){const p=layout.positions[node.id];if(!p)continue;graph.addNode(node.id,{...p,label:node.title,color:color(node,layout),size:(node.kind==='source'?5:5+Math.sqrt((layout.degrees[node.id]??0)/maxDegree)*10)*density});}
   edges.forEach((edge,index)=>{if(graph.hasNode(edge.from)&&graph.hasNode(edge.to))graph.addEdgeWithKey(String(index),edge.from,edge.to,{size:edge.kind==='semantic'?1.8:edge.kind==='source'?.5:.7,color:edge.kind==='semantic'?'#6b8498':edge.kind==='source'?'#d4dce3':'#bdcddd',type:edge.kind==='semantic'?'arrow':'line',label:edge.label??''});});
   const labelBoxes:{x:number;y:number;width:number;height:number}[]=[],style=getComputedStyle(container.current),ink=style.getPropertyValue('--mb-ink').trim()||'#193248',surface=style.getPropertyValue('--mb-surface').trim()||'#ffffff';
   sigma=new Sigma(graph,container.current,{labelFont:'Inter, Microsoft YaHei, sans-serif',labelSize:12,labelWeight:'500',labelDensity:.16,labelGridCellSize:150,labelRenderedSizeThreshold:8,hideLabelsOnMove:true,hideEdgesOnMove:true,stagePadding:65,minCameraRatio:.05,maxCameraRatio:8,zIndex:true,renderEdgeLabels:false,allowInvalidContainer:true,
    defaultDrawNodeLabel(context,data){
     if(!data.label)return;context.font='500 12px Microsoft YaHei, sans-serif';let text=String(data.label);while(context.measureText(text).width>160)text=text.slice(0,-2)+'…';
     const width=context.measureText(text).width+8,height=20,x=data.x+data.size+5,y=data.y-10;
     if(labelBoxes.some(box=>x<box.x+box.width&&x+width>box.x&&y<box.y+box.height&&y+height>box.y)&&!data.highlighted)return;
     labelBoxes.push({x,y,width,height});context.fillStyle=surface;context.fillRect(x,y,width,height);context.fillStyle=ink;context.fillText(text,x+4,y+14);
    }});renderer.current=sigma;sigma.on('beforeRender',()=>{labelBoxes.length=0});
   sigma.getCamera().setState({ratio:1.15});sigma.on('clickNode',({node})=>select.current(node));
   const updateScreen=()=>{const next:typeof screen={};graph.forEachNode((id,attrs)=>{const p=sigma.graphToViewport({x:attrs.x,y:attrs.y}),data=sigma.getNodeDisplayData(id);next[id]={x:p.x,y:p.y,size:Math.max(12,(data?.size??8)/Math.sqrt(sigma.getCamera().ratio))};});setScreen(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next)};
   sigma.on('afterRender',updateScreen);updateScreen();
  }catch(error){setFailure('图谱渲染失败：'+String(error));return}
  return()=>{sigma.kill();renderer.current=null};
 },[layout,nodes,edges])
 useEffect(()=>{const sigma=renderer.current;if(!sigma||!layout)return;const graph=sigma.getGraph(),target=hovered??selected,chosen=target&&graph.hasNode(target)?target:null,neighbors=new Set<string>(chosen?[chosen,...graph.neighbors(chosen)]:[]);
  for(const node of nodes)if(graph.hasNode(node.id))graph.setNodeAttribute(node.id,'color',color(node,layout));
  sigma.setSetting('nodeReducer',(id,attrs)=>({...attrs,...(chosen&&!neighbors.has(id)?{color:'#dce3e9',label:''}:{}),...(id===chosen?{highlighted:true,forceLabel:true,zIndex:2}:{}),...(highlight.has(id)?{forceLabel:true,color:'#267651'}:{})}));
  sigma.setSetting('edgeReducer',(id,attrs)=>{const touching=chosen&&(graph.source(id)===chosen||graph.target(id)===chosen);return {...attrs,...(chosen?{color:touching?'#496778':'#e4eaf0',size:touching?2:.3}:{})}});sigma.refresh();
 },[layout,selected,hovered,colorMode,highlight,nodes])
 function move(event:React.PointerEvent<HTMLButtonElement>){const drag=dragging.current,sigma=renderer.current;if(!drag||!sigma)return;const bounds=container.current!.getBoundingClientRect(),point=sigma.viewportToGraph({x:event.clientX-bounds.left,y:event.clientY-bounds.top});sigma.getGraph().mergeNodeAttributes(drag.id,point);sigma.refresh()}
 return <div className="knowledge-canvas" aria-label="记忆图谱画布" data-node-count={nodes.length} data-edge-count={edges.length} data-layout-ready={Boolean(layout&&!failure)}>
  <div ref={container} className="knowledge-sigma"/>
  {nodes.map(node=>{const p=screen[node.id];return p&&<button key={node.id} type="button" className={'knowledge-node-target'+(selected===node.id?' is-selected':'')} data-node={node.id} aria-label={'查看节点：'+node.title} aria-pressed={selected===node.id} title={node.title} style={{left:p.x,top:p.y,width:p.size*2,height:p.size*2}} onClick={()=>onSelect(node.id)} onPointerEnter={()=>setHovered(node.id)} onPointerLeave={()=>setHovered(null)} onPointerDown={event=>{event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);dragging.current={id:node.id,x:event.clientX,y:event.clientY};renderer.current?.getCamera().disable()}} onPointerMove={move} onPointerUp={()=>{dragging.current=null;renderer.current?.getCamera().enable()}} onPointerCancel={()=>{dragging.current=null;renderer.current?.getCamera().enable()}}/>})}
  {!layout&&!failure&&<p className="knowledge-canvas-message" role="status">正在计算知识社区与布局…</p>}
  {failure&&<p className="knowledge-canvas-message" role="alert">{failure} 原始资料未改动，仍可从右侧目录查看。</p>}
 </div>
})

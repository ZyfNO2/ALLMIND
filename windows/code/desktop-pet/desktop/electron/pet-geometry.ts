export interface PetRect {x:number;y:number;width:number;height:number}
export interface PetWindow extends PetRect {id:string;pid:number}
export interface PetDock {id:string;ratio:number}
export function surfaceAt(windows:PetWindow[],x:number,foot:number):PetWindow|null{
  return windows.find((row,index)=>Math.abs(row.y-foot)<=28&&x>=row.x+24&&x<=row.x+row.width-24&&!windows.slice(0,index).some(front=>x>=front.x&&x<=front.x+front.width&&row.y>=front.y&&row.y<front.y+front.height))??null;
}
export function dockPosition(windows:PetWindow[],dock:PetDock,height:number):{x:number;y:number}|null{
  const row=windows.find(item=>item.id===dock.id);if(!row)return null;
  const x=row.x+Math.max(24,Math.min(row.width-24,row.width*dock.ratio));
  return surfaceAt(windows,x,row.y)?.id===row.id?{x,y:row.y-height}:null;
}
export function movePet(current:{x:number;y:number},target:{x:number;y:number},elapsed:number,speed=100){
  const dx=target.x-current.x,dy=target.y-current.y,distance=Math.hypot(dx,dy),step=Math.min(distance,speed*Math.max(0,Math.min(100,elapsed))/1000);
  return distance===0?{...current}:{x:current.x+dx/distance*step,y:current.y+dy/distance*step};
}
export function reachableWindow(windows:PetWindow[],current:{x:number;y:number},exclude:string|null):PetWindow|null{
  return windows.find(row=>row.id!==exclude&&Math.abs(row.y-current.y)<=180&&Math.abs(Math.max(row.x+24,Math.min(row.x+row.width-24,current.x))-current.x)<=260&&surfaceAt(windows,Math.max(row.x+24,Math.min(row.x+row.width-24,current.x)),row.y)?.id===row.id)??null;
}

import {replaceResourceFile} from '../memory/resource-atomic-replace.js';
import {mkdirSync,existsSync,readFileSync,writeFileSync,appendFileSync,readdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CollectionHelperClient,collectionHelperPaths,type HelperEvent,type CollectionHelperClientOptions} from './collection-helper-client.js';

const DAY=86400000;
export interface ActivityBin {owner:string;day:string;slot:number;weekend:boolean;timezone:string;offset:number;count:number;coveredMs:number;updatedAt:number}
export interface ActivityView {enabled:boolean;state:'disabled'|'starting'|'active'|'paused'|'unavailable';error:string|null;policy:'keydown-repeat-v2';days:ActivityBin[];sampleDays:number;habitSlots:number[];quietCompanion:boolean}
interface ActivityData {version:1;consents:string[];rows:ActivityBin[];lastEnds:Record<string,number>;deletedBefore:Record<string,number>}
type ActivitySource=Pick<CollectionHelperClient,'start'|'startKeyboard'|'close'>;
const identity=(value:string)=>{if(typeof value!=='string'||!/^[\w-][\w.-]{0,127}$/.test(value))throw Error('Invalid activity owner');return value;};
export function activityBin(owner:string,start:number,end:number,count:number,offset:number,timezone:string):ActivityBin{
  identity(owner);
  if(![start,end,count,offset].every(Number.isSafeInteger)||start<0||end<=start||end-start>15000||count<0||count>100000||Math.abs(offset)>840||typeof timezone!=='string'||timezone.length>100)throw Error('Invalid keyboard aggregate or coverage');
  new Intl.DateTimeFormat('en',{timeZone:timezone});
  const local=new Date(start-offset*60000);
  return {owner,day:local.toISOString().slice(0,10),slot:Math.floor((local.getUTCHours()*60+local.getUTCMinutes())/30),weekend:[0,6].includes(local.getUTCDay()),timezone,offset,count,coveredMs:end-start,updatedAt:end};
}
/** Book's sole keyboard-data owner. Reuses the controlled helper; does not load the legacy SQLite runtime. */
export class BookActivity {
  private data:ActivityData;
  private owner:string|null=null;
  private source:ActivitySource|null=null;
  private state:ActivityView['state']='disabled';
  private error:string|null=null;
  private generation=0;
  private revision=0;
  private paused=false;
  private lastPrune=0;
  private operation=Promise.resolve();
  constructor(private readonly directory:string,private readonly packageRoot:string,private readonly notify:()=>void=()=>{},private readonly pulse:()=>void=()=>{},private readonly clock:()=>number=Date.now,private readonly createSource:(options:CollectionHelperClientOptions)=>ActivitySource=options=>new CollectionHelperClient(options)){
    mkdirSync(directory,{recursive:true});
    this.data=existsSync(join(directory,'activity.json'))?JSON.parse(readFileSync(join(directory,'activity.json'),'utf8')):{version:1,consents:[],rows:[],lastEnds:{},deletedBefore:{}};
    if(this.data.version!==1||!Array.isArray(this.data.consents)||!Array.isArray(this.data.rows)||this.data.rows.length>48000||!this.data.lastEnds)throw Error('Invalid Book keyboard activity store');
    this.data.consents.forEach(identity);
    for(const row of this.data.rows){identity(row.owner);if(!/^\d{4}-\d{2}-\d{2}$/.test(row.day)||!Number.isInteger(row.slot)||row.slot<0||row.slot>47||![row.count,row.coveredMs,row.updatedAt].every(Number.isSafeInteger)||row.count<0||row.coveredMs<0)throw Error('Invalid stored activity bin');}
    this.data.deletedBefore??={};
    this.prune();this.recoverRaw();
  }
  private save(){const path=join(this.directory,'activity.json'),temp=path+'.next';writeFileSync(temp,JSON.stringify(this.data),{flush:true});replaceResourceFile(temp,path);}
  private prune(){const now=this.clock();this.lastPrune=now;this.data.rows=this.data.rows.filter(row=>now-row.updatedAt<30*DAY);for(const file of readdirSync(this.directory)){
    const match=/^raw\.([\w.-]+)\.(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
    if(match){const path=join(this.directory,file),lines=readFileSync(path,'utf8').trim().split('\n').filter(Boolean),kept=lines.filter(line=>now-JSON.parse(line).end<7*DAY);if(!kept.length)unlinkSync(path);else if(kept.length!==lines.length)writeFileSync(path,kept.join('\n')+'\n');}
  }this.save();}
  private recoverRaw(){
    // Journal precedes the atomic projection. Apply only records newer than its durable watermark.
    for(const file of readdirSync(this.directory).sort()){
      const match=/^raw\.([\w.-]+)\.(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);if(!match)continue;
      const owner=identity(match[1]!),day=match[2]!;
      for(const line of readFileSync(join(this.directory,file),'utf8').trim().split('\n').filter(Boolean)){
        const raw=JSON.parse(line);const row=activityBin(owner,raw.start,raw.end,raw.count,raw.offset,raw.timezone);
        if(raw.end<=(this.data.lastEnds[owner]??0)||raw.start<(this.data.deletedBefore[owner]??0)||raw.start<(this.data.deletedBefore[owner+':'+day]??0))continue;
        const prior=this.data.rows.find(item=>item.owner===owner&&item.day===row.day&&item.slot===row.slot&&item.timezone===row.timezone&&item.offset===row.offset);
        if(prior){prior.count+=row.count;prior.coveredMs+=row.coveredMs;prior.updatedAt=row.updatedAt;}else this.data.rows.push(row);
        this.data.lastEnds[owner]=raw.end;
      }
    }
    this.save();
  }
  view(owner:string):ActivityView{
    if(this.clock()-this.lastPrune>=60000||this.clock()<this.lastPrune)this.prune();
    identity(owner);const now=this.clock(),days=this.data.rows.filter(row=>row.owner===owner&&now-row.updatedAt<30*DAY).map(row=>({...row}));
    const current=activityBin(owner,now,now+1,0,new Date(now).getTimezoneOffset(),Intl.DateTimeFormat().resolvedOptions().timeZone);
    const relevant=days.filter(row=>row.weekend===current.weekend&&row.timezone===current.timezone&&row.offset===current.offset&&row.coveredMs>=300000);
    const rates=Array.from({length:48},(_,slot)=>{const rows=relevant.filter(row=>row.slot===slot);return {slot,days:new Set(rows.map(row=>row.day)).size,rate:rows.reduce((n,row)=>n+row.count,0)/Math.max(1,rows.reduce((n,row)=>n+row.coveredMs,0)/60000)};});
    const eligible=rates.filter(row=>row.days>=3),peak=Math.max(0,...eligible.map(row=>row.rate));
    const habitSlots=eligible.filter(row=>row.rate>=Math.max(5,peak*.75)).map(row=>row.slot);
    const enabled=this.data.consents.includes(owner);
    return {enabled,state:this.owner===owner?this.state:enabled?'paused':'disabled',error:this.owner===owner?this.error:null,policy:'keydown-repeat-v2',days,sampleDays:new Set(relevant.map(row=>row.day)).size,habitSlots,quietCompanion:enabled&&this.owner===owner&&this.state==='active'&&habitSlots.includes(current.slot)};
  }
  async select(owner:string):Promise<void>{identity(owner);this.owner=owner;return this.sync();}
  async enable(owner:string,enabled:boolean):Promise<void>{identity(owner);if(typeof enabled!=='boolean'||owner!==this.owner)throw Error('Keyboard consent belongs to a different active character');
    this.data.consents=this.data.consents.filter(id=>id!==owner);if(enabled)this.data.consents.push(owner);this.save();return this.sync();}
  async suspend(paused:boolean){this.paused=paused;return this.sync();}
  async remove(owner:string,day?:string):Promise<void>{
    identity(owner);if(owner!==this.owner||day!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('Invalid activity deletion scope');
    // Invalidate the listener generation before deleting. A late bucket cannot recreate removed data.
    await this.suspend(true);
    this.data.rows=this.data.rows.filter(row=>row.owner!==owner||day!==undefined&&row.day!==day);
    this.data.deletedBefore[day?owner+':'+day:owner]=this.clock();this.save();
    for(const file of readdirSync(this.directory))if(file.startsWith('raw.'+owner+'.')&&file.endsWith('.jsonl')&&(!day||file.endsWith('.'+day+'.jsonl')))unlinkSync(join(this.directory,file));
    this.save();await this.suspend(false);this.notify();
  }
  private sync():Promise<void>{
    const generation=++this.generation;
    this.operation=this.operation.catch(error=>this.fail(error)).then(async()=>{
      if(this.source){const source=this.source;this.source=null;await source.close();}
      if(generation!==this.generation)return;
      const owner=this.owner;
      this.error=null;this.state=!owner||!this.data.consents.includes(owner)?'disabled':this.paused?'paused':'starting';this.notify();
      if(this.state!=='starting'||!owner)return;
      const revision=++this.revision;
      const source=this.createSource({paths:collectionHelperPaths(this.packageRoot),instanceId:'book-keyboard-'+randomUUID(),onEvent:event=>{
        if(generation!==this.generation||this.source!==source)return;
        if(event.kind==='system'&&event.op==='session_locked'){void this.suspend(true).catch(error=>this.fail(error));return;}
        if(event.kind==='keyboard'&&event.grantRevision===revision){
          if(event.op==='pulse'&&this.state==='active')this.pulse();
          else if(event.op==='activity'&&this.state==='active')try{this.ingest(owner,event)}catch(error){this.stopFailed(error);}
          else if(event.op==='error')this.stopFailed(Error(String(event.payload.code??'Keyboard source failed')));
        }
      },onExit:()=>{if(this.source===source&&generation===this.generation)this.fail(Error('Keyboard helper exited'));}});
      this.source=source;
      try{source.start();await source.startKeyboard({grantId:'book-local',grantRevision:revision,localActivityOnly:true,policy:{keyboardBucketMs:10000,keyboardQuietMs:5000,afkMs:300000}});if(generation===this.generation){this.state='active';this.notify();}}
      catch(error){if(generation===this.generation){this.fail(error);this.source=null;}await source.close();}
    });return this.operation;
  }
  private fail(error:unknown){this.state='unavailable';this.error=error instanceof Error?error.message:String(error);this.notify();}
  private stopFailed(error:unknown){const source=this.source;this.source=null;++this.generation;this.fail(error);if(source)void source.close().catch(closeError=>this.fail(closeError));}
  ingest(owner:string,event:HelperEvent):void{
    if(owner!==this.owner||!this.data.consents.includes(owner)||this.paused)return;
    const start=Date.parse(String(event.payload.bucketStart)),end=Date.parse(String(event.payload.bucketEnd)),count=event.payload.activityCount;
    if(typeof count!=='number'||event.payload.foregroundAppId!==null||event.payload.countingPolicy!=='keydown-repeat-v2')throw Error('Unexpected keyboard payload or counting policy');
    const now=this.clock();if(end>now+2000||now-end>15000)throw Error('Stale keyboard coverage');
    if(end<=(this.data.lastEnds[owner]??0))return;
    if(start<(this.data.lastEnds[owner]??0))throw Error('Overlapping keyboard coverage');
    const offset=new Date(start).getTimezoneOffset(),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const row=activityBin(owner,start,end,count,offset,timezone);
    if(start<(this.data.deletedBefore[owner]??0)||start<(this.data.deletedBefore[owner+':'+row.day]??0))return;
    if(now-this.lastPrune>=60000||now<this.lastPrune)this.prune();
    appendFileSync(join(this.directory,`raw.${owner}.${row.day}.jsonl`),JSON.stringify({start,end,count,offset,timezone,policy:'keydown-repeat-v2'})+'\n',{encoding:'utf8',flush:true});
    const prior=this.data.rows.find(item=>item.owner===owner&&item.day===row.day&&item.slot===row.slot&&item.timezone===row.timezone&&item.offset===row.offset);
    if(prior){prior.count+=row.count;prior.coveredMs+=row.coveredMs;prior.updatedAt=end;}else this.data.rows.push(row);
    this.data.lastEnds[owner]=end;this.save();this.notify();
  }
  async close(){this.owner=null;await this.sync();}
}

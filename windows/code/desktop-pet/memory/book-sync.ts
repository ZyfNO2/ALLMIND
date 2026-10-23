import {createHash,randomUUID} from 'node:crypto';
import {closeSync,copyFileSync,existsSync,fsyncSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {BookError,type BookChange,type BookEntry,type BookScope,type WikiSource,type RuntimeConfig} from '../contracts/memory-book.js';
import type {BookSyncPayload,SyncItem,SyncPreview,SyncChoices} from '../contracts/book-sync.js';
import {validateEntry,validateFactSources,validateIdentity,validateScope,validateWikiSource} from './book-validation.js';
import {FileBookRepository} from './file-book-repository.js';
import {replaceResourceFile} from './resource-atomic-replace.js';
import {bookEntryHash} from './book-entry-hash.js';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const identity=(value:BookEntry|WikiSource|null)=>value===null?null:'body'in value?bookEntryHash(value):digest(JSON.stringify((({revision:_revision,...rest})=>rest)(value)));
interface Ledger {schemaVersion:'allmind-sync-ledger/v1';deviceId:string;revision:number;peers:Record<string,Record<string,string|null>>;applied:Record<string,string>;revoked?:Record<string,string[]>;bindings?:Record<string,string>}
interface Intent {schemaVersion:'allmind-sync-intent/v1';scope:BookScope;operationId:string;expectedRevision:number;change:BookChange;ledger:Ledger;config?:RuntimeConfig}
const exclusions=['模型凭据、账号/登录态与通道绑定','本机程序、工具账本、设备标识与感知记录','聊天历史、附件二进制与外观文件','角色连接配置、定时任务及未选择的私有资料'];
/** Explicit file exchange. No background network, cloud account, or whole-directory replication. */
export class BookSync {
 private ledger:Ledger;
 private readonly directory:string;
 constructor(private readonly repository:FileBookRepository,private readonly changed:(characterId:string)=>void){
  this.directory=repository.directory;const path=join(this.directory,'sync-ledger.json');
  this.ledger=existsSync(path)?this.read<Ledger>('sync-ledger.json'):{schemaVersion:'allmind-sync-ledger/v1',deviceId:randomUUID(),revision:0,peers:{},applied:{}};
  this.validateLedger(this.ledger);if(!existsSync(path))this.write('sync-ledger.json',this.ledger);
  if(existsSync(join(this.directory,'sync-apply.json')))this.finish();
 }
 private validateLedger(value:Ledger){
  if(value?.schemaVersion!=='allmind-sync-ledger/v1'||typeof value.deviceId!=='string'||!/^[a-f0-9-]{36}$/.test(value.deviceId)||!Number.isSafeInteger(value.revision)||value.revision<0||!value.peers||typeof value.peers!=='object'||Array.isArray(value.peers)||Object.keys(value.peers).length>64||!value.applied||typeof value.applied!=='object'||Array.isArray(value.applied)||Object.keys(value.applied).length>1024)throw new BookError('corrupt_data','选择性同步账本无效。');
  for(const [peer,rows]of Object.entries(value.peers)){if(!/^[a-f0-9]{64}$/.test(peer)||!rows||typeof rows!=='object'||Array.isArray(rows)||Object.keys(rows).length>8192)throw new BookError('corrupt_data','同步设备基线无效。');for(const [key,hash]of Object.entries(rows))if(!/^(entry|source):[A-Za-z0-9._-]{1,128}$/.test(key)||hash!==null&&!/^[a-f0-9]{64}$/.test(hash))throw new BookError('corrupt_data','同步基线条目无效。');}
  for(const [id,hash]of Object.entries(value.applied))if(!/^[a-f0-9-]{36}$/.test(id)||!/^[a-f0-9]{64}$/.test(hash))throw new BookError('corrupt_data','同步提交回执无效。');
  if(value.bindings!==undefined){if(!value.bindings||typeof value.bindings!=='object'||Array.isArray(value.bindings)||Object.keys(value.bindings).length>64)throw new BookError('corrupt_data','同步角色映射无效。');for(const [key,id]of Object.entries(value.bindings)){if(!/^[a-f0-9]{64}$/.test(key))throw new BookError('corrupt_data','同步角色映射键无效。');validateIdentity(id);}}
  if(value.revoked!==undefined){if(!value.revoked||typeof value.revoked!=='object'||Array.isArray(value.revoked)||Object.keys(value.revoked).length>64)throw new BookError('corrupt_data','同步撤销账本无效。');for(const [scope,ids]of Object.entries(value.revoked)){if(!/^[a-f0-9]{64}$/.test(scope)||!Array.isArray(ids)||ids.length>8192||new Set(ids).size!==ids.length)throw new BookError('corrupt_data','同步撤销身份无效。');ids.forEach(id=>validateIdentity(id));}}
 }
 private read<T>(name:string):T{const target=join(this.directory,name),stat=lstatSync(target);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>32*1024*1024)throw new BookError('corrupt_data','同步文件身份或大小无效。');try{return JSON.parse(readFileSync(target,'utf8')) as T;}catch(cause){throw new BookError('corrupt_data','同步文件不是有效 JSON。',{cause});}}
 private write(name:string,value:unknown){const target=join(this.directory,name);if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new BookError('corrupt_data','同步目标不能为链接。');const text=JSON.stringify(value)+'\n';if(Buffer.byteLength(text)>32*1024*1024)throw new BookError('budget','同步文件超过32 MiB，未写入。');const temp=target+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}replaceResourceFile(temp,target);}
 private peer(deviceId:string,scope:Pick<BookScope,'characterId'|'pairingId'>){return digest(JSON.stringify([deviceId,scope.characterId,scope.pairingId]));}
 view(){return {deviceId:this.ledger.deviceId,revision:this.ledger.revision,exclusions,mode:'manual-file-exchange' as const};}
 export(scope:BookScope,input:{entryIds:string[];recipientId?:string|null;includePrivate:boolean;includeRole?:boolean;deletedEntryIds?:string[]}){
  validateScope(scope);if(!Array.isArray(input.entryIds)||input.entryIds.length>512||new Set(input.entryIds).size!==input.entryIds.length||typeof input.includePrivate!=='boolean')throw new BookError('invalid_input','请明确选择最多512条同步资料及私人资料权限。');
  const recipient=input.recipientId??null;if(recipient!==null&&!/^[a-f0-9-]{36}$/.test(recipient))throw new BookError('invalid_input','目标设备编号无效。');if(recipient===this.ledger.deviceId)throw new BookError('invalid_input','不能向本机导出同步增量。');
  const book=this.repository.snapshot(scope),selected=input.entryIds.map(id=>{validateIdentity(id);const row=book.entries.find(e=>e.id===id);if(!row)throw new BookError('not_found','所选同步资料不存在。');return row;});
  if(!input.includePrivate&&selected.some(e=>e.pairingId!==null||['memory','state'].includes(e.type)||e.origin!=='authored'))throw new BookError('invalid_input','私人/观察资料未获同步授权；请核对并启用明确的私人同步选项。');
  if(selected.some(entry=>entry.organization?.resourceRefs?.length))throw new BookError('invalid_input','所选条目依赖本机附件文件；同步包不复制附件，请先把可独立核对的文字资料另行导入。');
  const selectedIds=new Set(selected.map(row=>row.id)),sourceIds=new Set(selected.flatMap(row=>[...row.sourceRefs.filter(id=>(book.wikiSources??[]).some(s=>s.id===id)),...(row.fact?[row.fact.sourceId]:[]),...(row.synthesis?.sources.map(s=>s.id)??[])]));
  for(const entry of selected)if(entry.synthesis?.basis.some(ref=>!selectedIds.has(ref.entryId)))throw new BookError('invalid_input','派生 Wiki 的原始依据未完整选中；不会默默复制未选择的资料。');
  const sources=[...sourceIds].map(id=>{const row=book.wikiSources?.find(source=>source.id===id);if(!row)throw new BookError('invalid_input','同步所需来源缺失。');if(row.pairingId!==null&&!input.includePrivate)throw new BookError('invalid_input','同步所需来源是私人资料，未授权导出。');return {...structuredClone(row),uri:null};});
  validateFactSources(selected,sources);const baselines=recipient?this.ledger.peers[this.peer(recipient,scope)]??{}:{};
  const items:SyncItem[]=[...selected.map(row=>({key:'entry:'+row.id,kind:'entry' as const,id:row.id,baseHash:baselines['entry:'+row.id]??null,value:structuredClone(row)})),...sources.map(row=>({key:'source:'+row.id,kind:'source' as const,id:row.id,baseHash:baselines['source:'+row.id]??null,value:row}))];
  if(input.deletedEntryIds!==undefined){if(!Array.isArray(input.deletedEntryIds)||input.deletedEntryIds.length>512||new Set(input.deletedEntryIds).size!==input.deletedEntryIds.length)throw new BookError('invalid_input','同步删除清单无效。');for(const id of input.deletedEntryIds){validateIdentity(id);if(!recipient||book.entries.some(row=>row.id===id)||!Object.hasOwn(baselines,'entry:'+id)||!baselines['entry:'+id])throw new BookError('invalid_input','删除同步必须指定已知设备基线，且本机资料已经删除。');items.push({key:'entry:'+id,kind:'entry',id,baseHash:baselines['entry:'+id]!,value:null});}}
  if(input.includeRole!==undefined&&typeof input.includeRole!=='boolean')throw new BookError('invalid_input','角色档案同步选择无效。');
  const role=input.includeRole?this.repository.loadConfig().characters.find(row=>row.id===scope.characterId):undefined;
  if(input.includeRole&&!role)throw new BookError('not_found','源角色档案不存在。');
  if(!items.length&&!role)throw new BookError('invalid_input','没有选择任何同步内容。');const payload:BookSyncPayload={schemaVersion:'allmind-selective-sync/v1',packageId:randomUUID(),deviceId:this.ledger.deviceId,recipientId:recipient,characterId:scope.characterId,pairingId:scope.pairingId,createdAt:new Date().toISOString(),includePrivate:input.includePrivate,...(role?{role:{id:role.id,name:role.name,intro:role.intro}}:{}),items,exclusions};
  if(items.length>1536)throw new BookError('budget','所选资料及依据超过1536项；请减少同步选择。');
  if(items.some(row=>row.value===null)){const next=structuredClone(this.ledger),key=digest(JSON.stringify([scope.characterId,scope.pairingId]));next.revoked??={};next.revoked[key]=[...new Set([...(next.revoked[key]??[]),...items.filter(row=>row.value===null).map(row=>row.id)])];next.revision++;this.validateLedger(next);this.write('sync-ledger.json',next);this.ledger=next;}
  const text=JSON.stringify({payload,sha256:digest(JSON.stringify(payload))},null,2);if(Buffer.byteLength(text)>32*1024*1024)throw new BookError('budget','同步包超过32 MiB；请减少选择，没有截断。');return {text,filename:'allmind-sync-'+payload.packageId+'.json',packageId:payload.packageId};
 }
 private parse(scope:BookScope,text:string):BookSyncPayload{
  if(typeof text!=='string'||Buffer.byteLength(text)>32*1024*1024)throw new BookError('invalid_input','同步包超过32 MiB。');let data;try{data=JSON.parse(text);}catch(cause){throw new BookError('invalid_input','同步包不是有效 JSON。',{cause});}
  const p=data?.payload as BookSyncPayload;
  if(!p||p.schemaVersion!=='allmind-selective-sync/v1'||data.sha256!==digest(JSON.stringify(p))||typeof p.deviceId!=='string'||!/^[a-f0-9-]{36}$/.test(p.deviceId)||typeof p.packageId!=='string'||!/^[a-f0-9-]{36}$/.test(p.packageId)||p.deviceId===this.ledger.deviceId||p.recipientId!==null&&p.recipientId!==this.ledger.deviceId||p.pairingId!==scope.pairingId||!Array.isArray(p.items)||p.items.length>1536||new Set(p.items.map(row=>row.key)).size!==p.items.length||typeof p.includePrivate!=='boolean'||!Number.isFinite(Date.parse(p.createdAt)))throw new BookError('invalid_input','同步包校验、目标设备或角色/配对身份不匹配。');
  validateIdentity(p.characterId);const mapping=this.ledger.bindings?.[this.peer(p.deviceId,scope)];if(mapping&&mapping!==p.characterId)throw new BookError('conflict','此目标角色已绑定该设备的另一个来源角色，拒绝混合记忆。');
  if(p.role&&(p.role.id!==p.characterId||typeof p.role.name!=='string'||!p.role.name.trim()||p.role.name.length>200||typeof p.role.intro!=='string'||p.role.intro.length>4000||Object.keys(p.role).some(key=>!['id','name','intro'].includes(key))))throw new BookError('invalid_input','同步角色档案无效。');
  for(const row of p.items){validateIdentity(row.id);if(!['entry','source'].includes(row.kind)||row.key!==row.kind+':'+row.id||row.baseHash!==null&&!/^[a-f0-9]{64}$/.test(row.baseHash))throw new BookError('invalid_input','同步条目标识或基线无效。');if(row.value===null){if(row.kind!=='entry')throw new BookError('invalid_input','来源不能无证据删除；请同步已撤销的来源。');continue;}
   if(row.value.id!==row.id||row.value.pairingId!==null&&row.value.pairingId!==scope.pairingId||!p.includePrivate&&row.value.pairingId!==null)throw new BookError('invalid_input','同步条目属于其他配对或没有私人资料授权。');
   if(row.kind==='entry'&&this.ledger.revoked?.[digest(JSON.stringify([scope.characterId,scope.pairingId]))]?.includes(row.id))throw new BookError('conflict','同步条目已在本机明确撤销；不会从旧设备恢复。请使用单独的明确重新记住流程。');
   if(row.kind==='entry'){
    const entry=row.value as BookEntry;validateEntry(entry);
    if(entry.organization?.resourceRefs?.length)throw new BookError('invalid_input','同步包依赖未传输的本机附件，未应用。');
    if(!p.includePrivate&&(['memory','state'].includes(entry.type)||entry.origin!=='authored'))throw new BookError('invalid_input','同步包未明确授权私人/观察资料。');
   }else validateWikiSource(row.value as WikiSource);
  }return p;
 }
 preview(scope:BookScope,text:string):SyncPreview{
  const payload=this.parse(scope,text),book=this.repository.snapshot(scope),config=this.repository.loadConfig(),role=config.characters.find(row=>row.id===scope.characterId);if(!role)throw new BookError('not_found','请先在当前设备创建并选择目标角色。');
  if(Object.hasOwn(this.ledger.applied,payload.packageId)&&this.ledger.applied[payload.packageId]!==digest(text))throw new BookError('conflict','同一同步包编号的内容不同。');
  return {hash:digest(text),packageId:payload.packageId,deviceId:payload.deviceId,sourceCharacterId:payload.characterId,targetCharacterId:scope.characterId,configRevision:config.revision,...(payload.role?{role:{local:{name:role.name,intro:role.intro},incoming:{name:payload.role.name,intro:payload.role.intro}}}:{}),revision:book.revision,ledgerRevision:this.ledger.revision,exclusions,rows:payload.items.map(row=>{const local=row.kind==='entry'?book.entries.find(e=>e.id===row.id):book.wikiSources?.find(s=>s.id===row.id),localHash=identity(local??null),remoteHash=identity(row.value);return {key:row.key,id:row.id,kind:row.kind,localHash,remoteHash,title:row.value?.title??local?.title??row.id,localContent:local?JSON.stringify(local,null,2):'本机不存在',remoteContent:row.value?JSON.stringify(row.value,null,2):'明确删除此条目',action:localHash===remoteHash?'same':localHash===null&&row.baseHash===null?'add':localHash===row.baseHash?row.value===null?'delete':'update':'conflict'};})};
 }
 apply(scope:BookScope,text:string,input:{hash:string;expectedRevision:number;expectedLedgerRevision:number;expectedConfigRevision?:number;applyRole?:boolean;choices:SyncChoices;confirmed:boolean}){
  if(input.confirmed!==true)throw new BookError('invalid_input','请核对来源、私人内容和每项冲突后明确确认同步。');const p=this.parse(scope,text),preview=this.preview(scope,text);
  if(Object.hasOwn(this.ledger.applied,p.packageId)){if(this.ledger.applied[p.packageId]!==digest(text))throw new BookError('conflict','同步包编号冲突。');return {replayed:true,revision:this.repository.snapshot(scope).revision};}
  if(preview.hash!==input.hash||preview.revision!==input.expectedRevision||preview.ledgerRevision!==input.expectedLedgerRevision)throw new BookError('conflict','同步预览或目标已变化，请重新审核。');
  if(!input.choices||typeof input.choices!=='object'||Array.isArray(input.choices)||Object.keys(input.choices).some(key=>!preview.rows.some(row=>row.key===key))||Object.values(input.choices).some(choice=>!['local','incoming'].includes(choice)))throw new BookError('invalid_input','同步冲突选择无效。');
  for(const row of preview.rows)if(row.action==='conflict'&&!Object.hasOwn(input.choices,row.key))throw new BookError('conflict','存在未解决的同步冲突；没有自动覆盖。');
  if(input.applyRole!==undefined&&typeof input.applyRole!=='boolean')throw new BookError('invalid_input','角色档案应用选择无效。');
  if(input.expectedConfigRevision!==undefined&&input.expectedConfigRevision!==preview.configRevision||input.applyRole&&input.expectedConfigRevision!==preview.configRevision)throw new BookError('conflict','角色配置已变化，请重新预览同步。');
  const config=input.applyRole&&p.role?{...this.repository.loadConfig(),characters:this.repository.loadConfig().characters.map(row=>row.id===scope.characterId?{...row,name:p.role!.name,intro:p.role!.intro}:row)}:undefined;
  const accepted=p.items.filter(row=>input.choices[row.key]==='incoming'||preview.rows.find(r=>r.key===row.key)!.action!=='conflict'&&input.choices[row.key]!=='local'),book=this.repository.snapshot(scope),upsert:BookEntry[]=[],wikiSources:WikiSource[]=[],remove:string[]=[];
  for(const row of accepted.filter(row=>row.kind==='source'&&row.value&&preview.rows.find(r=>r.key===row.key)!.action!=='same')){
   const incoming=structuredClone(row.value as WikiSource),current=book.wikiSources?.find(s=>s.id===row.id);if(current){incoming.snapshots=[...current.snapshots,...incoming.snapshots.filter(s=>!current.snapshots.some(c=>c.hash===s.hash))];incoming.forgottenKeys=[...new Set([...current.forgottenKeys,...incoming.forgottenKeys])];incoming.enabled=current.enabled&&incoming.enabled;incoming.revision=current.revision+1;}else incoming.revision=1;wikiSources.push(incoming);
  }
  const entries=new Map(book.entries.map(row=>[row.id,structuredClone(row)])),pending=new Map(accepted.filter(row=>row.kind==='entry'&&row.value&&preview.rows.find(r=>r.key===row.key)!.action!=='same').map(row=>[row.id,structuredClone(row.value as BookEntry)]));
  for(const row of accepted)if(row.kind==='entry'&&row.value===null){remove.push(row.id);entries.delete(row.id);}
  const visiting=new Set<string>(),completed=new Set<string>();
  const prepare=(id:string):BookEntry|undefined=>{
   const next=pending.get(id);if(!next)return entries.get(id);if(completed.has(id))return entries.get(id);if(visiting.has(id))throw new BookError('invalid_input','同步派生依据形成循环。');visiting.add(id);
   next.revision=book.entries.find(row=>row.id===id)?.revision??0;
   for(const ref of next.synthesis?.basis??[]){const basis=prepare(ref.entryId);if(!basis)throw new BookError('invalid_input','同步派生依据不完整。');ref.hash=bookEntryHash(basis);ref.revision=basis.revision;}
   for(const ref of next.synthesis?.sources??[]){const source=wikiSources.find(row=>row.id===ref.id)??book.wikiSources?.find(row=>row.id===ref.id);if(!source)throw new BookError('invalid_input','同步派生来源不完整。');ref.hash=source.hash;ref.revision=source.revision;}
   upsert.push(next);const final={...next,revision:next.revision+1};entries.set(id,final);visiting.delete(id);completed.add(id);return final;
  };for(const id of pending.keys())prepare(id);
  const change:BookChange={upsert,remove,wikiSources},operationId='sync-'+p.packageId;
  this.preflight(scope,change,book.revision,operationId,config);
  const ledger=structuredClone(this.ledger),peer=this.peer(p.deviceId,scope);if(!Object.hasOwn(ledger.peers,peer)&&Object.keys(ledger.peers).length>=64)throw new BookError('budget','同步设备/角色配对基线达到64组上限。');if(Object.keys(ledger.applied).length>=1024)throw new BookError('budget','同步包回执达到1024份；不会淘汰旧编号来覆盖数据。');
  ledger.peers[peer]={...(ledger.peers[peer]??{}),...Object.fromEntries(p.items.map(row=>[row.key,identity(row.value)]))};ledger.bindings??={};ledger.bindings[peer]=p.characterId;ledger.applied[p.packageId]=digest(text);ledger.revision++;this.validateLedger(ledger);
  if(remove.length){const key=digest(JSON.stringify([scope.characterId,scope.pairingId]));ledger.revoked??={};ledger.revoked[key]=[...new Set([...(ledger.revoked[key]??[]),...remove])];this.validateLedger(ledger);}
  this.write('sync-apply.json',{schemaVersion:'allmind-sync-intent/v1',scope,operationId,expectedRevision:book.revision,change,ledger,...(config?{config}:{})} satisfies Intent);this.finish();return {replayed:false,revision:this.repository.snapshot(scope).revision};
 }
 private preflight(scope:BookScope,change:BookChange,revision:number,operationId:string,config?:RuntimeConfig){
  const stage=mkdtempSync(join(this.directory,'sync-stage-'));let repository:FileBookRepository|undefined;
  try{writeFileSync(join(stage,'storage-format.json'),JSON.stringify({schemaVersion:'allmind-storage/v1',format:2,minimumReader:2}));
   for(const name of ['runtime.json','book-'+digest(scope.characterId)+'.json']){const source=join(this.directory,name);if(existsSync(source)){if(lstatSync(source).isSymbolicLink()||!lstatSync(source).isFile())throw new BookError('corrupt_data','同步原始快照身份异常。');copyFileSync(source,join(stage,name));}}
   repository=new FileBookRepository(stage);if(config)repository.commitConfig(config,config.revision,operationId+'-config');repository.commit(scope,change,revision,operationId);
  }finally{repository?.close();const target=resolve(stage);if(!target.startsWith(resolve(this.directory)+sep)||!/^sync-stage-[A-Za-z0-9]+$/.test(target.slice(resolve(this.directory).length+1))||lstatSync(target).isSymbolicLink())throw new BookError('conflict','同步校验临时目录身份变化，未清理。');rmSync(target,{recursive:true});}
 }
 private finish(){
  const intent=this.read<Intent>('sync-apply.json');if(intent.schemaVersion!=='allmind-sync-intent/v1'||!/^sync-[a-f0-9-]{36}$/.test(intent.operationId)||!Number.isSafeInteger(intent.expectedRevision)||intent.expectedRevision<0)throw new BookError('corrupt_data','同步事务日志无效。');validateScope(intent.scope);this.validateLedger(intent.ledger);
  if(!this.repository.hasBookOperation(intent.scope,intent.operationId))this.repository.commit(intent.scope,intent.change,intent.expectedRevision,intent.operationId);
  if(intent.config)this.repository.commitConfig(intent.config,intent.config.revision,intent.operationId+'-config');
  this.write('sync-ledger.json',intent.ledger);this.ledger=intent.ledger;this.changed(intent.scope.characterId);unlinkSync(join(this.directory,'sync-apply.json'));
 }
}

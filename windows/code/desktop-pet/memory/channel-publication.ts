import type {PublicationSelection} from '../contracts/book-channel.js';
import {createHash} from 'node:crypto';
import {BookError, type BookEntry, type BookScope, type RuntimeConfig, type WikiSource} from '../contracts/memory-book.js';
import type {ChannelPublication, QqConversation} from '../contracts/book-channel.js';
import type {PresetPrompt, StoredPromptPreset} from '../contracts/prompt-preset.js';
import {validateEntry, validateFactSources, validateIdentity, validateScope, validateWikiSource} from './book-validation.js';
import {bookEntryHash} from './book-entry-hash.js';
import {exportPreset, parsePreset, presetCompatibility, validateStoredPreset} from './prompt-preset.js';
import type {FileBookRepository} from './file-book-repository.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const templatePairing='public-template';
const invalid=(message:string):never=>{throw new BookError('invalid_input','QQ 角色发布：'+message);};

export function qqId(value:unknown):string {
  if(typeof value==='number'){
    if(!Number.isSafeInteger(value))return invalid('账号/消息标识不是安全整数。');
    value=String(value);
  }
  if(typeof value!=='string'||!/^\d{1,32}$/.test(value)||value==='0')return invalid('QQ 标识无效。');
  return value;
}

export function qqScope(characterId:string, conversation:QqConversation, epoch:string):BookScope {
  validateIdentity(characterId);validateIdentity(conversation.connectorId);validateIdentity(epoch);
  if(!['private','group'].includes(conversation.kind))return invalid('会话种类无效。');
  const identity=['qq',conversation.connectorId,qqId(conversation.selfId),conversation.kind,qqId(conversation.targetId)];
  // Never reuse the historical group-wide pairing: members must not inherit each other's history.
  if(conversation.kind==='group')identity.push('member-v2',qqId(conversation.senderId));
  return {characterId,pairingId:'qq-'+hash(identity),sessionId:'qq-'+hash([...identity,epoch])};
}

/** No inactive extension fields, original JSON, desktop identity or connection fields travel. */
function publicPreset(preset:StoredPromptPreset):StoredPromptPreset {
  validateStoredPreset(preset);
  const document=parsePreset(exportPreset(preset.document));
  document.prompts=document.prompts.map(row=>{
    const prompt:PresetPrompt={identifier:row.identifier};
    for(const key of ['name','role','content','marker','injection_position','injection_depth','injection_order','injection_trigger'] as const)
      if(row[key]!==undefined)Object.assign(prompt,{[key]:structuredClone(row[key])});
    return prompt;
  });
  document.prompt_order=document.prompt_order.map(block=>({character_id:block.character_id,order:block.order.map(row=>({identifier:row.identifier,enabled:row.enabled}))}));
  const result:StoredPromptPreset={id:preset.id,name:preset.name,revision:preset.revision,original:JSON.stringify(document),document,orderBlock:preset.orderBlock};
  const check=presetCompatibility(result);if(check.errors.length)return invalid(check.errors.join('；'));
  return result;
}

function publicEntry(entry:BookEntry, selected:Set<string>):BookEntry {
  validateEntry(entry);
  if(!entry.enabled||['memory','state'].includes(entry.type)||entry.event||entry.state||entry.origin==='observed'||entry.organization?.domain==='real'||entry.synthesis?.domain==='real')return invalid('个人经历、实例状态或已停用条目不可发布：'+entry.id);
  if(entry.organization?.resourceRefs?.length)return invalid('附件来源需单独转换审核，不能带入资源句柄：'+entry.id);
  const result:BookEntry={
    id:entry.id,type:entry.type,title:entry.title,body:entry.body,enabled:true,origin:entry.origin,revision:entry.revision,
    pairingId:templatePairing,sourceRefs:[...entry.sourceRefs],aliases:[...entry.aliases],tags:[...entry.tags],entities:[...entry.entities],locations:[...entry.locations],related:entry.related.filter(id=>selected.has(id)),
    timeStart:entry.timeStart,timeEnd:entry.timeEnd,validFrom:entry.validFrom,validUntil:entry.validUntil,importance:entry.importance,pinned:entry.pinned,importedHash:null,
    trigger:{strategy:entry.trigger.strategy,keys:[...entry.trigger.keys],secondaryKeys:[...entry.trigger.secondaryKeys],operator:entry.trigger.operator,priority:entry.trigger.priority,stickyTurns:entry.trigger.stickyTurns,cooldownTurns:entry.trigger.cooldownTurns},
  };
  if(entry.knowledgeCategory!==undefined)result.knowledgeCategory=entry.knowledgeCategory;
  if(entry.corePersona!==undefined)result.corePersona=entry.corePersona;
  if(entry.knowledge)result.knowledge={worldId:entry.knowledge.worldId,branch:entry.knowledge.branch,chapter:entry.knowledge.chapter,awareness:entry.knowledge.awareness};
  if(entry.canon)result.canon={level:entry.canon.level,confidence:entry.canon.confidence};
  if(entry.authorScope!==undefined)result.authorScope=entry.authorScope;
  if(entry.organization)result.organization={domain:entry.organization.domain,evidenceStatus:entry.organization.evidenceStatus,...(entry.organization.coexisting===undefined?{}:{coexisting:entry.organization.coexisting})};
  if(entry.fact){const f=entry.fact;result.fact={sourceId:f.sourceId,sourceHash:f.sourceHash,subject:f.subject,predicate:f.predicate,value:f.value,quote:f.quote,start:f.start,end:f.end,status:f.status,key:f.key};}
  if(entry.synthesis){const meta=entry.synthesis;result.synthesis={version:meta.version,pageId:meta.pageId,domain:meta.domain,...(meta.pageType?{pageType:meta.pageType}:{}),basis:meta.basis.map(ref=>({entryId:ref.entryId,revision:ref.revision,hash:ref.hash})),sources:meta.sources.map(ref=>({id:ref.id,hash:ref.hash,revision:ref.revision})),relations:meta.relations.filter(ref=>selected.has(ref.targetId)).map(ref=>({targetId:ref.targetId,label:ref.label,basisEntryIds:[...ref.basisEntryIds]}))};}
  return result;
}

export type {PublicationSelection} from '../contracts/book-channel.js';

function selectedSource(repository:FileBookRepository, selection:PublicationSelection){
  if(!selection||typeof selection!=='object'||Array.isArray(selection))return invalid('请选择要公开的角色资料。');
  validateIdentity(selection.id);validateScope(selection.scope);
  if(!Number.isSafeInteger(selection.revision)||selection.revision<1)return invalid('发布版本无效。');
  for(const ids of [selection.entryIds,selection.sourceIds]){
    if(!Array.isArray(ids)||ids.length>128||new Set(ids).size!==ids.length)return invalid('选择超过128项或含重复ID。');
    ids.forEach(id=>validateIdentity(id));
  }
  if(typeof selection.name!=='string'||!selection.name.trim()||selection.name.length>200||typeof selection.intro!=='string'||selection.intro.length>4000)return invalid('公开角色名/简介无效。');
  const config=repository.loadConfig(),book=repository.snapshot(selection.scope);
  const role=config.characters.find(row=>row.id===selection.scope.characterId);if(!role)return invalid('源角色不存在。');
  const entries=selection.entryIds.map(id=>book.entries.find(row=>row.id===id)??invalid('所选条目不可用：'+id));
  const sources=selection.sourceIds.map(id=>(book.wikiSources??[]).find(row=>row.id===id&&row.enabled)??invalid('所选来源不可用：'+id));
  const preset=selection.presetId===null?null:config.promptPresets?.find(row=>row.id===selection.presetId)??invalid('预设不存在。');
  return {entries,sources,preset,fingerprint:hash({roleId:role.id,entries:entries.map(row=>[row.id,row.revision,bookEntryHash(row)]),sources:sources.map(row=>[row.id,row.revision,hash(row)]),preset})};
}

function rebase(entries:BookEntry[],sources:WikiSource[],pairingId:string,fresh=false){
  const output=structuredClone(entries),byId=new Map(output.map(row=>[row.id,row]));
  const publishedSources=structuredClone(sources).map(row=>({...row,pairingId,...(fresh?{revision:1}:{})}));
  if(fresh)for(const entry of output){entry.revision=1;for(const ref of entry.synthesis?.sources??[])ref.revision=1;}
  const visiting=new Set<string>(),done=new Set<string>();
  const visit=(entry:BookEntry)=>{
    if(done.has(entry.id))return;if(visiting.has(entry.id))return invalid('派生证据形成循环。');visiting.add(entry.id);entry.pairingId=pairingId;
    for(const ref of entry.synthesis?.basis??[]){const basis=byId.get(ref.entryId)??invalid('派生依据未被选中：'+ref.entryId);visit(basis);ref.hash=bookEntryHash(basis);ref.revision=basis.revision;}
    visiting.delete(entry.id);done.add(entry.id);validateEntry(entry);
  };
  output.forEach(visit);validateFactSources(output,publishedSources);
  return {entries:output,sources:publishedSources};
}

/** Pure preview: caller must render all returned text and explicitly confirm its hash. */
export function previewPublication(repository:FileBookRepository,selection:PublicationSelection):ChannelPublication {
  const source=selectedSource(repository,selection),ids=new Set(selection.entryIds),sourceIds=new Set(selection.sourceIds);
  for(const entry of source.entries){
    for(const id of [...entry.sourceRefs,...(entry.fact?[entry.fact.sourceId]:[])])if(!sourceIds.has(id))return invalid('条目来源未被选中：'+id);
    for(const ref of entry.synthesis?.basis??[]){const basis=source.entries.find(row=>row.id===ref.entryId);if(!basis||basis.revision!==ref.revision||bookEntryHash(basis)!==ref.hash)return invalid('派生依据缺失或已变化：'+ref.entryId);}
    for(const ref of entry.synthesis?.sources??[]){const s=source.sources.find(row=>row.id===ref.id);if(!s||s.hash!==ref.hash||s.revision!==ref.revision)return invalid('派生来源缺失或已变化：'+ref.id);}
    for(const relation of entry.synthesis?.relations??[])if(ids.has(relation.targetId)&&relation.basisEntryIds.some(id=>!ids.has(id)))return invalid('关系依据未被选中。');
  }
  const sources=source.sources.map(row=>{
    validateWikiSource(row);const current=row.snapshots.find(s=>s.hash===row.hash)??invalid('来源缺当前正文。');
    return {id:row.id,title:row.title,uri:null,pairingId:templatePairing,enabled:true,revision:row.revision,hash:row.hash,forgottenKeys:[...row.forgottenKeys],snapshots:[{hash:current.hash,text:current.text,capturedAt:current.capturedAt}]};
  });
  const published=rebase(source.entries.map(row=>publicEntry(row,ids)),sources,templatePairing);
  const payload={schemaVersion:'allmind-channel-publication/v1' as const,id:selection.id,revision:selection.revision,sourceScope:structuredClone(selection.scope),sourceFingerprint:source.fingerprint,character:{id:selection.scope.characterId,name:selection.name,intro:selection.intro},preset:source.preset?publicPreset(source.preset):null,...published};
  if(Buffer.byteLength(JSON.stringify(payload),'utf8')>2*1024*1024)return invalid('发布资料超过2 MiB。');
  return {...payload,hash:hash(payload)};
}

export function assertPublicationCurrent(repository:FileBookRepository,publication:ChannelPublication):void {
  const {hash:expected,...payload}=publication;if(hash(payload)!==expected)throw new BookError('conflict','发布预览已被修改，需重新审核。');
  const selected=selectedSource(repository,{id:publication.id,revision:publication.revision,scope:publication.sourceScope,entryIds:publication.entries.map(row=>row.id),sourceIds:publication.sources.map(row=>row.id),name:publication.character.name,intro:publication.character.intro,presetId:publication.preset?.id??null});
  if(selected.fingerprint!==publication.sourceFingerprint)throw new BookError('conflict','已发布的源资料已修改或撤销，需重新审核。');
}

/** Produces one target's data only. The channel service must use a separate repository root. */
export function publicationForPairing(publication:ChannelPublication,pairingId:string){
  validateIdentity(pairingId);const {hash:expected,...payload}=publication;if(hash(payload)!==expected)throw new BookError('conflict','发布快照校验失败。');
  return rebase(publication.entries,publication.sources,pairingId,true);
}

export function publicationRuntime(publication:ChannelPublication,base:RuntimeConfig):RuntimeConfig {
  const {hash:expected,...payload}=publication;if(hash(payload)!==expected)throw new BookError('conflict','发布快照校验失败。');
  return {schemaVersion:'memory-runtime/v1',revision:base.revision,currentCharacterId:publication.character.id,
    characters:[{...publication.character,appearancePath:null,...(publication.preset?{promptPresetId:publication.preset.id}:{})}],
    mainModel:base.mainModel?structuredClone(base.mainModel):null,fastModel:null,wikiModel:null,
    recall:structuredClone(base.recall),replyLanguage:base.replyLanguage??'zh-CN',
    ...(publication.preset?{promptPresets:[structuredClone(publication.preset)]}:{}),
    ...(base.chatgptWeb?{chatgptWeb:{...structuredClone(base.chatgptWeb),conversationMode:'temporary',temporaryChatTests:true,authorizedPurposes:['reply']}}:{}),chatgptProjects:[],
  };
}

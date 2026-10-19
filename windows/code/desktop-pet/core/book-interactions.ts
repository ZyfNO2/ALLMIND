import {BookError,type BookScope} from '../contracts/memory-book.js';
import type {CompanionRepository} from '../contracts/book-companion.js';
import {validateInteractionSettings,COMPANION_INTERACTIONS,type InteractionSettings,type InteractionChoice,type CompanionInteraction} from '../contracts/companion-interactions.js';
import type {SkinManifest} from '../contracts/skin.js';
import {resolveLocalPetSlot} from '../contracts/local-pet.js';

/** A generic motion is not evidence that a role offers a particular interaction. */
export function declaredInteractionBindings(manifest:SkinManifest):Partial<Record<CompanionInteraction,string>>{
  const kinds={touch:'petting',feed:'feeding',gift:'gifting'} as const;
  return Object.fromEntries(COMPANION_INTERACTIONS.flatMap(kind=>{
    const target=resolveLocalPetSlot(manifest.localInteractions??null,manifest,kinds[kind]).target;
    return target?[[kind,(target.kind==='sprite'?'clip:':'preset:')+target.targetId]]:[];
  }));
}

/** Explicit resources only; no synthetic animation catalog and no imported outfit controls. */
export function interactionChoices(manifest:SkinManifest):InteractionChoice[]{
  if(manifest.type==='sprite')return ['idle','working','happy','sleeping'].flatMap(id=>{
    const clip=manifest.sprite?.clips?.[id as 'idle'|'working'|'happy'|'sleeping'];return clip?[{id:'clip:'+id,label:`${id}（${clip.frameCount>1?'动画':'静态姿态'}）`,kind:'sprite' as const,targetId:id}]:[];
  });
  return manifest.catalog.items.filter(item=>item.previewable&&item.availability!=='unavailable'&&['model-expression','model-motion'].includes(item.source)&&item.category!=='appearance')
    .map(item=>({id:'preset:'+item.id,label:item.label,kind:'preset' as const,targetId:item.id}));
}
export function interactionBindings(repository:CompanionRepository,scope:BookScope,manifest:SkinManifest){
  const settings=repository.loadCompanionData(scope).interactionSettings,choices=interactionChoices(manifest),declared=declaredInteractionBindings(manifest);
  const matched=!!settings&&settings.skinId===manifest.skinId&&settings.assetFingerprint===manifest.assetFingerprint;
  return {settings:settings??null,choices,declared,matched,bindings:Object.fromEntries(COMPANION_INTERACTIONS.map(kind=>[kind,matched&&declared[kind]===settings.bindings[kind]&&choices.some(row=>row.id===settings.bindings[kind])?settings.bindings[kind]:null])) as Record<CompanionInteraction,string|null>};
}
export function saveInteractionSettings(repository:CompanionRepository,scope:BookScope,manifest:SkinManifest,input:{skinId:string;assetFingerprint:string;bindings:Record<CompanionInteraction,string|null>},expectedRevision:number){
  if(!input||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||input.skinId!==manifest.skinId||input.assetFingerprint!==manifest.assetFingerprint)throw new BookError('conflict','形象资源或设置修订已变化，请重新读取可用动作。');
  const data=repository.loadCompanionData(scope),previous=data.interactionSettings,proposed:InteractionSettings={...input,revision:(previous?.revision??0)+1};
  try{validateInteractionSettings(proposed)}catch(cause){throw new BookError('invalid_input','互动映射字段无效。',{cause})}
  const choices=interactionChoices(manifest),declared=declaredInteractionBindings(manifest);if(COMPANION_INTERACTIONS.some(kind=>proposed.bindings[kind]!==null&&(declared[kind]!==proposed.bindings[kind]||!choices.some(row=>row.id===proposed.bindings[kind]))))throw new BookError('invalid_input','角色未声明此互动，或所选动作不在对应声明与当前资源中。');
  if(previous&&previous.skinId===proposed.skinId&&previous.assetFingerprint===proposed.assetFingerprint&&COMPANION_INTERACTIONS.every(kind=>previous.bindings[kind]===proposed.bindings[kind]))return data;
  if((previous?.revision??0)!==expectedRevision)throw new BookError('conflict','互动设置已更新，草稿保留，请刷新核对。');
  data.interactionSettings=proposed;return repository.saveCompanionData(scope,data);
}

import type {SkinManifest} from './skin.js';
export const PET_ACTIONS=['gazing','petting','dragging','moving','chasing','docked','jumping','feeding','gifting','playing','resting','typing'] as const;
export type PetActionKind=typeof PET_ACTIONS[number];
export type PetPresentation='played'|'missing'|'loading'|'failed';
export interface PetAction {id:string;kind:PetActionKind;startedAt:number;updatedAt:number;until:number;presentation:PetPresentation}

/** Declarative role/appearance contribution. No paths, executable scripts, model calls or rewards. */
export interface LocalPetInteractionPack {
  schemaVersion:'local-pet/v1';skinId:string;assetFingerprint:string;
  bindings:Partial<Record<PetActionKind,{kind:'sprite'|'preset';targetId:string}|null>>;
}
export function resolveLocalPetSlot(pack:LocalPetInteractionPack|null,manifest:SkinManifest|null,kind:PetActionKind){
  if(!PET_ACTIONS.includes(kind))throw Error('Unknown local interaction slot');
  if(!pack)return {kind,availability:'placeholder' as const,target:null};
  if(!manifest||Object.keys(pack).some(key=>!['schemaVersion','skinId','assetFingerprint','bindings'].includes(key))||pack.schemaVersion!=='local-pet/v1'||pack.skinId!==manifest.skinId||pack.assetFingerprint!==manifest.assetFingerprint||!pack.bindings||typeof pack.bindings!=='object'||Array.isArray(pack.bindings)||Object.keys(pack.bindings).some(key=>!PET_ACTIONS.includes(key as PetActionKind)))throw Error('Local interaction pack is invalid or belongs to different appearance bytes');
  for(const target of Object.values(pack.bindings)){
    if(target===null)continue;
    if(!target||typeof target.targetId!=='string'||target.targetId.length>160||Object.keys(target).some(key=>!['kind','targetId'].includes(key)))throw Error('Invalid local interaction resource');
    const allowed=target.kind==='sprite'?manifest.type==='sprite'&&['idle','happy','working','sleeping'].includes(target.targetId)&&!!manifest.sprite?.clips?.[target.targetId as 'idle']
      :target.kind==='preset'&&manifest.type!=='sprite'&&manifest.catalog.items.some(item=>item.id===target.targetId&&item.previewable&&item.availability!=='unavailable'&&item.category!=='appearance'&&['model-motion','model-expression'].includes(item.source));
    if(!allowed)throw Error('Local interaction resource is absent from the current appearance catalog');
  }
  const target=pack.bindings[kind]??null;
  return {kind,availability:target?'available' as const:'placeholder' as const,target};
}

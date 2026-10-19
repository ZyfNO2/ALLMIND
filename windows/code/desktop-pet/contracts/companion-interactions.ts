export const COMPANION_INTERACTIONS=['touch','feed','gift'] as const;
export type CompanionInteraction=typeof COMPANION_INTERACTIONS[number];
export interface InteractionSettings {
  revision:number;skinId:string;assetFingerprint:string;
  bindings:Record<CompanionInteraction,string|null>;
}
export interface InteractionRecord {id:string;kind:CompanionInteraction;at:number;delta:number;undone:boolean}
export interface InteractionChoice {id:string;label:string;kind:'sprite'|'preset';targetId:string}
export type InteractionControlsState={available:false;reason:string}|{available:true;skinId:string;assetFingerprint:string;settings:InteractionSettings|null;choices:InteractionChoice[];declared?:Partial<Record<CompanionInteraction,string>>;matched:boolean;bindings:Record<CompanionInteraction,string|null>;mood:number;records:InteractionRecord[];allowance:{allowed:boolean;reason:string};pending:boolean};
export interface CompanionInteractionControls {
  read(scope:import('./memory-book.js').BookScope):InteractionControlsState;
  configure(scope:import('./memory-book.js').BookScope,input:{skinId:string;assetFingerprint:string;bindings:Record<CompanionInteraction,string|null>},expectedRevision:number):InteractionControlsState;
  perform(scope:import('./memory-book.js').BookScope,kind:CompanionInteraction,id:string,expectedRevision:number,signal:AbortSignal):Promise<{controls:InteractionControlsState;played:boolean;message:string}>;
  undo(scope:import('./memory-book.js').BookScope,id:string):Promise<InteractionControlsState>;
}
export function validateInteractionSettings(value:InteractionSettings):void{
  if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['revision','skinId','assetFingerprint','bindings'].includes(key))||!Number.isSafeInteger(value.revision)||value.revision<1
    ||typeof value.skinId!=='string'||!value.skinId||value.skinId.length>64||typeof value.assetFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.assetFingerprint)
    ||!value.bindings||typeof value.bindings!=='object'||Object.keys(value.bindings).length!==3||Object.keys(value.bindings).some(key=>!COMPANION_INTERACTIONS.includes(key as CompanionInteraction))
    ||COMPANION_INTERACTIONS.some(kind=>value.bindings[kind]!==null&&(typeof value.bindings[kind]!=='string'||value.bindings[kind]!.length>160||!value.bindings[kind])))throw Error('Invalid companion interaction settings');
}

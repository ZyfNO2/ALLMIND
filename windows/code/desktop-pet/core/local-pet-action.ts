/** Transient action data consumed by the existing presentation arbiter; no timer or storage owner. */
import {PET_ACTIONS,type PetActionKind,type PetPresentation,type PetAction} from '../contracts/local-pet.js';
export {PET_ACTIONS,type PetActionKind,type PetPresentation,type PetAction} from '../contracts/local-pet.js';
const duration:Record<PetActionKind,number>={gazing:800,petting:1200,dragging:1500,moving:1500,chasing:1500,docked:1500,jumping:900,feeding:1800,gifting:1800,playing:4000,resting:2000,typing:800};
export function startPetAction(previous:PetAction|null,kind:PetActionKind,id:string,now:number,presentation:PetPresentation):PetAction{
  if(!PET_ACTIONS.includes(kind)||!['played','missing','loading','failed'].includes(presentation)||!Number.isSafeInteger(now)||now<0||!/^[\w.-]{1,128}$/.test(id))throw Error('Invalid local pet action');
  const same=previous?.kind===kind&&now>=previous.updatedAt&&now<previous.until;
  return {id:same?previous.id:id,kind,startedAt:same?previous.startedAt:now,updatedAt:now,until:now+duration[kind],presentation:same?previous.presentation:presentation};
}
export function advancePetAction(action:PetAction|null,now:number,interrupted:boolean):{active:PetAction|null;completed:PetAction|null;cancelled:PetAction|null}{
  if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid local pet action clock');
  if(!action)return {active:null,completed:null,cancelled:null};
  if(interrupted||now<action.updatedAt)return {active:null,completed:null,cancelled:action};
  if(now>=action.until){const completed=action.presentation==='played';return {active:null,completed:completed?action:null,cancelled:completed?null:action};}
  return {active:action,completed:null,cancelled:null};
}

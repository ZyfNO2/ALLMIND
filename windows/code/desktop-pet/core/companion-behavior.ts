/** Local life has no model, device or transcript dependency. Book is its only persistent owner. */
import {COMPANION_INTERACTIONS,type CompanionInteraction,type InteractionRecord} from '../contracts/companion-interactions.js';
import {PET_ACTIONS,type PetAction,type PetActionKind,type PetPresentation} from './local-pet-action.js';
export interface PetInteractionSummary {id:string;kind:PetActionKind;at:number;presentation:PetPresentation}
export interface CompanionLifeState {
  characterId: string; pairingId: string; revision: number; enabled: boolean; quiet: boolean;
  activity: 'idle' | 'walking' | 'resting'; energy: number; mood: number;
  updatedAt: number; nextActivityAt: number; touchedUntil: number;
  interactions?:InteractionRecord[];
  /** Private local history, independent from the twelve daily mood rewards. */
  localHistory?:PetInteractionSummary[];
}
export function validateCompanionLife(value: CompanionLifeState): void {
  if(value?.localHistory!==undefined&&(!Array.isArray(value.localHistory)||value.localHistory.length>2048||new Set(value.localHistory.map(row=>row.id)).size!==value.localHistory.length||value.localHistory.some(row=>!row||!/^[\w.-]{1,128}$/.test(row.id)||!PET_ACTIONS.includes(row.kind)||!Number.isSafeInteger(row.at)||row.at<0||!['played','missing'].includes(row.presentation))))throw Error('本地互动摘要无效。');
  if(value?.interactions!==undefined&&(!Array.isArray(value.interactions)||value.interactions.length>12||new Set(value.interactions.map(row=>row?.id)).size!==value.interactions.length||value.interactions.some(row=>!row||typeof row.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.id)||!COMPANION_INTERACTIONS.includes(row.kind)||!Number.isSafeInteger(row.at)||row.at<0||!Number.isFinite(row.delta)||row.delta<0||row.delta>18||typeof row.undone!=='boolean'||row.undone&&row.delta!==0)))throw Error('桌宠互动记录无效。');
  if (!value || typeof value.characterId !== 'string' || typeof value.pairingId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.characterId)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.pairingId)
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.enabled !== 'boolean' || typeof value.quiet !== 'boolean'
    || !['idle', 'walking', 'resting'].includes(value.activity)
    || ![value.energy, value.mood].every(n => Number.isFinite(n) && n >= 0 && n <= 100)
    || ![value.updatedAt, value.nextActivityAt, value.touchedUntil].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error('桌宠生活状态无效。');
}
export function createCompanionLifeState(scope: { characterId: string; pairingId: string }, now: number): CompanionLifeState {
  const state: CompanionLifeState = { characterId: scope.characterId, pairingId: scope.pairingId, revision: 0, enabled: true, quiet: false, activity: 'idle', energy: 80, mood: 50,
    updatedAt: now, nextActivityAt: now + 30000, touchedUntil: 0 };
  validateCompanionLife(state); return state;
}
export class CompanionBehavior {
  private life: CompanionLifeState;
  constructor(state: CompanionLifeState) { validateCompanionLife(state); this.life = structuredClone(state); }
  snapshot(): CompanionLifeState { return structuredClone(this.life); }
  completeLocalAction(id:string,kind:PetActionKind,at:number,presentation:PetPresentation):boolean{
    if(presentation!=='played')throw Error('未确认实际播放的互动不能记为完成。');
    const row={id,kind,at,presentation},candidate={...this.life,localHistory:[row]};validateCompanionLife(candidate);
    const prior=this.life.localHistory?.find(item=>item.id===id);
    if(prior){if(prior.kind!==kind||prior.presentation!==presentation)throw Error('本地互动ID冲突。');return false;}
    const history=this.life.localHistory??[];
    if(history.some(item=>item.at>at))throw Error('本机时间回退，未写入互动摘要。');
    this.life.localHistory=[...history.filter(item=>at-item.at<30*86400000),row].slice(-2048);return true;
  }
  clearLocalHistory():void{this.life.localHistory=[];}
  saved(state: CompanionLifeState): void { validateCompanionLife(state); this.life.revision = state.revision; }
  tick(now: number, busy = false, paused = false): CompanionLifeState {
    if (!Number.isSafeInteger(now) || now < 0) throw Error('桌宠时间无效。');
    // Clock rollback and suspend/resume never punish an absent user or replay a week's activity.
    const wallElapsed=Math.max(0,now-this.life.updatedAt),elapsed = Math.min(60000,wallElapsed);
    if (now < this.life.updatedAt || now - this.life.updatedAt > 5 * 60000) {
      this.life.nextActivityAt = now + 30000; this.life.touchedUntil = 0;
    }
    const gain = this.life.activity === 'resting' ? 0.02 : this.life.activity === 'walking' ? -0.004 : 0.001;
    this.life.energy = Math.min(100, Math.max(0, this.life.energy + elapsed / 1000 * gain));
    const decay=Math.min(1,elapsed/3600000);
    this.life.mood += (50 - this.life.mood) * decay;
    for(const row of this.life.interactions??[]){
      const boundedDelta=row.delta*(1-decay),remaining=now-row.at>=86400000?0:boundedDelta*Math.exp(-Math.max(0,wallElapsed-elapsed)/3600000);
      this.life.mood=Math.max(0,Math.min(100,this.life.mood-(boundedDelta-remaining)));row.delta=remaining;
    }
    this.life.updatedAt = now;
    if(this.life.localHistory)this.life.localHistory=this.life.localHistory.filter(row=>now-row.at<30*86400000);
    if (!this.life.enabled || paused) { this.life.activity = 'idle'; if(paused)this.life.nextActivityAt=Math.max(this.life.nextActivityAt,now+30000); }
    else if (!busy && now >= this.life.nextActivityAt) {
      this.life.activity = this.life.energy < 35 ? 'resting'
        : this.life.activity === 'idle' ? 'walking' : this.life.activity === 'walking' ? 'resting' : 'idle';
      this.life.nextActivityAt = now + ({ idle: 60000, walking: 20000, resting: 45000 }[this.life.activity]);
    }
    return this.snapshot();
  }
  touch(now: number): CompanionLifeState {
    return this.interact('touch',`touch.${now}`,now).state;
  }
  interactionAllowance(now:number):{allowed:boolean;reason:string}{
    if(!Number.isSafeInteger(now)||now<0)throw Error('互动时间无效。');
    const history=this.life.interactions??[],last=Math.max(-Infinity,...history.map(row=>row.at));
    if(now<last)return {allowed:false,reason:'本机时间回退，暂停互动奖励。'};
    if(now-last<30000)return {allowed:false,reason:'互动间隔至少30秒，稍后再来。'};
    if(history.filter(row=>now-row.at<86400000).length>=12)return {allowed:false,reason:'最近24小时的12次互动反馈已用完；撤销不退回次数。'};
    return {allowed:true,reason:''};
  }
  interact(kind:CompanionInteraction,id:string,now:number):{state:CompanionLifeState;applied:boolean;reason:string}{
    if(!COMPANION_INTERACTIONS.includes(kind)||typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))throw Error('互动类型或ID无效。');
    this.tick(now,true);
    const previous=this.life.interactions?.find(row=>row.id===id);
    if(previous){if(previous.kind!==kind)throw Error('同一互动ID不能更换类型。');return {state:this.snapshot(),applied:false,reason:previous.undone?'该互动已撤销。':'该互动已处理，未重复反馈。'};}
    const allowance=this.interactionAllowance(now);if(!allowance.allowed)return {state:this.snapshot(),applied:false,reason:allowance.reason};
    const amount={touch:18,feed:8,gift:12}[kind],delta=Math.min(amount,100-this.life.mood);this.life.mood+=delta;
    this.life.interactions=[...(this.life.interactions??[]).filter(row=>now-row.at<86400000),{id,kind,at:now,delta,undone:false}];
    this.life.touchedUntil=now+4000;return {state:this.snapshot(),applied:true,reason:''};
  }
  undoInteraction(id:string,now:number):CompanionLifeState{
    this.tick(now,true);const row=this.life.interactions?.find(row=>row.id===id);if(!row)throw Error('该互动已不在可撤销记录中。');
    if(!row.undone){this.life.mood=Math.max(0,Math.min(100,this.life.mood-row.delta));row.delta=0;row.undone=true;if(this.life.interactions?.at(-1)?.id===id)this.life.touchedUntil=0;}
    return this.snapshot();
  }
  setEnabled(enabled: boolean, now: number): CompanionLifeState {
    if (typeof enabled !== 'boolean') throw Error('自主活动开关无效。');
    this.tick(now, true); this.life.enabled = enabled; this.life.activity = 'idle'; this.life.nextActivityAt = now + 30000;
    this.life.touchedUntil = 0; return this.snapshot();
  }
  setQuiet(quiet: boolean): CompanionLifeState {
    if (typeof quiet !== 'boolean') throw Error('免打扰开关无效。');
    this.life.quiet = quiet; return this.snapshot();
  }
}
/** One arbitration point for dialogue > touch > autonomous activity. No changes to dialogue scope. */
export function arbitrateCompanionPresentation<T extends { state?: string; characterId?: string; expression?: { emotion?: string }; mouth?: number }>(
  view: T, life: CompanionLifeState | null, now: number, options: { hidden?: boolean; interacting?: boolean; focused?:boolean; action?:PetAction|null; delivery?:{emotion:'happy'|'neutral';until:number};relationship?:{emotion:'happy'|'neutral';intensity:number;until:number} } = {},
) {
  const dialogue = ['listening', 'thinking', 'speaking'].includes(view.state ?? '');
  const usable = life && life.enabled && !options.hidden && !options.interacting && !options.focused
    && (!view.characterId || life.characterId === view.characterId) && now - life.updatedAt <= 10000 && now >= life.updatedAt;
  if (dialogue || !usable) return { ...view, characterState: dialogue ? view.state : 'idle', localActivity: 'idle' };
  const action=options.action;
  if(action&&!life.quiet&&action.updatedAt<=now&&now<action.until&&action.presentation!=='failed')return {...view,characterState:['feeding','gifting','petting','playing'].includes(action.kind)?'happy':action.kind==='resting'?'sleeping':['moving','chasing','typing','jumping'].includes(action.kind)?'working':'idle',localActivity:action.kind,mouth:0};
  const touched = life.touchedUntil > now;
  const delivered=options.delivery?.emotion==='happy'&&Number.isFinite(options.delivery.until)&&options.delivery.until>now&&options.delivery.until-now<=4000;
  const relationship=options.relationship&&options.relationship.until>now&&options.relationship.until-now<=10000&&Number.isFinite(options.relationship.intensity)&&options.relationship.intensity>0&&options.relationship.intensity<=.45?options.relationship:null;
  const relationshipHappy=relationship?.emotion==='happy';
  return { ...view, characterState: touched || (delivered||relationshipHappy)&&life.activity==='idle' ? 'happy' : life.activity === 'resting' ? 'sleeping' : life.activity === 'walking' ? 'working' : 'idle',
    expression: { emotion: touched || delivered || relationshipHappy || life.mood >= 65 ? 'happy' : 'neutral', intensity: delivered ? .35 : relationship?.intensity??Math.min(.7, Math.abs(life.mood - 50) / 50), delivery: '', gesture: null },
    mouth: 0, localActivity: touched ? 'touch' : life.activity };
}

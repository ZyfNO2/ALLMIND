import {BookError,type BookScope,type RuntimeConfig} from '../contracts/memory-book.js';
import {DIALOGUE_MODES,type DialogueMode,type DialogueDecision} from '../contracts/book-dialogue.js';
export function dialogueChoice(base:RuntimeConfig,query:string,requested:DialogueMode|'inherit'='inherit'):{choice:DialogueMode;mode:'smart'|'quick'|'rp'}{
 if(!['inherit',...DIALOGUE_MODES].includes(requested))throw new BookError('invalid_input','场景模式须为 Auto / Smart / Quick / RP 或沿用设置。');
 const configured=base.dialogueRouting,choice=requested==='inherit'?configured?.defaultMode??(base.recall.mode==='story-rp'?'rp':'smart'):requested;
 const mode=choice==='auto'?(/^\/rp(?:\s|$)/i.test(query)?'rp':/^(?:你好|早上好|晚上好|晚安|嗨|hi|hello|谢谢|thanks)[!！。,.，?？\s]*$/i.test(query.trim())?'quick':'smart'):choice;
 return {choice,mode};
}
export function dialogueRoute(base:RuntimeConfig,scope:BookScope,query:string,requested:DialogueMode|'inherit'='inherit'):{config:RuntimeConfig;decision:DialogueDecision}{
 const {choice,mode}=dialogueChoice(base,query,requested),configured=base.dialogueRouting;
 const profile=configured?.profiles[mode],config=structuredClone(base),role=config.characters.find(row=>row.id===scope.characterId);
 if(!role)throw new BookError('not_found','场景路由角色不存在。');
 const legacy=!configured&&requested==='inherit';
 config.mainModel=profile?.model?structuredClone(profile.model):config.mainModel;
 if(!config.mainModel)throw new BookError('unavailable','当前场景没有可用模型，请在场景路由或主模型中明确配置；未自动换模型。');
 if(profile?.presetId!==undefined){if(profile.presetId===null)delete role.promptPresetId;else role.promptPresetId=profile.presetId;}
 config.recall.mode=profile?.recallMode??(legacy?base.recall.mode:mode==='quick'?'off':mode==='rp'?'story-rp':'smart');
 config.recall.memoryDomain=profile?.memoryDomain??(legacy?base.recall.memoryDomain??'all':mode==='quick'?'core-only':mode==='rp'?'fiction':'all');
 if(profile?.inputTokens!==undefined)config.mainModel.inputTokens=Math.min(profile.inputTokens,config.mainModel.inputTokens);
 if(profile?.outputTokens!==undefined)config.mainModel.outputTokens=Math.min(profile.outputTokens,config.mainModel.outputTokens);
 if(config.mainModel.inputTokens<=config.mainModel.outputTokens)throw new BookError('budget','场景输入窗口必须大于输出预算。');
 return {config,decision:{requested,mode,reason:choice==='auto'?'Auto：明确 /rp 前缀走 RP；纯问候走 Quick；其余 Smart。':requested==='inherit'?'沿用已保存场景。':'本轮手动覆盖；不会改变其他会话。',model:config.mainModel.model,modelKind:config.mainModel.kind??'http',presetId:role.promptPresetId??null,recallMode:config.recall.mode,memoryDomain:config.recall.memoryDomain,inputBudget:config.mainModel.inputTokens-config.mainModel.outputTokens,outputBudget:config.mainModel.outputTokens}};
}

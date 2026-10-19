import {BookError,type ChatMessage,type ModelBinding} from '../contracts/memory-book.js';
import {type StoredPromptPreset,type PromptSegment,type PromptCompilation,type PresetPrompt} from '../contracts/prompt-preset.js';
import {presetCompatibility,validateStoredPreset} from '../memory/prompt-preset.js';
import {bookTokenCost} from '../memory/local-book-index.js';
import {createHash} from 'node:crypto';

export interface PresetContext {
  preset:StoredPromptPreset;char:string;user:string;intro:string;binding:ModelBinding;
}
export function presetBudget(context:PresetContext):{input:number;output:number;parameters:Record<string,number>}{
  const document=context.preset.document,binding=context.binding;
  const window=Math.min(binding.inputTokens,document.openai_max_context??binding.inputTokens);
  const output=document.openai_max_tokens??binding.outputTokens;
  if(!Number.isSafeInteger(output)||output<1||output>=window)throw new BookError('budget','预设输出预留必须小于有效模型窗口，请调整预设或模型配置。');
  const parameters:Record<string,number>={};
  if(binding.kind!=='chatgpt-web')for(const key of ['temperature','top_p','frequency_penalty','presence_penalty'] as const){
    const value=document[key];if(value===undefined)continue;
    const [min,max]=key==='temperature'?[0,2]:key==='top_p'?[0,1]:[-2,2];
    if(value<min!||value>max!)throw new BookError('invalid_input','预设参数 '+key+' 超出当前 HTTP 适配器范围。');
    parameters[key]=value;
  }
  return {input:window-output-64,output,parameters};
}

/** One deterministic compilation. History and recalled data never become macro source code. */
export function compilePreset(context:PresetContext,input:{current:string;history:ChatMessage[];segments:PromptSegment[];policy:string;budget:number}):{messages:ChatMessage[];compilation:PromptCompilation;retained:Set<string>}{
  const {preset}=context;validateStoredPreset(preset);
  const compatibility=presetCompatibility(preset);if(compatibility.errors.length)throw new BookError('invalid_input',compatibility.errors.join('\n'));
  const order=preset.document.prompt_order.find(block=>block.character_id===preset.orderBlock)!.order;
  const active=order.filter(row=>row.enabled).map(row=>preset.document.prompts.find(prompt=>prompt.identifier===row.identifier)!).filter(prompt=>!prompt.injection_trigger?.length||prompt.injection_trigger.includes('normal'));
  if(active.filter(row=>row.identifier==='chatHistory'&&row.marker).length!==1)throw new BookError('invalid_input','当前任务没有唯一的 chatHistory，未发送。');
  const warnings=[...compatibility.warnings],omissions:PromptCompilation['omissions']=[];
  const retained=new Set(input.segments.map(segment=>segment.id));
  const history=[...input.history].filter(message=>message.role==='user'||message.role==='assistant');
  const macroSlots:Record<string,string>={description:'charDescription',personality:'charPersonality',scenario:'scenario',persona:'personaDescription'};
  const usedSlots=new Set<string>(active.filter(row=>row.marker).map(row=>row.identifier));
  for(const prompt of active)for(const macro of (prompt.content??'').matchAll(/\{\{\s*(description|personality|scenario|persona)\s*\}\}/g))usedSlots.add(macroSlots[macro[1]!]!);
  for(const segment of input.segments)if(!usedSlots.has(segment.slot)){retained.delete(segment.id);omissions.push({id:segment.id,reason:'slot_disabled'});}
  const expand=(text:string)=>text.replace(/\{\{\/\/[\s\S]*?\}\}/g,'').replace(/\{\{([\s\S]*?)\}\}/g,(_all,key:string)=>{
    key=key.trim();if(key==='char'||key==='charIfNotGroup')return context.char;if(key==='user')return context.user;if(key==='trim')return '';
    const slot=macroSlots[key];if(slot)return (slot==='charDescription'?context.intro+'\n':'')+input.segments.filter(segment=>segment.slot===slot&&retained.has(segment.id)).map(segment=>segment.content).join('\n\n');
    throw new BookError('invalid_input','不支持宏 '+key+'，未发送。');
  });
  type Piece={identifier:string;message:ChatMessage;depth:number|null};
  const build=()=>{
    const pieces:Piece[]=[];
    const real=[...history,{role:'user' as const,content:input.current}];
    const buckets=new Map<number,{prompt:PresetPrompt;pieces:Piece[]}[]>();
    const contents=(prompt:PresetPrompt):Piece[]=>{
      const role=prompt.role??'system';
      if(prompt.marker){
        if(prompt.identifier==='chatHistory')return real.map((message,index)=>({identifier:index===real.length-1?'allmind.current':'history.'+index,message,depth:null}));
        const selected=input.segments.filter(segment=>segment.slot===prompt.identifier&&retained.has(segment.id));
        const rows=selected.map(segment=>({identifier:segment.id,message:{role,content:segment.content},depth:null as number|null}));
        if(prompt.identifier==='charDescription'&&context.intro.trim())rows.unshift({identifier:'character.intro',message:{role,content:context.intro},depth:null});
        return rows;
      }
      const content=expand(prompt.content??'');return content.trim()?[{identifier:prompt.identifier,message:{role,content},depth:null}]:[];
    };
    for(const prompt of active)if(prompt.injection_position===1){
      if(prompt.identifier==='chatHistory')throw new BookError('invalid_input','chatHistory 不能设为 In-Chat。');
      const depth=prompt.injection_depth??4,index=Math.max(0,real.length-depth);
      const rows=buckets.get(index)??[];rows.push({prompt,pieces:contents(prompt).map(piece=>({...piece,depth}))});buckets.set(index,rows);
    }
    const injected:Piece[]=[];
    for(let index=0;index<=real.length;index++){
      // The pinned ST implementation reverses the depth groups before final output.
      const ranks={assistant:0,user:1,system:2};
      const rows=(buckets.get(index)??[]).sort((a,b)=>(a.prompt.injection_order??100)-(b.prompt.injection_order??100)||ranks[a.prompt.role??'system']-ranks[b.prompt.role??'system']);
      for(const row of rows)injected.push(...row.pieces);
      if(index<real.length)injected.push({identifier:index===real.length-1?'allmind.current':'history.'+index,message:real[index]!,depth:null});
    }
    for(const prompt of active)if(prompt.injection_position!==1){if(prompt.identifier==='chatHistory')pieces.push(...injected);else pieces.push(...contents(prompt));}
    // Non-disableable evidence/privacy protocol is visible and charged, never an RP style preset.
    if(input.policy.trim())pieces.unshift({identifier:'allmind.protocol',message:{role:'system',content:input.policy},depth:null});
    return pieces;
  };
  let pieces=build();const cost=()=>pieces.reduce((sum,piece)=>sum+bookTokenCost(piece.message.content),0);
  while(cost()>input.budget&&history.length){
    history.shift();while(history[0]?.role==='assistant')history.shift();omissions.push({id:'history',reason:'oldest_complete_turn_budget'});pieces=build();
  }
  const optional=input.segments.filter(segment=>!['charDescription','charPersonality','allmindMaterials'].includes(segment.slot)).reverse();
  while(cost()>input.budget&&optional.length){const segment=optional.shift()!;if(retained.delete(segment.id))omissions.push({id:segment.id,reason:'token_budget'});pieces=build();}
  if(cost()>input.budget)throw new BookError('budget','预设固定指令、角色、本轮材料与输入超出预算；请缩小材料或调整模型窗口。未截断预设，未发送。');
  const currentMessageIndex=pieces.findIndex(piece=>piece.identifier==='allmind.current');
  if(currentMessageIndex<0||pieces.filter(piece=>piece.identifier==='allmind.current').length!==1)throw new BookError('invalid_input','本轮用户输入必须恰好一次，未发送。');
  for(const segment of input.segments)if(!segment.content.trim())warnings.push(segment.slot+' 没有动态内容。');
  // Slots this product has no data source for are reported, never silently filled with role persona,
  // fabricated user profile data or a guessed scene. An imported preset may reference all of them.
  const sourcedSlots=new Set(input.segments.map(segment=>segment.slot));
  for(const slot of ['charPersonality','personaDescription','scenario','dialogueExamples','allmindDesktopContext'] as const)
    if(usedSlots.has(slot)&&!sourcedSlots.has(slot))warnings.push(slot+'：当前实例没有该槽的数据来源，已按空内容编译；不会用角色人格或真实用户资料伪装填补。');
  if(context.binding.kind==='chatgpt-web')warnings.push('网页采用有序文本兼容投递；Role 优先级及采样参数不等同 messages API。');
  return {messages:pieces.map(piece=>piece.message),retained,compilation:{documentHash:createHash('sha256').update(JSON.stringify([preset.document,preset.orderBlock])).digest('hex'),originalHash:createHash('sha256').update(preset.original).digest('hex'),presetId:preset.id,presetRevision:preset.revision,orderBlock:preset.orderBlock,estimatedTokens:cost(),inputBudget:input.budget,currentMessageIndex,status:'assembled',transport:context.binding.kind==='chatgpt-web'?'web-text':'messages',items:pieces.map((piece,index)=>({identifier:piece.identifier,role:piece.message.role,index,depth:piece.depth})),warnings,omissions,parameters:presetBudget(context).parameters}};
}

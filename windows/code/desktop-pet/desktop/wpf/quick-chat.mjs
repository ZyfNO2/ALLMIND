/** One explicit desktop send, through the same authenticated HTTP chat route as the SPA. */
export function createQuickChat({getState,getSession,publish,fetchImpl=fetch}){
 let busy=false;
 return {send(input){
  const state=getState();
  if(state.backend!=='ready')throw Error('后台尚未就绪。');
  if(!input||input.characterId!==state.characterId||input.sessionId!==state.sessionId||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000||input.text.includes('\0')||typeof input.turnId!=='string'||!/^[a-zA-Z0-9-]{1,96}$/.test(input.turnId))throw Error('桌宠消息或角色范围无效。');
  if(busy)throw Error('上一条桌宠消息仍在处理，请稍候。');
  const scope={characterId:state.characterId,sessionId:state.sessionId},turnId=input.turnId,text=input.text;
  busy=true;
  const event=(phase,extra={})=>publish({channel:'wpf_quick_chat',phase,turnId,...scope,...extra});
  event('pending');
  void (async()=>{
   try{
    const session=await getSession(),url=new URL(session.url),token=new URLSearchParams(url.hash.slice(1)).get('token');
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!token)throw Error('本地聊天会话无效。');
    const headers={authorization:'Bearer '+token,'content-type':'application/json'};
    const configResponse=await fetchImpl(url.origin+'/api/memory-book/v1/runtime',{headers});
    if(!configResponse.ok)throw Error('无法读取当前模型配置。');
    const {config}=await configResponse.json();if(!config.mainModel)throw Error('请先在设置中绑定对话模型。');
    const budget=config.mainModel.kind==='chatgpt-web'?(config.chatgptWeb?.replyBudgetMs??300000)+20000:80000;
    const response=await fetchImpl(url.origin+'/api/memory-book/v1/chat',{method:'POST',headers,body:JSON.stringify({...scope,text,turnId,incognito:false,inputResources:[]}),signal:AbortSignal.timeout(budget)});
    const result=await response.json();if(!response.ok)throw Error(result.error?.message??'桌宠聊天失败，请打开聊天页核对。');
    if(result.turn?.id!==turnId||result.turn.characterId!==scope.characterId||result.turn.sessionId!==scope.sessionId||typeof result.turn.assistant!=='string')throw Error('聊天回执范围不符，请打开聊天页核对。');
    event('completed',{text:result.turn.assistant.slice(0,16000),truncated:result.turn.assistant.length>16000});
   }catch(error){event('failed',{message:(error instanceof Error?error.message:String(error)).slice(0,1000)});}
   finally{busy=false;}
  })();
  return {accepted:true,turnId};
 }};
}

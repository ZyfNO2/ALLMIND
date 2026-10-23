import {createHash, randomUUID} from 'node:crypto';
import {BookError, type BookScope, type SavedTurn} from '../contracts/memory-book.js';
import type {BookRuntime} from './book-runtime.js';
import type {AstrbotConnector} from './astrbot-connector.js';
import {saveCapabilityBinding} from '../management/allmind-capabilities.js';
import {dialogueChoice} from '../core/book-dialogue.js';

/** AstrBot owns generation; local rows are display mirrors and never become its history. */
export function attachAstrbotChat(runtime: BookRuntime, connector: AstrbotConnector): void {
  const active = new Map<string, AbortController>();
  runtime.externalExecutor = {
    cancel(scope) { active.get(JSON.stringify(scope))?.abort(); },
    async chat(scope, text, signal, options) {
      if (options?.incognito) throw new BookError('conflict', '集成会话不支持无痕：远端历史无法随本地删除。');
      if (options?.transcript || options?.inputResources?.length || options?.screenObservationId) throw new BookError('invalid_input', '当前 AstrBot 桌面入口只支持文本，请使用已验证的附件入口。');
      const history = runtime.repository.readSession(scope);
      const requested=options?.dialogueMode??'inherit';
      if (history.some(row => !row.traceId.startsWith('astrbot.'))) throw new BookError('conflict', '当前会话属于本地引擎，请新建会话后使用 AstrBot。');
      const id = options?.turnId ?? randomUUID();
      const prior = history.find(row => row.id === id);
      if (prior) {
        if (prior.user !== text) throw new BookError('conflict', '已保存轮次的正文不同。');
        if((prior.externalDialogue?.requested??'inherit')!==requested)throw new BookError('conflict','同一轮次编号已对应不同场景模式。');
        return {turn: prior, context: null,replayed:true};
      }
      const key = JSON.stringify(scope);
      if (active.has(key)) throw new BookError('busy', '此会话正在生成，请等待或取消。');
      const controller = new AbortController();
      const requestId = 'astrbot.' + createHash('sha256').update(JSON.stringify([scope,id])).digest('hex');
      const binding=connector.sessionBinding(scope.characterId,JSON.stringify([scope.pairingId,scope.sessionId]));
      const directory=(runtime.repository as {directory?:string}).directory;
      if(!directory)throw new BookError('unavailable','AstrBot 需要持久化绑定。');
      const {mode}=dialogueChoice(runtime.repository.loadConfig(),text,requested);
      saveCapabilityBinding(directory,{platform:'webchat',conversationKey:`webchat:FriendMessage:webchat!${binding.principalKey}!${binding.remoteSessionId}`,senderKey:binding.principalKey,...scope,audience:'private',publicationEntryIds:[],mode});

      const hash = createHash('sha256').update(text).digest('hex');
      runtime.repository.freezeTurn?.(scope, {...scope, turnId:id, state:'submitted', requestHash:hash, at:new Date().toISOString()});
      active.set(key,controller);
      try {
        const outcome = await connector.chat({requestId, text,mode, characterId:scope.characterId, sessionId:JSON.stringify([scope.pairingId,scope.sessionId]), signal:AbortSignal.any([signal,controller.signal])});
        signal.throwIfAborted();controller.signal.throwIfAborted();
        if (outcome.state !== 'completed' || !outcome.text) throw new BookError('unavailable', outcome.error ?? '远端结果未知，请勿重复提交。');
        const turn: SavedTurn = {...scope,id,timestamp:new Date().toISOString(),user:text,assistant:outcome.text,traceId:requestId,externalDialogue:{requested,mode,memoryDomain:mode==='rp'?'fiction':mode==='quick'?'core-only':'all'}};
        runtime.repository.appendTurn(scope,turn);
        runtime.repository.completeTurnFreeze?.(scope,id);
        return {turn,context:null,replayed:false};
      } finally { active.delete(key); }
    },
  };
}

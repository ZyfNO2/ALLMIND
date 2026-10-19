import { BookError, type ModelBinding } from '../contracts/memory-book.js';
import type { BookModelPort, ModelCallOptions, RichModelCallOptions } from './book-model.js';
import type { ChatMessage } from '../contracts/memory-book.js';
import { DEFAULT_RESOURCE_CAPABILITIES, type ResourceCapabilities, type RichModelResult } from '../contracts/book-resources.js';

/**
 * Binding-kind router (RPD_CHAT_WIKI §2.2): one BookModelPort for the whole runtime,
 * dispatching per binding. Legacy bindings (no `kind`) keep the exact BookHttpModel path;
 * `chatgpt-web` bindings go to the web adapter. A web binding without an assembled web
 * adapter fails explicitly — it never silently falls back to HTTP.
 */
export interface ModelRouterOptions {
  http: BookModelPort;
  chatgpt: () => BookModelPort | null;
}

export function isChatgptWebBinding(binding: ModelBinding | null | undefined): boolean {
  return binding?.kind === 'chatgpt-web';
}

export function createModelRouter(options: ModelRouterOptions): BookModelPort {
  const select = (binding: ModelBinding): BookModelPort => {
    if (isChatgptWebBinding(binding)) {
      const adapter = options.chatgpt();
      if (!adapter) throw new BookError('unavailable', 'ChatGPT 网页来源未装配（宿主未提供桥接），请检查本机工具安装。');
      return adapter;
    }
    return options.http;
  };
  return {
    forgetCompletion(binding:ModelBinding,requestId:string):void{select(binding).forgetCompletion?.(binding,requestId);},
    async resume(binding:ModelBinding,requestId:string,signal:AbortSignal,callOptions?:ModelCallOptions):Promise<string>{
      const adapter=select(binding);if(!adapter.resume)throw new BookError('unavailable','当前来源不支持读取旧回执，不会重发。');return adapter.resume(binding,requestId,signal,callOptions);
    },
    async complete(binding: ModelBinding, messages: ChatMessage[], signal: AbortSignal, callOptions?: ModelCallOptions): Promise<string> {
      return select(binding).complete(binding, messages, signal, callOptions);
    },
    /**
     * W01: capabilities are reported by the adapter that would actually serve this binding.
     * An adapter with no rich path reports `unknown` — never a fabricated "available".
     */
    capabilities(binding: ModelBinding): ResourceCapabilities {
      const adapter = select(binding);
      return adapter.capabilities ? adapter.capabilities(binding) : { ...DEFAULT_RESOURCE_CAPABILITIES };
    },
    /**
     * W01: rich submission. Only the selected adapter is ever used, and an adapter without a rich
     * path is never silently upgraded: images are rejected before submission, while a plain text
     * turn still completes through the ordinary path and reports discovery as `unsupported`.
     */
    async completeRich(binding: ModelBinding, messages: ChatMessage[], signal: AbortSignal, callOptions?: RichModelCallOptions): Promise<RichModelResult> {
      const adapter = select(binding);
      const images = callOptions?.images ?? [];
      if (adapter.completeRich) return adapter.completeRich(binding, messages, signal, callOptions);
      if (images.length) throw new BookError('unavailable', '当前模型来源不支持图片输入，未发送。请改选支持图片的来源，或移除图片后重试。');
      const text = await adapter.complete(binding, messages, signal, callOptions);
      return {
        text,
        requestId: '',
        conversationId: null,
        messageId: null,
        artifacts: [],
        artifactDiscovery: 'unsupported'
      };
    },
  };
}

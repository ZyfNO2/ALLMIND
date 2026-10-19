import {detectMedia} from '../memory/resource-bytes.js';
import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../contracts/memory-book.js';
import type { ChatgptBackgroundBridge } from '../providers/chatgpt-background-bridge.js';
import type { OutfitGenerator, OutfitGeneration, OutfitGenerationFailure } from './outfit-service.js';

const IMAGE_MIME = /^image\/(png|jpeg|webp)$/;

/**
 * Product-owned outfit turn. It uses the existing page host, a fresh explicitly selected chat, and the
 * generated-image probe. It does not send Wiki, memory or prior chat.
 */
export function createWebOutfitGenerator(bridge: ChatgptBackgroundBridge, config: () => RuntimeConfig): OutfitGenerator {
  const sourceFingerprint = () => {
    const current = config();
    return createHash('sha256').update(JSON.stringify({binding:current.mainModel,web:current.chatgptWeb,currentCharacterId:current.currentCharacterId})).digest('hex');
  };
  const collect = async (requestId: string, signal: AbortSignal,conversationId:string|null): Promise<OutfitGeneration | OutfitGenerationFailure> => {
    const listed = await bridge.listArtifacts(requestId, { includeGenerated: true });
    if (listed.discovery !== 'complete') return { kind: 'failed', code: listed.error?.code ?? 'unverified_identity', submitted: 'yes', message: listed.error?.message ?? '生成图身份无法核验。', requestId, conversationId: null, messageId: listed.messageId || null };
    const images = [];
    for (const artifact of listed.artifacts) {
      if(artifact.mimeHint&&!IMAGE_MIME.test(artifact.mimeHint))continue;
      const bytes = await bridge.readArtifact({ ...artifact, requestId, includeGenerated: true, messageId: listed.messageId }, signal);
      const detected=detectMedia(bytes,{name:artifact.nameHint,mime:null});if(detected.kind!=='image')continue;images.push({name:artifact.nameHint,mime:detected.mime,bytes});
    }
    if (!images.length) return { kind: 'failed', code: 'no_generated_image', submitted: 'yes', message: '网页终态和本次后继消息里没有可下载的生成图片。', requestId, conversationId: null, messageId: listed.messageId || null };
    bridge.noteGeneratedImages('available');
    return { kind: 'completed', requestId, conversationId, messageId: listed.messageId || null, images, submitted: 'yes' };
  };
  return {
    capabilities:()=>config().mainModel?.kind==='chatgpt-web'?bridge.capabilities():{inputImages:'unavailable',outputImages:'unavailable',reason:'换装需要绑定现有 GPT 网页来源。'},
    sourceFingerprint,
    async submit(input) {
      const binding=config().mainModel;
      const result = await bridge.ask({ requestId: input.requestId, temporary: input.temporary??true, captureArtifacts: true,recoverableCompletion:true,...(binding?{model:binding.model}:{}), prompt: `只根据所附参考图完成本次换装。不要使用其他聊天、记忆或角色设定。\n${input.instruction}\n请实际生成并返回图片，不要只回复绘图方法。透明背景、人物完整和画布锚点只是生成要求。`, images: input.images, timeoutMs: 180_000, signal: input.signal });
      if (result.kind !== 'completed') return { kind: result.kind === 'cancelled' ? 'cancelled' : 'failed', code: result.kind === 'failed' ? result.code : 'cancelled', submitted: result.kind === 'failed' ? result.submitted : result.confirmed ? 'yes' : 'unknown', message: result.message ?? '换装生成没有完成。', requestId: input.requestId };
      return collect(input.requestId, input.signal,result.conversationId);
    },
    async resume(requestId, signal) {
      const result = await bridge.resume(requestId, 60_000);
      if (result.kind !== 'completed') return { kind: result.kind === 'cancelled' ? 'cancelled' : 'failed', code: result.kind === 'failed' ? result.code : 'cancelled', submitted: result.kind === 'failed' ? result.submitted : 'unknown', message: result.message ?? '换装结果仍未确认。', requestId };
      return collect(requestId, signal,result.conversationId);
    },
    async cancel(requestId) {
      const result = await bridge.cancel(requestId);
      return { kind: 'cancelled', code: 'cancelled', submitted: result.kind === 'cancelled' && result.confirmed ? 'yes' : 'unknown', message: result.kind === 'cancelled' ? result.message : '取消结果未确认。取消不代表供应商已删除生成任务。', requestId };
    }
  };
}

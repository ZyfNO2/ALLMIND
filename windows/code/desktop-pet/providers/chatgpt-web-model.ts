import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { BookError, type ChatMessage, type ChatgptWebSourceConfig, type ModelBinding, type RuntimeConfig } from '../contracts/memory-book.js';
import type { BookModelPort, RichModelCallOptions } from './book-model.js';
import type { ChatgptWebAskResult, ChatgptWebBridge, ChatgptWebFailureCode } from './chatgpt-web-bridge.js';
import { DEFAULT_RESOURCE_CAPABILITIES, type ProviderArtifactCandidate, type ResourceCapabilities, type RichModelResult } from '../contracts/book-resources.js';
import type { ChatgptBackgroundBridge } from './chatgpt-background-bridge.js';

/** The webpage's empty memory-citation decoration has no public target. Keep quoted code literal. */
export function normalizeChatgptReplyDecoration(text:string):string{
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part,index)=>index%2?part:part.replace(/[ \t]*\uE200memcite\uE201/g,'')).join('');
}

/**
 * ChatGPT web BookModelPort adapter (RPD_CHAT_WIKI §3.2): turns the context builder's
 * messages into ONE browser ask and returns the complete reply text. Non-streaming by
 * contract — `complete` resolves once with the full answer; no fallback to any API model
 * and no second rewriting call. The last message becomes the web prompt; everything before
 * it (system policy + retrieved blocks + history) travels as context. The background bridge
 * inserts bounded chunks so the Windows command-line limit never truncates a turn.
 */

/** Default budgets for purposes the runtime does not gate itself (planner/test paths). */
const TEST_BUDGET_MS = 120_000;

/** Upper bound on a single web reply, mirroring BookHttpModel's 200k hard cap. */
const REPLY_HARD_CAP_CHARS = 200_000;
/** Rough chars-per-token used to translate `outputTokens` into a web reply cap. */
const CHARS_PER_TOKEN = 8;

function formatContext(messages: ChatMessage[]): string {
  return messages.map(message => `[${message.role === 'user' ? '用户' : message.role === 'assistant' ? '角色' : '系统设定'}]\n${message.content}`).join('\n\n');
}

/**
 * JSON extraction for `options.json` calls, mirroring chatgpt-use structured.rs: the whole
 * reply if it parses, else a fenced ```json block, else the first balanced object. This is
 * deterministic transport normalization — no extra model "fix JSON" turns are ever sent.
 */
function extractJsonText(reply: string): string {
  const trimmed = reply.trim();
  if (!trimmed) return trimmed;
  try { JSON.parse(trimmed); return trimmed; } catch { /* fall through */ }
  const fence = /```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/m.exec(trimmed);
  if (fence?.[1]) {
    const candidate = fence[1].trim();
    try { JSON.parse(candidate); return candidate; } catch { /* fall through */ }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try { JSON.parse(candidate); return candidate; } catch { /* fall through */ }
  }
  return trimmed;
}

function bookErrorOf(code: ChatgptWebFailureCode, message: string): BookError {
  switch (code) {
    case 'busy': return new BookError('busy', `ChatGPT 网页来源忙：${message}`);
    case 'login_required': return new BookError('unavailable', `ChatGPT 需要登录：${message} 请在管理入口打开登录页并在浏览器完成登录。`);
    case 'rate_limited': return new BookError('unavailable', `ChatGPT 账号限流：${message}`);
    case 'tool_missing': return new BookError('unavailable', `${message} 请先安装 chatgpt-use 与 chrome-use（官方安装脚本），或在来源配置中指定 binDir。`);
    case 'submit_unknown':
    case 'timeout':
    case 'duplicate':
      return new BookError('unavailable', `${message} 该请求的提交状态未知，不会自动重发；请从回执接续读取或重开新尝试。`);
    default: return new BookError('unavailable', message);
  }
}

export interface ChatgptWebModelOptions {
  bridge: Pick<ChatgptWebBridge, 'ask'> & Partial<Pick<ChatgptBackgroundBridge,'resume'|'forgetCompleted'>>;
  /** Live source-config reader (budgets and profile/session come from here). */
  config: () => ChatgptWebSourceConfig;
  runtime?: () => RuntimeConfig;
  /** Injectable for tests; defaults to randomUUID. */
  requestId?: (purpose: string) => string;
  /** W01: the background bridge carries the artifact actions; absent in text-only test doubles. */
  artifacts?: Pick<ChatgptBackgroundBridge, 'capabilities' | 'listArtifacts' | 'readArtifact'>;
}

/** W01: adapts the bridge's artifact receipt to the shared resource contract. */
function artifactCandidate(row: { handleId: string; nameHint: string; mimeHint?: string }, messageId: string): ProviderArtifactCandidate {
  return { handleId: row.handleId, nameHint: row.nameHint, messageId, ...(row.mimeHint ? { mimeHint: row.mimeHint } : {}) };
}

export class ChatgptWebModel implements BookModelPort {
  private readonly bridge: ChatgptWebModelOptions['bridge'];
  private readonly config: () => ChatgptWebSourceConfig;
  private readonly newRequestId: (purpose: string) => string;
  private readonly artifacts: ChatgptWebModelOptions['artifacts'];

  constructor(options: ChatgptWebModelOptions) {
    this.bridge = options.bridge;
    this.config = options.config;
    this.newRequestId = options.requestId ?? (purpose => `aiki-${purpose}-${randomUUID()}`);
    this.runtime = options.runtime;
    this.artifacts = options.artifacts;
  }
  private readonly runtime: (() => RuntimeConfig) | undefined;
  forgetCompletion(_binding:ModelBinding,requestId:string):void{this.bridge.forgetCompleted?.([requestId]);}
  async resume(binding:ModelBinding,requestId:string,signal:AbortSignal,options:RichModelCallOptions={}):Promise<string>{
    if(!this.bridge.resume)throw new BookError('unavailable','此网页来源不支持接续读取，不会重发。');
    signal.throwIfAborted();const result=await this.bridge.resume(requestId,Math.min(options.budgetMs??120000,900000));signal.throwIfAborted();
    if(result.kind!=='completed')throw new BookError('unavailable',result.kind==='cancelled'?result.message:result.message);
    if(result.text.length>Math.min(REPLY_HARD_CAP_CHARS,binding.outputTokens*CHARS_PER_TOKEN))throw new BookError('budget','接续结果超过输出预算，未截断。');
    return options.json?extractJsonText(result.text):result.text;
  }

  /**
   * W01: only the embedded page source can receive files and take images; every other transport says
   * so honestly instead of being silently treated as capable.
   */
  capabilities(_binding: ModelBinding): ResourceCapabilities {
    const declared = this.artifacts?.capabilities();
    if (!declared) return { ...DEFAULT_RESOURCE_CAPABILITIES };
    return declared;
  }

  /** W01: read the verified bytes of one file candidate of the CURRENT terminal message. */
  async readArtifact(candidate: ProviderArtifactCandidate & {requestId?:string;projectId?:string|null}, signal: AbortSignal): Promise<Uint8Array> {
    if (!this.artifacts) throw new BookError('unavailable', '当前来源未装配文件读取端口，未接收。');
    return this.artifacts.readArtifact({ ...(candidate.requestId?{requestId:candidate.requestId}:{}),messageId:candidate.messageId,...(candidate.projectId===undefined?{}:{projectId:candidate.projectId}), handleId: candidate.handleId, nameHint: candidate.nameHint, ...(candidate.mimeHint ? { mimeHint: candidate.mimeHint } : {}) }, signal);
  }

  /**
   * W01: the rich reply path. It is the SAME single submission as `complete` — the text result is
   * produced once, and this wrapper only adds the terminal identity and the file candidates that the
   * bridge already verified. It never sends a second request.
   */
  private richBusy=false;
  async completeRich(binding: ModelBinding, messages: ChatMessage[], signal: AbortSignal, options: RichModelCallOptions = {}): Promise<RichModelResult> {
    if(this.richBusy)throw new BookError('busy','来源正在接收本轮终态文件。');this.richBusy=true;
    try{
    const text = await this.completeInternal(binding, messages, signal, {...options,captureArtifacts:true});
    const requestId = this.lastRequestId;
    const imageReceipts = this.lastImageReceipts;
    if (!this.artifacts || !requestId) return { text, requestId: requestId ?? '', conversationId: null, messageId: null, artifacts: [], artifactDiscovery: 'unsupported' };
    const declared = this.artifacts.capabilities();
    if (declared.outputFiles !== 'available') {
      return { text, requestId, imageReceipts, conversationId: this.lastConversationId, messageId: this.lastMessageId, artifacts: [], artifactDiscovery: 'unsupported', ...(declared.reason ? { artifactError: { code: 'unsupported' as const, message: declared.reason } } : {}) };
    }
    try {
      const listing = await this.artifacts.listArtifacts(requestId);
      const artifacts = listing.artifacts.map(row => artifactCandidate(row, listing.messageId));
      if (listing.discovery === 'failed') return { text, requestId, imageReceipts, conversationId: this.lastConversationId, messageId: this.lastMessageId, artifacts, artifactDiscovery: 'failed', ...(listing.error ? { artifactError: { code: 'unverified_identity' as const, message: listing.error.message } } : {}) };
      return { text, requestId, imageReceipts, conversationId: this.lastConversationId, messageId: this.lastMessageId, artifacts, artifactDiscovery: 'complete' };
    } catch (error) {
      // A file that cannot even be listed is a discovery failure — the text is still a complete turn.
      return { text, requestId, imageReceipts, conversationId: this.lastConversationId, messageId: this.lastMessageId, artifacts: [], artifactDiscovery: 'failed', artifactError: { code: 'unverified_identity' as const, message: error instanceof Error ? error.message : String(error) } };
    }
    }finally{this.richBusy=false;}
  }
  /** W01: the identity of the submission `complete` just performed, for the rich wrapper only. */
  private lastImageReceipts: NonNullable<RichModelResult['imageReceipts']> = [];
  private lastRequestId = ''; private lastConversationId: string | null = null; private lastMessageId: string | null = null;

  async complete(binding: ModelBinding, messages: ChatMessage[], signal: AbortSignal, options: RichModelCallOptions = {}): Promise<string> {
    if (this.richBusy) throw new BookError('busy', '来源正在核对本轮文件。');
    return this.completeInternal(binding, messages, signal, options);
  }
  private async completeInternal(binding: ModelBinding, messages: ChatMessage[], signal: AbortSignal, options: RichModelCallOptions): Promise<string> {
    signal.throwIfAborted();
    if (!messages.length) throw new BookError('invalid_input', '网页模型请求缺少消息。');
    const last = messages[messages.length - 1]!;
    const prompt = (options.promptCompilation?formatContext(messages):last.content) + (options.json ? '\n\n只输出一个 JSON 值：不要 Markdown 代码围栏、不要解释或其他文本。' : '');
    const context = !options.promptCompilation&&messages.length > 1 ? formatContext(messages.slice(0, -1)) : undefined;
    const purpose = options.purpose ?? 'reply';
    const config = this.config();
    const projectBinding = options.scope && purpose==='reply' ? this.runtime?.().chatgptProjects?.find(row => row.enabled && row.characterId === options.scope!.characterId && row.pairingId === options.scope!.pairingId) : undefined;
    if(options.incognito&&(projectBinding||config.conversationMode==='regular'))throw new BookError('conflict','无痕请求不允许非临时或项目归档，未发送。');
    if (projectBinding && config.transport !== 'embedded') throw new BookError('unavailable','项目聊天需要独立页面来源，不会退回普通聊天。');
    // W01: images require a source that can actually attach them. Reject BEFORE the request is built so
    // the provider never submits a request that quietly dropped the user's selected image.
    if (options.images?.length) {
      const capability = this.capabilities(binding);
      if (capability.inputImages !== 'available') throw new BookError('unavailable', capability.reason ?? '当前模型来源不支持图片输入，未发送。请改选支持图片的来源，或移除图片后重试。');
    }
    const timeoutMs = options.budgetMs !== undefined && purpose === 'wiki' ? options.budgetMs : purpose === 'reply' ? config.replyBudgetMs
      : purpose === 'wiki' ? config.wikiBudgetMs
      : TEST_BUDGET_MS;
    const recoverableCompletion = purpose === 'reply' && !options.incognito && Boolean(options.scope && options.nextTurnId);
    const requestId = recoverableCompletion ? 'aiki-reply-'+createHash('sha256').update(JSON.stringify([options.scope,options.nextTurnId])).digest('hex').slice(0,40) : this.newRequestId(purpose);
    this.lastImageReceipts = []; this.lastRequestId = requestId; this.lastConversationId = null; this.lastMessageId = null;
    const result: ChatgptWebAskResult = await this.bridge.ask({
      temporary: options.incognito ? true : projectBinding ? false : purpose === 'test' ? config.temporaryChatTests : config.conversationMode !== 'regular',
      ...(projectBinding && options.scope ? {project:{binding:projectBinding,scope:options.scope,localTurnId:options.localTurnId??null,nextTurnId:options.nextTurnId??null},continuationContext:options.promptCompilation?'':formatContext(messages.slice(0,-1).filter(message=>message.role==='system'))} : {}),
      prompt,
      ...(context !== undefined ? { context } : {}),
      requestId, recoverableCompletion:recoverableCompletion||purpose==='wiki'&&options.requiredThinking==='high',
      captureArtifacts:options.captureArtifacts===true,
      ...(options.requiredThinking ? {requiredThinking:options.requiredThinking} : {}),
      ...(options.taskArchive ? {taskArchive:options.taskArchive} : {}),
      ...(options.onPrepared ? {onPrepared:options.onPrepared} : {}),
      timeoutMs,
      ...(binding.model ? { model: binding.model } : {}),
      ...(options.images?.length ? { images: options.images.map(image => ({ resourceId: image.resourceId, sha256: image.sha256, mime: image.mime, bytes: image.bytes })) } : {}),
      ...(signal ? { signal } : {}),
    });
    signal.throwIfAborted();
    if (result.kind === 'completed') {
      this.lastImageReceipts = structuredClone(result.uploads ?? []);
      this.lastConversationId = result.conversationId ?? null; this.lastMessageId = result.messageId ?? null;
      let text = !options.json&&!last.content.includes('memcite')?normalizeChatgptReplyDecoration(result.text):result.text;
      // Length discipline: the web source has no server-side max_tokens, so the binding's
      // output reserve becomes an approximate cap. allowTruncated accepts a capped reply
      // (mirroring the HTTP path's finish_reason=length semantics); otherwise the turn fails.
      const cap = Math.min(REPLY_HARD_CAP_CHARS, binding.outputTokens * CHARS_PER_TOKEN);
      if (text.length > cap) {
        if (!options.allowTruncated) throw new BookError('unavailable', `网页回复超出输出预留（约 ${text.length} 字符 > ${cap}），已拒绝交付。`);
        text = text.slice(0, cap);
      }
      if (options.json) text = extractJsonText(text);
      if (!text.trim()) throw new BookError('unavailable', '网页回复为空，不冒充成功。');
      return text;
    }
    if (result.kind === 'cancelled') {
      throw new BookError('unavailable', `网页生成已取消：${result.message}`);
    }
    throw bookErrorOf(result.code, result.message);
  }
}

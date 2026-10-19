import { randomUUID } from 'node:crypto';
import { BookError, type ChatMessage, type ChatgptWebSourceConfig, type ModelBinding } from '../contracts/memory-book.js';
import type { BookModelPort, ModelCallOptions } from './book-model.js';
import type { ChatgptWebBridge } from './chatgpt-web-bridge.js';
/**
 * Submit mechanism B (RPD D1, user-approved A/B coexistence): use the logged-in web
 * session's own access token to POST the internal conversation API — the same endpoint
 * and the same chat quota the web composer uses. Reads the SSE stream to completion and
 * returns the full reply text (the v1 BookModelPort contract; incremental delivery is a
 * later contract extension). The page is never typed into; the browser is only the
 * session holder that mints the token.
 *
 * Accepted risks (user decision, 2026-10-13): the request payload is an unofficial
 * contract that can change without notice — a broken payload is reported as a typed
 * `payload_broken` failure (never silently swallowed), and 'auto' mode falls back to the
 * page-automation path. The token is an account-level credential: memory cache only
 * (bridge-side), never persisted, never logged.
 */

const CONVERSATION_ENDPOINT = 'https://chatgpt.com/backend-api/conversation';

/** The one failure class that means "the unofficial payload contract changed". */
export type ConversationApiFailureCode =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'payload_broken'
  | 'no_reply'
  | 'aborted'
  | 'failed';

export class ConversationApiError extends Error {
  constructor(public readonly code: ConversationApiFailureCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'ConversationApiError';
  }
}

/** Injectable HTTP surface (production: fetch; tests: scripted responses). */
export interface ConversationHttpResponse { status: number; body: string }
export type ConversationTransport = (
  endpoint: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<ConversationHttpResponse>;

const defaultTransport: ConversationTransport = async (endpoint, init) => {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', ...init });
  return { status: response.status, body: await response.text() };
};

export interface ConversationCallResult {
  text: string;
  conversationId: string | null;
  /** The model slug the server actually served (picker label ↔ API slug drift is expected). */
  servedModelSlug: string | null;
  durationMs: number;
}

/** Parse one conversation SSE body into the final reply text (chatgpt-use structured-rs discipline). */
export function parseConversationStream(body: string): { text: string; conversationId: string | null; servedModelSlug: string | null } | { error: string } {
  let text = '';
  let conversationId: string | null = null;
  let servedModelSlug: string | null = null;
  let endTurn = false;
  let sawEvent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') { sawEvent = true; continue; }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch { continue; }
    sawEvent = true;
    const error = event.error && typeof event.error === 'object'
      ? (event.error as Record<string, unknown>)
      : null;
    if (error) {
      const message = typeof error.message === 'string' ? error.message : 'conversation 流返回错误';
      return { error: message };
    }
    const message = event.message && typeof event.message === 'object'
      ? event.message as Record<string, unknown>
      : null;
    if (typeof event.conversation_id === 'string' && event.conversation_id) conversationId = event.conversation_id;
    if (!message) continue;
    const author = message.author && typeof message.author === 'object' ? message.author as Record<string, unknown> : null;
    const content = message.content && typeof message.content === 'object' ? message.content as Record<string, unknown> : null;
    if (message.end_turn === true) endTurn = true;
    if (!author || author.role !== 'assistant' || !content) continue;
    if (content.content_type !== 'text' || !Array.isArray(content.parts)) continue;
    const parts = content.parts.filter((part): part is string => typeof part === 'string');
    // Streaming events carry the FULL text so far — the last assistant event wins.
    const joined = parts.join('');
    if (joined.trim()) text = joined;
    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata as Record<string, unknown> : null;
    if (metadata && typeof metadata.model_slug === 'string') servedModelSlug = metadata.model_slug;
    const finish = metadata && metadata.finish_details && typeof metadata.finish_details === 'object'
      ? metadata.finish_details as Record<string, unknown>
      : null;
    if (finish && finish.type === 'interrupted') {
      return { error: `回复被中断（finish_details=interrupted，已生成 ${text.length} 字符），不作为完整回复交付。` };
    }
  }
  if (!sawEvent) return { error: 'conversation 响应不是可识别的 SSE 流。' };
  if (!endTurn) return { error: 'conversation 流未包含 end_turn 标记，回复不完整。' };
  if (!text.trim()) return { error: 'conversation 流没有可显示的正文。' };
  return { text, conversationId, servedModelSlug };
}

export interface ChatgptWebConversationModelOptions {
  bridge: ChatgptWebBridge;
  config: () => ChatgptWebSourceConfig;
  transport?: ConversationTransport;
  requestId?: () => string;
}

export class ChatgptWebConversationModel implements BookModelPort {
  private readonly bridge: ChatgptWebBridge;
  private readonly config: () => ChatgptWebSourceConfig;
  private readonly transport: ConversationTransport;

  constructor(options: ChatgptWebConversationModelOptions) {
    this.bridge = options.bridge;
    this.config = options.config;
    this.transport = options.transport ?? defaultTransport;
    void options.requestId;
  }

  async complete(binding: ModelBinding, messages: ChatMessage[], signal: AbortSignal, options: ModelCallOptions = {}): Promise<string> {
    signal.throwIfAborted();
    if (!messages.length) throw new BookError('invalid_input', '网页模型请求缺少消息。');
    const startedAt = Date.now();
    // The page-composer prompt format (instructions + history + current message) is reused:
    // the conversation API receives the same roles the HTTP path would send.
    const payloadMessages = messages.map(message => ({
      id: randomUUID(),
      author: { role: message.role },
      content: { content_type: 'text', parts: [message.content] },
      metadata: {},
    }));
    const temporary = options.purpose === 'test' && this.config().temporaryChatTests;
    const payload: Record<string, unknown> = {
      action: 'next',
      messages: payloadMessages,
      model: 'auto',
      parent_message_id: randomUUID(),
      ...(temporary ? { history_and_training_disabled: true } : {}),
    };
    signal.throwIfAborted();

    for (let tokenAttempt = 0; tokenAttempt < 2; tokenAttempt += 1) {
      const token = await this.bridge.getSessionToken();
      if (!token) {
        throw new ConversationApiError('unauthorized', '未取得 ChatGPT 会话 token（页面可能未登录或不可读）；请先完成登录。');
      }
      signal.throwIfAborted();
      let response: ConversationHttpResponse;
      try {
        response = await this.transport(CONVERSATION_ENDPOINT, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new BookError('unavailable', '网页请求已取消。');
        throw new ConversationApiError('failed', `conversation 请求失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status === 401) {
        // The cached token went stale: refresh once, then give up (composite falls back to A).
        this.bridge.invalidateToken();
        if (tokenAttempt === 0) continue;
        throw new ConversationApiError('unauthorized', 'ChatGPT 会话 token 已失效（刷新后仍 401）；请重新登录。');
      }
      if (response.status === 429) throw new ConversationApiError('rate_limited', 'chatgpt.com 对本账号限流（429），请等待后重试。');
      if (response.status === 403) throw new ConversationApiError('forbidden', `conversation 被拒绝（403）${response.body ? `：${response.body.slice(0, 200)}` : ''}。`);
      if (response.status !== 200) {
        throw new ConversationApiError('failed', `conversation 请求失败（HTTP ${response.status}）。`);
      }
      signal.throwIfAborted();
      const parsed = parseConversationStream(response.body);
      if ('error' in parsed) {
        throw new ConversationApiError('payload_broken', `conversation 流解析失败：${parsed.error}`);
      }
      const cap = Math.min(200_000, binding.outputTokens * 8);
      if (parsed.text.length > cap && !options.allowTruncated) {
        throw new ConversationApiError('payload_broken', `网页回复超出输出预留（约 ${parsed.text.length} 字符 > ${cap}），已拒绝交付。`);
      }
      return parsed.text;
    }
    throw new ConversationApiError('unauthorized', 'unreachable');
  }
}

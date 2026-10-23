import {BookError} from '../contracts/memory-book.js';

export interface GptTextMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface GptTextPort {
  complete(messages: GptTextMessage[], signal: AbortSignal): Promise<{text: string; requestId: string}>;
}

export interface GptTextEndpoint { token: string; port: GptTextPort }

/** OpenAI-compatible text subset. tools, streaming and non-text parts are rejected before the bridge runs. */
export async function handleGptText(route: string, method: string, body: Record<string, unknown>, endpoint: GptTextEndpoint, signal: AbortSignal): Promise<{status: number; body: unknown} | undefined> {
  if (route === '/gpt-text/v1/models' && method === 'GET') {
    return {status: 200, body: {object: 'list', data: [{id: 'allmind-gpt-text', object: 'model', capabilities: {text: true, tools: false, streaming: false, images: false, structured_output: false}}]}};
  }
  if (route !== '/gpt-text/v1/chat/completions' || method !== 'POST') return undefined;
  if(body.model!==undefined&&body.model!=='allmind-gpt-text')return {status:400,body:{error:{code:'model_unsupported',message:'请选择 allmind-gpt-text。'}}};
  if(body.response_format!==undefined||body.functions!==undefined||body.function_call!==undefined)return {status:400,body:{error:{code:'capability_unsupported',message:'结构化输出和旧工具协议不受支持。'}}};
  if(JSON.stringify(body).length>1000000)return {status:400,body:{error:{code:'budget',message:'文本请求超过限制。'}}};
  if (body.tools !== undefined || body.tool_choice !== undefined) return {status: 400, body: {error: {code: 'tools_unsupported', message: '此文本端点不支持工具调用，已拒绝且未改写为文本。'}}};
  if (body.stream === true) return {status: 400, body: {error: {code: 'stream_unsupported', message: '此端点只返回整段文本，不能当作逐 token 流。'}}};
  if (!Array.isArray(body.messages) || !body.messages.length) return {status: 400, body: {error: {code: 'invalid_input', message: 'messages 必须是非空文本数组。'}}};
  const messages: GptTextMessage[] = [];
  for (const row of body.messages) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return {status: 400, body: {error: {code: 'invalid_input', message: '消息格式无效。'}}};
    const message = row as Record<string, unknown>;
    if(message.tool_calls!==undefined||message.function_call!==undefined||message.tool_call_id!==undefined)return {status:400,body:{error:{code:'tools_unsupported',message:'工具消息不能改写成普通文本。'}}};
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') return {status: 400, body: {error: {code: 'invalid_input', message: '只接受 system、user、assistant 文本消息。'}}};
    if (typeof message.content !== 'string') return {status: 400, body: {error: {code: 'invalid_input', message: '不支持的消息内容类型已拒绝，没有丢弃后继续。'}}};
    messages.push({role: message.role, content: message.content});
  }
  try {
    const result = await endpoint.port.complete(messages, signal);
    return {status: 200, body: {id: result.requestId, object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content: result.text}, finish_reason: 'stop'}]}};
  } catch (error) {
    const known = error instanceof BookError;
    return {status: 422, body: {error: {code: known ? error.code : 'unavailable', message: known ? error.message : '网页文本桥不可用，没有改走其他模型。'}}};
  }
}

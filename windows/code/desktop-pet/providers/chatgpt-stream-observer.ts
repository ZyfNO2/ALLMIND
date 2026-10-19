/** Native browser stream observation only. No inference requests are made here.
 * Compact delta shape reference: OpenBrowser 2f090f0/browser-extension/src/chatgpt-api.js (MIT).
 */
export interface ChatgptStreamState { document: Record<string, any>; path: string; operation: string; done: boolean; error: string | null; handoff?: { conversationId: string; turnExchangeId: string } }

/** Serializable, closure-free reducer, also executed inside the browser page. */
export function consumeChatgptStreamEvent(state: ChatgptStreamState, payload: unknown, eventName = 'message'): void {
  if (payload === '[DONE]') { state.done = true; return; }
  // The native v1 stream starts with event: delta_encoding / data: "v1".
  // This is a version declaration, not assistant text or completion evidence.
  if (eventName === 'delta_encoding') {
    if (payload !== 'v1') throw new Error('不支持的原生 SSE 编码版本。');
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('SSE 事件结构无效。');
  const event = payload as Record<string, any>;
  if (event.type === 'stream_handoff') {
    if (typeof event.conversation_id !== 'string' || typeof event.turn_exchange_id !== 'string') throw new Error('原生流交接身份缺失。');
    state.handoff = { conversationId: event.conversation_id, turnExchangeId: event.turn_exchange_id }; return;
  }
  if (event.error || event.type === 'error') { state.error = typeof event.error?.message === 'string' ? event.error.message : '网页流返回错误。'; return; }
  if (event.type === 'message_stream_complete') { state.done = true; return; }
  const apply = (path: string, operation: string, value: any): void => {
    if (operation === 'patch') {
      if (!Array.isArray(value)) throw new Error('SSE patch 不是数组。');
      for (const item of value) {
        if (!item || typeof item.p !== 'string' || typeof item.o !== 'string') throw new Error('SSE patch 项缺少路径/操作。');
        apply(path + item.p, item.o, item.v);
      }
      return;
    }
    if (!['add', 'replace', 'append', 'remove'].includes(operation)) throw new Error('不支持的 SSE 操作：' + operation);
    if (!path) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SSE 根快照无效。');
      state.document = value; return;
    }
    const keys = path.split('/').slice(1).map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!keys.length || keys.length > 32 || keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('SSE 路径无效。');
    let parent: any = state.document;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('SSE 增量缺少基线：' + path);
      parent = parent[key];
    }
    const key = keys[keys.length - 1]!;
    if (operation === 'append') {
      if (typeof parent[key] === 'string' && typeof value === 'string') parent[key] += value;
      else if (Array.isArray(parent[key]) && Array.isArray(value)) parent[key].push(...value);
      else if (parent[key] && value && typeof parent[key] === 'object' && typeof value === 'object' && !Array.isArray(parent[key]) && !Array.isArray(value)) {
        if (Object.keys(value).some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('SSE 对象键无效。');
        Object.assign(parent[key], value);
      }
      else throw new Error('SSE append 类型不匹配。');
    } else if (operation === 'remove') delete parent[key];
    else parent[key] = value;
  };
  if (event.message && typeof event.message === 'object') { state.document = event; return; }
  if (!event.o && event.v?.message) { state.document = event.v; state.path = ''; state.operation = 'add'; return; }
  if (typeof event.p === 'string') state.path = event.p;
  if (typeof event.o === 'string') state.operation = event.o;
  if (Object.hasOwn(event, 'v') && state.operation) apply(state.path, state.operation, event.v);
  // Other typed metadata/keepalive events do not create completion evidence.
}

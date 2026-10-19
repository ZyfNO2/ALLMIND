/**
 * W01 native artifact adapter (page side).
 *
 * The embedded ChatGPT page already proves, for every turn, WHICH assistant message is the terminal
 * one (`chatgpt-background-bridge.ts` keeps the verified `messageId`). This module turns that verified
 * message into bounded, opaque file handles, reads their bytes through the page's own authenticated
 * session, and stages images for the composer's real file input.
 *
 * Everything here is a closed action over validated fields: no caller-supplied JavaScript, no arbitrary
 * URL, no local file path, no debug port. The host allow-list in `chatgptPageScript` is the only entry
 * point, and the returned handles are opaque ids that mean nothing outside the current request.
 */

/** Actions the artifact adapter understands. Kept separate from the chat action list on purpose. */
export const ARTIFACT_ACTIONS = ['artifacts', 'recover-artifacts', 'open-file', 'read-chunk', 'close-file', 'upload-image'] as const;
export type ArtifactAction = (typeof ARTIFACT_ACTIONS)[number];

export interface ChatgptArtifactInput {
  /** The verified request identity of the current turn. Every action requires it. */
  id?: string;
  conversationId?: string; expectedNode?: string; expectedTextHash?: string;
  handleId?: string;
  offset?: number;
  length?: number;
  /** Upload staging slot: the caller-visible name of one in-flight image. */
  slot?: string;
  name?: string;
  mime?: string;
  /** Base64 chunk of at most RESOURCE_LIMITS.chunkBytes decoded bytes. */
  data?: string;
  done?: boolean;
  /** W02: also collect generated images on this user message's successor chain. */
  includeGenerated?: boolean;
}

export interface ChatgptArtifactCandidate {
  handleId: string;
  nameHint: string;
  mimeHint?: string;
}

export interface ChatgptArtifactList {
  messageId: string;
  artifacts: ChatgptArtifactCandidate[];
  discovery: 'complete' | 'failed';
  error?: { code: string; message: string };
}

/**
 * Injected page function. MUST stay self-contained: it is serialized with `toString()` and evaluated
 * in the page, so it may not reference any module-scope binding.
 */
export function artifactAction(action: string, input: ChatgptArtifactInput): unknown {
  const host = window as unknown as {
    __aikiChatRequest?: {
      id?: string;
      verifiedUploads?:{fileId:string;name:string}[]; terminalMessage?: unknown; userMessageId?: string; generatedMessages?: unknown[]; stream?: {document?:{conversation_id?:string}};
      artifacts?: Record<string, { name: string; mime: string; url: string | null; bytes?: Uint8Array }>;
    };
    __aikiUploads?: Record<string, { name: string; mime: string; chunks: string[]; bytes: number }>;
  };
  if (action === 'recover-artifacts') return (async () => {
    if (!input.id || !input.conversationId || !input.expectedNode || !input.expectedTextHash) throw Error('缺少已持久化的文件完成身份。');
    const init: RequestInit = { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) };
    const endpoint = '/backend-api/conversation/' + encodeURIComponent(input.conversationId);
    let response = await fetch(endpoint, init);
    if (response.status === 401) {
      const session = await fetch('/api/auth/session', init); const token = (await session.json()).accessToken;
      if (typeof token !== 'string') throw Error('文件恢复会话失效。');
      response = await fetch(endpoint, { ...init, headers: { Authorization: 'Bearer ' + token } });
    }
    if (!response.ok) throw Error('文件来源回读失败：HTTP ' + response.status);
    const record = await response.json();
    const message = record.mapping?.[input.expectedNode]?.message;
    if (record.conversation_id !== input.conversationId || message?.id !== input.expectedNode || message.author?.role !== 'assistant' || message.status !== 'finished_successfully' || message.end_turn !== true || message.channel && message.channel !== 'final' || message.recipient && message.recipient !== 'all') throw Error('文件完成身份无法重新核验。');
    const text = (message.content?.parts ?? []).filter((part: unknown) => typeof part === 'string').join('');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2,'0')).join('');
    if (hash !== input.expectedTextHash) throw Error('文件来源正文与完成回执不一致。');
    let ancestor:string|undefined=input.expectedNode,userMessageId:string|undefined;const seen=new Set<string>();
    while(ancestor&&seen.size<80&&!seen.has(ancestor)){
      seen.add(ancestor);const node:any=record.mapping[ancestor];
      if(node?.message?.author?.role==='user'){userMessageId=node.message.id;break;}
      ancestor=typeof node?.parent==='string'?node.parent:undefined;
    }
    host.__aikiChatRequest = { id: input.id, terminalMessage: message,...(userMessageId?{userMessageId}:{}), stream: { document: { conversation_id: input.conversationId } } };
    return { restored: true };
  })();
  const request = host.__aikiChatRequest;
  if (!request || !input || typeof input !== 'object' || request.id !== input.id) throw new Error('页面请求身份丢失；提交状态未知，不得自动重发。');
  const registry = (request.artifacts ??= {});
  const uploads = (host.__aikiUploads ??= {});

  const asRecord = (value: unknown): Record<string, any> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
  const textOf = (value: unknown): string => typeof value === 'string' ? value : '';
  /** Opaque, stable within one message; never a path or a remote URL. */
  const handleFor = (index: number, name: string): string => {
    let hash = 2166136261;
    for (let i = 0; i < name.length; i += 1) { hash ^= name.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
    return `f${index}-${hash.toString(16).padStart(8, '0')}`;
  };
  const baseName = (value: string): string => {
    const trimmed = value.replace(/[?#].*$/u, '').replace(/\\/gu, '/');
    const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    return last || 'file';
  };
  const extensionMime = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
    if (lower.endsWith('.txt')) return 'text/plain';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.zip')) return 'application/zip';
    return undefined;
  };
  /** Only a chatgpt.com same-origin backend path or an absolute chatgpt.com URL may ever be fetched. */
  const safeUrl = (raw: string): string | null => {
    try {
      const url = new URL(raw, location.origin);
      return url.origin === location.origin ? url.href : null;
    } catch { return null; }
  };

  /**
   * Collect file candidates from the VERIFIED terminal message only. Three native shapes are covered:
   * `file-service://` asset pointers, `metadata.attachments[]` entries, and `sandbox:` markdown links
   * inside text parts (the shape the 2026-10-16 capability probe actually observed). Anything that
   * cannot be mapped to a same-origin download path is still reported, with `url: null`, so the caller
   * can fail that one file honestly instead of pretending it was received.
   */
  const collect = (): { candidates: ChatgptArtifactCandidate[]; failures: string[] } => {
    const messages = [request.terminalMessage, ...(Array.isArray(request.generatedMessages) ? request.generatedMessages : [])].map(asRecord).filter((message): message is Record<string, any> => !!message);
    if (!messages.length) throw new Error('原生终态消息尚未保留，无法确认文件归属。');
    const candidates: ChatgptArtifactCandidate[] = [];
    const failures: string[] = [];
    const seen = new Set<string>();
    const push = (name: string, mime: string | undefined, url: string | null): void => {
      const clean = baseName(name);
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      const index = candidates.length;
      const handleId = handleFor(index, clean);
      const mimeHint = mime || extensionMime(clean);
      candidates.push({ handleId, nameHint: clean, ...(mimeHint ? { mimeHint } : {}) });
      registry[handleId] = { name: clean, mime: mimeHint ?? 'application/octet-stream', url };
      if (!url) failures.push(clean);
    };
    const byName = new Map<string, string>();
    for (const message of messages) {
    const metadata = asRecord(message.metadata) ?? {};
    const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
    for (const raw of attachments) {
      const entry = asRecord(raw);
      if (!entry) continue;
      const name = textOf(entry.name) || textOf(entry.file_name);
      const id = textOf(entry.id) || textOf(entry.file_id);
      const url = id ? safeUrl(`/backend-api/files/${encodeURIComponent(id)}/download`) : null;
      if (name && url) byName.set(baseName(name), url);
    }
    const content = asRecord(message.content) ?? {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const raw of parts) {
      const part = asRecord(raw);
      if (!part && typeof raw !== 'string') continue;
      const pointer = textOf(part?.asset_pointer);
      if (pointer.startsWith('file-service://')||pointer.startsWith('sediment://')) {
        const id = pointer.slice(pointer.indexOf('://')+3);
        if(!/^[A-Za-z0-9_-]{1,200}$/.test(id)){failures.push('资源指针标识无效');continue;}
        if(request.verifiedUploads?.some(upload=>upload.fileId===id))continue;
        push(textOf(part?.name) || textOf(part?.file_name) || `${id}${pointer.startsWith('sediment://')?'.png':''}`, textOf(part?.mime_type) || undefined, safeUrl(`/backend-api/files/${encodeURIComponent(id)}/download`));
        continue;
      }
      const text = textOf(raw);
      if (!text) continue;
      // `[label](sandbox:/mnt/data/x.md)` and bare `sandbox:/mnt/data/x.md` both appear natively.
      const pattern = /\[([^\]]*)\]\(\s*(?:sandbox:|file-service:)([^)\s]+)\s*\)|(?:sandbox:|file-service:)(\/[^\s)\]]+)/gu;
      for (const match of text.matchAll(pattern)) {
        const label = textOf(match[1]) || baseName(textOf(match[2]) || textOf(match[3]));
        const target = textOf(match[2]) || textOf(match[3]);
        const named = byName.get(baseName(label)) ?? byName.get(baseName(target));
        const cid=request.stream?.document?.conversation_id??/\/c\/([^/?]+)/.exec(location.pathname)?.[1];const mid=textOf(message.id);
        const resolved=named??(cid&&mid&&target.startsWith('/mnt/data/')?safeUrl('/backend-api/conversation/'+encodeURIComponent(cid)+'/interpreter/download?download_intent=true&message_id='+encodeURIComponent(mid)+'&sandbox_path='+encodeURIComponent(target)):null);
        push(baseName(target), undefined, resolved);
      }
    }
    }
    return { candidates, failures };
  };

  const finishArtifacts = () => {
    const { candidates, failures } = collect();
    const shapes=input.includeGenerated===true?[request.terminalMessage,...(request.generatedMessages??[])].map(raw=>{const message=asRecord(raw);return{role:message?.author?.role,contentType:message?.content?.content_type,parts:(message?.content?.parts??[]).map((part:any)=>typeof part==='string'?{type:'text',length:part.length}:{type:typeof part,keys:part&&typeof part==='object'?Object.keys(part):[],pointerScheme:typeof part?.asset_pointer==='string'?part.asset_pointer.split('://')[0]:null})};}):[];
    delete request.generatedMessages;
    const messageId = textOf(asRecord(request.terminalMessage)?.id);
    if (failures.length) return { messageId, artifacts: candidates, discovery: 'failed', error: { code: 'unverified_identity', message: `以下文件没有可核验的同源下载地址：${failures.join('、')}` } };
    if(input.includeGenerated===true&&!candidates.length)return{messageId,artifacts:[],discovery:'failed',error:{code:'unsupported_asset_shape',message:'生成图片结构尚未支持：'+JSON.stringify(shapes)}};
    return { messageId, artifacts: candidates, discovery: 'complete' };
  };
  if (action === 'artifacts' && input.includeGenerated === true) return (async () => {
    const cid = request.stream?.document?.conversation_id || /\/c\/([^/?]+)/.exec(location.pathname)?.[1];
    const userId = request.userMessageId;
    if (!cid || !userId) return { messageId: '', artifacts: [], discovery: 'failed', error: { code: 'unverified_identity', message: '生成图探针缺少本次用户消息或会话身份。' } };
    try {
      const init: RequestInit = { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) };
      let response = await fetch('/backend-api/conversation/' + encodeURIComponent(cid), init);
      if (response.status === 401) {
        const session = await fetch('/api/auth/session', init); const token = (await session.json()).accessToken;
        if (typeof token !== 'string') throw Error('生成图会话失效。');
        response = await fetch('/backend-api/conversation/' + encodeURIComponent(cid), { ...init, headers: { Authorization: 'Bearer ' + token } });
      }
      if (!response.ok) throw Error('生成图来源回读 HTTP ' + response.status);
      const record = await response.json();
      if (record.conversation_id !== cid || !record.mapping) throw Error('生成图会话结构不可识别。');
      let userKey = '';
      for (const [key, node] of Object.entries(record.mapping as Record<string, any>)) if (node?.message?.id === userId && node.message.author?.role === 'user') userKey = key;
      if (!userKey) throw Error('会话中找不到本次用户消息，不能确认生成图归属。');
      const terminalId=asRecord(request.terminalMessage)?.id;
      let key=Object.keys(record.mapping).find(id=>record.mapping[id]?.message?.id===terminalId);
      if(!key||record.current_node&&record.current_node!==key)throw Error('生成图终态分支已变化，未接收。');
      const extra:unknown[]=[],seen=new Set<string>();
      while(key!==userKey&&key&&seen.size<80){
        if(seen.has(key))throw Error('生成图消息链循环。');seen.add(key);const node:any=record.mapping[key];
        if(node?.message?.author?.role==='user')throw Error('生成图跨越了另一条用户消息。');
        if(node?.message&&['assistant','tool'].includes(node.message.author?.role)&&node.message.id!==terminalId)extra.push(node.message);
        const parents=Object.keys(record.mapping).filter(parent=>(record.mapping[parent]?.children??[]).includes(key));
        const parent:string|undefined=node?.parent??(parents.length===1?parents[0]:undefined);
        if(typeof parent!=='string'||!record.mapping[parent]||!(record.mapping[parent].children??[]).includes(key))throw Error('生成图消息归属链不完整。');key=parent;
      }
      if(key!==userKey)throw Error('生成图不属于本次已核验用户消息。');
      request.generatedMessages = extra;
    } catch (error) {
      return { messageId: textOf(asRecord(request.terminalMessage)?.id), artifacts: [], discovery: 'failed', error: { code: 'unverified_identity', message: error instanceof Error ? error.message : String(error) } };
    }
    return finishArtifacts();
  })();
  if (action === 'artifacts') return finishArtifacts();

  const entry = input.handleId ? registry[input.handleId] : undefined;
  if (action === 'open-file') {
    if (!entry) throw new Error('文件句柄无效或不属于本次回复。');
    if (!entry.url) throw new Error('该文件没有可核验的同源下载地址，未接收。');
    return (async () => {
      const init:RequestInit={credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(60000)};
      let response=await fetch(entry.url as string,init);
      if(response.status===401){const session=await fetch('/api/auth/session',init);const token=(await session.json()).accessToken;if(typeof token!=='string')throw Error('文件会话失效');response=await fetch(entry.url as string,{...init,headers:{Authorization:'Bearer '+token}});}
      if(response.ok&&(response.headers.get('content-type')??'').includes('application/json')){const meta=await response.json();if(typeof meta.download_url!=='string')throw Error('下载解析没有文件地址');const target=new URL(meta.download_url);if(target.origin!==location.origin)throw Error('下载文件来源尚未支持');response=await fetch(target.href,init);}
      if (!response.ok) throw new Error(`文件下载 HTTP ${response.status}`);
      const reader=response.body?.getReader();if(!reader)throw Error('下载无正文');const chunks:Uint8Array[]=[];let total=0;try{while(true){const row=await reader.read();if(row.done)break;total+=row.value.length;if(total>16*1024*1024){await reader.cancel();throw Error('文件超过16 MiB');}chunks.push(row.value);}}finally{reader.releaseLock();}const buffer=new Uint8Array(total);let cursor=0;for(const chunk of chunks){buffer.set(chunk,cursor);cursor+=chunk.length;}
      entry.bytes = buffer;
      const header = response.headers.get('content-type') ?? '';
      const declared = header.split(';')[0]?.trim();
      if (declared && declared !== 'application/octet-stream') entry.mime = declared;
      return { handleId: input.handleId, name: entry.name, mime: entry.mime, bytes: buffer.byteLength };
    })();
  }
  if (action === 'read-chunk') {
    if (!entry || !entry.bytes) throw new Error('文件尚未打开。');
    const offset = Number(input.offset ?? 0), length = Number(input.length ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) throw new Error('文件读取参数无效。');
    const slice = entry.bytes.subarray(offset, Math.min(offset + length, entry.bytes.byteLength));
    let binary = '';
    for (let i = 0; i < slice.length; i += 1) binary += String.fromCharCode(slice[i] as number);
    return { data: btoa(binary), offset, eof: offset + slice.length >= entry.bytes.byteLength };
  }
  if (action === 'close-file') {
    if (entry) { delete entry.bytes; if (!entry.url) delete registry[input.handleId as string]; }
    return { closed: Boolean(entry) };
  }
  if (action === 'upload-image') {
    const slot = textOf(input.slot), name = textOf(input.name), mime = textOf(input.mime);
    if (!slot || !name || !mime) throw new Error('图片暂存参数无效。');
    if (input.done) {
      const staged = uploads[slot];
      if (!staged) throw new Error('图片暂存不存在。');
      const input_element = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!input_element) throw new Error('页面没有可用的文件输入框。');
      const decoded=staged.chunks.map(chunk=>atob(chunk));const bytes=new Uint8Array(decoded.reduce((sum,chunk)=>sum+chunk.length,0));let offset=0;for(const chunk of decoded){for(let i=0;i<chunk.length;i++)bytes[offset++]=chunk.charCodeAt(i);}
      let createdId='',processedId='',uploadError='';const originalFetch=window.fetch.bind(window);
      const observeFetch:typeof fetch=async(resource,init)=>{const url=typeof resource==='string'?resource:resource instanceof URL?resource.href:resource.url;const response=await originalFetch(resource,init);
        
        if(url.includes('/backend-api/files/process_upload_stream')){const raw=typeof init?.body==='string'?init.body:'';void(async()=>{const reader=response.clone().body?.getReader();if(!reader){uploadError='图片处理没有响应流';return;}const decoder=new TextDecoder();let buffer='',seen=0;const statuses:string[]=[];try{while(seen<1024*1024){const part=await reader.read();if(part.done)break;seen+=part.value.length;buffer+=decoder.decode(part.value,{stream:true});let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;try{const event=JSON.parse(line.startsWith('data:')?line.slice(5):line);for(const key of ['status','type','event'])if(typeof event[key]==='string')statuses.push(key+':'+event[key]);if(typeof event.file_id==='string'&&raw.includes(event.file_id)&&response.ok&&event.event==='file.processing.completed'){createdId=event.file_id;processedId=event.file_id;await reader.cancel();return;}}catch{}}}}catch(error){if(!processedId)uploadError='上传处理流结束但没有完成证明：'+statuses.slice(-8).join(',')+' '+String(error);}finally{reader.releaseLock();}if(!processedId&&!uploadError)uploadError='上传处理流没有已识别完成事件：'+statuses.slice(-8).join(',');})()}
        return response;};window.fetch=observeFetch;
      const file = new File([bytes], staged.name, { type: staged.mime });
      const transfer = new DataTransfer(); transfer.items.add(file);
      input_element.files = transfer.files;
      input_element.dispatchEvent(new Event('change', { bubbles: true }));
      delete uploads[slot];
      return (async()=>{try{const deadline=Date.now()+60000;while(Date.now()<deadline&&!processedId&&!uploadError)await new Promise(r=>setTimeout(r,100));if(uploadError||!processedId)throw Error(uploadError||'图片上传处理未确认，未发送');(request.verifiedUploads??=[]).push({fileId:processedId,name:staged.name});return {attached:true,name:staged.name,mime:staged.mime,bytes:bytes.byteLength,fileId:processedId};}finally{if(window.fetch===observeFetch)window.fetch=originalFetch;}})();
    }
    const data = textOf(input.data);
    if (!data) throw new Error('图片分块为空。');
    const staged = uploads[slot] ?? (uploads[slot] = { name, mime, chunks: [], bytes: 0 });
    if (staged.name !== name || staged.mime !== mime) throw new Error('同一暂存槽的图片内容发生变化。');
    staged.bytes += atob(data).length;
    if (staged.bytes > 16 * 1024 * 1024) { delete uploads[slot]; throw Error('图片暂存超过16 MiB。'); }
    staged.chunks.push(data);
    return { staged: true, bytes: staged.bytes };
  }
  throw new Error('未知页面文件操作。');
}

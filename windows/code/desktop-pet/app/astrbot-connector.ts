import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, renameSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {BookError} from '../contracts/memory-book.js';
import type {AstrbotSettings} from './astrbot-settings.js';

export interface AstrbotChatOutcome {
  requestId: string;
  inputHash?: string;
  state: 'pending' | 'completed' | 'failed' | 'unknown';
  text: string | null;
  error: string | null;
  httpStatus: number | null;
}

interface SseParse {
  terminal: boolean;
  failed: boolean;
  text: string | null;
  error: string | null;
}

/** Parse one AstrBot chat body. A dropped stream is not success, even when some text already arrived. */
export function parseAstrbotChatBody(body: string, contentType: string): SseParse {
  if (!contentType.includes('text/event-stream')) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); }
    catch { return {terminal: true, failed: true, text: null, error: 'AstrBot 返回了无法解析的业务体。'}; }
    if (!parsed || typeof parsed !== 'object') return {terminal: true, failed: true, text: null, error: 'AstrBot 业务体无效。'};
    const row = parsed as Record<string, unknown>;
    if (row.status === 'error' || row.ok === false) return {terminal: true, failed: true, text: null, error: typeof row.message === 'string' ? row.message : 'AstrBot 拒绝了这次对话。'};
    return {terminal: true, failed: true, text: null, error: 'AstrBot 对话接口没有返回 SSE。'};
  }
  let text: string | null = null;
  let terminal = false;
  let failed = false;
  let error: string | null = null;
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { terminal = true; continue; }
    let event: unknown;
    try { event = JSON.parse(data); }
    catch { failed = true; terminal = true; error = 'AstrBot SSE 事件不是 JSON。'; break; }
    if (!event || typeof event !== 'object') continue;
    const row = event as Record<string, unknown>;
    if (row.status === 'error' || row.type === 'error') { failed = true; terminal = true; error = typeof row.message === 'string' ? row.message : 'AstrBot 事件报告失败。'; break; }
    if (row.type === 'complete' || row.type === 'end' || row.done === true) {
      terminal = true;
      const finalText = typeof row.data === 'string' ? row.data : typeof row.text === 'string' ? row.text : '';
      if (finalText.trim()) text = finalText;
      continue;
    }
    if (row.type === 'chain' && Array.isArray(row.chain)) {
      const parts = row.chain.flatMap(part => part && typeof part === 'object' && (part as {type?: string}).type === 'plain' && typeof (part as {text?: string}).text === 'string' ? [(part as {text: string}).text] : []);
      text = parts.join('');
      continue;
    }
    if ((row.type === 'plain' || row.type === undefined) && row.chain_type !== 'reasoning') {
      const piece = typeof row.text === 'string' ? row.text : row.type === 'plain' && typeof row.data === 'string' ? row.data : null;
      if (piece !== null) text = (text ?? '') + piece;
    }
  }
  return {terminal, failed, text, error};
}

export class AstrbotConnector {
  private readonly file: string;
  constructor(private readonly directory: string, private readonly settings: AstrbotSettings, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (settings.execution !== 'astrbot') throw new BookError('conflict', '连接器只在 astrbot 执行模式下发送。');
    mkdirSync(join(directory, 'astrbot'), {recursive: true});
    this.file = join(directory, 'astrbot', 'requests.json');
  }

  get(requestId: string): AstrbotChatOutcome | null {
    return this.read().find(row => row.requestId === requestId) ?? null;
  }

  /** One local request id is never posted twice. Unknown and pending stay unknown. */
  async chat(input: {requestId: string; text: string; characterId: string; sessionId: string; mode?:'quick'|'smart'|'rp'; signal: AbortSignal}): Promise<AstrbotChatOutcome> {
    if (!input.requestId || input.requestId.length > 200 || !input.text.trim() || input.text.length > 16000) throw new BookError('invalid_input', 'AstrBot 请求编号或正文无效。');
    const inputHash = createHash('sha256').update(JSON.stringify([this.settings, input.characterId, input.sessionId, input.text,input.mode??null])).digest('hex');
    const existing = this.get(input.requestId);
    if (existing && existing.inputHash !== inputHash) throw new BookError('conflict', '同一请求编号的内容或会话已经变化，未发送。');
    if (existing) return existing.state === 'pending' ? {...existing, state: 'unknown', error: '上次提交没有确认结束，不会再次发送。'} : existing;
    input.signal.throwIfAborted();
    const pending: AstrbotChatOutcome = {requestId: input.requestId, inputHash, state: 'pending', text: null, error: null, httpStatus: null};
    this.write([...this.read(), pending]);
    const username = 'desktop-' + createHash('sha256').update(JSON.stringify([this.settings.instanceId, input.characterId])).digest('hex').slice(0, 24);
    const sessionId = 'allmind-' + createHash('sha256').update(JSON.stringify([this.settings.instanceId, input.characterId, input.sessionId])).digest('hex').slice(0, 32);
    const payload: Record<string, unknown> = {username, session_id: sessionId, message: input.text, enable_streaming: true};
    const configId=input.mode?this.settings.modeConfigIds?.[input.mode]??this.settings.configId:this.settings.configId;
    if (configId) payload.config_id = configId;
    try {
      const response = await this.fetchImpl(this.settings.baseUrl + '/api/v1/chat', {
        method: 'POST',
        headers: {Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json', Accept: 'text/event-stream'},
        body: JSON.stringify(payload),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(300000)]),
        redirect: 'error',
      });
      const body = await response.text();
      const parsed = parseAstrbotChatBody(body, response.headers.get('content-type') ?? '');
      const outcome: AstrbotChatOutcome = !response.ok || parsed.failed
        ? {requestId: input.requestId, state: 'failed', text: null, error: parsed.error ?? ('AstrBot HTTP ' + response.status), httpStatus: response.status}
        : !parsed.terminal
          ? {requestId: input.requestId, state: 'unknown', text: null, error: 'SSE 在结束事件前断开，结果未知，不会重发。', httpStatus: response.status}
          : parsed.text
            ? {requestId: input.requestId, state: 'completed', text: parsed.text, error: null, httpStatus: response.status}
            : {requestId: input.requestId, state: 'unknown', text: null, error: 'SSE 结束但没有文本，结果未知，不会重发。', httpStatus: response.status};
      this.replace(outcome);
      return outcome;
    } catch (error) {
      const outcome: AstrbotChatOutcome = {requestId: input.requestId, state: 'unknown', text: null, error: input.signal.aborted ? '本地已停止显示；远端是否生成未知，不会重发。' : (error instanceof Error ? error.message : String(error)), httpStatus: null};
      this.replace(outcome);
      return outcome;
    }
  }

  sessionBinding(characterId: string, sessionId: string) {
    return {
      instanceId: this.settings.instanceId,
      principalKey: 'desktop-' + createHash('sha256').update(JSON.stringify([this.settings.instanceId, characterId])).digest('hex').slice(0, 24),
      platform: 'desktop',
      conversationKey: sessionId,
      characterId,
      pairingId: 'local-user',
      localSessionId: sessionId,
      remoteSessionId: 'allmind-' + createHash('sha256').update(JSON.stringify([this.settings.instanceId, characterId, sessionId])).digest('hex').slice(0, 32),
      execution: 'astrbot' as const,
      configId: this.settings.configId,
    };
  }

  /** Platform acceptance is distinct from delivery/read. A lost acknowledgement is never resent. */
  async send(input:{requestId:string;umo:string;text:string;signal:AbortSignal}):Promise<AstrbotChatOutcome>{
    if(!input.requestId||input.requestId.length>180||!input.umo||input.umo.length>500||!input.text.trim()||input.text.length>16000)throw new BookError('invalid_input','发送编号、目标或正文无效。');
    const requestId='im.'+input.requestId,inputHash=createHash('sha256').update(JSON.stringify(['im',this.settings.instanceId,input.umo,input.text])).digest('hex');
    const prior=this.get(requestId);
    if(prior){if(prior.inputHash!==inputHash)throw new BookError('conflict','发送编号已绑定其他正文或目标。');return prior.state==='pending'?{...prior,state:'unknown'}:prior;}
    input.signal.throwIfAborted();
    this.write([...this.read(),{requestId,inputHash,state:'pending',text:null,error:null,httpStatus:null}]);
    let outcome:AstrbotChatOutcome;
    try{
      const response=await this.fetchImpl(this.settings.baseUrl+'/api/v1/im/message',{method:'POST',headers:{Authorization:'Bearer '+this.apiKey,'Content-Type':'application/json'},body:JSON.stringify({umo:input.umo,message:input.text}),redirect:'error',signal:AbortSignal.any([input.signal,AbortSignal.timeout(30000)])});
      const body=await response.json() as {status?:string;message?:string};
      outcome={requestId,inputHash,state:response.ok&&body.status==='ok'?'completed':response.ok?'unknown':'failed',text:null,error:response.ok&&body.status==='ok'?null:'平台接受状态未确认，请核对；未自动重发。',httpStatus:response.status};
    }catch{outcome={requestId,inputHash,state:'unknown',text:null,error:'平台回执丢失或超时，是否已发送未知，未自动重发。',httpStatus:null};}
    this.replace(outcome);return outcome;
  }

  private read(): AstrbotChatOutcome[] {
    if (!existsSync(this.file)) return [];
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as AstrbotChatOutcome[];
    if (!Array.isArray(parsed) || parsed.some(row => !row || typeof row.requestId !== 'string' || !['pending','completed','failed','unknown'].includes(row.state))) throw new BookError('corrupt_data', 'AstrBot 请求账本损坏，未继续提交。');
    return parsed;
  }

  private replace(outcome: AstrbotChatOutcome): void {
    this.write(this.read().map(row => row.requestId === outcome.requestId ? {...outcome, ...(row.inputHash ? {inputHash:row.inputHash} : {})} : row));
  }

  private write(rows: AstrbotChatOutcome[]): void {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(rows) + '\n', {mode: 0o600});
    renameSync(temp, this.file);
  }
}

/** The local generator is not invoked when AstrBot owns the turn, including when the remote result is unknown. */
export async function runTurnExecutor(input: {execution: 'local' | 'astrbot'; local: () => Promise<string>; remote: () => Promise<AstrbotChatOutcome>}): Promise<{executor: 'local' | 'astrbot'; text: string}> {
  if (input.execution === 'astrbot') {
    const outcome = await input.remote();
    if (outcome.state !== 'completed' || !outcome.text) throw new BookError('unavailable', outcome.error ?? 'AstrBot 结果未知，未改走本地生成。');
    return {executor: 'astrbot', text: outcome.text};
  }
  return {executor: 'local', text: await input.local()};
}

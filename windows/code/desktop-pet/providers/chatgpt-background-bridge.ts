import { readFileSync, writeFileSync, existsSync, renameSync,statSync } from 'node:fs';
import {fileURLToPath} from 'node:url';
import { BookError, type ChatgptWebSourceConfig } from '../contracts/memory-book.js';
import { createNodeToolRunner, type ChatgptToolRunner, type ChatgptWebAskOptions, type ChatgptWebAskResult, type ChatgptWebProbe } from './chatgpt-web-bridge.js';
import { consumeChatgptStreamEvent, type ChatgptStreamState } from './chatgpt-stream-observer.js';
import { ARTIFACT_ACTIONS, artifactAction, type ChatgptArtifactInput } from './chatgpt-artifacts.js';
import { createHash } from 'node:crypto';
import { PROJECT_ID, CONVERSATION_ID, validateProjectBinding, type ChatgptProjectTarget, type ChatgptProjectBinding } from '../contracts/chatgpt-project.js';
import { validateScope } from '../memory/book-validation.js';
import { RESOURCE_LIMITS } from '../contracts/book-resources.js';
import {replaceResourceFile} from '../memory/resource-atomic-replace.js';
// Refresh the fixed dependency together with the existing opt-in development adapter reload.
const artifactModule=new URL('./chatgpt-artifacts.js',import.meta.url);
const currentArtifactAction=process.env.AIKI_CHAT_ADAPTER_RELOAD==='1'?(await import(artifactModule.href+'?revision='+statSync(fileURLToPath(artifactModule)).mtimeMs)).artifactAction as typeof artifactAction:artifactAction;
/** Native status labels may include model prefix and item position, e.g. “6 高，第3项”. */
export const isHighThinkingLabel=(label:unknown):boolean=>typeof label==='string'&&/(?:^|[\s，,:：])(?:high|高|高强度)(?=$|[\s，,.。:：])/i.test(label.trim());

export interface ChatgptPageInput { id?: string; text?: string; temporary?: boolean; model?: string; level?: number; projectId?: string; conversationId?: string; expectedNode?: string;
  /** W01: opaque file handle discovered from the verified native terminal message. */
  handleId?: string; offset?: number; length?: number;
  /** W01: staged image upload. `data` is a base64 chunk (≤ 64 KiB decoded). */
  slot?: string; name?: string; mime?: string; data?: string; done?: boolean; includeGenerated?: boolean }
export interface ChatgptPageDestination { projectId: string; conversationId?: string }
interface ProjectThread { key: string; projectId: string; conversationId: string; node: string; localTurnId: string | null; binding?:ChatgptProjectBinding; scope?:import('../contracts/memory-book.js').BookScope }

/** Only a failed read before submission can recreate the task's own empty page. */
function lostTaskTab(error: unknown): boolean {
  return error instanceof Error && /the tab this command was driving is gone|the relay is (?:NOT |not )attached to this tab|No tab with id:\s*\d+|Could not establish connection\. Receiving end does not exist/i.test(error.message);
}

export interface ChatgptPageHost {
  execute(action: string, input: ChatgptPageInput): Promise<Record<string, any>>;
  navigate(temporary: boolean, project?: ChatgptPageDestination): Promise<void>;
  login(): Promise<void>;
}

/** W01: what the current embedded source can actually do. Never optimistic. */
export interface ChatgptSourceCapabilities {
  outputFiles: 'available' | 'unavailable' | 'unknown';
  inputImages: 'available' | 'unavailable' | 'unknown';
  /** Native generated images are unknown until a product-owned probe receives real bytes. */
  outputImages: 'available' | 'unavailable' | 'unknown';
  reason?: string;
}

/** Host-side allow-list: no caller-supplied JavaScript, URL, file path or native command. */
export function chatgptPageScript(action: string, input: Record<string, unknown> = {}): string {
  const isArtifact = (ARTIFACT_ACTIONS as readonly string[]).includes(action);
  if (!isArtifact && !['account', 'project', 'thinking', 'models', 'probe', 'prepare', 'model', 'write', 'submit', 'submission', 'cancel', 'read'].includes(action)) throw new Error('未知 Chat 页面操作。');
  const allowed = isArtifact
    ? ['id', 'handleId', 'offset', 'length', 'slot', 'name', 'mime', 'data', 'done', 'conversationId', 'expectedNode', 'expectedTextHash', 'includeGenerated']
    : ['id', 'text', 'temporary', 'model', 'level', 'projectId', 'conversationId', 'expectedNode',...(action==='read'?['includeGenerated']:[])];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Chat 页面参数无效。');
  if(input.level!==undefined&&(!Number.isSafeInteger(input.level)||Number(input.level)<0||Number(input.level)>8))throw Error('思考强度参数无效。');
  if (input.projectId !== undefined && (typeof input.projectId !== 'string' || !PROJECT_ID.test(input.projectId))) throw new Error('项目标识无效。');
  for (const key of ['conversationId','expectedNode']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !CONVERSATION_ID.test(input[key] as string))) throw new Error('项目线程标识无效。');
  for (const key of ['id', 'model']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 128)) throw new Error('Chat 页面标识无效。');
  if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 3000)) throw new Error('Chat 页面输入块过长。');
  if (input.temporary !== undefined && typeof input.temporary !== 'boolean') throw new Error('Chat 临时模式参数无效。');
  if(input.includeGenerated!==undefined&&typeof input.includeGenerated!=='boolean')throw new Error('生成资源读取标志无效。');
  // W01 artifact actions: closed fields only. `handleId` is an opaque per-message handle, never a path;
  // `data` is one bounded base64 chunk; `offset`/`length` are safe integers within one file.
  if (isArtifact) {
    if(input.expectedTextHash!==undefined&&(typeof input.expectedTextHash!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedTextHash)))throw Error('文件完成哈希无效。');
    for (const key of ['handleId', 'slot', 'name', 'mime']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 200)) throw new Error('Chat 文件标识无效。');
    if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) throw new Error('Chat 文件偏移无效。');
    if (input.length !== undefined && (!Number.isSafeInteger(input.length) || Number(input.length) <= 0 || Number(input.length) > 262144)) throw new Error('Chat 文件读取长度无效。');
    if (input.data !== undefined && (typeof input.data !== 'string' || input.data.length > 131072 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data))) throw new Error('Chat 文件分块无效。');
    if (input.done !== undefined && typeof input.done !== 'boolean') throw new Error('Chat 文件完成标记无效。');
    if (input.includeGenerated !== undefined && typeof input.includeGenerated !== 'boolean') throw new Error('生成图探针参数无效。');
  }
  const body = isArtifact ? currentArtifactAction.toString() : pageAction.toString();
  return '(' + body + ')(' + JSON.stringify(action) + ',' + JSON.stringify(input) + (isArtifact ? '' : ',(' + consumeChatgptStreamEvent.toString() + ')') + ')';
}

/** Browser-owned writes; only the selected conversation is read back. No token leaves the page.
 * Pattern references: chatgpt-use ecb204d/channel.rs and DrA1ex 0ffdae9/conversationReconciliation.js (MIT).
 * This adapter never launches Chrome, changes another tab, or submits an internal HTTP POST.
 */
export async function pageAction(action: string, input: ChatgptPageInput, consume: typeof consumeChatgptStreamEvent) {
  const host = window as typeof window & { __aikiCaptureInstalled?: boolean; __aikiChatRequest?: { id: string; prompt: string; temporary: boolean; submitted: boolean; projectId?: string; conversationId?: string; sentPrompt?: string; userMessageId?: string; blockedMessage?: string; stream?: ChatgptStreamState; streamEnded?: boolean; verifiedUploads?:{fileId:string;name:string}[]; terminalMessage?: unknown; artifacts?: Record<string, unknown> } };
  const temporary = () => Array.from(document.querySelectorAll('button')).some(n => /^(关闭临时聊天|Turn off temporary chat|Temporary chat enabled)$/i.test(n.getAttribute('aria-label') ?? ''));
  const visible = (n: Element) => {
    if (n.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    for (let p: Element | null = n; p; p = p.parentElement) if (getComputedStyle(p).display === 'none') return false;
    return true;
  };
  const composers = () => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('#prompt-textarea,[contenteditable="true"][data-lexical-editor="true"],textarea[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"][data-composer-markdown]')).filter(visible);
    return nodes.filter(n => !nodes.some(other => other !== n && n.contains(other)));
  };
  const stop = () => document.querySelector<HTMLElement>('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop streaming"],button[aria-label="Stop generating"],button[aria-label="停止生成"]');
  const normalize = (s: string) => s.replace(/\r/g, '').replace(/\u00a0/g, ' ').trimEnd();
  if (!['chatgpt.com', 'chat.openai.com'].includes(location.hostname)) throw new Error('会话不在 ChatGPT 页面。');
  if (action === 'account') {
    let reason = '登录状态尚未就绪';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(6000) });
        if (!response.ok) {
          reason = '登录状态接口 HTTP ' + response.status;
          if (![408, 429].includes(response.status) && response.status < 500) break;
        } else {
          const session = await response.json();
          if (typeof session.user?.id === 'string' && session.user.id) {
            // Only an opaque fingerprint leaves the page. Tokens and session bodies never do.
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.user.id));
            return { account: Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('') };
          }
          reason = '登录状态接口尚未返回用户身份';
        }
      } catch (error) { reason = '登录状态读取失败（' + (error instanceof Error ? error.name : 'UnknownError') + '）'; }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
    throw new Error(reason + '；暂时无法确认账号，未发送。请等待页面加载后回读状态，无需因此重置配对。');
  }
  const checkProject = async (projectId: string, conversationId?: string, expectedNode?: string) => {
    if (temporary()) throw new Error('临时页面不能作为项目聊天。');
    if (!conversationId) {
      const readyUntil=Date.now()+8000;
      while(composers().length!==1&&Date.now()<readyUntil)await new Promise(resolve=>setTimeout(resolve,150));
      const route = /^\/g\/(g-p-[a-f0-9]{32})(?:-[a-zA-Z0-9-]+)?\/project\/?$/.exec(location.pathname);
      if (route?.[1] !== projectId || composers().length !== 1) throw new Error('没有确认目标项目的新对话页面，未发送。');
      const heading=Array.from(document.querySelectorAll('h1')).filter(visible);
      return { projectId, name:heading.length===1?heading[0]!.textContent?.trim()??'':'', conversationId:null, memory:'unverified' };
    }
    const init: RequestInit={credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)};
    const endpoint='/backend-api/conversation/'+encodeURIComponent(conversationId);
    let response=await fetch(endpoint,init);
    if(response.status===401){
      const session=await fetch('/api/auth/session',init);if(!session.ok)throw Error('项目线程登录状态不可用。');
      const token=(await session.json()).accessToken;if(typeof token!=='string')throw Error('项目线程登录已失效。');
      response=await fetch(endpoint,{...init,headers:{Authorization:'Bearer '+token}});
    }
    if(!response.ok)throw Error('项目线程检查 HTTP '+response.status);
    const record=await response.json();
    if(record.conversation_id!==conversationId || record.gizmo_id!==projectId || typeof record.current_node!=='string' || !record.mapping?.[record.current_node])throw Error('项目线程归属证据缺失或不匹配，不发送/交付。');
    const node=record.mapping[record.current_node];
    if(expectedNode && node.message?.id!==expectedNode)throw Error('网页线程已被外部修改或结果未同步，不能自动续接。');
    return {projectId,conversationId,currentNode:node.message?.id??null,memory:'unverified'};
  };
  if(action==='project')return checkProject(input.projectId!,input.conversationId,input.expectedNode);
  if (action === 'probe') return { ready: composers().length === 1, temporary: temporary(), generating: Boolean(stop()), projectId:/^\/g\/(g-p-[a-f0-9]{32})(?:-|\/)/.exec(location.pathname)?.[1]??null, conversationId:/\/c\/([^/?]+)/.exec(location.pathname)?.[1]??null, hasTurns: Array.from(document.querySelectorAll('[data-message-author-role="user"],[data-conversation-role="user"],[data-turn-key]')).some(visible) };
  if (action === 'prepare') {
    if (stop()) throw new Error('网页仍在生成，不能覆盖。');
    for (let i = 0; i < 20 && composers().length === 0; i++) await new Promise(r => setTimeout(r, 250));
    const nodes = composers();
    if (nodes.length !== 1) throw new Error('未找到唯一聊天输入框，需要登录或页面不可用。');
    if (input.temporary && !temporary()) throw new Error('临时聊天未启用，拒绝提交。');
    if(input.projectId)await checkProject(input.projectId,input.conversationId,input.expectedNode);
    host.__aikiChatRequest = { id: input.id!, prompt: '', temporary: Boolean(input.temporary), submitted: false, ...(input.projectId?{projectId:input.projectId}:{}), ...(input.conversationId?{conversationId:input.conversationId}:{}) };
    const node = nodes[0]!;
    node.focus();
    if (node instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      document.execCommand('delete');
    }
    return { ready: true, temporary: temporary() };
  }
  if (action === 'model' || action === 'models' || action==='thinking') {
    const label = input.model ?? '';
    if (action==='model' && (!label || ['auto', 'current', 'default'].includes(label))) return { model: label };
    let picker: HTMLElement | null = null;
    for (let attempt = 0; attempt < 20 && !picker; attempt++) {
      // Some page variants omit aria-haspopup or include the current model in the
      // accessible name. Collect the union so two different known triggers remain
      // ambiguous instead of selecting whichever selector happened to run first.
      const matches = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(node => {
        if (!visible(node) || node.disabled || node.getAttribute('aria-disabled') === 'true' || getComputedStyle(node).visibility === 'hidden') return false;
        const name = node.getAttribute('aria-label') ?? '';
        return ['model-switcher-dropdown-button','model-switcher'].includes(node.getAttribute('data-testid') ?? '')
          || node.getAttribute('data-codex-intelligence-trigger') === 'true'
          || /^(?:选择 ChatGPT 模型|Select ChatGPT model)$/.test(name)
          || /^Model selector(?:,|$)/i.test(name)
          || /^模型选择器(?:[，,:：]|$)/.test(name);
      });
      if (matches.length === 1) picker = matches[0]!;
      if (matches.length > 1) throw new Error('发现多个可见模型按钮，无法确认唯一入口；未提交消息，不会自动更换型号。');
      if (!picker) await new Promise(r => setTimeout(r, 250));
    }
    if (!picker) throw new Error('无法确认唯一模型按钮。若使用网页当前模型，请在连接设置选择“跟随网页当前模型”（current）并保存；未提交消息，不会自动更换型号。');
    const modelPicker = picker;
    const openPicker = async () => {
      if (modelPicker.getAttribute('aria-expanded') !== 'true') {
        modelPicker.focus();
        // Radix's trigger uses pointerdown/keydown rather than click. Keep focus and
        // its keyboard action in one page evaluation; CLI reconnects can reset focus.
        modelPicker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 500));
        if(modelPicker.getAttribute('aria-expanded')!=='true'&&!Array.from(document.querySelectorAll('[role="menu"],[role="listbox"],[role="menuitemradio"]')).some(visible))modelPicker.click();
      }
      await new Promise(r => setTimeout(r, 500));
    };
    await openPicker();
    if(action==='thinking'){
      let control=Array.from(document.querySelectorAll<HTMLElement>('[data-reasoning-slider="true"]')).filter(visible);
      if(control.length===0){
        const current=Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')).filter(visible);
        if(current.length===1){current[0]!.click();await new Promise(resolve=>setTimeout(resolve,200));await openPicker();control=Array.from(document.querySelectorAll<HTMLElement>('[data-reasoning-slider="true"]')).filter(visible);}
      }
      if(control.length!==1)throw Error('当前模型没有可核验的唯一思考强度控制。');
      const node=control[0]!,slider=node.querySelector('[role="slider"]');
      const value=()=>Number(slider?.getAttribute('aria-valuenow'));
      const original=value(),minimum=Number(slider?.getAttribute('aria-valuemin')),maximum=Number(slider?.getAttribute('aria-valuemax'));
      if(!slider||![original,minimum,maximum].every(Number.isSafeInteger)||minimum<0||maximum>8||original<minimum||original>maximum)throw Error('思考强度范围不可识别。');
      const label=()=>{const ids=(node.getAttribute('aria-describedby')??'').split(' ');return ids.map(id=>document.getElementById(id)).find(element=>element?.getAttribute('role')==='status')?.textContent?.trim()??'';};
      const move=async(target:number)=>{
        if(target<minimum||target>maximum)throw Error('账号不支持该思考强度。');
        for(let count=0;value()!==target&&count<9;count++){
          const before=value(),key=before<target?'ArrowRight':'ArrowLeft';node.focus();node.dispatchEvent(new KeyboardEvent('keydown',{key,code:key,bubbles:true,cancelable:true}));
          const deadline=Date.now()+2000;while(value()===before&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
          if(value()===before)throw Error('思考强度切换没有确认，不能假报保存。');
        }
        if(value()!==target)throw Error('思考强度未达到目标。');
        await new Promise(resolve=>setTimeout(resolve,100));
      };
      if(input.level!==undefined){await move(input.level);const selectedLabel=label();node.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));return {level:value(),label:selectedLabel,minimum,maximum};}
      const options=[];
      try{for(let level=minimum;level<=maximum;level++){await move(level);const text=label();if(!text)throw Error('思考强度选项没有可读标签。');options.push({level,label:text});}}
      finally{await move(original);node.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));}
      return {level:original,label:options.find(option=>option.level===original)?.label,options};
    }
    const viewToggle=Array.from(document.querySelectorAll<HTMLElement>('[data-model-picker-view-toggle="true"]')).filter(visible);
    if(viewToggle.length===1){viewToggle[0]!.click();await new Promise(resolve=>setTimeout(resolve,350));}
    if(action==='models'){
      const options=Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"],[role="menuitem"],[role="option"]')).filter(visible).map(node=>({label:(node.innerText.trim()||node.textContent?.trim()||'').slice(0,200),role:node.getAttribute('role'),checked:node.getAttribute('aria-checked'),popup:node.getAttribute('aria-haspopup'),state:node.getAttribute('data-state')})).slice(0,30);
      const selected=modelPicker.innerText.trim().slice(0,200);
      modelPicker.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
      const triggers=Array.from(document.querySelectorAll<HTMLElement>('button[aria-label="选择 ChatGPT 模型"],button[aria-label="Select ChatGPT model"],button[data-testid="model-switcher-dropdown-button"],button[data-codex-intelligence-trigger="true"],button[data-testid="model-switcher"]')).filter(visible).map(node=>({label:node.getAttribute('aria-label'),testId:node.getAttribute('data-testid'),text:node.textContent?.trim().slice(0,200),innerText:node.innerText.trim().slice(0,200)}));
      const menuMarkup=Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).filter(visible).map(node=>node.outerHTML.slice(0,16000)).slice(0,3);
      return {selected,options,triggers,menuMarkup};
    }
    const readOption = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).filter(n => {
      const text=(n.innerText.trim()||n.textContent?.trim()||'').split('\n')[0];
      // New native menu abbreviates the verified GPT numeric family, e.g. GPT-6 → 6.
      return visible(n)&&(text===label||/^GPT-\d+(?:\.\d+)?$/.test(label)&&text===label.slice(4));
    });
    const waitOption = async (checked = false) => {
      const deadline = Date.now() + 5000; let matches = readOption();
      while (Date.now() < deadline && (matches.length !== 1 || checked && matches[0]!.getAttribute('aria-checked') !== 'true')) { await new Promise(r => setTimeout(r, 100)); matches = readOption(); }
      return matches;
    };
    let matches = await waitOption();
    if (matches.length !== 1) throw new Error('账号模型菜单中没有唯一精确选项：' + label + '；匹配数 ' + matches.length);
    if (matches[0]!.getAttribute('aria-checked') !== 'true') {
      matches[0]!.click(); await new Promise(r => setTimeout(r, 300));
      await openPicker(); matches = await waitOption(true);
    }
    if (matches.length !== 1 || matches[0]!.getAttribute('aria-checked') !== 'true') throw new Error('模型选择未确认：' + label);
    modelPicker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    return { model: label };
  }
  const request = host.__aikiChatRequest;
  if (!request || request.id !== input.id) throw new Error('页面请求身份丢失；提交状态未知，不得自动重发。');
  if (action === 'submission') return { submitted: request.submitted };
  if (action === 'write') {
    if (request.submitted) throw new Error('不能改写已提交请求。');
    const node = composers()[0]; if (!node) throw new Error('输入框不可用。');
    node.focus();
    if (node instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, node.value + input.text!);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (!document.execCommand('insertText', false, input.text!)) throw new Error('无法输入提示词。');
    request.prompt += input.text!;
    return { ok: true };
  }
  if (action === 'submit') {
    if (request.submitted) throw new Error('该请求已经提交，不得重复提交。');
    if (request.temporary && !temporary()) throw new Error('临时模式在提交前丢失，拒绝提交。');
    if(request.projectId)await checkProject(request.projectId,request.conversationId);
    const node = composers()[0]; if (!node) throw new Error('输入框不可用。');
    // innerText inserts layout-driven blank lines between <p> blocks. Serialize the
    // editor's actual paragraphs instead; the exact intended input check remains intact.
    const paragraphs = Array.from(node.children);
    const actual = node instanceof HTMLTextAreaElement ? node.value : paragraphs.length && paragraphs.every(p => p.tagName === 'P')
      ? paragraphs.map(p => p.getAttribute('data-empty-paragraph') === 'true' ? '' : p.textContent ?? '').join('\n') : node.innerText;
    if (normalize(actual) !== normalize(request.prompt)) throw new Error('输入完整性校验失败，未提交。');
    const button = document.querySelector<HTMLButtonElement>('button[data-testid="send-button"],button[data-testid="fruitjuice-send-button"],button#composer-submit-button,button[aria-label="发送"],button[aria-label="Send prompt"]');
    if (!button || button.disabled) throw new Error('发送按钮不可用，未提交。');
    if (!host.__aikiCaptureInstalled) {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (resource, init) => {
        const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
        const current = host.__aikiChatRequest;
        let tracked = false;
        if (current?.submitted && !current.sentPrompt && /\/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(url) && (init?.method ?? (resource instanceof Request ? resource.method : 'GET')).toUpperCase() === 'POST') {
          const body = typeof init?.body === 'string' ? init.body : resource instanceof Request ? await resource.clone().text() : null;
          if(!body && current.projectId){current.submitted=false;current.blockedMessage='项目提交正文不可校验，已阻止发出。';throw Error(current.blockedMessage);}
          if (body) {
            const payload = JSON.parse(body);
            if (current.projectId && (payload.gizmo_id !== current.projectId || payload.history_and_training_disabled === true || (current.conversationId ? payload.conversation_id !== current.conversationId : Boolean(payload.conversation_id)))) {
              current.submitted=false;current.blockedMessage='网页提交的项目、线程或模式不匹配，已阻止发出。';throw Error(current.blockedMessage);
            }
            if (current.temporary && payload.history_and_training_disabled !== true) {
              current.submitted = false;
              current.blockedMessage = '网页请求未证明临时聊天，已阻止发出。';
              throw new Error(current.blockedMessage);
            }
            const user = payload.messages?.findLast((m: any) => m.author?.role === 'user' || m.role === 'user');
            if (['text','multimodal_text'].includes(user?.content?.content_type) && Array.isArray(user.content.parts)) {
              const uploads=current.verifiedUploads??[];if(uploads.some(row=>!JSON.stringify(user).includes(row.fileId))){current.submitted=false;current.blockedMessage='本次消息未携带已核实的图片，已阻止发送。';throw Error(current.blockedMessage);}
              // Observe, never modify or reproduce the browser's own POST. Its text
              // serialization and message ID are the exact readback boundary.
              current.sentPrompt = user.content.parts.filter((part:unknown)=>typeof part==='string').join(''); current.userMessageId = user.id;
              current.stream = { document: {}, path: '', operation: '', done: false, error: null };
              tracked = true;
            }
            if(current.projectId && !tracked){current.submitted=false;current.blockedMessage='项目提交缺少可核验用户消息，已阻止发出。';throw Error(current.blockedMessage);}
          }
        }
        let response: Response;
        try { response = await originalFetch(resource, init); }
        catch (error) {
          if (tracked && current?.stream) { current.stream.error = '网页网络请求失败：' + String(error); current.streamEnded = true; }
          throw error;
        }
        if (tracked && current?.stream) {
          const state = current.stream;
          if (!response.ok || !response.body) { state.error = '网页提交 HTTP ' + response.status; current.streamEnded = true; }
          else {
            const reader = response.clone().body!.getReader();
            // The browser consumes its normal response concurrently. Only our clone is read.
            void (async () => {
              const decoder = new TextDecoder(); let buffer = '';
              const frame = (block: string) => {
                const eventName = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
                const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (!data) return;
                consume(state, data === '[DONE]' ? data : JSON.parse(data), eventName);
              };
              try {
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) { buffer += decoder.decode(); break; }
                  buffer += decoder.decode(chunk.value, { stream: true });
                  buffer = buffer.replace(/\r\n/g, '\n');
                  if (buffer.length > 1000000) throw new Error('原生流事件超过观察上限。');
                  let boundary: number;
                  while ((boundary = buffer.indexOf('\n\n')) >= 0) { frame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
                  if (state.done && state.document.message?.status === 'finished_successfully' && state.document.message?.end_turn === true) {
                    void reader.cancel().catch(() => {}); break;
                  }
                }
                if (buffer.trim()) frame(buffer);
              } catch (error) { state.error = '原生流观察失败：' + String(error); }
              finally { current.streamEnded = true; reader.releaseLock(); }
            })();
          }
        }
        return response;
      };
      host.__aikiCaptureInstalled = true;
    }
    request.submitted = true; // The browser side also forbids replay after a lost tool response.
    button.click();
    return { submitted: true };
  }
  if (action === 'cancel') { const button = stop(); if (button) button.click(); return { clicked: Boolean(button) }; }
  if (action !== 'read') throw new Error('未知页面动作。');
  if (request.blockedMessage) return { state: 'not_submitted', message: request.blockedMessage };
  // After the first send, ChatGPT replaces the blank-page temporary toggle. The
  // captured native POST has already proven history_and_training_disabled=true.
  if (request.temporary && !temporary() && !(request.sentPrompt && request.userMessageId)) return { state: 'incomplete', message: '临时模式在生成过程中未获得请求证据。' };
  if (request.stream) {
    const stream = request.stream;
    // A cloned browser response can abort while the page continues the same turn. Only this
    // observed transport failure may use the existing identity-checked conversation readback.
    // Schema/protocol/service errors remain hard failures, never guessed from rendered text.
    const transportAborted=typeof stream.error==='string'&&stream.error.startsWith('原生流观察失败：AbortError:');
    if (stream.error&&!transportAborted) return { state: 'incomplete', message: stream.error };
    // A handoff continues on a separate web stream. Only a verified conversation
    // readback can recover it; never treat handoff metadata or DOM text as final.
    if (!request.streamEnded && !stream.handoff) return { state: 'pending' };
    const observed=stream.document.message;
    const finalMessage=observed?.author?.role==='assistant'&&observed.status==='finished_successfully'&&observed.end_turn===true&&(!observed.channel||observed.channel==='final')&&(!observed.recipient||observed.recipient==='all');
    // Image generation can end this stream at an intermediate tool message. That is not a final
    // reply; continue with the same verified user's conversation chain until a real final exists.
    if (!stream.handoff&&!transportAborted&&!(request.streamEnded&&stream.done&&observed&&!finalMessage)) {
    const message = stream.document.message;
    if (!stream.done || !request.sentPrompt || !request.userMessageId || !message || message.author?.role !== 'assistant') return { state: 'incomplete', message: '原生流没有完整消息和结束证据。' };
    if (message.metadata?.finish_details?.type === 'interrupted' || message.status === 'cancelled') return { state: 'cancelled' };
    if (message.status !== 'finished_successfully' || message.end_turn !== true || message.channel && message.channel !== 'final' || message.recipient && message.recipient !== 'all') return { state: 'incomplete', message: '原生流未确认完整正文终态。' };
    // W01: only the two verified terminal content shapes may pass. `multimodal_text` still has to
    // carry at least one plain-text part; unknown part shapes are refused, never silently accepted.
    const contentType = message.content?.content_type;
    if (contentType !== 'text' && contentType !== 'multimodal_text') return { state: 'incomplete', message: '原生回复不是纯文本。' };
    if (!Array.isArray(message.content.parts)) return { state: 'incomplete', message: '原生回复不是纯文本。' };
    const text = message.content.parts.filter((part: unknown) => typeof part === 'string').join('');
    const extra = message.content.parts.filter((part: unknown) => typeof part !== 'string');
    if (extra.some((part: any) => !part || typeof part !== 'object' || typeof (part.asset_pointer ?? part.file_id ?? part.file_name ?? part.name) === 'undefined')) return { state: 'incomplete', message: '原生回复包含无法核验的附件块。' };
    // A verified native final may have empty text after image tools. The bridge separately
    // requires text for ordinary replies; artifact callers must still receive verified bytes.
    // The verified terminal message is retained so file handles can be derived from THIS message
    // identity later — never from the display text or a DOM guess.
    request.terminalMessage = message;
    return { state: 'completed', text, conversationId: stream.document.conversation_id ?? null, messageId:message.id??null, modelSlug: message.metadata?.model_slug ?? null };
    }
  }
  if (stop()) return { state: 'pending' };
  const conversationId = request.stream?.handoff?.conversationId ?? request.stream?.document?.conversation_id ?? /\/c\/([^/?]+)/.exec(location.pathname)?.[1];
  if (!conversationId) return { state: 'pending' };
  const init: RequestInit = { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) };
  let response = await fetch('/backend-api/conversation/' + encodeURIComponent(conversationId), init);
  if (response.status === 401) {
    const session = await fetch('/api/auth/session', init);
    if (!session.ok) return { state: 'incomplete', message: '无法回读登录会话。' };
    const token = (await session.json()).accessToken;
    if (typeof token !== 'string') return { state: 'incomplete', message: '登录会话已失效。' };
    response = await fetch('/backend-api/conversation/' + encodeURIComponent(conversationId), { ...init, headers: { Authorization: 'Bearer ' + token } });
  }
  if (!response.ok) return { state: 'incomplete', message: '结果回读 HTTP ' + response.status };
  const record = await response.json();
  if (record.conversation_id !== conversationId || !record.mapping || !record.current_node) return { state: 'incomplete', message: '会话结果结构不可识别。' };
  const seen = new Set<string>(); let key = record.current_node; let assistant: any = null;
  while (key && !seen.has(key) && seen.size < 10000) {
    seen.add(key); const node = record.mapping[key]; if (!node) break;
    const message = node.message;
    if (!assistant && message?.author?.role === 'assistant' && (!message.channel || message.channel === 'final') && (!message.recipient || message.recipient === 'all')) assistant = message;
    if (message?.author?.role === 'user') {
      if (!request.sentPrompt || !request.userMessageId || message.id !== request.userMessageId || normalize((message.content?.parts ?? []).filter((p: unknown) => typeof p === 'string').join('')) !== normalize(request.sentPrompt)) return { state: 'incomplete', message: '结果不属于本次提交的消息身份/正文。' };
      if (!assistant) return { state: 'pending' };
      if (assistant.metadata?.finish_details?.type === 'interrupted' || assistant.status === 'cancelled') return { state: 'cancelled' };
      if (assistant.status === 'in_progress') return { state: 'pending' };
      const shape=()=>JSON.stringify({status:assistant.status,endTurn:assistant.end_turn,contentType:assistant.content?.content_type,channel:assistant.channel,recipient:assistant.recipient,parts:(assistant.content?.parts??[]).map((part:any)=>typeof part==='string'?{type:'text',length:part.length}:{type:typeof part,contentType:part?.content_type,pointerScheme:typeof part?.asset_pointer==='string'?part.asset_pointer.split('://')[0]:null}),ancestorRoles:[...seen].map(id=>({role:record.mapping[id]?.message?.author?.role,status:record.mapping[id]?.message?.status,endTurn:record.mapping[id]?.message?.end_turn,contentType:record.mapping[id]?.message?.content?.content_type}))});
      if (assistant.status !== 'finished_successfully' || assistant.end_turn !== true) return { state: 'incomplete', message: '未确认完整回复：'+shape() };
      // W01: the readback path accepts the same two verified terminal shapes as the stream path and
      // retains the terminal message for file-handle derivation. Anything else stays incomplete.
      const readbackType = assistant.content?.content_type;
      if (readbackType !== 'text' && readbackType !== 'multimodal_text') return { state: 'incomplete', message: '未确认完整回复内容类型：'+shape() };
      if (!Array.isArray(assistant.content.parts)) return { state: 'incomplete', message: '未确认完整回复。' };
      const text = assistant.content.parts.filter((p: unknown) => typeof p === 'string').join('');
      const readbackExtra = assistant.content.parts.filter((p: unknown) => typeof p !== 'string');
      if (readbackExtra.some((p: any) => !p || typeof p !== 'object' || typeof (p.asset_pointer ?? p.file_id ?? p.file_name ?? p.name) === 'undefined')) return { state: 'incomplete', message: '原生回复包含无法核验的附件块。' };
      request.terminalMessage = assistant;
      return { state: 'completed', text, conversationId, messageId:assistant.id??null, modelSlug: assistant.metadata?.model_slug ?? null };
    }
    key = node.parent;
  }
  return { state: 'incomplete', message: '没有本次请求的消息边界。' };
}

export class ChatgptBackgroundBridge {
  currentRequest() { return this.active ? { requestId: this.active.id, submitted: this.active.submitted } : null; }
  private readonly abandoned = new Map<string,{submitted:'no'|'yes'|'unknown';reason:'owned_tab_closed';at:number}>();
  private readonly runner: ChatgptToolRunner;
  private active: { fingerprint?:string; recoverableCompletion?:boolean; uploads?:{resourceId:string;sha256:string;mime:string;bytes:number;name:string}[]; id: string; submitted: 'no' | 'yes' | 'unknown'; project?: ChatgptProjectTarget } | null = null;
  private readonly threads = new Map<string,ProjectThread>();
  private inspecting = false;
  async thinking(level?:number,model?:string){
    if(this.options.config().transport!=='embedded')throw new BookError('unavailable','思考强度首版仅支持独立页面。');
    if(this.active||this.inspecting)throw new BookError('busy','生成或网页操作期间不能切换思考强度。');
    if(this.warming)await this.warming;
    if(this.active||this.inspecting)throw new BookError('busy','网页操作尚未结束。');
    this.inspecting=true;
    try{if(model){const selected=await this.evaluate('model',{model});if(selected.model!==model)throw Error('主回复模型未确认，不能设置思考强度。');}return await this.evaluate('thinking',level===undefined?{}:{level});}
    catch(error){throw new BookError('unavailable',String(error),{cause:error});}
    finally{this.inspecting=false;}
  }
  async inspectModels(){
    if(this.active||this.inspecting)throw new BookError('busy','活动请求期间不能检查模型菜单。');
    if(this.warming)await this.warming;
    if(this.active||this.inspecting)throw new BookError('busy','网页操作尚未结束。');
    this.inspecting=true;try{return await this.evaluate('models');}finally{this.inspecting=false;}
  }
  async inspectProject(projectId:string) {
    if(!PROJECT_ID.test(projectId))throw new BookError('invalid_input','项目标识无效。');
    if(this.active || this.inspecting)throw new BookError('busy','有活动网页操作，不能切换项目。');
    if(this.warming)await this.warming;
    if(this.active || this.inspecting)throw new BookError('busy','有活动网页操作，不能切换项目。');
    if(this.options.config().transport!=='embedded')throw new BookError('unavailable','项目首版仅支持独立页面，请准备独立登录并选择该来源。');
    this.inspecting=true;
    try{
      const account=(await this.evaluate('account')).account;
      if(!/^[a-f0-9]{64}$/.test(account??''))throw Error('项目账号尚未确认。');
      await this.navigate(false,{projectId});
      const result=await this.evaluate('project',{projectId});
      if(result.projectId!==projectId)throw Error('项目归属不匹配。');
      return {projectId,account,name:result.name||projectId,memory:'unverified' as const};
    }finally{this.inspecting=false;}
  }
  projectThreads(binding:ChatgptProjectBinding|null,scope:import('../contracts/memory-book.js').BookScope) {
    const row=(binding?this.threads.get(this.threadKey({binding,scope,localTurnId:null,nextTurnId:null})):undefined)
      ??[...this.threads.values()].reverse().find(row=>row.scope?.characterId===scope.characterId&&row.scope.pairingId===scope.pairingId&&row.scope.sessionId===scope.sessionId);
    return row?{conversationId:row.conversationId,url:'https://chatgpt.com/c/'+row.conversationId,projectId:row.projectId,projectName:row.binding?.name??(binding?.projectId===row.projectId?binding.name:row.projectId),targetChanged:!binding?.enabled||row.key!==this.threadKey({binding,scope,localTurnId:null,nextTurnId:null})}:null;
  }
  private threadKey(project:ChatgptProjectTarget):string {
    return createHash('sha256').update(JSON.stringify([project.binding.id,project.binding.account,project.binding.projectId,project.scope.characterId,project.scope.pairingId,project.scope.sessionId])).digest('hex');
  }
  private readonly used = new Set<string>();
  private lastSubmission = 0;
  private warming: Promise<void> | null = null;
  private warmDetail = '尚未预热';
  private warmModel: string | undefined;
  private warmProject: ChatgptProjectTarget | undefined;
  /** Prepare only our owned page; no prompt or model request is submitted. */
  async warmup(model?: string, project?: ChatgptProjectTarget): Promise<void> {
    if(this.inspecting)throw new BookError('busy','项目检查期间不能预热。');
    if (this.active) throw new BookError('busy', '有未确认请求，不导航预热。');
    if (this.warming) return this.warming;
    this.warmModel=model ?? this.warmModel;
    this.warmProject=project;
    const mode=project?false:this.options.config().conversationMode !== 'regular';
    this.warmDetail='后台页面预热中';
    this.warming=(async()=>{
      let page: Record<string, any>;
      try { page=await this.evaluate('probe'); }
      catch(error) { if(!lostTaskTab(error))throw error; await this.navigate(mode); page=await this.evaluate('probe'); }
      if(page.generating)throw new BookError('busy','后台页面仍在生成，不预热新对话。');
      const thread=project?this.threads.get(this.threadKey(project)):undefined;
      if(project){
        if(this.options.config().transport!=='embedded'||(await this.evaluate('account')).account!==project.binding.account)throw Error('项目预热账号/来源不匹配。');
        if(!page.ready||page.temporary||!(thread?page.conversationId===thread.conversationId:page.projectId===project.binding.projectId&&!page.hasTurns))await this.navigate(false,{projectId:project.binding.projectId,...(thread?{conversationId:thread.conversationId}:{})});
        const checked=await this.evaluate('project',{projectId:project.binding.projectId,...(thread?{conversationId:thread.conversationId,expectedNode:thread.node}:{})});
        if(checked.projectId!==project.binding.projectId)throw Error('项目预热归属未确认。');
        page=await this.evaluate('probe');
      }else if (!page.ready || page.temporary !== mode || page.hasTurns) { await this.navigate(mode); page=await this.evaluate('probe'); }
      const readyUntil=Date.now()+5000;
      while((!page.ready || page.temporary!==mode) && page.signedIn!==false && Date.now()<readyUntil){
        await new Promise(resolve=>setTimeout(resolve,150));page=await this.evaluate('probe');
      }
      if(!page.ready || page.temporary !== mode)throw new BookError('unavailable','后台页面尚未就绪，请完成所选来源登录。');
      if(this.warmModel)await this.evaluate('model',{model:this.warmModel});
      const thinkingLevel=this.options.config().thinkingLevel;
      if(thinkingLevel!==undefined)await this.evaluate('thinking',{level:thinkingLevel});
      this.warmDetail='后台页面已预热 · '+(project?'角色项目':mode?'临时聊天':'非临时聊天');
    })();
    try { await this.warming; }
    catch(error) { this.warmDetail='预热未完成：'+String(error); throw error; }
    finally { this.warming=null; }
  }
  private resolvedProfile: { requested: string; id: string } | null = null;
  constructor(private readonly options: { config: () => ChatgptWebSourceConfig; runner?: ChatgptToolRunner; pageHost?: ChatgptPageHost; pollMs?: number; intervalMs?: number; receiptPath?: string; prewarm?: boolean }) {
    this.runner = options.runner ?? createNodeToolRunner();
    if (options.receiptPath && existsSync(options.receiptPath)) {
      const saved = JSON.parse(readFileSync(options.receiptPath, 'utf8'));
      if (!Array.isArray(saved.used) || saved.used.some((id: unknown) => typeof id !== 'string')) throw new Error('网页请求回执损坏。');
      for (const id of saved.used) this.used.add(id);
      if (saved.active && (typeof saved.active.id !== 'string' || !['no', 'yes', 'unknown'].includes(saved.active.submitted))) throw new Error('网页活动回执损坏。');
      this.active = saved.active?.submitted === 'no' ? null : saved.active ?? null;
      if(saved.abandoned!==undefined){
        if(!Array.isArray(saved.abandoned)||saved.abandoned.length>256)throw Error('网页失效连接回执损坏。');
        for(const entry of saved.abandoned){if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!entry[1]||!['no','yes','unknown'].includes(entry[1].submitted)||entry[1].reason!=='owned_tab_closed'||!Number.isSafeInteger(entry[1].at))throw Error('网页失效连接回执损坏。');this.abandoned.set(entry[0],entry[1]);this.used.add(entry[0]);}
      }
      if(this.active?.project){validateProjectBinding(this.active.project.binding);validateScope(this.active.project.scope);}
      if(saved.completedResults!==undefined){
        if(!Array.isArray(saved.completedResults)||saved.completedResults.length>256)throw Error('文件完成回执损坏。');
        for(const [id,row] of saved.completedResults){if(typeof id!=='string'||!row||typeof row.fingerprint!=='string'||row.result?.kind!=='completed'||typeof row.result.text!=='string')throw Error('文件完成回执损坏。');this.completedResults.set(id,row);}
      }
      if(saved.threads!==undefined){
        if(!Array.isArray(saved.threads)||saved.threads.length>256)throw Error('项目线程回执损坏。');
        for(const row of saved.threads){
          if(!row || !/^[a-f0-9]{64}$/.test(row.key) || !PROJECT_ID.test(row.projectId) || !CONVERSATION_ID.test(row.conversationId) || !CONVERSATION_ID.test(row.node) || (row.localTurnId!==null && (typeof row.localTurnId!=='string'||row.localTurnId.length>128)) || this.threads.has(row.key))throw Error('项目线程映射损坏。');
          if(row.binding!==undefined||row.scope!==undefined){validateProjectBinding(row.binding);validateScope(row.scope);if(row.projectId!==row.binding.projectId||row.key!==this.threadKey({binding:row.binding,scope:row.scope,localTurnId:null,nextTurnId:null}))throw Error('项目线程作用域损坏。');}
          this.threads.set(row.key,row);
        }
      }
    }
  }
  private save() {
    if (!this.options.receiptPath) return;
    const temporary = this.options.receiptPath + '.pending';
    writeFileSync(temporary, JSON.stringify({ used: [...this.used], active: this.active, abandoned:[...this.abandoned.entries()], completedResults:[...this.completedResults.entries()], threads:[...this.threads.values()] }) + '\n', { mode: 0o600 });
    replaceResourceFile(temporary, this.options.receiptPath);
  }
  private async args() {
    const config = this.options.config();
    // --browser selects a live extension profile; --profile could provision a launched browser.
    let profile = config.profile;
    if (['auto', 'relay'].includes(profile)) {
      if (this.resolvedProfile?.requested === profile) profile = this.resolvedProfile.id;
      else {
        const run = await this.runner('chrome-use', ['browsers', '--json'], { binDir: config.binDir, timeoutMs: 10000 });
        if (run.exitCode !== 0 || run.timedOut) throw new Error('无法发现已有浏览器连接，不启动新浏览器。');
        const value = JSON.parse(run.stdout);
        const browsers = value.data?.browsers?.filter((b: any) => b.connected && b.default && typeof b.id === 'string');
        if (!Array.isArray(browsers) || browsers.length !== 1) throw new Error('没有唯一已连接的默认浏览器，不启动新浏览器。');
        this.resolvedProfile = { requested: profile, id: browsers[0].id };
        profile = browsers[0].id;
      }
    }
    return ['--browser', profile, '--window', 'user', '--session', config.session];
  }
  private async run(args: string[]) {
    const run = await this.runner('chrome-use', [...await this.args(), ...args], { binDir: this.options.config().binDir, timeoutMs: 20000 });
    if (run.exitCode !== 0 || run.timedOut) throw new Error('后台网页命令失败：' + (run.stderr.trim() || 'exit=' + run.exitCode));
    return run.stdout;
  }
  private async evaluate(action: string, input: Parameters<typeof pageAction>[1] = {}): Promise<Record<string, any>> {
    if (this.options.config().transport !== 'cli') {
      if (!this.options.pageHost) throw new Error('未装配 Chat bridge 页面端口；不会自动启动 CLI。');
      return this.options.pageHost.execute(action, input);
    }
    const call = '(' + pageAction.toString() + ')(' + JSON.stringify(action) + ',' + JSON.stringify(input) + ',(' + consumeChatgptStreamEvent.toString() + '))';
    const output = await this.run(['eval', '/*aiki:' + action + '*/(async () => JSON.stringify(await ' + call + '))()']);
    // chrome-use may wrap JS strings and may prefix the page origin. Only parse a complete object.
    for (const line of output.trim().split(/\r?\n/).reverse()) {
      const candidate = line.replace(/^eval @ /, '');
      try { let value = JSON.parse(candidate); if (typeof value === 'string') value = JSON.parse(value); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* another CLI output line */ }
    }
    throw new Error('后台网页未返回可识别的动作结果。');
  }
  private async navigate(temporary: boolean, project?: ChatgptPageDestination): Promise<void> {
    if (this.options.config().transport !== 'cli') {
      if (!this.options.pageHost) throw new Error('未装配 Chat bridge 页面端口；不会自动启动 CLI。');
      await this.options.pageHost.navigate(temporary,project);
    }
    else { if(project)throw Error('项目路由仅支持独立页面。');await this.run(['open', temporary ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/']); }
  }
  async probe(): Promise<ChatgptWebProbe> {
    const checkedAt = new Date().toISOString();
    try { const result = await this.evaluate('probe'); return { state: result.ready ? 'signed-in' : 'signed-out', checkedAt, ...(this.active ? { activeRequest: { requestId: this.active.id, submitted: this.active.submitted } } : {}), detail: this.active ? '请求 ' + this.active.id + ' 尚未确认结束，请接续读取或确认停止。' : this.warmDetail }; }
    catch (error) { return { state: 'not-connected', checkedAt, ...(this.active ? { activeRequest: { requestId: this.active.id, submitted: this.active.submitted } } : {}), detail: String(error) }; }
  }
  /**
   * W01: what this source can actually do, from the transport we are really on. Only the embedded
   * page host carries the artifact adapter; extension/CLI report `unavailable` and are never silently
   * treated as if they could receive files or take images.
   */
  private generatedImages: 'available' | 'unavailable' | 'unknown' = 'unknown';
  noteGeneratedImages(value: 'available' | 'unavailable') { this.generatedImages = value; }
  capabilities(): ChatgptSourceCapabilities {
    const transport = this.options.config().transport;
    const outputImages = this.generatedImages;
    if (transport === 'embedded' && this.options.pageHost) return { outputFiles: 'available', inputImages: 'available', outputImages };
    if (transport === 'embedded') return { outputFiles: 'unavailable', inputImages: 'unavailable', outputImages: 'unavailable', reason: '未装配独立页面端口。' };
    return { outputFiles: 'unavailable', inputImages: 'unavailable', outputImages: 'unavailable', reason: '文件接收与图片输入首版仅支持独立页面来源。' };
  }
  /** W01: the file candidates of the CURRENT verified terminal message. Never derived from display text. */
  private readonly completedResults = new Map<string,{sourceSignature?:string;projectId?:string|null;fingerprint:string;result:Extract<ChatgptWebAskResult,{kind:'completed'}>}>();
  private completedArtifactRequest:string|null=null;
  private artifactReaders=0;
  forgetCompleted(requestIds:string[]):void{for(const id of requestIds)this.completedResults.delete(id);this.save();}
  private captureArtifacts=false;
  async listArtifacts(id: string, options?: { includeGenerated?: boolean }): Promise<{ messageId: string; artifacts: { handleId: string; nameHint: string; mimeHint?: string }[]; discovery: 'complete' | 'failed'; error?: { code: string; message: string } }> {
    if (this.completedArtifactRequest !== id) throw new Error('文件所属网页请求已失效，不能读取其他消息。');
    const probe = options?.includeGenerated ? { id, includeGenerated: true } : { id };
    let result:Record<string,any>;
    try{result=await this.evaluateArtifact('artifacts',probe);}catch(error){
      const saved=this.completedResults.get(id)?.result;
      if(!saved?.conversationId||!saved.messageId)throw error;
      await this.evaluateArtifact('recover-artifacts',{id,conversationId:saved.conversationId,expectedNode:saved.messageId,expectedTextHash:createHash('sha256').update(saved.text).digest('hex')});
      result=await this.evaluateArtifact('artifacts',probe);
    }
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts.filter((row: any) => row && typeof row.handleId === 'string' && typeof row.nameHint === 'string') : [];
    return { messageId: String(result.messageId ?? ''), artifacts, discovery: result.discovery === 'complete' ? 'complete' : 'failed', ...(result.error ? { error: { code: String(result.error.code ?? 'unverified_identity'), message: String(result.error.message ?? '') } } : {}) };
  }
  /**
   * W01: read the verified bytes of one candidate. Chunked, bounded, and always closes the page-side
   * handle — a failed read must not leave a buffer alive in the page.
   */
  async readArtifact(candidate: { requestId?:string; includeGenerated?: boolean; projectId?:string|null; messageId?:string; handleId: string; nameHint: string; mimeHint?: string }, signal: AbortSignal): Promise<Uint8Array> {
    const id = candidate.requestId ?? this.completedArtifactRequest;
    if (!id) throw new Error('网页请求身份丢失；提交状态未知，不得自动重发。');
    signal.throwIfAborted();
    if(this.active||this.warming)throw new Error('网页来源正忙，文件读取未开始。');
    this.artifactReaders++;
    try {
      const saved=this.completedResults.get(id);
      if(saved?.sourceSignature&&saved.sourceSignature!==createHash('sha256').update(JSON.stringify(this.options.config())).digest('hex'))throw Error('文件来源设置已变化，未下载。');
      if(saved&&candidate.projectId!==undefined&&(saved.projectId??null)!==candidate.projectId)throw Error('文件来源项目绑定已变化，未下载。');
      const receipt=saved?.result;
      let nativeIdentity:Record<string,any>|undefined;
      const probe=candidate.includeGenerated?{id,includeGenerated:true}:{id};
      try{nativeIdentity=await this.evaluateArtifact('artifacts',probe);}catch(error){
        if(!receipt?.messageId||!receipt.conversationId)throw error;
        if(receipt.messageId!==candidate.messageId)throw Error('文件身份与完成回执不匹配。');
        await this.evaluateArtifact('recover-artifacts',{id,conversationId:receipt.conversationId,expectedNode:receipt.messageId,expectedTextHash:createHash('sha256').update(receipt.text).digest('hex')});
        nativeIdentity=await this.evaluateArtifact('artifacts',probe);
      }
      if(candidate.messageId&&nativeIdentity.messageId!==candidate.messageId)throw Error('文件不属于已持久化的终态消息。');
      const opened = await this.evaluateArtifact('open-file', { id, handleId: candidate.handleId });
      const total = Number(opened.bytes ?? 0);
      if (!Number.isSafeInteger(total) || total <= 0) throw new Error('文件为空或长度不可确认，未接收。');
      if (total > RESOURCE_LIMITS.imageBytes) throw new Error('文件超过 16 MiB 上限，未接收。');
      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (offset < total) {
        signal.throwIfAborted();
        const length = Math.min(RESOURCE_LIMITS.chunkBytes, total - offset);
        const part = await this.evaluateArtifact('read-chunk', { id, handleId: candidate.handleId, offset, length });
        const data = typeof part.data === 'string' ? part.data : '';
        if (!data) throw new Error('文件分块读取为空，未接收。');
        const binary = Buffer.from(data, 'base64');
        chunks.push(new Uint8Array(binary));
        offset += binary.byteLength;
        if (binary.byteLength === 0) throw new Error('文件分块读取没有前进，未接收。');
      }
      const merged = new Uint8Array(offset);
      let cursor = 0;
      for (const chunk of chunks) { merged.set(chunk, cursor); cursor += chunk.byteLength; }
      return merged;
    } finally {
      try {
        await this.evaluateArtifact('close-file', { id, handleId: candidate.handleId }).catch(error => {
          process.stderr.write(`Artifact handle cleanup failed: ${String(error)}\n`);
        });
      } finally { this.artifactReaders--; }
    }
  }
  /**
   * W01: actually upload one image into the composer's real file input, in bounded chunks, and prove
   * the page accepted it. The caller must await this BEFORE submitting, so the native POST carries the
   * image as a real attachment instead of a filename in the prompt.
   */
  async uploadImage(image: { resourceId: string; sha256: string; mime: string; bytes: Uint8Array }, signal: AbortSignal): Promise<{ attached: true; name: string; mime: string; bytes: number }> {
    const id = this.active?.id;
    if (!id) throw new Error('网页请求身份丢失；提交状态未知，不得自动重发。');
    const capability = this.capabilities();
    if (capability.inputImages !== 'available') throw new BookError('unavailable', capability.reason ?? '当前来源不支持图片输入，未发送。');
    signal.throwIfAborted();
    const name = `${image.resourceId.slice(0, 48)}.${image.mime === 'image/png' ? 'png' : image.mime === 'image/jpeg' ? 'jpg' : 'webp'}`;
    const slot = `${id}-${image.sha256.slice(0, 16)}`;
    for (let offset = 0; offset < image.bytes.byteLength; offset += RESOURCE_LIMITS.chunkBytes) {
      signal.throwIfAborted();
      const slice = image.bytes.subarray(offset, Math.min(offset + RESOURCE_LIMITS.chunkBytes, image.bytes.byteLength));
      await this.evaluateArtifact('upload-image', { id, slot, name, mime: image.mime, data: Buffer.from(slice).toString('base64') });
    }
    const result = await this.evaluateArtifact('upload-image', { id, slot, name, mime: image.mime, done: true });
    if (result.attached !== true) throw new Error('页面没有确认图片附件，未提交。');
    return { attached: true, name: String(result.name ?? name), mime: String(result.mime ?? image.mime), bytes: Number(result.bytes ?? image.bytes.byteLength) };
  }
  /** W01 artifact actions go through the same closed host port, with their own validated script body. */
  private async evaluateArtifact(action: string, input: ChatgptArtifactInput): Promise<Record<string, any>> {
    if (this.options.config().transport !== 'cli') {
      if (!this.options.pageHost) throw new Error('未装配 Chat bridge 页面端口；不会自动启动 CLI。');
      return this.options.pageHost.execute(action, input as ChatgptPageInput);
    }
    const call = '(' + currentArtifactAction.toString() + ')(' + JSON.stringify(action) + ',' + JSON.stringify(input) + ')';
    const output = await this.run(['eval', '/*aiki:' + action + '*/(async () => JSON.stringify(await ' + call + '))()']);
    for (const line of output.trim().split(/\r?\n/).reverse()) {
      const candidate = line.replace(/^eval @ /, '');
      try { let value = JSON.parse(candidate); if (typeof value === 'string') value = JSON.parse(value); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* another CLI output line */ }
    }
    throw new Error('后台网页未返回可识别的文件操作结果。');
  }
  async openLoginPage(options: { standalone?: boolean } = {}) {
    if (options.standalone) throw new BookError('unavailable', 'MVP 不允许打开独立浏览器窗口。');
    if (this.active) throw new BookError('busy', '已有未确认结束的网页请求，不能导航。');
    if (this.options.pageHost && this.options.config().transport !== 'cli') { await this.options.pageHost.login(); return; }
    await this.navigate(true);
    const result = await this.evaluate('probe');
    if (!result.ready) throw new BookError('unavailable', '尚未登录。当前后台路径不能在 AIKI 内完成首次登录；不会弹出外部窗口。');
  }
  private async poll(id: string, timeoutMs: number, signal?: AbortSignal): Promise<ChatgptWebAskResult> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if(this.active?.id!==id)return {kind:'cancelled',confirmed:false,message:'本地请求已结束占用，不读取或重发旧请求。',durationMs:Date.now()-start};
      if (signal?.aborted) {
        await this.evaluate('cancel', { id });
        const state = await this.evaluate('read', { id });
        const confirmed = state.state === 'cancelled' || state.state === 'completed';
        if (confirmed) { this.active = null; this.save(); }
        return { kind: 'cancelled', confirmed, message: confirmed ? '远端已结束，迟到结果丢弃。' : '停止未确认，来源保持占用。', durationMs: Date.now() - start };
      }
      const result = await this.evaluate('read', { id,...(this.captureArtifacts||this.active?.recoverableCompletion?{includeGenerated:true}:{}) });
      if(this.active?.id!==id)return {kind:'cancelled',confirmed:false,message:'旧请求的迟到结果已隔离，不覆盖当前连接。',durationMs:Date.now()-start};
      if (result.state === 'not_submitted') {
        this.active = null; this.save();
        return { kind: 'failed', code: 'not_submitted', submitted: 'no', message: result.message, durationMs: Date.now() - start };
      }
      if (result.state === 'cancelled') {
        this.active = null; this.save();
        return { kind: 'cancelled', confirmed: true, message: '远端回读确认生成中断。', durationMs: Date.now() - start };
      }
      if (result.state === 'completed' && typeof result.text === 'string' && (result.text.trim()||(this.captureArtifacts||this.active?.recoverableCompletion)&&typeof result.messageId==='string'&&result.messageId)) {
        if(this.active?.project){
          const target=this.active.project;
          if(!CONVERSATION_ID.test(result.conversationId??'')||!CONVERSATION_ID.test(result.messageId??''))return {kind:'failed',code:'incomplete',submitted:'yes',message:'项目回复缺少线程或终态身份，保留回执，不重发。',durationMs:Date.now()-start};
          const record=await this.evaluate('project',{projectId:target.binding.projectId,conversationId:result.conversationId,expectedNode:result.messageId});
          if(record.projectId!==target.binding.projectId||record.conversationId!==result.conversationId||record.currentNode!==result.messageId)throw Error('完成回复的项目归属不匹配。');
          this.threads.set(this.threadKey(target),{key:this.threadKey(target),projectId:target.binding.projectId,conversationId:result.conversationId,node:result.messageId,localTurnId:target.nextTurnId,binding:structuredClone(target.binding),scope:structuredClone(target.scope)});
        }
        this.completedArtifactRequest=id;
        const completed: Extract<ChatgptWebAskResult,{kind:'completed'}> = { kind: 'completed', text: result.text, conversationId: result.conversationId ?? null, durationMs: Date.now() - start, messageId: result.messageId ?? null, modelSlug: result.modelSlug ?? null, ...(this.active?.uploads?.length?{uploads:structuredClone(this.active.uploads)}:{}) };
        if(this.active?.recoverableCompletion&&this.active.fingerprint){this.completedResults.set(id,{projectId:this.active.project?.binding.projectId??null,sourceSignature:createHash('sha256').update(JSON.stringify(this.options.config())).digest('hex'),fingerprint:this.active.fingerprint,result:completed});if(this.completedResults.size>256)this.completedResults.delete(this.completedResults.keys().next().value!);}
        this.active = null; this.save();
        if(!this.captureArtifacts&&this.options.prewarm)void this.warmup(undefined,this.warmProject).catch(error=>process.stderr.write('Chat page warmup: '+String(error)+'\n'));
        return completed;
      }
      if (result.state !== 'pending') return { kind: 'failed', code: 'incomplete', submitted: 'yes', message: result.message ?? '生成未完整结束，不重发。', durationMs: Date.now() - start };
      await new Promise(r => setTimeout(r, this.options.pollMs ?? 500));
    }
    return { kind: 'failed', code: 'timeout', submitted: 'unknown', message: '等待超时；请接续读取，不得自动重发。', durationMs: Date.now() - start };
  }
  async ask(input: ChatgptWebAskOptions): Promise<ChatgptWebAskResult> {
    const start = Date.now();
    const failed = (code: 'busy' | 'duplicate' | 'failed' | 'submit_unknown', message: string, submitted: 'no' | 'yes' | 'unknown'): ChatgptWebAskResult => ({ kind: 'failed', code, message, submitted, durationMs: Date.now() - start });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.requestId)) throw new BookError('invalid_input', 'requestId 无效。');
    if(this.warming)try{await this.warming;}catch(error){return failed('failed','后台预热未完成：'+String(error),'no');}
    if(this.artifactReaders)return failed('busy','正在读取已完成回复的文件。','no');
    if (this.active) return failed('busy', '网页来源有未确认结束的请求。', 'no');
    if(this.inspecting)return failed('busy','项目检查尚未结束。','no');
    const fingerprint=createHash('sha256').update(JSON.stringify({config:this.options.config(),prompt:input.prompt,context:input.context,model:input.model,temporary:input.temporary,project:input.project,...(input.taskArchive?{taskArchiveSha256:input.taskArchive.sha256}:{}),images:input.images?.map(({resourceId,sha256,mime})=>({resourceId,sha256,mime}))})).digest('hex');
    const completed=this.completedResults.get(input.requestId);
    if(input.recoverableCompletion&&completed){if(completed.fingerprint!==fingerprint)return failed('duplicate','同一轮完成回执的输入或来源已变化，不重发。','yes');this.completedArtifactRequest=input.requestId;return structuredClone(completed.result);}
    if (this.used.has(input.requestId)) return failed('duplicate', '请求 ID 已使用，不得重发。', 'unknown');
    if (this.used.size >= 10000) throw new BookError('budget', '网页请求回执数量达到上限，需要人工归档。');
    if (this.options.config().submitMechanism === 'token') return failed('failed', '内部 token 路径尚未通过真实验证，MVP 不启用。', 'no');
    if(input.project){
      validateProjectBinding(input.project.binding);validateScope(input.project.scope);
      if(this.options.config().transport!=='embedded'||input.temporary||!input.project.binding.enabled||input.project.binding.characterId!==input.project.scope.characterId||input.project.binding.pairingId!==input.project.scope.pairingId)return failed('failed','项目来源、实例或模式不匹配，未发送。','no');
      if(this.threads.size>=256&&!this.threads.has(this.threadKey(input.project)))return failed('failed','项目线程数量达到256，需要显式整理，不丢弃旧映射。','no');
    }
    this.captureArtifacts=input.captureArtifacts===true;
    this.active = { id: input.requestId, submitted: 'no', fingerprint, recoverableCompletion:input.recoverableCompletion===true, ...(input.project?{project:structuredClone(input.project)}:{}) }; this.used.add(input.requestId); this.save();
    let phaseStarted=Date.now();
    const phase=(name:string)=>{const now=Date.now();process.stderr.write(JSON.stringify({diagnostic:'chat-page-timing',requestId:input.requestId,phase:name,phaseMs:now-phaseStarted,totalMs:now-start})+'\n');phaseStarted=now;};
    try {
      input.signal?.throwIfAborted();
      await new Promise(r => setTimeout(r, Math.max(0, (this.options.intervalMs ?? 4000) - (Date.now() - this.lastSubmission))));
      input.signal?.throwIfAborted();
      let page: Record<string, any>;
      try { page = await this.evaluate('probe'); }
      catch (error) {
        // There has been no submit call for this request. Re-open only our known
        // destination, never adopt another user's tab or retry an uncertain send.
        if (!lostTaskTab(error)) throw error;
        await this.navigate(Boolean(input.temporary));
        page = await this.evaluate('probe');
      }
      if (page.generating) throw new BookError('busy', '本任务页面仍在生成，不能导航或提交。');
      const thread=input.project?this.threads.get(this.threadKey(input.project)):undefined;
      let projectInput:ChatgptPageInput={};
      if(input.project){
        if((await this.evaluate('account')).account!==input.project.binding.account)throw Error('当前账号与项目绑定不同，未发送。');
        if(!thread&&input.project.localTurnId!==null)throw Error('此会话没有当前项目的已确认线程；请新建会话，不会把旧历史迁入新项目。');
        if(thread && thread.localTurnId!==input.project.localTurnId)throw Error('本地与网页会话边界不一致，请新建会话，不能自动续接。');
        if(!page.ready||page.temporary||!(thread?page.conversationId===thread.conversationId:page.projectId===input.project.binding.projectId&&!page.hasTurns))await this.navigate(false,{projectId:input.project.binding.projectId,...(thread?{conversationId:thread.conversationId}:{})});
        projectInput={projectId:input.project.binding.projectId,...(thread?{conversationId:thread.conversationId,expectedNode:thread.node}:{})};
        const checked=await this.evaluate('project',projectInput);
        if(checked.projectId!==input.project.binding.projectId||(thread && (checked.conversationId!==thread.conversationId||checked.currentNode!==thread.node)))throw Error('项目页面或线程边界不匹配，未发送。');
      }else{
        const reuse = page.ready === true && page.temporary === Boolean(input.temporary) && page.hasTurns === false && !input.images?.length;
        if (!reuse) await this.navigate(Boolean(input.temporary));
      }
      const prepared = await this.evaluate('prepare', { id: input.requestId, temporary: Boolean(input.temporary),...projectInput });
      if (prepared.ready !== true || (input.temporary && prepared.temporary !== true)) throw new Error('网页或临时聊天未确认就绪，未提交。');
      const model = input.model?.trim() ?? 'current';
      this.warmModel=model;
      this.warmProject=input.project;
      const selected = await this.evaluate('model', { model });
      if (selected.model !== model) throw new Error('选定模型未确认。');
      const thinkingLevel=this.options.config().thinkingLevel;
      let thinkingProof:{level:number;label:string}|undefined;
      if(input.requiredThinking==='high'){
        const inspected=await this.evaluate('thinking',{});
        const high=(inspected.options??[]).filter((option:any)=>isHighThinkingLabel(option.label));
        if(high.length!==1)throw Error('未找到唯一可核验的High思考选项，未提交。实际选项：'+JSON.stringify(inspected.options??[]));
        const chosen=await this.evaluate('thinking',{level:high[0].level});
        if(chosen.level!==high[0].level||!isHighThinkingLabel(chosen.label))throw Error('High思考强度未确认，未提交。');
        thinkingProof={level:chosen.level,label:chosen.label};
      }else if(thinkingLevel!==undefined){const chosen=await this.evaluate('thinking',{level:thinkingLevel});if(chosen.level!==thinkingLevel)throw Error('思考强度未确认，未提交。');}
      phase('page-ready');
      const context=thread?input.continuationContext:input.context;
      const text = context !== undefined ? context + '\n\n[当前任务]\n' + input.prompt : input.prompt;
      // W01: images are attached through the page's real file input BEFORE the prompt is written, so
      // the native POST carries an actual image part. A page that does not confirm the attachment
      // aborts here — before `submit` — and therefore never sends a half-declared request.
      const uploads: NonNullable<Extract<ChatgptWebAskResult, { kind: 'completed' }>['uploads']> = [];
      // The legacy action name uploads bytes through the native file input; keep ZIP MIME/name.
      if(input.taskArchive){
        const file=input.taskArchive;
        if(this.options.config().transport!=='embedded'||this.capabilities().inputImages!=='available')throw new BookError('unavailable','Wiki任务附件需要独立页面来源，未发送。');
        if(file.bytes.byteLength>1024*1024||createHash('sha256').update(file.bytes).digest('hex')!==file.sha256)throw new BookError('invalid_input','Wiki任务附件哈希或大小无效，未发送。');
        const slot=input.requestId+'-wiki-task',name='ALLMIND-Wiki-Task.zip',mime='application/zip';
        for(let offset=0;offset<file.bytes.byteLength;offset+=RESOURCE_LIMITS.chunkBytes){input.signal?.throwIfAborted();await this.evaluateArtifact('upload-image',{id:input.requestId,slot,name,mime,data:Buffer.from(file.bytes.subarray(offset,offset+RESOURCE_LIMITS.chunkBytes)).toString('base64')});}
        const attached=await this.evaluateArtifact('upload-image',{id:input.requestId,slot,name,mime,done:true});
        if(attached.attached!==true||attached.bytes!==file.bytes.byteLength||attached.name!==name)throw Error('Wiki任务附件未确认上传，未提交。');
        uploads.push({resourceId:'wiki-task',sha256:file.sha256,mime,bytes:file.bytes.byteLength,name});
      }
      if (input.images?.length) {
        const capability = this.capabilities();
        if (capability.inputImages !== 'available') throw new BookError('unavailable', capability.reason ?? '当前来源不支持图片输入，未发送。');
        if (input.images.length > 8) throw new BookError('invalid_input', '单轮图片数量超过上限，未发送。');
        let totalBytes = 0;
        for (const image of input.images) {
          input.signal?.throwIfAborted();
          totalBytes += image.bytes.byteLength;
          if (totalBytes > RESOURCE_LIMITS.imagesPerTurnBytes) throw new BookError('budget', '本轮图片总量超过 32 MiB 上限，未发送。');
          const receipt = await this.uploadImage(image, input.signal ?? new AbortController().signal);
          uploads.push({ resourceId: image.resourceId, sha256: image.sha256, mime: receipt.mime, bytes: receipt.bytes, name: receipt.name });
        }
      }
      if(thinkingProof){const verified=await this.evaluate('thinking',{level:thinkingProof.level});if(verified.level!==thinkingProof.level||verified.label!==thinkingProof.label)throw Error('附件准备后High状态变化，未提交。');}
      input.onPrepared?.({requestId:input.requestId,...(thinkingProof?{thinking:thinkingProof}:{}),...(input.taskArchive?{taskArchiveSha256:input.taskArchive.sha256}:{})});
      // Keep each argv well under Windows's limit; include the complete ordered prompt.
      const chars = Array.from(text);
      for (let offset = 0; offset < chars.length; offset += 1500) { input.signal?.throwIfAborted(); await this.evaluate('write', { id: input.requestId, text: chars.slice(offset, offset + 1500).join('') }); }
      input.signal?.throwIfAborted();
      this.active.uploads=uploads;
      this.active.submitted = 'unknown'; this.save(); // persist BEFORE the side-effecting tool call
      const submit = await this.evaluate('submit', { id: input.requestId });
      if (submit.submitted !== true) throw new Error('提交结果未知。');
      this.active.submitted = 'yes'; this.lastSubmission = Date.now(); this.save();
      phase('submitted');
      const result=await this.poll(input.requestId, Math.max(1, input.timeoutMs - (Date.now() - start)), input.signal);
      phase(result.kind);
      // W01: the terminal message identity and the upload receipts travel with the completed result.
      return result.kind === 'completed' ? { ...result, ...(uploads.length ? { uploads } : {}) } : result;
    } catch (error) {
      let submitted = this.active?.submitted ?? 'unknown';
      let message = String(error);
      if (submitted === 'unknown') {
        try { const state = await this.evaluate('submission', { id: input.requestId }); if (state.submitted === false) submitted = 'no'; }
        catch (readError) { message += '；提交边界核对失败：' + String(readError); }
      }
      if (submitted === 'no') { this.active = null; this.save(); }
      return failed(submitted === 'no' ? 'failed' : 'submit_unknown', message + (submitted !== 'no' ? '；不得自动重发，请接续读取。' : ''), submitted);
    }
  }
  async resume(id: string, timeoutMs: number) {
    const saved=this.completedResults.get(id);
    if(saved){if(saved.sourceSignature&&saved.sourceSignature!==createHash('sha256').update(JSON.stringify(this.options.config())).digest('hex'))throw new BookError('conflict','完成回执的网页来源已变化。');this.completedArtifactRequest=id;return structuredClone(saved.result);}
    if (!this.active || this.active.id !== id) throw new BookError('not_found', '没有可接续的活动网页回执。');
    try{return await this.poll(id, timeoutMs);}catch(error){
      if(this.options.config().transport==='bridge'&&/^(?:Error:\s*)*No tab with id:\s*\d+\.?\s*$/i.test(String(error)))throw new BookError('unavailable','原配对 Chrome 标签页已关闭（No tab）。点击“停止并核对结果”结束本地占用，或绑定已就绪的独立页面；旧请求不会自动重发。',{cause:error});
      throw new BookError('unavailable','无法接续旧网页请求，回执已保留：'+String(error),{cause:error});
    }
  }
  async cancel(id: string): Promise<ChatgptWebAskResult> {
    if (!this.active || this.active.id !== id) throw new BookError('not_found', '没有当前活动网页回执。');
    let submission:Record<string,any>;
    try{submission=await this.evaluate('submission',{id});}catch(error){
      if(this.options.config().transport==='bridge'&&/^(?:Error:\s*)*No tab with id:\s*\d+\.?\s*$/i.test(String(error))){
        if(this.active?.id!==id)throw new BookError('conflict','活动请求已变化，请回读。');
        this.abandoned.set(id,{submitted:this.active.submitted,reason:'owned_tab_closed',at:Date.now()});
        if(this.abandoned.size>256)this.abandoned.delete(this.abandoned.keys().next().value!);
        this.active=null;this.save();
        return {kind:'cancelled',confirmed:false,message:'原配对标签页已关闭，已结束其本地占用。旧请求的远端结果未知，编号已保留且不会重发；现在可以绑定独立页面或重新配对。',durationMs:0};
      }
      // An explicit cancellation may abandon an orphan after its owned host was restarted.
      // Require a proven empty idle page; do not cancel/adopt a different live conversation.
      if(!String(error).includes('页面请求身份丢失'))throw new BookError('unavailable','无法核对旧网页请求，尚未释放连接：'+String(error),{cause:error});
      const page=await this.evaluate('probe');
      if(page.ready!==true||page.generating!==false||page.hasTurns!==false)throw error;
      this.active=null;this.save();
      return{kind:'cancelled',confirmed:false,message:'已取消本地孤立任务并释放空闲页面；远端结果未确认，该请求编号保留且不会重发。',durationMs:0};
    }
    if (submission.submitted === false) { this.active = null; this.save(); return { kind: 'cancelled', confirmed: true, message: '页面确认从未提交。', durationMs: 0 }; }
    await this.evaluate('cancel', { id });
    const state = await this.evaluate('read', { id });
    const confirmed = state.state === 'cancelled' || state.state === 'completed';
    if (confirmed) { this.active = null; this.save(); }
    return { kind: 'cancelled', confirmed, message: confirmed ? '远端已结束。' : '停止未确认，不能释放来源。', durationMs: 0 };
  }
  requestStatus(id: string) { const abandoned=this.abandoned.get(id);return abandoned?{state:'abandoned',submitted:abandoned.submitted,outcome:'unknown',reason:abandoned.reason}:this.active?.id === id ? { state: 'pending', submitted: this.active.submitted, outcome: null } : this.used.has(id) ? { state: 'finished', submitted: 'yes' as const, outcome: null } : null; }
}

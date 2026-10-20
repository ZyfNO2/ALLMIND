import { chatgptPageScript } from '../../dist/providers/chatgpt-background-bridge.js';
import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const partition = 'persist:aiki-chatgpt-user';
const chatUrl = (temporary, project) => {
  if (!project) return 'https://chatgpt.com/' + (temporary ? '?temporary-chat=true' : '');
  if (temporary || typeof project !== 'object' || Object.keys(project).some(key=>!['projectId','conversationId'].includes(key)) || !/^g-p-[a-f0-9]{32}$/.test(project.projectId) || project.conversationId!==undefined && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(project.conversationId)) throw Error('项目导航参数无效。');
  return project.conversationId ? 'https://chatgpt.com/c/'+project.conversationId : 'https://chatgpt.com/g/'+project.projectId+'/project';
};
const chatOrigin = url => { try { return new URL(url).origin === 'https://chatgpt.com'; } catch { return false; } };
const loginDestination = url => {
  try { const u = new URL(url); return u.protocol === 'https:' && ['chatgpt.com', 'auth.openai.com', 'auth0.openai.com', 'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com'].includes(u.hostname); }
  catch { return false; }
};

/** In-process, browser-owned authentication. No CDP, CLI, shell or credential export. */
export function createChatgptPageHost({ BrowserWindow, getParent, accountFile }) {
  let page = null, signingIn = false, navigating = null, loginTimer = null, loadFailure = null;
  let account = accountFile && existsSync(accountFile) ? JSON.parse(readFileSync(accountFile,'utf8')).account : null;
  if(account!==null && !/^[a-f0-9]{64}$/.test(account))throw Error('独立页面账号绑定损坏。');
  const confirmAccount = async target => {
    const result=await target.webContents.executeJavaScript(chatgptPageScript('account'));
    if(!/^[a-f0-9]{64}$/.test(result?.account ?? ''))throw Error('独立页面没有确认登录账号。');
    if(account && account!==result.account)throw Error('独立页面账号与已绑定账号不同，未发送。请恢复原账号。');
    if(!account){account=result.account;if(accountFile)writeFileSync(accountFile,JSON.stringify({account})+'\n',{mode:0o600});}
    return result.account;
  };
  const popups = new Set();
  const preferences = { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false, backgroundThrottling: false };
  const conceal = () => {
    signingIn = false; page?.hide();
    for (const popup of popups) if (!popup.isDestroyed()) popup.close();
    if (loginTimer) clearInterval(loginTimer); loginTimer = null;
  };
  const ensure = () => {
    if (page && !page.isDestroyed()) return page;
    page = new BrowserWindow({ title: 'ALLMIND · ChatGPT 登录', show: false, skipTaskbar: true, width: 980, height: 760, autoHideMenuBar: true, parent: getParent(), webPreferences: preferences });
    page.setMenu(null);
    page.webContents.setWindowOpenHandler(({ url }) => signingIn && loginDestination(url)
      ? { action: 'allow', overrideBrowserWindowOptions: { parent: page, skipTaskbar: true, autoHideMenuBar: true, webPreferences: preferences } }
      : { action: 'deny' });
    page.webContents.on('did-create-window', child => { popups.add(child); child.setMenu(null); child.once('closed', () => popups.delete(child)); });
    page.webContents.on('will-navigate', (event, url) => { if (!loginDestination(url)) event.preventDefault(); });
    page.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) loadFailure = new Error('ChatGPT 页面加载失败：' + description + ' (' + code + ')；请重新打开登录窗口重试。');
    });
    page.webContents.on('did-finish-load', () => { loadFailure = null; });
    page.on('close', event => { event.preventDefault(); conceal(); });
    return page;
  };
  const navigate = async (temporary, project) => {
    if (signingIn) throw new Error('请先在 ALLMIND 登录面板完成登录。');
    const target = ensure();
    // Fixed destination only; no URL can be supplied by the management renderer.
    loadFailure = null;
    navigating = target.loadURL(chatUrl(temporary,project));
    try { await navigating; } catch(error) { loadFailure = error; throw error; } finally { navigating = null; }
  };
  const execute = async (action, input = {}) => {
    // Opt-in development reload of this fixed local adapter, never supplied scripts/URLs.
    const moduleUrl=new URL('../../dist/providers/chatgpt-background-bridge.js',import.meta.url);
    const scriptFactory=process.env.AIKI_CHAT_ADAPTER_RELOAD==='1'?(await import(moduleUrl.href+'?revision='+statSync(fileURLToPath(moduleUrl)).mtimeMs)).chatgptPageScript:chatgptPageScript;
    const script = scriptFactory(action, input); // validates closed actions/fields
    const target = ensure();
    if (!target.webContents.getURL()) await navigate(true);
    if (navigating) await navigating;
    if (loadFailure) throw new Error('ChatGPT 页面未加载成功：' + loadFailure.message + '；请重新打开登录窗口。');
    if (signingIn && action !== 'probe') throw new Error('请先完成 ALLMIND 内的登录。');
    if (!chatOrigin(target.webContents.getURL())) {
      if (action === 'probe') return { ready: false, temporary: false, generating: false, hasTurns: false };
      throw new Error('ChatGPT 需要在 ALLMIND 内重新登录。');
    }
    if(action==='probe'){
      const result=await target.webContents.executeJavaScript(script);
      try{await confirmAccount(target);}catch(error){return {...result,ready:false,signedIn:false,detail:String(error)};}
      if(result.ready&&signingIn)conceal();
      return {...result,signedIn:true};
    }
    if(['account','project','thinking','models','prepare','submit','model'].includes(action))await confirmAccount(target);
    const result=await target.webContents.executeJavaScript(script);
    if(action==='models'&&accountFile){
      const header=await target.webContents.capturePage({x:300,y:0,width:650,height:230});
      const diagnosticHeader=join(dirname(accountFile),'chatgpt-model-header.png');writeFileSync(diagnosticHeader,header.toPNG());
      return {...result,diagnosticHeader};
    }
    return result;
  };
  const login = async () => {
    const target = ensure();
    // Show the login surface before network navigation, including slow/offline first launch.
    target.setSkipTaskbar(false); target.show(); target.focus?.();
    const url = target.webContents.getURL();
    // getURL() retains the requested HTTPS URL even when Chromium displays an error document.
    // An explicit login click retries ChatGPT GET navigation; preserve an in-progress IdP login.
    signingIn = false;
    const loading = navigating ?? (!url || chatOrigin(url) || !loginDestination(url) || loadFailure ? navigate(false) : null);
    signingIn = true;
    try { if (loading) await loading; }
    catch (error) {
      signingIn = false;
      // Render only a fixed local error page; never keep a featureless failed Chromium document.
      const description = String(error.message ?? error).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><title>ALLMIND · ChatGPT 连接失败</title><body style="font:16px system-ui;padding:40px;line-height:1.8"><h2>ChatGPT 页面未能加载</h2><p>' + description + '</p><p>检查网络或代理连接后，返回 ALLMIND 设置，重新点击“打开独立登录窗口”。不会自动重发聊天消息。</p></body>')).catch(renderError=>process.stderr.write('Chat login error page: '+String(renderError)+'\n'));
      throw new Error('ChatGPT 登录页面加载失败：' + error.message + '。检查网络或代理后，重新点击打开登录窗口重试。');
    }
    if (loginTimer) clearInterval(loginTimer);
    // Observe only readiness on our own page; never read credentials. Hide after login.
    let inspecting = false;
    loginTimer = setInterval(async () => {
      if (inspecting || !signingIn || target.isDestroyed() || !chatOrigin(target.webContents.getURL())) return;
      inspecting = true;
      try { if ((await execute('probe')).ready) conceal(); }
      catch(error) { process.stderr.write('Independent Chat login readiness: '+String(error)+'\n'); }
      finally { inspecting = false; }
    }, 1500);
  };
  return {
    async handle(params) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Chat 宿主参数无效。');
      if (params.action === 'navigate') {
        if (Object.keys(params).some(k => !['action', 'temporary','project'].includes(k)) || typeof params.temporary !== 'boolean') throw new Error('Chat 导航参数无效。');
        await navigate(params.temporary,params.project); return { ok: true };
      }
      if (params.action === 'login') {
        if (Object.keys(params).some(k => k !== 'action')) throw new Error('Chat 登录参数无效。');
        await login(); return { opened: true };
      }
      if (Object.keys(params).some(k => !['action', 'input'].includes(k))) throw new Error('Chat 操作参数无效。');
      return execute(params.action, params.input ?? {});
    },
    close() { conceal(); if (page && !page.isDestroyed()) page.destroy(); page = null; },
  };
}


/** Fixed, isolated task pages sharing only the already authorized account partition. */
export function createParallelChatgptPageHost(options) {
  const lanes=new Map();
  return {
    async handle(params){
      if(!params||typeof params!=='object'||Array.isArray(params))throw Error('Chat 宿主参数无效。');
      const {lane=0,...request}=params;
      if(!Number.isInteger(lane)||lane<0||lane>3)throw Error('Chat 网页通道无效。');
      if(!lanes.has(lane))lanes.set(lane,createChatgptPageHost(options));
      return lanes.get(lane).handle(request);
    },
    close(){for(const host of lanes.values())host.close();lanes.clear();}
  };
}

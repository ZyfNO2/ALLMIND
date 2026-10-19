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
  let page = null, signingIn = false, navigating = null, loginTimer = null;
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
    page.on('close', event => { event.preventDefault(); conceal(); });
    return page;
  };
  const navigate = async (temporary, project) => {
    if (signingIn) throw new Error('请先在 ALLMIND 登录面板完成登录。');
    const target = ensure();
    // Fixed destination only; no URL can be supplied by the management renderer.
    navigating = target.loadURL(chatUrl(temporary,project));
    try { await navigating; } finally { navigating = null; }
  };
  const execute = async (action, input = {}) => {
    // Opt-in development reload of this fixed local adapter, never supplied scripts/URLs.
    const moduleUrl=new URL('../../dist/providers/chatgpt-background-bridge.js',import.meta.url);
    const scriptFactory=process.env.AIKI_CHAT_ADAPTER_RELOAD==='1'?(await import(moduleUrl.href+'?revision='+statSync(fileURLToPath(moduleUrl)).mtimeMs)).chatgptPageScript:chatgptPageScript;
    const script = scriptFactory(action, input); // validates closed actions/fields
    const target = ensure();
    if (!target.webContents.getURL()) await navigate(true);
    if (navigating) await navigating;
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
    const loading = navigating ?? (!target.webContents.getURL() || !loginDestination(target.webContents.getURL()) ? navigate(true) : null);
    signingIn = true;
    try { if (loading) await loading; }
    catch (error) { signingIn = false; throw error; }
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

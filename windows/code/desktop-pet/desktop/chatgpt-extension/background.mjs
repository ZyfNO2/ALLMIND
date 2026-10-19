// DrA1ex/chatgpt-bridge's extension/local-service pattern, reduced to AIKI's page port.
let running = false;
let tabId = null;
let client = null;
let lastError = '';
const allowed = ['probe', 'prepare', 'model', 'write', 'submit', 'submission', 'cancel', 'read', 'navigate', 'login'];
async function ownedTab() {
  if (tabId === null) tabId = (await chrome.storage.local.get('tabId')).tabId ?? null;
  if (tabId === null) throw new Error('尚未创建 AIKI 专用后台标签，请先在扩展设置中配对。');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://chatgpt.com/')) throw new Error('AIKI 后台标签已离开 ChatGPT；不接管其他标签。');
  return tab;
}
async function waitLoaded(id) {
  const start = Date.now();
  while (Date.now() - start < 40000) { const tab = await chrome.tabs.get(id); if (tab.status === 'complete') return; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error('后台页面加载超时；不自动导航或重发。');
}
async function execute(command) {
  if (!allowed.includes(command.action)) throw new Error('不支持此操作。');
  let tab;
  try { tab = await ownedTab(); }
  catch (error) {
    // Only the backend's pre-submit navigation may replace a missing owned tab.
    // Read/submit/stop never recreate a page or replay a request.
    if (command.action !== 'navigate' || !/No tab with id:\s*\d+/i.test(String(error))) throw error;
    const saved = await chrome.storage.local.get('windowId');
    const windows = (await chrome.windows.getAll()).filter(window => window.type === 'normal' && !window.incognito);
    const window = windows.find(window => window.id === saved.windowId) ?? (windows.length === 1 ? windows[0] : null);
    if (!window) throw new Error('原配对窗口已关闭且没有唯一可用窗口；请在目标配置重新配对。');
    tab = await chrome.tabs.create({ windowId: window.id, url: 'https://chatgpt.com/', active: false });
    tabId = tab.id;
    await chrome.storage.local.set({ tabId, windowId: window.id });
    await waitLoaded(tabId);
  }
  const confirmAccount = async () => {
    const identity = await chrome.tabs.sendMessage(tab.id, { channel: 'aiki-command', action: 'account', input: {} });
    const saved = await chrome.storage.local.get(['account', 'code', 'client']);
    if (identity?.error) throw new Error('ChatGPT 登录状态读取未成功：' + identity.error);
    if (!identity?.value?.account) throw new Error('ChatGPT 登录状态未返回账号指纹；未发送，稍后回读状态。');
    if (!saved.account) {
      // Older paired versions stored only the service key and browser client.
      // Migrate that existing connection on its first verified login; never
      // replace an existing fingerprint or accept an unpaired extension.
      if (!/^[a-f0-9]{64}$/.test(saved.code ?? '') || saved.client !== client || !client) throw new Error('扩展缺少原配对账号绑定，请重新配对。');
      await chrome.storage.local.set({ account: identity.value.account });
      return;
    }
    if (identity.value.account !== saved.account) throw new Error('已确认当前 ChatGPT 账号与原配对账号不同；未发送。若要更换账号，请在 AIKI 重置配对。');
  };
  if (['probe', 'prepare', 'submit', 'login'].includes(command.action)) await confirmAccount();
  if (command.action === 'navigate') {
    if (typeof command.input?.temporary !== 'boolean') throw new Error('临时模式参数无效。');
    await chrome.tabs.update(tab.id, { url: command.input.temporary ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/', active: false });
    await waitLoaded(tab.id);
    // Reloading a fixed URL in our owned tab also reinstalls scripts after an
    // extension update. Verify the pinned account AFTER that reload, before writes.
    await confirmAccount(); return { ok: true };
  }
  // Login is a read-only check: user logs in normally; never focus/open a window here.
  const result = await chrome.tabs.sendMessage(tab.id, { channel: 'aiki-command', action: command.action === 'login' ? 'probe' : command.action, input: command.input ?? {} });
  if (result?.error) throw new Error(result.error);
  if (!result?.value) throw new Error('页面没有返回结果。');
  if (command.action === 'login' && !result.value.ready) throw new Error('请在现有浏览器中登录 ChatGPT，随后回到 AIKI 检查连接。');
  return result.value;
}
async function loop() {
  if (running) return;
  running = true;
  try {
    const settings = await chrome.storage.local.get(['code', 'client']);
    if (!settings.code || !settings.client) return;
    client = settings.client;
    const post = async (path, body) => {
      const response = await fetch('http://127.0.0.1:17643' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + settings.code, 'Content-Type': 'application/json' }, body: JSON.stringify({ client, ...body }), signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('本地 bridge 连接失败：HTTP ' + response.status);
      return response.json();
    };
    for (;;) {
      const command = await post('/pull', {});
      lastError = '';
      if (command.idle) continue;
      let result;
      try { result = { value: await execute(command) }; } catch (error) { result = { error: String(error).slice(0, 1500) }; }
      // A lost result is NOT a reason to repeat execute(command).
      await post('/result', { id: command.id, ...result });
    }
  } catch (error) { lastError = String(error); }
  finally { running = false; }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) return;
  if (message?.action === 'status') { sendResponse({ running, lastError }); return; }
  if (message?.action !== 'pair' || !/^[a-f0-9]{64}$/.test(message.code ?? '')) return;
  void (async () => {
    if (running) throw new Error('请先断开旧配对，再修改配对码。');
    // Pairing is the only operation allowed to create ONE background tab in an existing window.
    const windowId = sender.tab?.windowId;
    if (windowId === undefined) throw new Error('请在目标 Chrome 配置的普通窗口中打开本扩展设置。');
    const window = await chrome.windows.get(windowId);
    if (window.type !== 'normal') throw new Error('需要一个已打开的普通浏览器窗口。');
    try { await ownedTab(); } catch {
      const tab = await chrome.tabs.create({ windowId: window.id, url: 'https://chatgpt.com/?temporary-chat=true', active: false });
      tabId = tab.id;
      await chrome.storage.local.set({ tabId });
      await waitLoaded(tabId);
    }
    const identity = await chrome.tabs.sendMessage(tabId, { channel: 'aiki-command', action: 'account', input: {} });
    if (identity?.error || !identity?.value?.account) throw new Error(identity?.error ?? '不能确认 ChatGPT 登录身份。');
    const previous = await chrome.storage.local.get(['client', 'code', 'account']);
    if (previous.code === message.code && previous.account && previous.account !== identity.value.account) throw new Error('ChatGPT 账号已更换，请先在 AIKI 重置配对。');
    await chrome.storage.local.set({ code: message.code, client: previous.client ?? crypto.randomUUID(), account: identity.value.account, windowId });
    void loop(); return { ok: true };
  })().then(sendResponse, error => sendResponse({ error: String(error) }));
  return true;
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onStartup.addListener(() => { void loop(); });
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 }); void loop(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bridge-reconnect') void loop(); });
void loop();

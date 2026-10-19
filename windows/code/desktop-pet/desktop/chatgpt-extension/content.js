chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== 'aiki-command') return;
  const ticket = crypto.randomUUID();
  const listener = event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'aiki-page-result' || event.data.ticket !== ticket) return;
    clearTimeout(timer); window.removeEventListener('message', listener);
    sendResponse(event.data.error ? { error: event.data.error } : { value: event.data.value });
  };
  const timer = setTimeout(() => { window.removeEventListener('message', listener); sendResponse({ error: '页面操作未确认；不重发。' }); }, 45000);
  window.addEventListener('message', listener);
  window.postMessage({ channel: 'aiki-page-command', ticket, action: message.action, input: message.input }, location.origin);
  return true;
});

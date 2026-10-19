/** Built into a static MAIN-world content script, never eval or CDP. */
export function installPageRuntime(pageAction, consume) {
  const allowed = ['account', 'probe', 'prepare', 'model', 'write', 'submit', 'submission', 'cancel', 'read'];
  window.addEventListener('message', async event => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || message?.channel !== 'aiki-page-command' || !allowed.includes(message.action) || typeof message.ticket !== 'string') return;
    const input = message.input ?? {};
    if (Object.keys(input).some(key => !['id', 'text', 'temporary', 'model'].includes(key))) return;
    if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 3000)) return;
    try { const value = await pageAction(message.action, input, consume); window.postMessage({ channel: 'aiki-page-result', ticket: message.ticket, value }, location.origin); }
    catch (error) { window.postMessage({ channel: 'aiki-page-result', ticket: message.ticket, error: String(error).slice(0, 1500) }, location.origin); }
  });
}

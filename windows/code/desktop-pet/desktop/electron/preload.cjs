const { contextBridge, ipcRenderer } = require('electron');
const channels = new Set(['desktop', 'shell', 'diagnostic']);
// FIX61-11: `microphonePreference` carries the stored microphone device id from the shell to the renderer.
// It is a device id only — never a path, never a recording.
// UI-MAN-01: `clickThroughChanged` and `localGreetingPreference`/`localGreetingLastShownAt` are delivered by
// the shell and were missing from this allowlist, so the renderer never learned the real click-through or
// greeting state. An unlisted method is silently dropped by the filter below.
// RWR-10-01: `replySoundPreference` carries the host-owned reply-sound switch to the renderer. Without
// it the renderer's `#sound-toggle` had no owner and the switch did nothing at all.
// RUX-04: `cachedAppearance` carries the LAST SHOWN character's manifest + stable asset base for the
// load period. It is the same manifest the backend once published; the shell republishes its files
// from the same disk locations, so it never carries a path into the renderer.
const methods = new Set(['receive', 'connectionChanged', 'hotkeyConfig', 'hotkeyEvent', 'displayConfig', 'managementResult', 'microphonePreference', 'rightClickRestore', 'clickThroughChanged', 'localGreetingPreference', 'localGreetingLastShownAt', 'replySoundPreference', 'cachedAppearance', 'desktopVisibility', 'petEnvironment']);
contextBridge.exposeInMainWorld('desktopHost', {
  postMessage(name, value) { if (channels.has(name)) ipcRenderer.send('pet:' + name, value); },
  subscribe(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('pet:delivery', (_event, method, ...args) => { if (methods.has(method)) callback(method, ...args); });
  }
});

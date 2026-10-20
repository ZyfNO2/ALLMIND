import { app, BrowserWindow, dialog, ipcMain, protocol, screen, Menu, shell, globalShortcut, desktopCapturer, Tray, powerMonitor, nativeImage } from 'electron';
import { installTray } from './tray.mjs';
import { archiveEntries } from '../../dist/management/model-archive.js';
import { createResourcePicker } from './resource-picker.mjs';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, unlink, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from './transport.mjs';
import { createParallelChatgptPageHost } from './chatgpt-page-host.mjs';
import { createScreenTargetCapture, dispatchScreenTargetCaptureRequest } from './screen-capture.mjs';
import { fitDisplay } from './layout.mjs';
import {surfaceAt,dockPosition,movePet,reachableWindow} from './pet-geometry.ts';
import {resolveLocalPetSlot} from '../../contracts/local-pet.ts';
import {CollectionHelperClient,collectionHelperPaths} from '../../dist/core/collection-helper-client.js';
import { assetResponse } from './assets.mjs';
import { managementUrl, managementTarget } from '../../tools/management-url.mjs';
import { nextUserDataDir } from '../../core/next-namespace.ts';
import { sanitizeRects, shouldIgnoreMouseEvents } from '../interactive-region.ts';
// RWR-10-01: the host owns hotkey / replySound / display preferences. This module is loaded directly by
// Electron, which STRIPS types rather than compiling them, so no `type` specifier may appear in an import
// here — only runtime values. The state type is therefore documented, not imported.
import {
  applyHostPatch, clampHostDrawerSize, defaultHostPreferences, hostCapabilities, HOST_MODEL_ENTRY_FILENAME,
  HostOperationLedger, parseHostPreferences,
  serializeHostPreferences, toPackRelativeEntry, toHostPreferencesPayload,
} from './host-preferences.ts';

const here = dirname(fileURLToPath(import.meta.url));
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(option('--root') || resolve(here, '..'));
const node = option('--node'), backend = option('--backend');
if (!node || !backend) throw Error('Use npm run dev or npm start to launch the Windows host.');
const preview = process.argv.includes('--preview');
const inspect = process.argv.includes('--inspect');
const bookSmoke = process.argv.includes('--book-smoke-test');
const companionProbe = process.argv.includes('--companion-probe');
// Spatial prototypes remain opt-in while role interactions ship as placeholders.
const localPetSpatialEnabled=process.argv.includes('--local-pet-spatial');
const backgroundAcceptance = process.argv.includes('--background-acceptance');
const inactiveStart = process.argv.includes('--inactive-start');
const smoke = process.argv.includes('--smoke-test') || bookSmoke || companionProbe || backgroundAcceptance;
app.setName('ALLMIND');
const smokeUserDataDir = companionProbe && option('--probe-user-data') ? resolve(option('--probe-user-data'))
  : smoke ? await mkdtemp(join(tmpdir(), 'aikanext-smoke-')) : undefined;
app.setPath('userData', smokeUserDataDir ?? nextUserDataDir(app.getPath('appData'), preview ? 'preview' : 'desktop'));
if (!app.requestSingleInstanceLock({ root, preview })) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const skinAssets = new Map(), appearanceRequests = new Map();
let activeSkinPrefix = null;
let win, ready = false, voiceRequested = false, wakeRequested = false, micTestRequested = false, panelOpen = false, beforeResize, beforeDrawerResize, clickThrough = false;
const chatgptPageHost = createParallelChatgptPageHost({ BrowserWindow, getParent: () => win, accountFile: resolve(app.getPath('userData'),'chatgpt-account.json') });
let desktopTray;
let hostBookMode = false, hostLife = null, hostInteractionManifest = null;
let companionStepAt = 0;
let petMotion='stop',petDock=null,petWindows=[],petGeometry=null,petGeometryPending=false,petGeometryAt=0,petMotionAt=0,petHostFocus=false,petJump=null,petHostSuspended=false;
export function localPetHostProbe(){return {anchor:{...anchor},motion:petMotion,docked:!!petDock,jumping:!!petJump,windows:petWindows.map(row=>({...row}))};}
function petHeight(){return fitDisplay(prefs.width,false,screen.getDisplayNearestPoint({x:Math.round(anchor.x),y:Math.round(anchor.y)}).workArea,anchor,prefs.mode).config.modelHeight;}
async function readPetWindows(){
  if(petGeometryPending)return;petGeometryPending=true;
  try{
    if(!petGeometry){petGeometry=new CollectionHelperClient({paths:collectionHelperPaths(resolve(here,'../..')),instanceId:'pet-windows-'+process.pid,onEvent:()=>{}});petGeometry.start();}
    const rows=await petGeometry.windowGeometry();
    petWindows=rows.filter(row=>row.pid!==process.pid).map(row=>{const rect=screen.screenToDipRect(win,row);return {...row,...rect};});petGeometryAt=Date.now();
  }catch(error){petWindows=[];petDock=null;petJump=null;petMotion='stop';deliver('petEnvironment',{error:'窗口几何来源不可用：'+String(error)});}
  finally{petGeometryPending=false;}
}
async function dockPet(jump=false){
  await readPetWindows();if(panelOpen||petHostSuspended||petHostFocus||hostLife?.quiet||!hostLife?.enabled||!win?.isVisible())return;
  const height=petHeight(),foot=anchor.y+height;
  const row=jump?reachableWindow(petWindows,{x:anchor.x,y:foot},petDock?.id??null):surfaceAt(petWindows,anchor.x,foot);
  if(!row){deliver('petEnvironment',{error:jump?'附近没有可达窗口。':'脚部附近没有可停靠的窗口顶边。'});return;}
  const x=Math.max(row.x+24,Math.min(row.x+row.width-24,anchor.x));
  const dock={id:row.id,ratio:(x-row.x)/row.width};
  if(jump){petJump={dock,from:{...anchor},startedAt:Date.now()};petDock=null;petMotion='stop';}
  else{petDock=dock;petMotion='stop';anchor={x,y:row.y-height};layout();}
}
function refreshCompanionTray() {
  if (!desktopTray || !hostBookMode) return;
  const available = !!hostLife && connection.state === 'ready';
  const action = (name, enabled) => {
    if (hostLife && connection.state === 'ready') connection.send({ channel: 'companion_action', characterId: hostLife.characterId,
      pairingId: hostLife.pairingId, action: name, enabled }, connection.generation);
  };
  desktopTray.setCompanionMenu([
    { type: 'separator' },
    { label: '自主活动', type: 'checkbox', checked: !!hostLife?.enabled, enabled: available, click: () => action('set_enabled', !hostLife.enabled) },
    { label: '免打扰', type: 'checkbox', checked: !!hostLife?.quiet, enabled: available, click: () => action('set_quiet', !hostLife.quiet) },
    { label: '静音', type: 'checkbox', checked: !prefs.replySound, click: () => { commitHostPreference(() => { prefs.replySound = !prefs.replySound; }); deliver('replySoundPreference', prefs.replySound); refreshCompanionTray(); } },
  ]);
}
let prefs = defaultHostPreferences(), hostUnknown = {}, anchor, prefsFile, writes = Promise.resolve();
/** Bounded replay ledger so a retried PUT after a lost response returns the ORIGINAL receipt. */
const hostOperations = new HostOperationLedger();
/**
 * RWR-10-04: one native chooser per (character, type, selection). The user asked for one dialog; a retried
 * request must not stack a second one on top. Completed selections are never cached here.
 */
const selectResource = createResourcePicker({ dialog, getWindow: () => win, scanModelEntries, archiveEntries });
const screenTargetOperations = new Map();
const screenTargetRevisions = new Map();
/**
 * CK-11: `electron.screen` throws if it is touched before the app `ready` event, and this module is
 * loaded before that. The capture closure is therefore built on first use, never at import time; a
 * capture request can only arrive over the host channel, which itself only exists once the window is up.
 */
let captureScreenTarget;
const captureScreenTargetForHost = params => {
  captureScreenTarget ??= createScreenTargetCapture({ screen, desktopCapturer, targets: screenTargetRevisions });
  return captureScreenTarget(params);
};
const deliver = (method, ...args) => { if (ready && win && !win.isDestroyed()) win.webContents.send('pet:delivery', method, ...args); };
/**
 * RUX-04 (user follow-up, 2026-10-10): the load period shows the LAST SHOWN character, never a
 * built-in default. When the renderer acknowledges a successful appearance, the host remembers that
 * appearance's manifest plus its on-disk asset paths in its own userData; on the next page load it
 * republishes the SAME files under the STABLE `skin-assets/last/` prefix — the per-request prefix
 * dies with the backend session — and hands them to the renderer before the backend is even up.
 * The backend's authoritative appearance still swaps in later exactly as before.
 */
const lastAppearanceFile = () => resolve(app.getPath('userData'), 'last-appearance.json');
const validSkinAssetName = name => !!name && typeof name === 'string' && !name.includes('\\') && !name.includes(':') && !name.includes('%') && !name.split('/').some(part => !part || part === '..' || part === '.');
async function persistLastAppearance(request) {
  try {
    // Route bodies: most assets are pack files on disk, but the manifest (`pet.skin.json`) and a
    // derived `presets.json` ride as inline bodies. Inline bodies are written ONCE into the host's
    // own userData so the memory is a complete, self-sufficient set of disk paths.
    const inlineDir = resolve(app.getPath('userData'), 'last-appearance-assets');
    await mkdir(inlineDir, { recursive: true });
    const routes = [];
    for (const [name, route] of request.routes) {
      if (!validSkinAssetName(name)) return;
      if (typeof route === 'string') { routes.push([name, route]); continue; }
      if (!route || typeof route !== 'object' || !('body' in route)) return;
      const target = join(inlineDir, name.replaceAll('/', '\u2423'));
      await writeFile(target, route.body);
      routes.push([name, target]);
    }
    if (routes.length !== request.routes.length) return;
    await writeFile(lastAppearanceFile(), JSON.stringify({ version: 1, manifest: request.manifest, routes }) + '\n', { mode: 0o600 });
  } catch (error) { process.stderr.write(`Host: last appearance could not be remembered: ${error?.message || error}\n`); }
}
async function restoreLastAppearance() {
  try {
    const persisted = JSON.parse(await readFile(lastAppearanceFile(), 'utf8'));
    const manifest = persisted?.manifest;
    if (persisted?.version !== 1 || !manifest || (manifest.type !== 'live2d' && manifest.type !== 'sprite') || !Array.isArray(persisted.routes) || !persisted.routes.length || persisted.routes.length > 256) return;
    const routes = [];
    for (const entry of persisted.routes) {
      if (!Array.isArray(entry) || entry.length !== 2 || !validSkinAssetName(entry[0]) || typeof entry[1] !== 'string') return;
      // The pack may have moved or been deleted since the last session; a stale entry must never
      // turn the restore into a half-loaded model, so every file is proven to still exist first.
      if (!existsSync(entry[1])) return;
      routes.push(entry);
    }
    const prefix = 'skin-assets/last/';
    for (const [name, route] of routes) skinAssets.set(prefix + name, route);
    deliver('cachedAppearance', { manifest, assetBase: `pet://app/${prefix}` });
    process.stderr.write('Host: last appearance republished for the load period.\n');
  } catch { /* No remembered appearance just means the load period stays empty, as before. */ }
}
const connection = new BackendConnection({
  onState: state => {
    voiceRequested = wakeRequested = false;
    if (state.state !== 'ready') {
      hostLife = null; hostInteractionManifest=null; refreshCompanionTray();
      for (const request of appearanceRequests.values()) for (const name of skinAssets.keys()) if (name.startsWith(request.prefix)) skinAssets.delete(name);
      appearanceRequests.clear();
    }
    deliver('connectionChanged', state);
    refreshCompanionTray();
  },
  onMessage: (message, generation) => {
    if (message.channel === 'backend_ready') { hostBookMode = message.productMode === 'memory-book'; if (hostLife?.characterId !== message.characterId) {hostLife = null;hostInteractionManifest=null;} refreshCompanionTray(); }
    if (message.channel === 'companion_state') {
      const changed = !hostLife || hostLife.characterId !== message.state.characterId || hostLife.enabled !== message.state.enabled || hostLife.quiet !== message.state.quiet;
      hostLife = message.state;petHostFocus=!!message.focus; if (changed) refreshCompanionTray();
    }
    // RWR-10-01: the backend's management server asks the host to read/write host-owned preferences.
    // This is a backend<->host exchange; it is answered here and never forwarded to the renderer.
    if (message.channel === 'host_request') { handleHostRequest(message); return; }
    if (message.channel === 'appearance') {
      hostInteractionManifest=null;petMotion='stop';petDock=null;petJump=null;
      const { routes, ...safe } = message;
      const prefix = `skin-assets/${generation}/${message.requestId}/`;
      for (const [name, route] of routes) {
        if (!validSkinAssetName(name)) throw Error('后端发布了无效的形象路径');
        skinAssets.set(prefix + name, route);
      }
      // RUX-04: keep the manifest and the routes for the ack below; every route form (pack file or
      // inline body) is made durable by persistLastAppearance, so the memory is always complete.
      appearanceRequests.set(message.requestId, { prefix, manifest: safe.manifest, routes: [...routes] });
      deliver('receive', { ...safe, assetBase: `pet://app/${prefix}` }, generation); return;
    }
    if (message.channel === 'wake_control') wakeRequested = message.enabled === true;
    if (message.channel === 'wake_error') wakeRequested = false;
    if (['capture_finish', 'capture_stop'].includes(message.channel)) voiceRequested = false;
    deliver('receive', message, generation);
  }
});
const validHotkey = code => code === null || /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/.test(code);
/**
 * RWR-10-01: the single write path for host-owned preferences.
 *
 * Every mutation — the renderer's own shell commands AND the console's `preferences.patch` — advances the
 * same revision and persists through here. Without this, a hotkey set from the desktop would leave the
 * console's cached revision stale and its next save would be refused for no visible reason.
 */
function commitHostPreference(mutate) {
  if (mutate) mutate();
  prefs.revision += 1;
  refreshCompanionTray();
  layout();
  void savePreferences();
  return prefs.revision;
}
function savePreferences() {
  // RWR-10-01: atomic publish. A crash mid-write must leave the previous file intact rather than a
  // truncated one, and unknown fields written by a newer host are carried through verbatim.
  const raw = serializeHostPreferences({ state: prefs, unknown: hostUnknown }, anchor);
  const target = prefsFile, temporary = `${target}.${process.pid}.next`;
  writes = writes
    .then(() => writeFile(temporary, raw, { mode: 0o600 }))
    .then(() => rename(temporary, target))
    .catch(() => { void unlink(temporary).catch(() => {}); process.stderr.write('Display preferences could not be saved.\n'); });
  return writes;
}
// FIX61-11 / FIX61-07: the microphone device preference. It lives in this machine's app data beside the
// display preferences, holds a device id only (never a path or a recording), and is written on its own
// serialized chain so a preference write can never race the display write.
let microphoneFile;
const readMicrophonePreference = async () => {
  if (!microphoneFile) return null;
  try {
    const saved = JSON.parse(await readFile(microphoneFile, 'utf8'));
    return typeof saved?.deviceId === 'string' && saved.deviceId ? saved.deviceId : null;
  } catch { return null; }
};
const writeMicrophonePreference = deviceId => {
  if (!microphoneFile) return writes;
  writes = writes.then(() => writeFile(microphoneFile, JSON.stringify({ version: 1, deviceId }) + '\n', { mode: 0o600 }))
    .catch(() => process.stderr.write('Microphone preference could not be saved.\n'));
  return writes;
};
function layout() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
  const fitted = fitDisplay(prefs.width, panelOpen, display.workArea, anchor, prefs.mode, prefs.drawerSize);
  anchor = fitted.anchor; win.setBounds(fitted.bounds); syncRightClickHookBounds();
  // The renderer positions its own floating surfaces (bubble → card → full answer). Give it the same
  // facts the host used — the current display's usable work area and DPI scale — so a bubble never
  // parks under the taskbar or off-screen on a scaled display. Additive fields; old renderers ignore them.
  deliver('displayConfig', { ...fitted.config, workArea: display.workArea, scaleFactor: display.scaleFactor });
  // UI-MAN-01: regions are content-relative, so a resize or a display-scale change can move a control out
  // from under the stored pointer. Re-arbitrate at the new size instead of keeping a stale decision.
  clickThroughPointer = null;
  applyMousePolicy();
}
const trusted = event => win && !win.isDestroyed() && !win.webContents.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame?.url === 'pet://app/index.html';
const start = () => connection.start(node, [backend], process.env);
const CLICK_THROUGH_SHORTCUT = 'CommandOrControl+Shift+M';
// UI-MAN-01: click-through can no longer be a window-wide boolean.
//
// Windows has no per-button hit testing behind `setIgnoreMouseEvents`, but with `forward: true` the window
// still receives mouse MOVEMENT while ignoring clicks. The renderer therefore reports the content-relative
// rectangles of its real, visible controls, and this process decides from the forwarded movement whether
// the pointer currently sits on one of them. Only then does the window stop ignoring the mouse — so the
// very next left click lands on the control instead of a later one — and the character body keeps passing
// clicks to the desktop behind it.
let interactiveRegions = [], clickThroughPointer = null, mouseIgnored = false;
const RIGHT_CLICK_MESSAGES = [0x0204, 0x0205, 0x00a4, 0x00a5, 0x007b];
let rightClickHooked = false, rightClickProcess = null, rightClickBuffer = '';
function stopRightClickHook() {
  if (!rightClickProcess) return;
  rightClickProcess.kill(); rightClickProcess = null; rightClickBuffer = '';
}
function syncRightClickHookBounds() {
  if (!rightClickProcess || !win || win.isDestroyed()) return;
  const dip = win.getBounds();
  const bounds = screen.dipToScreenRect ? screen.dipToScreenRect(win, dip) : dip;
  try { rightClickProcess.stdin.write(`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}\n`); } catch {}
}
function startRightClickHook() {
  if (backgroundAcceptance || process.platform !== 'win32' || rightClickProcess || !win || win.isDestroyed()) return;
  const hookFile = resolve(root, 'desktop/electron/right-click-hook.ps1');
  rightClickProcess = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hookFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  rightClickProcess.stdin.on('error', () => {});
  syncRightClickHookBounds();
  rightClickProcess.stdout.setEncoding('utf8');
  rightClickProcess.stdout.on('data', chunk => {
    rightClickBuffer += chunk;
    const lines = rightClickBuffer.split(/\r?\n/); rightClickBuffer = lines.pop() || '';
    for (const line of lines) {
      const match = /^R (-?\d+) (-?\d+)$/.exec(line.trim());
      if (!match || !clickThrough || !win || win.isDestroyed()) continue;
      const rawX = Number(match[1]), rawY = Number(match[2]);
      const point = screen.screenToDipPoint ? screen.screenToDipPoint({ x: rawX, y: rawY }) : { x: rawX, y: rawY };
      const x = point.x, y = point.y, bounds = win.getBounds();
      if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) continue;
      setClickThrough(false, true);
      deliver('rightClickRestore', { x: x - bounds.x, y: y - bounds.y });
    }
  });
  rightClickProcess.once('error', () => { rightClickProcess = null; rightClickBuffer = ''; });
  rightClickProcess.once('exit', () => { rightClickProcess = null; rightClickBuffer = ''; });
}
/**
 * UI-MAN-01: the single writer of `setIgnoreMouseEvents`.
 *
 * `interactiveRegions` is renderer-reported, so it is sanitized on the way in AND re-derived here from the
 * window's own content size. A stale or hostile list can therefore never capture the desktop: at worst it
 * makes the window receive clicks over an area the user can already see is part of the UI.
 */
function applyMousePolicy() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getContentBounds();
  const regions = sanitizeRects(interactiveRegions, { x: 0, y: 0, width: bounds.width, height: bounds.height });
  const ignore = shouldIgnoreMouseEvents(clickThrough, clickThroughPointer, regions);
  if (ignore === mouseIgnored) return;
  mouseIgnored = ignore;
  win.setIgnoreMouseEvents(ignore, { forward: true });
}
function setClickThrough(enabled, focusOnRestore = false) {
  clickThrough = enabled === true;
  clickThroughPointer = null;
  if (!win || win.isDestroyed()) return;
  applyMousePolicy();
  if (clickThrough) startRightClickHook(); else stopRightClickHook();
  if (!clickThrough && focusOnRestore) { if (desktopTray) desktopTray.show(); else { win.show(); win.focus(); } }
  deliver('clickThroughChanged', { enabled: clickThrough });
}

/**
 * RWR-10-01: the host control channel. The backend's management server owns no host state, so it sends
 * `host_request` over the same NDJSON pipe and awaits a correlated `host_reply`.
 *
 * Only the two frozen methods are implemented. Anything else is answered `unsupported` — the renderer
 * can never turn this into an arbitrary native call, and no parameter here names a path, URL or window.
 */
const hostReply = (requestId, result) => connection.send({ channel: 'host_reply', requestId, ok: true, result }, connection.generation);
const hostRefuse = (requestId, code, message) => connection.send({ channel: 'host_reply', requestId, ok: false, error: { code, message } }, connection.generation);
function currentDisplayPreferences() {
  const fitted = win && !win.isDestroyed()
    ? fitDisplay(prefs.width, panelOpen, screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea, anchor, prefs.mode, prefs.drawerSize)
    : undefined;
  return {
    mode: prefs.mode,
    preferredWidth: prefs.width,
    modelWidth: fitted?.config.modelWidth ?? Math.round(prefs.width * (340 / 360)),
    modelHeight: fitted?.config.modelHeight ?? 340,
    drawerHeight: fitted?.config.drawerHeight ?? 0,
  };
}
function hostCapabilityReport() {
  return hostCapabilities({
    windowAvailable: !!win && !win.isDestroyed(),
    canPersist: !!prefsFile,
    // RWR-10-04: the native chooser is implemented below, so this is now honestly true.
    filePicker: true,
  });
}

/**
 * RWR-10-04: find the `.model3.json` entry candidates inside a chosen pack root.
 *
 * Scanned shallowly by default (a rig's model file sits at the pack root or one level down) and bounded in
 * both depth and count so a huge directory cannot stall the host. The result is display-only: the browser
 * receives RELATIVE entries, never a path.
 */
async function scanModelEntries(root, maxDepth = 3, maxEntries = 64) {
  const found = [];
  const walk = async (directory, depth) => {
    if (depth > maxDepth || found.length >= maxEntries) return;
    let listing;
    try { listing = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const item of listing) {
      if (found.length >= maxEntries) return;
      const absolute = join(directory, item.name);
      if (item.isDirectory()) { await walk(absolute, depth + 1); continue; }
      if (!item.isFile() || !HOST_MODEL_ENTRY_FILENAME.test(item.name)) continue;
      const entry = toPackRelativeEntry(root, absolute, sep);
      if (entry) found.push({ entry, label: item.name });
    }
  };
  await walk(root, 0);
  return found.sort((a, b) => a.entry.localeCompare(b.entry));
}

/** RWR-10-05: user-initiated display selection. It returns only a real display handle and geometry; pixels are never captured here. */
async function openScreenTargetPicker(params) {
  const operationId = typeof params.operationId === 'string' ? params.operationId.trim() : '';
  const pairing = params.pairing && typeof params.pairing === 'object' ? params.pairing : {};
  if (!operationId || operationId.length > 200 || !pairing.userId || !pairing.characterId || !pairing.characterInstanceId) {
    throw Object.assign(new Error('目标选择请求无效。'), { code: 'invalid_request' });
  }
  const signature = JSON.stringify([pairing.userId, pairing.characterId, pairing.characterInstanceId]);
  const prior = screenTargetOperations.get(operationId);
  if (prior) {
    if (prior.signature !== signature) throw Object.assign(new Error('目标选择操作编号冲突。'), { code: 'operation_conflict' });
    return prior.result;
  }
  const displays = screen.getAllDisplays();
  if (!displays.length) throw Object.assign(new Error('当前没有可选择的显示器。'), { code: 'unavailable' });
  const buttons = displays.map((_, index) => `显示器 ${index + 1}`).concat('取消');
  const options = {
    type: 'question', title: '选择屏幕观察目标', message: '选择允许桌宠观察的显示器。',
    detail: '此步骤只选择目标，不会捕获屏幕像素。后续采集仍需单独授权。',
    buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true,
  };
  const result = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  let selected = { outcome: 'cancelled' };
  if (result.response >= 0 && result.response < displays.length) {
    const display = displays[result.response];
    const targetId = `display-${String(display.id)}`;
    const bounds = { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height };
    const scaleFactor = Number(display.scaleFactor) || 1;
    const fingerprint = JSON.stringify([bounds.x, bounds.y, bounds.width, bounds.height, scaleFactor]);
    const previous = screenTargetRevisions.get(targetId);
    const targetRevision = previous?.fingerprint === fingerprint ? previous.revision : (previous?.revision ?? 0) + 1;
    screenTargetRevisions.set(targetId, { fingerprint, revision: targetRevision });
    selected = { outcome: 'selected', target: { targetId, targetRevision, kind: 'screen',
      displayName: `显示器 ${result.response + 1}`, bounds, scaleFactor } };
  }
  screenTargetOperations.set(operationId, { signature, result: selected });
  while (screenTargetOperations.size > 64) screenTargetOperations.delete(screenTargetOperations.keys().next().value);
  return selected;
}

function handleHostRequest(value) {
  const requestId = value.requestId;
  if (typeof requestId !== 'string' || !requestId) return;
  if(value.method==='companion.interact'){
    if(!win||win.isDestroyed()||connection.state!=='ready'){hostRefuse(requestId,'unavailable','桌面尚未就绪。');return;}
    const params={...value.params,generation:connection.generation};
    void win.webContents.executeJavaScript(`window.petBridge.playCompanionInteraction(${JSON.stringify(params)})`).then(result=>hostReply(requestId,result),error=>hostRefuse(requestId,'unavailable',error?.message??'互动播放失败。'));return;
  }
  if (value.method === 'chatgpt-page') {
    void chatgptPageHost.handle(value.params).then(result => hostReply(requestId, result), error => hostRefuse(requestId, 'unavailable', error?.message ?? 'Chat 网页宿主不可用。'));
    return;
  }
  if (!prefsFile) { hostRefuse(requestId, 'unavailable', '宿主偏好文件尚未就绪。'); return; }
  if (value.method === 'screen-target.select') {
    const params = value.params && typeof value.params === 'object' ? value.params : {};
    void openScreenTargetPicker(params).then(result => hostReply(requestId, result), error => {
      hostRefuse(requestId, error?.code ?? 'unavailable', error?.message ?? '屏幕目标选择未完成。');
    });
    return;
  }
  if (dispatchScreenTargetCaptureRequest(value, { captureScreenTarget: captureScreenTargetForHost, hostReply, hostRefuse })) return;
  if (value.method === 'resource-picker.select') {
    const params = value.params && typeof value.params === 'object' ? value.params : {};
    const { type, selectionKind } = params;
    if (!['live2d', 'sprite'].includes(type) || !['directory', 'model-entry', 'archive', 'image'].includes(selectionKind)
      || (type === 'sprite') !== (selectionKind === 'image')) {
      hostRefuse(requestId, 'invalid_request', '选择的形象类型或来源无效。'); return;
    }
    void selectResource(params).then(result => hostReply(requestId, result), error => {
      hostRefuse(requestId, error?.code ?? 'unavailable', error instanceof Error ? error.message : '系统选择窗口没有打开。');
    });
    return;
  }
  if (value.method === 'preferences.get') {
    hostReply(requestId, toHostPreferencesPayload(prefs, currentDisplayPreferences(), hostCapabilityReport()));
    return;
  }
  if (value.method === 'preferences.patch') {
    const params = value.params && typeof value.params === 'object' ? value.params : {};
    const operationId = typeof params.operationId === 'string' ? params.operationId : '';
    if (!operationId) { hostRefuse(requestId, 'invalid_request', '操作编号无效。'); return; }
    const payload = { expectedRevision: params.expectedRevision, patch: params.patch };
    try {
      // Replay is resolved BEFORE the revision check: a retry after a lost response must return the
      // original receipt rather than a stale-revision conflict against the write it already performed.
      const replayed = hostOperations.lookup(operationId, payload);
      if (replayed) { hostReply(requestId, replayed); return; }
    } catch (error) {
      hostRefuse(requestId, (error?.code ?? 'operation_conflict'), error?.message ?? '操作编号冲突。'); return;
    }
    const outcome = applyHostPatch(prefs, params.expectedRevision, params.patch);
    if (!outcome.ok) { hostRefuse(requestId, outcome.code, outcome.message); return; }
    const applied = outcome.applied;
    const previous = prefs;
    prefs = outcome.next;
    layout();
    // The receipt is only produced after the write is durable; a failed write restores the old state.
    void savePreferences().then(() => {
      const receipt = { revision: prefs.revision, applied, preferences: toHostPreferencesPayload(prefs, currentDisplayPreferences(), hostCapabilityReport()) };
      hostOperations.record(operationId, payload, receipt);
      if (applied.includes('hotkey')) deliver('hotkeyConfig', { code: prefs.hotkey });
      if (applied.includes('replySound')) deliver('replySoundPreference', prefs.replySound);
      if (applied.includes('mode')) deliver('displayConfig', currentDisplayPreferences());
      hostReply(requestId, receipt);
    }, () => { prefs = previous; layout(); hostRefuse(requestId, 'unavailable', '宿主设置保存失败，原设置已保留。'); });
    return;
  }
  if (value.method === 'app.restart') {
    // RUX-02: the host owns the restart. The reply goes out FIRST so the console request settles;
    // the actual shutdown uses the existing bounded path (EOF first, then the shutdown timeout kill),
    // and `start()` reuses the serialized launcher so the old backend fully exits before the new one
    // spawns. This is a real process restart of the managed backend — never a web reload.
    process.stderr.write('Host: managed backend restart requested by the console.\n');
    hostReply(requestId, { requestedAt: new Date().toISOString() });
    setTimeout(() => {
      try { void connection.cancel().finally(() => start()); }
      catch (error) { process.stderr.write(`Host: restart failed to relaunch: ${error?.message || error}\n`); }
    }, 50);
    return;
  }
  hostRefuse(requestId, 'unsupported', '这个宿主操作尚未实现。');
}
ipcMain.on('pet:desktop', (event, value) => {
  if (!trusted(event) || !value || value.generation !== connection.generation || connection.state !== 'ready' || !value.message || typeof value.message !== 'object') return;
  const appearanceRequest = appearanceRequests.get(value.message.requestId);
  if (appearanceRequest && ['ack', 'rpc_error'].includes(value.message.channel)) {
    const removePrefix = value.message.channel === 'ack' ? activeSkinPrefix : appearanceRequest.prefix;
    for (const name of skinAssets.keys()) if (removePrefix && name.startsWith(removePrefix)) skinAssets.delete(name);
    if (value.message.channel === 'ack') {
      hostInteractionManifest=appearanceRequest.manifest;
      activeSkinPrefix = appearanceRequest.prefix;
      // RUX-04: the ack means this model actually loaded and reached the screen — remember it so
      // the NEXT page load can show it immediately (see restoreLastAppearance).
      void persistLastAppearance(appearanceRequest);
    }
    appearanceRequests.delete(value.message.requestId);
  }
  const type = value.message.command?.type;
  if (['start_voice', 'click_invitation'].includes(type)) voiceRequested = true;
  if (['finish_voice', 'cancel', 'submit_text'].includes(type)) voiceRequested = false;
  connection.send(value.message, value.generation);
});
ipcMain.on('pet:shell', async (event, value) => {
  if (!trusted(event) || !value || typeof value !== 'object') return;
  switch (value.type) {
    case 'ready':
      if (ready) return;
      ready = true; layout(); deliver('hotkeyConfig', { code: prefs.hotkey }); deliver('localGreetingPreference', prefs.localGreeting); deliver('localGreetingLastShownAt', prefs.localGreetingLastShownAt);
      // RWR-10-01: the host owns replySound, so every fresh page learns the stored value.
      deliver('replySoundPreference', prefs.replySound);
      // RUX-04: republish the LAST SHOWN character's assets for the load period, before the backend
      // is up. A fresh install (or a deleted pack) simply has nothing remembered here.
      void restoreLastAppearance();
      // FIX61-10 (FIX61-07 07-C "重启一致"): report the stored microphone choice on every fresh page so
      // the conversation capture applies the same device after a restart, not only in the test panel.
      void readMicrophonePreference().then(deviceId => deliver('microphonePreference', deviceId));
      start(); break;
    case 'panel': panelOpen = value.open === true; if(panelOpen){petDock=null;petJump=null;petMotion='stop';}layout(); if (panelOpen) win.focus(); break;
    case 'focus': win.focus(); break;
    case 'drag':
      petDock=null;petJump=null;petMotion='stop';
      if (Number.isFinite(value.dx) && Number.isFinite(value.dy) && Math.abs(value.dx) < 2000 && Math.abs(value.dy) < 2000) {
        anchor.x += value.dx; anchor.y += value.dy; layout(); savePreferences();
      } break;
    case 'drag_end': {
      const area = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea;
      const fitted = fitDisplay(prefs.width, false, area, anchor, prefs.mode, prefs.drawerSize);
      const bounds = fitted.bounds, margin = 24;
      if (bounds.x - area.x <= margin) anchor.x = area.x + bounds.width / 2;
      else if (area.x + area.width - bounds.x - bounds.width <= margin) anchor.x = area.x + area.width - bounds.width / 2;
      if (bounds.y - area.y <= margin) anchor.y = area.y;
      else if (area.y + area.height - bounds.y - bounds.height <= margin) anchor.y = area.y + area.height - bounds.height;
      layout(); await savePreferences(); break;
    }
    case 'pet_motion':{
      const kind=({walk:'moving',chase:'chasing',dock:'docked',jump:'jumping'})[value.mode];
      if(value.mode!=='stop'&&(!kind||!hostInteractionManifest||resolveLocalPetSlot(hostInteractionManifest.localInteractions??null,hostInteractionManifest,kind).availability!=='available')){deliver('petEnvironment',{error:'当前角色未声明此窗口互动。'});break;}
      if(!hostBookMode||!hostLife?.enabled||petHostFocus||hostLife.quiet||panelOpen||!win.isVisible())break;
      if(['walk','chase','stop'].includes(value.mode)){petMotion=value.mode;if(value.mode!=='stop')petDock=null;}
      else if(value.mode==='dock'||value.mode==='jump'){
        if(localPetSpatialEnabled)void dockPet(value.mode==='jump');
        else deliver('petEnvironment',{error:'当前宿主未启用空间互动。',spatialEnabled:false});
      }
      break;
    }
    case 'companion_step': {
      const now = Date.now(); if (now < companionStepAt) companionStepAt = 0;
      if (hostBookMode && hostLife?.enabled && hostLife.activity === 'walking' && now - companionStepAt >= 800
        && !panelOpen && win.isVisible() && Number.isFinite(value.dx) && Math.abs(value.dx) <= 1) {
        companionStepAt = now; anchor.x += value.dx; layout();
      }
      break;
    }
    case 'set_click_through':
      setClickThrough(value.enabled); break;
    // UI-MAN-01: the renderer reports where its visible controls are, and where the OS says the pointer is.
    // Both are bounded here rather than trusted, and neither can widen the window or reach the file system.
    case 'interactive_regions':
      interactiveRegions = Array.isArray(value.regions) ? value.regions.slice(0, 64) : [];
      applyMousePolicy(); break;
    case 'pointer_position': {
      if (!clickThrough) break;
      const bounds = win && !win.isDestroyed() ? win.getContentBounds() : null;
      if (!bounds) break;
      const x = Number(value.x), y = Number(value.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) { clickThroughPointer = null; break; }
      if (value.inside === false) { clickThroughPointer = null; break; }
      if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) { clickThroughPointer = null; break; }
      clickThroughPointer = { x, y };
      applyMousePolicy(); break;
    }
    case 'set_display': if (['full', 'half'].includes(value.mode)) { commitHostPreference(() => { prefs.mode = value.mode; }); } break;
    case 'resize_model':
      if (value.phase === 'begin') beforeResize ??= prefs.width;
      else if (beforeResize !== undefined) {
        if (value.phase === 'cancel') { prefs.width = beforeResize; beforeResize = undefined; }
        else if (['update', 'commit'].includes(value.phase) && Number.isFinite(value.width)) {
          prefs.width = Math.max(220, Math.min(720, value.width));
          if (value.phase === 'commit') { beforeResize = undefined; commitHostPreference(); }
        }
        layout();
      } break;
    // RUX-08: the chat window's four sides and four corners resize the DRAWER geometry only — the
    // model keeps its own preferred width. Same begin/update/commit/cancel transaction as
    // resize_model: an uncommitted drag restores the saved size, a commit persists through the
    // single preference write path. Sizes are clamped to the honest drawer minimum (header +
    // composer stay usable) and the current work area.
    // The renderer reports the pointer's VIEWPORT position; the HOST derives the size from the
    // pointer's absolute screen position, so a window that MOVES mid-drag (fitDisplay re-places
    // the drawer against the screen bounds) can never corrupt the gesture — there is no delta.
    case 'resize_drawer': {
      if (value.phase === 'begin') { beforeDrawerResize ??= prefs.drawerSize; break; }
      if (beforeDrawerResize === undefined) break;
      if (value.phase === 'cancel') { prefs.drawerSize = beforeDrawerResize; beforeDrawerResize = undefined; layout(); break; }
      if (!['update', 'commit'].includes(value.phase)) break;
      if (value.phase === 'update' && typeof value.edge === 'string' && /^[nsew]{1,2}$/.test(value.edge)
        && Number.isFinite(value.pointerX) && Number.isFinite(value.pointerY)) {
        const bounds = win && !win.isDestroyed() ? win.getContentBounds() : null;
        if (!bounds) break;
        const workArea = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea;
        const fitted = fitDisplay(prefs.width, panelOpen, workArea, anchor, prefs.mode, prefs.drawerSize);
        const drawer = { left: fitted.bounds.x + fitted.config.drawerLeft, top: fitted.bounds.y + fitted.config.drawerTop,
          right: fitted.bounds.x + fitted.config.drawerLeft + fitted.config.drawerWidth, bottom: fitted.bounds.y + fitted.config.drawerTop + fitted.config.drawerHeight };
        const screenX = bounds.x + Number(value.pointerX), screenY = bounds.y + Number(value.pointerY);
        let width = prefs.drawerSize?.width ?? fitted.config.drawerWidth;
        let height = prefs.drawerSize?.height ?? fitted.config.drawerHeight;
        if (value.edge.includes('e')) width = screenX - drawer.left;
        if (value.edge.includes('w')) width = drawer.right - screenX;
        if (value.edge.includes('s')) height = screenY - drawer.top;
        if (value.edge.includes('n')) height = drawer.bottom - screenY;
        const clamped = clampHostDrawerSize({ width: Math.min(width, workArea.width - 20), height: Math.min(height, workArea.height) });
        // A below-minimum request keeps the last valid size (the drag visibly stops at the honest
        // minimum) instead of snapping the drawer back to the layout default.
        if (clamped !== null) prefs.drawerSize = clamped;
      }
      if (value.phase === 'commit') { beforeDrawerResize = undefined; commitHostPreference(); }
      layout();
      break;
    }
    case 'set_hotkey': if (validHotkey(value.code)) { commitHostPreference(() => { prefs.hotkey = value.code; }); deliver('hotkeyConfig', { code: prefs.hotkey }); } break;
    case 'local_greeting_preference':
      if (typeof value.enabled === 'boolean') { commitHostPreference(() => { prefs.localGreeting = value.enabled; }); deliver('localGreetingPreference', prefs.localGreeting); }
      break;
    case 'reply_sound_preference':
      if (typeof value.enabled === 'boolean') {
        commitHostPreference(() => { prefs.replySound = value.enabled; });
        deliver('replySoundPreference', prefs.replySound);
      }
      break;
    case 'local_greeting_shown':
      if (Number.isFinite(value.occurredAt) && value.occurredAt >= 0 && value.occurredAt <= Date.now() + 60_000) {
        commitHostPreference(() => { prefs.localGreetingLastShownAt = Math.max(prefs.localGreetingLastShownAt ?? -Infinity, value.occurredAt); });
      }
      break;
    case 'reconnect': if (['failed', 'disconnected'].includes(connection.state)) start(); break;
    // RUX-02: 快速重启 — the renderer asked for a managed-backend restart. Same bounded shutdown path
    // as quit-drain (EOF first, then the shutdown timeout), then a fresh spawn through start().
    case 'restart_backend': {
      process.stderr.write('Host: quick restart requested from the pet menu.\n');
      void connection.cancel().then(() => start()).catch(() => start());
      break;
    }
    // FIX61-11 / FIX61-07: an explicit, user-initiated microphone-test lease. It grants AUDIO ONLY, and
    // only while the test panel is open, so a mic test never needs the backend to be ready and can never
    // open the camera. Releasing the lease drops the permission again immediately.
    case 'mic_test_request':
      micTestRequested = true;
      // FIX61-11: the renderer owns the device but not the file. The chosen device id is stored here, in
      // this machine's app data, and reported back — the renderer never sees a path.
      deliver('microphonePreference', await readMicrophonePreference());
      break;
    case 'mic_test_release': micTestRequested = false; break;
    case 'mic_test_preference':
      // null is an explicit "use the system default device", distinct from a missing value.
      if (value.deviceId !== null && (typeof value.deviceId !== 'string' || !value.deviceId.trim() || value.deviceId.length > 512)) break;
      await writeMicrophonePreference(value.deviceId);
      break;
    // FIX61-03: a visible startup can be cancelled; EOF first, then the shutdown timeout.
    case 'cancel_startup': if (connection.state === 'connecting') void connection.cancel(); break;
    case 'disconnect': if (value.generation === connection.generation) connection.close(); break;
    case 'open_management':
      if (preview) { deliver('managementResult', { ok: false }); break; }
      // FIX61-04: a panel entry may name a console section. Only a same-origin console path is accepted;
      // an absolute URL from the renderer is refused rather than handed to the shell.
      if (value.path !== undefined && (typeof value.path !== 'string' || !/^\/(?!\/)[A-Za-z0-9._~\-/?#=&%]*$/.test(value.path))) { deliver('managementResult', { ok: false }); break; }
      void managementUrl(process.env.PET_TRIAL_CONFIG)
        // FIX61-11: the route is MERGED into the session fragment. Composing with `new URL(value.path, url)`
        // replaced the whole fragment and silently dropped `#token=`, so 外观 / 换肤 opened in the locked
        // state even though the page itself was right.
        .then(url => shell.openExternal(managementTarget(url, value.path)))
        .then(() => deliver('managementResult', { ok: true })).catch(() => deliver('managementResult', { ok: false })); break;
    // Older renderer quit commands now also collapse; actual user exit belongs to the tray.
    case 'quit': desktopTray?.hide(); break;
    case 'hide_to_tray': desktopTray?.hide(); break;
  }
});
ipcMain.on('pet:diagnostic', (event, value) => {
  if (!trusted(event) || !value) return;
  // Don't copy arbitrary renderer text, chat or media into diagnostic logs.
  if (['model-ready', 'model-error', 'script-error', 'promise-error'].includes(value.type)) process.stderr.write(`Renderer: ${value.type}: ${value.message || ""}\n`);
  if (['book-turn-recovery','book-turn-rejected','book-turn-event'].includes(value.type)) {
    const safe={diagnostic:value.type,at:Date.now()};
    for(const key of ['requestId','turnId','state','reason','event'])if(typeof value[key]==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(value[key]))safe[key]=value[key];
    if(typeof value.accepted==='boolean')safe.accepted=value.accepted;
    process.stderr.write(JSON.stringify(safe)+'\n');
  }
});

// Do not await readiness at module scope: Electron must finish loading this ESM
// entry before it can emit ready. Keep initialization in the ready callback.
void app.whenReady().then(async () => {
await mkdir(app.getPath('userData'), { recursive: true });
prefsFile = resolve(app.getPath('userData'), 'windows-display.json');
microphoneFile = resolve(app.getPath('userData'), 'microphone.json');
try {
  const saved = JSON.parse(await readFile(prefsFile, 'utf8'));
  const parsed = parseHostPreferences(saved);
  prefs = parsed.state; hostUnknown = parsed.unknown;
  if (Number.isFinite(saved?.anchor?.x) && Number.isFinite(saved?.anchor?.y)) anchor = saved.anchor;
} catch {}
const area = screen.getPrimaryDisplay().workArea;
anchor ??= { x: area.x + area.width - 220, y: area.y + Math.max(0, area.height - 430) };
win = new BrowserWindow({ title: preview ? 'ALLMIND · Offline preview' : 'ALLMIND', width: 380, height: 376,
  frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, hasShadow: false, resizable: false, show: !smoke && !inactiveStart, focusable: !backgroundAcceptance,
  webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    partition: 'aika-desktop', backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', ...(backgroundAcceptance ? {offscreen:true} : {}) } });
const brandIconPath = resolve(here, '../assets/allmind/icon-256.png');
const brandIcon = existsSync(brandIconPath) ? nativeImage.createFromPath(brandIconPath) : null;
if (brandIcon && !brandIcon.isEmpty()) win.setIcon(brandIcon);
const trayIcon = brandIcon && !brandIcon.isEmpty() ? brandIcon.resize({ width: 16, height: 16 }) : await app.getFileIcon(process.execPath, { size: 'small' });
// Keep the hidden model page alive when the main window hides; before-quit owns shutdown.
if(inactiveStart&&!smoke)win.once('ready-to-show',()=>win.showInactive());
if(!backgroundAcceptance)desktopTray = installTray({ app, win, Tray, Menu, icon: trayIcon,
  onHide: () => deliver('hotkeyEvent', { type: 'cancel' }) });
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'ALLMIND', submenu: [
  { label: 'Reload', accelerator: 'Ctrl+R', click: () => { connection.close(); ready = false; win.webContents.reload(); } },
  { label: 'Developer tools', accelerator: 'Ctrl+Shift+I', click: () => win.webContents.toggleDevTools() },
  { label: 'Toggle click-through', click: () => setClickThrough(!clickThrough, true) },
  { label: '收起到系统托盘', click: () => desktopTray.hide() }
] }, { role: 'editMenu' }]));
if (!backgroundAcceptance && !globalShortcut.register(CLICK_THROUGH_SHORTCUT, () => setClickThrough(!clickThrough, true)))
  process.stderr.write('Click-through shortcut could not be registered.\n');
await win.webContents.session.protocol.handle('pet', request => assetResponse(root, request.url, skinAssets));
// FIX61-11 / FIX61-07: a microphone test is a separate, explicit lease (`mic_test_request`). It grants
// AUDIO only — `video` still requires a real voice turn, so a mic test can never light the camera — and
// it is deliberately independent of `voiceRequested`, so a failed or not-yet-ready backend does not stop
// the user from checking whether the device itself works.
const mediaAllowed = (wc, permission, origin, types, mainFrame) => !preview && wc === win.webContents && permission === 'media'
  && origin?.startsWith('pet://app/') && mainFrame !== false && types.length > 0
  && types.every(type => type === 'audio' ? voiceRequested || wakeRequested || micTestRequested : type === 'video' && voiceRequested);
win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(mediaAllowed(wc, permission, details.requestingUrl, details.mediaTypes || [], details.isMainFrame)));
win.webContents.session.setPermissionCheckHandler((wc, permission, origin, details) => mediaAllowed(wc, permission, origin + '/', [details.mediaType], details.isMainFrame));
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', event => event.preventDefault());
win.webContents.on('will-attach-webview', event => event.preventDefault());
win.webContents.on('render-process-gone', () => { ready = false; connection.close(); });
win.on('blur', () => { if (beforeResize !== undefined) { prefs.width = beforeResize; beforeResize = undefined; layout(); } if (beforeDrawerResize !== undefined) { prefs.drawerSize = beforeDrawerResize; beforeDrawerResize = undefined; layout(); } deliver('hotkeyEvent', { type: 'cancel' }); });
win.on('hide', () => deliver('desktopVisibility', false));
win.on('show', () => deliver('desktopVisibility', true));
for (const message of RIGHT_CLICK_MESSAGES) {
  win.hookWindowMessage(message, () => {
    if (clickThrough) setClickThrough(false, true);
  });
}
rightClickHooked = true;
screen.on('display-metrics-changed', layout); screen.on('display-removed', layout);
const petMotionTimer=setInterval(()=>{
  const now=Date.now(),elapsed=petMotionAt?now-petMotionAt:0;petMotionAt=now;
  if(!win||win.isDestroyed()||!ready||!hostBookMode)return;
  if(!hostLife?.enabled||hostLife.quiet||petHostFocus||petHostSuspended||panelOpen||!win.isVisible()||now-hostLife.updatedAt>10000){petMotion='stop';petDock=null;petJump=null;return;}
  const cursor=screen.getCursorScreenPoint(),height=petHeight();
  if((petDock||petJump)&&now-petGeometryAt>250)void readPetWindows();
  let state='gazing',changed=false;
  if(petJump){
    const target=dockPosition(petWindows,petJump.dock,height),t=Math.min(1,(now-petJump.startedAt)/900);
    if(!target){petJump=null;petDock=null;}
    else{anchor={x:petJump.from.x+(target.x-petJump.from.x)*t,y:petJump.from.y+(target.y-petJump.from.y)*t-Math.sin(Math.PI*t)*60};state='jumping';changed=true;if(t>=1){petDock=petJump.dock;petJump=null;deliver('petEnvironment',{completed:'jumping'});}}
  }else if(petDock){const position=dockPosition(petWindows,petDock,height);if(position){anchor=position;changed=true;state='docked';}else{petDock=null;state='idle';}}
  else if(petMotion==='chase'||petMotion==='walk'){
    const target=petMotion==='chase'?{x:cursor.x,y:anchor.y}:{x:anchor.x+(Math.floor(now/20000)%2?-150:150),y:anchor.y};
    if(localPetSpatialEnabled&&(petMotion==='walk'||Math.abs(cursor.x-anchor.x)>60)){anchor=movePet(anchor,target,elapsed,petMotion==='chase'?140:65);changed=true;}state=petMotion==='chase'?'chasing':'moving';
  }
  if(changed)layout();
  deliver('petEnvironment',{state,spatialEnabled:localPetSpatialEnabled,cursor:{x:Math.max(-1,Math.min(1,(cursor.x-anchor.x)/250)),y:Math.max(-1,Math.min(1,(cursor.y-anchor.y-height*.3)/250))}});
},100);
function petSession(paused){petHostSuspended=paused;petMotion='stop';petDock=null;petJump=null;deliver('petEnvironment',{suspended:paused});if(connection.state==='ready')connection.send({channel:'book_activity_session',paused},connection.generation);}
powerMonitor.on('lock-screen',()=>petSession(true));powerMonitor.on('suspend',()=>petSession(true));
powerMonitor.on('unlock-screen',()=>petSession(false));powerMonitor.on('resume',()=>petSession(false));
app.on('second-instance', () => desktopTray.show());
let quitDrained = false, quitPending = false;
app.on('before-quit', event => {
  clearInterval(petMotionTimer);void petGeometry?.close();
  chatgptPageHost.close();
  if (quitDrained) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  // Keep pipes and the Electron event loop alive until backend EOF cleanup
  // finishes. Otherwise Windows can leave backend.lock after the window closes.
  void connection.close().then(() => writes).finally(() => { quitDrained = true; if (bookSmoke || companionProbe) app.exit(process.exitCode ?? 0); else app.quit(); });
});
app.on('will-quit', () => {
  chatgptPageHost.close();
  globalShortcut.unregister(CLICK_THROUGH_SHORTCUT);
  stopRightClickHook();
  if (rightClickHooked && win && !win.isDestroyed()) for (const message of RIGHT_CLICK_MESSAGES) win.unhookWindowMessage(message);
  rightClickHooked = false;
});
app.on('window-all-closed', () => app.quit());
layout();
await win.loadURL('pet://app/index.html');
if (inspect) win.webContents.openDevTools({ mode: 'detach' });
if (bookSmoke) {
  try {
    const waitFor = async (expression, label) => {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        if (await win.webContents.executeJavaScript(expression)) return;
        await new Promise(done => setTimeout(done, 150));
      }
      throw Error(`${label}: ` + await win.webContents.executeJavaScript("document.getElementById('status').textContent"));
    };
    await waitFor("!!window.petBridge && !document.getElementById('send').disabled && window.__aikaAppearanceProbe?.().appearanceReady", 'Memory Book renderer/appearance readiness');
    await win.webContents.executeJavaScript("document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))");
    for (const [query, expected] of [['还记得我们第一次见面吗？', '机库'], ['Alice 负责什么？', '结构检测']]) {
      await win.webContents.executeJavaScript(`document.getElementById('text').value=${JSON.stringify(query)};document.getElementById('form').requestSubmit()`);
      await waitFor(`document.getElementById('reply').textContent.includes(${JSON.stringify(expected)}) && !document.getElementById('send').disabled`, 'Memory Book production text round trip');
    }
    await win.webContents.executeJavaScript("document.getElementById('drawer-settings').click()");
    const menu = await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('#drawer-more-menu [role^=menuitem]')).map(node=>node.textContent)");
    if (!menu.includes('Memory Book') || !menu.some(label => /自主活动/.test(label)) || menu.some(label => /语音|麦克风|问候/.test(label))) throw Error('Desktop menu did not select Memory Book companion mode: ' + JSON.stringify(menu));
    if (option('--screenshot')) {
      win.showInactive();
      await waitFor("!document.getElementById('drawer').hidden && getComputedStyle(document.getElementById('drawer')).opacity === '1'", 'Actual visible chat drawer');
      await writeFile(resolve(option('--screenshot')), (await win.webContents.capturePage()).toPNG());
      win.hide();
    }
    if (desktopTray) {
      win.close();
      if (win.isDestroyed() || win.isVisible()) throw Error('Window close must keep the pet alive in the tray');
      desktopTray.show();
      if (win.isDestroyed() || !win.isVisible()) throw Error('Tray restore must reuse the existing window');
      console.log('TRAY_CLOSE_RESTORE_OK');
    }
    console.log('MEMORY_BOOK_ELECTRON_OK: default file backend, actual appearance, two retrieved-context turns, minimal menu. External model is protocol stub.');
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
  app.quit();
}
if (smoke && !bookSmoke && !companionProbe && !backgroundAcceptance) {
  try {
    // Exercise the real Electron renderer in an offscreen window; no account or device access.
    const deadline = Date.now() + 20000;
    let loaded = false;
    while (Date.now() < deadline) {
      // RUX-04: the loading cover node no longer exists — nothing is displayed while the model
      // loads. Readiness is the bridge plus a connected backend (send enabled), not a cover flip.
      loaded = await win.webContents.executeJavaScript("!!window.petBridge && !document.getElementById('loading') && !document.getElementById('send').disabled");
      if (loaded) break;
      await new Promise(done => setTimeout(done, 200));
    }
    if (!loaded) throw Error('Renderer or offline backend did not become ready: ' + await win.webContents.executeJavaScript("document.getElementById('status').textContent"));
    await win.webContents.executeJavaScript("document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));document.getElementById('text').value='Windows bridge smoke test';document.getElementById('form').requestSubmit();");
    await new Promise(done => setTimeout(done, 400));
    const echoed = await win.webContents.executeJavaScript("document.getElementById('reply').textContent.includes('Offline preview received')");
    if (!echoed) throw Error('Text did not complete a backend round trip');
    // UI-MAN-01: the drawer opens with an opacity transition, and an offscreen window never advances one.
    // Show the window (without stealing focus) so the drawer reaches its real, opaque, clickable state —
    // which is also the only state in which it should capture the pointer.
    win.showInactive();
    await new Promise(done => setTimeout(done, 500));
    await win.webContents.executeJavaScript("window.desktopHost.postMessage('shell',{type:'set_click_through',enabled:true})");
    await new Promise(done => setTimeout(done, 300));
    // UI-MAN-01: with the drawer open the renderer must have reported real interactive regions, and a
    // pointer inside one must have made the window stop ignoring the mouse. This asserts the live wiring,
    // not just that the shell accepted the toggle.
    const reported = await win.webContents.executeJavaScript("(() => { const r = document.getElementById('drawer').getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top, width: r.width, height: r.height }); })()");
    const drawerRect = JSON.parse(reported);
    await win.webContents.executeJavaScript(`window.desktopHost.postMessage('shell',{type:'pointer_position',x:${Math.round(drawerRect.x + drawerRect.width / 2)},y:${Math.round(drawerRect.y + 20)},inside:true})`);
    await new Promise(done => setTimeout(done, 200));
    const regionCount = await win.webContents.executeJavaScript("(() => { const roots = ['#drawer','#function-panel','#mic-test','#work-records-dialog']; let n = 0; for (const sel of roots) { const node = document.querySelector(sel); if (node && !node.hidden && node.getClientRects().length) n++; } return n; })()");
    if (regionCount < 1) throw Error('The renderer reported no interactive regions while the drawer is open');
    // The visible always-on-top window also sees the USER's real pointer (`forward: true`), and a
    // real move over a non-interactive area legitimately re-arbitrates back to ignore. Restate the
    // synthetic probe immediately before reading the decision so the assertion below reads THIS
    // probe's arbitration, not a physical mouse that happens to be parked over the window.
    // Electron exposes no getter for `setIgnoreMouseEvents`, so assert the shell's own arbitration
    // state — the same value that was last written to the window.
    await win.webContents.executeJavaScript(`window.desktopHost.postMessage('shell',{type:'pointer_position',x:${Math.round(drawerRect.x + drawerRect.width / 2)},y:${Math.round(drawerRect.y + 20)},inside:true})`);
    if (mouseIgnored) {
      const diagnostic = await win.webContents.executeJavaScript("JSON.stringify(window.__aikaInteractiveRegionProbe?.() ?? null)");
      throw Error('A pointer on the open drawer must stop click-through, but the window still ignores the mouse; regionProbe=' + diagnostic + ' shellRegions=' + JSON.stringify(interactiveRegions));
    }
    await win.webContents.executeJavaScript("window.desktopHost.postMessage('shell',{type:'set_click_through',enabled:false})");
    // DUX-01: an explicit collapse is separate from quitting. `hide_to_tray` hides the window while the
    // process and tray stay alive, and the tray can restore it.
    await win.webContents.executeJavaScript("window.desktopHost.postMessage('shell',{type:'hide_to_tray'})");
    await new Promise(done => setTimeout(done, 300));
    if (!win.isDestroyed() && win.isVisible()) throw Error('An explicit hide_to_tray must hide the window while keeping the pet alive');
    desktopTray.show();
    if (!win.isDestroyed() && !win.isVisible()) throw Error('Tray restore must show the existing pet window');
    desktopTray.hide();
    if (!win.isDestroyed() && win.isVisible()) throw Error('Tray hide must remove the visible pet window');
    console.log(`WINDOWS_SMOKE_OK: appearance-gated renderer (no preload, no loading cover), isolated preload, backend round trip, panel layout, ${regionCount} interactive region root(s), close-to-tray and explicit tray collapse/restore.`);
    if (option('--screenshot')) {
      win.showInactive();
      await new Promise(done => setTimeout(done, 600));
      const visible = await win.webContents.executeJavaScript("!document.getElementById('drawer').hidden && getComputedStyle(document.getElementById('drawer')).opacity === '1'");
      if (!visible) throw Error('Chat drawer is not visible');
      await writeFile(resolve(option('--screenshot')), (await win.webContents.capturePage()).toPNG());
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  app.quit();
}
}).catch(error => { console.error(error.message); app.exit(1); });

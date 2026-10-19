// FIX61-11 shell token: the REAL host process, driven through its REAL function panel.
//
// `desktop/electron/main.mjs` is imported unmodified and at MODULE SCOPE, exactly as `tools/dev-desktop.mjs`
// and `app/trial-launcher.ts` launch it — the host registers the privileged `pet://` scheme at module scope
// and Electron refuses that after readiness. This module only (a) points the process at a throwaway
// app-data directory, (b) replaces `shell.openExternal` with a recorder, because a test machine must not
// really launch a browser, and (c) clicks the production panel buttons in the production renderer.
// Everything between that click and the recorded URL — the isolated preload channel, the `open_management`
// case, the route guard, the management-session check and the URL composition itself — is production code.
//
// Every recorded URL is then loaded in a real Chromium window together with the real console page, so the
// assertion is made on the DOM the user would actually see, not on the URL string alone.
import { app, BrowserWindow, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { restrictPrivatePathSync } from '../../dist/core/platform-files.js';

const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
const request = decode(process.argv[2]);
const REPORT = 'SHELL_TOKEN_RESULT=';
const pet = new URL('../../', import.meta.url);

// Before the host is imported: its module scope reads these launch options and resolves its user-data
// directory from appData, so both must already be in place.
app.setPath('appData', resolve(request.temp, 'appData'));
app.disableHardwareAcceleration();
process.argv.push('--root', resolve(request.desktopRoot), '--node', process.execPath, '--backend', resolve(request.previewBackend));

const opened = [], waiters = [];
shell.openExternal = url => {
  const value = String(url);
  if (waiters.length) waiters.shift()(value); else opened.push(value);
  return Promise.resolve(true);
};

// THE production host, unmodified.
await import(new URL('desktop/electron/main.mjs', pet).href);

const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await Promise.resolve(check()).catch(() => undefined);
    if (value) return value;
    await wait(50);
  }
  throw new Error('timed out waiting for ' + label);
}

/** Load one composed URL against the real console page and report what its DOM contains. */
async function consoleFacts(url) {
  const probeWindow = new BrowserWindow({
    show: false, paintWhenInitiallyHidden: true, width: 1280, height: 1000,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    await probeWindow.loadURL(url);
    let result;
    for (let attempt = 0; attempt < 300; attempt++) {
      result = await probeWindow.webContents.executeJavaScript("document.querySelector('#console-result[data-complete=true]')?.textContent");
      if (result) break;
      await wait(50);
    }
    if (!result) {
      const diagnostic = await probeWindow.webContents.executeJavaScript("JSON.stringify({ hash: location.hash, h1: document.querySelector('h1')?.textContent ?? null, html: document.body.innerHTML.slice(0, 300) })");
      return { url, error: 'UI timeout', diagnostic };
    }
    return { url, ...JSON.parse(result) };
  } finally { probeWindow.destroy(); }
}

// Registered AFTER the host, so the host's own ready handler runs first and its window exists by the time
// this one resumes.
void app.whenReady().then(async () => {
  const results = [];
  try {
    // The real, private session descriptor the backend would have written for this running instance. It is
    // created here only because this runner stands in for the backend; the descriptor's shape, its
    // permissions and every check the opener performs on it are production.
    await mkdir(dirname(request.sessionFile), { recursive: true });
    await writeFile(request.sessionFile, JSON.stringify({ version: 1, pid: process.pid, instanceId: request.instanceId,
      sourceRevision: request.sourceRevision, url: request.origin + '/#token=' + request.token }) + '\n');
    // `tools/management-url.mjs` refuses a session file without private permissions on Windows.
    restrictPrivatePathSync(request.sessionFile);
    process.env.PET_TRIAL_CONFIG = resolve(request.configFile);

    // `petWindow` is this runner's handle on the REAL desktop window. It must not be called `window`:
    // inside an executeJavaScript string a bare `window` is evaluated in the PAGE, which shadows this
    // module's own binding and silently produced confusing diagnostics during RWR-10-02.
const petWindow = await until(() => BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()), 'the desktop window');
    petWindow.hide();

    // RWR-10-02: the right-click function panel no longer exists. The console-open actions live in the
    // drawer's 「⋯」 menu, so open the drawer, expand the menu, and click the real menu entries. Those
    // entries are rendered by the production renderer from `drawerMenuEntries`.
    //
    // Two renderer behaviours must not be raced against each other:
    //   `#open` OPENS the drawer through an animation, so `drawer.hidden` is still true on the same tick;
    //   the drawer must therefore be confirmed on a LATER poll before the menu is touched.
    //   `#drawer-settings` TOGGLES the menu, so it may only be clicked while the menu is closed —
    //   clicking it again while the menu is open would collapse it.
    const showEntry = async entryId => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const state = await petWindow.webContents.executeJavaScript(
          "(() => ({ drawerHidden: document.getElementById('drawer').hidden,"
          + " menuOpen: !!document.getElementById('drawer-more-menu'),"
          + " entry: !!document.getElementById('menu-" + entryId + "') }))()",
        );
        if (state.entry) return true;
        if (state.drawerHidden) await petWindow.webContents.executeJavaScript("document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))");
        else if (!state.menuOpen) await petWindow.webContents.executeJavaScript("document.getElementById('drawer-settings').click()");
        await wait(50);
      }
      return false;
    };
    for (const entry of request.entries) {
      if (!await showEntry(entry.id)) throw new Error('the ' + entry.id + ' menu entry never appeared');
      await petWindow.webContents.executeJavaScript("document.getElementById('menu-" + entry.id + "').click()");
      const url = await Promise.race([
        waiters.length ? Promise.resolve(waiters.shift()) : opened.length ? Promise.resolve(opened.shift()) : new Promise(resolve => waiters.push(resolve)),
        wait(30000).then(async () => {
          // Report the renderer state rather than a bare timeout: whether the entry is still present and
          // which menu entries exist is what distinguishes "the click did nothing" from "the host refused".
          const state = await petWindow.webContents.executeJavaScript(
            "(() => { const node = id => document.getElementById(id); const drawer = node('drawer');"
            + " return JSON.stringify({ entryPresent: !!node('menu-" + entry.id + "'),"
            + " drawerHidden: drawer ? drawer.hidden : 'no drawer',"
            + " menuEntries: [...document.querySelectorAll('#drawer-more-menu [role^=menuitem]')].map(n => n.id) }); })()",
          ).catch(error => 'probe failed: ' + String(error));
          throw new Error('the shell never opened a URL for the ' + entry.id + ' entry; renderer=' + state
            + '; opened=' + JSON.stringify(opened) + '; waiters=' + waiters.length);
        }),
      ]);
      results.push({ entry: entry.id, ...(await consoleFacts(url)) });
    }
    console.log(REPORT + JSON.stringify(results));
  } catch (error) {
    console.log(REPORT + JSON.stringify({ error: error.message, opened }));
    process.exitCode = 1;
  } finally {
    // The host's `before-quit` handler keeps the process alive for backend cleanup; this runner is a
    // protocol recorder, so it ends deterministically instead.
    app.exit(process.exitCode ?? 0);
  }
}).catch(error => { console.error(error); app.exit(1); });

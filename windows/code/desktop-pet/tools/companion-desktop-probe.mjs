// Runs inside real Electron, imports the same host used by book-launcher, never the user's instance.
import { app, BrowserWindow, screen } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const opt = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const result = { mode: opt('--probe-mode'), checks: [], samples: [], startedAt: new Date().toISOString() };
const evidence = opt('--probe-evidence'), duration = Number(opt('--probe-duration'));
let failed = false;
async function run() {
try {
  await import('../desktop/electron/main.mjs');
  await app.whenReady();
  const windowDeadline = Date.now() + 15000;
  while (!BrowserWindow.getAllWindows().length && Date.now() < windowDeadline) await new Promise(done => setTimeout(done, 100));
  const windows = BrowserWindow.getAllWindows(); assert.equal(windows.length, 1, 'isolated host owns exactly one desktop window');
  const win = windows[0];
  const evaluate = script => win.webContents.executeJavaScript(script);
  const waitFor = async (script, label, ms = 15000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await evaluate(script)) return; await new Promise(done => setTimeout(done, 100)); }
    throw Error(label + ': ' + await evaluate("document.getElementById('status').textContent"));
  };
  await waitFor('window.__aikaCompanionProbe?.().life && window.__aikaAppearanceProbe?.().appearanceReady', 'default Book composition/appearance/life');
  win.setFocusable(false); win.showInactive(); await waitFor('!window.__aikaCompanionProbe().hidden', 'visible');
  const probe = () => evaluate('window.__aikaCompanionProbe()');
  const mark = (name, details = {}) => result.checks.push({ name, passed: true, ...details });
  const menu = async prefix => {
    await evaluate("if(document.getElementById('drawer').hidden)document.getElementById('model').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));if(!document.getElementById('drawer-more-menu'))document.getElementById('drawer-settings').click();");
    await evaluate(`(()=>{const button=Array.from(document.querySelectorAll('#drawer-more-menu [role^=menuitem]')).find(b=>b.textContent.startsWith(${JSON.stringify(prefix)}));if(!button)throw Error('Missing control');button.click()})()`);
  };
  result.hostUserData = app.getPath('userData');
  if (result.mode === 'recovery') {
    const savedPreferences = JSON.parse(readFileSync(join(app.getPath('userData'), 'windows-display.json'), 'utf8'));
    const restored = await probe();
    assert.equal(restored.life.quiet, true); assert.equal(restored.life.enabled, true); assert.equal(restored.muted, true);
    assert.ok(restored.life.mood > 55); assert.equal(savedPreferences.replySound, false);
    assert.equal(savedPreferences.width, 260);
    mark('new host process restores Book life and durable host mute/size', { mood: restored.life.mood, preferenceRevision: savedPreferences.revision });
  } else if (result.mode === 'baseline') {
    await menu('自主活动'); await waitFor('!window.__aikaCompanionProbe().life.enabled', 'disabled baseline');
  } else {
    assert.equal(win.isAlwaysOnTop(), true); mark('transparent/always-on-top host', { transparent: win.getBackgroundColor() });
    const initial = await probe(); assert.equal(initial.renderer.runtime, 'SpriteCanvas'); assert.deepEqual(initial.capabilities, []); mark('declared dynamic clips loaded');
    await menu('免打扰'); await waitFor('window.__aikaCompanionProbe().life.quiet', 'quiet control');
    assert.equal((await probe()).life.enabled, true); mark('quiet keeps autonomous life running');
    await menu('自主活动'); await waitFor('!window.__aikaCompanionProbe().life.enabled', 'pause control'); mark('pause autonomous activity');
    await menu('自主活动'); await waitFor('window.__aikaCompanionProbe().life.enabled', 'resume control');
    await menu('回复声音'); await waitFor('window.__aikaCompanionProbe().muted', 'mute control'); mark('mute effective');
    await evaluate("if(!document.getElementById('drawer-more-menu'))document.getElementById('drawer-settings').click()");
    await waitFor("!!document.getElementById('drawer-more-menu')?.getBoundingClientRect().width", 'visible controls');
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    writeFileSync(evidence.replace(/\.json$/, '-controls.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate("document.getElementById('close').click()");
    const beforeTouch = (await probe()).life.mood;
    const point = await evaluate("(()=>{const r=document.getElementById('model').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await waitFor(`window.__aikaCompanionProbe().life.mood>${beforeTouch + 10}`, 'production pointer touch');
    await waitFor("window.__aikaCompanionProbe().presentation.characterState==='happy'", 'touch expression'); mark('touch mood/animation through production pointer route');
    const scope = await probe(); assert.equal(scope.life.pairingId, 'local-user');
    await menu('收起到系统托盘'); await waitFor('window.__aikaCompanionProbe().hidden', 'hidden');
    assert.equal(win.isVisible(), false); mark('hide suppresses output'); win.showInactive();
    await waitFor('!window.__aikaCompanionProbe().hidden', 'restore');
    await evaluate("document.getElementById('close').click()");
    await evaluate("window.desktopHost.postMessage('shell',{type:'drag',dx:-1900,dy:-1900});window.desktopHost.postMessage('shell',{type:'drag_end'})");
    await new Promise(done => setTimeout(done, 300));
    const area = screen.getDisplayMatching(win.getBounds()).workArea, bounds = win.getBounds();
    assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width + 1 && bounds.y + bounds.height <= area.y + area.height + 1);
    mark('drag clamp/snap and focus-safe bounds', { area, bounds });
    const currentWidth = bounds.width;
    await evaluate("window.desktopHost.postMessage('shell',{type:'resize_model',phase:'begin'});window.desktopHost.postMessage('shell',{type:'resize_model',phase:'update',width:260});window.desktopHost.postMessage('shell',{type:'resize_model',phase:'commit',width:260})");
    await new Promise(done => setTimeout(done, 300));
    assert.notEqual(win.getBounds().width, currentWidth); mark('production model resize');
    await evaluate("window.desktopHost.postMessage('shell',{type:'set_click_through',enabled:true})");
    await waitFor('window.__aikaClickThroughProbe===true', 'click-through'); mark('host click-through enabled');
    await evaluate("window.desktopHost.postMessage('shell',{type:'set_click_through',enabled:false})");
    const beforeRestart = await probe();
    await menu('快速重启');
    await waitFor(`window.__aikaCompanionProbe().connectionGeneration>${beforeRestart.connectionGeneration} && window.__aikaCompanionProbe().connected && window.__aikaCompanionProbe().life?.quiet===true && window.__aikaCompanionProbe().muted===true`, 'life/control restart recovery', 25000);
    assert.ok((await probe()).life.mood > 60); mark('default backend restart restores mood/quiet and host mute');
  }
  await evaluate("if(!document.getElementById('drawer').hidden)document.getElementById('close').click()");
  // Controls are driven without stealing the user's focus; idle movement is tested with the real
  // production focusable setting restored, so setFocusable(false) cannot mask a focus regression.
  win.setFocusable(true); win.blur();
  // Resource comparison runs without interaction, with the same original sprite and local fixture.
  const begin = Date.now(); let previousAt = begin, previousFrames = (await probe()).frames;
  const management = JSON.parse(readFileSync(join(process.env.AIKI_BOOK_DATA, 'management-session.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(management.pid) && management.pid > 0);
  let lastBackendCpu = null;
  const sample = async () => {
    const now = Date.now(), state = await probe(), metrics = app.getAppMetrics();
    const backend = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${management.pid} | Select-Object CPU,WorkingSet64 | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
    const backendCpuPercent = lastBackendCpu === null ? null : (backend.CPU - lastBackendCpu) * 100000 / Math.max(1, now - previousAt);
    lastBackendCpu = backend.CPU;
    result.samples.push({ elapsedMs: now - begin, cpuPercent: metrics.reduce((n, m) => n + m.cpu.percentCPUUsage, 0),
      rssMiB: metrics.reduce((n, m) => n + (m.memory?.workingSetSize ?? 0), 0) / 1024,
      backendRssMiB: backend.WorkingSet64 / 1048576, backendCpuPercent,
      framesPerSecond: (state.frames - previousFrames) * 1000 / Math.max(1, now - previousAt), activity: state.life.activity,
      focused: win.isFocused(), focusable: win.isFocusable(), rendererState: state.renderer.characterState, frame: state.renderer.frame, bounds: win.getBounds() });
    previousAt = now; previousFrames = state.frames;
    writeFileSync(evidence, JSON.stringify({ ...result, running: true }, null, 2));
  };
  while (Date.now() - begin < duration) { await new Promise(done => setTimeout(done, Math.min(10000, duration - (Date.now() - begin)))); await sample(); }
  await writeFileSync(evidence.replace(/\.json$/, '.png'), (await win.webContents.capturePage()).toPNG());
  result.elapsedMs = Date.now() - begin; result.finishedAt = new Date().toISOString();
  result.finalState = await probe(); result.backendIdentity = { pid: management.pid, instanceId: management.instanceId, sourceRevision: management.sourceRevision };
  console.log('COMPANION_DESKTOP_PROBE_OK ' + JSON.stringify({ durationMs: result.elapsedMs, checks: result.checks.length, samples: result.samples.length }));
} catch (error) { failed = true; result.error = error.stack; console.error(error.stack); }
finally {
  writeFileSync(evidence, JSON.stringify({ ...result, running: false, failed }, null, 2));
  process.exitCode = failed ? 1 : 0; app.quit();
}
}
// Do not await app.whenReady at Electron's ESM top level: that delays the ready event itself.
void run();

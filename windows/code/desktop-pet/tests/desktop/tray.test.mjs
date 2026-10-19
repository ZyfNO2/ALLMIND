import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installTray } from '../../desktop/electron/tray.mjs';

// Window close keeps the process alive; only tray exit starts application shutdown.
test('explicit collapse hides to tray, double click restores, exit menu truly quits', () => {
  const app = new EventEmitter(), win = new EventEmitter();
  let visible = true, skip = false, destroyed = false, quitCalls = 0;
  win.isDestroyed = () => false; win.hide = () => visible = false; win.show = () => visible = true;
  win.setSkipTaskbar = value => skip = value; win.focus = () => {};
  app.quit = () => { quitCalls++; app.emit('before-quit'); };
  class Tray extends EventEmitter { setToolTip() {} setContextMenu(menu) { this.menu = menu; } destroy() { destroyed = true; } }
  let menu;
  const lifecycle = installTray({ app, win, Tray, icon: {}, Menu: { buildFromTemplate: value => menu = value } });
  // An explicit collapse is NOT a close event: the window is hidden, the process and tray stay alive.
  lifecycle.hide();
  assert.equal(visible, false); assert.equal(skip, true);
  lifecycle.show(); assert.equal(visible, true); assert.equal(skip, false);
  let toggled = false;
  lifecycle.setCompanionMenu([{ label: '自主活动', click: () => { toggled = true; } }]);
  menu.find(item => item.label === '自主活动').click(); assert.equal(toggled, true);
  // The only quit entry is the tray menu, labeled with the current product name.
  const exitItem = menu.find(item => item.label === '退出 ALLMIND');
  assert.ok(exitItem, 'the tray menu must offer a real quit');
  exitItem.click();
  assert.equal(quitCalls, 1, 'the tray exit must really call app.quit');
  app.emit('will-quit'); assert.ok(destroyed);
});

test('window close hides to tray, while an explicit application quit permits window destruction', () => {
  const app = new EventEmitter(), win = new EventEmitter();
  let visible = true, skip = false, destroyed = false, quitCalls = 0, prevented = false;
  win.isDestroyed = () => false; win.hide = () => visible = false; win.show = () => visible = true;
  win.setSkipTaskbar = value => skip = value; win.focus = () => {};
  app.quit = () => { quitCalls++; app.emit('before-quit'); };
  class Tray extends EventEmitter { setToolTip() {} setContextMenu(menu) { this.menu = menu; } destroy() { destroyed = true; } }
  installTray({ app, win, Tray, icon: {}, Menu: { buildFromTemplate: value => value } });
  // A normal close retains the process, backend and tray.
  win.emit('close', { preventDefault: () => prevented = true });
  assert.equal(prevented, true, 'close must hide rather than destroy the window');
  assert.equal(visible, false); assert.equal(skip, true);
  assert.equal(quitCalls, 0, 'close must not shut down the backend');
  assert.equal(destroyed, false);
  app.quit(); prevented = false;
  win.emit('close', { preventDefault: () => prevented = true });
  assert.equal(prevented, false, 'tray quit must not be trapped in close-to-hide');
  assert.equal(quitCalls, 1);
});

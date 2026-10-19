/** Current contract: close hides, tray restores, tray exit really shuts down. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installTray } from '../../desktop/electron/tray.mjs';

test('DUX-01 契约：tray 拦截窗口 close，显式收起仍可恢复', () => {
  const app = new EventEmitter(), win = new EventEmitter();
  let visible = true, skip = false, destroyed = false, prevented = false;
  win.isDestroyed = () => false; win.hide = () => visible = false; win.show = () => visible = true;
  win.setSkipTaskbar = value => skip = value; win.focus = () => {};
  class Tray extends EventEmitter { setToolTip() {} setContextMenu(menu) { this.menu = menu; } destroy() { destroyed = true; } }
  installTray({ app, win, Tray, icon: {}, Menu: { buildFromTemplate: value => value } });
  win.emit('close', { preventDefault: () => prevented = true });
  assert.equal(prevented, true, 'close keeps the window alive in the tray');
  assert.equal(visible, false, 'closed window is hidden'); assert.equal(skip, true);
  assert.equal(destroyed, false);
});

test('DUX-01 契约：托盘菜单为 Aika 且提供真正退出；AIKI 旧名清除', () => {
  const app = new EventEmitter(), win = new EventEmitter();
  let quitCalls = 0;
  win.isDestroyed = () => false; win.hide = () => {}; win.show = () => {}; win.setSkipTaskbar = () => {}; win.focus = () => {};
  app.quit = () => { quitCalls++; app.emit('before-quit'); };
  class Tray extends EventEmitter { setToolTip() {} setContextMenu(menu) { this.menu = menu; } destroy() {} }
  let menu;
  installTray({ app, win, Tray, icon: {}, Menu: { buildFromTemplate: value => menu = value } });
  const labels = menu.filter(item => item.label).map(item => item.label);
  assert.deepEqual(labels, ['显示桌宠', '收起到系统托盘', '退出 ALLMIND'], `托盘菜单标签：${labels.join(' / ')}`);
  menu.find(item => item.label === '退出 ALLMIND').click();
  assert.equal(quitCalls, 1, '托盘退出 = app.quit');
  const traySource = readFileSync(resolve(import.meta.dirname, '../../desktop/electron/tray.mjs'), 'utf8');
  assert.doesNotMatch(traySource, /AIKI/, 'tray.mjs 不得再出现 AIKI 旧名');
});

test('DUX-01 契约：main.mjs 的 quit/hide_to_tray 意图分离；smoke 已适配', () => {
  const main = readFileSync(resolve(import.meta.dirname, '../../desktop/electron/main.mjs'), 'utf8');
  assert.match(main, /case 'quit':\s*desktopTray\?\.hide\(\);/, "legacy shell 'quit' keeps running in the tray");
  assert.match(main, /case 'hide_to_tray':\s*desktopTray\?\.hide\(\);/, "shell 'hide_to_tray' 意图 = 显式收起");
  assert.doesNotMatch(main, /label: '退出 ALLMIND', click: \(\) => app\.quit\(\)/, 'real exit is exposed only by the tray');
  assert.doesNotMatch(main, /Closing the window must hide it without destroying the pet/, '旧 close=hide smoke 断言已随契约适配');
  // DUX-06 前置：主进程产品名当前仍是 AAAAGENT（在 DUX-06 改），此处只钉住退出路径已换 Aika。
  assert.match(main, /label: 'ALLMIND', submenu:/, '应用菜单顶层名已为 Aika');
});

test('DUX-00 历史基线：数据隔离例外保留（LEGACY_DATA_ROOT 仍为 AAAAGENT）', () => {
  const ns = readFileSync(resolve(import.meta.dirname, '../../core/next-namespace.ts'), 'utf8');
  assert.match(ns, /LEGACY_DATA_ROOT = 'AAAAGENT'/, '旧库隔离保护保留 AAAAGENT 原值（合法例外，不在清除范围）');
});

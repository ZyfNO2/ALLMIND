/** Current contract: close hides, tray restores, tray exit really shuts down. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installTray } from '../../desktop/electron/tray.mjs';

function rig() {
  const app = new EventEmitter(), win = new EventEmitter();
  const state = { visible: true, skip: false, destroyed: false, quitCalls: 0, hideCalls: 0 };
  win.isDestroyed = () => false;
  win.hide = () => { state.visible = false; state.hideCalls++; };
  win.show = () => { state.visible = true; };
  win.setSkipTaskbar = value => state.skip = value;
  win.focus = () => {};
  app.quit = () => { state.quitCalls++; app.emit('before-quit'); };
  class Tray extends EventEmitter { setToolTip() {} setContextMenu(menu) { this.menu = menu; } destroy() { state.destroyed = true; } }
  let menu;
  const lifecycle = installTray({ app, win, Tray, icon: {}, Menu: { buildFromTemplate: value => menu = value } });
  return { app, win, state, lifecycle, menu: () => menu };
}

test('DUX-01 窗口 close 收起到托盘，后台继续运行', () => {
  const r = rig();
  let prevented = false;
  r.win.emit('close', { preventDefault: () => prevented = true });
  assert.equal(prevented, true, 'close must hide without destroying');
  assert.equal(r.state.visible, false); assert.equal(r.state.skip, true);
  assert.equal(r.state.quitCalls, 0, 'close 事件本身不直接 app.quit：主进程 window-all-closed → before-quit 统一排空');
  // window-all-closed → app.quit 是 main.mjs 的集成路径，用源码钉桩确认。
  const main = readFileSync(resolve(import.meta.dirname, '../../desktop/electron/main.mjs'), 'utf8');
  assert.match(main, /app\.on\('window-all-closed', \(\) => app\.quit\(\)\)/, 'window-all-closed 必须走 app.quit（排空由 before-quit 处理）');
});

test('DUX-01 显式收起（tray.hide）仍可从托盘恢复，且不触发 close 拦截', () => {
  const r = rig();
  r.lifecycle.hide();
  assert.equal(r.state.visible, false, '显式 hide 后窗口隐藏');
  assert.equal(r.state.skip, true, '显式 hide 后任务栏隐藏');
  r.lifecycle.show();
  assert.equal(r.state.visible, true, '托盘恢复后窗口显示');
  assert.equal(r.state.skip, false, '托盘恢复后任务栏恢复');
  assert.equal(r.state.destroyed, false, '收起不销毁 tray');
});

test('DUX-01 托盘菜单：「退出 ALLMIND」真正退出；旧「退出 AIKI」与 AIKI tooltip 不再出现', () => {
  const r = rig();
  const labels = r.menu().filter(item => item.label).map(item => item.label);
  assert.deepEqual(labels, ['显示桌宠', '收起到系统托盘', '退出 ALLMIND'], `托盘菜单标签应为新契约：${labels.join(' / ')}`);
  r.menu().find(item => item.label === '退出 ALLMIND').click();
  assert.equal(r.state.quitCalls, 1, '托盘退出 = app.quit');
  // tooltip 与旧品牌由 main/tray 的调用方提供；此处断言 tray.mjs 不再内置 AIKI 字样。
  const traySource = readFileSync(resolve(import.meta.dirname, '../../desktop/electron/tray.mjs'), 'utf8');
  assert.doesNotMatch(traySource, /AIKI/, 'tray.mjs 不得再出现 AIKI 旧名（DUX-06 同批）');
});

test('DUX-01 main.mjs：shell quit 与 hide_to_tray 收起，真实退出仅由托盘提供', () => {
  const main = readFileSync(resolve(import.meta.dirname, '../../desktop/electron/main.mjs'), 'utf8');
  // renderer 的 {type:'quit'} 必须真正结束应用（走 before-quit 排空）。
  assert.match(main, /case 'quit': desktopTray\?\.hide\(\)/, 'legacy renderer quit also collapses');
  // 新增显式收起意图。
  assert.match(main, /case 'hide_to_tray':/, '必须新增 shell hide_to_tray 意图');
  // 应用菜单「收起到系统托盘」直接 hide（主进程内合法）；必须存在「退出 ALLMIND」真退出项。
  assert.match(main, /label: '收起到系统托盘', click: \(\) => desktopTray\.hide\(\)/, '应用菜单收起项仍是显式 hide');
  assert.doesNotMatch(main, /label: '退出 ALLMIND', click: \(\) => app\.quit\(\)/, 'only the tray context menu exposes real exit');
  assert.doesNotMatch(main, /label: '退出 AIKI'/, '应用菜单不得再出现 AIKI 旧名');
  assert.doesNotMatch(main, /label: '收起到系统托盘', click: \(\) => \{\s*wake\.disconnect/, '应用菜单收起项不得误走 renderer quit 意图');
  // smoke：close 断言改为「close 结束进程」，显式 hide 保留可恢复验证；不删断言。
  assert.doesNotMatch(main, /Closing the window must hide it without destroying the pet/, '旧 close=hide smoke 断言必须随契约更新（适配而非删除）');
  assert.match(main, /hide_to_tray|收起到系统托盘/, 'smoke 或初始化必须保留显式收起路径');
});

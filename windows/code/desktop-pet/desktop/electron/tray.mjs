/**
 * 系统托盘：显示/收起桌宠与真正的应用退出。
 *
 * 窗口关闭只收起，后台与托盘继续运行；托盘退出触发 before-quit，允许窗口真正关闭。
 */
export function installTray({ app, win, Tray, Menu, icon, onHide = () => {} }) {
  const tray = new Tray(icon);
  const show = () => { if (!win.isDestroyed()) { win.show(); win.setSkipTaskbar(false); win.focus(); } };
  const hide = () => { onHide(); win.setSkipTaskbar(true); win.hide(); };
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  win.on('close', event => { if (!quitting) { event.preventDefault(); hide(); } });
  tray.setToolTip('ALLMIND');
  const setCompanionMenu = (items = []) => tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示桌宠', click: show },
    { label: '收起到系统托盘', click: hide },
    ...items,
    { type: 'separator' },
    { label: '退出 ALLMIND', click: () => app.quit() },
  ]));
  setCompanionMenu();
  tray.on('double-click', show);
  app.on('will-quit', () => tray.destroy());
  return { show, hide, setCompanionMenu };
}

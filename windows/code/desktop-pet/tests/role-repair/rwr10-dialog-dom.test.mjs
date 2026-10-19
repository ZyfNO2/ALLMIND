import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * RWR-10-02: the chat dialog was reduced to role/status title, 「⋯」/close, messages, the composer, and an
 * in-frame size panel. These assertions read the PRODUCTION files, so a control that comes back — or a
 * handler that still dereferences a removed node — fails here instead of at runtime with a null error.
 */
const read = file => readFileSync(resolve(process.cwd(), file), 'utf8');
const html = read('desktop/index.html');
const renderer = read('desktop/main.mjs');
const workCard = read('desktop/work-card.mjs');
const displayControls = read('desktop/display-controls.mjs');

/** AC-02-1: the removed controls must be GONE from the markup, not merely hidden. */
test('RWR-10-02: the dialog no longer contains the hotkey strip, the bottom tool row, or the function panel', () => {
  for (const id of ['hotkey-settings', 'hotkey-value', 'hotkey-bind', 'hotkey-clear',
    'drawer-tools', 'sound-toggle', 'voice-toggle', 'voice', 'hint', 'quit',
    'function-panel', 'function-entries', 'function-close', 'function-notice']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} must not exist in the dialog markup`);
  }
  // The Enter hint survives as the input's title, per the requirement that it leaves the permanent footer.
  assert.match(html, /id="text"[^>]*title="Enter 发送 · Shift\+Enter 换行"/, 'the Enter hint is now the input title');
});

/** AC-02-1: Enter/Shift+Enter behaviour is unchanged even though the hint moved. */
test('RWR-10-02: Enter sends and Shift+Enter still inserts a newline', () => {
  assert.match(renderer, /if \(!event\.shiftKey\) \{ event\.preventDefault\(\); \$\('form'\)\.requestSubmit\(\); \}/,
    'plain Enter still submits the composer');
  assert.match(renderer, /if \(event\.key !== 'Enter'\) return;/, 'other keys are left to the textarea');
  assert.match(renderer, /event\.keyCode === 229/, 'IME composition is still honoured');
});

/** AC-02-1: no handler may keep dereferencing a removed node, which would throw on load. */
test('RWR-10-02: the renderer never dereferences a removed control', () => {
  for (const id of ['hotkey-bind', 'hotkey-clear', 'hotkey-value', 'function-close', 'function-entries',
    'function-notice', 'sound-toggle']) {
    assert.doesNotMatch(renderer, new RegExp(`\\$\\('${id}'\\)`), `$('${id}') would throw on the deleted node`);
  }
  // The `#quit` button moved into the menu, so the menu owns the quit command instead of a DOM handler.
  assert.doesNotMatch(renderer, /\$\('quit'\)\.onclick/, 'quit is no longer bound to a deleted button');
  assert.match(renderer, /id: 'quit', label: '退出桌宠'/, 'quit is now a menu entry');
});

/** AC-02-1: the two always-on task buttons and their empty strip are gone; history stays reachable. */
test('RWR-10-02: the always-on task buttons are removed but the records dialog still has a way in', () => {
  assert.doesNotMatch(workCard, /work-reopen/, 'the 查看任务与输入 button is gone');
  assert.doesNotMatch(workCard, /work-records-open/, 'the 工程记录 button is gone from the bottom strip');
  assert.doesNotMatch(workCard, /recordsButton/, 'the shared records-button factory is gone');
  // The badge is the remaining entry point: it opens the records dialog when no task is in progress.
  assert.match(workCard, /this\.onRecords\?\.\(badge\)/, 'the status badge still opens the records dialog');
  // Real task confirmation must survive; only the entry that reopened a task was removed.
  for (const id of ['work-confirm', 'work-dismiss', 'work-replan', 'work-edit']) {
    assert.ok(workCard.includes(`'${id}'`), `${id} is a real task control and must remain`);
  }
});

/** AC-02-2: the right button is consumed and produces nothing. */
test('RWR-10-02: the renderer consumes the context menu and never toggles a panel', () => {
  assert.match(renderer, /oncontextmenu = e => \{ e\.preventDefault\(\); pointerRouter\.contextMenu\(e\); \}/,
    'the context menu is still suppressed so the browser does not show its own');
  const router = read('desktop/pointer-router.ts');
  const contextMenu = /contextMenu\(event: PointerSample\): void \{[\s\S]*?\n  \}/.exec(router)?.[0] ?? '';
  assert.doesNotMatch(contextMenu, /handlers\.panel/, 'the right button must not open any panel');
  assert.match(contextMenu, /#rightConsumed = true/, 'the right press is still consumed');
  // The panel catalog is removed with the panel; the ⋯ menu is the single entry point.
  // Comments may still NAME the deleted symbol to explain the removal, so strip them before asserting.
  const routerCode = router.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(routerCode, /PANEL_ENTRIES/, 'the right-click panel catalog is deleted');
  assert.doesNotMatch(renderer, /PANEL_ENTRIES/, 'the renderer no longer imports the deleted catalog');
});

/** AC-02-3: the size panel is a real in-frame control wired to the host shell commands. */
test('RWR-10-02: the size panel exists in-frame and drives the host resize commands', () => {
  assert.match(html, /id="size-panel"/, 'the in-frame size panel exists');
  // Attribute order in the markup puts `type` before `id`, so match the element, not one fixed order.
  assert.match(html, /<input type="range" id="model-size"[^>]*>/, 'the slider is a real range input');
  assert.match(html, /id="model-size"[^>]*min="220"[^>]*max="720"/, 'the slider uses the frozen 220..720 range');
  assert.match(html, /id="view-full"/, 'the full-body control is a real button');
  assert.match(html, /id="view-half"/, 'the half-body control is a real button');
  assert.match(html, /id="model-size-reset"/, 'restore-default is a real control');

  // A mode change must go through set_display, not a half-filled object into receive().
  assert.doesNotMatch(renderer, /display\.receive\(\{ \.\.\.display\.mode/, 'the half-object mode bug is gone');
  assert.match(displayControls, /shell\(\{ type: 'set_display', mode \}\)/, 'mode changes use the real shell command');
  for (const phase of ['begin', 'update', 'commit', 'cancel']) {
    assert.ok(displayControls.includes(`phase: '${phase}'`), `resize_model ${phase} is used`);
  }
  assert.match(displayControls, /Math\.min\(720, Math\.max\(220/, 'the 220..720 clamp is applied');
});

/** AC-02-3: the slider shows intent, the host's acknowledgement decides what is applied. */
test('RWR-10-02: the slider and readout track the requested width, not the fitted size', () => {
  assert.match(displayControls, /sizeSlider\.value = String\(Math\.round\(value\.preferredWidth\)\)/,
    'the slider follows the user intent (preferredWidth)');
  assert.match(displayControls, /'character'\)\.style\.width = `\$\{value\.modelWidth\}px`/,
    'the model is actually sized from the host acknowledgement (modelWidth)');
});

/** AC-02-1: Escape cancels an uncommitted resize and closes the menu before the drawer. */
test('RWR-10-02: Escape closes the menu, then the size panel, without cancelling an active turn first', () => {
  assert.match(renderer, /if \(drawerMenuOpen\) \{ e\.preventDefault\(\); closeDrawerMenu\(\); return; \}/,
    'Escape closes the ⋯ menu first');
  assert.match(renderer, /if \(display\.panelOpen\) \{ e\.preventDefault\(\); display\.setPanelOpen\(false\); renderDrawerMenu\(\); return; \}/,
    'Escape then closes the size panel');
  assert.match(renderer, /if \(e\.key === 'Escape' && display\.cancel\(e\)\) return;/,
    'an in-flight drag is still cancelled first');
});

/** AC-02-3: the ⋯ menu is the single entry point and every entry does something real. */
test('RWR-10-02: the ⋯ menu is the single low-frequency entry point', () => {
  assert.match(renderer, /function drawerMenuEntries\(\)/, 'the menu has one entry list');
  for (const id of ['console', 'size', 'mode', 'greeting', 'voice', 'sound', 'quit']) {
    assert.match(renderer, new RegExp(`id: '${id}'`), `the ${id} entry exists`);
  }
  // One menu only: the earlier inline ⋯ block and its toast-only size entry must not return.
  assert.doesNotMatch(renderer, /拖动模型下沿的圆形手柄/, 'the toast-only size hint is gone');
  assert.match(renderer, /function toggleDrawerMenu\(\)/, 'the menu has one open/close implementation');
  assert.match(renderer, /\$\('drawer-settings'\)\?\.addEventListener\('click', event => \{ event\.stopPropagation\(\); toggleDrawerMenu\(\); \}\)/,
    'the header ⋯ button opens that menu');
});

/** AC-02-4: the deleted CSS must not linger, and the panel must be styled inside the drawer. */
test('RWR-10-02: the stylesheet follows the markup', () => {
  const css = read('desktop/style.css');
  for (const id of ['#function-panel', '#function-entries', '#function-notice', '#drawer-tools',
    '#hotkey-settings', '#voice-toggle', '#sound-toggle', '#display-controls']) {
    assert.doesNotMatch(css, new RegExp(`^${id.replace('#', '\\#')}[.{ :]`, 'm'), `${id} styling is removed`);
  }
  assert.match(css, /#size-panel\{/, 'the size panel is styled');
  assert.match(css, /#size-panel\[hidden\]\{display:none\}/, 'the panel can actually be hidden');
});
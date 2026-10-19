import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desktopHostRoute } from '../../dist/management/desktop-host-routes.js';
import { ManagementError } from '../../dist/contracts/management.js';

/**
 * RWR-10-04 AC-04-1/AC-04-3: the picker endpoint is reached only through the authenticated console, it
 * accepts no path from the client, and a cancelled selection is a normal answer.
 */
function harness(hostReply = { outcome: 'selected', selectionId: 'sel-1', displayName: 'hiyori', entries: [] }) {
  const calls = [];
  const imported = [];
  const port = {
    preferences: async () => ({ apiVersion: 1, revision: 0, hotkey: null, replySound: true,
      display: { mode: 'full', preferredWidth: 360, modelWidth: 340, modelHeight: 321, drawerHeight: 0 },
      capabilities: { hotkey: 'window-only', filePicker: true, display: true, preferences: true } }),
    patch: async input => { calls.push(['patch', input]); return { revision: 1 }; },
    identityFor: (characterId, type, selectionKind) => ({ instanceId: 'inst-1', characterId, type, selectionKind }),
    select: async identity => { calls.push(['select', identity]); return hostReply; },
    importBySelection: async (identity, input) => {
      calls.push(['import', identity, input]);
      imported.push(input);
      return { schemaVersion: 1, revision: 2, activeSkinId: 'x', skins: [{ skinId: 'hiyori', origin: 'imported', label: 'hiyori', importedAt: '', bytes: 1, modelEntry: 'pet.model3.json', modelFingerprint: 'a', assetFingerprint: 'b', parameters: {}, capabilities: {} }] };
    },
  };
  return { port, calls, imported };
}

const post = (port, body) => desktopHostRoute('POST', port, '/api/desktop/resource-picker', async () => body, () => {});
const rejects = async (promise, code, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ManagementError, 'errors surface as ManagementError');
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
};

test('RWR-10-04: a selection request reaches the host without the client naming any path', async () => {
  const h = harness();
  const sent = [];
  const pending = desktopHostRoute('POST', h.port, '/api/desktop/resource-picker',
    async () => ({ characterId: 'companion', type: 'live2d', selectionKind: 'directory' }), value => sent.push(value));
  assert.equal(await pending, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'select');
  assert.deepEqual(h.calls[0][1], { instanceId: 'inst-1', characterId: 'companion', type: 'live2d', selectionKind: 'directory' });
  assert.deepEqual(sent, [{ outcome: 'selected', selectionId: 'sel-1', displayName: 'hiyori', entries: [] }],
    'only the ticket and display data reach the browser');
});

test('RWR-10-04: a cancelled chooser is a normal outcome with no ticket and no error', async () => {
  const h = harness({ outcome: 'cancelled' });
  const sent = [];
  const pending = desktopHostRoute('POST', h.port, '/api/desktop/resource-picker',
    async () => ({ characterId: 'companion', type: 'live2d', selectionKind: 'directory' }), value => sent.push(value));
  assert.equal(await pending, true);
  assert.deepEqual(sent, [{ outcome: 'cancelled' }], 'cancel is reported as cancelled, never as a failure');
});

test('RWR-10-04: the client cannot pass a path, a URL or its own window to the chooser', async () => {
  const h = harness();
  for (const extra of [{ path: 'C:/Windows' }, { url: 'file:///C:/' }, { windowId: 'other' }]) {
    await rejects(post(h.port, { characterId: 'companion', type: 'live2d', selectionKind: 'directory', ...extra }),
      'forbidden', /桌宠打开/);
  }
  assert.equal(h.calls.length, 0, 'a rejected request never reaches the host');
});

test('RWR-10-04: a bad type or selection kind is refused before any host call', async () => {
  const h = harness();
  await rejects(post(h.port, { characterId: 'companion', type: 'video', selectionKind: 'directory' }), 'invalid_request', /形象类型/);
  await rejects(post(h.port, { characterId: 'companion', type: 'live2d', selectionKind: 'anything' }), 'invalid_request', /选择来源/);
  await rejects(post(h.port, { characterId: '', type: 'live2d', selectionKind: 'directory' }), 'invalid_request', /角色标识/);
  assert.equal(h.calls.length, 0);
});

test('RWR-10-04: a ticket import forwards the ticket, not a path', async () => {
  const h = harness();
  const sent = [];
  const pending = desktopHostRoute('POST', h.port, '/api/desktop/resource-picker', async () => ({
    characterId: 'companion', type: 'live2d', selectionKind: 'directory',
    selectionId: 'sel-1', entry: 'model/Hiyori.model3.json', label: '我的模型',
  }), value => sent.push(value));
  assert.equal(await pending, true);
  assert.equal(h.calls[0][0], 'import');
  assert.deepEqual(h.imported[0], { selectionId: 'sel-1', entry: 'model/Hiyori.model3.json', label: '我的模型' });
  assert.equal(JSON.stringify(sent[0]).includes('C:'), false, 'no path is echoed to the browser');
});

test('RWR-10-04: a hostile or malformed ticket input is refused at the HTTP edge', async () => {
  const h = harness();
  await rejects(post(h.port, { characterId: 'companion', type: 'live2d', selectionKind: 'directory',
    selectionId: 'sel-1', entry: '../escape.model3.json' }), 'invalid_request', /入口文件/);
  await rejects(post(h.port, { characterId: 'companion', type: 'live2d', selectionKind: 'directory',
    selectionId: '' }), 'invalid_request', /选择票据/);
  await rejects(post(h.port, { characterId: 'companion', type: 'live2d', selectionKind: 'directory',
    selectionId: 'sel-1', label: 'x'.repeat(200) }), 'invalid_request', /显示名称/);
  assert.equal(h.calls.length, 0);
  // NOTE: `skinId` is only length-checked here. Its character rule (`ID` in skin-store.ts) is enforced by the
  // importer, which is the authority for that field; inventing a second rule here would let the two drift.
});

test('RWR-10-04: sprite frame parameters are forwarded only when supplied', async () => {
  const h = harness();
  const pending = desktopHostRoute('POST', h.port, '/api/desktop/resource-picker', async () => ({
    characterId: 'companion', type: 'sprite', selectionKind: 'image', selectionId: 'sel-2',
    sprite: { rows: 2, columns: 4, frameCount: 8, fps: 24 },
  }), () => {});
  assert.equal(await pending, true);
  assert.deepEqual(h.imported[0].sprite, { rows: 2, columns: 4, frameCount: 8, fps: 24 });
});

test('RWR-10-04: without a host the picker reports unavailable rather than faking a selection', async () => {
  await rejects(post(undefined, { characterId: 'companion', type: 'live2d', selectionKind: 'directory' }),
    'unavailable', /未连接桌宠宿主/);
  assert.equal(await desktopHostRoute('POST', undefined, '/api/other', async () => ({}), () => {}), false,
    'paths outside this route are not claimed');
});

/**
 * AC-04-1: the real dialog must come from the host. These assertions read the production host and console
 * so a future edit cannot quietly restore a hand-typed path box or drop the native dialog.
 */
test('RWR-10-04: the native chooser lives in the host and the console no longer asks for a path', () => {
  const host = readFileSync(resolve(process.cwd(), 'desktop/electron/main.mjs'), 'utf8');
  assert.match(host, /import \{[^}]*\bdialog\b[^}]*\} from 'electron'/, 'the host imports the Electron dialog module');
  const picker = readFileSync(resolve(process.cwd(), 'desktop/electron/resource-picker.mjs'), 'utf8');
  assert.match(host, /createResourcePicker\(\{ dialog, getWindow: \(\) => win/, 'the host binds the chooser to the real window');
  assert.match(picker, /dialog\.showOpenDialog\(win, options\)/, 'the chooser is parented to the real window');
  assert.match(picker, /HOST_SPRITE_EXTENSIONS/, 'PNG/WebP filters come from the frozen extension list');
  assert.match(host, /filePicker: true/, 'the host now honestly reports that it can open a chooser');

  // LUI-07: the retired appearance views are deleted. The same guarantee is asserted against the React
  // surface that replaced them: the chooser lives in the host, the page never asks for a typed path,
  // and the ticket endpoint is the only import entry.
  const view = readFileSync(resolve(process.cwd(), 'management/character-ui/src/components/AppearanceResources.tsx'), 'utf8');
  assert.doesNotMatch(view, /role-skin-source/, 'the path text box is gone from the appearance page');
  assert.match(view, /资源导入与预览|选择模型包目录/, 'the page renders the chooser-driven dialog');

  const panel = readFileSync(resolve(process.cwd(), 'management/character-ui/src/components/character/AppearancePanel.tsx'), 'utf8');
  assert.doesNotMatch(panel, /type:\s*'path'/, 'the console never posts a path');
  // The ticket endpoint is consumed by the resource dialog itself.
  assert.match(view, /\/api\/desktop\/resource-picker/, 'the console uses the ticket endpoint');
  assert.doesNotMatch(view, /\/api\/skins\/import/, 'the old path-based import endpoint is not used by the UI');
});

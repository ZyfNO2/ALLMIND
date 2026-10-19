import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainPath = new URL('../../desktop/electron/main.mjs', import.meta.url);
const contractPath = new URL('../../contracts/desktop-host.ts', import.meta.url);

test('RWR-10-05: Electron host exposes user-initiated real display selection without capturing pixels', async () => {
  const [main, contract] = await Promise.all([readFile(mainPath, 'utf8'), readFile(contractPath, 'utf8')]);
  assert.match(contract, /'screen-target\.select'/);
  assert.match(main, /value\.method === 'screen-target\.select'/);
  assert.match(main, /screen\.getAllDisplays\(\)/);
  assert.match(main, /dialog\.showMessageBox/);
  assert.match(main, /targetRevision/);
  assert.match(main, /scaleFactor/);
  const picker = main.slice(main.indexOf('async function openScreenTargetPicker'), main.indexOf('function handleHostRequest'));
  assert.match(picker, /outcome: 'cancelled'/);
  assert.match(picker, /outcome: 'selected'/);
  assert.doesNotMatch(picker, /capturePage|desktopCapturer|nativeImage|imageBase64/);
});

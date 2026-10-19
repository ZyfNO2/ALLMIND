import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, openSync, fstatSync, closeSync, renameSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isPrivateFiles, restrictPrivatePathSync } from '../../dist/core/platform-files.js';
import { ManagedCredentialStore } from '../../dist/management/credential-store.js';
import { credentialRegistry } from '../../dist/management/credentials.js';
import { startManagementServer } from '../../dist/management/server.js';
import { resolve } from 'node:path';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aika loading 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('batched live ACL checks yield to the event loop and reject broad access on the next call', async t => {
  const root = fixture(t), files = Array.from({length:6}, (_,i) => join(root, `key ${i}.txt`));
  for (const file of files) { writeFileSync(file, 'synthetic'); restrictPrivatePathSync(file); }
  const checks = files.map(filename => ({filename}));
  let completed = false;
  const pending = isPrivateFiles(checks).then(result => { completed = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  if (process.platform === 'win32') assert.equal(completed, false, 'PowerShell must not block the Node event loop');
  assert.deepEqual(await pending, files.map(() => true));
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [files[2], '/grant', '*S-1-1-0:R'], {windowsHide:true, stdio:'pipe'});
    assert.deepEqual(await isPrivateFiles(checks), files.map((_,i) => i !== 2));
  }
});
test('async checks retain opened-file identity and reject a file replaced during verification', async t => {
  const root = fixture(t), file = join(root, 'first.key'), other = join(root, 'other.key');
  for (const path of [file, other]) { writeFileSync(path, 'synthetic'); restrictPrivatePathSync(path); }
  const fd = openSync(file, 'r');
  try {
    const opened = fstatSync(fd);
    assert.deepEqual(await isPrivateFiles([{filename:file,opened}, {filename:other,opened}, {filename:root}, {filename:join(root,'missing')}]), [true,false,false,false]);
  } finally { closeSync(fd); }
  if (process.platform === 'win32') {
    const pending = isPrivateFiles([{filename:file}]);
    renameSync(file, file + '.old'); renameSync(other, file);
    assert.deepEqual(await pending, [false]);
  }
});
test('credential metadata snapshot preserves revision/status and does not use synchronous listing', async t => {
  const root = fixture(t), projectRoot = join(root, 'project'), directory = join(root, 'credentials');
  mkdirSync(projectRoot);
  const store = new ManagedCredentialStore(projectRoot, directory);
  store.save({provider:'dashscope',key:'sk-synthetic12345',expectedRevision:0,operationId:'loading-test-1'});
  const file = store.entries()[0].file;
  const registry = credentialRegistry({projectRoot,models:{dialogue:{provider:'dashscope',credentialFile:file}}},store);
  const expected = registry.list();
  store.entries = () => { throw Error('synchronous metadata path called'); };
  store.revision = () => { throw Error('synchronous revision path called'); };
  const snapshot = await registry.snapshot();
  assert.deepEqual(snapshot, {credentials:expected,credentialRevision:1});
  assert.ok(!JSON.stringify(snapshot).includes('sk-synthetic'));
  let entered, complete=false;
  const started = new Promise(done => {entered=done});
  const server = await startManagementServer({uiRoot: resolve('management'),memory:{},settings:{async drain(){}},snapshot:async()=>{
    entered(); const value=await registry.snapshot();complete=true;return value;
  }});
  t.after(()=>server.close());
  const response=fetch(server.origin+'/api/snapshot',{headers:{Authorization:`Bearer ${server.token}`}});
  await started;
  const asset=await fetch(server.origin+'/assets/avatar-neutral.svg');
  assert.equal(asset.status,200); assert.match(await asset.text(),/<svg/);
  if(process.platform==='win32')assert.equal(complete,false,'static asset must not wait for snapshot ACL checks');
  assert.deepEqual(await (await response).json(),snapshot);
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:R'], {windowsHide:true,stdio:'pipe'});
    assert.equal((await registry.snapshot()).credentials[0].status, 'unavailable');
    const metadata = join(directory,'registry.json');
    execFileSync('icacls.exe', [metadata, '/grant', '*S-1-1-0:R'], {windowsHide:true,stdio:'pipe'});
    await assert.rejects(registry.snapshot(), /本机凭据目录不可用/);
  }
});

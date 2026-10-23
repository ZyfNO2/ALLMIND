import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {PROFILES} from '../../dist/app/product-profile.js';

const directory = mkdtempSync(join(tmpdir(), 'allmind-lite-probe-'));
const repo = new FileBookRepository(directory);
const runtime = new BookRuntime(repo, {async complete() { throw new Error('lite probe must not call a model'); }}, {screenEnabled: false});
const server = await startBookServer({runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management'), profile: PROFILES['desktop-lite']});
try {
  const origin = new URL(server.url).origin;
  const headers = {Authorization: 'Bearer ' + server.token};
  const voice = await fetch(origin + '/api/memory-book/v1/voice/capabilities', {headers});
  const screen = await fetch(origin + '/api/memory-book/v1/screen/capabilities', {headers});
  if ((await voice.json()).installed !== false) throw new Error('voice module was reported installed');
  if ((await screen.json()).installed !== false) throw new Error('screen module was reported installed');
} finally {
  await server.close();
  repo.close();
  rmSync(directory, {recursive: true, force: true});
}
const banned = process.moduleLoadList.filter(row => /(?:book-voice|book-screen|book-tools|qq-channel-manager|onebot-qq|napcat-host)\.js/.test(String(row)));
if (banned.length) {
  console.error(banned.join('\n'));
  process.exit(1);
}
console.log('lite-probe-ok');

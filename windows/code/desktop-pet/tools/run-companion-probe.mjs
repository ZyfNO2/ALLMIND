// Isolated production-host acceptance; generated test artwork is original, not a distributed role asset.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { FileBookRepository } from '../dist/memory/file-book-repository.js';
import { SkinStore } from '../dist/management/skin-store.js';
import { CHARACTER_STATES } from '../dist/contracts/character-state.js';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../dist/contracts/memory-book.js';

const opt = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const mode = opt('--mode') ?? 'acceptance', duration = Number(opt('--duration-ms') ?? 1800000);
if (!['baseline', 'acceptance', 'recovery'].includes(mode) || !Number.isSafeInteger(duration) || duration < 1000) throw Error('Invalid probe mode/duration');
const root = resolve('.local/allmind-m01'); mkdirSync(root, { recursive: true });
const reused = opt('--data-directory');
const directory = reused ? resolve(reused) : mkdtempSync(join(root, mode + '-'));
if (reused && (!directory.startsWith(root + sep) || mode !== 'recovery')) throw Error('Recovery only accepts this task own fixture directory');
const evidence = resolve(opt('--evidence') ?? join(directory, 'result.json'));
mkdirSync(resolve(evidence, '..'), { recursive: true });
let modelRequests = 0;
const model = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Drain the fixture request without persisting user text. */ }
  modelRequests++; await new Promise(done => setTimeout(done, 1500));
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '隔离验收回复。' }, finish_reason: 'stop' }] }));
});
await new Promise(done => model.listen(0, '127.0.0.1', done));
// PNG RGBA atlas: seven declared state clips, two visibly distinct frames each.
const crc = bytes => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE(crc(body)); return Buffer.concat([size, body, check]); };
const width = 32 * 14, height = 32, pixels = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const frame = Math.floor(x / 32), px = x % 32 - 16, py = y - 17 - frame % 2;
  const ink = px * px + py * py < 130 || y < 12 && Math.abs(px) > 5 && Math.abs(px) < 10;
  if (!ink) continue;
  const at = y * (width * 4 + 1) + 1 + x * 4;
  const eye = Math.abs(px) >= 4 && Math.abs(px) <= 5 && y >= 14 && y <= 16;
  pixels.set(eye ? [40, 35, 70, 255] : [160 + frame % 7 * 10, 130, 220 - frame % 7 * 8, 255], at);
}
const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
if (!reused) {
const image = join(directory, 'original-test-pet.png');
writeFileSync(image, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
const skins = await SkinStore.open(join(directory, 'appearance-registry.json'), join(directory, 'appearance-packs'), resolve('desktop'));
await skins.import(image, { type: 'sprite', skinId: 'companion-test', label: '原创验收精灵图', sprite: { rows: 1, columns: 14, frameCount: 14, fps: 8,
  clips: Object.fromEntries(CHARACTER_STATES.map((state, i) => [state, { start: i * 2, frameCount: 2, fps: 8 }])) } });
const repository = new FileBookRepository(directory), config = repository.loadConfig();
repository.commitConfig({ ...config, characters: [{ ...config.characters[0], appearanceSkinId: 'companion-test' },
  { id: 'role-b', name: '隔离角色 B', intro: '', appearancePath: null, appearanceSkinId: 'companion-test' }],
  chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded' },
  mainModel: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'local-protocol-fixture', credentialId: 'fixture', inputTokens: 8192, outputTokens: 1024 } }, 0, 'probe-config');
repository.close();
}
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, [resolve('tools/companion-desktop-probe.mjs'), '--root', resolve('desktop'), '--node', process.execPath,
  '--backend', resolve('dist/app/book-backend.js'), '--companion-probe', '--probe-mode', mode, '--probe-duration', String(duration),
  '--probe-evidence', evidence, ...(opt('--user-data') ? ['--probe-user-data', resolve(opt('--user-data'))] : [])],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, AIKI_BOOK_DATA: directory, AIKI_BOOK_PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; process.stdout.write(data); });
writeFileSync(evidence.replace(/\.json$/, '.run.json'), JSON.stringify({ pid: process.pid, electronPid: child.pid, directory, mode, duration, startedAt: new Date().toISOString() }, null, 2));
child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
await new Promise(done => model.close(done));
const result = (() => { try { return JSON.parse(readFileSync(evidence, 'utf8')); } catch { return {}; } })();
writeFileSync(evidence, JSON.stringify({ ...result, exitCode: code, modelRequests, modelKind: 'local HTTP protocol fixture', dataDirectory: directory,
  stdout, stderr }, null, 2));
console.log(JSON.stringify({ evidence, exitCode: code, modelRequests })); process.exitCode = result.failed ? 1 : code ?? 1;

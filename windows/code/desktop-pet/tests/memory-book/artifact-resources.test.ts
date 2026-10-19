import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BookError, type BookScope } from '../../contracts/memory-book.js';
import { RESOURCE_BUNDLE_SCHEMA, RESOURCE_LIMITS, type ArtifactDelivery, type ResourceRecord } from '../../contracts/book-resources.js';
import { FileResourceStore } from '../../memory/file-resource-store.js';
import { BookResourceService, type ArtifactCandidate, type ArtifactSource } from '../../memory/book-resources.js';

/**
 * W01 artifact resource tests.
 *
 * Everything here is offline and deterministic: URLs are captured through an injected fetch, and
 * bundles are built with a stored-entry ZIP writer defined in this file. No test touches the
 * network, the user's config or a running server.
 */

const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'first' };
const other: BookScope = { ...scope, sessionId: 'second' };
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Runs an operation that must throw and returns the error for message-level comparison. */
function captureError(run: () => unknown): BookError {
  try {
    run();
  } catch (error) {
    return error as BookError;
  }
  throw new Error('expected the operation to throw');
}

function fixture(t: test.TestContext): { directory: string; store: FileResourceStore; service: BookResourceService } {
  const root = join(process.cwd(), '.local', 'memory-book-tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'artifact-'));
  const store = new FileResourceStore({ directory });
  const service = new BookResourceService(store, { capabilities: () => ({ outputFiles: 'available', inputImages: 'available' }) });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store, service };
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Minimal structurally valid PNG: signature + IHDR + IEND. Width/height live at bytes 16..24. */
function png(width = 4, height = 3): Buffer {
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([head, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const MARKDOWN = Buffer.from('# 标题\n\n正文内容，包含 & 符号。\n', 'utf8');
const HTML = Buffer.from(
  '<!doctype html><html><head><style>body{color:red}</style><script>alert("x")</script></head>' +
  '<body><p>第一段 &amp; 第二段</p><p>3 &lt; 5 &amp;&amp; 5 &gt; 3</p><p>&quot;引号&quot; &#39;单引号&#39;</p></body></html>',
  'utf8'
);

/** Stored-entry (method 0) ZIP writer, so bundle fixtures need no new dependency. */
function zip(entries: { path: string; body: Buffer; flags?: number }[]): Buffer {
  const table: { name: Buffer; crc: number; size: number; offset: number; flags: number }[] = [];
  const parts: Buffer[] = [];
  let offset = 0;
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.body);
    const flags = entry.flags ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.body.length, 18); local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, entry.body);
    table.push({ name, crc, size: entry.body.length, offset, flags });
    offset += local.length + name.length + entry.body.length;
  }
  const central: Buffer[] = [];
  let size = 0;
  for (const entry of table) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6);
    head.writeUInt16LE(entry.flags, 8); head.writeUInt16LE(0, 10); head.writeUInt16LE(0, 12); head.writeUInt16LE(0, 14);
    head.writeUInt32LE(entry.crc, 16); head.writeUInt32LE(entry.size, 20); head.writeUInt32LE(entry.size, 24);
    head.writeUInt16LE(entry.name.length, 28); head.writeUInt16LE(0, 30); head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34); head.writeUInt16LE(0, 36); head.writeUInt32LE(0, 38); head.writeUInt32LE(entry.offset, 42);
    central.push(head, entry.name);
    size += head.length + entry.name.length;
  }
  const body = Buffer.concat(parts);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(table.length, 8); end.writeUInt16LE(table.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(body.length, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([body, directory, end]);
}

function manifest(files: unknown[], extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: RESOURCE_BUNDLE_SCHEMA, title: '示例资源包', entrypoint: 'index.md', files, ...extra }), 'utf8');
}

function validBundle(): Buffer {
  return zip([
    { path: 'manifest.json', body: manifest([{ path: 'index.md', role: 'page', mime: 'text/markdown' }, { path: 'assets/a.png', role: 'asset', mime: 'image/png' }]) },
    { path: 'index.md', body: Buffer.from('# 首页\n\n![图](assets/a.png)\n\n[外链](https://example.com/x)\n', 'utf8') },
    { path: 'assets/a.png', body: png() }
  ]);
}

/** Uploads bytes and returns the ready record, failing loudly if the upload did not succeed. */
async function upload(service: BookResourceService, bytes: Buffer, name: string, mime: string, operationId: string, owner = scope): Promise<ResourceRecord> {
  return service.receiveUpload(owner, { name, mime }, bytes, operationId, new AbortController().signal);
}

/** A bundle resource is a ZIP upload, so it goes through the same verified upload path. */
async function uploadBundle(service: BookResourceService, bytes: Buffer, operationId: string, owner = scope): Promise<ResourceRecord> {
  return upload(service, bytes, 'bundle.zip', 'application/zip', operationId, owner);
}

// ---------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------

test('a real PNG upload becomes ready with the locally computed sha256', async t => {
  const { service, store } = fixture(t);
  const bytes = png(8, 6);
  const record = await upload(service, bytes, 'photo.png', 'image/png', 'op-png');
  assert.equal(record.state, 'ready');
  assert.equal(record.mime, 'image/png');
  assert.equal(record.kind, 'image');
  assert.equal(record.bytes, bytes.byteLength);
  assert.equal(record.sha256, sha256(bytes), 'hash is computed from the received bytes');
  assert.ok(record.receivedAt);
  assert.deepEqual(record.origin, { kind: 'upload' });
  // The caller-supplied metadata never becomes the hash: reading back re-verifies the blob.
  const read = await service.readBytes(scope, record.id, new AbortController().signal);
  assert.deepEqual(Buffer.from(read), bytes);
  assert.equal(store.stats().resources, 1);
});

test('a real markdown upload becomes ready and stays readable', async t => {
  const { service } = fixture(t);
  const record = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-md');
  assert.equal(record.state, 'ready');
  assert.equal(record.kind, 'markdown');
  assert.equal(record.mime, 'text/markdown');
  assert.equal(record.sha256, sha256(MARKDOWN));
  assert.deepEqual(Buffer.from(await service.readBytes(scope, record.id, new AbortController().signal)), MARKDOWN);
});

test('an empty upload and an over-long name are rejected', async t => {
  const { service } = fixture(t);
  await assert.rejects(() => upload(service, Buffer.alloc(0), 'empty.md', 'text/markdown', 'op-empty'), { code: 'invalid_input' });
  await assert.rejects(() => upload(service, MARKDOWN, 'x'.repeat(RESOURCE_LIMITS.nameChars + 1), 'text/markdown', 'op-long'), { code: 'invalid_input' });
  await assert.rejects(() => upload(service, MARKDOWN, '', 'text/markdown', 'op-blank'), { code: 'invalid_input' });
});

test('bytes that contradict the declared image mime are rejected', async t => {
  const { service } = fixture(t);
  // A PNG signature is absent, so the declared image/png is a lie about the content.
  await assert.rejects(() => upload(service, Buffer.from('not an image at all', 'utf8'), 'fake.png', 'image/png', 'op-fake'), { code: 'invalid_input' });
  // A real PNG declared as JPEG is the same class of mismatch.
  await assert.rejects(() => upload(service, png(), 'photo.jpg', 'image/jpeg', 'op-swap'), { code: 'invalid_input' });
});

test('oversized payloads are rejected before they are published', async t => {
  const { service, store } = fixture(t);
  const huge = Buffer.alloc(RESOURCE_LIMITS.textBytes + 1, 0x61);
  await assert.rejects(() => upload(service, huge, 'huge.md', 'text/markdown', 'op-huge'), { code: 'invalid_input' });
  const hugeImage = Buffer.concat([png(), Buffer.alloc(RESOURCE_LIMITS.imageBytes, 0)]);
  await assert.rejects(() => upload(service, hugeImage, 'huge.png', 'image/png', 'op-huge-image'), { code: 'invalid_input' });
  assert.equal(store.stats().resources, 0, 'a rejected upload leaves no record behind');
});

test('an image beyond the pixel budget is rejected', async t => {
  const { service } = fixture(t);
  // 100000 x 100000 exceeds RESOURCE_LIMITS.imagePixels (40_000_000) while staying tiny on disk.
  await assert.rejects(() => upload(service, png(100_000, 100_000), 'wide.png', 'image/png', 'op-pixels'), { code: 'invalid_input' });
});

test('identical bytes in two scopes stay isolated', async t => {
  const { service, store } = fixture(t);
  const mine = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-a', scope);
  const theirs = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-b', other);
  assert.notEqual(mine.id, theirs.id);
  assert.equal(mine.sha256, theirs.sha256, 'content addressing may share the blob');
  // Revoking one scope must not revoke or hide the other scope's record.
  service.revoke(scope, mine.id, mine.revision, 'op-revoke-a');
  assert.equal(service.get(scope, mine.id).state, 'revoked');
  assert.equal(service.get(other, theirs.id).state, 'ready');
  assert.deepEqual(Buffer.from(await service.readBytes(other, theirs.id, new AbortController().signal)), MARKDOWN);
  assert.ok(store.stats().resources >= 2);
});

// ---------------------------------------------------------------------------------------------
// Ownership and revocation
// ---------------------------------------------------------------------------------------------

test('a cross-scope read is indistinguishable from a missing id', async t => {
  const { service } = fixture(t);
  const record = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-own', scope);
  const missing = captureError(() => service.get(other, 'res-does-not-exist'));
  const foreign = captureError(() => service.get(other, record.id));
  assert.equal(foreign.message, missing.message, 'no existence leak through the message');
  await assert.rejects(() => service.readBytes(other, record.id, new AbortController().signal), (error: BookError) => error.code === 'not_found' && error.message === missing.message);
  assert.equal(service.get(scope, record.id).id, record.id, 'the owner still reads it');
});

test('a revoked resource cannot be read and a late mark-ready cannot resurrect it', async t => {
  const { service, store } = fixture(t);
  const record = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-rev');
  const revoked = service.revoke(scope, record.id, record.revision, 'op-rev-1');
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.sha256, null, 'the tombstone keeps no content identity');
  assert.equal(revoked.bytes, null);
  assert.equal(revoked.mime, null);
  await assert.rejects(() => service.readBytes(scope, record.id, new AbortController().signal), { code: 'not_found' });
  // A late background receipt must not restore the file.
  assert.throws(() => store.receiveBytes({ scope, resourceId: record.id, bytes: MARKDOWN, mime: 'text/markdown', kind: 'markdown' }), { code: 'conflict' });
  assert.equal(service.get(scope, record.id).state, 'revoked');
  assert.throws(() => store.markReceiving(scope, record.id), { code: 'not_found' });
});

test('a stale revision is a conflict, not a silent overwrite', async t => {
  const { service } = fixture(t);
  const record = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-stale');
  assert.throws(() => service.revoke(scope, record.id, record.revision + 5, 'op-stale-1'), { code: 'conflict' });
  assert.equal(service.get(scope, record.id).state, 'ready');
});

// ---------------------------------------------------------------------------------------------
// readMaterial
// ---------------------------------------------------------------------------------------------

test('markdown and plain text material are the UTF-8 body without a BOM', async t => {
  const { service } = fixture(t);
  const markdown = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-m1');
  const material = await service.readMaterial(scope, markdown.id, new AbortController().signal);
  assert.equal(material.text, MARKDOWN.toString('utf8'));
  assert.equal(material.mime, 'text/markdown');
  assert.equal(material.sha256, markdown.sha256);
  assert.equal(material.resourceId, markdown.id);
  assert.equal(material.title, 'note.md');
  assert.deepEqual(material.extraction, { version: 'aiki-text-extract/v1', complete: true });
  const withBom = await upload(service, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), MARKDOWN]), 'bom.md', 'text/markdown', 'op-m2');
  const stripped = await service.readMaterial(scope, withBom.id, new AbortController().signal);
  assert.equal(stripped.text.startsWith('\ufeff'), false, 'BOM is stripped');
});

test('html material drops script and style bodies and decodes entities', async t => {
  const { service } = fixture(t);
  const record = await upload(service, HTML, 'page.html', 'text/html', 'op-h1');
  const material = await service.readMaterial(scope, record.id, new AbortController().signal);
  assert.equal(material.mime, 'text/html');
  assert.ok(!material.text.includes('alert'), 'script body must not survive');
  assert.ok(!material.text.includes('color:red'), 'style body must not survive');
  assert.ok(!material.text.includes('<p>'), 'tags are stripped');
  assert.ok(material.text.includes('第一段 & 第二段'), `entities decoded: ${material.text}`);
  assert.ok(material.text.includes('3 < 5 && 5 > 3'), `lt/gt/amp decoded: ${material.text}`);
  assert.ok(material.text.includes('"引号" \'单引号\''), `quot/#39 decoded: ${material.text}`);
  assert.equal(material.extraction.complete, true);
});

test('images and bundles are not readable as text material', async t => {
  const { service } = fixture(t);
  const image = await upload(service, png(), 'photo.png', 'image/png', 'op-m3');
  await assert.rejects(() => service.readMaterial(scope, image.id, new AbortController().signal), { code: 'invalid_input' });
  const bundle = await uploadBundle(service, validBundle(), 'op-m4');
  await assert.rejects(() => service.readMaterial(scope, bundle.id, new AbortController().signal), { code: 'invalid_input' });
});

test('material beyond the material budget is truncated and marked incomplete', async t => {
  const { service } = fixture(t);
  const long = Buffer.from('# 长文\n\n' + '字'.repeat(RESOURCE_LIMITS.materialBytes), 'utf8');
  const record = await upload(service, long, 'long.md', 'text/markdown', 'op-m5');
  const material = await service.readMaterial(scope, record.id, new AbortController().signal);
  assert.equal(material.extraction.complete, false);
  assert.ok(material.extraction.omittedReason, 'truncation must state a reason');
  assert.ok(Buffer.byteLength(material.text, 'utf8') <= RESOURCE_LIMITS.materialBytes);
});

// ---------------------------------------------------------------------------------------------
// captureUrl
// ---------------------------------------------------------------------------------------------

/** A capture service whose fetch never reaches the network. */
function webFixture(t: test.TestContext, respond: (url: string) => Response | Promise<Response>) {
  const root = join(process.cwd(), '.local', 'memory-book-tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'artifact-web-'));
  const seen: string[] = [];
  const service = new BookResourceService(new FileResourceStore({ directory }), {
    fetch: async input => { seen.push(String(input)); return respond(String(input)); },
    resolveHost: async () => ['93.184.216.34'],
    capabilities: () => ({ outputFiles: 'available', inputImages: 'available' })
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { service, seen };
}

test('captureUrl rejects non-http schemes, credentials and private hosts without any network call', async t => {
  const { service, seen } = webFixture(t, () => new Response('x', { status: 200, headers: { 'content-type': 'text/plain' } }));
  const blocked = [
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'ftp://example.com/a.txt',
    'http://user:pass@example.com/a.txt',
    'http://127.0.0.1:8080/a.txt',
    'http://localhost/a.txt',
    'http://10.0.0.1/a.txt',
    'http://192.168.1.10/a.txt',
    'http://172.16.5.5/a.txt',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/a.txt',
    'http://0.0.0.0/a.txt'
  ];
  for (const url of blocked) {
    await assert.rejects(
      () => service.captureUrl(scope, url, `op-${Buffer.from(url).toString('hex').slice(0, 24)}`, new AbortController().signal),
      (error: BookError) => error instanceof BookError,
      `must refuse ${url}`
    );
  }
  assert.deepEqual(seen, [], 'a blocked target must never reach fetch');
});

test('captureUrl refuses a redirect that lands on a private address', async t => {
  const { service } = webFixture(t, url =>
    url.includes('public.example')
      ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
      : new Response('secret', { status: 200, headers: { 'content-type': 'text/plain' } })
  );
  await assert.rejects(() => service.captureUrl(scope, 'https://public.example/a', 'op-redirect', new AbortController().signal), (error: BookError) => error instanceof BookError);
});

test('captureUrl stores a real page and reports a transport failure instead of an empty document', async t => {
  const { service } = webFixture(t, url =>
    url.includes('ok.example')
      ? new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      : new Response('gone', { status: 500, headers: { 'content-type': 'text/plain' } })
  );
  const record = await service.captureUrl(scope, 'https://ok.example/page', 'op-web-ok', new AbortController().signal);
  assert.equal(record.state, 'ready');
  assert.equal(record.kind, 'html');
  assert.equal(record.sha256, sha256(HTML));
  assert.equal(record.origin.kind, 'web');
  assert.equal(record.origin.sourceUri, 'https://ok.example/page');
  // A failure is an error, never a ready record holding an empty body.
  await assert.rejects(() => service.captureUrl(scope, 'https://bad.example/page', 'op-web-bad', new AbortController().signal), (error: BookError) => error instanceof BookError);
});

// ---------------------------------------------------------------------------------------------
// Bundle preview
// ---------------------------------------------------------------------------------------------

test('a valid aiki-resource-bundle/v1 previews every member with real bytes and hashes', async t => {
  const { service } = fixture(t);
  const record = await uploadBundle(service, validBundle(), 'op-b1');
  const preview = await service.previewBundle(scope, record.id, new AbortController().signal);
  assert.equal(preview.format, RESOURCE_BUNDLE_SCHEMA);
  assert.equal(preview.resourceId, record.id);
  assert.equal(preview.bundleSha256, record.sha256);
  assert.equal(preview.title, '示例资源包');
  assert.equal(preview.entrypoint, 'index.md');
  assert.equal(preview.canOrganize, true);
  assert.deepEqual(preview.files.map(file => file.path).sort(), ['assets/a.png', 'index.md']);
  const index = preview.files.find(file => file.path === 'index.md')!;
  assert.equal(index.role, 'page');
  assert.equal(index.mime, 'text/markdown');
  assert.equal(index.bytes, Buffer.byteLength('# 首页\n\n![图](assets/a.png)\n\n[外链](https://example.com/x)\n', 'utf8'));
  assert.equal(index.sha256, sha256(Buffer.from('# 首页\n\n![图](assets/a.png)\n\n[外链](https://example.com/x)\n', 'utf8')));
  const asset = preview.files.find(file => file.path === 'assets/a.png')!;
  assert.equal(asset.role, 'asset');
  assert.equal(asset.sha256, sha256(png()));
  // Member identity is deterministic and satisfies the identity regex.
  for (const file of preview.files) assert.match(file.resourceId, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u, file.path);
  const links = preview.links.map(link => `${link.kind}:${link.status}`);
  assert.ok(links.includes('asset:resolved'), `asset link resolved: ${JSON.stringify(preview.links)}`);
  assert.ok(links.includes('external:external_unfetched'), `external link not fetched: ${JSON.stringify(preview.links)}`);
});

test('repeated previews are idempotent', async t => {
  const { service, store } = fixture(t);
  const record = await uploadBundle(service, validBundle(), 'op-b2');
  const before = store.stats().resources;
  const first = await service.previewBundle(scope, record.id, new AbortController().signal);
  const second = await service.previewBundle(scope, record.id, new AbortController().signal);
  assert.deepEqual(second, first, 'preview is a pure function of the archive');
  assert.equal(store.stats().resources, before + 2, 'one-time creation of two readable members');
  await service.previewBundle(scope,record.id,new AbortController().signal);
  assert.equal(store.stats().resources,before + 2,'subsequent previews create no duplicates');
});

test('revoking a package also revokes its materialized members across store reconstruction', async t => {
  const {service,store}=fixture(t);
  const record=await uploadBundle(service,validBundle(),'cascade-upload');
  const preview=await service.previewBundle(scope,record.id,new AbortController().signal);
  service.revoke(scope,record.id,record.revision,'cascade-revoke');
  const restored=new FileResourceStore({directory:store.directory});
  for(const member of preview.files)assert.throws(()=>restored.readBytes(scope,member.resourceId),{code:'not_found'});
});

test('a valid ZIP without a manifest is unrecognized and never organized', async t => {
  const { service } = fixture(t);
  const bare = zip([{ path: 'readme.md', body: Buffer.from('# hi\n', 'utf8') }]);
  const record = await uploadBundle(service, bare, 'op-b3');
  const preview = await service.previewBundle(scope, record.id, new AbortController().signal);
  assert.equal(preview.format, 'unrecognized');
  assert.equal(preview.canOrganize, false);
  assert.deepEqual(preview.files, []);
  assert.ok(preview.diagnostics.length, 'an unrecognized bundle must explain itself');
  assert.ok(preview.diagnostics.some(item => item.code === 'missing_manifest'), JSON.stringify(preview.diagnostics));
});

test('bundle manifests with unsafe or inconsistent structure are rejected', async t => {
  const { service } = fixture(t);
  const page = { path: 'index.md', role: 'page', mime: 'text/markdown' };
  const index = Buffer.from('# 首页\n', 'utf8');
  const cases: { label: string; bytes: Buffer }[] = [
    { label: 'traversal', bytes: zip([{ path: 'manifest.json', body: manifest([{ path: '../escape.md', role: 'page', mime: 'text/markdown' }, page]) }, { path: 'index.md', body: index }]) },
    { label: 'absolute path', bytes: zip([{ path: 'manifest.json', body: manifest([{ path: '/etc/passwd', role: 'page', mime: 'text/markdown' }, page]) }, { path: 'index.md', body: index }]) },
    { label: 'missing listed member', bytes: zip([{ path: 'manifest.json', body: manifest([page, { path: 'ghost.md', role: 'source', mime: 'text/markdown' }]) }, { path: 'index.md', body: index }]) },
    { label: 'manifest lists itself', bytes: zip([{ path: 'manifest.json', body: manifest([page, { path: 'manifest.json', role: 'source', mime: 'text/markdown' }]) }, { path: 'index.md', body: index }]) },
    { label: 'case collision', bytes: zip([{ path: 'manifest.json', body: manifest([page, { path: 'Index.md', role: 'source', mime: 'text/markdown' }]) }, { path: 'index.md', body: index }, { path: 'Index.md', body: index }]) },
    { label: 'bad role', bytes: zip([{ path: 'manifest.json', body: manifest([{ path: 'index.md', role: 'script', mime: 'text/markdown' }]) }, { path: 'index.md', body: index }]) },
    { label: 'missing entrypoint', bytes: zip([{ path: 'manifest.json', body: manifest([page], { entrypoint: 'nope.md' }) }, { path: 'index.md', body: index }]) },
    { label: 'wrong schema version', bytes: zip([{ path: 'manifest.json', body: Buffer.from(JSON.stringify({ schemaVersion: 'aiki-delivery/v1', files: [page] }), 'utf8') }, { path: 'index.md', body: index }]) },
    { label: 'unlisted member', bytes: zip([{ path: 'manifest.json', body: manifest([page]) }, { path: 'index.md', body: index }, { path: 'smuggled.exe', body: Buffer.from('MZ', 'utf8') }]) }
  ];
  for (const item of cases) {
    const record = await uploadBundle(service, item.bytes, `op-bad-${Buffer.from(item.label).toString('hex')}`);
    if(item.label==='case collision'){await assert.rejects(()=>service.previewBundle(scope,record.id,new AbortController().signal),{code:'invalid_input'});continue;}
    const preview = await service.previewBundle(scope, record.id, new AbortController().signal);
    assert.equal(preview.canOrganize, false, `${item.label} must not be organizable`);
    assert.ok(preview.diagnostics.length, `${item.label} must explain itself`);
  }
});

test('a backslash member path is rejected before it can escape', async t => {
  const { service } = fixture(t);
  const bytes = zip([{ path: 'manifest.json', body: manifest([{ path: '..\\escape.md', role: 'page', mime: 'text/markdown' }]) }, { path: 'index.md', body: Buffer.from('# x\n', 'utf8') }]);
  const record = await uploadBundle(service, bytes, 'op-backslash');
  await assert.rejects(() => service.previewBundle(scope, record.id, new AbortController().signal), (error: BookError) => error instanceof BookError);
});

test('an encrypted bundle member is rejected', async t => {
  const { service } = fixture(t);
  const bytes = zip([{ path: 'manifest.json', body: manifest([{ path: 'index.md', role: 'page', mime: 'text/markdown' }]), flags: 1 }, { path: 'index.md', body: Buffer.from('# x\n', 'utf8') }]);
  const record = await uploadBundle(service, bytes, 'op-encrypted');
  await assert.rejects(() => service.previewBundle(scope, record.id, new AbortController().signal), (error: BookError) => error instanceof BookError);
});

test('previewing a non-bundle resource is a typed error', async t => {
  const { service } = fixture(t);
  const record = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-b4');
  await assert.rejects(() => service.previewBundle(scope, record.id, new AbortController().signal), { code: 'invalid_input' });
  await assert.rejects(() => service.previewBundle(other, record.id, new AbortController().signal), { code: 'not_found' });
});

// ---------------------------------------------------------------------------------------------
// Delivery lifecycle
// ---------------------------------------------------------------------------------------------

function sourceOf(bodies: Record<string, Buffer | Error>): ArtifactSource {
  return {
    async readArtifact(candidate: ArtifactCandidate): Promise<Uint8Array> {
      const body = bodies[candidate.candidateId];
      if (body instanceof Error) throw body;
      if (!body) throw new Error('missing fixture');
      return body;
    }
  };
}

function prepare(service: BookResourceService, operationId: string, candidates: { handleId: string; nameHint: string; mimeHint?: string; messageId: string }[]): ArtifactDelivery {
  return service.prepareDelivery({ scope, turnId: 'turn-1', discovery: 'complete', candidates }, operationId);
}

test('retryReceive re-reads only the named failed items and leaves ready items untouched', async t => {
  const { service } = fixture(t);
  const delivery = prepare(service, 'op-d1', [
    { handleId: 'h1', nameHint: 'good.md', mimeHint: 'text/markdown', messageId: 'm1' },
    { handleId: 'h2', nameHint: 'bad.md', mimeHint: 'text/markdown', messageId: 'm2' }
  ]);
  assert.equal(delivery.resourceIds.length, 2);
  const [first, second] = delivery.resourceIds as [string, string];

  let reads: string[] = [];
  const failing: ArtifactSource = {
    async readArtifact(candidate) {
      reads.push(candidate.candidateId);
      if (candidate.candidateId === 'h2') throw Object.assign(new Error('下载失败'), { cause: { code: 'download_failed' } });
      return MARKDOWN;
    }
  };
  const received = await service.receiveFromProvider({ scope, deliveryId: delivery.id, signal: new AbortController().signal }, failing);
  assert.deepEqual(reads.sort(), ['h1', 'h2']);
  assert.equal(received.resources.length, 1);
  assert.equal(received.failures.length, 1);
  assert.equal(received.failures[0]!.resourceId, second);
  assert.equal(service.get(scope, first).state, 'ready');
  assert.equal(service.get(scope, second).state, 'failed');
  const goodHash = service.get(scope, first).sha256;

  reads = [];
  const retry = await service.retryReceive(scope, delivery.id, [second], received.delivery.revision, 'op-retry', new AbortController().signal, {async readArtifact(candidate){reads.push(candidate.candidateId);return MARKDOWN;}});
  assert.deepEqual(reads, ['h2'], 'only the named failed item is re-read');
  assert.equal(service.get(scope, second).state, 'ready');
  assert.equal(service.get(scope, first).sha256, goodHash, 'the ready item keeps its identity');
  assert.ok(retry.revision > received.delivery.revision);
});

test('retryReceive refuses unknown, ready-only and revoked targets', async t => {
  const { service } = fixture(t);
  const delivery = prepare(service, 'op-d2', [{ handleId: 'h1', nameHint: 'good.md', mimeHint: 'text/markdown', messageId: 'm1' }]);
  const [first] = delivery.resourceIds as [string];
  const received = await service.receiveFromProvider({ scope, deliveryId: delivery.id, signal: new AbortController().signal }, sourceOf({ h1: MARKDOWN }));
  await assert.rejects(() => service.retryReceive(scope, delivery.id, [], received.delivery.revision, 'op-r0', new AbortController().signal, sourceOf({ h1: MARKDOWN })), { code: 'invalid_input' });
  await assert.rejects(() => service.retryReceive(scope, delivery.id, ['res-unknown'], received.delivery.revision, 'op-r1', new AbortController().signal, sourceOf({ h1: MARKDOWN })), { code: 'not_found' });
  await assert.rejects(() => service.retryReceive(scope, delivery.id, [first], received.delivery.revision + 9, 'op-r2', new AbortController().signal, sourceOf({ h1: MARKDOWN })), { code: 'conflict' });
  service.revoke(scope, first, service.get(scope, first).revision, 'op-r3');
  await assert.rejects(() => service.retryReceive(scope, delivery.id, [first], service.getDelivery(scope, delivery.id).revision, 'op-r4', new AbortController().signal, sourceOf({ h1: MARKDOWN })), { code: 'conflict' });
});

test('cancelReceive stops only pending items and never revokes a ready one', async t => {
  const { service } = fixture(t);
  const delivery = prepare(service, 'op-d3', [
    { handleId: 'h1', nameHint: 'good.md', mimeHint: 'text/markdown', messageId: 'm1' },
    { handleId: 'h2', nameHint: 'slow.md', mimeHint: 'text/markdown', messageId: 'm2' }
  ]);
  const [first, second] = delivery.resourceIds as [string, string];
  const received = await service.receiveFromProvider(
    { scope, deliveryId: delivery.id, resourceIds: [first], signal: new AbortController().signal },
    sourceOf({ h1: MARKDOWN, h2: MARKDOWN })
  );
  assert.equal(service.get(scope, first).state, 'ready');
  assert.equal(service.get(scope, second).state, 'pending');

  const cancelled = service.cancelReceive(scope, delivery.id, received.delivery.revision, 'op-cancel');
  assert.ok(cancelled.revision > received.delivery.revision);
  assert.equal(service.get(scope, second).state, 'failed');
  assert.equal(service.get(scope, second).error?.code, 'cancelled');
  assert.equal(service.get(scope, first).state, 'ready', 'a ready item is not cancelled');
  assert.deepEqual(Buffer.from(await service.readBytes(scope, first, new AbortController().signal)), MARKDOWN);
  assert.throws(() => service.cancelReceive(scope, delivery.id, received.delivery.revision, 'op-cancel-stale'), { code: 'conflict' });
});

// ---------------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------------

test('the same operationId replays the same result and a changed payload conflicts', async t => {
  const { service, store } = fixture(t);
  const first = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-idem');
  const second = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-idem');
  assert.equal(second.id, first.id, 'a retried upload replays instead of duplicating');
  assert.equal(store.stats().resources, 1);
  await assert.rejects(() => upload(service, MARKDOWN, 'renamed.md', 'text/markdown', 'op-idem'), { code: 'conflict' });
  await assert.rejects(() => upload(service, Buffer.from('different\n', 'utf8'), 'note.md', 'text/markdown', 'op-idem'), { code: 'conflict' });

  const url = await service.captureUrl(scope, 'https://ok.example/a', 'op-idem-url', new AbortController().signal).catch(() => null);
  void url;
});

test('captureUrl replays the same operationId without a second fetch', async t => {
  const { service, seen } = webFixture(t, () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
  const first = await service.captureUrl(scope, 'https://ok.example/a', 'op-url-idem', new AbortController().signal);
  const second = await service.captureUrl(scope, 'https://ok.example/a', 'op-url-idem', new AbortController().signal);
  assert.equal(second.id, first.id);
  assert.equal(seen.length, 1, 'the replay must not re-fetch');
  await assert.rejects(() => service.captureUrl(scope, 'https://ok.example/b', 'op-url-idem', new AbortController().signal), { code: 'conflict' });
});

// ---------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------

test('staging cleanup expires unused records and leaves ready ones alone', async t => {
  const { service, store } = fixture(t);
  const ready = await upload(service, MARKDOWN, 'note.md', 'text/markdown', 'op-sweep-1');
  const delivery = prepare(service, 'op-sweep-2', [{ handleId: 'h1', nameHint: 'never.md', mimeHint: 'text/markdown', messageId: 'm1' }]);
  const [pending] = delivery.resourceIds as [string];
  assert.equal(service.get(scope, pending).state, 'pending');
  const future = new Date(Date.now() + 25 * 60 * 60 * 1000);
  const expired = store.sweep(future, 24 * 60 * 60 * 1000);
  assert.equal(expired, 1);
  assert.equal(service.get(scope, pending).state, 'expired');
  assert.equal(service.get(scope, ready.id).state, 'ready', 'a ready resource is never swept');
  assert.deepEqual(Buffer.from(await service.readBytes(scope, ready.id, new AbortController().signal)), MARKDOWN);
});

test('capabilities come from the injected source', async t => {
  const { service } = fixture(t);
  assert.deepEqual(service.capabilities(), { outputFiles: 'available', inputImages: 'available' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_DELIVERY_SCHEMA,
  DEFAULT_RESOURCE_CAPABILITIES,
  RESOURCE_BUNDLE_SCHEMA,
  RESOURCE_FAILURE_CODES,
  RESOURCE_KINDS,
  RESOURCE_LIMITS,
  RESOURCE_MIMES,
  RESOURCE_SCHEMA,
  RESOURCE_STATES,
  RESOURCE_USES,
  SOURCE_MATERIAL_EXTRACTION_VERSION,
  failureOf,
  kindOfMime,
  normalizeResourceSelections,
  resourceRequestHash,
  resourceScopeKey,
  sameScope,
  validateArtifactDelivery,
  validateFrozenResourceSelection,
  validateResourceCapabilities,
  validateResourceOrigin,
  validateResourceRecord,
  validateResourceSelection,
  validateSourceMaterial,
  type ArtifactDelivery,
  type FrozenResourceSelection,
  type ResourceRecord,
  type SourceMaterial
} from '../../contracts/book-resources.js';
import type { BookScope } from '../../contracts/memory-book.js';

/**
 * W01 artifact contract tests (contracts/book-resources.ts).
 *
 * This file treats the contract as frozen: it pins the exact limit values, the exact record
 * invariants per state, and the replay identity. A record that passes validation is the only thing
 * the store, the Runtime and the HTTP layer are allowed to trust.
 */

const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'first' };
const other: BookScope = { ...scope, sessionId: 'second' };
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

/** Invalid records are built as raw JSON so a negative test cannot be rejected by the compiler. */
function rawRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: RESOURCE_SCHEMA,
    id: 'res-1',
    scope: { ...scope },
    revision: 1,
    name: 'note.md',
    kind: 'markdown',
    state: 'pending',
    mime: null,
    bytes: null,
    sha256: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    receivedAt: null,
    origin: { kind: 'upload' },
    ...overrides
  };
}
function readyRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawRecord({ state: 'ready', mime: 'text/markdown', kind: 'markdown', bytes: 12, sha256: SHA, receivedAt: '2026-01-01T00:00:01.000Z', ...overrides });
}
function asRecord(raw: Record<string, unknown>): ResourceRecord { return raw as unknown as ResourceRecord; }
function rejects(raw: Record<string, unknown>, message: string): void {
  assert.throws(() => validateResourceRecord(asRecord(raw)), { code: 'invalid_input' }, message);
}

test('W01 limits are pinned to the contract values', () => {
  assert.deepEqual(RESOURCE_LIMITS, {
    textBytes: 2 * 1024 * 1024,
    imageBytes: 16 * 1024 * 1024,
    bundleBytes: 16 * 1024 * 1024,
    bundleUncompressedBytes: 64 * 1024 * 1024,
    bundleEntries: 128,
    inputsPerTurn: 8,
    outputsPerTurn: 16,
    imagesPerTurnBytes: 32 * 1024 * 1024,
    fetchTimeoutMs: 60_000,
    imagePixels: 40_000_000,
    materialBytes: 512 * 1024,
    chunkBytes: 64 * 1024,
    nameChars: 160
  });
  assert.equal(RESOURCE_SCHEMA, 'aiki-resource/v1');
  assert.equal(ARTIFACT_DELIVERY_SCHEMA, 'aiki-artifact-delivery/v1');
  assert.equal(RESOURCE_BUNDLE_SCHEMA, 'aiki-resource-bundle/v1');
  assert.equal(SOURCE_MATERIAL_EXTRACTION_VERSION, 'aiki-text-extract/v1');
  assert.deepEqual(RESOURCE_MIMES, ['image/png', 'image/jpeg', 'image/webp', 'text/markdown', 'text/html', 'text/plain', 'application/zip']);
  assert.deepEqual(RESOURCE_USES, ['text', 'image']);
});

test('a well-formed record validates in every state', () => {
  for (const state of RESOURCE_STATES) {
    const raw = state === 'ready'
      ? readyRaw()
      : rawRecord({ state, ...(state === 'failed' ? { error: { code: 'download_failed', message: '下载失败。' } } : {}) });
    validateResourceRecord(asRecord(raw));
  }
  // Only `ready` carries bytes/hash/receivedAt; the others must be able to leave them null.
  for (const state of RESOURCE_STATES.filter(value => value !== 'ready')) {
    assert.equal(rawRecord({ state }).mime, null, state);
  }
});

test('resource records reject unknown keys, bad identity and bad scope', () => {
  rejects(rawRecord({ extra: 1 }), 'unknown key');
  rejects(rawRecord({ id: '' }), 'empty id');
  rejects(rawRecord({ id: '-leading' }), 'id must start alphanumeric');
  rejects(rawRecord({ id: 'x'.repeat(129) }), 'id too long');
  rejects(rawRecord({ schemaVersion: 'aiki-resource/v2' }), 'wrong schema');
  rejects(rawRecord({ revision: -1 }), 'negative revision');
  rejects(rawRecord({ revision: 1.5 }), 'fractional revision');
  rejects(rawRecord({ name: '' }), 'empty name');
  rejects(rawRecord({ name: 'x'.repeat(RESOURCE_LIMITS.nameChars + 1) }), 'name too long');
  rejects(rawRecord({ createdAt: 'not-a-date' }), 'bad createdAt');
  rejects(rawRecord({ kind: 'video' }), 'unknown kind');
  rejects(rawRecord({ state: 'downloading' }), 'unknown state');
  rejects(rawRecord({ scope: { characterId: 'aika', pairingId: 'local-user' } }), 'incomplete scope');
  rejects(rawRecord({ scope: { ...scope, sessionId: '' } }), 'empty sessionId');
});

test('ready records require a verified mime, byte count, hash and receivedAt', () => {
  validateResourceRecord(asRecord(readyRaw()));
  rejects(readyRaw({ mime: null }), 'ready without mime');
  rejects(readyRaw({ mime: 'application/octet-stream' }), 'ready with a mime outside the allowlist');
  rejects(readyRaw({ bytes: null }), 'ready without bytes');
  rejects(readyRaw({ bytes: -1 }), 'ready with negative bytes');
  rejects(readyRaw({ sha256: null }), 'ready without sha256');
  rejects(readyRaw({ sha256: 'A'.repeat(64) }), 'ready with an uppercase hash');
  rejects(readyRaw({ sha256: 'a'.repeat(63) }), 'ready with a short hash');
  rejects(readyRaw({ receivedAt: null }), 'ready without receivedAt');
  rejects(readyRaw({ error: { code: 'cancelled', message: '撤销。' } }), 'ready must not carry an error');
  // kind is derived from the verified mime, never from a name hint.
  rejects(readyRaw({ kind: 'image', mime: 'text/markdown' }), 'kind/mime mismatch');
  rejects(readyRaw({ kind: 'text', mime: 'text/markdown' }), 'markdown mime with text kind');
  validateResourceRecord(asRecord(readyRaw({ kind: 'image', mime: 'image/png' })));
  validateResourceRecord(asRecord(readyRaw({ kind: 'zip', mime: 'application/zip' })));
});

test('failed records must state a reason and every error is validated', () => {
  validateResourceRecord(asRecord(rawRecord({ state: 'failed', error: { code: 'too_large', message: '超过上限。' } })));
  rejects(rawRecord({ state: 'failed' }), 'failed without error');
  rejects(rawRecord({ error: { code: 'nope', message: 'x' } }), 'unknown failure code');
  rejects(rawRecord({ error: { code: 'cancelled', message: '' } }), 'empty error message');
  rejects(rawRecord({ error: { code: 'cancelled', message: 'x'.repeat(301) } }), 'error message too long');
  rejects(rawRecord({ error: { code: 'cancelled', message: 'x', extra: 1 } }), 'unknown error key');
  for (const code of RESOURCE_FAILURE_CODES) {
    validateResourceRecord(asRecord(rawRecord({ state: 'failed', error: { code, message: '原因。' } })));
  }
});

test('resource origin rejects unknown kinds, bad ids and unsafe URLs', () => {
  validateResourceOrigin({ kind: 'upload' });
  validateResourceOrigin({ kind: 'web', sourceUri: 'https://example.com/a.md' });
  validateResourceOrigin({ kind: 'bundle_member', parentResourceId: 'res-1', memberPath: 'docs/a.md' });
  validateResourceOrigin({ kind: 'provider', requestId: 'turn-1', conversationId: 'conv-1', messageId: 'msg-1' });
  rejects(rawRecord({ origin: { kind: 'ftp' } }), 'unknown origin kind');
  rejects(rawRecord({ origin: { kind: 'upload', extra: 1 } }), 'unknown origin key');
  rejects(rawRecord({ origin: { kind: 'upload', requestId: 'bad id' } }), 'invalid requestId');
  rejects(rawRecord({ origin: { kind: 'bundle_member', memberPath: 'a.md' } }), 'bundle member without parent');
  rejects(rawRecord({ origin: { kind: 'bundle_member', parentResourceId: 'res-1' } }), 'bundle member without path');
  rejects(rawRecord({ origin: { kind: 'web', sourceUri: 'https://example.com/a b' } }), 'sourceUri with a space');
  rejects(rawRecord({ origin: { kind: 'web', sourceUri: 'x'.repeat(2049) } }), 'sourceUri too long');
});

test('artifact deliveries validate their resource list', () => {
  const delivery: ArtifactDelivery = {
    schemaVersion: ARTIFACT_DELIVERY_SCHEMA,
    id: 'dlv-1',
    scope,
    turnId: 'turn-1',
    revision: 0,
    resourceIds: ['res-1', 'res-2'],
    discovery: 'complete'
  };
  validateArtifactDelivery(delivery);
  validateArtifactDelivery({ ...delivery, discovery: 'unsupported', resourceIds: [], error: { code: 'unsupported', message: '来源不支持附件。' } });
  const bad = (overrides: Record<string, unknown>): void => {
    assert.throws(() => validateArtifactDelivery({ ...delivery, ...overrides } as ArtifactDelivery), { code: 'invalid_input' });
  };
  bad({ extra: 1 });
  bad({ schemaVersion: 'x' });
  bad({ discovery: 'maybe' });
  bad({ resourceIds: ['res-1', 'res-1'] });
  bad({ resourceIds: 'res-1' });
  bad({ resourceIds: Array.from({ length: RESOURCE_LIMITS.outputsPerTurn + 1 }, (_, index) => `res-${index}`) });
  bad({ revision: -1 });
  bad({ error: { code: 'nope', message: 'x' } });
});

test('source material requires a text mime and honest extraction metadata', () => {
  const material: SourceMaterial = {
    resourceId: 'res-1',
    scope,
    resourceRevision: 3,
    sha256: SHA,
    mime: 'text/markdown',
    title: 'note.md',
    origin: { kind: 'upload' },
    text: '# 标题',
    extraction: { version: SOURCE_MATERIAL_EXTRACTION_VERSION, complete: true }
  };
  validateSourceMaterial(material);
  validateSourceMaterial({ ...material, mime: 'text/html', extraction: { version: SOURCE_MATERIAL_EXTRACTION_VERSION, complete: false, omittedReason: '超过上限。' } });
  const bad = (overrides: Record<string, unknown>): void => {
    assert.throws(() => validateSourceMaterial({ ...material, ...overrides } as SourceMaterial), { code: 'invalid_input' });
  };
  bad({ extra: 1 });
  bad({ mime: 'image/png' });
  bad({ mime: 'application/zip' });
  bad({ sha256: 'zz' });
  bad({ text: 5 });
  bad({ title: 'x'.repeat(301) });
  bad({ extraction: { version: '', complete: true } });
  bad({ extraction: { version: 'v', complete: 'yes' } });
  bad({ extraction: { version: 'v', complete: true, extra: 1 } });
});

test('resource capabilities accept only the three known levels', () => {
  validateResourceCapabilities(DEFAULT_RESOURCE_CAPABILITIES);
  validateResourceCapabilities({ outputFiles: 'available', inputImages: 'unavailable', reason: '本地来源不支持。' });
  assert.deepEqual(DEFAULT_RESOURCE_CAPABILITIES, { outputFiles: 'unknown', inputImages: 'unknown' });
  // Raw JSON: a caller can hand the validator anything, so the negative cases bypass the types.
  const rejects = (value: unknown): void => {
    assert.throws(() => validateResourceCapabilities(value as Parameters<typeof validateResourceCapabilities>[0]), { code: 'invalid_input' });
  };
  rejects({ outputFiles: 'yes', inputImages: 'unknown' });
  rejects({ outputFiles: 'unknown' });
  rejects({ outputFiles: 'unknown', inputImages: 'unknown', extra: 1 });
  rejects({ outputFiles: 'unknown', inputImages: 'unknown', reason: 'x'.repeat(301) });
  rejects(null);
});

test('selections normalize to at most eight unique entries in the caller order', () => {
  assert.deepEqual(normalizeResourceSelections(undefined), []);
  assert.deepEqual(normalizeResourceSelections(null), []);
  assert.deepEqual(normalizeResourceSelections([]), []);
  const ordered = [
    { resourceId: 'res-b', use: 'text' as const },
    { resourceId: 'res-a', use: 'image' as const }
  ];
  assert.deepEqual(normalizeResourceSelections(ordered), ordered, 'order is preserved, not sorted');
  // Normalization returns fresh objects: mutating the result must not reach back into the caller.
  const source = [{ resourceId: 'res-a', use: 'text' as const }];
  const normalized = normalizeResourceSelections(source);
  normalized[0]!.use = 'image';
  assert.equal(source[0]!.use, 'text');
});

test('selections reject overflow, duplicates and bad uses', () => {
  const eight = Array.from({ length: RESOURCE_LIMITS.inputsPerTurn }, (_, index) => ({ resourceId: `res-${index}`, use: 'text' }));
  assert.equal(normalizeResourceSelections(eight).length, 8);
  assert.throws(() => normalizeResourceSelections([...eight, { resourceId: 'res-9', use: 'text' }]), { code: 'invalid_input' }, 'more than 8');
  assert.throws(() => normalizeResourceSelections('res-1'), { code: 'invalid_input' }, 'not a list');
  assert.throws(() => normalizeResourceSelections([{ resourceId: 'res-1', use: 'text' }, { resourceId: 'res-1', use: 'image' }]), { code: 'invalid_input' }, 'duplicate id');
  assert.throws(() => normalizeResourceSelections([{ resourceId: 'res-1', use: 'audio' }]), { code: 'invalid_input' }, 'bad use');
  assert.throws(() => normalizeResourceSelections([{ resourceId: 'res-1', use: 'text', extra: 1 }]), { code: 'invalid_input' }, 'unknown key');
  assert.throws(() => normalizeResourceSelections([{ use: 'text' }]), { code: 'invalid_input' }, 'missing id');
  assert.throws(() => normalizeResourceSelections([{ resourceId: 'res-1' }]), { code: 'invalid_input' }, 'missing use');
});

test('a single selection round-trips and drops unknown keys', () => {
  assert.deepEqual(validateResourceSelection({ resourceId: 'res-1', use: 'image' }), { resourceId: 'res-1', use: 'image' });
  const frozen: FrozenResourceSelection = { resourceId: 'res-1', use: 'text', sha256: SHA };
  assert.deepEqual(validateFrozenResourceSelection(frozen), frozen);
  assert.throws(() => validateFrozenResourceSelection({ resourceId: 'res-1', use: 'text' }), { code: 'invalid_input' }, 'frozen without hash');
  assert.throws(() => validateFrozenResourceSelection({ resourceId: 'res-1', use: 'text', sha256: SHA, extra: 1 }), { code: 'invalid_input' }, 'frozen with unknown key');
});

test('the request hash is stable and sensitive to every replay input', () => {
  const base = {
    scope,
    turnId: 'turn-1',
    query: '看看这个',
    replyStyle: 'balanced',
    selections: [{ resourceId: 'res-1', use: 'text' as const, sha256: SHA }]
  };
  const hash = resourceRequestHash(base);
  assert.equal(hash, resourceRequestHash({ ...base, selections: [{ resourceId: 'res-1', use: 'text', sha256: SHA }] }), 'stable across calls');
  assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.notEqual(hash, resourceRequestHash({ ...base, scope: other }), 'scope');
  assert.notEqual(hash, resourceRequestHash({ ...base, turnId: 'turn-2' }), 'turnId');
  assert.notEqual(hash, resourceRequestHash({ ...base, query: '看看那个' }), 'query');
  assert.notEqual(hash, resourceRequestHash({ ...base, replyStyle: 'detailed' }), 'replyStyle');
  assert.notEqual(hash, resourceRequestHash({ ...base, selections: [{ resourceId: 'res-1', use: 'text', sha256: SHA_B }] }), 'sha256');
  assert.notEqual(hash, resourceRequestHash({ ...base, selections: [{ resourceId: 'res-2', use: 'text', sha256: SHA }] }), 'resourceId');
  assert.notEqual(hash, resourceRequestHash({ ...base, selections: [{ resourceId: 'res-1', use: 'image', sha256: SHA }] }), 'use');
  const two = resourceRequestHash({ ...base, selections: [{ resourceId: 'res-1', use: 'text', sha256: SHA }, { resourceId: 'res-2', use: 'text', sha256: SHA_B }] });
  const swapped = resourceRequestHash({ ...base, selections: [{ resourceId: 'res-2', use: 'text', sha256: SHA_B }, { resourceId: 'res-1', use: 'text', sha256: SHA }] });
  assert.notEqual(two, swapped, 'resource order');
  assert.equal(resourceRequestHash({ ...base, selections: [] }), resourceRequestHash({ ...base, selections: [] }));
});

test('scope keys isolate sessions and mime maps to exactly one kind', () => {
  assert.equal(resourceScopeKey(scope), resourceScopeKey({ ...scope }));
  assert.notEqual(resourceScopeKey(scope), resourceScopeKey(other));
  assert.notEqual(resourceScopeKey(scope), resourceScopeKey({ ...scope, pairingId: 'other-user' }));
  assert.match(resourceScopeKey(scope), /^[a-f0-9]{64}$/u);
  assert.equal(sameScope(scope, { ...scope }), true);
  assert.equal(sameScope(scope, other), false);
  assert.equal(kindOfMime('text/markdown'), 'markdown');
  assert.equal(kindOfMime('text/html'), 'html');
  assert.equal(kindOfMime('text/plain'), 'text');
  assert.equal(kindOfMime('image/png'), 'image');
  assert.equal(kindOfMime('application/zip'), 'zip');
  assert.equal(kindOfMime(null), 'unknown');
  assert.equal(kindOfMime('image/svg+xml'), 'unknown');
  for (const kind of RESOURCE_KINDS) assert.equal(typeof kind, 'string');
});

test('failureOf truncates to the contract error budget', () => {
  assert.deepEqual(failureOf('cancelled', '取消。'), { code: 'cancelled', message: '取消。' });
  const long = failureOf('download_failed', 'x'.repeat(400));
  assert.equal(long.message.length, 300);
  assert.ok(long.message.endsWith('...'));
});

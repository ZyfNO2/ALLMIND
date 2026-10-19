import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  createWindowsMediaOcrEngine,
  WINDOWS_MEDIA_OCR_BINARY,
  WINDOWS_MEDIA_OCR_MAX_INPUT_BYTES,
  WINDOWS_MEDIA_OCR_MAX_OUTPUT_BYTES,
  WINDOWS_MEDIA_OCR_MAX_PIXELS,
  type WindowsMediaOcrHelperPaths,
} from '../../core/windows-media-ocr-engine.js';

function withHelperFixture(run: (paths: WindowsMediaOcrHelperPaths) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'aika-windows-ocr-'));
  const paths = {
    binaryPath: join(directory, WINDOWS_MEDIA_OCR_BINARY),
    manifestPath: join(directory, 'helper-build.json'),
  };
  writeFileSync(paths.binaryPath, 'fixture-only');
  writeFileSync(paths.manifestPath, JSON.stringify({
    schemaVersion: 1,
    binary: WINDOWS_MEDIA_OCR_BINARY,
    platform: 'win32',
    builtFrom: 'desktop/ocr/windows-media-ocr-helper.cpp',
    protocolSchemaVersion: 1,
    maxInputBytes: WINDOWS_MEDIA_OCR_MAX_INPUT_BYTES,
    maxPixels: WINDOWS_MEDIA_OCR_MAX_PIXELS,
    maxOutputBytes: WINDOWS_MEDIA_OCR_MAX_OUTPUT_BYTES,
  }));
  return run(paths).finally(() => rmSync(directory, { recursive: true, force: true }));
}

const readyResponse = JSON.stringify({
  schemaVersion: 1, status: 'ready', engine: 'windows-media-ocr', language: 'en-US',
});

test('native helper uses in-memory OCR and exposes no screen-capture, disk, or network API', () => {
  const source = readFileSync(resolve(process.cwd(), 'desktop/ocr/windows-media-ocr-helper.cpp'), 'utf8');
  assert.match(source, /OcrEngine::TryCreateFromUserProfileLanguages/);
  assert.match(source, /InMemoryRandomAccessStream/);
  assert.match(source, /GetStdHandle\(STD_INPUT_HANDLE\)/);
  assert.match(source, /SecureZeroMemory/);
  assert.doesNotMatch(source, /\b(?:GetDC|BitBlt|PrintWindow|CreateFileW|CreateFileA|WinHttpOpen|InternetOpen|URLDownloadToFile)\b/);
  const backend = readFileSync(resolve(process.cwd(), 'app/trial-backend.ts'), 'utf8');
  assert.match(backend, /createWindowsMediaOcrEngine/);
  assert.match(backend, /const nativeOcr = localOcr;/);
  assert.match(backend, /capabilities: \{ capture: false, localOcr: windowsOcr\?\.available \?\? false/);
});

test('Windows Media OCR stays unavailable off Windows or without a valid helper manifest', async () => {
  const offWindows = await createWindowsMediaOcrEngine({
    paths: { binaryPath: 'missing.exe', manifestPath: 'missing.json' }, platform: 'linux',
  });
  assert.equal(offWindows.available, false);
  assert.equal((await offWindows.recognize(new Uint8Array([1]))).reason, 'windows_media_ocr_requires_windows');

  const missing = await createWindowsMediaOcrEngine({
    paths: { binaryPath: 'missing.exe', manifestPath: 'missing.json' }, platform: 'win32',
  });
  assert.equal(missing.available, false);
  assert.equal((await missing.recognize(new Uint8Array([1]))).reason, 'windows_media_ocr_helper_missing');
});

test('Windows Media OCR passes bounded image bytes and preserves unknown confidence as null', async () => {
  await withHelperFixture(async paths => {
    const calls: string[] = [];
    const engine = await createWindowsMediaOcrEngine({
      paths,
      platform: 'win32',
      invokeHelper: async (_binaryPath, command, bytes) => {
        calls.push(command);
        if (command === '--probe') return readyResponse;
        assert.deepEqual([...bytes ?? []], [1, 2, 3]);
        return JSON.stringify({
          schemaVersion: 1,
          status: 'ok',
          engine: 'windows-media-ocr',
          language: 'en-US',
          width: 200,
          height: 100,
          blocks: [
            { text: 'Hello', confidence: null, bounds: { x: 8, y: 12, width: 40, height: 18 } },
            { text: 'World', confidence: null, bounds: { x: 8, y: 34, width: 45, height: 18 } },
          ],
        });
      },
    });
    assert.equal(engine.available, true);
    assert.equal(engine.language, 'en-US');
    const result = await engine.recognize(Uint8Array.from([1, 2, 3]));
    assert.equal(result.status, 'ok');
    assert.equal(result.engine, 'windows-media-ocr');
    assert.equal(result.language, 'en-US');
    assert.equal(result.readingOrderText, 'Hello\nWorld');
    assert.equal(result.blocks[0]?.confidence, null);
    assert.deepEqual(calls, ['--probe', '--recognize']);
  });
});

test('Windows Media OCR rejects malformed or out-of-bounds native responses', async () => {
  await withHelperFixture(async paths => {
    const engine = await createWindowsMediaOcrEngine({
      paths,
      platform: 'win32',
      invokeHelper: async (_binaryPath, command) => command === '--probe' ? readyResponse : JSON.stringify({
        schemaVersion: 1, status: 'ok', engine: 'windows-media-ocr', language: 'en-US', width: 10, height: 10,
        blocks: [{ text: 'bad box', confidence: null, bounds: { x: 9, y: 2, width: 5, height: 2 } }],
      }),
    });
    const result = await engine.recognize(Uint8Array.from([1]));
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'invalid_helper_response');
    assert.deepEqual(result.blocks, []);
  });
});

test('Windows Media OCR preserves aborts and does not invoke helper for oversized frames', async () => {
  await withHelperFixture(async paths => {
    let recognitionCalls = 0;
    const engine = await createWindowsMediaOcrEngine({
      paths,
      platform: 'win32',
      invokeHelper: async (_binaryPath, command, _bytes, signal) => {
        if (command === '--probe') return readyResponse;
        recognitionCalls += 1;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      },
    });

    const oversized = await engine.recognize(new Uint8Array(WINDOWS_MEDIA_OCR_MAX_INPUT_BYTES + 1));
    assert.equal(oversized.status, 'failed');
    assert.equal(oversized.reason, 'invalid_or_oversized_image');
    assert.equal(recognitionCalls, 0);

    const controller = new AbortController();
    const pending = engine.recognize(Uint8Array.from([1]), controller.signal);
    controller.abort();
    await assert.rejects(pending, error => (error as Error).name === 'AbortError');
    assert.equal(recognitionCalls, 1);
  });
});

test('Windows Media OCR reports missing language support instead of claiming healthy capability', async () => {
  await withHelperFixture(async paths => {
    let recognitionCalls = 0;
    const engine = await createWindowsMediaOcrEngine({
      paths,
      platform: 'win32',
      invokeHelper: async (_binaryPath, command) => command === '--probe'
        ? JSON.stringify({ schemaVersion: 1, status: 'unavailable', engine: 'windows-media-ocr', reason: 'ocr_language_unavailable' })
        : (recognitionCalls += 1, '{}'),
    });
    assert.equal(engine.available, false);
    assert.equal(engine.reason, 'ocr_language_unavailable');
    assert.equal((await engine.recognize(Uint8Array.from([1]))).status, 'unavailable');
    assert.equal(recognitionCalls, 0);
  });
});

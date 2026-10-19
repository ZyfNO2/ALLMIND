/**
 * Backend adapter for the optional one-shot Windows.Media.Ocr helper.
 * Images are sent over a private child-process stdin pipe and are never written to disk or sent remotely.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { OcrResult, OcrTextBlock } from '../contracts/perception.js';

export const WINDOWS_MEDIA_OCR_BINARY = 'aika-windows-media-ocr.exe';
export const WINDOWS_MEDIA_OCR_PROTOCOL_VERSION = 1 as const;
export const WINDOWS_MEDIA_OCR_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const WINDOWS_MEDIA_OCR_MAX_PIXELS = 40_000_000;
export const WINDOWS_MEDIA_OCR_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_BLOCKS = 256;
const MAX_TEXT_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface WindowsMediaOcrHelperPaths {
  readonly binaryPath: string;
  readonly manifestPath: string;
}

export interface WindowsMediaOcrHelperManifest {
  readonly schemaVersion: 1;
  readonly binary: typeof WINDOWS_MEDIA_OCR_BINARY;
  readonly platform: 'win32';
  readonly builtFrom: 'desktop/ocr/windows-media-ocr-helper.cpp';
  readonly protocolSchemaVersion: typeof WINDOWS_MEDIA_OCR_PROTOCOL_VERSION;
  readonly maxInputBytes: typeof WINDOWS_MEDIA_OCR_MAX_INPUT_BYTES;
  readonly maxPixels: typeof WINDOWS_MEDIA_OCR_MAX_PIXELS;
  readonly maxOutputBytes: typeof WINDOWS_MEDIA_OCR_MAX_OUTPUT_BYTES;
}

export interface WindowsMediaOcrEngineOptions {
  readonly paths: WindowsMediaOcrHelperPaths;
  /** Narrow test seams. Production uses process.platform and a real child process. */
  readonly platform?: string;
  readonly timeoutMs?: number;
  readonly invokeHelper?: (binaryPath: string, command: '--probe' | '--recognize', bytes?: Uint8Array, signal?: AbortSignal) => Promise<string>;
}

export interface WindowsMediaOcrEngine {
  readonly available: boolean;
  readonly language?: string;
  readonly reason?: string;
  readonly recognize: (bytes: Uint8Array, signal?: AbortSignal) => Promise<OcrResult>;
}

export function windowsMediaOcrHelperPaths(packageRoot: string): WindowsMediaOcrHelperPaths {
  const directory = resolve(packageRoot, 'dist', 'ocr');
  return {
    binaryPath: resolve(directory, WINDOWS_MEDIA_OCR_BINARY),
    manifestPath: resolve(directory, 'helper-build.json'),
  };
}

export function loadWindowsMediaOcrHelperManifest(paths: WindowsMediaOcrHelperPaths): WindowsMediaOcrHelperManifest | null {
  if (!existsSync(paths.binaryPath) || !existsSync(paths.manifestPath)) return null;
  try {
    const value = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || value.protocolSchemaVersion !== WINDOWS_MEDIA_OCR_PROTOCOL_VERSION
      || value.binary !== WINDOWS_MEDIA_OCR_BINARY || value.platform !== 'win32'
      || value.builtFrom !== 'desktop/ocr/windows-media-ocr-helper.cpp'
      || value.maxInputBytes !== WINDOWS_MEDIA_OCR_MAX_INPUT_BYTES
      || value.maxPixels !== WINDOWS_MEDIA_OCR_MAX_PIXELS || value.maxOutputBytes !== WINDOWS_MEDIA_OCR_MAX_OUTPUT_BYTES
      || basename(paths.binaryPath) !== WINDOWS_MEDIA_OCR_BINARY) return null;
    return value as unknown as WindowsMediaOcrHelperManifest;
  } catch { return null; }
}

export async function createWindowsMediaOcrEngine(options: WindowsMediaOcrEngineOptions): Promise<WindowsMediaOcrEngine> {
  const unavailable = (reason: string): WindowsMediaOcrEngine => ({
    available: false,
    reason,
    recognize: async (_bytes: Uint8Array, signal?: AbortSignal) => {
      if (signal?.aborted) throw abortError();
      return unavailableResult(reason);
    },
  });
  if ((options.platform ?? process.platform) !== 'win32') return unavailable('windows_media_ocr_requires_windows');
  if (!loadWindowsMediaOcrHelperManifest(options.paths)) return unavailable('windows_media_ocr_helper_missing');

  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
    ? Math.min(options.timeoutMs as number, 60_000) : DEFAULT_TIMEOUT_MS;
  const invoke = options.invokeHelper ?? ((binaryPath: string, command: '--probe' | '--recognize', bytes?: Uint8Array, signal?: AbortSignal) =>
    invokeNativeHelper(binaryPath, command, bytes, signal, timeoutMs));
  let probe: HelperProbe;
  try {
    probe = parseProbe(await invoke(options.paths.binaryPath, '--probe'));
  } catch (error) {
    if (isAbortError(error)) throw error;
    return unavailable(safeReason(error instanceof Error ? error.message : 'windows_media_ocr_probe_failed'));
  }
  if (probe.status !== 'ready') return unavailable(probe.reason ?? 'ocr_language_unavailable');

  return {
    available: true,
    language: probe.language,
    recognize: async (bytes: Uint8Array, signal?: AbortSignal): Promise<OcrResult> => {
      if (signal?.aborted) throw abortError();
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > WINDOWS_MEDIA_OCR_MAX_INPUT_BYTES) {
        return failedResult('invalid_or_oversized_image');
      }
      try {
        const response = parseRecognition(await invoke(options.paths.binaryPath, '--recognize', bytes, signal));
        if (response.status !== 'ok') {
          if (response.status === 'unavailable') return unavailableResult(response.reason ?? 'ocr_language_unavailable');
          return failedResult(response.reason ?? 'windows_media_ocr_failed');
        }
        const blocks = validateBlocks(response);
        return {
          status: 'ok',
          blocks,
          readingOrderText: blocks.map(block => block.text).join('\n'),
          language: response.language,
          engine: 'windows-media-ocr',
        };
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw abortError();
        return failedResult(safeReason(error instanceof Error ? error.message : 'windows_media_ocr_failed'));
      }
    },
  };
}

type HelperProbe =
  | { readonly status: 'ready'; readonly language: string }
  | { readonly status: 'unavailable'; readonly reason: string };
type HelperRecognition =
  | { readonly status: 'ok'; readonly language: string; readonly width: number; readonly height: number; readonly blocks: readonly unknown[] }
  | { readonly status: 'unavailable' | 'failed'; readonly reason: string };

function parseProbe(text: string): HelperProbe {
  const value = parseJsonRecord(text);
  if (value.schemaVersion !== 1 || value.engine !== 'windows-media-ocr') throw new Error('invalid_helper_response');
  if (value.status === 'unavailable') return { status: 'unavailable', reason: safeReason(value.reason) };
  if (value.status !== 'ready' || typeof value.language !== 'string' || value.language.length < 1 || value.language.length > 64) {
    throw new Error('invalid_helper_response');
  }
  return { status: 'ready', language: value.language };
}

function parseRecognition(text: string): HelperRecognition {
  const value = parseJsonRecord(text);
  if (value.schemaVersion !== 1 || value.engine !== 'windows-media-ocr'
    || !['ok', 'unavailable', 'failed'].includes(String(value.status))) throw new Error('invalid_helper_response');
  if (value.status === 'unavailable' || value.status === 'failed') {
    return { status: value.status, reason: safeReason(value.reason) };
  }
  if (value.status !== 'ok' || typeof value.language !== 'string' || value.language.length < 1 || value.language.length > 64
    || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || (value.width as number) < 1 || (value.height as number) < 1
    || (value.width as number) * (value.height as number) > WINDOWS_MEDIA_OCR_MAX_PIXELS
    || !Array.isArray(value.blocks) || value.blocks.length > MAX_BLOCKS) throw new Error('invalid_helper_response');
  return {
    status: 'ok', language: value.language, width: value.width as number, height: value.height as number,
    blocks: value.blocks,
  };
}

function validateBlocks(response: Extract<HelperRecognition, { readonly status: 'ok' }>): readonly OcrTextBlock[] {
  const width = response.width;
  const height = response.height;
  const blocks: OcrTextBlock[] = [];
  for (const value of response.blocks) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_helper_response');
    const block = value as Record<string, unknown>;
    const bounds = block.bounds;
    if (typeof block.text !== 'string' || block.text.trim().length === 0 || Buffer.byteLength(block.text, 'utf8') > MAX_TEXT_BYTES
      || (block.confidence !== null && (typeof block.confidence !== 'number' || !Number.isFinite(block.confidence)
        || block.confidence < 0 || block.confidence > 1))
      || !bounds || typeof bounds !== 'object' || Array.isArray(bounds)) throw new Error('invalid_helper_response');
    const rect = bounds as Record<string, unknown>;
    const x = rect.x, y = rect.y, blockWidth = rect.width, blockHeight = rect.height;
    if (![x, y, blockWidth, blockHeight].every(v => typeof v === 'number' && Number.isFinite(v))
      || (x as number) < 0 || (y as number) < 0 || (blockWidth as number) <= 0 || (blockHeight as number) <= 0
      || (x as number) + (blockWidth as number) > width + 1 || (y as number) + (blockHeight as number) > height + 1) {
      throw new Error('invalid_helper_response');
    }
    blocks.push({
      text: block.text,
      confidence: block.confidence as number | null,
      bounds: { x: x as number, y: y as number, width: blockWidth as number, height: blockHeight as number },
    });
  }
  return blocks;
}

function parseJsonRecord(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > WINDOWS_MEDIA_OCR_MAX_OUTPUT_BYTES || text.includes('\n') || text.includes('\r')) throw new Error('invalid_helper_response');
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_helper_response');
  return value as Record<string, unknown>;
}

function invokeNativeHelper(binaryPath: string, command: '--probe' | '--recognize', bytes?: Uint8Array, signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binaryPath, [command], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
    const inputBuffer = bytes ? Buffer.from(bytes) : undefined;
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const timer = setTimeout(() => stop(new Error('ocr_helper_timeout')), timeoutMs);
    timer.unref?.();
    const onAbort = () => stop(abortError());
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      inputBuffer?.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    };
    const settle = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise(value ?? '');
    };
    const stop = (error: Error) => {
      if (!failure) failure = error;
      try { child.kill(); } catch { /* close/error below settles the request */ }
    };

    child.stdin.on('error', () => stop(new Error('ocr_helper_input_failed')));
    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > WINDOWS_MEDIA_OCR_MAX_OUTPUT_BYTES) { stop(new Error('ocr_output_limit')); return; }
      chunks.push(buffer);
    });
    child.once('error', () => settle(failure ?? new Error('ocr_helper_unavailable')));
    child.once('close', code => {
      if (failure) settle(failure);
      else if (code !== 0) settle(new Error('ocr_helper_failed'));
      else {
        const output = Buffer.concat(chunks);
        const response = output.toString('utf8').trim();
        output.fill(0);
        settle(undefined, response);
      }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      if (inputBuffer) child.stdin.end(inputBuffer);
      else child.stdin.end();
    } catch { stop(new Error('ocr_helper_input_failed')); }
  });
}

function unavailableResult(reason: string): OcrResult {
  return { status: 'unavailable', blocks: [], readingOrderText: '', engine: 'windows-media-ocr', reason: safeReason(reason) };
}
function failedResult(reason: string): OcrResult {
  return { status: 'failed', blocks: [], readingOrderText: '', engine: 'windows-media-ocr', reason: safeReason(reason) };
}
function safeReason(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value) ? value : 'windows_media_ocr_failed';
}
function abortError(): Error { return Object.assign(new Error('OCR operation aborted'), { name: 'AbortError' }); }
function isAbortError(error: unknown): boolean { return (error as Error | null)?.name === 'AbortError'; }

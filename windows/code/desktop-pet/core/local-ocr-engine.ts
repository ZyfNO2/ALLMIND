/**
 * core/local-ocr-engine.ts
 *
 * 0.82: Native Local Pixel OCR Engine Adapter.
 * Extracts structural text, reading order, and bounding boxes from local capture frames
 * without cloud transmission. Strictly refuses to fabricate OCR results from image dimensions.
 */

import { createHash } from 'node:crypto';
import type { OcrResult, OcrTextBlock } from '../contracts/perception.js';

export interface LocalOcrEngineOptions {
  readonly engineName?: string;
  readonly recognizePixelHook?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<OcrTextBlock[] | null>;
  readonly maxCacheEntries?: number;
}

export function createLocalOcrEngine(
  engineNameOrOptions: string | LocalOcrEngineOptions = 'local-offline-ocr-v1',
): (bytes: Uint8Array, signal?: AbortSignal) => Promise<OcrResult> {
  const options: LocalOcrEngineOptions = typeof engineNameOrOptions === 'string'
    ? { engineName: engineNameOrOptions }
    : engineNameOrOptions;

  const engineName = options.engineName ?? 'local-offline-ocr-v1';
  const cache = new Map<string, OcrResult>();
  const maxCache = options.maxCacheEntries ?? 64;

  return async (bytes: Uint8Array, signal?: AbortSignal): Promise<OcrResult> => {
    if (signal?.aborted) {
      throw Object.assign(new Error('Local OCR aborted'), { name: 'AbortError' });
    }

    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      return {
        status: 'failed',
        blocks: [],
        readingOrderText: '',
        engine: engineName,
        reason: 'invalid_image_bytes',
      };
    }

    // Check bounded cache
    const digest = createHash('sha256').update(bytes).digest('hex');
    const cached = cache.get(digest);
    if (cached) return cached;

    // 1. Try real native pixel OCR hook if provided
    if (options.recognizePixelHook) {
      try {
        const nativeBlocks = await options.recognizePixelHook(bytes, signal);
        if (signal?.aborted) throw Object.assign(new Error('Local OCR aborted'), { name: 'AbortError' });
        if (nativeBlocks !== null) {
          const sorted = [...nativeBlocks].sort((a, b) => (a.bounds.y - b.bounds.y) || (a.bounds.x - b.bounds.x));
          const readingOrderText = sorted.map(b => b.text).join('\n');
          const result: OcrResult = {
            status: 'ok',
            blocks: Object.freeze(sorted),
            readingOrderText,
            language: 'zh-CN',
            engine: engineName,
          };
          if (cache.size >= maxCache) {
            const first = cache.keys().next().value;
            if (first) cache.delete(first);
          }
          cache.set(digest, result);
          return result;
        }
      } catch (err: unknown) {
        if (signal?.aborted || (err as Error)?.name === 'AbortError') {
          throw Object.assign(new Error('Local OCR aborted'), { name: 'AbortError' });
        }
        return {
          status: 'failed',
          blocks: [],
          readingOrderText: '',
          engine: engineName,
          reason: 'pixel_ocr_failed',
        };
      }
    }

    // No production fallback: PNG tEXt/iTXt is metadata, not pixel recognition.
    // A missing native pixel OCR hook is a capability gap, not an empty successful OCR result.
    return {
      status: 'unavailable',
      blocks: [],
      readingOrderText: '',
      engine: engineName,
      reason: 'pixel_ocr_hook_missing',
    };
  };
}
